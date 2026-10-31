/**
 * `tools[]` snapshot → immutable generation content.
 *
 * Pure on purpose: no services, no I/O, no clock, no `await`. Everything the
 * executor will need is decided here, so a definition can be validated in a unit
 * test and previewed without a running host.
 *
 * Failure policy — deliberately *per tool*, not per document:
 *
 *   - A tool with errors does not enter the candidate generation.
 *   - If the previous generation already had that tool, its previous compiled
 *     form is carried forward ("last good"). That is what makes "I broke one
 *     definition while editing it" a non-event for the rest of the profile.
 *   - If the whole snapshot is unusable (not an array), nothing is committed and
 *     the previous generation keeps serving untouched.
 *
 * A disabled tool is still compiled: `/custom-tools test` and `preview` must work
 * on it, and re-enabling it should not require a recompile.
 */
import { validateSnapshot, tryParseJson } from '../config/validate.js'
import { normalizeArguments, toParameterProperties } from './parameters.js'
import { contractHashOf } from './hash.js'

const POWER_SHELL_FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive']

function freezeDeep(value) {
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freezeDeep(item)
    return Object.freeze(value)
  }
  return value
}

function compileOne(spec, deferLoading) {
  const parameters = spec.parameters ?? {}
  const parameterSchema = toParameterProperties(parameters)

  const description = spec.whenToUse
    ? `${spec.description}\n\nWhen to use: ${spec.whenToUse}`
    : spec.description

  const output = spec.output ?? { parse: 'text' }
  let outputSchema
  if (output.parse === 'json' && typeof output.schema === 'string' && output.schema !== '') {
    const parsed = tryParseJson(output.schema)
    if (parsed.ok) outputSchema = parsed.value
  }

  const plan = {
    name: spec.name,
    title: spec.title,
    description,
    whenToUse: spec.whenToUse,
    mode: spec.mode ?? 'executable',
    enabled: spec.enabled !== false,

    // Shell modes always have an executable: it is the shell itself. Preflight
    // resolves it to an absolute path before spawn, so this name is only what
    // `preview` prints.
    executable: spec.executable
      ?? ((spec.mode ?? 'executable') === 'bash' ? 'bash'
        : (spec.mode ?? 'executable') === 'powershell' ? 'pwsh'
          : undefined),
    interpreter: spec.interpreter,
    script: spec.script,
    scriptTrust: spec.scriptTrust ?? 'trusted-path',
    scriptSha256: spec.scriptSha256 || undefined,
    command: spec.command,
    flags: (spec.mode ?? 'executable') === 'powershell' ? [...POWER_SHELL_FLAGS] : [],

    args: Array.isArray(spec.args) ? spec.args : [],
    cwd: typeof spec.cwd === 'string' && spec.cwd !== '' ? spec.cwd : '.',
    approval: spec.approval ?? 'inherit',
    concurrency: spec.concurrency ?? 'exclusive',
    timeoutMs: spec.timeoutMs ?? 120000,
    env: spec.env ?? {},
    encodingDefaults: spec.encodingDefaults !== false,
    credentials: Array.isArray(spec.credentials) ? spec.credentials : [],

    parameters,
    parameterSchema,
    deferLoading: deferLoading === true,
    output: { parse: output.parse ?? 'text', schema: outputSchema },
    examples: Array.isArray(spec.examples) ? spec.examples : [],
  }

  const compiled = {
    name: spec.name,
    contractHash: contractHashOf(plan),
    plan: freezeDeep(plan),
    // Raw spec is kept for the settings page / `show`, never for execution.
    spec: freezeDeep(spec),
  }
  return compiled
}

/**
 * @param {{tools?: unknown, deferLoading?: unknown}} snapshot
 * @param {Map<string, {compiled: object}>} [previous] last committed tools
 * @returns {{ok: boolean, tools: Map<string, object>, issues: object[],
 *            usedLastGood: string[]}}
 */
export function compile(snapshot, previous) {
  const tools = snapshot && Array.isArray(snapshot.tools) ? snapshot.tools : undefined
  if (tools === undefined) {
    return {
      ok: false,
      tools: new Map(previous ?? []),
      issues: [{
        path: 'tools',
        code: 'TOOLS_NOT_ARRAY',
        message: 'tools 必须是一个数组',
        severity: 'error',
      }],
      usedLastGood: [...(previous?.keys() ?? [])],
    }
  }

  const deferLoading = snapshot?.deferLoading === true
  const { issues } = validateSnapshot({ tools })
  const errorNames = new Set(
    issues.filter((issue) => issue.severity === 'error' && issue.tool).map((issue) => issue.tool),
  )

  const next = new Map()
  const usedLastGood = []

  for (const spec of tools) {
    const name = spec && typeof spec.name === 'string' ? spec.name : undefined
    if (name === undefined || errorNames.has(name)) {
      if (name !== undefined && previous?.has(name)) {
        next.set(name, previous.get(name))
        usedLastGood.push(name)
      }
      continue
    }
    if (next.has(name)) {
      // Duplicate name: keep the first, report already emitted by validation.
      continue
    }
    next.set(name, compileOne(spec, deferLoading))
  }

  return { ok: true, tools: next, issues, usedLastGood }
}

export { normalizeArguments, toParameterProperties, contractHashOf }
export default compile
