/**
 * Browser half of dsh-custom-tools.
 *
 * It mounts one `settings.section` page and talks to the host exclusively
 * through the shipped `ctx.remote.settings` namespace — `describe()` to read
 * this row's volatile config and `mutate()` to write it. There is no private
 * HTTP bridge and no dependency on host runtime code: everything the page
 * knows about a tool is the JSON the settings document already contains.
 *
 * Two consequences shape the whole design:
 *
 *   - The page cannot *run* anything. There is no client→host call channel for
 *     arbitrary plugins, so `preview` and `test` stay in the `/custom-tools`
 *     command family. The argv strip below is a local projection of the same
 *     binding rules; `test/client.test.js` proves it agrees with
 *     `src/compiler/bindings.js`, so it cannot quietly start lying.
 *   - The page is the only place a broken tool definition becomes visible
 *     before it fails at call time, so it validates on every keystroke and
 *     says which field is wrong.
 *
 * Writes carry the revision they were read at, so a browser tab that was open
 * while something else saved gets a conflict instead of silently reverting it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-custom-tools',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Settings namespace == the profile row id declared in cordis.patch.yml. */
    const NS = 'custom-tools'

    // ------------------------------------------------------------------ theme

    /**
     * Only alias tokens, never raw palette values: the page has to look native
     * in both light and dark themes, and the aliases are what the harness
     * itself themes.
     */
    const C = {
      borderL1: 'var(--dsw-alias-border-l1, var(--dsw-alias-border-l2, rgba(127,127,127,0.22)))',
      borderL2: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      textPrimary: 'var(--dsw-alias-label-primary, inherit)',
      textSecondary: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
      textTertiary: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.7))',
      bg1: 'var(--dsw-alias-bg-layer-1, transparent)',
      bg2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
      bg3: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.12))',
      brand: 'var(--dsw-alias-brand-primary, #3b7ddd)',
      error: 'var(--dsw-alias-state-error, #d33)',
      warning: 'var(--dsw-alias-state-warning, #c98a00)',
      success: 'var(--dsw-alias-state-success, #2f9e5f)',
      radius: 'var(--dsw-alias-radius-l2, 8px)',
      radiusSmall: 'var(--dsw-alias-radius-l1, 6px)',
      mono: '12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    const S = {
      wrap: { display: 'grid', gap: 12, maxWidth: 860 },
      header: { display: 'grid', gap: 4 },
      titleRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 15, fontWeight: 600, color: C.textPrimary },
      lead: { margin: 0, fontSize: 12, color: C.textSecondary, lineHeight: 1.6 },
      toolbar: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      card: {
        display: 'grid',
        gap: 0,
        border: `1px solid ${C.borderL1}`,
        borderRadius: C.radius,
        background: C.bg1,
        overflow: 'hidden',
      },
      cardOpen: { borderColor: C.borderL2 },
      cardHead: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '9px 12px',
        cursor: 'pointer',
        userSelect: 'none',
      },
      twist: {
        width: 12,
        fontSize: 9,
        color: C.textTertiary,
        transition: 'transform .12s',
      },
      cardName: { font: C.mono, fontWeight: 600, color: C.textPrimary },
      cardBody: { padding: '2px 12px 12px', borderTop: `1px solid ${C.borderL1}` },
      panel: { padding: '10px 0', borderBottom: `1px solid ${C.borderL1}` },
      panelLast: { padding: '10px 0 0', borderBottom: 'none' },
      panelHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
      panelTitle: { fontSize: 12, fontWeight: 600, color: C.textSecondary, letterSpacing: '.02em' },
      panelMeta: { fontSize: 11, color: C.textTertiary },
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 },
      grid3: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 },
      field: { display: 'grid', gap: 3, fontSize: 12, minWidth: 0 },
      label: { fontSize: 11, color: C.textTertiary },
      hint: { fontSize: 11, color: C.textTertiary, lineHeight: 1.5 },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        minHeight: 28,
        padding: '3px 8px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL1}`,
        background: C.bg3,
        color: 'inherit',
        font: 'inherit',
        outline: 'none',
      },
      monoInput: {
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        minHeight: 28,
        padding: '3px 8px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL1}`,
        background: C.bg3,
        color: 'inherit',
        font: C.mono,
        outline: 'none',
      },
      textarea: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 64,
        padding: '5px 8px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL1}`,
        background: C.bg3,
        color: 'inherit',
        font: C.mono,
        resize: 'vertical',
        outline: 'none',
      },
      button: {
        boxSizing: 'border-box',
        minHeight: 28,
        padding: '0 10px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL2}`,
        background: C.bg2,
        color: C.textPrimary,
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      buttonPrimary: {
        boxSizing: 'border-box',
        minHeight: 28,
        padding: '0 12px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.brand}`,
        background: C.brand,
        color: '#fff',
        font: 'inherit',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
      },
      buttonSmall: {
        boxSizing: 'border-box',
        minHeight: 24,
        padding: '0 8px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL2}`,
        background: 'transparent',
        color: C.textSecondary,
        font: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      },
      buttonDanger: {
        boxSizing: 'border-box',
        minHeight: 24,
        padding: '0 8px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL1}`,
        background: 'transparent',
        color: C.error,
        font: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      },
      disabled: { opacity: 0.5, cursor: 'default' },
      chip: {
        fontSize: 11,
        color: C.textTertiary,
        border: `1px solid ${C.borderL1}`,
        borderRadius: 999,
        padding: '1px 8px',
        background: C.bg2,
        whiteSpace: 'nowrap',
      },
      chipDirty: { color: C.warning, borderColor: C.warning, background: 'transparent' },
      chipBad: { color: C.error, borderColor: C.error, background: 'transparent' },
      chipOk: { color: C.success, borderColor: C.success, background: 'transparent' },
      banner: {
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '8px 10px',
        borderRadius: C.radius,
        border: `1px solid ${C.borderL2}`,
        background: C.bg2,
        fontSize: 12,
        lineHeight: 1.6,
      },
      bannerOk: { borderColor: C.success },
      bannerBad: { borderColor: C.error },
      grow: { flex: 1 },
      status: { fontSize: 12, color: C.textTertiary },
      error: { fontSize: 12, color: C.error },
      empty: {
        display: 'grid',
        gap: 8,
        justifyItems: 'start',
        padding: '22px 16px',
        fontSize: 13,
        color: C.textSecondary,
        border: `1px dashed ${C.borderL2}`,
        borderRadius: C.radius,
      },
      // segments
      seg: { display: 'inline-flex', border: `1px solid ${C.borderL1}`, borderRadius: C.radiusSmall, overflow: 'hidden' },
      segButton: {
        font: 'inherit',
        fontSize: 11.5,
        padding: '3px 10px',
        border: 'none',
        borderRight: `1px solid ${C.borderL1}`,
        background: 'transparent',
        color: C.textTertiary,
        cursor: 'pointer',
      },
      segButtonOn: { background: C.bg3, color: C.brand, fontWeight: 600 },
      // parameter table
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: {
        textAlign: 'left',
        fontWeight: 500,
        fontSize: 10.5,
        color: C.textTertiary,
        textTransform: 'uppercase',
        letterSpacing: '.04em',
        padding: '0 4px 4px',
      },
      td: { padding: '2px 4px', verticalAlign: 'top' },
      // argv strip
      argv: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        padding: 8,
        border: `1px solid ${C.borderL1}`,
        borderRadius: C.radiusSmall,
        background: C.bg2,
      },
      token: {
        font: C.mono,
        fontSize: 11.5,
        padding: '1px 6px',
        border: `1px solid ${C.borderL1}`,
        borderRadius: 4,
        background: C.bg1,
        color: C.textPrimary,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        maxWidth: '100%',
      },
      tokenExe: { color: C.brand, borderColor: C.brand, fontWeight: 600 },
      tokenStdin: { color: C.warning, borderColor: C.warning },
      tokenArrow: { font: C.mono, color: C.textTertiary, alignSelf: 'center' },
      // diagnostics
      issues: { display: 'grid', gap: 2, margin: 0, padding: 0, listStyle: 'none', fontSize: 11.5 },
      issueError: { display: 'flex', gap: 6, color: C.error },
      issueWarn: { display: 'flex', gap: 6, color: C.warning },
      issueOk: { display: 'flex', gap: 6, color: C.success },
      bindingRow: {
        display: 'grid',
        gap: 6,
        padding: '6px 0',
        borderBottom: `1px dashed ${C.borderL1}`,
      },
      bindingMain: { display: 'grid', gridTemplateColumns: 'minmax(88px, 120px) 1fr auto', gap: 6, alignItems: 'center' },
      bindingAdvanced: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 6 },
      checkRow: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: C.textSecondary },
      sampleRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 },
    }

    // -------------------------------------------------------------- constants

    const MODES = ['executable', 'script', 'bash', 'powershell']
    const MODE_LABEL = {
      executable: '可执行文件',
      script: '脚本',
      bash: 'Bash',
      powershell: 'PowerShell',
    }
    const APPROVALS = ['inherit', 'always']
    const APPROVAL_LABEL = {
      inherit: '跟随会话（inherit）',
      always: '每次都要批准（always）',
    }
    const CONCURRENCY = ['exclusive', 'parallel']
    const PARSES = ['text', 'json']
    const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'array']
    const PARAM_ITEMS = ['string', 'number', 'integer', 'boolean']
    const BINDING_KINDS = ['literal', 'arg', 'flag', 'stdin-raw', 'stdin-json']
    const BINDING_LABEL = {
      literal: '固定值',
      arg: '参数',
      flag: '开关',
      'stdin-raw': 'stdin（原始文本）',
      'stdin-json': 'stdin（JSON）',
    }

    /**
     * Names the runtime already owns. Duplicating one of these makes
     * `tools.register` throw, so the page refuses them before save.
     */
    const RESERVED = new Set([
      'bash', 'pwsh', 'shell', 'read', 'write', 'edit', 'grep', 'glob', 'task',
      'subagent', 'workflow', 'skill', 'send_message', 'send_meme', 'ask_user_question',
      'create_goal', 'update_goal', 'get_goal', 'compress', 'decompress', 'search_context',
      'acp_status', 'present', 'run_code', 'custom_tools', 'todo_write', 'weather',
      'web_search', 'web_fetch', 'platform_search', 'domain_search', 'research',
    ])

    const POWERSHELL_FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive']
    const NAME_PATTERN = /^[a-z][a-z0-9_]{0,40}$/u
    const PARAM_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
    const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

    const TEMPLATES = {
      executable: {
        name: 'my_tool',
        title: '',
        description: '一句话说明这个工具做什么，以及什么时候该用它。',
        mode: 'executable',
        executable: 'git',
        args: [{ literal: 'status' }, { literal: '--short' }],
        parameters: {},
        output: { parse: 'text' },
      },
      script: {
        name: 'my_script',
        title: '',
        description: '用解释器运行一个脚本文件，参数作为 argv 传进去。',
        mode: 'script',
        interpreter: 'python',
        script: 'C:/Users/me/tools/report.py',
        args: [],
        parameters: {},
        output: { parse: 'text' },
      },
      bash: {
        name: 'my_bash',
        title: '',
        description: '运行一段固定的 bash 脚本；模型参数只经 $@ 传入位置参数。',
        mode: 'bash',
        command: 'printf "%s\\n" "$@"',
        args: [{ arg: 'value' }],
        parameters: { value: { type: 'string', required: true } },
        output: { parse: 'text' },
      },
      powershell: {
        name: 'my_pwsh',
        title: '',
        description: '用 PowerShell 运行一段固定脚本；参数从 stdin 的 JSON 读取。',
        mode: 'powershell',
        command: '$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json; $payload | ConvertTo-Json -Compress',
        args: [{ stdin: 'json' }],
        parameters: { value: { type: 'string' } },
        output: { parse: 'text' },
      },
    }

    // ---------------------------------------------------------------- helpers

    const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
    const asString = (value, fallback = '') => (typeof value === 'string' ? value : fallback)
    const asNumber = (value, fallback) =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback

    function clone(value) {
      if (value === undefined) return undefined
      return JSON.parse(JSON.stringify(value))
    }

    /** Structural equality through canonical JSON; `undefined` keys drop out. */
    function sameJson(a, b) {
      return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
    }

    function tryParseJson(text) {
      try {
        return { ok: true, value: JSON.parse(text) }
      } catch {
        return { ok: false }
      }
    }

    /** Unwrap the remote result envelope; a dead socket surfaces as undefined. */
    function unwrap(result) {
      if (result === undefined || result === null) {
        return { ok: false, message: '服务没有返回结果（可能已断开连接）' }
      }
      if (result.ok === false) {
        const error = result.error ?? {}
        return { ok: false, message: `${asString(error.code, 'error')}: ${asString(error.message)}` }
      }
      return { ok: true, value: result.ok === true ? result.value : result }
    }

    /** `describe()` returns a list, or occasionally a namespace map. */
    function namespaceList(value) {
      const bag = value?.namespaces ?? value?.views ?? value
      if (Array.isArray(bag)) return bag
      if (isObject(bag)) return Object.values(bag)
      return []
    }

    function findNamespace(value, ns) {
      for (const view of namespaceList(value)) {
        if (!isObject(view)) continue
        if (view.ns === ns || view.namespace === ns || view.id === ns) return view
      }
      return undefined
    }

    const EMPTY_CONFIG = { tools: [], deferLoading: false }

    function readConfig(value) {
      const source = isObject(value) ? value : {}
      return {
        tools: Array.isArray(source.tools) ? source.tools.filter(isObject).map((tool) => clone(tool)) : [],
        deferLoading: source.deferLoading === true,
      }
    }

    // ----------------------------------------------------- argv projection

    /**
     * Mirror of `src/compiler/compile.js` for the fields `buildInvocation`
     * reads. Kept separate from the caller so `previewInvocation` can be
     * exercised on its own.
     */
    function planOf(spec) {
      const mode = asString(spec.mode, 'executable')
      return {
        mode,
        executable: spec.executable
          ?? (mode === 'bash' ? 'bash' : mode === 'powershell' ? 'pwsh' : undefined),
        interpreter: spec.interpreter,
        script: spec.script,
        command: spec.command,
        flags: mode === 'powershell' ? [...POWERSHELL_FLAGS] : [],
        args: Array.isArray(spec.args) ? spec.args : [],
      }
    }

    const NUL = '\u0000'

    function formatScalar(value) {
      if (typeof value === 'string') return value
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      if (typeof value === 'number') return String(value)
      return String(value)
    }

    function guardValue(binding, value) {
      if (value.includes(NUL)) return `参数 ${binding.arg ?? binding.flag} 的值不能包含 NUL 字节`
      if (!binding.allowLeadingDash && value.startsWith('-')) {
        return `参数 ${binding.arg ?? binding.flag} 的值以 - 开头，会被当成命令选项`
      }
      if (!binding.allowResponseFile && value.startsWith('@')) {
        return `参数 ${binding.arg ?? binding.flag} 的值以 @ 开头，可能被当作 response file`
      }
      return undefined
    }

    function isEmptyValue(value) {
      return value === undefined || value === null || value === ''
        || (Array.isArray(value) && value.length === 0)
    }

    function emitArrayValue(binding, items, out, errors) {
      if (binding.repeat) {
        for (const item of items) {
          const text = formatScalar(item)
          const problem = guardValue(binding, text)
          if (problem) {
            errors.push(problem)
            return
          }
          out.push(`${binding.prefix ?? ''}${text}${binding.suffix ?? ''}`)
        }
        return
      }
      const joined = binding.join === undefined
        ? items.map(formatScalar).join(' ')
        : items.map(formatScalar).join(binding.join)
      const problem = items.length > 0 ? guardValue(binding, String(items[0])) : undefined
      if (problem) {
        errors.push(problem)
        return
      }
      out.push(`${binding.prefix ?? ''}${joined}${binding.suffix ?? ''}`)
    }

    /**
     * Byte-for-byte the same rules as `src/compiler/bindings.js`
     * (`buildInvocation`), minus the preflight-resolved absolute paths — the
     * page shows what the author configured. `test/client.test.js` compares
     * this against the real compiler for a matrix of definitions, so a change
     * on one side cannot silently desynchronise the preview from the spawn.
     */
    function previewInvocation(spec, values = {}) {
      const plan = planOf(spec)
      const errors = []
      const positional = []
      let stdin

      for (const binding of plan.args) {
        if (!isObject(binding)) continue

        if (binding.stdin === 'json') {
          stdin = { kind: 'json', text: JSON.stringify(values) }
          continue
        }

        if (binding.literal !== undefined) {
          positional.push(asString(binding.literal))
          continue
        }

        if (binding.flag !== undefined) {
          if (values[binding.flag] !== true) continue
          const as = Array.isArray(binding.as) ? binding.as : [binding.as]
          for (const element of as) {
            if (typeof element !== 'string') {
              errors.push(`flag ${binding.flag} 的 as 必须是字符串`)
              continue
            }
            positional.push(element)
          }
          continue
        }

        if (binding.arg === undefined) {
          errors.push('arg 条目既没有 literal/flag 也没有 arg')
          continue
        }

        const raw = values[binding.arg]

        if (binding.stdin === 'raw') {
          if (raw === undefined || raw === null) {
            if (binding.omitIfEmpty) continue
            errors.push(`参数 ${binding.arg} 没有值可写入 stdin`)
            continue
          }
          if (typeof raw === 'object') {
            errors.push('stdin: "raw" 只接受标量或数组，不接受对象')
            continue
          }
          stdin = {
            kind: 'raw',
            text: Array.isArray(raw) ? raw.map(formatScalar).join('\n') : formatScalar(raw),
          }
          continue
        }

        if (isEmptyValue(raw)) {
          if (binding.omitIfEmpty) continue
          if (raw === undefined) continue
          if (Array.isArray(raw)) continue
          positional.push(`${binding.prefix ?? ''}${binding.suffix ?? ''}`)
          continue
        }

        if (binding.json) {
          positional.push(`${binding.prefix ?? ''}${JSON.stringify(raw)}${binding.suffix ?? ''}`)
          continue
        }

        if (Array.isArray(raw)) {
          emitArrayValue(binding, raw, positional, errors)
          continue
        }

        const text = formatScalar(raw)
        const problem = guardValue(binding, text)
        if (problem) {
          errors.push(problem)
          continue
        }
        positional.push(`${binding.prefix ?? ''}${text}${binding.suffix ?? ''}`)
      }

      if (errors.length > 0) return { ok: false, errors }

      let argv
      if (plan.mode === 'bash') {
        argv = [plan.executable, '-c', plan.command, 'custom-tool', ...positional]
      } else if (plan.mode === 'powershell') {
        if (positional.length > 0) {
          return {
            ok: false,
            errors: ['powershell 模式不能把参数放进 argv：-Command 之后的标记会被拼进命令文本；请改用 stdin（JSON）'],
          }
        }
        argv = [plan.executable, ...plan.flags, '-Command', plan.command]
      } else if (plan.mode === 'script') {
        argv = [plan.interpreter, plan.script, ...positional]
      } else {
        argv = [plan.executable, ...positional]
      }

      const cleaned = []
      for (const element of argv) {
        if (typeof element !== 'string') return { ok: false, errors: ['argv 元素必须是字符串'] }
        if (element.includes(NUL)) return { ok: false, errors: ['argv 元素不能包含 NUL 字节'] }
        cleaned.push(element)
      }

      return stdin === undefined ? { ok: true, argv: cleaned } : { ok: true, argv: cleaned, stdin }
    }

    /** A plausible value per declared parameter, so the strip shows its shape. */
    function sampleValue(spec) {
      if (!isObject(spec)) return '<value>'
      if (spec.default !== undefined && spec.default !== '') {
        const parsed = tryParseJson(spec.default)
        if (parsed.ok) return parsed.value
      }
      if (spec.type === 'boolean') return false
      if (spec.type === 'number' || spec.type === 'integer') return 0
      if (spec.type === 'array') return []
      if (Array.isArray(spec.enum) && spec.enum.length > 0) return spec.enum[0]
      return '<value>'
    }

    function sampleValues(spec, overrides = {}) {
      const parameters = isObject(spec.parameters) ? spec.parameters : {}
      const values = {}
      for (const [name, parameter] of Object.entries(parameters)) {
        values[name] = Object.prototype.hasOwnProperty.call(overrides, name)
          ? overrides[name]
          : sampleValue(parameter)
      }
      return values
    }

    // ------------------------------------------------------------ validation

    /**
     * The page's own checks. They deliberately mirror `src/config/validate.js`
     * but only where a person editing the form benefits: the host re-validates
     * on save, and the page cannot see host diagnostics, so anything it claims
     * here must be checkable locally.
     */
    function collectIssues(tools) {
      const issues = []
      const seen = new Map()

      tools.forEach((tool, index) => {
        const name = asString(tool.name)
        const at = (path, message, severity = 'error') => issues.push({
          tool: index,
          toolName: name,
          path,
          message,
          severity,
        })

        if (name === '') at('name', '工具名为空')
        else if (!NAME_PATTERN.test(name)) at('name', '工具名须匹配 ^[a-z][a-z0-9_]{0,40}$')
        else if (RESERVED.has(name)) at('name', `${name} 是运行时保留名`)
        else if (seen.has(name)) at('name', `与第 ${seen.get(name) + 1} 个工具重名，后一个不会被加载`)
        else seen.set(name, index)

        if (asString(tool.description).trim() === '') at('description', '描述为空（模型靠它决定是否调用）')

        const timeout = asNumber(tool.timeoutMs, 120000)
        if (timeout < 1000 || timeout > 600000) at('timeoutMs', '超时须在 1000 – 600000 毫秒之间')

        const mode = asString(tool.mode, 'executable')
        if (!MODES.includes(mode)) at('mode', `未知模式 ${mode}`)
        if (mode === 'executable' && asString(tool.executable).trim() === '') at('executable', '未填可执行文件')
        if (mode === 'script') {
          if (asString(tool.interpreter).trim() === '') at('interpreter', '未填解释器')
          if (asString(tool.script).trim() === '') at('script', '未填脚本路径')
        }
        if ((mode === 'bash' || mode === 'powershell') && asString(tool.command).trim() === '') {
          at('command', '脚本文本为空')
        }

        const parameters = isObject(tool.parameters) ? tool.parameters : {}
        for (const [paramName, parameter] of Object.entries(parameters)) {
          if (!PARAM_PATTERN.test(paramName)) at(`parameters.${paramName}`, '参数名须匹配 ^[A-Za-z_][A-Za-z0-9_]*$')
          if (!isObject(parameter)) {
            at(`parameters.${paramName}`, '参数说明必须是一个对象')
            continue
          }
          const type = asString(parameter.type, 'string')
          if (!PARAM_TYPES.includes(type)) at(`parameters.${paramName}.type`, `未知类型 ${type}`)
          if (type === 'array' && parameter.items !== undefined && !PARAM_ITEMS.includes(parameter.items)) {
            at(`parameters.${paramName}.items`, '数组元素类型须是 string/number/integer/boolean')
          }
          if (parameter.enum !== undefined) {
            if (!Array.isArray(parameter.enum)) at(`parameters.${paramName}.enum`, 'enum 必须是数组')
            else if (parameter.enum.length > 0 && type !== 'string') {
              at(`parameters.${paramName}.enum`, '只有 string 类型能声明 enum')
            }
          }
          if (parameter.default !== undefined && parameter.default !== '') {
            if (typeof parameter.default !== 'string') {
              at(`parameters.${paramName}.default`, '默认值要以 JSON 文本保存')
            } else if (!tryParseJson(parameter.default).ok) {
              at(`parameters.${paramName}.default`, '默认值不是合法 JSON')
            }
          }
          if (typeof parameter.min === 'number' && typeof parameter.max === 'number'
            && parameter.min > parameter.max) {
            at(`parameters.${paramName}`, 'min 不能大于 max')
          }
        }

        const bindings = Array.isArray(tool.args) ? tool.args : []
        let stdinCount = 0
        bindings.forEach((binding, bindingIndex) => {
          const where = `args[${bindingIndex}]`
          if (!isObject(binding)) {
            at(where, '绑定必须是对象')
            return
          }
          if (binding.stdin === 'json') {
            stdinCount += 1
            if (stdinCount > 1) at(where, '最多只能有一条 stdin JSON 绑定')
            if (binding.arg !== undefined || binding.literal !== undefined || binding.flag !== undefined) {
              at(where, 'stdin JSON 条目不能同时声明 literal/arg/flag')
            }
            return
          }
          const kinds = ['literal', 'arg', 'flag'].filter((key) => binding[key] !== undefined)
          if (kinds.length !== 1) {
            at(where, '每条绑定必须有且只有 literal / arg / flag 之一')
            return
          }
          if (binding.flag !== undefined) {
            const spec = parameters[binding.flag]
            if (!isObject(spec)) at(where, `开关引用了未声明的参数 ${binding.flag}`)
            else if (spec.type !== 'boolean') at(where, `开关必须引用 boolean 参数，${binding.flag} 是 ${spec.type}`)
            if (binding.as === undefined) at(where, '开关要写 as：值为 true 时插入的 argv 元素')
            if (binding.stdin !== undefined) at(where, '开关不能同时使用 stdin')
            return
          }
          if (binding.literal !== undefined) {
            if (binding.arg !== undefined) at(where, 'literal 与 arg 不能同时出现')
            return
          }
          // arg
          const spec = parameters[binding.arg]
          if (!isObject(spec)) at(where, `参数 ${binding.arg} 未在 parameters 中声明`)
          else if (spec.type === 'boolean') {
            at(where, `boolean 参数应该用 flag 绑定，而不是 arg`)
          }
          if (binding.repeat === true || binding.join !== undefined) {
            if (isObject(spec) && spec.type !== 'array') at(where, 'repeat / join 只能用于 array 参数')
            if (binding.repeat === true && binding.join !== undefined) at(where, 'repeat 与 join 不能同时使用')
          }
          if (binding.stdin === 'raw' && binding.omitIfEmpty !== true && asString(binding.arg) === '') {
            at(where, 'stdin: raw 需要 arg')
          }
        })

        if (bindings.some((binding) => isObject(binding) && binding.arg !== undefined
          && !Object.prototype.hasOwnProperty.call(parameters, binding.arg)
          && parameters[binding.arg] === undefined)) {
          // already reported per binding; kept for readability of intent
        }

        const output = isObject(tool.output) ? tool.output : {}
        const parse = asString(output.parse, 'text')
        if (!PARSES.includes(parse)) at('output.parse', `未知输出解析方式 ${parse}`)
        if (parse === 'json' && typeof output.schema === 'string' && output.schema.trim() !== '') {
          if (!tryParseJson(output.schema).ok) at('output.schema', '输出 schema 不是合法 JSON')
        }

        if (mode === 'powershell' && bindings.some((binding) => isObject(binding)
          && binding.stdin !== 'json' && (binding.arg !== undefined || binding.flag !== undefined))) {
          at('args', 'powershell 模式只能把参数放进 stdin（JSON）：-Command 之后的标记不进 $args')
        }
      })

      return issues
    }

    function issuesFor(issues, index) {
      return issues.filter((issue) => issue.tool === index)
    }

    // -------------------------------------------------------------- controls

    function Chip({ children, tone }) {
      const style = tone === 'dirty' ? { ...S.chip, ...S.chipDirty }
        : tone === 'bad' ? { ...S.chip, ...S.chipBad }
          : tone === 'ok' ? { ...S.chip, ...S.chipOk }
            : S.chip
      return h('span', { style }, children)
    }

    function Banner({ tone, title, children, action }) {
      const style = tone === 'ok' ? { ...S.banner, ...S.bannerOk }
        : tone === 'bad' ? { ...S.banner, ...S.bannerBad }
          : S.banner
      return h('div', { style },
        h('div', { style: S.grow },
          title ? h('strong', null, title, ' ') : null,
          children),
        action || null)
    }

    function Field({ label, hint, children }) {
      return h('label', { style: S.field },
        h('span', { style: S.label }, label),
        children,
        hint ? h('span', { style: S.hint }, hint) : null)
    }

    function TextInput({ value, onChange, disabled, placeholder, mono }) {
      return h('input', {
        style: mono ? S.monoInput : S.input,
        value,
        disabled,
        placeholder,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function NumberInput({ value, onChange, disabled, placeholder, min, max }) {
      return h('input', {
        type: 'number',
        min,
        max,
        style: S.input,
        value,
        disabled,
        placeholder,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function TextArea({ value, onChange, disabled, rows, placeholder, mono = true }) {
      return h('textarea', {
        style: mono ? { ...S.textarea, minHeight: rows ? rows * 18 : 64 } : { ...S.textarea, font: 'inherit', minHeight: rows ? rows * 18 : 64 },
        value,
        disabled,
        placeholder,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function Select({ value, options, onChange, disabled, render }) {
      return h('select', {
        style: S.input,
        value,
        disabled,
        onChange: (event) => onChange(event.target.value),
      }, options.map((option) => h('option', { key: option, value: option }, render ? render(option) : option)))
    }

    function Button({ children, onClick, disabled, kind, title }) {
      const base = kind === 'primary' ? S.buttonPrimary
        : kind === 'small' ? S.buttonSmall
          : kind === 'danger' ? S.buttonDanger
            : S.button
      return h('button', {
        type: 'button',
        style: disabled ? { ...base, ...S.disabled } : base,
        disabled,
        title,
        onClick,
      }, children)
    }

    function Checkbox({ checked, onChange, disabled, label }) {
      return h('label', { style: S.checkRow },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled,
          onChange: (event) => onChange(event.target.checked),
        }),
        label)
    }

    function Switch({ checked, onChange, disabled }) {
      // A plain checkbox keeps the platform's own focus ring and hit target;
      // the mock's sliding pill is prettier but needs pixels this page cannot
      // guarantee across themes.
      return h('input', {
        type: 'checkbox',
        checked: checked === true,
        disabled,
        title: checked ? '已启用' : '已停用',
        style: { cursor: disabled ? 'default' : 'pointer' },
        onClick: (event) => event.stopPropagation(),
        onChange: (event) => onChange(event.target.checked),
      })
    }

    function Segmented({ value, options, onChange, disabled, render }) {
      return h('span', { style: S.seg }, options.map((option, index) => h('button', {
        key: option,
        type: 'button',
        style: {
          ...S.segButton,
          ...(value === option ? S.segButtonOn : null),
          ...(index === options.length - 1 ? { borderRight: 'none' } : null),
          ...(disabled ? S.disabled : null),
        },
        disabled,
        onClick: () => onChange(option),
      }, render ? render(option) : option)))
    }

    /**
     * A JSON textarea that keeps invalid text on screen and reports why.
     *
     * The text is adopted from `value` only when that value's serialized form
     * changes (reload, template swap), so typing in a sibling field never
     * fights the editor.
     */
    function JsonField({ label, value, onChange, disabled, rows, hint }) {
      const format = (input) => JSON.stringify(input ?? null, null, 2)
      const serialized = (input) => JSON.stringify(input ?? null)
      const [text, setText] = React.useState(() => format(value))
      const [problem, setProblem] = React.useState('')
      const adopted = React.useRef(serialized(value))
      const incoming = serialized(value)
      if (incoming !== adopted.current) {
        adopted.current = incoming
        setText(format(value))
        setProblem('')
      }

      const commit = (next) => {
        setText(next)
        if (next.trim() === '') {
          setProblem('')
          adopted.current = serialized(null)
          onChange(null)
          return
        }
        try {
          const parsed = JSON.parse(next)
          adopted.current = serialized(parsed)
          setProblem('')
          onChange(parsed)
        } catch (error) {
          setProblem(error instanceof Error ? error.message : String(error))
        }
      }

      return h('div', { style: S.field },
        h('span', { style: S.label }, label),
        h(TextArea, { value: text, onChange: commit, disabled, rows, placeholder: '{}' }),
        problem
          ? h('span', { style: S.error }, `JSON 有误：${problem}`)
          : hint ? h('span', { style: S.hint }, hint) : null)
    }

    function Panel({ title, meta, action, children, last }) {
      return h('div', { style: last ? S.panelLast : S.panel },
        h('div', { style: S.panelHead },
          h('span', { style: S.panelTitle }, title),
          meta ? h('span', { style: S.panelMeta }, meta) : null,
          h('span', { style: S.grow }),
          action || null),
        children)
    }

    // ------------------------------------------------------------- argv strip

    function ArgvStrip({ spec, samples, issues }) {
      const values = sampleValues(spec, samples)
      const preview = previewInvocation(spec, values)
      const mode = asString(spec.mode, 'executable')

      if (!preview.ok) {
        return h('div', { style: S.argv },
          h('span', { style: { ...S.token, ...S.tokenStdin } }, preview.errors.join('；')))
      }

      const chips = preview.argv.map((element, index) => h('span', {
        key: `argv-${index}`,
        style: index === 0 ? { ...S.token, ...S.tokenExe } : S.token,
        title: `argv[${index}]`,
      }, element))

      const stdin = preview.stdin
        ? [h('span', { key: 'arrow', style: S.tokenArrow }, '│ stdin →'),
          h('span', {
            key: 'stdin',
            style: { ...S.token, ...S.tokenStdin },
            title: `stdin (${preview.stdin.kind})`,
          }, preview.stdin.kind === 'json'
            ? (preview.stdin.text.length > 160 ? `${preview.stdin.text.slice(0, 160)}…` : preview.stdin.text)
            : (preview.stdin.text.length > 160 ? `${preview.stdin.text.slice(0, 160)}…` : preview.stdin.text))]
        : []

      const target = mode === 'script' && !asString(spec.interpreter)
        ? h('span', { style: { ...S.token, ...S.tokenStdin } }, '未填解释器')
        : null

      return h('div', { style: S.argv },
        target,
        chips.length > 0 ? chips : h('span', { style: S.hint }, '这个工具没有任何 argv 元素，只靠宿主注入。'),
        stdin)
    }

    // ------------------------------------------------------- parameters table

    function ParametersPanel({ tool, disabled, onChange }) {
      const parameters = isObject(tool.parameters) ? tool.parameters : {}
      const names = Object.keys(parameters)

      const setParameter = (name, patch) => {
        const next = { ...parameters }
        const merged = { ...(isObject(parameters[name]) ? parameters[name] : {}), ...patch }
        for (const key of Object.keys(merged)) {
          if (merged[key] === undefined) delete merged[key]
        }
        next[name] = merged
        onChange({ parameters: next })
      }

      const removeParameter = (name) => {
        const next = { ...parameters }
        delete next[name]
        // Drop bindings that only existed to feed the removed parameter, so the
        // definition does not silently keep a dangling reference.
        const bindings = (Array.isArray(tool.args) ? tool.args : []).filter((binding) => isObject(binding)
          && binding.arg !== name && binding.flag !== name)
        onChange({ parameters: next, args: bindings })
      }

      const renameParameter = (from, to) => {
        if (to === '' || to === from) return
        if (!PARAM_PATTERN.test(to)) return
        if (Object.prototype.hasOwnProperty.call(parameters, to)) return
        const next = {}
        for (const [key, value] of Object.entries(parameters)) next[key === from ? to : key] = value
        const bindings = (Array.isArray(tool.args) ? tool.args : []).map((binding) => {
          if (!isObject(binding)) return binding
          if (binding.arg === from) return { ...binding, arg: to }
          if (binding.flag === from) return { ...binding, flag: to }
          return binding
        })
        onChange({ parameters: next, args: bindings })
      }

      const addParameter = () => {
        let index = 1
        let name = 'param1'
        while (Object.prototype.hasOwnProperty.call(parameters, name)) {
          index += 1
          name = `param${index}`
        }
        onChange({ parameters: { ...parameters, [name]: { type: 'string', required: true } } })
      }

      const rows = names.map((name) => {
        const parameter = isObject(parameters[name]) ? parameters[name] : {}
        const type = asString(parameter.type, 'string')
        return h('tr', { key: `param-${name}` },
          h('td', { style: S.td },
            h(TextInput, {
              value: name,
              disabled,
              mono: true,
              onChange: (next) => renameParameter(name, next.trim()),
            })),
          h('td', { style: S.td },
            h(Select, {
              value: type,
              options: PARAM_TYPES,
              disabled,
              onChange: (next) => setParameter(name, { type: next }),
            })),
          h('td', { style: { ...S.td, textAlign: 'center' } },
            h('input', {
              type: 'checkbox',
              checked: parameter.required === true,
              disabled,
              onChange: (event) => setParameter(name, { required: event.target.checked }),
            })),
          h('td', { style: S.td },
            h(TextInput, {
              value: asString(parameter.description),
              disabled,
              placeholder: '给模型看的说明',
              onChange: (next) => setParameter(name, { description: next }),
            })),
          h('td', { style: S.td },
            type === 'string'
              ? h(TextInput, {
                value: Array.isArray(parameter.enum) ? parameter.enum.join(', ') : '',
                disabled,
                mono: true,
                placeholder: '可选：a, b, c',
                onChange: (next) => {
                  const values = next.split(',').map((item) => item.trim()).filter(Boolean)
                  setParameter(name, { enum: values.length > 0 ? values : undefined })
                },
              })
              : h('span', { style: S.hint }, type === 'array' ? '值以数组形式传入' : '')),
          h('td', { style: { ...S.td, textAlign: 'right' } },
            h(Button, { kind: 'danger', disabled, onClick: () => removeParameter(name) }, '×')))
      })

      return h(Panel, {
        title: '参数',
        meta: names.length > 0 ? `${names.length} 个` : '尚未声明',
        action: h(Button, { kind: 'small', disabled, onClick: addParameter }, '＋ 参数'),
      },
      names.length === 0
        ? h('span', { style: S.hint }, '模型能填的字段都在这里声明；不声明参数的工具有固定行为。')
        : h('table', { style: S.table },
          h('thead', null, h('tr', null,
            h('th', { style: S.th }, '名称'),
            h('th', { style: S.th }, '类型'),
            h('th', { style: { ...S.th, textAlign: 'center' } }, '必填'),
            h('th', { style: S.th }, '说明'),
            h('th', { style: S.th }, '枚举 / 备注'),
            h('th', { style: S.th }, ''))),
          h('tbody', null, rows)))
    }

    // ------------------------------------------------------- bindings editor

    function bindingKind(binding) {
      if (!isObject(binding)) return 'literal'
      if (binding.stdin === 'json') return 'stdin-json'
      if (binding.flag !== undefined) return 'flag'
      if (binding.arg !== undefined) return binding.stdin === 'raw' ? 'stdin-raw' : 'arg'
      return 'literal'
    }

    /** Rewrite one binding as the chosen kind, dropping fields that no longer apply. */
    function rebind(binding, kind, parameters) {
      const firstParam = Object.keys(parameters)[0] ?? ''
      const booleanParam = Object.entries(parameters)
        .find(([, spec]) => isObject(spec) && spec.type === 'boolean')?.[0] ?? firstParam
      if (kind === 'literal') return { literal: asString(binding?.literal, '') }
      if (kind === 'stdin-json') return { stdin: 'json' }
      if (kind === 'stdin-raw') return { arg: asString(binding?.arg, firstParam), stdin: 'raw' }
      if (kind === 'flag') {
        return {
          flag: asString(binding?.flag, booleanParam),
          as: binding?.as ?? `--${asString(binding?.flag, booleanParam)}`.replace(/_/g, '-'),
        }
      }
      return { arg: asString(binding?.arg, firstParam) }
    }

    function BindingsPanel({ tool, disabled, onChange }) {
      const parameters = isObject(tool.parameters) ? tool.parameters : {}
      const paramNames = Object.keys(parameters)
      const bindings = Array.isArray(tool.args) ? tool.args : []
      const mode = asString(tool.mode, 'executable')

      const replace = (index, next) => {
        const list = bindings.map((binding, i) => (i === index ? next : binding))
        onChange({ args: list })
      }
      const remove = (index) => onChange({ args: bindings.filter((_, i) => i !== index) })
      const move = (index, delta) => {
        const target = index + delta
        if (target < 0 || target >= bindings.length) return
        const list = [...bindings]
        const [item] = list.splice(index, 1)
        list.splice(target, 0, item)
        onChange({ args: list })
      }
      const add = (kind) => onChange({
        args: [...bindings, rebind({}, kind, parameters)],
      })

      const rows = bindings.map((binding, index) => {
        const kind = bindingKind(binding)
        const patch = (next) => {
          const merged = { ...binding, ...next }
          for (const key of Object.keys(merged)) {
            if (merged[key] === undefined) delete merged[key]
          }
          replace(index, merged)
        }
        const setField = (key) => (value) => patch({ [key]: value === '' ? undefined : value })

        let primary
        if (kind === 'literal') {
          primary = h(TextInput, {
            value: asString(binding.literal),
            disabled,
            mono: true,
            placeholder: '--short',
            onChange: setField('literal'),
          })
        } else if (kind === 'flag') {
          primary = h('div', { style: S.grid2 },
            h(Select, {
              value: asString(binding.flag),
              options: paramNames.length > 0 ? paramNames : [''],
              disabled,
              onChange: setField('flag'),
            }),
            h(TextInput, {
              value: Array.isArray(binding.as) ? binding.as.join(' ') : asString(binding.as),
              disabled,
              mono: true,
              placeholder: '--dry-run',
              onChange: (next) => {
                const parts = next.split(/\s+/u).filter(Boolean)
                patch({ as: parts.length > 1 ? parts : (parts[0] ?? undefined) })
              },
            }))
        } else if (kind === 'stdin-json') {
          primary = h('span', { style: S.hint }, '把整份参数 JSON 写进 stdin（powershell 唯一可用形式）')
        } else {
          primary = h(Select, {
            value: asString(binding.arg),
            options: paramNames.length > 0 ? paramNames : [''],
            disabled,
            onChange: setField('arg'),
          })
        }

        const advanced = kind === 'arg' || kind === 'stdin-raw'
          ? h('div', { style: S.bindingAdvanced },
            h(Field, { label: '前缀' },
              h(TextInput, { value: asString(binding.prefix), disabled, mono: true, placeholder: '--glob=', onChange: setField('prefix') })),
            h(Field, { label: '后缀' },
              h(TextInput, { value: asString(binding.suffix), disabled, mono: true, placeholder: '', onChange: setField('suffix') })),
            kind === 'arg'
              ? h(Field, { label: 'join（数组用）' },
                h(TextInput, { value: asString(binding.join), disabled, mono: true, placeholder: ',', onChange: setField('join') }))
              : null,
            h('div', { style: { display: 'grid', gap: 3, alignContent: 'start', paddingTop: 14 } },
              h(Checkbox, {
                checked: binding.omitIfEmpty === true,
                disabled,
                label: '空值时不传',
                onChange: (next) => patch({ omitIfEmpty: next ? true : undefined }),
              }),
              h(Checkbox, {
                checked: binding.repeat === true,
                disabled,
                label: 'repeat（数组逐项）',
                onChange: (next) => patch({ repeat: next ? true : undefined }),
              }),
              h(Checkbox, {
                checked: binding.json === true,
                disabled,
                label: 'json（值序列化）',
                onChange: (next) => patch({ json: next ? true : undefined }),
              }),
              h(Checkbox, {
                checked: binding.allowLeadingDash === true,
                disabled,
                label: '允许值以 - 开头',
                onChange: (next) => patch({ allowLeadingDash: next ? true : undefined }),
              }),
              h(Checkbox, {
                checked: binding.allowResponseFile === true,
                disabled,
                label: '允许值以 @ 开头',
                onChange: (next) => patch({ allowResponseFile: next ? true : undefined }),
              })))
          : null

        return h('div', { key: `binding-${index}`, style: S.bindingRow },
          h('div', { style: S.bindingMain },
            h(Select, {
              value: kind,
              options: BINDING_KINDS,
              disabled,
              render: (option) => BINDING_LABEL[option] ?? option,
              onChange: (next) => replace(index, rebind(binding, next, parameters)),
            }),
            primary,
            h('span', null,
              h(Button, { kind: 'small', disabled: disabled || index === 0, onClick: () => move(index, -1), title: '上移' }, '↑'),
              ' ',
              h(Button, { kind: 'small', disabled: disabled || index === bindings.length - 1, onClick: () => move(index, 1), title: '下移' }, '↓'),
              ' ',
              h(Button, { kind: 'danger', disabled, onClick: () => remove(index), title: '删除' }, '×'))),
          advanced)
      })

      const addButtons = ['literal', 'arg', 'flag', 'stdin-json'].filter((kind) => {
        if (kind === 'stdin-json') return mode !== 'executable'
        return true
      }).map((kind) => h(Button, {
        key: kind,
        kind: 'small',
        disabled,
        onClick: () => add(kind),
      }, `＋ ${BINDING_LABEL[kind]}`))

      return h(Panel, {
        title: '参数怎么变成 argv',
        meta: `${bindings.length} 条绑定`,
        action: h('span', { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } }, addButtons),
      },
      bindings.length === 0
        ? h('span', { style: S.hint }, mode === 'executable'
          ? '没有绑定：这个工具不带任何参数运行。'
          : mode === 'powershell'
            ? 'PowerShell 只接受 stdin（JSON）；不声明绑定就拿不到参数。'
            : '没有绑定：脚本拿不到参数。')
        : h('div', null, rows),
      h('div', { style: { marginTop: 8 } }, h(ArgvStrip, { spec: tool, samples: {} , issues: [] })))
    }

    // ----------------------------------------------------------- tool card

    function ToolCard({ tool, index, total, disabled, savedAt, issues, onChange, onRemove, onMove, onDuplicate, samples, onSample }) {
      const [open, setOpen] = React.useState(index === 0)
      const set = (patch) => {
        const next = { ...tool, ...patch }
        for (const key of Object.keys(next)) {
          if (next[key] === undefined) delete next[key]
        }
        onChange(next)
      }
      const mode = asString(tool.mode, 'executable')
      const own = issuesFor(issues, index)
      const bad = own.some((issue) => issue.severity === 'error')

      // The headline shows the *persisted* name: a draft name only reaches the
      // card header after a successful save, so typing never rewrites it.
      const committed = React.useRef(asString(tool.name))
      React.useEffect(() => { committed.current = asString(tool.name) }, [savedAt])
      const draftName = asString(tool.name)

      const target = mode === 'executable'
        ? h(Field, { label: '可执行文件', hint: 'PATH 中的名字（如 git）或绝对路径；preflight 会解析成绝对路径' },
          h(TextInput, {
            value: asString(tool.executable),
            disabled,
            mono: true,
            placeholder: 'git',
            onChange: (next) => set({ executable: next }),
          }))
        : mode === 'script'
          ? h('div', { style: S.grid2 },
            h(Field, { label: '解释器', hint: '如 python / node / pwsh' },
              h(TextInput, {
                value: asString(tool.interpreter),
                disabled,
                mono: true,
                onChange: (next) => set({ interpreter: next }),
              })),
            h(Field, { label: '脚本路径' },
              h(TextInput, {
                value: asString(tool.script),
                disabled,
                mono: true,
                placeholder: 'C:/Users/me/tools/report.py',
                onChange: (next) => set({ script: next }),
              })))
          : h(Field, {
            label: mode === 'bash' ? 'bash 脚本文本（模型参数只进 $@）' : 'PowerShell 脚本文本（参数只能走 stdin）',
            hint: '脚本文本由作者固定；模型的值永远不会拼进这段文本',
          }, h(TextArea, {
            value: asString(tool.command),
            disabled,
            rows: 5,
            onChange: (next) => set({ command: next }),
          }))

      const scriptExtras = mode === 'script'
        ? h('div', { style: S.grid2 },
          h(Field, { label: '脚本来源', hint: 'trusted-path：路径就是信任；user-managed：不允许可变路径' },
            h(Select, {
              value: asString(tool.scriptTrust, 'trusted-path'),
              options: ['trusted-path', 'user-managed'],
              disabled,
              onChange: (next) => set({ scriptTrust: next }),
            })),
          h(Field, { label: 'SHA-256（可选）', hint: '脚本内容变了就拒绝运行' },
            h(TextInput, {
              value: asString(tool.scriptSha256),
              disabled,
              mono: true,
              placeholder: '64 位小写十六进制',
              onChange: (next) => set({ scriptSha256: next }),
            })))
        : null

      const samplesForTool = samples?.[index] ?? {}

      return h('section', { style: open ? { ...S.card, ...S.cardOpen } : S.card },
        h('div', {
          style: S.cardHead,
          onClick: () => setOpen(!open),
        },
        h('span', { style: { ...S.twist, transform: open ? 'rotate(90deg)' : 'none' } }, '▶'),
        h('span', { style: { ...S.cardName, color: bad ? C.error : C.textPrimary } }, committed.current || '（未命名）'),
        committed.current === '' ? null : h(Chip, null, MODE_LABEL[mode] ?? mode),
        draftName !== committed.current ? h(Chip, { tone: 'dirty' }, '未保存') : null,
        bad ? h(Chip, { tone: 'bad' }, `${own.filter((issue) => issue.severity === 'error').length} 处错误`) : null,
        tool.enabled === false ? h(Chip, { tone: 'dirty' }, '已停用') : null,
        h('span', { style: S.grow }),
        h(Switch, {
          checked: tool.enabled !== false,
          disabled,
          onChange: (next) => set({ enabled: next }),
        })),

        open
          ? h('div', { style: S.cardBody },
            h(Panel, { title: '身份', last: false },
              h('div', { style: S.grid2 },
                h(Field, { label: '工具名', hint: '小写字母开头，a-z 0-9 _；这是模型看到的工具名' },
                  h(TextInput, {
                    value: draftName,
                    disabled,
                    mono: true,
                    placeholder: 'my_tool',
                    onChange: (next) => set({ name: next }),
                  })),
                h(Field, { label: '标题（可选）', hint: '界面显示用，不进模型上下文' },
                  h(TextInput, {
                    value: asString(tool.title),
                    disabled,
                    onChange: (next) => set({ title: next }),
                  }))),
              h(Field, { label: '描述', hint: '模型据此决定是否调用：写清用途与边界' },
                h(TextArea, {
                  value: asString(tool.description),
                  disabled,
                  rows: 2,
                  mono: false,
                  onChange: (next) => set({ description: next }),
                })),
              h(Field, { label: '何时使用（可选）', hint: '会追加到描述后面，作为 When to use 段落' },
                h(TextArea, {
                  value: asString(tool.whenToUse),
                  disabled,
                  rows: 2,
                  mono: false,
                  onChange: (next) => set({ whenToUse: next }),
                }))),

            h(Panel, {
              title: '命令',
              action: h(Segmented, {
                value: mode,
                options: MODES,
                disabled,
                render: (option) => MODE_LABEL[option],
                onChange: (next) => set({ mode: next }),
              }),
            },
            target,
            scriptExtras),

            h(BindingsPanel, {
              tool,
              disabled,
              onChange: (patch) => set(patch),
            }),

            h(ParametersPanel, {
              tool,
              disabled,
              onChange: (patch) => set(patch),
            }),

            h(Panel, { title: '执行' },
              h('div', { style: S.grid3 },
                h(Field, { label: '工作目录', hint: '相对路径基于会话目录；留空用会话目录' },
                  h(TextInput, {
                    value: asString(tool.cwd),
                    disabled,
                    mono: true,
                    placeholder: '.',
                    onChange: (next) => set({ cwd: next }),
                  })),
                h(Field, { label: '超时（毫秒）', hint: '1000 – 600000' },
                  h(NumberInput, {
                    value: String(asNumber(tool.timeoutMs, 120000)),
                    disabled,
                    min: 1000,
                    max: 600000,
                    onChange: (next) => set({ timeoutMs: next === '' ? undefined : Number(next) }),
                  })),
                h(Field, { label: '审批', hint: '工具与宿主同权限运行，没有插件侧沙箱' },
                  h(Select, {
                    value: asString(tool.approval, 'inherit'),
                    options: APPROVALS,
                    disabled,
                    render: (option) => APPROVAL_LABEL[option],
                    onChange: (next) => set({ approval: next }),
                  }))),
              h('div', { style: S.grid3 },
                h(Field, { label: '并发', hint: 'exclusive：同工具串行；parallel：允许重叠' },
                  h(Select, {
                    value: asString(tool.concurrency, 'exclusive'),
                    options: CONCURRENCY,
                    disabled,
                    onChange: (next) => set({ concurrency: next }),
                  })),
                h(Field, { label: '输出解析' },
                  h(Select, {
                    value: asString(tool.output?.parse, 'text'),
                    options: PARSES,
                    disabled,
                    onChange: (next) => set({ output: { ...(isObject(tool.output) ? tool.output : {}), parse: next } }),
                  })),
                h('div', { style: { display: 'grid', gap: 3, alignContent: 'end' } },
                  h(Checkbox, {
                    checked: tool.encodingDefaults !== false,
                    disabled,
                    label: '自动 UTF-8 编码默认值',
                    onChange: (next) => set({ encodingDefaults: next ? undefined : false }),
                  }))),
              asString(tool.output?.parse, 'text') === 'json'
                ? h(JsonField, {
                  label: '输出 JSON Schema（字符串，可选）',
                  hint: '成功输出必须满足它，否则报 OUTPUT_SCHEMA_MISMATCH',
                  value: typeof tool.output?.schema === 'string' && tool.output.schema.trim() !== ''
                    ? tryParseJson(tool.output.schema).value ?? {}
                    : {},
                  disabled,
                  rows: 4,
                  onChange: (next) => set({
                    output: {
                      ...(isObject(tool.output) ? tool.output : {}),
                      parse: 'json',
                      schema: next === null ? undefined : JSON.stringify(next),
                    },
                  }),
                })
                : null),

            h(Panel, { title: '高级', last: true },
              h(Field, { label: '环境变量', hint: '固定值，不来自模型；键名必须合法' },
                h(JsonField, {
                  label: '',
                  value: isObject(tool.env) ? tool.env : {},
                  disabled,
                  rows: 3,
                  onChange: (next) => set({ env: isObject(next) && Object.keys(next).length > 0 ? next : undefined }),
                })),
              h(JsonField, {
                label: '凭据引用（credentials）',
                hint: '形如 [{ "env": "GH_TOKEN", "ref": "github_token" }]；值每次调用时解析，不落盘',
                value: Array.isArray(tool.credentials) ? tool.credentials : [],
                disabled,
                rows: 3,
                onChange: (next) => set({ credentials: Array.isArray(next) && next.length > 0 ? next : undefined }),
              }),
              h(JsonField, {
                label: '调用示例（examples）',
                hint: '形如 [{ "name": "看最近改动", "args": "{\\"limit\\": 5}" }]',
                value: Array.isArray(tool.examples) ? tool.examples : [],
                disabled,
                rows: 3,
                onChange: (next) => set({ examples: Array.isArray(next) && next.length > 0 ? next : undefined }),
              })),

            own.length > 0
              ? h('ul', { style: { ...S.issues, marginTop: 8 } }, own.map((issue, i) => h('li', {
                key: `issue-${i}`,
                style: issue.severity === 'error' ? S.issueError : S.issueWarn,
              },
              h('span', null, issue.severity === 'error' ? '✕' : '!'),
              h('span', null, `${issue.path}: ${issue.message}`))))
              : h('div', { style: { ...S.issues, marginTop: 8 } },
                h('span', { style: S.issueOk }, '✓', ' 本地检查通过；保存后由宿主最终校验')),

            h('div', { style: { ...S.toolbar, marginTop: 10 } },
              h(Button, { kind: 'small', disabled, onClick: () => onDuplicate(index) }, '复制'),
              h(Button, { kind: 'small', disabled: disabled || index === 0, onClick: () => onMove(index, -1) }, '↑ 上移'),
              h(Button, { kind: 'small', disabled: disabled || index === total - 1, onClick: () => onMove(index, 1) }, '↓ 下移'),
              h('span', { style: S.grow }),
              h(Button, { kind: 'danger', disabled, onClick: () => onRemove(index) }, '删除这个工具')))
          : null)
    }

    // ------------------------------------------------------------------- page

    /** Build the page component bound to the live client context. */
    function makeSectionPage(ctx) {
      // `remote.settings` is a guarded service name: reading `ctx.remote.settings`
      // throws unless it is declared in inject, which it now is. `ctx.get()` is
      // the soft path, so a deployment that lost the service shows an inline
      // explanation instead of a section that throws mid-render.
      const settings = () => {
        const direct = ctx.get('remote.settings')
        if (direct) return direct
        try {
          return ctx.remote?.settings
        } catch {
          return undefined
        }
      }

      return function SectionPage() {
        const [phase, setPhase] = React.useState('loading')
        const [problem, setProblem] = React.useState('')
        const [banner, setBanner] = React.useState(null)
        const [draft, setDraft] = React.useState(null)
        const [saved, setSaved] = React.useState(null)
        const [revision, setRevision] = React.useState(undefined)
        const [busy, setBusy] = React.useState(false)
        // `savedAt` bumps on every successful load/save: cards use it to know
        // when the persisted name changed and the headline may be redrawn.
        const [savedAt, setSavedAt] = React.useState(0)
        // Row identity for React keys. Keying a card by its *name* remounts the
        // whole card on every keystroke, which steals focus from the name input.
        const rowIds = React.useRef([])
        const nextRowId = React.useRef(1)
        // Sample values for the argv strip: UI-only, never written back.
        const [samples, setSamples] = React.useState({})

        async function load() {
          setPhase('loading')
          setProblem('')
          try {
            const api = settings()
            if (!api || typeof api.describe !== 'function') {
              setPhase('error')
              setProblem('当前客户端没有挂载 remote.settings，无法读写插件配置。')
              return
            }
            const result = unwrap(await api.describe())
            if (!result.ok) {
              setPhase('error')
              setProblem(`读取设置失败：${result.message}`)
              return
            }
            const view = findNamespace(result.value, NS)
            if (!view) {
              setPhase('error')
              setProblem(`设置文档里没有命名空间 ${NS}：插件可能未启用，或加载失败。`)
              return
            }
            const config = readConfig(view.value)
            rowIds.current = config.tools.map(() => nextRowId.current++)
            setDraft(config)
            setSaved(clone(config))
            setSamples({})
            setRevision(view.revision)
            setSavedAt((count) => count + 1)
            setPhase('ready')
          } catch (error) {
            setPhase('error')
            setProblem(error instanceof Error ? error.message : String(error))
          }
        }

        React.useEffect(() => { load() }, [])

        const config = draft ?? EMPTY_CONFIG
        const baseline = saved ?? EMPTY_CONFIG
        const dirty = !sameJson(config, baseline)
        const issues = collectIssues(config.tools)
        const errorCount = issues.filter((issue) => issue.severity === 'error').length

        const edit = (next) => { setDraft(next); setBanner(null) }

        const setTool = (index, next) => {
          edit({ ...config, tools: config.tools.map((tool, i) => (i === index ? next : tool)) })
        }
        const removeTool = (index) => {
          rowIds.current = rowIds.current.filter((_, i) => i !== index)
          edit({ ...config, tools: config.tools.filter((_, i) => i !== index) })
        }
        const moveTool = (index, delta) => {
          const tools = [...config.tools]
          const target = index + delta
          if (target < 0 || target >= tools.length) return
          const [item] = tools.splice(index, 1)
          tools.splice(target, 0, item)
          const ids = [...rowIds.current]
          const [movedId] = ids.splice(index, 1)
          ids.splice(target, 0, movedId)
          rowIds.current = ids
          edit({ ...config, tools })
        }
        const duplicateTool = (index) => {
          const copy = clone(config.tools[index])
          if (isObject(copy)) {
            const taken = new Set(config.tools.map((tool) => asString(tool.name)))
            let candidate = `${asString(copy.name, 'tool')}_copy`
            let n = 2
            while (taken.has(candidate)) {
              candidate = `${asString(copy.name, 'tool')}_copy${n}`
              n += 1
            }
            copy.name = candidate
          }
          const ids = [...rowIds.current]
          ids.splice(index + 1, 0, nextRowId.current++)
          rowIds.current = ids
          const tools = [...config.tools]
          tools.splice(index + 1, 0, copy)
          edit({ ...config, tools })
        }
        const addTool = (kind) => {
          rowIds.current = [...rowIds.current, nextRowId.current++]
          edit({ ...config, tools: [...config.tools, clone(TEMPLATES[kind])] })
        }
        const setSample = (index, name, value) => {
          setSamples((current) => {
            const forTool = { ...(current[index] ?? {}) }
            forTool[name] = value
            return { ...current, [index]: forTool }
          })
        }

        const save = async () => {
          if (busy || revision === undefined) return
          if (errorCount > 0) {
            setBanner({
              tone: 'bad',
              title: '还有格式错误，未提交：',
              text: issues.filter((issue) => issue.severity === 'error').slice(0, 3)
                .map((issue) => `${asString(config.tools[issue.tool]?.name, `#${issue.tool + 1}`)} ${issue.path}`)
                .join('；'),
            })
            return
          }
          setBusy(true)
          setBanner(null)
          try {
            const api = settings()
            const ops = [
              { op: 'set', path: ['tools'], value: config.tools },
              { op: 'set', path: ['deferLoading'], value: config.deferLoading === true },
            ]
            const result = unwrap(await api.mutate(NS, ops, revision))
            if (!result.ok) {
              setBanner({
                tone: 'bad',
                title: '保存失败：',
                text: /conflict/u.test(result.message)
                  ? `${result.message}（别处已保存过，点「重新读取」再看当前值）`
                  : result.message,
              })
            } else {
              setBanner({
                tone: 'ok',
                title: '已保存。',
                text: '下一次工具调用就用新定义；已经在跑的调用会跑完它启动时的那一版。',
              })
              await load()
            }
          } catch (error) {
            setBanner({ tone: 'bad', title: '保存失败：', text: error instanceof Error ? error.message : String(error) })
          } finally {
            setBusy(false)
          }
        }

        const revert = () => {
          if (saved === null) return
          setDraft(clone(saved))
          setBanner(null)
        }

        const body = [
          h('div', { key: 'header', style: S.header },
            h('div', { key: 't', style: S.titleRow },
              h('h3', { key: 'title', style: S.title }, '自定义工具'),
              h(Chip, { key: 'rev' }, revision === undefined ? 'revision …' : `revision ${revision}`),
              dirty ? h(Chip, { key: 'dirty', tone: 'dirty' }, '未保存') : null,
              errorCount > 0 ? h(Chip, { key: 'bad', tone: 'bad' }, `${errorCount} 处错误`) : null,
              dirty ? null : h(Chip, { key: 'clean', tone: 'ok' }, '已同步')),
            h('p', { key: 'lead', style: S.lead },
              '把手上的可执行文件或脚本包成模型能调用的工具：声明参数，参数只以精确的 argv / stdin 值传给程序，'
              + '永远不会拼进 shell 文本。工具以宿主权限运行——写定义的人对它的行为负责。')),
        ]

        if (phase === 'loading') body.push(h('p', { key: 'loading', style: S.status }, '读取中…'))
        if (problem) body.push(h('p', { key: 'problem', style: S.error }, problem))
        if (banner) {
          body.push(h(Banner, {
            key: 'banner',
            tone: banner.tone,
            title: banner.title,
            action: banner.tone === 'bad'
              ? h(Button, { kind: 'small', disabled: busy, onClick: () => load() }, '重新读取')
              : null,
          }, banner.text))
        }

        if (phase === 'ready') {
          body.push(h('div', { key: 'toolbar', style: S.toolbar },
            h(Button, { key: 'save', kind: 'primary', disabled: busy || !dirty, onClick: save },
              busy ? '保存中…' : '保存'),
            h(Button, { key: 'revert', disabled: busy || !dirty, onClick: revert }, '放弃修改'),
            h(Button, { key: 'reload', disabled: busy, onClick: () => load() }, '重新读取'),
            h('span', { key: 'grow', style: S.grow }),
            h('span', { key: 'add-label', style: S.hint }, '新增：'),
            ...MODES.map((mode) => h(Button, {
              key: `add-${mode}`,
              kind: 'small',
              disabled: busy,
              onClick: () => addTool(mode),
            }, MODE_LABEL[mode]))))

          if (config.tools.length === 0) {
            body.push(h('div', { key: 'empty', style: S.empty },
              h('strong', null, '还没有任何工具'),
              h('span', null, '从上面挑一个模板开始；也可以直接改 profile 的 cordis.patch.yml。'),
              h('span', { style: S.hint },
                '典型的第一件事：把某个 CLI 收紧成一条固定命令，只让模型填参数。')))
          }

          body.push(...config.tools.map((tool, index) => h(ToolCard, {
            key: rowIds.current[index] ?? `row-${index}`,
            tool,
            index,
            total: config.tools.length,
            disabled: busy,
            savedAt,
            issues,
            samples,
            onSample: setSample,
            onChange: setTool,
            onRemove: removeTool,
            onMove: moveTool,
            onDuplicate: duplicateTool,
          })))

          body.push(h('div', { key: 'defer', style: S.toolbar },
            h(Checkbox, {
              checked: config.deferLoading === true,
              disabled: busy,
              label: '延迟加载工具定义（deferLoading）',
              onChange: (next) => edit({ ...config, deferLoading: next }),
            })))

          body.push(h('div', { key: 'foot', style: S.toolbar },
            h(Button, { key: 'save2', kind: 'primary', disabled: busy || !dirty, onClick: save },
              busy ? '保存中…' : '保存'),
            h(Button, { key: 'revert2', disabled: busy || !dirty, onClick: revert }, '放弃修改'),
            h('span', { key: 'count', style: S.status },
              `共 ${config.tools.length} 个，启用 ${config.tools.filter((tool) => tool.enabled !== false).length} 个`)))

          body.push(h('div', { key: 'hint', style: S.hint },
            '这个页面只能编辑定义，不能执行：浏览器没有到宿主的执行通道。'
            + '要在会话里试跑，用 /custom-tools preview <名字> {"参数":"值"}（只打印 argv，不执行）'
            + ' 或 /custom-tools test <名字> {"参数":"值"}（真的跑一次）。'))
        }

        return h('div', { style: S.wrap }, body)
      }
    }

    return {
      // `remote.settings` has to be declared: the client context guards service
      // properties exactly like the host, so reading it without inject throws
      // "cannot get property \"remote.settings\" without inject" while rendering.
      // This is also what the shipped settings UI declares on its own provider.
      inject: ['slots', 'remote', 'remote.settings'],
      apply(ctx) {
        const SectionPage = makeSectionPage(ctx)
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            { name: 'settings.section', id: 'custom-tools', order: 60, label: '自定义工具' },
            SectionPage,
          )
        })
      },
      /**
       * Exposed for `test/client.test.js` only. The preview must agree with
       * `src/compiler/bindings.js` byte for byte, and that is only checkable if
       * the function is reachable from a test harness.
       */
      __internal: { previewInvocation, collectIssues, sampleValues, planOf },
    }
  },
})
