/**
 * One pasted JSON document, three accepted shapes.
 *
 * A tool travels between people as JSON: out of `/custom-tools export`, out of
 * a chat message, out of a colleague's settings page. Every surface that reads
 * one has to agree on what a "tool document" is, or the export one surface
 * writes is the paste the next surface refuses. All three shapes are accepted
 * everywhere:
 *
 * 1. a single definition — what `show <name>` prints;
 * 2. an array of definitions — what `export` used to print;
 * 3. `{ tools: [...] }` — the settings document, so a whole config is pastable.
 *
 * The reader only decides *which* definitions the document holds. Shape and
 * field validation stays with `validateTool`, so one bad tool in a bundle is
 * still reported field by field.
 */

/** Keys that mark a plain object as a tool definition rather than a wrapper. */
const TOOL_HINTS = [
  'name', 'title', 'description', 'whenToUse', 'mode', 'enabled',
  'executable', 'interpreter', 'script', 'command', 'args', 'cwd',
  'approval', 'concurrency', 'timeoutMs', 'env', 'encodingDefaults',
  'credentials', 'parameters', 'output', 'examples',
]

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function looksLikeTool(value) {
  return isPlainObject(value) && TOOL_HINTS.some((key) => value[key] !== undefined)
}

/**
 * Read a parsed JSON value as a tool document.
 *
 * @param {unknown} value parsed JSON (already `JSON.parse`d)
 * @returns {{ok: true, tools: object[], ignoredKeys: string[]}
 *   | {ok: false, message: string}}
 *   `ignoredKeys` names top-level keys of a bundle that the import does not
 *   carry over (`deferLoading`), so the caller can say so instead of dropping
 *   them in silence.
 */
export function readToolDocument(value) {
  let tools
  let ignoredKeys = []
  if (Array.isArray(value)) {
    tools = value
  } else if (isPlainObject(value) && Array.isArray(value.tools)) {
    tools = value.tools
    ignoredKeys = Object.keys(value).filter((key) => key !== 'tools')
  } else if (looksLikeTool(value)) {
    tools = [value]
  } else {
    return {
      ok: false,
      message: '无法识别的文档形状。可接受：单个工具对象、工具对象数组，或 {"tools": [...]}。',
    }
  }

  if (tools.length === 0) {
    return { ok: false, message: '文档里没有任何工具定义。' }
  }
  const foreign = tools.findIndex((tool) => !isPlainObject(tool))
  if (foreign !== -1) {
    return { ok: false, message: `第 ${foreign + 1} 项不是对象，无法当作工具定义。` }
  }

  // A repeated name would make "import two tools" quietly mean "import one":
  // the second upsert replaces the first. Refuse instead of guessing.
  const seen = new Set()
  for (const tool of tools) {
    const name = typeof tool.name === 'string' ? tool.name : ''
    if (name === '') continue // `validateTool` reports the missing name itself
    if (seen.has(name)) {
      return { ok: false, message: `工具名 ${name} 在文档里出现了两次，请先合并成一份定义。` }
    }
    seen.add(name)
  }

  return { ok: true, tools, ignoredKeys }
}
