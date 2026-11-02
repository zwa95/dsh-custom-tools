/**
 * One document, three shapes.
 *
 * A tool definition travels as JSON between people — out of `export`, out of a
 * chat pasted into the settings page, out of a colleague's config file. These
 * tests pin the reader that all of those go through, because a shape the
 * export can produce and the import refuses is exactly the bug this file
 * exists to prevent.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { readToolDocument } from '../src/config/document.js'

function tool(overrides = {}) {
  return {
    name: 'git_status',
    description: '显示工作区状态。',
    mode: 'executable',
    executable: 'git',
    args: [{ literal: 'status' }],
    ...overrides,
  }
}

test('a single tool object is one tool', () => {
  const result = readToolDocument(tool())
  assert.equal(result.ok, true)
  assert.deepEqual(result.tools.map((entry) => entry.name), ['git_status'])
  assert.deepEqual(result.ignoredKeys, [])
})

test('an array is read in order', () => {
  const result = readToolDocument([tool(), tool({ name: 'git_log' })])
  assert.equal(result.ok, true)
  assert.deepEqual(result.tools.map((entry) => entry.name), ['git_status', 'git_log'])
})

test('a { tools: [...] } bundle is read and its other keys are reported', () => {
  const result = readToolDocument({ tools: [tool()], deferLoading: true })
  assert.equal(result.ok, true)
  assert.deepEqual(result.tools.map((entry) => entry.name), ['git_status'])
  assert.deepEqual(result.ignoredKeys, ['deferLoading'], 'the caller can say what it did not carry')
})

test('the bundle wrapper wins over tool sniffing', () => {
  // `{ tools: [...], name: 'x' }` is a bundle that happens to have a name key;
  // treating it as one tool would import a definition nobody wrote.
  const result = readToolDocument({ name: 'x', tools: [tool()] })
  assert.equal(result.ok, true)
  assert.equal(result.tools.length, 1)
  assert.equal(result.tools[0].name, 'git_status')
})

test('an empty document is refused', () => {
  for (const value of [[], { tools: [] }]) {
    const result = readToolDocument(value)
    assert.equal(result.ok, false, `${JSON.stringify(value)} is not a tool document`)
    assert.match(result.message, /没有任何工具/u)
  }
  // `{}` has neither a tools array nor a single key that looks like a tool, so
  // it falls out of shape detection instead of the emptiness check.
  const shape = readToolDocument({})
  assert.equal(shape.ok, false)
  assert.match(shape.message, /无法识别的文档形状/u)
})

test('a non-tool object is refused with the accepted shapes', () => {
  const result = readToolDocument({ hello: 'world' })
  assert.equal(result.ok, false)
  assert.match(result.message, /单个工具对象/u)
})

test('a non-object entry is named by position', () => {
  const result = readToolDocument([tool(), 'nope'])
  assert.equal(result.ok, false)
  assert.match(result.message, /第 2 项/u)
})

test('a repeated name is refused instead of silently collapsing', () => {
  const result = readToolDocument([tool(), tool()])
  assert.equal(result.ok, false)
  assert.match(result.message, /出现了两次/u)
})

test('unnamed definitions are left to validateTool to report', () => {
  // The reader decides which definitions exist, not whether they are valid: a
  // missing name has a better message from the validator than from here.
  const result = readToolDocument([{ description: 'x', mode: 'executable', executable: 'git' }])
  assert.equal(result.ok, true)
  assert.equal(result.tools.length, 1)
})
