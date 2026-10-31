/**
 * The one output contract every custom tool returns.
 *
 * It is deliberately *universal*: the same object shape for executable, script,
 * bash and PowerShell modes, success and failure. That is what lets the renderer
 * be a single function and what makes `createExecution`'s captured presenter
 * still correct after a hot swap (see the generation notes in the design).
 *
 * The shape is also chosen to be expressible in the host's restricted schema
 * subset: no `type` together with `oneOf`, nullable fields declined as child
 * `oneOf`, and no untyped `value` node (the parsed payload travels as JSON text
 * in `data`).
 */

export const ERROR_CODES = Object.freeze([
  'INVALID_CONFIG',
  'INVALID_ARGUMENT',
  'TOOL_RELOADING',
  'CREDENTIAL_UNAVAILABLE',
  'APPROVAL_REJECTED',
  'APPROVAL_UNAVAILABLE',
  'CWD_UNAVAILABLE',
  'SCRIPT_UNAVAILABLE',
  'EXECUTABLE_NOT_FOUND',
  'SPAWN_FAILED',
  'ABORTED',
  'TIMED_OUT',
  'PROCESS_EXIT',
  'PROCESS_SIGNALED',
  'OUTPUT_LIMIT',
  'INVALID_JSON_OUTPUT',
  'OUTPUT_SCHEMA_MISMATCH',
  'CUSTOM_TOOL_INTERNAL',
])

const nullableString = {
  oneOf: [{ type: 'string' }, { type: 'null' }],
}

export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: '命令是否成功（exit 0 且无信号、未超时、未被取消）' },
    code: { type: 'string', description: '失败时的稳定错误码；成功时为空串' },
    message: { type: 'string', description: '失败时的一句话原因；成功时为空串' },
    hint: { type: 'string', description: '失败时的修复建议；没有则为空串' },
    exitCode: {
      oneOf: [{ type: 'integer' }, { type: 'null' }],
      description: '子进程退出码；未拿到时为 null',
    },
    signal: {
      ...nullableString,
      description: '导致终止的信号名；正常退出或自行取消时为 null',
    },
    timedOut: { type: 'boolean' },
    aborted: { type: 'boolean', description: '调用方或插件取消导致的中止' },
    durationMs: { type: 'number', description: '从 spawn 到真实退出的毫秒数' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    truncated: { type: 'boolean', description: '输出超过上限（v1 视为失败）' },
    argv: { type: 'array', items: { type: 'string' }, description: '实际 argv，逐元素' },
    cwd: { type: 'string' },
    autoEnvKeys: {
      type: 'array',
      items: { type: 'string' },
      description: '按解释器自动注入的编码环境变量名',
    },
    data: {
      ...nullableString,
      description: 'parse: json 时的紧凑 JSON 文本，否则为 null',
    },
  },
}

/**
 * Build a result object with every key present. Callers mutate the returned
 * object rather than spreading partial ones, which keeps the schema validator
 * from ever seeing a missing field.
 */
export function emptyResult() {
  return {
    ok: false,
    code: 'CUSTOM_TOOL_INTERNAL',
    message: '',
    hint: '',
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    durationMs: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    argv: [],
    cwd: '',
    autoEnvKeys: [],
    data: null,
  }
}

export function failure(code, message, extra = {}) {
  if (!ERROR_CODES.includes(code)) {
    throw new Error(`unknown custom-tool error code: ${code}`)
  }
  return { ...emptyResult(), ...extra, ok: false, code, message }
}

export function success(extra = {}) {
  return { ...emptyResult(), ...extra, ok: true, code: '', message: '' }
}
