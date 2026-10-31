/**
 * `/custom-tools` — the inspection surface that the settings page cannot be.
 *
 * Everything here is read-only except `enable` / `disable`, which are the two
 * edits users ask for by name far more often than they open a form. Those go
 * through `ctx.settings.mutate()` with the revision the document reports, so a
 * command racing the browser gets a conflict instead of clobbering it.
 *
 * The commands never re-implement the mapper or the executor: `preview` and
 * `test` call {@link Manager.preview} / {@link Manager.test}, which call the
 * same `runCustomTool` a model call reaches.
 */
const HELP = [
  '用法：/custom-tools <子命令>',
  '',
  '  list                       列出已声明的工具（含启用状态与注册状态）',
  '  status                     当前代际、诊断与最近一次提交时间',
  '  show <name>                打印某个工具的完整定义（JSON）',
  '  preview <name> [json]      展示将要执行的 argv/cwd/env 键/沙箱档位，不启动进程',
  '  test <name> [json]         真实执行一次（与模型调用同一条流水线）',
  '  enable <name>              启用一个工具',
  '  disable <name>             禁用一个工具（在途调用会被取消）',
  '',
  '参数 [json] 是一个 JSON 对象，例如：{"query":"dsh","limit":5}',
].join('\n')

function ok(text) {
  return { kind: 'success', text }
}

function err(text) {
  return { kind: 'error', text }
}

/** Split the raw command input into the verb and its remainder. */
function splitInput(rawInput) {
  const trimmed = String(rawInput ?? '').trim()
  if (trimmed === '') return { verb: 'list', rest: '' }
  const space = trimmed.search(/\s/u)
  if (space === -1) return { verb: trimmed, rest: '' }
  return { verb: trimmed.slice(0, space), rest: trimmed.slice(space).trim() }
}

/** Split `<name> [json]` — the name never contains whitespace. */
function splitNameAndArgs(rest) {
  if (rest === '') return { name: '', argsText: '' }
  const space = rest.search(/\s/u)
  if (space === -1) return { name: rest, argsText: '' }
  return { name: rest.slice(0, space), argsText: rest.slice(space).trim() }
}

function parseArgsText(text) {
  if (text === '') return { ok: true, value: {} }
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: '参数必须是一个 JSON 对象' }
    }
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: `参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
}

function renderList(manager) {
  const tools = manager.list()
  if (tools.length === 0) {
    return '还没有声明任何工具。在「设置 → 自定义工具」里添加，或让它保持为空。'
  }
  const rows = tools.map((tool) => {
    const flags = [
      tool.enabled ? 'enabled' : 'disabled',
      tool.registered ? 'registered' : 'not-registered',
      tool.mode,
      `sandbox=${tool.sandbox}`,
      `timeout=${tool.timeoutMs}ms`,
    ]
    return `- ${tool.name}${tool.title ? `（${tool.title}）` : ''}  [${flags.join(', ')}]`
  })
  return [`共 ${tools.length} 个工具：`, '', ...rows].join('\n')
}

function renderStatus(manager) {
  const status = manager.status()
  const lines = [
    `代际：${status.generationId}`,
    `工具：${status.toolCount} 个（已注册 ${status.registeredCount} 个）`,
    status.ok ? '校验：通过' : '校验：有错误，相关工具沿用上一份可用定义',
    status.lastCommitAt ? `上次提交：${new Date(status.lastCommitAt).toISOString()}` : '上次提交：尚未提交',
  ]
  if (status.usedLastGood.length > 0) {
    lines.push(`沿用上一版：${status.usedLastGood.join(', ')}`)
  }
  if (status.issues.length > 0) {
    lines.push('', '诊断：')
    for (const issue of status.issues) {
      const where = issue.tool ? `[${issue.tool}] ` : ''
      lines.push(`- ${issue.severity} ${issue.code} ${where}${issue.path}: ${issue.message}`)
    }
  }
  return lines.join('\n')
}

function renderPreview(result) {
  if (result === undefined) return err('没有找到这个工具')
  if (result.ok !== true) {
    return `预览失败：[${result.code}] ${result.message}${result.hint ? `\n提示：${result.hint}` : ''}`
  }
  const sandbox = result.sandbox ?? {}
  const lines = [
    '（预览：没有启动任何进程）',
    '',
    `cwd: ${result.cwd}`,
    'argv:',
    ...result.argv.map((element, index) => `  ${index}: ${JSON.stringify(element)}`),
    '',
    `沙箱：声明 ${sandbox.declared} / 会话 ${sandbox.session} / 生效 ${sandbox.effective}`,
  ]
  if (sandbox.autoEnvKeys && sandbox.autoEnvKeys.length > 0) {
    lines.push(`自动编码环境：${sandbox.autoEnvKeys.join(', ')}`)
  }
  return lines.join('\n')
}

function renderTest(result) {
  if (result === undefined) return err('没有找到这个工具')
  const lines = []
  if (result.ok === true) {
    lines.push('执行成功。')
    lines.push(`耗时 ${result.durationMs}ms，exitCode=${result.exitCode}`)
  } else {
    lines.push(`执行失败：[${result.code}] ${result.message}`)
    if (result.hint) lines.push(`提示：${result.hint}`)
    lines.push(`耗时 ${result.durationMs}ms，exitCode=${result.exitCode}`)
  }
  if (result.stdout) lines.push('', 'stdout:', result.stdout.trimEnd())
  if (result.stderr) lines.push('', 'stderr:', result.stderr.trimEnd())
  return lines.join('\n')
}

/**
 * Register `/custom-tools` on the host.
 * @param {object} ctx cordis plugin context (`commands` service required)
 * @param {object} options
 * @param {import('../runtime/manager.js').Manager} options.manager
 * @param {string} options.namespace settings namespace (the profile row id)
 */
export function registerCommands(ctx, { manager, namespace }) {
  const flipEnabled = async (name, enabled) => {
    const entry = manager.currentEntry(name)
    if (!entry) return err(`没有找到工具 ${name}`)

    const settings = ctx.get('settings')
    if (!settings) return err('当前部署没有加载 settings 服务，无法修改配置')

    const descriptor = settings.describe()?.find?.((row) => row.ns === namespace)
    if (!descriptor) return err(`找不到配置项 ${namespace}`)

    const index = [...manager.current.tools.keys()].indexOf(name)
    if (index === -1) return err(`没有找到工具 ${name}`)

    try {
      await settings.mutate(
        namespace,
        [{ op: 'set', path: ['tools', index, 'enabled'], value: enabled }],
        descriptor.revision,
      )
    } catch (error) {
      return err(`修改配置失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return ok(`已${enabled ? '启用' : '禁用'} ${name}。`)
  }

  // `ctx.commands` is a guarded service: property access throws unless `commands`
  // is declared in inject. `ctx.get()` reads the store without that requirement,
  // so an absent service degrades to "this deployment has no slash commands".
  const commands = ctx.get('commands')
  if (!commands || typeof commands.register !== 'function') return undefined

  return ctx.effect(() => commands.register({
    name: 'custom-tools',
    description: '查看、预览、试运行、启用或禁用自定义工具',
    input: { hint: 'list | status | show <name> | preview <name> [json] | test <name> [json] | enable|disable <name>' },
    handler: async ({ rawInput, agent, signal }) => {
      const { verb, rest } = splitInput(rawInput)

      if (verb === 'help' || verb === '?') return ok(HELP)

      if (verb === 'list') return ok(renderList(manager))
      if (verb === 'status') return ok(renderStatus(manager))

      if (verb === 'show') {
        const { name } = splitNameAndArgs(rest)
        const entry = name === '' ? undefined : manager.currentEntry(name)
        if (!entry) return err('用法：/custom-tools show <name>')
        return ok(JSON.stringify(entry.spec, null, 2))
      }

      if (verb === 'preview' || verb === 'test') {
        const { name, argsText } = splitNameAndArgs(rest)
        if (name === '') return err(`用法：/custom-tools ${verb} <name> [json]`)
        const parsed = parseArgsText(argsText)
        if (!parsed.ok) return err(parsed.error)

        if (verb === 'preview') return ok(renderPreview(await manager.preview(name, parsed.value)))

        const result = await manager.test(name, parsed.value, { agent, signal })
        if (result === undefined) return err(`没有找到工具 ${name}`)
        return ok(renderTest(result))
      }

      if (verb === 'enable' || verb === 'disable') {
        const { name } = splitNameAndArgs(rest)
        if (name === '') return err(`用法：/custom-tools ${verb} <name>`)
        return flipEnabled(name, verb === 'enable')
      }

      return err(`未知子命令 ${verb}。\n\n${HELP}`)
    },
  }))
}

export default registerCommands
