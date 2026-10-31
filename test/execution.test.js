import assert from 'node:assert/strict'
import test from 'node:test'

import { compile } from '../src/compiler/compile.js'
import { runCustomTool } from '../src/execution/run.js'
import { renderResult } from '../src/result/render.js'

function tool(overrides = {}) {
  return {
    name: 'demo',
    description: '演示',
    mode: 'executable',
    executable: 'demo',
    parameters: { target: { type: 'string', required: true } },
    args: [{ literal: 'run' }, { arg: 'target' }],
    ...overrides,
  }
}

function entryOf(spec) {
  const result = compile({ tools: [spec] })
  return result.tools.get(spec.name)
}

function services(overrides = {}) {
  const spawned = []
  const base = {
    spawned,
    mode: 'workspace-write',
    exitCode: 0,
    signal: null,
    stdout: 'hello\n',
    stderr: '',
    confineFails: false,
    spawnFails: false,
    services: {
      subprocess: {
        async resolveExecutable(name) {
          if (name === 'missing') {
            const error = new Error('not found')
            error.name = 'SubprocessExecutableNotFoundError'
            throw error
          }
          return `/usr/bin/${name}`
        },
        spawn(spec) {
          spawned.push(spec)
          if (base.spawnFails) throw new Error('boom')
          return {
            collected: {
              stdout: { readFrom: () => ({ text: base.stdout, nextOffset: 0, lossy: false }) },
              stderr: { readFrom: () => ({ text: base.stderr, nextOffset: 0, lossy: false }) },
            },
            done: Promise.resolve({ exitCode: base.exitCode, signal: base.signal }),
            terminate() {},
            async waitForExit() { return true },
          }
        },
      },
      sandbox: {
        async confine(argv) {
          if (base.confineFails) throw new Error('no runner')
          return {
            argv: ['/usr/bin/sandbox-runner', ...argv],
            enforcement: 'partial',
            denialSignatures: ['permission denied'],
            runnerFailureRules: ['runner failed to start'],
          }
        },
      },
      sandboxPolicy: { resolve: () => ({ mode: base.mode }) },
      shellEnv: { collect: () => ({ DSH_SESSION_ID: 's1' }) },
      workingDirectory: {
        defaultDirectory: process.cwd(),
        async ensure() { return process.cwd() },
      },
      credentials: { async resolve() { return { value: 'secret-value' } } },
    },
  }
  Object.assign(base, overrides)
  return base
}

test('success returns stdout verbatim and passes exact argv through the sandbox', async () => {
  const fake = services()
  const value = await runCustomTool(fake.services, entryOf(tool()), { target: 'a b' }, {})

  assert.equal(value.ok, true)
  assert.equal(value.stdout, 'hello\n')
  assert.equal(value.exitCode, 0)
  assert.equal(value.argv[0], '/usr/bin/demo')
  assert.deepEqual(value.argv.slice(1), ['run', 'a b'])
  assert.equal(value.sandbox.declared, 'workspace-write')
  assert.equal(value.sandbox.enforcement, 'partial')

  // The spawn saw the confined argv, and the values are still separate elements.
  assert.deepEqual(fake.spawned[0].argv, ['/usr/bin/sandbox-runner', '/usr/bin/demo', 'run', 'a b'])
  assert.equal(fake.spawned[0].cwd, process.cwd())
  assert.equal(renderResult(value, { parse: 'text' }), 'hello\n')
})

test('full access skips confinement entirely', async () => {
  const fake = services({ mode: 'danger-full-access' })
  const value = await runCustomTool(fake.services, entryOf(tool({ sandbox: 'danger-full-access' })), { target: 'x' }, {})

  assert.equal(value.ok, true)
  assert.deepEqual(fake.spawned[0].argv, ['/usr/bin/demo', 'run', 'x'])
  assert.equal(value.sandbox.effective, 'danger-full-access')
})

test('a session may only tighten the declared tier', async () => {
  const fake = services({ mode: 'read-only' })
  const value = await runCustomTool(
    fake.services,
    entryOf(tool({ sandbox: 'danger-full-access' })),
    { target: 'x' },
    {},
  )
  assert.equal(value.sandbox.effective, 'read-only')
  assert.deepEqual(fake.spawned[0].argv[0], '/usr/bin/sandbox-runner')
})

test('sandbox failure fails closed instead of running bare', async () => {
  const fake = services({ confineFails: true })
  const value = await runCustomTool(fake.services, entryOf(tool()), { target: 'x' }, {})

  assert.equal(value.ok, false)
  assert.equal(value.code, 'SANDBOX_UNAVAILABLE')
  assert.equal(fake.spawned.length, 0)
})

test('non-zero exit becomes PROCESS_EXIT with stderr tail', async () => {
  const fake = services({ exitCode: 3, stdout: '', stderr: 'fatal: bad revision\n' })
  const value = await runCustomTool(fake.services, entryOf(tool()), { target: 'x' }, {})

  assert.equal(value.ok, false)
  assert.equal(value.code, 'PROCESS_EXIT')
  const text = renderResult(value, { parse: 'text' })
  assert.match(text, /PROCESS_EXIT/)
  assert.match(text, /fatal: bad revision/)
  assert.doesNotMatch(text, /\/usr\/bin\/demo/, 'argv must never reach the model')
})

test('missing executable is reported before anything is spawned', async () => {
  const fake = services()
  const value = await runCustomTool(fake.services, entryOf(tool({ executable: 'missing' })), { target: 'x' }, {})

  assert.equal(value.code, 'EXECUTABLE_NOT_FOUND')
  assert.equal(fake.spawned.length, 0)
})

test('credentials are resolved per call and never echoed', async () => {
  const fake = services()
  const entry = entryOf(tool({ credentials: [{ env: 'DEMO_TOKEN', ref: 'demo' }] }))
  const value = await runCustomTool(fake.services, entry, { target: 'x' }, {})

  assert.equal(value.ok, true)
  assert.equal(fake.spawned[0].env.DEMO_TOKEN, 'secret-value')
  assert.doesNotMatch(JSON.stringify(value), /secret-value/)
})

test('json output is parsed and schema-checked', async () => {
  const fake = services({ stdout: '{"count":2}' })
  const spec = tool({ output: { parse: 'json', schema: '{"type":"object","properties":{"count":{"type":"integer"}},"required":["count"]}' } })
  const value = await runCustomTool(fake.services, entryOf(spec), { target: 'x' }, {})
  assert.equal(value.ok, true)
  assert.equal(value.data, '{"count":2}')

  const mismatch = services({ stdout: '{"count":"two"}' })
  const bad = await runCustomTool(mismatch.services, entryOf(spec), { target: 'x' }, {})
  assert.equal(bad.code, 'OUTPUT_SCHEMA_MISMATCH')

  const notJson = services({ stdout: 'nope' })
  const invalid = await runCustomTool(notJson.services, entryOf(spec), { target: 'x' }, {})
  assert.equal(invalid.code, 'INVALID_JSON_OUTPUT')
})

test('preview builds argv without spawning', async () => {
  const fake = services()
  const value = await runCustomTool(fake.services, entryOf(tool()), { target: 'x' }, {}, { spawn: false })
  assert.equal(value.ok, true)
  assert.deepEqual(value.argv, ['/usr/bin/demo', 'run', 'x'])
  assert.equal(fake.spawned.length, 0)
})

test('python gets PYTHONIOENCODING unless the author overrides it', async () => {
  const fake = services()
  const python = entryOf(tool({ executable: 'python', args: [{ literal: '-V' }], parameters: {} }))
  await runCustomTool(fake.services, python, {}, {})
  assert.equal(fake.spawned[0].env.PYTHONIOENCODING, 'utf-8')

  const explicit = services()
  const overridden = entryOf(tool({
    executable: 'python',
    args: [{ literal: '-V' }],
    parameters: {},
    env: { PYTHONIOENCODING: 'gbk' },
  }))
  await runCustomTool(explicit.services, overridden, {}, {})
  assert.equal(explicit.spawned[0].env.PYTHONIOENCODING, 'gbk')
})

test('ssh-style flags with = stay one element', async () => {
  const fake = services()
  const spec = tool({
    parameters: { key: { type: 'string', required: true } },
    args: [{ literal: 'run' }, { arg: 'key', prefix: '--key=' }],
  })
  const value = await runCustomTool(fake.services, entryOf(spec), { key: 'a b' }, {})
  assert.deepEqual(value.argv, ['/usr/bin/demo', 'run', '--key=a b'])
})

test('a real agent resolves the sandbox tier from its session', async () => {
  const fake = services()
  const requests = []
  fake.services.sandboxPolicy = {
    resolve(request) {
      requests.push(request)
      return { mode: 'read-only', sessionId: 'sess-1' }
    },
  }
  const session = { id: 'sess-1' }

  const value = await runCustomTool(
    fake.services,
    entryOf(tool({ sandbox: 'workspace-write' })),
    { target: 'x' },
    { agent: { session } },
  )

  assert.equal(value.ok, true)
  assert.equal(value.sandbox.session, 'read-only')
  assert.equal(value.sandbox.effective, 'read-only')
  assert.deepEqual(requests, [{ session }])
})

test('an agentless call resolves the deployment default', async () => {
  const fake = services()
  const requests = []
  fake.services.sandboxPolicy = {
    resolve(request) {
      requests.push(request)
      return { mode: 'workspace-write' }
    },
  }

  await runCustomTool(fake.services, entryOf(tool()), { target: 'x' }, {})

  assert.deepEqual(requests, [{}], 'no session is invented when there is no agent')
})
