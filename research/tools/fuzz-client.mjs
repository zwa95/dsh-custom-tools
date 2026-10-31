// Probe: do the page's pure helpers ever throw while a definition is mid-edit?
// A throw during render unmounts the React subtree, which would look to the
// user like "the page keeps reverting my edits".
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8')
const fakeReact = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useRef: () => ({ current: null }),
  useEffect: () => {},
}
let exportsObject
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (mod) => {
        exportsObject = mod.factory((name) => {
          if (name === 'react') return fakeReact
          throw new Error(`no require ${name}`)
        })
      },
    },
  },
  console,
}
vm.runInNewContext(source, sandbox)
const internal = exportsObject.__internal

const spec = {
  name: 'python_pretty_json',
  description: 'x',
  mode: 'script',
  interpreter: 'python',
  script: 'C:/x/y.py',
  args: [{ arg: 'path' }, { flag: 'sort_keys', as: '--sort' }],
  parameters: { path: { type: 'string', required: true }, sort_keys: { type: 'boolean' } },
}

const mutations = [
  { name: '' },
  { name: 'a' },
  { name: 'UPPER' },
  { interpreter: '' },
  { script: '' },
  { args: [] },
  { args: [{ arg: 'path' }] },
  { args: [{ literal: 'x' }] },
  { args: [{ flag: 'sort_keys', as: '' }] },
  { parameters: {} },
  { parameters: { path: { type: 'string' } } },
  { parameters: { path: { type: 'weird' } } },
  { parameters: { path: { type: 'string', default: '{bad' } } },
  { args: undefined },
  { parameters: undefined },
  { mode: 'bash' },
  { mode: 'powershell' },
  { timeoutMs: '60000' },
  { timeoutMs: 0 },
]

let threw = 0
for (const patch of mutations) {
  const candidate = { ...spec, ...patch }
  try {
    internal.collectIssues([candidate])
    internal.previewInvocation(candidate, { path: 'a', sort_keys: true })
  } catch (error) {
    threw += 1
    console.log('THREW for', JSON.stringify(patch), '->', error.message)
  }
}
console.log(threw === 0 ? 'no throw across every mid-edit shape' : `${threw} throwing shapes`)
