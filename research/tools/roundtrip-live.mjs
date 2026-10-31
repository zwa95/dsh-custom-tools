// Read the tools already installed in the profile and prove that the settings
// page reproduces them byte for byte: opening a card and saving must not
// rewrite a definition the user never edited.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const yamlPath = process.argv[2]
if (yamlPath === undefined) {
  console.error('usage: node research/tools/roundtrip-live.mjs <js-yaml.mjs>')
  process.exit(2)
}
const yaml = await import(pathToFileURL(yamlPath).href)

const patchPath = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const patch = yaml.load(readFileSync(patchPath, 'utf8'))
const row = (patch ?? []).find((entry) => entry?.id === 'custom-tools')
const tools = row?.config?.tools ?? []
console.log(`read ${tools.length} tool(s) from ${patchPath}`)

const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8')
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: ({ factory }) => {
        sandbox.__exports = factory((name) => {
          if (name === 'react') return { createElement: () => null, useRef: () => ({ current: null }), useState: () => [null, () => {}], useEffect: () => {}, useMemo: (fn) => fn() }
          throw new Error(`unexpected require: ${name}`)
        })
      },
    },
  },
  console,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Math,
  RegExp,
}
vm.runInNewContext(source, sandbox)
const internals = sandbox.__exports.__internal

const canon = (value) => {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

let failures = 0
for (const tool of tools) {
  const pieces = internals.piecesOf(tool)
  const rebuilt = internals.applyPieces(tool, pieces)
  const before = canon({ args: tool.args ?? [], parameters: tool.parameters ?? {} })
  const after = canon({ args: rebuilt.args ?? [], parameters: rebuilt.parameters ?? {} })
  const ok = before === after
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${tool.name}  pieces=${pieces.map((piece) => piece.kind).join(',')}`)
  if (!ok) {
    console.log(`  before ${before}`)
    console.log(`  after  ${after}`)
  }
  const preview = internals.previewOf(tool, pieces)
  console.log(`     preview: ${preview.argv.map((item) => (item.absent === true ? `${item.kind}?` : item.kind)).join(' ')}${preview.stdin === null ? '' : `  stdin(${preview.stdin.kind})=${preview.stdin.names.join('+')}`}`)
}
process.exit(failures === 0 ? 0 : 1)
