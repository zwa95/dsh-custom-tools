import assert from 'node:assert/strict'
import test from 'node:test'

import { Manager } from '../src/runtime/manager.js'

function fakeDefineTool(options) {
  return { ...options }
}

function registry() {
  const registered = new Map()
  const log = []
  return {
    registered,
    log,
    register(definition) {
      registered.set(definition.name, definition)
      log.push(`register:${definition.name}`)
      return () => {
        if (registered.get(definition.name) === definition) registered.delete(definition.name)
        log.push(`dispose:${definition.name}`)
      }
    },
    get(name) {
      return registered.get(name)
    },
  }
}

function services({ delay = 0 } = {}) {
  let concurrent = 0
  let peak = 0
  return {
    get peak() { return peak },
    subprocess: {
      async resolveExecutable(name) { return `/usr/bin/${name}` },
      spawn(spec) {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        let release
        const gate = new Promise((resolve) => { release = resolve })
        const done = delay === 0
          ? Promise.resolve({ exitCode: 0, signal: null })
          : gate.then(() => ({ exitCode: 0, signal: null }))
        if (delay > 0) setTimeout(() => {
          concurrent -= 1
          release()
        }, delay)
        else concurrent -= 1
        return {
          collected: {
            stdout: { readFrom: () => ({ text: `${spec.argv.slice(1).join(' ')}\n`, nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
          done,
          terminate() {},
          async waitForExit() { return true },
        }
      },
    },
    shellEnv: { collect: () => ({}) },
    workingDirectory: { defaultDirectory: process.cwd(), async ensure() { return process.cwd() } },
    credentials: { async resolve() { return { value: 'v' } } },
  }
}

function tool(overrides = {}) {
  return {
    name: 'demo',
    description: '演示工具',
    mode: 'executable',
    executable: 'demo',
    parameters: {},
    args: [{ literal: 'one' }],
    ...overrides,
  }
}

function makeManager(svc = services()) {
  const reg = registry()
  const manager = new Manager({
    registry: reg,
    services: svc,
    defineTool: fakeDefineTool,
  })
  return { manager, reg, svc }
}

test('initial snapshot registers only enabled tools', async () => {
  const { manager, reg } = makeManager()
  await manager.apply({ tools: [tool(), tool({ name: 'off', enabled: false })] })

  assert.deepEqual([...reg.registered.keys()], ['demo'])
  assert.equal(manager.list().length, 2)
  assert.equal(manager.get('off').plan.enabled, false)
})

test('compatible edit swaps the pointer without touching the registration', async () => {
  const { manager, reg } = makeManager()
  await manager.apply({ tools: [tool()] })
  const first = reg.get('demo')

  const result = await manager.apply({ tools: [tool({ args: [{ literal: 'two' }] })] })
  assert.equal(result.changed, true)

  assert.equal(reg.get('demo'), first, 'same definition object must survive')
  assert.deepEqual(reg.log, ['register:demo'])

  const value = await first.execute({}, {})
  assert.equal(value.stdout, 'two\n')
})

test('breaking edit re-registers and the old definition is disposed', async () => {
  const { manager, reg } = makeManager()
  await manager.apply({ tools: [tool()] })
  const first = reg.get('demo')

  await manager.apply({ tools: [tool({ description: '新的说明' })] })
  const second = reg.get('demo')

  assert.notEqual(second, first)
  assert.deepEqual(reg.log, ['register:demo', 'dispose:demo', 'register:demo'])
  assert.equal(second.description, '新的说明')
})

test('disabling unregisters but keeps the tool inspectable and testable', async () => {
  const { manager, reg } = makeManager()
  await manager.apply({ tools: [tool()] })
  await manager.apply({ tools: [tool({ enabled: false })] })

  assert.equal(reg.get('demo'), undefined)
  assert.equal(manager.list()[0].enabled, false)

  const value = await manager.test('demo', {})
  assert.equal(value.ok, true)
  assert.equal(value.stdout, 'one\n')

  await manager.apply({ tools: [tool()] })
  assert.ok(reg.get('demo'))
})

test('removing a tool unregisters it', async () => {
  const { manager, reg } = makeManager()
  await manager.apply({ tools: [tool(), tool({ name: 'other' })] })
  await manager.apply({ tools: [tool()] })

  assert.deepEqual([...reg.registered.keys()], ['demo'])
})

test('a wholly invalid document keeps the previous generation', async () => {
  const { manager } = makeManager()
  await manager.apply({ tools: [tool()] })
  const before = manager.get('demo')

  const result = await manager.apply({ tools: 'not-an-array' })
  assert.equal(result.changed, false)
  assert.equal(manager.get('demo'), before)
  assert.ok(result.issues.some((issue) => issue.code === 'TOOLS_NOT_ARRAY'))
})

test('exclusive tools serialise their calls', async () => {
  const svc = services({ delay: 20 })
  const { manager, reg } = makeManager(svc)
  await manager.apply({ tools: [tool()] })
  const definition = reg.get('demo')

  await Promise.all([
    definition.execute({}, {}),
    definition.execute({}, {}),
    definition.execute({}, {}),
  ])
  assert.equal(svc.peak, 1)
})

test('parallel tools overlap', async () => {
  const svc = services({ delay: 20 })
  const { manager, reg } = makeManager(svc)
  await manager.apply({ tools: [tool({ concurrency: 'parallel' })] })
  const definition = reg.get('demo')

  await Promise.all([definition.execute({}, {}), definition.execute({}, {})])
  assert.equal(svc.peak, 2)
})

test('dispose unregisters everything', async () => {
  const { manager, reg } = makeManager()
  await manager.apply({ tools: [tool(), tool({ name: 'other' })] })
  await manager.dispose()
  assert.equal(reg.registered.size, 0)
})

test('preview and status expose the current state', async () => {
  const { manager } = makeManager()
  await manager.apply({ tools: [tool({ parameters: { a: { type: 'string', required: true } }, args: [{ arg: 'a' }] })] })

  const preview = await manager.preview('demo', { a: 'x' })
  assert.deepEqual(preview.argv, ['/usr/bin/demo', 'x'])

  const status = manager.status()
  assert.equal(status.ok, true)
  assert.equal(status.toolCount, 1)
  assert.equal(status.generationId, 1)
})

test('a call stays pinned to the generation it started on', async () => {
  const svc = services({ delay: 30 })
  const { manager, reg } = makeManager(svc)
  await manager.apply({ tools: [tool()] })
  const definition = reg.get('demo')

  const running = definition.execute({}, {})
  await manager.apply({ tools: [tool({ args: [{ literal: 'two' }] })] })
  const value = await running
  assert.equal(value.stdout, 'one\n', 'in-flight call must not observe the new argv')
})
