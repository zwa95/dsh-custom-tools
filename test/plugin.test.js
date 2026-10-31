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
register('./stubs/loader.mjs', import.meta.url)
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
    sandbox: {
      async confine(argv) { return { argv, enforcement: 'partial' } },
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
