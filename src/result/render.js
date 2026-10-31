/**
 * The single model-facing projection.
 *
 * Everything else about a run — exact argv, cwd, duration, exit code — stays in
 * the returned value, where the UI, the logs and `ToolErrorInfo.reason` can read
 * it. The model only gets what a human would paste into a terminal: the
 * program's own output, or a short, stable failure header plus the tail of
 * stderr.
 *
 * This is what keeps a custom tool from becoming a context hog: a 1 MB stdout is
 * already refused upstream by OUTPUT_LIMIT, and a successful run is never wrapped
 * in prose the model has to read past.
 */

const EMPTY_SUCCESS = '（命令成功，没有输出）'
const MODEL_TEXT_LIMIT = 12000

function clip(text, limit = MODEL_TEXT_LIMIT) {
  if (text.length <= limit) return text
  // Keep the tail: failures and program output are usually decided at the end.
  const head = text.slice(0, Math.floor(limit / 4))
  const tail = text.slice(text.length - Math.floor((limit * 3) / 4))
  return `${head}\n…（已截断 ${text.length - limit} 字符）…\n${tail}`
}

function tailLines(text, maxLines = 40) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length <= maxLines) return text
  return lines.slice(lines.length - maxLines).join('\n')
}

/**
 * @param {object} value a result from `./contract.js`
 * @param {{parse?: 'text'|'json'}} [options]
 * @returns {string}
 */
export function renderResult(value, options = {}) {
  const parse = options.parse ?? 'text'

  if (value.ok) {
    if (parse === 'json' && typeof value.data === 'string') {
      const parts = [clip(value.data)]
      if (value.stderr) parts.push(`[stderr]\n${clip(tailLines(value.stderr))}`)
      return parts.join('\n\n')
    }
    const parts = [value.stdout ? clip(value.stdout) : EMPTY_SUCCESS]
    if (value.stderr) parts.push(`[stderr]\n${clip(tailLines(value.stderr))}`)
    return parts.join('\n\n')
  }

  const parts = [`[${value.code}] ${value.message}`]

  const stderr = value.stderr ? tailLines(value.stderr).trimEnd() : ''
  if (stderr) parts.push(`[stderr]\n${clip(stderr)}`)

  const stdout = value.stdout ? tailLines(value.stdout).trimEnd() : ''
  if (stdout) parts.push(`[stdout]\n${clip(stdout)}`)

  if (value.hint) parts.push(`提示：${value.hint}`)

  return parts.join('\n\n')
}

/**
 * The user-facing detail attached to `ToolErrorInfo.reason`: model-invisible,
 * but preserved in durable projections. This is where argv/cwd/duration become
 * legitimate to show.
 */
export function describeForUser(value) {
  const lines = []
  lines.push(`code: ${value.code}`)
  if (value.message) lines.push(`message: ${value.message}`)
  if (value.hint) lines.push(`hint: ${value.hint}`)
  lines.push(`argv: ${JSON.stringify(value.argv)}`)
  lines.push(`cwd: ${value.cwd}`)
  lines.push(`exitCode: ${value.exitCode === null ? 'null' : value.exitCode}`)
  if (value.signal) lines.push(`signal: ${value.signal}`)
  lines.push(`durationMs: ${value.durationMs}`)
  return lines.join('\n')
}

export default renderResult
