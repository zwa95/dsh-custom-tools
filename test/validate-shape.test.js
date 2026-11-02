/**
 * What the validator says when a definition is *shaped* wrong rather than
 * merely invalid.
 *
 * A model writing a definition from memory does not get the shape wrong
 * subtly — it invents a field (`execution`), or writes `parameters` as the JSON
 * Schema it knows from every other tool API. Both used to be near-silent:
 * unknown keys were dropped, and a JSON Schema under `parameters` produced four
 * separate complaints about `type`, `properties`, `required` and
 * `additionalProperties` that never said what the right shape was. These tests
 * pin the replacement messages, because they are the only feedback the model
 * gets before it retries.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { validateTool } from '../src/config/validate.js'

/** Minimal valid definition, so each test can break exactly one thing. */
function base(overrides = {}) {
  return {
    name: 'demo',
    description: '在目录里搜字符串。',
    mode: 'executable',
    executable: 'rg',
    args: [{ arg: 'pattern' }],
    parameters: { pattern: { type: 'string', required: true, description: '要找的字符串' } },
    ...overrides,
  }
}

test('an unknown top-level key is named with the valid ones listed', () => {
  const issues = validateTool(base({ execution: { type: 'bash' } }), 'tools[0]')

  const issue = issues.find((entry) => entry.code === 'UNKNOWN_KEY')
  assert.ok(issue, 'the invented key is reported')
  assert.equal(issue.severity, 'error')
  assert.match(issue.message, /execution/u)
  assert.match(issue.message, /可用字段/u)
  assert.match(issue.message, /parameters/u, 'the message lists real field names')
})

test('a parameter map shaped like JSON Schema gets one explanation, not four', () => {
  const issues = validateTool(
    base({
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
        additionalProperties: false,
      },
    }),
    'tools[0]',
  )

  const matching = issues.filter((entry) => entry.code === 'PARAMETERS_IS_SCHEMA')
  assert.equal(matching.length, 1, 'exactly one explanation')
  assert.match(matching[0].message, /参数名 → 规格/u)
  assert.equal(
    issues.filter((entry) => entry.code.startsWith('PARAMETER_')).length,
    0,
    'no per-key noise underneath the explanation',
  )
})

test('an unknown key inside a parameter is reported at its own path', () => {
  const issues = validateTool(
    base({
      parameters: { pattern: { type: 'string', required: true, descrption: '拼错' } },
    }),
    'tools[0]',
  )

  const issue = issues.find((entry) => entry.code === 'UNKNOWN_KEY')
  assert.ok(issue)
  assert.match(issue.path, /parameters\.pattern\.descrption/u)
  assert.match(issue.message, /description/u, 'the likely intended key is offered')
})

test('an unknown key inside an argv binding is reported', () => {
  const issues = validateTool(
    base({ args: [{ arg: 'pattern', preffix: '--' }] }),
    'tools[0]',
  )

  const issue = issues.find((entry) => entry.code === 'UNKNOWN_KEY')
  assert.ok(issue)
  assert.match(issue.message, /prefix/u)
})

test('a binding that is not an object explains both accepted shapes', () => {
  const issues = validateTool(base({ args: ['--line-number'] }), 'tools[0]')

  const issue = issues.find((entry) => entry.code === 'ARG_SHAPE')
  assert.ok(issue)
  assert.match(issue.message, /literal/u)
  assert.match(issue.message, /arg/u)
})

test('a bare number default is rejected with the string form to use', () => {
  // It used to validate and then fail at call time with "参数 count 必须是数字",
  // which points at the caller instead of the definition.
  const issues = validateTool(
    base({ parameters: { count: { type: 'integer', default: 20 } } }),
    'tools[0]',
  )

  const issue = issues.find((entry) => entry.code === 'PARAMETER_DEFAULT_TEXT')
  assert.ok(issue)
  assert.equal(issue.severity, 'error')
  assert.match(issue.message, /"20"/u)
})

test('an array items written as a nested schema is rejected with the bare form', () => {
  const issues = validateTool(
    base({ parameters: { paths: { type: 'array', items: { type: 'string' } } } }),
    'tools[0]',
  )

  const issue = issues.find((entry) => entry.code === 'PARAMETER_ITEMS')
  assert.ok(issue)
  assert.match(issue.message, /"items": "string"/u)
})

test('a shell definition may set executable, but not to nothing', () => {
  // `executable` on a bash/powershell tool is the shell binary, and an absent
  // field means "the default bash/pwsh". An empty string is neither: downstream
  // it is the program name, so it fails at call time instead of here.
  const ok = validateTool(base({
    mode: 'bash',
    executable: 'C:/Program Files/Git/bin/bash.exe',
    command: 'grep -rn -- "$@"',
  }), 'tools[0]')
  assert.deepEqual(ok.filter((entry) => entry.severity === 'error'), [])

  const blank = validateTool(base({ mode: 'bash', executable: '', command: 'true' }), 'tools[0]')
  const issue = blank.find((entry) => entry.code === 'MODE_FIELD_REQUIRED' && entry.path === 'tools[0].executable')
  assert.ok(issue, 'an empty shell path is reported at the field')
  assert.match(issue.message, /默认用 bash/u)
})

test('a valid definition produces no issues at all', () => {
  assert.deepEqual(validateTool(base(), 'tools[0]'), [])
})
