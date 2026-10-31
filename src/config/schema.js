/**
 * The single Schemastery adapter for this plugin.
 *
 * Nothing outside this file should know how a `ToolSpec` is persisted. The
 * schema only enforces *shape* (types, enums, numeric bounds). Every semantic
 * rule — "exactly one source per arg binding", "flag parameters must be
 * boolean", "a `stdin` mapping may appear at most once" — lives in
 * `./validate.js`, so that the same rules can run in unit tests without a
 * Cordis runtime.
 *
 * Two fields are persisted as JSON *text* on purpose:
 *
 *   - `parameters.*.default` and `examples[].args` hold arbitrary JSON, which
 *     Schemastery cannot round-trip through the settings document safely;
 *   - `output.schema` is a JSON Schema fragment, i.e. user-authored JSON.
 *
 * They are parsed and re-validated at compile time, so a bad JSON string is a
 * compile diagnostic instead of a corrupted in-memory value.
 */
import Schema from '@deepseek-ai/schemastery'

const ArgBinding = Schema.object({
  literal: Schema.string().description('固定输出一个 argv 元素'),
  arg: Schema.string().description('从同名参数取值'),
  flag: Schema.string().description('布尔参数名；为 true 时输出 as'),
  as: Schema.union([Schema.string(), Schema.array(Schema.string())])
    .description('flag 输出，可为一个或多个 argv 元素'),
  prefix: Schema.string().description('值前缀，与值同属一个 argv 元素'),
  suffix: Schema.string().description('值后缀，与值同属一个 argv 元素'),
  join: Schema.string().description('数组参数的连接分隔符，产出单个元素'),
  repeat: Schema.boolean().default(false)
    .description('数组参数逐项输出为多个元素'),
  json: Schema.boolean().default(false)
    .description('把参数序列化为紧凑 JSON 后输出'),
  stdin: Schema.union(['raw', 'json'])
    .description('写入 stdin 而不是 argv'),
  omitIfEmpty: Schema.boolean().default(false)
    .description('值为空字符串、空数组或 null 时跳过'),
  allowLeadingDash: Schema.boolean().default(false)
    .description('允许值以 - 开头（默认拒绝，防 option injection）'),
  allowResponseFile: Schema.boolean().default(false)
    .description('允许值以 @ 开头（默认拒绝，防 response file 注入）'),
})

const ParameterSpec = Schema.object({
  type: Schema.union(['string', 'number', 'integer', 'boolean', 'array'])
    .required()
    .description('参数类型；v1 不支持 object / 嵌套 json'),
  items: Schema.union(['string', 'number', 'integer', 'boolean'])
    .description('array 参数的元素类型'),
  required: Schema.boolean().default(false),
  default: Schema.string()
    .description('任意 JSON 默认值，以 JSON 文本保存'),
  description: Schema.string(),
  enum: Schema.array(Schema.string())
    .description('固定选项；v1 仅允许 string 参数'),
  min: Schema.number(),
  max: Schema.number(),
  minLength: Schema.number().step(1).min(0),
  maxLength: Schema.number().step(1).min(0),
})

const CredentialBinding = Schema.object({
  env: Schema.string().required()
    .description('注入子进程的环境变量名'),
  ref: Schema.string().required()
    .description('凭据引用名；每次执行时解析，从不落盘明文'),
})

const ToolExample = Schema.object({
  name: Schema.string().required(),
  args: Schema.string()
    .description('示例参数对象，以 JSON 文本保存'),
})

const ToolSpec = Schema.object({
  name: Schema.string().required()
    .description('工具名：^[a-z][a-z0-9_]{0,40}$，全局唯一，不可占用保留名'),
  title: Schema.string()
    .description('设置页显示名，不影响模型'),
  description: Schema.string().required()
    .description('模型看到的说明：做什么、什么时候用'),
  whenToUse: Schema.string()
    .description('额外使用场景，追加到 description'),
  mode: Schema.union(['executable', 'script', 'bash', 'powershell'])
    .default('executable'),
  enabled: Schema.boolean().default(true),

  executable: Schema.string()
    .description('executable 模式：PATH 名或绝对路径'),
  interpreter: Schema.string()
    .description('script 模式：解释器 PATH 名或绝对路径'),
  script: Schema.string()
    .description('script 模式：脚本绝对路径'),
  scriptTrust: Schema.union(['trusted-path', 'user-managed'])
    .default('trusted-path'),
  scriptSha256: Schema.string()
    .description('可选的小写 64 位 SHA-256，用于固定脚本内容'),
  command: Schema.string()
    .description('bash / powershell 模式：固定源码；模型值只能经 argv / env / stdin 进入'),

  args: Schema.array(ArgBinding)
    .default([])
    .description('声明式 argv / stdin 映射'),
  cwd: Schema.string().default('.')
    .description('相对会话工作目录；模型不可改'),
  approval: Schema.union(['inherit', 'always'])
    .default('inherit'),
  concurrency: Schema.union(['exclusive', 'parallel'])
    .default('exclusive'),
  timeoutMs: Schema.number().step(1000).min(1000).max(600000)
    .default(120000),
  env: Schema.dict(Schema.string())
    .description('附加环境变量；同名值覆盖宿主提供的值'),
  encodingDefaults: Schema.boolean().default(true)
    .description('按解释器自动注入可关闭的 UTF-8 默认设置'),
  credentials: Schema.array(CredentialBinding).default([]),
  parameters: Schema.dict(ParameterSpec).default({}),
  output: Schema.object({
    parse: Schema.union(['text', 'json']).default('text'),
    schema: Schema.string()
      .description('可选 JSON Schema 子集，以 JSON 文本保存'),
  }).default({ parse: 'text' }),
  examples: Schema.array(ToolExample).default([]),
})

export const Config = Schema.object({
  tools: Schema.array(ToolSpec)
    .default([])
    .volatile()
    .description('全部自定义工具；空数组表示尚未配置'),
  deferLoading: Schema.boolean()
    .default(false)
    .volatile()
    .description('为 true 时工具 schema 在首次使用前不进入模型上下文'),
})

export default Config
