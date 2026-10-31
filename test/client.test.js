/**
 * The browser half cannot run here, but its *wiring* can: load the bundle the
 * way the harness ModuleLoader does, hand it a fake React and a fake slot
 * registry, and assert it registers one settings section with a component.
 *
 * That is exactly the part that fails silently in production — a wrong module
 * id means "loaded without registering <name>", a wrong inject name means the
 * page never mounts, and neither shows up as an error anywhere.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8')

/** Minimal React surface: enough for module load, not for rendering. */
function fakeReact() {
  const hook = () => undefined
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, hook],
    useEffect: hook,
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    Fragment: Symbol('Fragment'),
  }
}

function loadBundle() {
  let captured
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { captured = spec } } },
    console,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(captured, 'the bundle registers itself with the ModuleLoader')
  return captured
}

test('the client registers under the package name', () => {
  const spec = loadBundle()
  // The loader rejects a bundle whose id does not match the package it came
  // from ("loaded without registering <name>"), so this is load-bearing.
  assert.equal(spec.id, 'dsh-custom-tools')
  assert.equal(typeof spec.factory, 'function')
})

test('the client declares the remote settings service it reads', () => {
  const exportsObject = loadBundle().factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require: ${name}`)
  })
  // Arrays built inside the VM carry that realm's prototype, so compare values.
  assert.deepEqual(Array.from(exportsObject.inject), ['slots', 'remote', 'remote.settings'])
  assert.equal(typeof exportsObject.apply, 'function')
})

test('mounting registers exactly one settings section with a component', () => {
  const exportsObject = loadBundle().factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require: ${name}`)
  })

  const registered = []
  const slots = {
    inject(name, generator) {
      assert.equal(name, 'settings.section')
      const iterator = generator()
      for (let step = iterator.next(); !step.done; step = iterator.next()) {
        registered.push(step.value)
      }
    },
    register(definition, component) {
      return { definition, component }
    },
  }

  const ctx = {
    slots,
    remote: { settings: { describe: async () => ({ ok: true, value: [] }), mutate: async () => ({ ok: true }) } },
    get(service) {
      return service === 'slots' ? slots : service === 'remote' ? ctx.remote : undefined
    },
  }

  exportsObject.apply(ctx)

  assert.equal(registered.length, 1, 'one section, not zero and not two')
  const [{ definition, component }] = registered
  assert.equal(definition.name, 'settings.section')
  assert.equal(definition.id, 'custom-tools')
  assert.equal(typeof definition.label, 'string')
  assert.equal(typeof component, 'function', 'the section renders a component')
})

test('an absent remote settings namespace does not stop the section mounting', () => {
  const exportsObject = loadBundle().factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require: ${name}`)
  })

  let registered = 0
  const slots = {
    inject(_name, generator) {
      const iterator = generator()
      for (let step = iterator.next(); !step.done; step = iterator.next()) registered += 1
    },
    register() {
      return {}
    },
  }
  const ctx = { slots, get: (service) => (service === 'slots' ? slots : undefined) }

  assert.doesNotThrow(() => exportsObject.apply(ctx))
  assert.equal(registered, 1)
})

test('the section reads remote settings through the soft get path', () => {
  // Regression: `ctx.remote.settings` throws "cannot get property
  // \"remote.settings\" without inject" on the client, because the client
  // context guards service properties exactly like the host does. `ctx.get()`
  // is the documented soft path and degrades to an inline explanation.
  assert.match(source, /ctx\.get\('remote\.settings'\)/u)
  assert.match(source, /'slots', 'remote', 'remote\.settings'/u)
})

test('a card key never embeds the tool name, so typing cannot remount the field', () => {
  // Regression: keying ToolCard by `${index}:${tool.name}` remounted the whole
  // card on every keystroke, so the name input lost focus after one character.
  assert.match(source, /key: rowIds\.current\[index\]/u)
  assert.doesNotMatch(source, /key: `\$\{index\}:\$\{asString\(tool\.name\)\}`/u)
})

test('the JSON textareas survive parent re-renders', () => {
  // Regression: JsonField compared `value` by identity, and the page rebuilds
  // `advanced` on every render, so each keystroke reset the textarea content.
  assert.match(source, /const serialized = \(input\) => JSON\.stringify\(input \?\? null\)/u)
  assert.match(source, /if \(incoming !== adopted\.current\)/u)
})
