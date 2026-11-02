/**
 * Composition smoke test: the real `apply()` against a fake host.
 *
 * This is the only test that exercises the wiring — registry seam, volatile
 * re-apply, command registration, teardown — without a Cordis runtime. It is
 * deliberately small: everything it asserts is something that would otherwise
 * only fail after the plugin is installed into a live profile.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// Peer dependencies only exist inside an installed profile; redirect them to
// the faithful doubles before the composition root is loaded.
register('../test-support/loader.mjs', import.meta.url)
const { apply, name, inject } = await import('../index.js')

/** A fake context exposing only what `apply()` actually touches. */
function fakeContext() {
  const tools = new Map()
  const commands = new Map()
  const listeners = new Map()
  const effects = []
  const logs = []

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        logs.push(`register:${definition.name}`)
        return () => {
          tools.delete(definition.name)
          logs.push(`dispose:${definition.name}`)
        }
      },
      get(toolName) {
        return tools.get(toolName)
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect(factory) {
      const dispose = factory()
      effects.push(dispose)
      return dispose
    },
    get(serviceName) {
      return ctx[serviceName]
    },
    logger: {
      warn(message) { logs.push(`warn:${message}`) },
      info(message) { logs.push(`info:${message}`) },
    },
    // Just enough of the runtime to let preflight reach the argv stage without
    // spawning anything: preview only needs resolutions to succeed.
    subprocess: {
      async resolveExecutable(command) { return `/fake/bin/${command}` },
    },
    workingDirectory: {
      defaultDirectory: process.cwd(),
      async ensure() { return process.cwd() },
    },
    sandboxPolicy: {
      resolve() { return { mode: 'workspace-write' } },
    },
    shellEnv: {
      collect() { return {} },
    },
  }

  return { ctx, tools, commands, listeners, effects, logs }
}

/** A volatile-style holder. */
function ref(value) {
  let current = value
  return {
    get: () => current,
    set(next) { current = next },
  }
}

const TOOL = {
  name: 'demo_tool',
  description: 'A demo tool.',
  mode: 'executable',
  executable: 'node',
  args: [{ arg: 'value' }],
  parameters: { value: { type: 'string', required: true } },
}

test('the plugin declares its identity and its one hard dependency', () => {
  assert.equal(name, 'custom-tools')
  assert.deepEqual(inject, ['tools'])
})

// Cordis validates whatever `apply()` returns as an effect. Returning a plain
// object makes the fiber fail with "Invalid effect", and the rollback disposes
// every tool the plugin just registered — the tools silently vanish.
test('apply returns nothing so Cordis does not treat it as an effect', async () => {
  const fake = fakeContext()
  const config = { tools: ref([TOOL]), deferLoading: ref(false) }

  const returned = apply(fake.ctx, config)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(returned, undefined)
  assert.ok(fake.tools.has('demo_tool'))
})

test('mounting registers the declared tools and the slash command', async () => {
  const fake = fakeContext()
  const config = { tools: ref([TOOL]), deferLoading: ref(false) }

  apply(fake.ctx, config)
  await new Promise((resolve) => setImmediate(resolve))

  assert.ok(fake.tools.has('demo_tool'), 'the tool is registered')
  assert.ok(fake.commands.has('custom-tools'), 'the command is registered')

  const definition = fake.tools.get('demo_tool')
  assert.equal(definition.description, 'A demo tool.')
  // `defineTool` receives the property map and hands back the compiled object
  // schema; `value` is its only property and it is required.
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(Object.keys(definition.parameters.properties), ['value'])
  assert.deepEqual(definition.parameters.required, ['value'])
})

test('a volatile update re-applies without re-registering a compatible edit', async () => {
  const fake = fakeContext()
  const config = { tools: ref([TOOL]), deferLoading: ref(false) }

  apply(fake.ctx, config)
  await new Promise((resolve) => setImmediate(resolve))
  const first = fake.tools.get('demo_tool')

  // Body-only change: same contract, new argv.
  config.tools.set([{ ...TOOL, args: [{ literal: '--flag' }] }])
  fake.listeners.get('loader/volatile-update')()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(fake.tools.get('demo_tool'), first, 'the definition object is untouched')
  const preview = await fake.commands.get('custom-tools').handler({
    rawInput: 'preview demo_tool {"value":"x"}',
    agent: undefined,
    signal: new AbortController().signal,
  })
  assert.equal(preview.kind, 'success')
  assert.match(preview.text, /--flag/)
})

test('a breaking edit re-registers and a disabled tool is unregistered', async () => {
  const fake = fakeContext()
  const config = { tools: ref([TOOL]), deferLoading: ref(false) }

  apply(fake.ctx, config)
  await new Promise((resolve) => setImmediate(resolve))

  config.tools.set([{ ...TOOL, description: 'Changed description.' }])
  fake.listeners.get('loader/volatile-update')()
  await new Promise((resolve) => setImmediate(resolve))

  assert.ok(fake.logs.includes('dispose:demo_tool'), 'the old registration was disposed')
  assert.equal(fake.tools.get('demo_tool').description, 'Changed description.')

  config.tools.set([{ ...TOOL, enabled: false }])
  fake.listeners.get('loader/volatile-update')()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(fake.tools.has('demo_tool'), false, 'a disabled tool is not registered')
})

test('the command surface answers list, status and unknown verbs', async () => {
  const fake = fakeContext()
  apply(fake.ctx, { tools: ref([TOOL]), deferLoading: ref(false) })
  await new Promise((resolve) => setImmediate(resolve))

  const handler = fake.commands.get('custom-tools').handler
  const run = (rawInput) => handler({ rawInput, agent: undefined, signal: new AbortController().signal })

  const list = await run('list')
  assert.equal(list.kind, 'success')
  assert.match(list.text, /demo_tool/)

  const status = await run('status')
  assert.equal(status.kind, 'success')
  assert.match(status.text, /代际/)

  const unknown = await run('nope')
  assert.equal(unknown.kind, 'error')

  // A malformed argument payload is reported before anything spawns.
  const bad = await run('preview demo_tool {oops}')
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /JSON/)
})

test('teardown unregisters every tool it registered', async () => {
  const fake = fakeContext()
  apply(fake.ctx, { tools: ref([TOOL]), deferLoading: ref(false) })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(fake.tools.has('demo_tool'))

  for (const dispose of fake.effects.reverse()) {
    if (typeof dispose === 'function') await dispose()
  }
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(fake.tools.has('demo_tool'), false)
})

test('a deployment without the commands service still mounts the tools', async () => {
  const fake = fakeContext()
  // Cordis resolves `ctx.commands` through a proxy that throws for any service
  // not declared in `inject`; the plugin must read it through `ctx.get()` so an
  // absent slash-command service degrades instead of failing the whole row.
  delete fake.ctx.commands
  const config = { tools: ref([TOOL]), deferLoading: ref(false) }

  apply(fake.ctx, config)
  await new Promise((resolve) => setImmediate(resolve))

  assert.ok(fake.tools.has('demo_tool'), 'tools are independent of the command service')
  assert.equal(fake.commands.size, 0, 'no command is registered')
})

test('add validates the whole definition before writing it', async () => {
  const fake = fakeContext()
  const writes = []
  fake.ctx.settings = {
    describe: () => [{ ns: 'custom-tools', revision: 7, value: { tools: [], deferLoading: false } }],
    async mutate(ns, ops, revision) {
      writes.push({ ns, ops, revision })
    },
  }
  apply(fake.ctx, { tools: ref([]), deferLoading: ref(false) })
  await new Promise((resolve) => setImmediate(resolve))

  const handler = fake.commands.get('custom-tools').handler

  const rejected = await handler({ rawInput: 'add {"name":"Bad Name","description":"x","executable":"node"}', signal: undefined })
  assert.equal(rejected.kind, 'error')
  assert.match(rejected.text, /TOOL_NAME_FORMAT/)
  assert.equal(writes.length, 0, 'nothing is written when validation fails')

  const accepted = await handler({
    rawInput: `add ${JSON.stringify(TOOL)}`,
    signal: undefined,
  })
  assert.equal(accepted.kind, 'success')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].revision, 7)
  assert.deepEqual(writes[0].ops, [{ op: 'set', path: ['tools'], value: [TOOL] }])

  const exported = await handler({ rawInput: 'export', signal: undefined })
  assert.equal(exported.kind, 'success')
  // `export` writes the same bundle `add` and the settings page accept, so a
  // pasted export is directly importable.
  assert.deepEqual(JSON.parse(exported.text), { tools: [] })
})

test('a pasted export goes back in: same name replaces, new name appends', async () => {
  const fake = fakeContext()
  const writes = []
  fake.ctx.settings = {
    describe: () => [{ ns: 'custom-tools', revision: 3, value: { tools: [TOOL], deferLoading: false } }],
    async mutate(ns, ops, revision) { writes.push({ ns, ops, revision }) },
  }
  apply(fake.ctx, { tools: ref([TOOL]), deferLoading: ref(false) })
  await new Promise((resolve) => setImmediate(resolve))
  const handler = fake.commands.get('custom-tools').handler

  const exported = await handler({ rawInput: 'export', signal: undefined })
  assert.equal(exported.kind, 'success')
  assert.deepEqual(Object.keys(JSON.parse(exported.text)), ['tools'], 'a bundle, not a bare array')

  const extra = { ...TOOL, name: 'demo_tool_2' }
  const pasted = JSON.stringify({ tools: [TOOL, extra] })
  const imported = await handler({ rawInput: `add ${pasted}`, signal: undefined })
  assert.equal(imported.kind, 'success')
  assert.match(imported.text, /已导入 2 个工具/u)
  assert.match(imported.text, /新增 demo_tool_2/u)
  assert.match(imported.text, /替换 demo_tool/u)
  assert.equal(writes.length, 1, 'one mutate for the whole document')
  assert.deepEqual(
    writes[0].ops[0].value.map((entry) => entry.name),
    ['demo_tool', 'demo_tool_2'],
  )

  const single = await handler({ rawInput: 'export demo_tool', signal: undefined })
  assert.equal(single.kind, 'success')
  assert.equal(JSON.parse(single.text).name, 'demo_tool', 'a named export is one definition')
})
