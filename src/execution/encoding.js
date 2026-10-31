/**
 * UTF-8 defaults for interpreters that are not UTF-8 by default.
 *
 * The plugin decodes all child output as UTF-8 and does no code-page sniffing,
 * so an interpreter that writes GBK produces replacement characters before the
 * plugin ever sees the bytes. Rather than ship an `outputEncoding` field (which
 * would mean giving up the bounded collect buffer), the plugin sets the
 * interpreter's own switch — the same thing the user would have to type.
 *
 * Everything injected here is visible in `preview`/`test` with an `[auto]`
 * marker, and `encodingDefaults: false` or an explicit empty value turns it off.
 */

const PYTHON = new Set(['python', 'python3', 'pythonw', 'py', 'uv', 'uvx'])
const JAVA = new Set(['java', 'javaw'])

/** Basename without extension, lowercased: `C:\Python312\python.exe` → `python`. */
export function interpreterKey(path) {
  if (typeof path !== 'string' || path === '') return ''
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  return base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
}

/**
 * @param {string} key result of `interpreterKey`
 * @returns {{env: Record<string, string>, argvPrefix: string[]}}
 */
export function encodingDefaultsFor(key) {
  if (PYTHON.has(key)) return { env: { PYTHONIOENCODING: 'utf-8' }, argvPrefix: [] }
  if (JAVA.has(key)) return { env: {}, argvPrefix: ['-Dfile.encoding=UTF-8'] }
  return { env: {}, argvPrefix: [] }
}

/**
 * Merge encoding defaults into the env overlay, recording which keys were
 * injected so preview can mark them `[auto]`.
 *
 * @param {{env: Record<string, string>, argvPrefix: string[]}} defaults
 * @param {Record<string, string>} userEnv
 * @returns {{env: Record<string, string>, autoKeys: string[]}}
 */
export function mergeEncodingEnv(defaults, userEnv) {
  const env = {}
  const autoKeys = []
  for (const [key, value] of Object.entries(defaults.env)) {
    if (Object.prototype.hasOwnProperty.call(userEnv, key)) continue
    env[key] = value
    autoKeys.push(key)
  }
  return { env, autoKeys }
}

/**
 * Insert the argv prefix where the interpreter expects it: for the JVM that is
 * before `-jar`, i.e. immediately after argv[0].
 */
export function withArgvPrefix(argv, prefix) {
  if (prefix.length === 0) return argv
  const [head, ...rest] = argv
  const already = rest.some((element) => prefix.includes(element))
  if (already) return argv
  return [head, ...prefix, ...rest]
}
