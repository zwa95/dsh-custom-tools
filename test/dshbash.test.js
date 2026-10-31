import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { pathWithStaged, resolveStagedBash } from '../src/execution/dshbash.js'

function stagedHome(files) {
  const home = mkdtempSync(join(tmpdir(), 'dshbash-'))
  const bin = join(home, 'dsh-ops', 'bash-ipc', 'identity', 'usr', 'bin')
  mkdirSync(bin, { recursive: true })
  for (const name of files) writeFileSync(join(bin, name), '')
  return { home, root: join(home, 'dsh-ops', 'bash-ipc', 'identity'), bin }
}

test('a staged runtime is only trusted when its proxies are present', () => {
  const incomplete = stagedHome(['bash.exe', 'msys-2.0.dll'])
  assert.equal(resolveStagedBash({ DSH_HOME: incomplete.home }), undefined)

  const complete = stagedHome(['bash.exe', 'msys-2.0.dll', 'opsipc.dll'])
  const found = resolveStagedBash({ DSH_HOME: complete.home })
  assert.equal(found.file, join(complete.bin, 'bash.exe'))
  assert.deepEqual(found.directories, [complete.bin])
  assert.equal(found.root, complete.root)
})

test('a missing dsh-ops cache is not an error', () => {
  const home = mkdtempSync(join(tmpdir(), 'dshbash-empty-'))
  assert.equal(resolveStagedBash({ DSH_HOME: home }), undefined)
})

test('staged directories lead the PATH so the pinned runtime wins', () => {
  const path = pathWithStaged(['C:\\staged\\usr\\bin'], 'C:\\Windows\\System32')
  assert.equal(path.split(';')[0], 'C:\\staged\\usr\\bin')
  assert.ok(path.endsWith('C:\\Windows\\System32'))
})
