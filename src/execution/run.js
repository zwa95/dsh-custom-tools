/**
 * One execution, from normalised arguments to a uniform result.
 *
 * This is the only path that spawns anything: the ToolSlot body and
 * `/custom-tools test` both call it, so a preview or a test can never disagree
 * with what a real model call does.
 *
 * Every service is injected (`ctx`), which keeps the module testable and makes
 * the dependency surface auditable: nothing here reaches for a global.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

import { buildInvocation } from '../compiler/bindings.js'
import { normalizeArguments } from '../compiler/parameters.js'
import { emptySandbox, failure, success } from '../result/contract.js'
import { hintFor, classifyExit } from './classify.js'
import { stricter, isFullAccess, confinementPolicy } from './sandbox.js'
import { encodingDefaultsFor, interpreterKey, mergeEncodingEnv, withArgvPrefix } from './encoding.js'
import { bashCandidates, isStubBash, POWERSHELL_FALLBACK } from './interpreters.js'
import { pathWithStaged, resolveStagedBash } from './dshbash.js'
import { validateJsonSubset } from './jsonschema.js'

const STDOUT_LIMIT = 1_000_000
const STDERR_LIMIT = 256_000
const GRACE_MS = 3000

/**
 * A few Windows programs (the WSL launcher among them) write UTF-16LE straight
 * to the console. Read as UTF-8 that becomes NUL-interleaved garbage, which
 * hides the only useful part of the message. Re-decode when the text is mostly
 * NUL padding; every byte of ASCII survives, and characters the UTF-8 decode
 * already replaced are lost either way.
 */
function decodeWideText(text) {
  if (text.length < 4) return text
  let nul = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0) nul += 1
  }
  if (nul / text.length < 0.15) return text
  const decoded = Buffer.from(text, 'latin1').toString('utf16le')
  return decoded.includes('\u0000') ? text : decoded
}

function readStream(collector, offset = 0) {
  if (!collector || typeof collector.readFrom !== 'function') {
    return { text: '', lossy: false }
  }
  const read = collector.readFrom(offset) ?? {}
  return {
    text: decodeWideText(typeof read.text === 'string' ? read.text : ''),
    lossy: read.lossy === true,
    spillPath: read.spillPath,
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function withSandbox(result, tiers) {
  return { ...result, sandbox: { ...emptySandbox(), ...tiers } }
}

/**
 * @param {object} services injected host services (see `index.js`)
 * @param {object} compiled `{name, plan}` from the compiler
 * @param {unknown} rawArgs model-supplied arguments
 * @param {{agent?: unknown, signal?: AbortSignal, callId?: string}} exec
 * @param {{spawn?: boolean}} [options] `spawn:false` stops right before spawn,
 *   which is what `preview` uses to show argv without running anything.
 */
export async function runCustomTool(services, compiled, rawArgs, exec = {}, options = {}) {
  const plan = compiled.plan
  const startedAt = Date.now()
  const base = { argv: [], cwd: '' }
  const failWith = (code, message, extra = {}) => failure(code, message, {
    ...base,
    durationMs: Date.now() - startedAt,
    hint: hintFor(code),
    ...extra,
  })

  // 1 — arguments
  const normalized = normalizeArguments(plan.parameters, rawArgs)
  if (!normalized.ok) {
    return failWith('INVALID_ARGUMENT', normalized.errors.join('；'))
  }
  const values = normalized.values

  // 2 — working directory (before confine: a bad cwd must not look like a runner fault)
  let agentCwd
  if (services.workingDirectory) {
    try {
      agentCwd = exec.agent
        ? await services.workingDirectory.ensure(exec.agent, exec.signal)
        : services.workingDirectory.defaultDirectory
    } catch {
      agentCwd = undefined
    }
  }
  const cwdBase = agentCwd ?? services.fallbackCwd ?? process.cwd()
  const cwd = isAbsolute(plan.cwd) ? plan.cwd : resolvePath(cwdBase, plan.cwd)
  base.cwd = cwd
  if (!isDirectory(cwd)) {
    return failWith('CWD_UNAVAILABLE', `工作目录不存在或不是目录：${cwd}`)
  }

  // 3 — approval (opt-in per tool; the session policy still has the final say)
  if (plan.approval === 'always') {
    if (typeof services.requestApproval !== 'function') {
      return failWith('APPROVAL_UNAVAILABLE',
        '该工具声明了 approval: always，但当前没有可用的审批通道')
    }
    let verdict
    try {
      verdict = await services.requestApproval(exec, plan)
    } catch {
      verdict = 'unavailable'
    }
    if (verdict === 'unavailable') {
      return failWith('APPROVAL_UNAVAILABLE',
        '审批通道不可用（会话策略为 never，或当前不在一个打开的轮次里）')
    }
    if (verdict !== 'allowed-once') {
      return failWith('APPROVAL_REJECTED', '本次调用被拒绝')
    }
  }

  // 4 — credentials, resolved per call and never cached
  const credentialEnv = {}
  for (const binding of plan.credentials) {
    let resolved
    try {
      resolved = await services.credentials?.resolve(binding.ref)
    } catch {
      resolved = undefined
    }
    const value = resolved && typeof resolved.value === 'string' ? resolved.value : undefined
    if (value === undefined || value === '') {
      return failWith('CREDENTIAL_UNAVAILABLE', `凭据 ${binding.ref} 未配置或为空`)
    }
    credentialEnv[binding.env] = value
  }

  // 4b — the sandbox tier, resolved before the interpreter is chosen: on Windows
  // the only bash that can start inside the restricted token is dsh-ops' staged
  // payload, and that choice depends on whether this call will be confined.
  let policy = {}
  // The public execution context carries no session, but a real agent does: when
  // one is present the session policy participates, so a tool can only ever be
  // narrowed below what the conversation already permits. Agentless calls (the
  // slash-command test path) resolve against the deployment default.
  const resolveRequest = exec?.agent?.session ? { session: exec.agent.session } : {}
  try {
    policy = services.sandboxPolicy?.resolve(resolveRequest) ?? {}
  } catch (error) {
    return failWith('SANDBOX_UNAVAILABLE',
      `无法解析沙箱策略：${error instanceof Error ? error.message : String(error)}`)
  }
  const declared = plan.sandbox
  const session = policy.mode ?? 'workspace-write'
  const effective = stricter(declared, session)
  const platform = options.platform ?? process.platform
  const confined = !isFullAccess(effective)

  // 5 — executable / interpreter / script
  const lookupEnv = { ...(plan.env ?? {}) }
  const resolveExecutable = async (name, code) => {
    // A deployment without the subprocess service cannot run anything at all:
    // that is a plugin/deployment fault, not a missing executable.
    if (!services.subprocess?.resolveExecutable) return { error: 'CUSTOM_TOOL_INTERNAL', detail: 'subprocess 服务不可用' }
    try {
      return { path: await services.subprocess.resolveExecutable(name, lookupEnv, exec.signal) }
    } catch (error) {
      if (error && typeof error === 'object' && error.name === 'SubprocessExecutableNotFoundError') {
        return { error: 'EXECUTABLE_NOT_FOUND' }
      }
      // An unresolvable name and a broken provider are different failures.
      return { error: code, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  const resolved = {}
  const targetName = plan.mode === 'script' ? plan.interpreter : plan.executable
  const usesDefaultBash = plan.mode === 'bash' && plan.executable === 'bash'
  const usesDefaultPwsh = plan.mode === 'powershell' && plan.executable === 'pwsh'
  const windowsConfinedBash = platform === 'win32' && plan.mode === 'bash' && confined

  // Windows: every MSYS2/Cygwin runtime dies inside the restricted token before
  // argv is parsed. The one exception is the pinned MSYS payload dsh-ops patches
  // and stages with its IPC proxies; use it when it is present, and remember to
  // put its own directories first on PATH (an inherited PATH resolves `cat` to a
  // different, unpinned tree, which then dies the same way).
  let stagedBash
  if (windowsConfinedBash && usesDefaultBash) {
    const findStaged = options.findStagedBash ?? (() => resolveStagedBash(process.env))
    stagedBash = findStaged()
  }

  const resolvedTarget = stagedBash !== undefined
    ? { path: stagedBash.file }
    : await resolveExecutable(targetName, 'EXECUTABLE_NOT_FOUND')

  if (resolvedTarget.error === 'CUSTOM_TOOL_INTERNAL') {
    return failWith('CUSTOM_TOOL_INTERNAL', resolvedTarget.detail ?? 'subprocess 服务不可用')
  }

  let interpreterPath = resolvedTarget.error ? undefined : resolvedTarget.path

  // Confined bash on Windows has exactly one working runtime (the staged dsh-ops
  // payload); if it is not there, say so now instead of surfacing a runner failure.
  if (windowsConfinedBash && stagedBash === undefined) {
    return failWith('BASH_SANDBOX_UNSUPPORTED',
      usesDefaultBash
        ? 'Windows 上的 bash 在沙箱里只能跑 dsh-ops 的 staged 运行时，当前找不到它'
          + '（$DSH_HOME/dsh-ops/bash-ipc/<identity>/usr/bin/bash.exe 不存在）。'
          + '请先让 dsh-ops 准备好受限 bash，或把该工具的 sandbox 设为 '
          + 'danger-full-access，或改用 mode: powershell / mode: executable'
        : 'Windows 上的 bash 在沙箱里只能跑 dsh-ops 的 staged 运行时；'
          + '显式指定的 executable（如 Git Bash / MSYS2）无法在受限令牌里启动。'
          + '请留空 executable 让插件挑 staged bash，或把 sandbox 设为 danger-full-access')
  }

  // Windows ships `bash` as the WSL launcher: it resolves, then dies inside a
  // confined run with an opaque E_ACCESSDENIED. Look for a real bash instead.
  if (usesDefaultBash && interpreterPath !== undefined && isStubBash(interpreterPath)) {
    interpreterPath = undefined
    // `process.env` (not the scrubbed DSH_* facts) is the deployment environment
    // these install roots are found in.
    const git = await resolveExecutable('git', 'EXECUTABLE_NOT_FOUND')
    const candidates = bashCandidates(process.env, git.error ? undefined : git.path)
    if (candidates.length > 0) interpreterPath = candidates[0]
  }

  if (usesDefaultBash && interpreterPath === undefined) {
    return failWith('EXECUTABLE_NOT_FOUND',
      'PATH 上的 bash 是 WSL 启动器，找不到可用的 bash；'
      + '请设置 executable 指向 Git Bash 或 MSYS2 的 bash.exe')
  }

  // PowerShell 7 is not on every Windows box; Windows PowerShell 5.1 ships with
  // the OS and takes the same -Command shape we emit.
  if (usesDefaultPwsh && interpreterPath === undefined) {
    const fallback = await resolveExecutable(POWERSHELL_FALLBACK, 'EXECUTABLE_NOT_FOUND')
    if (!fallback.error) interpreterPath = fallback.path
  }

  if (interpreterPath === undefined) {
    if (resolvedTarget.error === 'EXECUTABLE_NOT_FOUND') {
      return failWith('EXECUTABLE_NOT_FOUND', `找不到可执行文件 ${targetName}`)
    }
    return failWith(resolvedTarget.error, `解析可执行文件失败：${resolvedTarget.detail ?? ''}`)
  }
  if (plan.mode === 'script') resolved.interpreter = interpreterPath
  else resolved.executable = interpreterPath

  if (plan.mode === 'script') {
    if (!isFile(plan.script)) {
      return failWith('SCRIPT_UNAVAILABLE', `脚本不存在或不是文件：${plan.script}`)
    }
    if (plan.scriptSha256) {
      const actual = createHash('sha256').update(readFileSync(plan.script)).digest('hex')
      if (actual !== plan.scriptSha256) {
        return failWith('SCRIPT_UNAVAILABLE',
          `脚本哈希不匹配：期望 ${plan.scriptSha256}，实际 ${actual}`)
      }
    }
  }

  // 6 — exact argv
  const invocation = buildInvocation(plan, values, resolved)
  if (!invocation.ok) {
    return failWith('INVALID_ARGUMENT', invocation.errors.join('；'))
  }

  // 7 — environment: encoding defaults, then author env, then credentials
  const encoding = plan.encodingDefaults
    ? encodingDefaultsFor(interpreterKey(resolved.interpreter ?? resolved.executable))
    : { env: {}, argvPrefix: [] }
  const { env: encodingEnv, autoKeys } = mergeEncodingEnv(encoding, plan.env ?? {})
  const env = {
    ...shellFacts(services, exec),
    ...encodingEnv,
    ...plan.env,
    ...credentialEnv,
  }
  // The staged bash resolves `cat`, `ls`, … through its own tree; an inherited
  // PATH points at a different, unpinned MSYS install whose binaries die in the
  // restricted token.
  if (stagedBash !== undefined) {
    env.PATH = pathWithStaged(stagedBash.directories, env.PATH ?? process.env.PATH ?? '')
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) delete env[key]
  }
  const argv = withArgvPrefix(invocation.argv, encoding.argvPrefix)
  base.argv = argv

  // 8 — sandbox tier and confinement (resolved in step 4b)
  const tiers = { declared, session, effective, autoEnvKeys: autoKeys }

  if (options.spawn === false) {
    return withSandbox(success({
      argv,
      cwd,
      durationMs: Date.now() - startedAt,
      data: null,
    }), tiers)
  }

  let finalArgv = argv
  let enforcement
  // Classification inputs stay local: they are sandbox implementation detail,
  // not part of the published result contract.
  let denialSignatures
  let runnerFailureRules

  // Windows bash already chose its runtime in step 5 (the staged dsh-ops payload,
  // or danger-full-access for anything else); nothing left to refuse here.

  if (!isFullAccess(effective)) {
    if (!services.sandbox?.confine) {
      return withSandbox(failWith('SANDBOX_UNAVAILABLE',
        '非 full-access 档位下缺少沙箱服务，已拒绝执行'), tiers)
    }
    try {
      const confined = await services.sandbox.confine(
        argv, confinementPolicy(policy, effective), exec.signal,
      )
      finalArgv = confined.argv
      enforcement = confined.enforcement
      denialSignatures = confined.denialSignatures
      runnerFailureRules = confined.runnerFailureRules
    } catch (error) {
      return withSandbox(failWith('SANDBOX_UNAVAILABLE',
        `沙箱无法启动：${error instanceof Error ? error.message : String(error)}`), tiers)
    }
    tiers.enforcement = enforcement
  }

  // 9 — spawn, with our own deadline and cancellation on top of the caller's
  const own = new AbortController()
  let timedOut = false
  let aborted = false
  const onOuterAbort = () => {
    aborted = true
    own.abort()
  }
  exec.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    own.abort()
  }, plan.timeoutMs)

  let handle
  try {
    handle = services.subprocess.spawn({
      argv: finalArgv,
      cwd,
      stdio: {
        stdin: invocation.stdin === undefined ? 'ignore' : { data: invocation.stdin.text },
        stdout: { maxBytes: STDOUT_LIMIT },
        stderr: { maxBytes: STDERR_LIMIT },
      },
      graceMs: GRACE_MS,
      signal: own.signal,
      env,
    })
  } catch (error) {
    clearTimeout(timer)
    exec.signal?.removeEventListener('abort', onOuterAbort)
    return withSandbox(failWith('SPAWN_FAILED',
      `进程启动失败：${error instanceof Error ? error.message : String(error)}`), tiers)
  }

  let outcome = { exitCode: null, signal: null }
  let spawnError
  try {
    outcome = await handle.done
  } catch (error) {
    spawnError = error
  } finally {
    try {
      await handle.waitForExit()
    } catch {
      // A provider that cannot prove quiescence is reported, not hidden: the
      // process facts below still describe the direct child.
    }
    clearTimeout(timer)
    exec.signal?.removeEventListener('abort', onOuterAbort)
  }

  // 10 — output, then classification
  const stdout = readStream(handle.collected?.stdout)
  const stderr = readStream(handle.collected?.stderr)
  const lossy = stdout.lossy || stderr.lossy
  const durationMs = Date.now() - startedAt

  if (spawnError && !timedOut && !aborted) {
    const message = spawnError instanceof Error ? spawnError.message : String(spawnError)
    return withSandbox(failWith('SPAWN_FAILED', `进程启动失败：${message}`), tiers)
  }

  const verdict = classifyExit({
    exitCode: outcome?.exitCode ?? null,
    signal: outcome?.signal ?? null,
    timedOut,
    aborted,
    lossy,
    stderr: stderr.text,
    sandbox: {
      originalArgv0: argv[0],
      confinedArgv0: finalArgv[0],
      denialSignatures,
      runnerFailureRules,
    },
  })

  const facts = {
    ...base,
    exitCode: outcome?.exitCode ?? null,
    signal: outcome?.signal ?? null,
    timedOut,
    aborted,
    durationMs,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: lossy,
  }

  if (verdict.code !== null) {
    return withSandbox(failure(verdict.code, verdict.message, {
      ...facts,
      hint: verdict.hint,
    }), tiers)
  }

  // 11 — optional JSON parse and schema check (success path only)
  let data = null
  if (plan.output.parse === 'json') {
    try {
      const parsed = JSON.parse(stdout.text)
      if (plan.output.schema !== undefined) {
        const problem = validateJsonSubset(plan.output.schema, parsed)
        if (problem) {
          return withSandbox(failure('OUTPUT_SCHEMA_MISMATCH',
            `输出不符合 schema：${problem}`, {
              ...facts,
              hint: hintFor('OUTPUT_SCHEMA_MISMATCH'),
            }), tiers)
        }
      }
      data = JSON.stringify(parsed)
    } catch {
      return withSandbox(failure('INVALID_JSON_OUTPUT',
        'output.parse 是 json，但 stdout 不是合法 JSON', {
          ...facts,
          hint: hintFor('INVALID_JSON_OUTPUT'),
        }), tiers)
    }
  }

  return withSandbox(success({ ...facts, data }), tiers)
}

function shellFacts(services, exec) {
  try {
    return services.shellEnv?.collect?.(exec) ?? {}
  } catch {
    // Trusted `DSH_*` facts are a convenience; losing them must not break a run.
    return {}
  }
}

export default runCustomTool
