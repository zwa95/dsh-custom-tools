/**
 * `custom_tools_propose` — the one admin surface the model is allowed to reach.
 *
 * The plugin's whole promise is that a model value can never become a program,
 * a command line, a working directory or an environment key. That promise would
 * be void the moment a model could register a tool by itself: it would declare
 * `bash -c <anything>` and then call what it just built.
 *
 * So this tool writes nothing at all — no configuration, no files. It validates
 * the definition and returns the one line that would install it:
 *
 *     /custom-tools add {"name":"…"}
 *
 * Running that line is the human gate, and it is the only gate. There is no
 * second copy of the definition to keep in sync (a draft directory, a diff
 * panel), and nothing half-applied to reason about: either the user pastes the
 * command and the profile changes, or nothing happened.
 *
 * An approval prompt on top of it would gate the same action twice — and on a
 * session whose approval policy is `never`, it was rejected before the human
 * ever saw a card. One gate, at the place that actually mutates configuration,
 * is both simpler and truthful.
 */
import { validateTool } from '../config/validate.js'

export const PROPOSE_TOOL_NAME = 'custom_tools_propose'

const MODE_LABEL = {
  executable: '可执行文件',
  script: '脚本',
  bash: 'bash',
  powershell: 'PowerShell',
}

/** Shorten one line so the summary stays readable. */
function clip(text, limit = 96) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/**
 * One sentence describing what the definition would actually run — the same
 * line the settings page shows, so a proposal and a hand-written tool read alike.
 */
export function describeTarget(spec) {
  const mode = MODE_LABEL[spec?.mode] ?? String(spec?.mode ?? '未知模式')
  let target
  if (spec?.mode === 'executable') {
    const fixed = Array.isArray(spec.args) ? spec.args.length : 0
    target = `${spec.executable ?? '?'}${fixed > 0 ? ` + ${fixed} 个固定参数` : ''}`
  } else if (spec?.mode === 'script') {
    target = `${spec.interpreter ?? '?'} ${spec.script ?? '?'}`
  } else {
    target = clip(spec?.command ?? '?', 72)
  }
  return `${spec?.name ?? '?'}（${mode}）：${clip(target)}`
}

/**
 * The `definition` argument, spelled out as a real schema.
 *
 * Being a schema rather than a JSON string is the point: the model sees the
 * field names, the enums and the nesting in the call signature instead of
 * having to guess the shape from one sentence of prose. `additionalProperties`
 * stays `true` at the top level so a stray key reaches `validateTool`, whose
 * message names the offending field and lists the valid ones — the host's own
 * "unexpected property" is shorter but says far less.
 */
const BINDING_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: '一个 argv / stdin 映射：literal、arg、flag 三选一，再按需加修饰。',
  properties: {
    literal: { type: 'string', description: '固定输出一个 argv 元素，不来自模型' },
    arg: { type: 'string', description: '从同名参数取值，输出一个 argv 元素' },
    flag: { type: 'string', description: '布尔参数名；值为 true 时输出 as' },
    as: {
      oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      description: 'flag 为 true 时输出的 argv 元素，可写一个或多个',
    },
    prefix: { type: 'string', description: '值前缀，和值同属一个 argv 元素，例如 --glob=' },
    suffix: { type: 'string', description: '值后缀，和值同属一个 argv 元素，例如 .json' },
    join: { type: 'string', description: '数组参数合并成一个元素时的分隔符；不写则用空格' },
    repeat: { type: 'boolean', description: '数组参数每个元素占一个 argv' },
    json: { type: 'boolean', description: '把参数序列化成紧凑 JSON 再输出' },
    stdin: { type: 'string', enum: ['raw', 'json'], description: '写入 stdin 而不是 argv' },
    omitIfEmpty: { type: 'boolean', description: '值为空字符串、空数组或 null 时整条不出现' },
    allowLeadingDash: { type: 'boolean', description: '允许值以 - 开头' },
    allowResponseFile: { type: 'boolean', description: '允许值以 @ 开头' },
  },
}

const DEFINITION_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: '一个工具定义。字段含义见 custom_tools_schema 的返回。',
  properties: {
    name: {
      type: 'string',
      required: true,
      description: '工具名，匹配 ^[a-z][a-z0-9_]{0,40}$，不能与已有工具或内建工具重名',
    },
    title: { type: 'string', description: '设置页显示名，不进入模型上下文' },
    description: {
      type: 'string',
      required: true,
      description: '模型看到的说明：做什么、什么时候用',
    },
    whenToUse: { type: 'string', description: '追加到 description 末尾的使用场景段落' },
    mode: {
      type: 'string',
      required: true,
      enum: ['executable', 'script', 'bash', 'powershell'],
      description: 'executable=直接跑程序；script=解释器跑脚本文件；bash/PowerShell=跑一段固定源码',
    },
    enabled: { type: 'boolean', description: '默认 true' },
    executable: {
      type: 'string',
      description: 'executable 模式必填：程序 PATH 名或绝对路径；bash/PowerShell 模式可选，用来自定 shell',
    },
    interpreter: { type: 'string', description: 'script 模式必填：解释器 PATH 名或绝对路径' },
    script: { type: 'string', description: 'script 模式必填：脚本文件绝对路径' },
    command: {
      type: 'string',
      description: 'bash / PowerShell 模式必填：固定源码。模型的值只能经 $@ / $args / stdin 进入，永远不拼进这段文本',
    },
    args: {
      type: 'array',
      items: BINDING_SCHEMA,
      description: '声明式 argv / stdin 映射，按顺序拼成命令行',
    },
    cwd: { type: 'string', description: '「.」表示会话工作目录；否则必须是绝对路径。模型不可改' },
    approval: {
      type: 'string',
      enum: ['inherit', 'always'],
      description: 'inherit=跟随会话；always=每次调用都要批准',
    },
    concurrency: {
      type: 'string',
      enum: ['exclusive', 'parallel'],
      description: 'exclusive=同一工具串行；parallel=允许重叠',
    },
    timeoutMs: { type: 'number', description: '1000..600000，默认 120000' },
    env: {
      type: 'object',
      additionalProperties: true,
      description: '附加给子进程的固定环境变量：{"NAME": "value"}',
    },
    encodingDefaults: {
      type: 'boolean',
      description: '为 python / java 注入 UTF-8 环境变量，默认 true',
    },
    credentials: {
      type: 'array',
      description: '凭据注入：[{"env":"GH_TOKEN","ref":"github_token"}]，值每次调用时解析',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          env: { type: 'string', required: true, description: '注入的环境变量名' },
          ref: { type: 'string', required: true, description: '凭据引用名' },
        },
      },
    },
    parameters: {
      type: 'object',
      additionalProperties: true,
      description:
        '参数名 → 规格的映射（不是 JSON Schema）。每项形如 { type: "string", required: true, default: "\\".\\"", description: "..." }，type 取 string/number/integer/boolean/array',
    },
    output: {
      type: 'object',
      additionalProperties: false,
      description: '输出处理方式',
      properties: {
        parse: { type: 'string', enum: ['text', 'json'], description: '默认 text' },
        schema: {
          type: 'string',
          description: 'parse=json 时用于校验的 JSON Schema 子集，以 JSON 文本给出',
        },
      },
    },
    examples: {
      type: 'array',
      description: '给模型参考的示例调用',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true, description: '示例名' },
          args: { type: 'string', required: true, description: '参数对象，以 JSON 文本给出' },
        },
      },
    },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: '定义是否通过校验' },
    message: {
      type: 'string',
      description: '给模型和用户看的结果：一行摘要 + 可直接执行 /custom-tools add 的整行命令',
    },
    command: {
      type: 'string',
      description: '生效用的那一行：/custom-tools add <完整 JSON>；未通过校验时为空串',
    },
    issues: {
      type: 'array',
      items: { type: 'string' },
      description: '校验问题，一行一条；没有为空数组',
    },
  },
}

/** Whether this name already exists, so the result can say "修改". */
function isReplacing(ctx, namespace, name) {
  try {
    const settings = ctx.get('settings')
    const descriptor = settings?.describe?.()?.find?.((row) => row.ns === namespace)
    const tools = descriptor?.value?.tools
    return Array.isArray(tools) && tools.some((tool) => tool?.name === name)
  } catch {
    return false
  }
}

/**
 * Register the tool on the host.
 * @param {object} ctx cordis plugin context
 * @param {object} options
 * @param {Function} options.defineTool host `defineTool`
 * @param {object} options.registry `{register}` seam
 * @param {string} options.namespace settings namespace, used for the "replaces" hint
 */
export function registerProposeTool(ctx, { defineTool, registry, namespace }) {
  const definition = defineTool({
    name: PROPOSE_TOOL_NAME,
    description: [
      '提议新增或修改一个自定义工具。',
      'definition 是完整的工具定义对象；不确定字段名或写法时，先调用 custom_tools_schema 取样例。',
      '调用只做校验，不写配置也不写文件；通过后返回一行 /custom-tools add <JSON>，',
      '由用户自己执行才会生效。把那一行原样交给用户，不要改写、不要自己执行。',
      '用户没有明确要求建工具时不要调用。',
    ].join(''),
    parameters: {
      intent: {
        type: 'string',
        required: true,
        description: '一句话说明为什么需要这个工具',
      },
      // `required` belongs at the property position in the author DSL, and it
      // has to be spelled out on this line: spreading the schema alone left
      // `definition` out of the compiled `required` list, so a model could call
      // the tool with no definition at all.
      definition: { ...DEFINITION_SCHEMA, required: true },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const intent = typeof args.intent === 'string' ? args.intent.trim() : ''
      if (intent === '') {
        return {
          ok: false,
          message: '没有写 intent。先用一句话说明为什么需要这个工具，再决定要不要建。',
          command: '',
          issues: [],
        }
      }

      const spec = args.definition
      const issues = validateTool(spec, 'definition')
      const errors = issues.filter((issue) => issue.severity === 'error')
      if (errors.length > 0) {
        return {
          ok: false,
          message: `定义没有通过校验，未写入任何内容（${errors.length} 处）：\n${errors
            .map((issue) => `- ${issue.code} ${issue.path}: ${issue.message}`)
            .join('\n')}`,
          command: '',
          issues: errors.map((issue) => `${issue.code} ${issue.path}: ${issue.message}`),
        }
      }

      // One line, and the whole definition inside it: `/custom-tools add` takes
      // the entire remainder of the input, so nothing needs quoting or escaping
      // and there is no file for the user to open first. What they paste is
      // exactly what was validated here.
      const command = `/custom-tools add ${JSON.stringify(spec)}`
      const replacing = isReplacing(ctx, namespace, spec.name)
      return {
        ok: true,
        message: [
          `校验通过${replacing ? '（会替换同名工具）' : ''}，没有写入任何东西。`,
          `内容：${describeTarget(spec)}`,
          '',
          '生效需要用户执行这一行：',
          command,
          '',
          '执行前请核对里面的 JSON：',
          JSON.stringify(spec, null, 2),
        ].join('\n'),
        command,
        issues: [],
      }
    },
  })

  return ctx.effect(() => registry.register(definition), 'custom-tools: propose')
}

export default registerProposeTool
