import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { compile } from '../src/compiler/compile.js'
import { bashCandidates, isStubBash, POWERSHELL_FALLBACK } from '../src/execution/interpreters.js'
import { runCustomTool } from '../src/execution/run.js'

function entryOf(spec) {
  return compile({ tools: [spec] }).tools.get(spec.name)
}

function fakeServices(overrides = {}) {
  const spawned = []
  const state = {
    spawned,
    exitCode: 0,
    stdout: 'ok\n',
    stderr: '',
    resolve: overrides.resolve,
  }
  const services = {
    subprocess: {
      async resolveExecutable(name) {
        return state.resolve(name)
      },
      spawn(spec) {
        spawned.push(spec)
        return {
          collected: {
            stdout: { readFrom: () => ({ text: state.stdout, nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: state.stderr, nextOffset: 0, lossy: false }) },
          },
          done: Promise.resolve({ exitCode: state.exitCode, signal: null }),
          terminate() {},
          async waitForExit() { return true },
        }
      },
    },
    shellEnv: { collect: () => ({}) },
    workingDirectory: { defaultDirectory: process.cwd(), ensure: async () => process.cwd() },
  }
  return { state, services }
}

test('the WSL launcher and the store stub are not bash', () => {
  assert.equal(isStubBash('C:\\Windows\\System32\\bash.exe'), true)
  assert.equal(isStubBash('c:/windows/system32/BASH.EXE'), true)
  assert.equal(isStubBash('C:\\Users\\mark\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe'), true)
  assert.equal(isStubBash('C:\\Program Files\\Git\\bin\\bash.exe'), false)
  assert.equal(isStubBash('C:\\msys64\\usr\\bin\\bash.exe'), false)
})

test('a git installation on PATH contributes a bash candidate', () => {
  const root = mkdtempSync(join(tmpdir(), 'cts-interp-'))
  try {
    mkdirSync(join(root, 'git', 'bin'), { recursive: true })
    writeFileSync(join(root, 'git', 'bin', 'bash.exe'), '')
    const candidates = bashCandidates({}, join(root, 'git', 'cmd', 'git.exe'))
    assert.equal(candidates[0], join(root, 'git', 'bin', 'bash.exe'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a default bash that resolves to the WSL launcher falls back to a real bash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cts-interp-'))
  try {
    mkdirSync(join(root, 'git', 'bin'), { recursive: true })
    const realBash = join(root, 'git', 'bin', 'bash.exe')
    writeFileSync(realBash, '')
    const { state, services } = fakeServices({
      resolve: (name) => {
        if (name === 'bash') return 'C:\\Windows\\System32\\bash.exe'
        if (name === 'git') return join(root, 'git', 'cmd', 'git.exe')
        return `/usr/bin/${name}`
      },
    })
    const entry = entryOf({
      name: 'shout',
      description: '回显参数',
      mode: 'bash',
      command: 'echo "$@"',
      parameters: { value: { type: 'string', required: true } },
      args: [{ arg: 'value' }],
    })
    const result = await runCustomTool(services, entry, { value: 'hi' }, { signal: null })
    assert.equal(result.ok, true)
    assert.equal(state.spawned.length, 1)
    assert.equal(state.spawned[0].argv[0], realBash)
    assert.deepEqual(state.spawned[0].argv.slice(1, 4), ['-c', 'echo "$@"', 'custom-tool'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an explicit bash executable is used as given', async () => {
  const { state, services } = fakeServices({ resolve: (name) => name })
  const entry = entryOf({
    name: 'shout',
    description: '回显参数',
    mode: 'bash',
    executable: 'C:\\Program Files\\Git\\bin\\bash.exe',
    command: 'echo "$@"',
    parameters: {},
    args: [],
  })
  const result = await runCustomTool(services, entry, {}, { signal: null })
  assert.equal(result.ok, true)
  assert.equal(state.spawned[0].argv[0], 'C:\\Program Files\\Git\\bin\\bash.exe')
})

test('a missing pwsh falls back to Windows PowerShell', async () => {
  const { state, services } = fakeServices({
    resolve: (name) => {
      if (name === 'pwsh') {
        const error = new Error('not found')
        error.name = 'SubprocessExecutableNotFoundError'
        throw error
      }
      if (name === POWERSHELL_FALLBACK) return 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      return `/usr/bin/${name}`
    },
  })
  const entry = entryOf({
    name: 'report',
    description: '写报告',
    mode: 'powershell',
    command: 'Write-Output $args[0]',
    parameters: {},
    args: [],
  })
  const result = await runCustomTool(services, entry, {}, { signal: null })
  assert.equal(result.ok, true)
  assert.equal(state.spawned[0].argv[0],
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.ok(state.spawned[0].argv.includes('-Command'))
})

test('UTF-16LE output from a Windows program stays readable', async () => {
  const { state, services } = fakeServices({ resolve: (name) => `/usr/bin/${name}` })
  // "denied" as UTF-16LE, decoded as UTF-8 first — the shape the WSL launcher produced.
  state.stdout = Buffer.from('denied', 'utf16le').toString('utf8')
  state.stderr = ''
  state.exitCode = 1
  const entry = entryOf({
    name: 'demo',
    description: '演示',
    mode: 'executable',
    executable: 'demo',
    parameters: {},
    args: [],
  })
  const result = await runCustomTool(services, entry, {}, { signal: null })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PROCESS_EXIT')
  assert.equal(result.stdout.trim(), 'denied')
})
