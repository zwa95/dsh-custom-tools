/**
 * `custom_tools_schema` — the read-only half of the admin surface.
 *
 * `custom_tools_propose` can only be used well by a model that already knows
 * the definition vocabulary. Nothing else in the conversation carries it: the
 * tool signature lists field names, but not the four modes' mutual exclusions,
 * not the "values never get interpolated into command text" rule, and not what
 * a correct file looks like end to end.
 *
 * Measured, not assumed: given only the propose tool's prose, a model with no
 * context produced a definition built around an invented `execution` block that
 * interpolated `{{pattern}}` straight into a shell command — the exact failure
 * this plugin exists to prevent. Hence this tool: one call returns the rules,
 * one ready-to-edit example per mode, and the user's own tools as references.
 */
import { validateTool } from '../config/validate.js'

export const SCHEMA_TOOL_NAME = 'custom_tools_schema'

/** Mode list shared by the tool parameter and the reference text. */
export const MODES = ['executable', 'script', 'bash', 'powershell']

/**
 * One complete, valid definition per mode.
 *
 * These are exported so the test suite can run every example through
 * `validateTool`: an example that does not validate is worse than no example.
 */
export const EXAMPLES = {
  executable: {
    name: 'rg_ts',
    description: '用 ripgrep 在目录里递归搜索，只匹配 *.ts 文件，输出 文件:行号:内容。',
    mode: 'executable',
    executable: 'rg',
    args: [
      { literal: '--line-number' },
      { literal: '--no-heading' },
      { literal: '--color=never' },
      { literal: '--glob=*.ts' },
      { arg: 'pattern' },
      { arg: 'path' },
    ],
    cwd: '.',
    parameters: {
      pattern: { type: 'string', required: true, description: '正则或字面量' },
      path: { type: 'string', default: '"."', description: '搜索起点，默认当前目录' },
    },
    output: { parse: 'text' },
  },
  script: {
    name: 'pretty_json',
    description: '用 Python 把一个 JSON 文件格式化成两空格缩进后打印。',
    mode: 'script',
    interpreter: 'python',
    script: 'C:\\tools\\pretty-json.py',
    args: [{ arg: 'path' }, { flag: 'sort_keys', as: '--sort' }],
    parameters: {
      path: { type: 'string', required: true, description: 'JSON 文件路径' },
      sort_keys: { type: 'boolean', default: 'false', description: '按键名排序' },
    },
    output: { parse: 'text' },
  },
  bash: {
    name: 'grep_repo',
    description: '在仓库里递归搜索字符串，输出 文件:行号:内容。',
    mode: 'bash',
    command: 'grep -rnI --color=never -- "$@"',
    args: [{ arg: 'pattern' }, { arg: 'path' }],
    cwd: '.',
    parameters: {
      pattern: { type: 'string', required: true, description: '要找的字符串或正则' },
      path: { type: 'string', default: '"."', description: '搜索起点，默认当前目录' },
    },
    output: { parse: 'text' },
  },
  powershell: {
    name: 'recent_files',
    description: '列出目录下最近修改的文件。',
    mode: 'powershell',
    command:
      '$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json; Get-ChildItem -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First $payload.limit | ForEach-Object { $_.FullName }',
    args: [{ stdin: 'json' }],
    cwd: '.',
    parameters: {
      limit: { type: 'integer', default: '20', description: '最多返回多少条' },
    },
    output: { parse: 'text' },
  },
}

const FIELDS = [
  ['name', '必填。^[a-z][a-z0-9_]{0,40}$，不能与已有工具或内建工具重名'],
  ['description', '必填。模型据此判断是否调用：写清做什么、什么时候用'],
  ['mode', '必填。executable / script / bash / powershell'],
  ['title / whenToUse', '可选。title 只在设置页显示；whenToUse 追加到 description 末尾'],
  ['executable', 'executable 模式必填：程序的 PATH 名或绝对路径'],
  ['interpreter / script', 'script 模式必填：解释器名、脚本绝对路径'],
  ['command', 'bash / PowerShell 模式必填：固定源码'],
  ['args', 'argv / stdin 映射数组，按顺序拼命令行'],
  ['parameters', '参数名 → 规格的映射（不是 JSON Schema）'],
  ['cwd', '「.」= 会话工作目录；否则必须是绝对路径'],
  ['approval / concurrency', 'inherit|always / exclusive|parallel'],
  ['timeoutMs', '1000..600000，默认 120000'],
  ['env / credentials', '固定环境变量 / 凭据注入 [{"env","ref"}]'],
  ['output', '{ "parse": "text"|"json", "schema": "JSON Schema 文本" }'],
  ['examples', '给模型参考的示例：[{ "name", "args": "JSON 文本" }]'],
]

const BINDINGS = [
  ['{ "literal": "--flag" }', '固定 argv 元素，不来自模型'],
  ['{ "arg": "name", "prefix": "--opt=" }', '从参数取值，前缀后缀与值同属一个 argv'],
  ['{ "arg": "list", "repeat": true }', '数组参数每项一个 argv；改用 "join": "," 则合并成一个'],
  ['{ "flag": "name", "as": "--flag" }', '布尔参数为 true 时输出 as'],
  ['{ "stdin": "json" }', '把参数打包成 JSON 写 stdin（PowerShell 必须这样传参）'],
]

/**
 * The per-parameter fields.
 *
 * `parameters` is a name → spec map, which means the spec keys are the second
 * thing a model has to guess — and the one it gets wrong. A blind trial wrote an
 * array parameter with no `items` and only learned it from the error. Spell the
 * keys out next to the top-level ones.
 */
const PARAMETER_FIELDS = [
  ['type', '必填。string / number / integer / boolean / array'],
  ['items', 'array 必填：元素类型，例如 "string"'],
  ['required', '可选，布尔。写了就要模型必须提供'],
  ['default', '可选。**JSON 文本**：字符串写成 "\\".\\""，数字写 20，布尔写 false'],
  ['description', '可选但强烈建议：模型读这一行知道该填什么'],
  ['min / max', '数字参数的取值范围'],
  ['minLength / maxLength', '字符串或数组的长度范围'],
]

/**
 * Build the reference text.
 * @param {object} options
 * @param {string} [options.mode] one of `MODES`, or `all`
 * @param {object[]} [options.existing] the user's current tools
 */
export function referenceText({ mode = 'all', existing = [] } = {}) {
  const parts = ['# 自定义工具定义速查', '', '## 四条硬规则', '']
  parts.push(
    '1. 模型给的值永远不拼进 command / executable / cwd / env 键名：只能经 args 里的 {arg} / {flag} 进 argv，或 {stdin} 进 stdin。',
    '2. parameters 是「参数名 → 规格」的映射，不是一份 JSON Schema。',
    '3. cwd 只能是 "." 或一个绝对路径。',
    '4. bash 用 "$@" 取位置参数（bash -c <source> <argv0> <args…>）；PowerShell 的参数必须走 { "stdin": "json" }。',
    '',
    '## 顶层字段',
    '',
  )
  for (const [field, note] of FIELDS) parts.push(`- ${field}：${note}`)
  parts.push('', '## parameters 里每个参数的字段', '')
  for (const [field, note] of PARAMETER_FIELDS) parts.push(`- ${field}：${note}`)
  parts.push('', '## args 条目', '')
  for (const [shape, note] of BINDINGS) parts.push(`- ${shape} —— ${note}`)

  const wanted = mode === 'all' ? MODES : [mode]
  parts.push('', '## 样例（可直接改写，字段都是真实字段）', '')
  for (const key of wanted) {
    if (!MODES.includes(key)) continue
    parts.push(`### ${key}`, '```json', JSON.stringify(EXAMPLES[key], null, 2), '```', '')
  }

  if (existing.length > 0) {
    parts.push('## 用户现有的工具（可参考或修改）', '')
    for (const tool of existing) {
      const toolName = tool?.name ?? '?'
      const toolMode = tool?.mode ?? 'executable'
      const line = String(tool?.description ?? '').replace(/\s+/gu, ' ').trim()
      parts.push(
        `- ${toolName}（${toolMode}）：${line.length > 80 ? `${line.slice(0, 79)}…` : line}`,
      )
    }
    parts.push('')
  }

  return parts.join('\n')
}

/** The user's tools, so the reference can point at real definitions. */
function existingTools(ctx, namespace) {
  try {
    const settings = ctx.get('settings')
    const descriptor = settings?.describe?.()?.find?.((row) => row.ns === namespace)
    const tools = descriptor?.value?.tools
    return Array.isArray(tools) ? tools : []
  } catch {
    return []
  }
}

/**
 * Register the read-only reference tool.
 * @param {object} ctx cordis plugin context
 * @param {object} options
 * @param {Function} options.defineTool host `defineTool`
 * @param {object} options.registry `{register}` seam
 * @param {string} options.namespace settings namespace
 */
export function registerSchemaTool(ctx, { defineTool, registry, namespace }) {
  const definition = defineTool({
    name: SCHEMA_TOOL_NAME,
    description: [
      '返回自定义工具定义的字段说明和每种模式的一份完整样例，',
      '以及用户当前已有的工具列表。',
      '准备调用 custom_tools_propose 之前先读它，照着样例改写即可。',
    ].join(''),
    parameters: {
      mode: {
        type: 'string',
        enum: ['all', ...MODES],
        description: '只看某一种模式的样例；默认 all',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reference: { type: 'string', description: '速查文本（Markdown）' },
        },
      },
      render: (args, value) => [{ type: 'text', text: value.reference }],
    },
    isConcurrencySafe: () => true,
    execute: async (args) => ({
      reference: referenceText({
        mode: typeof args.mode === 'string' && args.mode !== '' ? args.mode : 'all',
        existing: existingTools(ctx, namespace),
      }),
    }),
  })

  return ctx.effect(() => registry.register(definition), 'custom-tools: schema')
}

export default registerSchemaTool

/** Every example must survive validation; the test suite asserts this. */
export function exampleIssues() {
  return MODES.flatMap((mode) =>
    validateTool(EXAMPLES[mode], `examples.${mode}`).filter((issue) => issue.severity === 'error'),
  )
}
