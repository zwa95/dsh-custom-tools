/**
 * The browser half cannot run here, but its *wiring* can: load the bundle the
 * way the harness ModuleLoader does, hand it a fake React and a fake slot
 * registry, and assert it registers one settings section with a component.
 *
 * That is exactly the part that fails silently in production — a wrong module
 * id means "loaded without registering <name>", a wrong inject name means the
 * page never mounts, and neither shows up as an error anywhere.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8')

/** Minimal React surface: enough for module load, not for rendering. */
function fakeReact() {
  const hook = () => undefined
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, hook],
    useEffect: hook,
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    Fragment: Symbol('Fragment'),
  }
}

function loadBundle() {
  let captured
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { captured = spec } } },
    console,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(captured, 'the bundle registers itself with the ModuleLoader')
  return captured
}

test('the client registers under the package name', () => {
  const spec = loadBundle()
  // The loader rejects a bundle whose id does not match the package it came
  // from ("loaded without registering <name>"), so this is load-bearing.
  assert.equal(spec.id, 'dsh-custom-tools')
  assert.equal(typeof spec.factory, 'function')
})

test('the client declares the remote settings service it reads', () => {
  const exportsObject = loadBundle().factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require: ${name}`)
  })
  // Arrays built inside the VM carry that realm's prototype, so compare values.
  assert.deepEqual(Array.from(exportsObject.inject), ['slots', 'remote', 'remote.settings'])
  assert.equal(typeof exportsObject.apply, 'function')
})

test('mounting registers exactly one settings section with a component', () => {
  const exportsObject = loadBundle().factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require: ${name}`)
  })

  const registered = []
  const slots = {
    inject(name, generator) {
      assert.equal(name, 'settings.section')
      const iterator = generator()
      for (let step = iterator.next(); !step.done; step = iterator.next()) {
        registered.push(step.value)
      }
    },
    register(definition, component) {
      return { definition, component }
    },
  }

  const ctx = {
    slots,
    remote: { settings: { describe: async () => ({ ok: true, value: [] }), mutate: async () => ({ ok: true }) } },
    get(service) {
      return service === 'slots' ? slots : service === 'remote' ? ctx.remote : undefined
    },
  }

  exportsObject.apply(ctx)

  assert.equal(registered.length, 1, 'one section, not zero and not two')
  const [{ definition, component }] = registered
  assert.equal(definition.name, 'settings.section')
  assert.equal(definition.id, 'custom-tools')
  assert.equal(typeof definition.label, 'string')
  assert.equal(typeof component, 'function', 'the section renders a component')
})

test('an absent remote settings namespace does not stop the section mounting', () => {
  const exportsObject = loadBundle().factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require: ${name}`)
  })

  let registered = 0
  const slots = {
    inject(_name, generator) {
      const iterator = generator()
      for (let step = iterator.next(); !step.done; step = iterator.next()) registered += 1
    },
    register() {
      return {}
    },
  }
  const ctx = { slots, get: (service) => (service === 'slots' ? slots : undefined) }

  assert.doesNotThrow(() => exportsObject.apply(ctx))
  assert.equal(registered, 1)
})

test('the section reads remote settings through the soft get path', () => {
  // Regression: `ctx.remote.settings` throws "cannot get property
  // \"remote.settings\" without inject" on the client, because the client
  // context guards service properties exactly like the host does. `ctx.get()`
  // is the documented soft path and degrades to an inline explanation.
  assert.match(source, /ctx\.get\('remote\.settings'\)/u)
  assert.match(source, /'slots', 'remote', 'remote\.settings'/u)
})

test('a card key never embeds the tool name, so typing cannot remount the field', () => {
  // Regression: keying ToolCard by `${index}:${tool.name}` remounted the whole
  // card on every keystroke, so the name input lost focus after one character.
  assert.match(source, /key: rowIds\.current\[index\]/u)
  assert.doesNotMatch(source, /key: `\$\{index\}:\$\{asString\(tool\.name\)\}`/u)
})

test('the JSON textareas survive parent re-renders', () => {
  // Regression: JsonField compared `value` by identity, and the page rebuilds
  // `advanced` on every render, so each keystroke reset the textarea content.
  assert.match(source, /const serialized = \(input\) => JSON\.stringify\(input \?\? null\)/u)
  assert.match(source, /if \(incoming !== adopted\.current\)/u)
})

// ---------------------------------------------------------------- argv parity

/**
 * The page draws an argv strip that it computes locally; the host spawns from
 * `buildInvocation`. If those two ever disagree the page lies about what will
 * run, which is worse than showing nothing. This compares them on a matrix of
 * definitions instead of trusting that the port stayed in sync.
 */
function clientInternals() {
  const exportsObject = loadBundle().factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require: ${name}`)
  })
  assert.ok(exportsObject.__internal, 'the bundle exposes its pure helpers for tests')
  return exportsObject.__internal
}

const BASE = {
  name: 'demo',
  description: 'test fixture',
  mode: 'executable',
  executable: '/usr/bin/demo',
  args: [],
  parameters: {},
}

const PARITY_CASES = [
  {
    label: 'literal arguments only',
    spec: { ...BASE, args: [{ literal: 'run' }, { literal: '--short' }] },
    values: {},
  },
  {
    label: 'a positional value keeps its spaces and CJK',
    spec: {
      ...BASE,
      args: [{ arg: 'text' }],
      parameters: { text: { type: 'string', required: true } },
    },
    values: { text: 'hello 中文 "quoted"' },
  },
  {
    label: 'prefix and suffix wrap one element',
    spec: {
      ...BASE,
      args: [{ arg: 'glob', prefix: '--glob=', suffix: '' }],
      parameters: { glob: { type: 'string' } },
    },
    values: { glob: '*.ts' },
  },
  {
    label: 'a blank value still emits the prefix',
    spec: {
      ...BASE,
      args: [{ arg: 'format', prefix: '--format=' }],
      parameters: { format: { type: 'string' } },
    },
    values: { format: '' },
  },
  {
    label: 'omitIfEmpty suppresses a blank value',
    spec: {
      ...BASE,
      args: [{ arg: 'format', prefix: '--format=', omitIfEmpty: true }],
      parameters: { format: { type: 'string' } },
    },
    values: { format: '' },
  },
  {
    label: 'a switch expands only when true',
    spec: {
      ...BASE,
      args: [{ flag: 'dry', as: ['--dry-run', '-n'] }],
      parameters: { dry: { type: 'boolean' } },
    },
    values: { dry: true },
  },
  {
    label: 'a false switch contributes nothing',
    spec: {
      ...BASE,
      args: [{ flag: 'dry', as: '--dry-run' }],
      parameters: { dry: { type: 'boolean' } },
    },
    values: { dry: false },
  },
  {
    label: 'repeat emits one element per item',
    spec: {
      ...BASE,
      args: [{ arg: 'paths', repeat: true, prefix: '--path=' }],
      parameters: { paths: { type: 'array', items: 'string' } },
    },
    values: { paths: ['a', 'b'] },
  },
  {
    label: 'join folds an array into one element',
    spec: {
      ...BASE,
      args: [{ arg: 'paths', join: ',' }],
      parameters: { paths: { type: 'array', items: 'string' } },
    },
    values: { paths: ['a', 'b'] },
  },
  {
    label: 'json serialises a structured value',
    spec: {
      ...BASE,
      args: [{ arg: 'payload', json: true }],
      parameters: { payload: { type: 'array', items: 'number' } },
    },
    values: { payload: [1, 2] },
  },
  {
    label: 'an empty array contributes no element',
    spec: {
      ...BASE,
      args: [{ arg: 'paths' }],
      parameters: { paths: { type: 'array', items: 'string' } },
    },
    values: { paths: [] },
  },
  {
    label: 'bash passes values after the argv0 placeholder',
    spec: {
      name: 'sh_tool',
      description: 'bash fixture',
      mode: 'bash',
      command: 'printf "%s\\n" "$@"',
      args: [{ arg: 'value' }],
      parameters: { value: { type: 'string', required: true } },
    },
    values: { value: '-notaflag' },
    expectError: true,
  },
  {
    label: 'bash with a safe value',
    spec: {
      name: 'sh_tool',
      description: 'bash fixture',
      mode: 'bash',
      command: 'printf "%s\\n" "$@"',
      args: [{ arg: 'value' }],
      parameters: { value: { type: 'string', required: true } },
    },
    values: { value: 'hello' },
  },
  {
    label: 'bash with a leading-dash value allowed per binding',
    spec: {
      name: 'sh_tool',
      description: 'bash fixture',
      mode: 'bash',
      command: 'printf "%s\\n" "$@"',
      args: [{ arg: 'value', allowLeadingDash: true }],
      parameters: { value: { type: 'string', required: true } },
    },
    values: { value: '-n' },
  },
  {
    label: 'stdin json for powershell',
    spec: {
      name: 'ps_tool',
      description: 'powershell fixture',
      mode: 'powershell',
      command: '$p = [Console]::In.ReadToEnd(); $p',
      args: [{ stdin: 'json' }],
      parameters: { drive: { type: 'string' } },
    },
    values: { drive: 'C' },
  },
  {
    label: 'powershell refuses positional arguments',
    // The host validator rejects this definition outright, so it never reaches
    // the compiler. Compare against a hand-built plan instead: the page must
    // draw the same refusal for the same input.
    spec: {
      name: 'ps_tool',
      description: 'powershell fixture',
      mode: 'powershell',
      command: 'Get-Date',
      args: [{ arg: 'drive' }],
      parameters: { drive: { type: 'string' } },
    },
    plan: {
      name: 'ps_tool',
      mode: 'powershell',
      executable: 'pwsh',
      command: 'Get-Date',
      flags: ['-NoLogo', '-NoProfile', '-NonInteractive'],
      args: [{ arg: 'drive' }],
    },
    values: { drive: 'C' },
    expectError: true,
  },
  {
    label: 'stdin raw writes the scalar verbatim',
    spec: {
      ...BASE,
      args: [{ arg: 'body', stdin: 'raw' }],
      parameters: { body: { type: 'string' } },
    },
    values: { body: 'line1\nline2' },
  },
  {
    label: 'script mode puts the interpreter first',
    spec: {
      name: 'py_tool',
      description: 'script fixture',
      mode: 'script',
      interpreter: '/usr/bin/python',
      script: '/tmp/tool.py',
      args: [{ literal: '--json' }],
    },
    values: {},
  },
]

test('the page previews the same argv the host would spawn', async () => {
  const internals = clientInternals()
  const { compile } = await import('../src/compiler/compile.js')
  const { buildInvocation } = await import('../src/compiler/bindings.js')

  for (const fixture of PARITY_CASES) {
    let plan = fixture.plan
    if (plan === undefined) {
      const compiled = compile({ tools: [fixture.spec] })
      const entry = compiled.tools.get(fixture.spec.name)
      assert.ok(entry, `${fixture.label}: the fixture must compile`)
      plan = entry.plan
    }
    const expected = buildInvocation(plan, fixture.values)
    const actual = internals.previewInvocation(fixture.spec, fixture.values)
    // Cross-realm objects: compare data, not prototypes.
    assert.equal(
      JSON.stringify({ ok: actual.ok, argv: actual.argv, stdin: actual.stdin }),
      JSON.stringify({ ok: expected.ok, argv: expected.argv, stdin: expected.stdin }),
      `preview drifted from buildInvocation for: ${fixture.label}`,
    )
    if (fixture.expectError) assert.equal(actual.ok, false, fixture.label)
  }
})

test('the page reports the same problems the host validator would refuse', () => {
  const internals = clientInternals()
  const bad = [
    { name: 'Bad Name', description: 'x', mode: 'executable', executable: 'git', args: [] },
    { name: 'bash', description: 'x', mode: 'executable', executable: 'git', args: [] },
    { name: 'no_desc', description: '', mode: 'executable', executable: 'git', args: [] },
    { name: 'no_target', description: 'x', mode: 'executable', args: [] },
    {
      name: 'dangling',
      description: 'x',
      mode: 'executable',
      executable: 'git',
      args: [{ arg: 'missing' }],
      parameters: {},
    },
    {
      name: 'switch_on_string',
      description: 'x',
      mode: 'executable',
      executable: 'git',
      args: [{ flag: 'word', as: '--word' }],
      parameters: { word: { type: 'string' } },
    },
    {
      name: 'too_slow',
      description: 'x',
      mode: 'executable',
      executable: 'git',
      timeoutMs: 900000,
      args: [],
    },
  ]
  const issues = internals.collectIssues(bad)
  const messages = issues.map((issue) => `${issue.toolName}:${issue.path}`)
  assert.ok(messages.includes('Bad Name:name'), 'name pattern')
  assert.ok(messages.includes('bash:name'), 'reserved name')
  assert.ok(messages.includes('no_desc:description'), 'empty description')
  assert.ok(messages.includes('no_target:executable'), 'missing executable')
  assert.ok(messages.includes('dangling:args[0]'), 'undeclared parameter')
  assert.ok(messages.includes('switch_on_string:args[0]'), 'switch on a non-boolean')
  assert.ok(messages.includes('too_slow:timeoutMs'), 'timeout range')
  assert.ok(
    internals.collectIssues([{
      name: 'relative_cwd',
      description: 'x',
      mode: 'executable',
      executable: 'git',
      cwd: 'sub/dir',
      args: [],
    }]).some((issue) => issue.path === 'cwd'),
    'a relative cwd is refused',
  )

  // And a clean definition produces no error at all.
  const clean = internals.collectIssues([{
    name: 'ok_tool',
    description: 'x',
    mode: 'executable',
    executable: 'git',
    args: [{ literal: 'status' }],
  }])
  assert.equal(clean.length, 0, 'a valid definition draws no complaints')
})

test('the page tracks unsaved edits without touching the saved snapshot', () => {
  // The dirty chip and the disabled Save button both hinge on this comparison
  // existing; a page that silently allowed "save" with no changes would bump
  // the revision for nothing.
  assert.match(source, /const dirty = !sameJson\(config, baseline\)/u)
  assert.match(source, /setSaved\(clone\(config\)\)/u)
})

test('an edit reaches the draft the page saves', () => {
  // ToolCard calls onChange(next) with a single argument, so binding it to
  // setTool(index, next) directly made every edit a no-op: index received the
  // tool object, nothing matched, and the dirty flag never flipped.
  assert.match(source, /onChange: \(next\) => setTool\(index, next\)/u)
  assert.doesNotMatch(source, /onChange: setTool,/u)
})

test('the retired knobs are gone from the form', () => {
  // Enum lists, script trust and SHA-256 were removed: the author owns the tool,
  // and a string parameter needs no vocabulary of allowed values.
  assert.doesNotMatch(source, /scriptTrust|scriptSha256/u)
  assert.doesNotMatch(source, /parameter\.enum/u)
})

test('the sandbox selector from the old mock is gone', () => {
  // The plugin runs tools with the harness's own privileges; a sandbox field in
  // the form would either be a lie or an unreachable setting.
  assert.doesNotMatch(source, /workspace-write|danger-full-access|read-only/u)
})
