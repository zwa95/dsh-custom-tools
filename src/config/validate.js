/**
 * Cross-field validation for `tools[]`.
 *
 * Pure: no Cordis, no filesystem, no network, no clock. It runs twice —
 * once at save time (so the settings page can reject a bad document before it
 * is persisted) and once at compile time (so a hand-edited patch still cannot
 * smuggle an invalid tool into the registry). Keeping it pure is what makes
 * both paths share one set of rules.
 *
 * An issue is `{ tool, path, code, message, severity }` where `path` is a
 * dotted, human-readable location (`tools[2].args[1].join`) — the settings page
 * prints it verbatim, so it must address the *document* the user is editing.
 */

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,40}$/

/**
 * Names that would shadow or confuse a built-in tool. Not an exhaustive list of
 * the host's tools — it only needs to cover the ones an author plausibly types
 * and that DSH itself may register later.
 */
export const RESERVED_NAMES = new Set([
  'bash', 'pwsh', 'powershell', 'shell', 'cmd',
  'read', 'write', 'edit', 'multi_edit', 'apply_patch',
  'grep', 'glob', 'ls', 'find', 'list', 'search', 'web_search', 'web_fetch',
  'task', 'todo', 'todo_write', 'subagent', 'workflow', 'skill',
  'send_message', 'ask_user_question', 'create_goal', 'update_goal', 'get_goal',
  'compress', 'decompress', 'search_context', 'acp_status',
  'custom_tools', 'custom-tools', 'custom_tools_propose', 'custom_tools_schema',
])

const fail = (tool, path, code, message) => ({
  tool: tool === undefined ? undefined : tool,
  path,
  code,
  message,
  severity: 'error',
})

const warn = (tool, path, code, message) => ({
  tool: tool === undefined ? undefined : tool,
  path,
  code,
  message,
  severity: 'warning',
})

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Every key a stored definition may carry, grouped by where it lives.
 *
 * These lists exist so that a misspelt or invented key is reported instead of
 * being silently dropped. Silence is the expensive failure here: a model that
 * writes `execution` instead of `mode` would otherwise get "executable 模式必须
 * 给出 executable" and go on patching the wrong shape.
 */
const TOOL_KEYS = [
  'name', 'title', 'description', 'whenToUse', 'mode', 'enabled',
  'executable', 'interpreter', 'script', 'command',
  'args', 'cwd', 'approval', 'concurrency', 'timeoutMs',
  'env', 'encodingDefaults', 'credentials', 'parameters', 'output', 'examples',
  // Retired fields: kept out of the "unknown key" list so they still get their
  // own targeted "this no longer does anything" warning.
  'scriptSha256', 'scriptTrust',
]

const BINDING_KEYS = [
  'literal', 'arg', 'flag', 'as', 'prefix', 'suffix', 'join', 'repeat', 'json',
  'stdin', 'omitIfEmpty', 'allowLeadingDash', 'allowResponseFile',
]

const PARAMETER_KEYS = [
  'type', 'items', 'required', 'default', 'description',
  'min', 'max', 'minLength', 'maxLength',
]

const CREDENTIAL_KEYS = ['env', 'ref']
const EXAMPLE_KEYS = ['name', 'args']
const OUTPUT_KEYS = ['parse', 'schema']

/** Levenshtein distance, bounded: these strings are all short. */
function distance(left, right) {
  const rows = left.length + 1
  const columns = right.length + 1
  let previous = Array.from({ length: columns }, (_, index) => index)
  for (let row = 1; row < rows; row += 1) {
    const current = [row]
    for (let column = 1; column < columns; column += 1) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution)
    }
    previous = current
  }
  return previous[columns - 1]
}

/** The allowed key the author most likely meant, or undefined when unsure. */
function closestKey(key, allowed) {
  const lowered = key.toLowerCase()
  let best
  let bestScore = Number.POSITIVE_INFINITY
  for (const candidate of allowed) {
    const candidateLowered = candidate.toLowerCase()
    const score = candidateLowered.startsWith(lowered) || lowered.startsWith(candidateLowered)
      ? 0
      : distance(lowered, candidateLowered)
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  const limit = Math.max(2, Math.floor(key.length / 3))
  return bestScore <= limit ? best : undefined
}

/**
 * Report keys that no reader would ever look at.
 *
 * @param {string|undefined} toolName tool being validated, for the issue row
 * @param {object} object record to inspect
 * @param {string[]} allowed keys that have meaning at this position
 * @param {string} path dotted path of `object`
 * @param {object[]} issues collector
 * @param {string} where human label for the position, e.g. `参数 path 上的`
 */
function checkKeys(toolName, object, allowed, path, issues, where) {
  for (const key of Object.keys(object)) {
    if (allowed.includes(key)) continue
    const guess = closestKey(key, allowed)
    issues.push(fail(toolName, `${path}.${key}`, 'UNKNOWN_KEY',
      `${where}没有 ${key} 这个字段${guess ? `，是否想写 ${guess}？` : ''}。可用字段：${allowed.join(', ')}`))
  }
}

/**
 * Absolute on either platform, because a definition written on Windows may be
 * read on Linux and the rule must not depend on where it is validated.
 */
const isAbsolutePath = (value) =>
  value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')

/** Which argv directives a binding carries, for the "exactly one" rule. */
function bindingShape(binding) {
  const shape = []
  if (typeof binding.literal === 'string') shape.push('literal')
  if (typeof binding.arg === 'string') shape.push('arg')
  if (typeof binding.flag === 'string') shape.push('flag')
  return shape
}

function validateParameter(toolName, paramName, spec, path, issues) {
  if (!isPlainObject(spec)) {
    issues.push(fail(toolName, path, 'PARAMETER_SHAPE', `参数 ${paramName} 必须是对象`))
    return
  }
  checkKeys(toolName, spec, PARAMETER_KEYS, path, issues, `参数 ${paramName} 上`)

  const type = spec.type
  if (!['string', 'number', 'integer', 'boolean', 'array'].includes(type)) {
    issues.push(fail(toolName, path, 'PARAMETER_TYPE',
      `参数 ${paramName} 的 type 必须是 string/number/integer/boolean/array`))
    return
  }

  if (type === 'array') {
    if (!spec.items) {
      issues.push(fail(toolName, path, 'PARAMETER_ITEMS',
        `数组参数 ${paramName} 必须声明 items，写成元素类型名，例如 "items": "string"`))
    } else if (!['string', 'number', 'integer', 'boolean'].includes(spec.items)) {
      // The element type is a bare name, not a nested schema — a model that has
      // just written a JSON Schema will reach for { "type": "string" } here.
      issues.push(fail(toolName, path, 'PARAMETER_ITEMS',
        `数组参数 ${paramName} 的 items 写成元素类型名，例如 "items": "string"；`
        + `不能写成 { "type": "string" } 这样的嵌套 schema。当前是 ${JSON.stringify(spec.items)}`))
    }
  } else if (spec.items !== undefined) {
    issues.push(warn(toolName, `${path}.items`, 'PARAMETER_ITEMS_IGNORED',
      `参数 ${paramName} 不是数组，items 会被忽略`))
  }

  if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
    issues.push(fail(toolName, `${path}.min`, 'PARAMETER_RANGE',
      `参数 ${paramName} 的 min 大于 max`))
  }
  if (spec.minLength !== undefined && spec.maxLength !== undefined
    && spec.minLength > spec.maxLength) {
    issues.push(fail(toolName, `${path}.minLength`, 'PARAMETER_LENGTH',
      `参数 ${paramName} 的 minLength 大于 maxLength`))
  }

  if (spec.default !== undefined && spec.default !== '') {
    // A default is JSON *text* — a string whose content is the JSON. A number
    // written bare (`default: 20`) validated here but then failed at call time
    // with "参数 count 必须是数字", because the runtime parses the text. Reject
    // it at the definition instead, where the message can show the fix.
    if (typeof spec.default !== 'string') {
      issues.push(fail(toolName, `${path}.default`, 'PARAMETER_DEFAULT_TEXT',
        `参数 ${paramName} 的 default 要写成 JSON 文本（带引号的字符串），当前是 ${JSON.stringify(spec.default)}；`
        + `应写成 ${JSON.stringify(JSON.stringify(spec.default))}`))
    } else {
      const parsed = tryParseJson(spec.default)
      if (!parsed.ok) {
        // A plain "." looks fine and is not JSON. Say what to write instead of
        // only what is wrong — a model wrote `"."` here believing the sample's
        // escaped form was the mistake.
        issues.push(fail(toolName, `${path}.default`, 'PARAMETER_DEFAULT_JSON',
          `参数 ${paramName} 的 default 要以 JSON 文本给出：字符串写成 ${JSON.stringify(JSON.stringify(String(spec.default)))}，`
          + '数字写成 "20"，布尔写成 "false"。当前值不是合法 JSON：' + parsed.error))
      }
    }
  }
}

export function tryParseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: true, value: undefined }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function validateArgs(tool, path, issues) {
  const parameters = isPlainObject(tool.parameters) ? tool.parameters : {}
  const args = Array.isArray(tool.args) ? tool.args : []
  let stdinCount = 0

  args.forEach((binding, index) => {
    const at = `${path}.args[${index}]`
    if (!isPlainObject(binding)) {
      issues.push(fail(tool.name, at, 'ARG_SHAPE',
        `每个 arg 条目必须是对象；固定参数写成 { "literal": "${typeof binding === 'string' ? binding : '...'}" }，取值写成 { "arg": "参数名" }`))
      return
    }
    checkKeys(tool.name, binding, BINDING_KEYS, at, issues, 'arg 条目上')

    const shape = bindingShape(binding)
    const hasStdin = binding.stdin !== undefined

    if (shape.length === 0 && !hasStdin) {
      issues.push(fail(tool.name, at, 'ARG_EMPTY',
        'arg 条目必须给出 literal、arg 或 flag 之一'))
      return
    }
    if (shape.length > 1) {
      issues.push(fail(tool.name, at, 'ARG_AMBIGUOUS',
        `arg 条目同时声明了 ${shape.join(' / ')}，只能选一个`))
      return
    }

    if (hasStdin) {
      stdinCount += 1
      if (binding.stdin !== 'raw' && binding.stdin !== 'json') {
        issues.push(fail(tool.name, `${at}.stdin`, 'ARG_STDIN_VALUE',
          'stdin 只能是 "raw" 或 "json"'))
      }
      if (binding.stdin === 'raw' && shape[0] !== 'arg') {
        issues.push(fail(tool.name, `${at}.stdin`, 'ARG_STDIN_RAW_SOURCE',
          'stdin: "raw" 必须与 arg 一起使用'))
      }
      if (binding.stdin === 'json' && shape.length > 0) {
        issues.push(fail(tool.name, `${at}.stdin`, 'ARG_STDIN_JSON_EXCLUSIVE',
          'stdin: "json" 必须是独立条目，不能同时绑定 literal/arg/flag'))
      }
    }

    if (shape[0] === 'literal') {
      const extra = ['arg', 'flag', 'prefix', 'suffix', 'join', 'repeat', 'json',
        'omitIfEmpty', 'allowLeadingDash', 'allowResponseFile'].filter(
        (key) => binding[key] !== undefined && binding[key] !== false,
      )
      if (extra.length > 0) {
        issues.push(warn(tool.name, at, 'ARG_LITERAL_EXTRA',
          `literal 条目上的 ${extra.join('/')} 不会生效`))
      }
      if (typeof binding.literal !== 'string') {
        issues.push(fail(tool.name, `${at}.literal`, 'ARG_LITERAL_TYPE',
          'literal 必须是字符串'))
      }
      return
    }

    if (shape[0] === 'flag') {
      if (binding.as === undefined) {
        issues.push(fail(tool.name, `${at}.as`, 'ARG_FLAG_AS',
          'flag 条目必须声明 as（true 时输出什么）'))
      } else if (typeof binding.as !== 'string'
        && !(Array.isArray(binding.as) && binding.as.every((v) => typeof v === 'string'))) {
        issues.push(fail(tool.name, `${at}.as`, 'ARG_FLAG_AS_TYPE',
          'as 必须是字符串或字符串数组'))
      }
      if (binding.repeat || binding.join !== undefined || binding.json) {
        issues.push(fail(tool.name, at, 'ARG_FLAG_MAPPER',
          'flag 条目不能同时使用 repeat / join / json'))
      }
      if (binding.stdin !== undefined && binding.stdin !== 'json') {
        issues.push(fail(tool.name, `${at}.stdin`, 'ARG_FLAG_STDIN',
          'flag 条目不能写 stdin'))
      }
      const spec = parameters[binding.flag]
      if (!spec) {
        issues.push(fail(tool.name, at, 'ARG_FLAG_UNKNOWN_PARAMETER',
          `flag 引用了未声明的参数 ${binding.flag}`))
      } else if (spec.type !== 'boolean') {
        issues.push(fail(tool.name, at, 'ARG_FLAG_NOT_BOOLEAN',
          `flag 引用的参数 ${binding.flag} 必须是 boolean`))
      }
      return
    }

    if (shape.length === 0) return // bare `{stdin:'json'}` already validated above

    // shape[0] === 'arg'
    const spec = parameters[binding.arg]
    if (!spec) {
      issues.push(fail(tool.name, at, 'ARG_UNKNOWN_PARAMETER',
        `arg 引用了未声明的参数 ${binding.arg}`))
    } else {
      if (binding.repeat && spec.type !== 'array') {
        issues.push(fail(tool.name, `${at}.repeat`, 'ARG_REPEAT_TYPE',
          `repeat 只能用于数组参数（${binding.arg} 是 ${spec.type}）`))
      }
      if (binding.join !== undefined && spec.type !== 'array') {
        issues.push(fail(tool.name, `${at}.join`, 'ARG_JOIN_TYPE',
          `join 只能用于数组参数（${binding.arg} 是 ${spec.type}）`))
      }
      if (binding.repeat && binding.join !== undefined) {
        issues.push(fail(tool.name, at, 'ARG_REPEAT_JOIN',
          'repeat 与 join 互斥：一个产出多个元素，一个产出单个元素'))
      }
      if (binding.join !== undefined && binding.repeat) {
        issues.push(fail(tool.name, at, 'ARG_DECORATION_CONFLICT',
          'repeat 下 join 不会生效'))
      }
      if (binding.allowResponseFile && spec.type !== 'string' && spec.type !== 'array') {
        issues.push(warn(tool.name, `${at}.allowResponseFile`, 'ARG_RESPONSE_FILE_TYPE',
          'allowResponseFile 只对 string / array 参数有意义'))
      }
    }

    if (binding.stdin === 'raw' && binding.repeat) {
      issues.push(fail(tool.name, `${at}.stdin`, 'ARG_STDIN_RAW_REPEAT',
        'stdin: "raw" 需要单个标量值，不能与 repeat 一起使用'))
    }
  })

  if (stdinCount > 1) {
    issues.push(fail(tool.name, path, 'ARG_STDIN_DUPLICATE',
      `最多只能有一个 stdin 映射，当前有 ${stdinCount} 个`))
  }

  // Shell modes get their values positionally: `bash -c <source> <argv0> <args…>`
  // exposes them as "$@", and everything after `pwsh -Command <source>` lands in
  // $args. That is safe (no interpolation) and leaves the fixed source untouched,
  // so no extra restriction is needed here beyond the global rules above.
}

/**
 * `powershell -Command <source>` appends trailing tokens to the command text
 * instead of binding them to `$args`, so a positional binding would either be
 * ignored or silently become part of the script. Parameters reach PowerShell as
 * one JSON document on stdin.
 */
function validatePowershellArgs(tool, path, issues) {
  const bindings = Array.isArray(tool.args) ? tool.args : []
  const isStdin = (binding) => binding && (binding.stdin === 'json'
    || (binding.stdin === 'raw' && binding.arg !== undefined))

  bindings.forEach((binding, index) => {
    if (isStdin(binding)) return
    issues.push(fail(tool.name, `${path}.args[${index}]`, 'POWERSHELL_ARGV_UNSUPPORTED',
      'powershell 模式下 -Command 之后的标记不会进入 $args；请改用 { stdin: "json" }'))
  })

  const hasParameters = Object.keys(tool.parameters ?? {}).length > 0
  if (hasParameters && !bindings.some(isStdin)) {
    issues.push(fail(tool.name, `${path}.args`, 'POWERSHELL_STDIN_REQUIRED',
      '声明了 parameters 的 powershell 工具必须有一条 { stdin: "json" } 绑定，参数才能到达脚本'))
  }
}

function validateMode(tool, path, issues) {
  const mode = tool.mode ?? 'executable'
  const require = (field, message) => {
    if (typeof tool[field] !== 'string' || tool[field].trim() === '') {
      issues.push(fail(tool.name, `${path}.${field}`, 'MODE_FIELD_REQUIRED', message))
    }
  }
  const forbid = (field, message) => {
    if (tool[field] !== undefined && tool[field] !== '') {
      issues.push(warn(tool.name, `${path}.${field}`, 'MODE_FIELD_IGNORED', message))
    }
  }

  if (mode === 'executable') {
    require('executable', 'executable 模式必须给出 executable')
    forbid('interpreter', 'executable 模式下 interpreter 不生效')
    forbid('script', 'executable 模式下 script 不生效')
    forbid('command', 'executable 模式下 command 不生效')
  } else if (mode === 'script') {
    require('interpreter', 'script 模式必须给出 interpreter')
    require('script', 'script 模式必须给出 script（绝对路径）')
    forbid('executable', 'script 模式下 executable 不生效')
    forbid('command', 'script 模式下 command 不生效')
  } else {
    require('command', `${mode} 模式必须给出固定的 command 源码`)
    // `executable` is the shell binary: it defaults to `bash`/`pwsh` on PATH and
    // may be pointed at a specific installation when PATH has the wrong one.
    forbid('interpreter', `${mode} 模式下请用 executable 指定 shell，interpreter 不生效`)
    forbid('script', `${mode} 模式下 script 不生效`)
    // `??` in the compiler only defaults an *absent* field: `executable: ''`
    // would be executed as the empty name and fail at call time instead.
    if (tool.executable !== undefined
      && (typeof tool.executable !== 'string' || tool.executable.trim() === '')) {
      issues.push(fail(tool.name, `${path}.executable`, 'MODE_FIELD_REQUIRED',
        `executable 要么删掉（默认用 ${mode === 'bash' ? 'bash' : 'pwsh'}），要么写 shell 名或绝对路径；空字符串不是默认值`))
    }
    if (mode === 'powershell') validatePowershellArgs(tool, path, issues)
  }

  if (tool.scriptSha256 !== undefined && tool.scriptSha256 !== ''
    && !/^[0-9a-f]{64}$/.test(tool.scriptSha256)) {
    issues.push(warn(tool.name, `${path}.scriptSha256`, 'SCRIPT_HASH_IGNORED',
      'scriptSha256 已不再使用，可以删掉；脚本内容由你自己负责'))
  }
  if (tool.scriptTrust !== undefined) {
    issues.push(warn(tool.name, `${path}.scriptTrust`, 'SCRIPT_TRUST_IGNORED',
      'scriptTrust 已不再使用，可以删掉；路径写对就行'))
  }
}

export function validateTool(tool, path = 'tools[0]') {
  const issues = []

  if (!isPlainObject(tool)) {
    issues.push(fail(undefined, path, 'TOOL_SHAPE', '每个工具必须是对象'))
    return issues
  }
  checkKeys(undefined, tool, TOOL_KEYS, path, issues, '工具定义里')

  if (typeof tool.name !== 'string' || !NAME_PATTERN.test(tool.name)) {
    issues.push(fail(tool.name, `${path}.name`, 'TOOL_NAME_FORMAT',
      '工具名必须匹配 ^[a-z][a-z0-9_]{0,40}$'))
  } else if (RESERVED_NAMES.has(tool.name)) {
    issues.push(fail(tool.name, `${path}.name`, 'TOOL_NAME_RESERVED',
      `${tool.name} 是保留名，请换一个`))
  }

  if (typeof tool.description !== 'string' || tool.description.trim() === '') {
    issues.push(fail(tool.name, `${path}.description`, 'TOOL_DESCRIPTION_REQUIRED',
      'description 不能为空：它是模型决定是否调用这个工具的唯一依据'))
  }

  if (tool.timeoutMs !== undefined
    && (tool.timeoutMs < 1000 || tool.timeoutMs > 600000)) {
    issues.push(fail(tool.name, `${path}.timeoutMs`, 'TIMEOUT_RANGE',
      'timeoutMs 必须在 1000..600000 之间'))
  }

  // Two shapes only: the session directory (`.`) or an absolute path. A
  // relative path would silently mean "relative to wherever the harness
  // happened to start", which is exactly the ambiguity this field must not have.
  const cwd = tool.cwd === undefined ? '.' : tool.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    issues.push(fail(tool.name, `${path}.cwd`, 'CWD_SHAPE',
      'cwd 只能是 . （会话目录）或一个绝对路径'))
  } else if (cwd !== '.' && !isAbsolutePath(cwd)) {
    issues.push(fail(tool.name, `${path}.cwd`, 'CWD_NOT_ABSOLUTE',
      `cwd 必须写成绝对路径（当前是 ${cwd}）；想用会话目录就写 .`))
  }

  if (isPlainObject(tool.env)) {    for (const key of Object.keys(tool.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        issues.push(fail(tool.name, `${path}.env.${key}`, 'ENV_KEY_FORMAT',
          `环境变量名 ${key} 不合法`))
      }
    }
  }

  if (isPlainObject(tool.parameters)) {
    // The most common wrong shape by far: a JSON Schema pasted in where the
    // plugin wants a `name → spec` map. Detect it once instead of reporting
    // three bogus "parameter type/properties/required" rows.
    const looksLikeSchema = tool.parameters.type === 'object'
      || Object.hasOwn(tool.parameters, 'properties')
      || Object.hasOwn(tool.parameters, 'additionalProperties')
    if (looksLikeSchema) {
      issues.push(fail(tool.name, `${path}.parameters`, 'PARAMETERS_IS_SCHEMA',
        'parameters 要写成「参数名 → 规格」的映射，不是一份 JSON Schema；例如 pattern: { type: "string", required: true, description: "要找的字符串" }'))
    } else {
      for (const [paramName, spec] of Object.entries(tool.parameters)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(paramName)) {
          issues.push(fail(tool.name, `${path}.parameters.${paramName}`, 'PARAMETER_NAME',
            `参数名 ${paramName} 必须是合法标识符`))
          continue
        }
        validateParameter(tool.name, paramName, spec, `${path}.parameters.${paramName}`, issues)
      }
    }
  }

  if (Array.isArray(tool.credentials)) {
    const seen = new Set()
    tool.credentials.forEach((binding, index) => {
      const at = `${path}.credentials[${index}]`
      if (!isPlainObject(binding)) {
        issues.push(fail(tool.name, at, 'CREDENTIAL_SHAPE', '凭据条目必须是对象'))
        return
      }
      checkKeys(tool.name, binding, CREDENTIAL_KEYS, at, issues, '凭据条目上')
      if (typeof binding.env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.env)) {
        issues.push(fail(tool.name, `${at}.env`, 'CREDENTIAL_ENV',
          '凭据的 env 必须是合法环境变量名'))
      } else if (seen.has(binding.env)) {
        issues.push(fail(tool.name, `${at}.env`, 'CREDENTIAL_DUPLICATE',
          `凭据注入 ${binding.env} 重复声明`))
      } else {
        seen.add(binding.env)
      }
      if (typeof binding.ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.ref)) {
        issues.push(fail(tool.name, `${at}.ref`, 'CREDENTIAL_REF',
          '凭据 ref 必须是合法引用名（字母/数字/下划线，不以数字开头）'))
      }
      if (isPlainObject(tool.env) && binding.env in tool.env) {
        issues.push(fail(tool.name, `${at}.env`, 'CREDENTIAL_ENV_CONFLICT',
          `${binding.env} 同时出现在 env 与 credentials 里，隐式覆盖会让凭据失效排查变难`))
      }
    })
  }

  if (isPlainObject(tool.output)) {
    checkKeys(tool.name, tool.output, OUTPUT_KEYS, `${path}.output`, issues, 'output 里')
    if (tool.output.parse === 'json' && tool.output.schema !== undefined
      && tool.output.schema !== '') {
      const parsed = tryParseJson(tool.output.schema)
      if (!parsed.ok) {
        issues.push(fail(tool.name, `${path}.output.schema`, 'OUTPUT_SCHEMA_JSON',
          `output.schema 不是合法 JSON：${parsed.error}`))
      }
    }
    if (tool.output.parse !== 'json' && tool.output.schema) {
      issues.push(warn(tool.name, `${path}.output.schema`, 'OUTPUT_SCHEMA_IGNORED',
        'output.schema 只在 parse: json 时生效'))
    }
  }

  if (Array.isArray(tool.examples)) {
    tool.examples.forEach((example, index) => {
      const at = `${path}.examples[${index}]`
      if (!isPlainObject(example)) {
        issues.push(fail(tool.name, at, 'EXAMPLE_SHAPE', '示例必须是对象'))
        return
      }
      checkKeys(tool.name, example, EXAMPLE_KEYS, at, issues, '示例上')
      if (typeof example.name !== 'string' || example.name.trim() === '') {
        issues.push(fail(tool.name, `${at}.name`, 'EXAMPLE_NAME', '示例必须有名字'))
      }
      const parsed = tryParseJson(example.args)
      if (!parsed.ok) {
        issues.push(fail(tool.name, `${at}.args`, 'EXAMPLE_ARGS_JSON',
          `示例参数不是合法 JSON：${parsed.error}`))
      } else if (parsed.value !== undefined && !isPlainObject(parsed.value)) {
        issues.push(fail(tool.name, `${at}.args`, 'EXAMPLE_ARGS_OBJECT',
          '示例参数必须是 JSON 对象'))
      } else if (parsed.value !== undefined) {
        const declared = isPlainObject(tool.parameters) ? tool.parameters : {}
        for (const key of Object.keys(parsed.value)) {
          if (!(key in declared)) {
            issues.push(fail(tool.name, `${at}.args.${key}`, 'EXAMPLE_ARGS_UNKNOWN',
              `示例用了未声明的参数 ${key}`))
          }
        }
      }
    })
  }

  validateMode(tool, path, issues)
  validateArgs(tool, path, issues)

  return issues
}

/**
 * Validate the whole snapshot. Duplicate names are reported once, on the second
 * and later occurrences, so the first one keeps working.
 */
export function validateSnapshot(snapshot) {
  const tools = snapshot && Array.isArray(snapshot.tools) ? snapshot.tools : []
  const issues = []
  const seen = new Map()

  tools.forEach((tool, index) => {
    const path = `tools[${index}]`
    issues.push(...validateTool(tool, path))

    const name = isPlainObject(tool) ? tool.name : undefined
    if (typeof name === 'string') {
      if (seen.has(name)) {
        issues.push(fail(name, `${path}.name`, 'TOOL_NAME_DUPLICATE',
          `工具名 ${name} 与 tools[${seen.get(name)}] 重复；后一个不会被加载`))
      } else {
        seen.set(name, index)
      }
    }
  })

  return {
    issues,
    errors: issues.filter((issue) => issue.severity === 'error'),
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  }
}

export default validateSnapshot
