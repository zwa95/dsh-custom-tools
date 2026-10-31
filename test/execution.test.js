import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { compile } from '../src/compiler/compile.js'
import { runCustomTool } from '../src/execution/run.js'
import { renderResult } from '../src/result/render.js'

import { validateJsonSubset } from '../src/execution/jsonschema.js'
import { OUTPUT_SCHEMA } from '../src/result/contract.js'

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
    exitCode: 0,
    signal: null,
    stdout: 'hello\n',
    stderr: '',
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

test('success returns stdout verbatim and spawns the exact argv', async () => {
  const fake = services()
  const value = await runCustomTool(fake.services, entryOf(tool()), { target: 'a b' }, {})

  assert.equal(value.ok, true)
  assert.equal(value.stdout, 'hello\n')
  assert.equal(value.exitCode, 0)
  assert.equal(value.argv[0], '/usr/bin/demo')
  assert.deepEqual(value.argv.slice(1), ['run', 'a b'])

  // The spawned argv is the same list, element for element: no wrapper, no join.
  assert.deepEqual(fake.spawned[0].argv, ['/usr/bin/demo', 'run', 'a b'])
  assert.equal(fake.spawned[0].cwd, process.cwd())
  assert.equal(renderResult(value, { parse: 'text' }), 'hello\n')
})

test('every result satisfies the declared output schema', async () => {
  const ok = await runCustomTool(services().services, entryOf(tool()), { target: 'a b' }, {})
  assert.equal(validateJsonSubset(OUTPUT_SCHEMA, ok), null)

  const failed = await runCustomTool(services({ spawnFails: true }).services, entryOf(tool()), { target: 'x' }, {})
  assert.equal(failed.ok, false)
  assert.equal(validateJsonSubset(OUTPUT_SCHEMA, failed), null)

  // Missing arguments bail out before anything is resolved: the result must
  // still carry every key, or the host rejects it as an extra property.
  const early = await runCustomTool(services().services, entryOf(tool()), {}, {})
  assert.equal(early.code, 'INVALID_ARGUMENT')
  assert.equal(validateJsonSubset(OUTPUT_SCHEMA, early), null)
})

test('nothing asks the host for a sandbox policy or confinement', async () => {
  const fake = services()
  let consulted = false
  // A tool runs with the privileges of the harness itself: no policy lookup and
  // no confinement step may appear in the path.
  fake.services.sandboxPolicy = { resolve() { consulted = true; return { mode: 'read-only' } } }
  fake.services.sandbox = { async confine() { consulted = true; return { argv: [] } } }

  const value = await runCustomTool(fake.services, entryOf(tool()), { target: 'x' }, {})

  assert.equal(value.ok, true)
  assert.equal(consulted, false)
  assert.deepEqual(fake.spawned[0].argv, ['/usr/bin/demo', 'run', 'x'])
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

test('a deployment without the subprocess service is a plugin fault, not a missing binary', async () => {
  const fake = services()
  const bare = { ...fake.services, subprocess: undefined }
  const value = await runCustomTool(bare, entryOf(tool()), { target: 'x' }, {})

  assert.equal(value.code, 'CUSTOM_TOOL_INTERNAL')
  assert.match(value.message, /subprocess/)
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

test('a real agent supplies the working directory', async () => {
  const fake = services()
  const seen = []
  fake.services.workingDirectory = {
    defaultDirectory: tmpdir(),
    async ensure(agent) { seen.push(agent); return process.cwd() },
  }

  const value = await runCustomTool(
    fake.services,
    entryOf(tool()),
    { target: 'x' },
    { agent: { id: 'agent-1' } },
  )

  assert.equal(value.ok, true)
  assert.equal(value.cwd, process.cwd())
  assert.deepEqual(seen, [{ id: 'agent-1' }])
})

test('an agentless call falls back to the deployment working directory', async () => {
  const fake = services()
  fake.services.workingDirectory = {
    defaultDirectory: tmpdir(),
    async ensure() { throw new Error('no agent') },
  }

  const value = await runCustomTool(fake.services, entryOf(tool()), { target: 'x' }, {})

  assert.equal(value.ok, true)
  assert.equal(value.cwd, tmpdir())
})
