import assert from 'node:assert/strict'
import test from 'node:test'

import { compile } from '../src/compiler/compile.js'
import { buildInvocation } from '../src/compiler/bindings.js'
import { normalizeArguments } from '../src/compiler/parameters.js'
import { validateSnapshot } from '../src/config/validate.js'

function spec(overrides = {}) {
  return {
    name: 'git_status',
    description: '显示工作区状态',
    mode: 'executable',
    enabled: true,
    executable: 'git',
    parameters: {},
    args: [{ literal: 'status' }],
    ...overrides,
  }
}

function compiled(tool) {
  const result = compile({ tools: [tool] })
  assert.deepEqual(result.issues.filter((i) => i.severity === 'error'), [])
  const entry = result.tools.get(tool.name)
  assert.ok(entry, 'tool should compile')
  return entry
}

test('literal and arg produce exact argv elements', () => {
  const tool = compiled(spec({
    parameters: { path: { type: 'string', required: true } },
    args: [{ literal: 'status' }, { arg: 'path' }],
  }))
  const values = normalizeArguments(tool.plan.parameters, { path: 'C:\\Program Files\\demo' })
  assert.equal(values.ok, true)
  const built = buildInvocation(tool.plan, values.values)
  assert.deepEqual(built.argv, ['git', 'status', 'C:\\Program Files\\demo'])
})

test('empty and quoted values survive untouched', () => {
  const tool = compiled(spec({
    parameters: { msg: { type: 'string', required: true } },
    args: [{ arg: 'msg' }],
  }))
  const values = normalizeArguments(tool.plan.parameters, { msg: "it's \"quoted\" 中文" })
  const built = buildInvocation(tool.plan, values.values)
  assert.deepEqual(built.argv, ['git', "it's \"quoted\" 中文"])
})

test('leading dash and response file are refused unless allowed', () => {
  const strict = compiled(spec({ parameters: { ref: { type: 'string', required: true } }, args: [{ arg: 'ref' }] }))
  const dash = buildInvocation(strict.plan, { ref: '--upload-pack=evil' })
  assert.equal(dash.ok, false)
  assert.match(dash.errors[0], /以 - 开头/)

  const at = buildInvocation(strict.plan, { ref: '@/etc/passwd' })
  assert.equal(at.ok, false)
  assert.match(at.errors[0], /response file/)

  const relaxed = compiled(spec({
    parameters: { ref: { type: 'string', required: true } },
    args: [{ arg: 'ref', allowLeadingDash: true, allowResponseFile: true }],
  }))
  const ok = buildInvocation(relaxed.plan, { ref: '--force' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.argv, ['git', '--force'])
})

test('boolean flags, prefixes, join and repeat', () => {
  const tool = compiled(spec({
    parameters: {
      verbose: { type: 'boolean' },
      fmt: { type: 'string' },
      labels: { type: 'array', items: 'string' },
    },
    args: [
      { flag: 'verbose', as: ['-v', '--verbose'] },
      { arg: 'fmt', prefix: '--format=' },
      { arg: 'labels', repeat: true, suffix: '!' },
    ],
  }))
  const built = buildInvocation(tool.plan, { verbose: true, fmt: 'json', labels: ['a', 'b'] })
  assert.equal(built.ok, true)
  assert.deepEqual(built.argv, ['git', '-v', '--verbose', '--format=json', 'a!', 'b!'])

  const off = buildInvocation(tool.plan, { verbose: false, fmt: 'json', labels: [] })
  assert.deepEqual(off.argv, ['git', '--format=json'])
})

test('stdin json carries the whole normalised object', () => {
  const tool = compiled(spec({
    mode: 'powershell',
    executable: undefined,
    command: '$input | ConvertFrom-Json',
    parameters: { n: { type: 'integer', required: true } },
    args: [{ stdin: 'json' }],
  }))
  const built = buildInvocation(tool.plan, { n: 3 })
  assert.equal(built.ok, true)
  assert.equal(built.stdin.kind, 'json')
  assert.equal(built.stdin.text, '{"n":3}')
})

test('bash and powershell pass values positionally, never into the source', () => {
  const bash = compiled(spec({
    mode: 'bash',
    executable: undefined,
    command: 'printf "%s\\n" "$@"',
    parameters: { a: { type: 'string' }, b: { type: 'string' } },
    args: [{ arg: 'a' }, { arg: 'b' }],
  }))
  const built = buildInvocation(bash.plan, { a: 'x; rm -rf /', b: 'y' }, { executable: '/usr/bin/bash' })
  assert.equal(built.ok, true)
  assert.deepEqual(built.argv, ['/usr/bin/bash', '-c', 'printf "%s\\n" "$@"', 'custom-tool', 'x; rm -rf /', 'y'])
})

test('defaults are applied, unknown arguments rejected', () => {
  const tool = compiled(spec({
    parameters: {
      depth: { type: 'integer', default: '2' },
      mode: { type: 'string', enum: ['a', 'b'], required: true },
    },
    args: [{ arg: 'depth', prefix: '--depth=' }, { arg: 'mode' }],
  }))
  const ok = normalizeArguments(tool.plan.parameters, { mode: 'a' })
  assert.deepEqual(ok.values, { mode: 'a', depth: 2 })

  const unknown = normalizeArguments(tool.plan.parameters, { mode: 'a', extra: 1 })
  assert.equal(unknown.ok, false)
  assert.match(unknown.errors.join(), /未声明/)

  const enumMiss = normalizeArguments(tool.plan.parameters, { mode: 'z' })
  assert.equal(enumMiss.ok, false)
})

test('validation catches cross-field mistakes', () => {
  const { errors } = validateSnapshot({
    tools: [
      spec({ name: 'Bad Name', parameters: {} }),
      spec({
        name: 'two_stdin',
        parameters: { a: { type: 'string' }, b: { type: 'string' } },
        args: [{ arg: 'a', stdin: 'raw' }, { stdin: 'json' }],
      }),
      spec({
        name: 'bad_flag',
        parameters: { n: { type: 'number' } },
        args: [{ flag: 'n', as: '-n' }],
      }),
      spec({
        name: 'missing_target',
        executable: undefined,
      }),
    ],
  })
  const codes = errors.map((issue) => issue.code)
  assert.ok(codes.includes('TOOL_NAME_FORMAT'))
  assert.ok(codes.includes('ARG_STDIN_DUPLICATE'))
  assert.ok(codes.includes('ARG_FLAG_NOT_BOOLEAN'))
  assert.ok(codes.includes('MODE_FIELD_REQUIRED'))
})

test('a broken tool keeps its last good version while the rest move on', () => {
  const first = compile({ tools: [spec({ name: 'keep' }), spec({ name: 'other' })] })
  assert.equal(first.ok, true)

  const second = compile({
    tools: [
      spec({ name: 'keep', description: '' }),
      spec({ name: 'other', args: [{ literal: 'log' }] }),
    ],
  }, first.tools)

  assert.equal(second.ok, true)
  assert.deepEqual([...second.tools.keys()].sort(), ['keep', 'other'])
  assert.deepEqual(second.usedLastGood, ['keep'])
  assert.equal(second.tools.get('other').plan.args[0].literal, 'log')
  assert.deepEqual(second.tools.get('keep').plan.args[0], { literal: 'status' })
})

test('contract hash ignores implementation-only edits', () => {
  const base = compiled(spec({ args: [{ literal: 'status' }] }))
  const bodyOnly = compiled(spec({ args: [{ literal: 'diff' }] }))
  const description = compiled(spec({ description: '另一个说明' }))

  assert.equal(base.contractHash, bodyOnly.contractHash)
  assert.notEqual(base.contractHash, description.contractHash)
})
