/**
 * The propose tool's contract: it validates, it explains, and it returns the one
 * line that would install the tool — nothing else.
 *
 * It writes no configuration and no files. `/custom-tools add` is the step that
 * changes the profile, so it is already the human gate; a draft directory would
 * have been a second copy of the same definition to keep in sync, with nothing
 * able to consume it. An approval prompt in front of the write gated the same
 * action twice as well, and on a `never` policy it rejected the proposal before
 * the human saw a card.
 *
 * So what these tests pin is the whole bargain: nothing reaches disk, the
 * returned command round-trips back to exactly the definition that was
 * validated, and the JSON is visible in the message the user reads.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register('../test-support/loader.mjs', import.meta.url)
const { defineTool } = await import('@deepseek-ai/dsh-tools')
const { registerProposeTool, PROPOSE_TOOL_NAME, describeTarget } = await import(
  '../src/admin/propose.js'
)

const DEFINITION = {
  name: 'demo_grep',
  description: '在目录里搜字符串。',
  mode: 'bash',
  command: 'grep -rnI -- "$@"',
  args: [{ arg: 'pattern' }, { arg: 'path' }],
  parameters: {
    pattern: { type: 'string', required: true, description: '要找的字符串' },
    path: { type: 'string', default: '"."', description: '搜索目录' },
  },
}

/** Mount the tool on a fake context; the settings service is optional. */
function mount({ existing = [], settingsThrows = false } = {}) {
  const registered = new Map()

  const ctx = {
    effect(factory) {
      return factory()
    },
    get(serviceName) {
      if (serviceName !== 'settings') return undefined
      if (settingsThrows) throw new Error('no settings service')
      return {
        describe: () => [{ ns: 'custom-tools', value: { tools: existing } }],
      }
    },
  }

  registerProposeTool(ctx, {
    defineTool,
    registry: { register: (definition) => registered.set(definition.name, definition) },
    namespace: 'custom-tools',
  })

  const tool = registered.get(PROPOSE_TOOL_NAME)
  assert.ok(tool, 'the propose tool is registered')
  return { tool, call: (args) => tool.execute(args, {}) }
}

test('an invalid definition returns problems and no command', async () => {
  const { call } = mount()
  const result = await call({ intent: '试一试', definition: { name: 'Bad Name' } })

  assert.equal(result.ok, false)
  assert.equal(result.command, '')
  assert.match(result.message, /没有通过校验/u)
  assert.ok(result.issues.length > 0, 'issues are returned as data as well as prose')
  assert.match(result.message, /NAME_/u)
})

test('an unknown key is named instead of silently dropped', async () => {
  const { call } = mount()
  const result = await call({
    intent: '试一试',
    definition: { ...DEFINITION, execution: { type: 'bash' } },
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /UNKNOWN_KEY/u)
  assert.match(result.message, /execution/u)
})

test('a valid definition returns a paste-ready command and nothing else', async () => {
  const { call } = mount()
  const result = await call({ intent: '用户想搜代码', definition: DEFINITION })

  assert.equal(result.ok, true)
  assert.match(result.command, /^\/custom-tools add \{/u)
  assert.match(result.message, /没有写入任何东西/u, 'the result says it changed nothing')
  assert.match(result.message, /生效需要用户执行这一行/u)
})

test('the command carries the exact definition that was validated', async () => {
  const { call } = mount()
  const result = await call({ intent: '用户想搜代码', definition: DEFINITION })

  const json = result.command.replace(/^\/custom-tools add /u, '')
  assert.deepEqual(JSON.parse(json), DEFINITION, 'the JSON argument round-trips')

  // The same JSON is shown in the message, pretty-printed for reading.
  assert.match(result.message, /"command": "grep -rnI -- /u)
  assert.match(result.message, /\\"\$@\\"/u, 'quotes inside the command text are escaped, not lost')
})

test('a name that already exists is announced as a replacement', async () => {
  const { call } = mount({
    existing: [{ name: 'demo_grep', mode: 'bash', description: '旧版本' }],
  })
  const result = await call({ intent: '改一下', definition: DEFINITION })

  assert.equal(result.ok, true)
  assert.match(result.message, /会替换同名工具/u)
})

test('a missing settings service still yields the command', async () => {
  const { call } = mount({ settingsThrows: true })
  const result = await call({ intent: '试一试', definition: DEFINITION })

  assert.equal(result.ok, true)
  assert.match(result.command, /^\/custom-tools add \{/u)
  assert.doesNotMatch(result.message, /会替换同名工具/u)
})

test('an empty intent is refused before anything else happens', async () => {
  const { call } = mount()
  const result = await call({ intent: '   ', definition: DEFINITION })

  assert.equal(result.ok, false)
  assert.match(result.message, /intent/u)
})

test('the summary names the program and mode', () => {
  assert.match(
    describeTarget({ ...DEFINITION, mode: 'bash' }),
    /^demo_grep（bash）：grep -rnI/u,
  )
  assert.match(
    describeTarget({ name: 'x', mode: 'script', interpreter: 'python', script: 'a.py' }),
    /^x（脚本）：python a\.py/u,
  )
  assert.match(
    describeTarget({ name: 'x', mode: 'executable', executable: 'rg', args: [{ arg: 'q' }] }),
    /rg \+ 1 个固定参数/u,
  )
})
