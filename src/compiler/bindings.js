/**
 * Declarative binding → exact argv / stdin.
 *
 * This module is the reason the plugin can promise "the model value never
 * becomes shell source". It only ever produces *array elements* and one optional
 * stdin document; there is no string concatenation of user values into any
 * command text, and no quoting/escaping helper to get wrong.
 *
 * Pure: no process, no filesystem, no services. `buildInvocation` is what
 * `preview` prints and what the executor spawns, so the preview cannot lie.
 */

const NUL = '\u0000'

function formatScalar(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return String(value)
}

/**
 * Guard against accidental CLI option injection and response-file injection.
 * Both are opt-in per binding, and the check runs on the *value*, never on the
 * author's prefix/suffix.
 */
function guardValue(binding, value) {
  if (value.includes(NUL)) {
    return `参数 ${binding.arg ?? binding.flag} 的值不能包含 NUL 字节`
  }
  if (!binding.allowLeadingDash && value.startsWith('-')) {
    return `参数 ${binding.arg ?? binding.flag} 的值以 - 开头，会被当成命令选项；`
      + '确认安全后在该 arg 条目上设置 allowLeadingDash: true'
  }
  if (!binding.allowResponseFile && value.startsWith('@')) {
    return `参数 ${binding.arg ?? binding.flag} 的值以 @ 开头，可能被当作 response file；`
      + '确认安全后在该 arg 条目上设置 allowResponseFile: true'
  }
  return undefined
}

function isEmpty(value) {
  return value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0)
}

function emitArray(binding, items, out, errors) {
  if (binding.repeat) {
    for (const item of items) {
      const text = formatScalar(item)
      const problem = guardValue(binding, text)
      if (problem) {
        errors.push(problem)
        return
      }
      out.push(`${binding.prefix ?? ''}${text}${binding.suffix ?? ''}`)
    }
    return
  }

  const joined = binding.join === undefined
    ? items.map(formatScalar).join(' ')
    : items.map(formatScalar).join(binding.join)
  const problem = items.length > 0 ? guardValue(binding, String(items[0])) : undefined
  if (problem) {
    errors.push(problem)
    return
  }
  out.push(`${binding.prefix ?? ''}${joined}${binding.suffix ?? ''}`)
}

/**
 * @param {object} plan compiled tool plan (mode + args + target fields)
 * @param {Record<string, unknown>} values normalised parameter values
 * @param {{executable?: string, interpreter?: string}} [resolved]
 *   Absolute paths discovered at preflight. Preview omits them, so the printed
 *   argv shows what the author configured; execution passes them so the child
 *   never depends on PATH lookup at spawn time.
 * @returns {{ok: true, argv: string[], stdin?: {kind: 'raw'|'json', text: string}}
 *          | {ok: false, errors: string[]}}
 */
export function buildInvocation(plan, values, resolved = {}) {
  const errors = []
  const positional = []
  let stdin
  const executable = resolved.executable ?? plan.executable
  const interpreter = resolved.interpreter ?? plan.interpreter

  for (const binding of plan.args) {
    if (binding.stdin === 'json') {
      stdin = { kind: 'json', text: JSON.stringify(values) }
      continue
    }

    if (binding.literal !== undefined) {
      positional.push(binding.literal)
      continue
    }

    if (binding.flag !== undefined) {
      const on = values[binding.flag] === true
      if (!on) continue
      const as = Array.isArray(binding.as) ? binding.as : [binding.as]
      for (const element of as) {
        if (typeof element !== 'string') {
          errors.push(`flag ${binding.flag} 的 as 必须是字符串`)
          continue
        }
        positional.push(element)
      }
      continue
    }

    if (binding.arg === undefined) {
      errors.push('arg 条目既没有 literal/flag 也没有 arg')
      continue
    }

    const raw = values[binding.arg]

    if (binding.stdin === 'raw') {
      if (raw === undefined || raw === null) {
        if (binding.omitIfEmpty) continue
        errors.push(`参数 ${binding.arg} 没有值可写入 stdin`)
        continue
      }
      if (typeof raw === 'object') {
        errors.push(`stdin: "raw" 只接受标量或数组，不接受对象`)
        continue
      }
      stdin = {
        kind: 'raw',
        text: Array.isArray(raw) ? raw.map(formatScalar).join('\n') : formatScalar(raw),
      }
      continue
    }

    if (isEmpty(raw)) {
      if (binding.omitIfEmpty) continue
      if (raw === undefined) continue
      if (Array.isArray(raw)) continue // an empty array contributes no element
      // An empty string still renders as one element, so `--format=` style
      // prefixes keep working when the value is deliberately blank.
      positional.push(`${binding.prefix ?? ''}${binding.suffix ?? ''}`)
      continue
    }

    if (binding.json) {
      positional.push(`${binding.prefix ?? ''}${JSON.stringify(raw)}${binding.suffix ?? ''}`)
      continue
    }

    if (Array.isArray(raw)) {
      emitArray(binding, raw, positional, errors)
      continue
    }

    const text = formatScalar(raw)
    const problem = guardValue(binding, text)
    if (problem) {
      errors.push(problem)
      continue
    }
    positional.push(`${binding.prefix ?? ''}${text}${binding.suffix ?? ''}`)
  }

  if (errors.length > 0) return { ok: false, errors }

  let argv
  if (plan.mode === 'bash') {
    // `bash -c <source> <argv0> <args...>` puts the values in "$@" only.
    argv = [executable, '-c', plan.command, 'custom-tool', ...positional]
  } else if (plan.mode === 'powershell') {
    // `-Command` takes the script text and nothing else: trailing tokens are
    // appended to the command text rather than bound to `$args` (measured on
    // Windows PowerShell 5.1, where `-Command 'Write-Output $args.Count' a b`
    // prints 0 and then evaluates `a`). Parameters travel as stdin JSON.
    if (positional.length > 0) {
      return {
        ok: false,
        errors: ['powershell 模式不能把参数放进 argv：-Command 之后的标记会被拼进命令文本；请改用 { stdin: "json" }'],
      }
    }
    argv = [executable, ...plan.flags, '-Command', plan.command]
  } else if (plan.mode === 'script') {
    argv = [interpreter, plan.script, ...positional]
  } else {
    argv = [executable, ...positional]
  }

  for (const element of argv) {
    if (typeof element !== 'string') {
      return { ok: false, errors: ['argv 元素必须是字符串'] }
    }
    if (element.includes(NUL)) {
      return { ok: false, errors: ['argv 元素不能包含 NUL 字节'] }
    }
  }

  return stdin === undefined ? { ok: true, argv } : { ok: true, argv, stdin }
}

export default buildInvocation
