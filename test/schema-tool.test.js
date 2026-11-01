/**
 * The reference tool's contract: every example it hands a model must itself be
 * a valid definition.
 *
 * That is the whole point of the tool. A model with no repository context wrote
 * a `bash` tool that interpolated `{{pattern}}` into a command line — the exact
 * shape this plugin refuses — because nothing in the conversation showed it what
 * a correct definition looks like. An example that fails validation would teach
 * the same mistake with more confidence, so the suite runs every one through the
 * real validator.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register('../test-support/loader.mjs', import.meta.url)
const { defineTool } = await import('@deepseek-ai/dsh-tools')
const {
  registerSchemaTool,
  SCHEMA_TOOL_NAME,
  MODES,
  EXAMPLES,
  exampleIssues,
  referenceText,
} = await import('../src/admin/schema-tool.js')

test('every shipped example is a valid definition', () => {
  assert.deepEqual(exampleIssues(), [])
})

test('the examples cover each mode exactly once', () => {
  assert.deepEqual(Object.keys(EXAMPLES).sort(), [...MODES].sort())
  for (const mode of MODES) {
    assert.equal(EXAMPLES[mode].mode, mode)
    assert.equal(EXAMPLES[mode].name, EXAMPLES[mode].name.toLowerCase())
  }
})

test('the reference states the four rules a model gets wrong', () => {
  const text = referenceText()
  assert.match(text, /不拼进 command/u, 'values never reach command text')
  assert.match(text, /不是一份 JSON Schema/u, 'parameters is a map, not a schema')
  assert.match(text, /绝对路径/u, 'cwd is dot or absolute')
  assert.match(text, /stdin/u, 'PowerShell takes parameters over stdin')
})

test('the reference lists the fields inside a parameter spec', () => {
  // A blind trial wrote an array parameter with no `items` and only found out
  // from the error. The keys of a parameter spec have to be visible up front,
  // for the same reason the top-level keys are.
  const text = referenceText()
  assert.match(text, /parameters 里每个参数的字段/u)
  assert.match(text, /items：array 必填/u)
  assert.match(text, /default：可选。\*\*JSON 文本\*\*/u)
})

test('a mode filter returns one example and no other', () => {
  const text = referenceText({ mode: 'powershell' })
  assert.match(text, /### powershell/u)
  assert.doesNotMatch(text, /### bash/u)
})

test('existing tools are listed when the settings service answers', async () => {
  const registered = new Map()
  const ctx = {
    effect(factory) {
      return factory()
    },
    get(serviceName) {
      if (serviceName !== 'settings') return undefined
      return {
        describe: () => [
          {
            ns: 'custom-tools',
            value: {
              tools: [
                { name: 'rg_search', mode: 'executable', description: '用 ripgrep 搜索仓库' },
                { name: 'pretty_json', mode: 'script', description: '格式化 JSON' },
              ],
            },
          },
          { ns: 'other-plugin', value: { tools: [{ name: 'not_ours' }] } },
        ],
      }
    },
  }

  registerSchemaTool(ctx, {
    defineTool,
    registry: { register: (definition) => registered.set(definition.name, definition) },
    namespace: 'custom-tools',
  })

  const tool = registered.get(SCHEMA_TOOL_NAME)
  assert.ok(tool, 'the reference tool is registered')
  const value = await tool.execute({}, {})
  assert.match(value.reference, /用户现有的工具/u)
  assert.match(value.reference, /rg_search（executable）/u)
  assert.doesNotMatch(value.reference, /not_ours/u, 'other namespaces stay out')
})

test('a missing settings service yields the reference without a tool list', async () => {
  const registered = new Map()
  const ctx = {
    effect(factory) {
      return factory()
    },
    get() {
      throw new Error('no services')
    },
  }

  registerSchemaTool(ctx, {
    defineTool,
    registry: { register: (definition) => registered.set(definition.name, definition) },
    namespace: 'custom-tools',
  })

  const value = await registered.get(SCHEMA_TOOL_NAME).execute({ mode: 'all' }, {})
  assert.match(value.reference, /四条硬规则/u)
  assert.doesNotMatch(value.reference, /用户现有的工具/u)
})
