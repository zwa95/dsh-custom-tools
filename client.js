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
 *     command family. The strip under the command form is a local projection
 *     of the same binding rules — it shows the *shape* of argv (one box per
 *     real element), never a value, because the page never sees the model's
 *     arguments.
 *   - The page is the only place a broken tool definition becomes visible
 *     before it fails at call time, so it validates on every keystroke and
 *     says which field is wrong.
 *
 * Writes carry the revision they were read at, so a browser tab that was open
 * while something else saved gets a conflict instead of silently reverting it.
 *
 * Model of the editor: the persisted shape is `args[] + parameters{}` (two
 * parallel structures). The page edits a single ordered list of *pieces* —
 * literal, variable, flag, stdin — where a variable or flag declares its own
 * parameter inline. `piecesOf` / `applyPieces` convert between the two, and
 * they are exported for tests because that conversion is the one place where a
 * label could silently eat a field.
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

    /**
     * The preview colours are literal, not theme aliases: they encode "which
     * part of argv is this", and a semantic token would collapse them onto the
     * same grey in one of the two themes.
     */
    const TONE = {
      prog: '#78a9ff',
      script: '#56b6c2',
      lit: '#b9c0d4',
      variable: '#9ece6a',
      flag: '#bb9af7',
      stdin: '#e0af68',
    }

    const S = {
      wrap: { display: 'grid', gap: 12, maxWidth: 900 },
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
      twist: { width: 12, fontSize: 9, color: C.textTertiary, transition: 'transform .12s' },
      cardName: { font: C.mono, fontWeight: 600, color: C.textPrimary },
      cardBody: { padding: '2px 12px 12px', borderTop: `1px solid ${C.borderL1}` },
      panel: { padding: '10px 0', borderBottom: `1px solid ${C.borderL1}` },
      panelLast: { padding: '10px 0 0', borderBottom: 'none' },
      panelHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
      panelTitle: { fontSize: 12, fontWeight: 600, color: C.textSecondary, letterSpacing: '.02em' },
      panelMeta: { fontSize: 11, color: C.textTertiary },
      panelBody: { display: 'grid', gap: 8 },
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
      area: {
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
      select: {
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        minHeight: 28,
        padding: '3px 6px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL1}`,
        background: C.bg3,
        color: 'inherit',
        font: 'inherit',
      },
      status: { margin: 0, fontSize: 12, color: C.textSecondary },
      error: { margin: 0, fontSize: 12, color: C.error },
      grow: { flex: 1 },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 7px',
        borderRadius: 999,
        border: `1px solid ${C.borderL1}`,
        fontSize: 11,
        lineHeight: 1.7,
        color: C.textSecondary,
        whiteSpace: 'nowrap',
      },
      chipDirty: { borderColor: TONE.stdin, color: TONE.stdin },
      chipBad: { borderColor: C.error, color: C.error },
      chipOk: { borderColor: C.success, color: C.success },
      chipMode: { borderColor: C.borderL2, color: C.textSecondary },
      banner: {
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '8px 10px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL1}`,
        background: C.bg2,
        fontSize: 12,
        color: C.textSecondary,
        lineHeight: 1.6,
      },
      bannerOk: { borderColor: C.success },
      bannerBad: { borderColor: C.error },
      empty: {
        display: 'grid',
        gap: 4,
        padding: '18px 14px',
        borderRadius: C.radius,
        border: `1px dashed ${C.borderL1}`,
        fontSize: 12,
        color: C.textSecondary,
        lineHeight: 1.6,
      },
      button: {
        boxSizing: 'border-box',
        minHeight: 28,
        padding: '3px 12px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL1}`,
        background: C.bg2,
        color: C.textPrimary,
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      buttonPrimary: {
        boxSizing: 'border-box',
        minHeight: 28,
        padding: '3px 14px',
        borderRadius: C.radiusSmall,
        border: '1px solid transparent',
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
        padding: '1px 9px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL1}`,
        background: 'transparent',
        color: C.textSecondary,
        font: 'inherit',
        fontSize: 11.5,
        cursor: 'pointer',
      },
      buttonDanger: {
        boxSizing: 'border-box',
        minHeight: 24,
        padding: '1px 9px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.error}`,
        background: 'transparent',
        color: C.error,
        font: 'inherit',
        fontSize: 11.5,
        cursor: 'pointer',
      },
      iconButton: {
        boxSizing: 'border-box',
        width: 26,
        height: 26,
        padding: 0,
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL1}`,
        background: 'transparent',
        color: C.textSecondary,
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      disabled: { opacity: 0.45, cursor: 'default' },
      seg: {
        display: 'inline-flex',
        padding: 2,
        gap: 2,
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL1}`,
        background: C.bg2,
      },
      segItem: {
        boxSizing: 'border-box',
        padding: '2px 10px',
        borderRadius: 4,
        border: 'none',
        background: 'transparent',
        color: C.textSecondary,
        font: 'inherit',
        fontSize: 11.5,
        cursor: 'pointer',
      },
      segItemOn: { background: C.bg3, color: C.textPrimary, fontWeight: 600 },
      check: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: C.textSecondary },
      switchWrap: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' },
      switchTrack: {
        position: 'relative',
        width: 30,
        height: 16,
        borderRadius: 999,
        background: C.bg3,
        border: `1px solid ${C.borderL1}`,
        transition: 'background .12s',
      },
      switchKnob: {
        position: 'absolute',
        top: 1,
        left: 1,
        width: 12,
        height: 12,
        borderRadius: 999,
        background: C.textTertiary,
        transition: 'left .12s, background .12s',
      },
      preview: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 5,
        alignItems: 'center',
        padding: '9px 10px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL1}`,
        background: C.bg2,
        font: C.mono,
        minHeight: 40,
      },
      previewEmpty: { fontSize: 11.5, color: C.textTertiary },
      legend: { display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11, color: C.textTertiary },
      legendItem: { display: 'inline-flex', alignItems: 'center', gap: 4 },
      legendDot: { width: 7, height: 7, borderRadius: 999 },
      chipBox: {
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 5,
        padding: '1px 7px',
        borderRadius: 4,
        border: '1px solid transparent',
        background: 'rgba(255,255,255,.04)',
        whiteSpace: 'pre',
      },
      chipGhost: { borderStyle: 'dashed', borderColor: C.borderL2, opacity: 0.62 },
      chipEmpty: { borderStyle: 'dashed', borderColor: C.borderL1, color: C.textTertiary },
      pieceHead: { display: 'flex', gap: 6, alignItems: 'center' },
      pieceKind: { width: 96, flex: 'none' },
      pieceGrow: { flex: 1, minWidth: 0 },
      pieceBody: { display: 'grid', gap: 8, padding: '9px 0 2px' },
      pieces: { display: 'grid', gap: 6 },
      piece: {
        display: 'grid',
        gap: 4,
        padding: '7px 8px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL1}`,
        background: C.bg2,
      },
      options: {
        display: 'grid',
        gap: 3,
        paddingTop: 2,
      },
      optionsTitle: { fontSize: 11, color: C.textTertiary, letterSpacing: '.02em' },
      option: {
        display: 'grid',
        gridTemplateColumns: '16px 1fr',
        gap: 7,
        alignItems: 'flex-start',
        padding: '5px 7px',
        borderRadius: 6,
        background: 'rgba(255,255,255,.018)',
        cursor: 'pointer',
      },
      optionOn: { background: 'rgba(76,141,255,.10)', border: '1px solid rgba(76,141,255,.35)' },
      optionOff: { border: '1px solid transparent' },
      optionTitle: { fontSize: 11.5, color: C.textPrimary, lineHeight: 1.5 },
      optionDetail: { fontSize: 11, color: C.textTertiary, lineHeight: 1.55 },
      code: {
        font: C.mono,
        fontSize: 10.5,
        padding: '0 3px',
        borderRadius: 3,
        background: C.bg3,
        color: C.textSecondary,
      },
      issues: { display: 'grid', gap: 2, fontSize: 11.5, color: C.error, lineHeight: 1.5 },
      ok: { fontSize: 11.5, color: C.success },
      note: { fontSize: 11.5, color: C.textTertiary, lineHeight: 1.6 },
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
    const CONCURRENCY_LABEL = {
      exclusive: 'exclusive（同一工具串行）',
      parallel: 'parallel（允许重叠）',
    }
    const PARSES = ['text', 'json']
    const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'array']
    const PARAM_ITEMS = ['string', 'number', 'integer', 'boolean']

    const PIECE_KINDS = ['literal', 'variable', 'flag', 'stdin']
    const PIECE_LABEL = {
      literal: '字面值',
      variable: '变量',
      flag: '开关',
      stdin: 'stdin（JSON）',
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
    const isAbsolutePath = (value) =>
      value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')
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

    function namespaceList(value) {
      if (Array.isArray(value)) return value
      if (isObject(value)) return Object.values(value)
      return []
    }

    function findNamespace(value, ns) {
      return namespaceList(value).find((entry) => isObject(entry)
        && (entry.ns === ns || entry.namespace === ns || entry.id === ns)) ?? null
    }

    const EMPTY_CONFIG = { tools: [], deferLoading: false }

    function readConfig(value) {
      if (!isObject(value)) return { ...EMPTY_CONFIG, tools: [] }
      const tools = Array.isArray(value.tools) ? value.tools.filter(isObject) : []
      return { tools: clone(tools), deferLoading: value.deferLoading === true }
    }

    // ------------------------------------------------------- pieces <-> spec

    /**
     * One piece per argv slot, plus anything that rides on stdin. A variable or
     * flag OWNS its parameter: there is no second table to keep in sync, which
     * removes the classic "you bound a parameter you never declared" state.
     *
     * Parameters without a binding are surfaced as `orphan` pieces so that a
     * save never silently drops them.
     */
    function piecesOf(tool) {
      const bindings = Array.isArray(tool.args) ? tool.args : []
      const parameters = isObject(tool.parameters) ? tool.parameters : {}
      const claimed = new Set()
      const pieces = []

      bindings.forEach((binding, index) => {
        if (!isObject(binding)) return
        const id = `b${index}`
        if (binding.stdin === 'json') {
          pieces.push({ id, kind: 'stdin' })
          return
        }
        if (binding.literal !== undefined) {
          pieces.push({ id, kind: 'literal', text: asString(binding.literal) })
          return
        }
        if (binding.flag !== undefined) {
          const name = asString(binding.flag)
          claimed.add(name)
          const spec = isObject(parameters[name]) ? parameters[name] : {}
          const as = Array.isArray(binding.as) ? binding.as : asString(binding.as)
          pieces.push({
            id,
            kind: 'flag',
            name,
            as: Array.isArray(as) ? as.join(' ') : as,
            originalAs: Array.isArray(as) ? [...as] : undefined,
            description: asString(spec.description),
            required: spec.required === true,
            default: asString(spec.default),
            original: isObject(spec) ? clone(spec) : undefined,
          })
          return
        }
        if (binding.arg !== undefined) {
          const name = asString(binding.arg)
          claimed.add(name)
          const spec = isObject(parameters[name]) ? parameters[name] : {}
          pieces.push({
            id,
            kind: 'variable',
            name,
            rawStdin: binding.stdin === 'raw',
            prefix: asString(binding.prefix),
            prefixSet: binding.prefix !== undefined,
            suffix: asString(binding.suffix),
            suffixSet: binding.suffix !== undefined,
            join: asString(binding.join),
            joinSet: binding.join !== undefined,
            repeat: binding.repeat === true,
            json: binding.json === true,
            omitIfEmpty: binding.omitIfEmpty === true,
            allowLeadingDash: binding.allowLeadingDash === true,
            allowResponseFile: binding.allowResponseFile === true,
            type: asString(spec.type, 'string'),
            items: asString(spec.items),
            required: spec.required === true,
            default: asString(spec.default),
            description: asString(spec.description),
            original: isObject(spec) ? clone(spec) : undefined,
          })
        }
      })

      for (const [name, spec] of Object.entries(parameters)) {
        if (claimed.has(name)) continue
        const parameter = isObject(spec) ? spec : {}
        pieces.push({
          id: `p:${name}`,
          kind: 'variable',
          orphan: true,
          name,
          rawStdin: false,
          prefix: '',
          suffix: '',
          join: '',
          repeat: false,
          json: false,
          omitIfEmpty: false,
          allowLeadingDash: false,
          allowResponseFile: false,
          type: asString(parameter.type, 'string'),
          items: asString(parameter.items),
          required: parameter.required === true,
          default: asString(parameter.default),
          description: asString(parameter.description),
          original: clone(parameter),
        })
      }

      return pieces
    }

    /** Rebuild a parameter, keeping fields this page does not edit (min/max…). */
    function parameterOf(piece, type) {
      const base = isObject(piece.original) ? clone(piece.original) : {}
      const parameter = { ...base, type }
      if (type === 'array' && asString(piece.items) !== '') parameter.items = asString(piece.items)
      else delete parameter.items
      if (piece.required === true) parameter.required = true
      else delete parameter.required
      const description = asString(piece.description)
      if (description.trim() !== '') parameter.description = description
      else delete parameter.description
      const fallback = asString(piece.default)
      // `default: ""` is a real default for a string parameter, so an empty
      // box only means "no default" when the stored one was not empty either.
      if (fallback !== '' || base.default === '') parameter.default = fallback
      else delete parameter.default
      return parameter
    }

    /** The inverse of `piecesOf`. Orphans stay in `parameters` but get no slot. */
    function applyPieces(tool, pieces) {
      const parameters = isObject(tool.parameters) ? { ...tool.parameters } : {}
      const args = []
      const declared = new Set()

      for (const piece of pieces) {
        if (piece.kind === 'literal') {
          args.push({ literal: asString(piece.text) })
          continue
        }
        if (piece.kind === 'stdin') {
          args.push({ stdin: 'json' })
          continue
        }
        const name = asString(piece.name)
        if (piece.kind === 'flag') {
          const binding = { flag: name }
          const asText = asString(piece.as)
          if (Array.isArray(piece.originalAs) && piece.originalAs.join(' ') === asText) {
            binding.as = [...piece.originalAs]
          } else if (asText.trim() !== '') {
            binding.as = /\s/u.test(asText.trim()) ? asText.trim().split(/\s+/u) : asText
          }
          args.push(binding)
          parameters[name] = parameterOf(piece, 'boolean')
          declared.add(name)
          continue
        }
        // variable
        if (piece.orphan === true) {
          parameters[name] = parameterOf(piece, asString(piece.type, 'string'))
          declared.add(name)
          continue
        }
        const binding = { arg: name }
        if (piece.rawStdin === true) binding.stdin = 'raw'
        // A field the author wrote as "" is preserved: dropping it would make
        // "open the card, save" rewrite a definition the user never edited.
        if (asString(piece.prefix) !== '' || piece.prefixSet === true) binding.prefix = asString(piece.prefix)
        if (asString(piece.suffix) !== '' || piece.suffixSet === true) binding.suffix = asString(piece.suffix)
        if (asString(piece.join) !== '' || piece.joinSet === true) binding.join = asString(piece.join)
        if (piece.repeat === true) binding.repeat = true
        if (piece.json === true) binding.json = true
        if (piece.omitIfEmpty === true) binding.omitIfEmpty = true
        if (piece.allowLeadingDash === true) binding.allowLeadingDash = true
        if (piece.allowResponseFile === true) binding.allowResponseFile = true
        args.push(binding)
        parameters[name] = parameterOf(piece, asString(piece.type, 'string'))
        declared.add(name)
      }

      // Drop parameters that no piece mentions any more, unless the piece is an
      // orphan (which is exactly how the user keeps one on purpose).
      const kept = {}
      for (const [name, parameter] of Object.entries(parameters)) {
        if (declared.has(name)) kept[name] = parameter
      }
      return { ...tool, args, parameters: kept }
    }

    const positionals = (pieces) => pieces.filter((piece) =>
      (piece.kind === 'variable' && piece.orphan !== true) || piece.kind === 'flag').length

    /** `--glob=<glob>`: the slot keeps its decoration, the value stays unknown. */
    function slotText(piece) {
      return `${asString(piece.prefix)}<${asString(piece.name) || '…'}>${asString(piece.suffix)}`
    }

    /**
     * The shape of argv, with one box per real element. Values are deliberately
     * absent: the page cannot know them, and inventing a sample would train the
     * author to trust a number that never appears at call time.
     */
    function previewOf(tool, pieces) {
      const mode = asString(tool.mode, 'executable')
      const parameters = isObject(tool.parameters) ? tool.parameters : {}
      const argv = []
      // A `{stdin:'json'}` slot (or PowerShell, which always needs one) hands
      // over EVERY declared parameter as one JSON object, in declaration order —
      // including parameters that have no argv slot of their own.
      const toStdin = mode === 'powershell' || pieces.some((piece) => piece.kind === 'stdin')
      const rawPiece = pieces.find((piece) => piece.kind === 'variable' && piece.rawStdin === true)
      const stdin = toStdin
        ? { kind: 'json', names: Object.keys(parameters) }
        : rawPiece
          ? { kind: 'raw', names: [asString(rawPiece.name)] }
          : null

      if (mode === 'executable') {
        argv.push({ kind: 'prog', text: asString(tool.executable) || '（未填程序）' })
      } else if (mode === 'script') {
        argv.push({ kind: 'prog', text: asString(tool.interpreter) || '（未填解释器）' })
        argv.push({ kind: 'script', text: asString(tool.script) || '（未填脚本路径）' })
      } else if (mode === 'bash') {
        argv.push({ kind: 'prog', text: asString(tool.executable) || 'bash' })
        argv.push({ kind: 'lit', text: '-c' })
        argv.push({ kind: 'script', text: asString(tool.command) || '（未填命令）' })
      } else if (mode === 'powershell') {
        argv.push({ kind: 'prog', text: asString(tool.executable) || 'pwsh' })
        for (const flag of POWERSHELL_FLAGS) argv.push({ kind: 'lit', text: flag })
        argv.push({ kind: 'lit', text: '-Command' })
        argv.push({ kind: 'script', text: asString(tool.command) || '（未填命令）' })
      }

      // `bash -c <source> <$0> <args…>`: the placeholder is what makes $1 the
      // first model value instead of $0.
      if (mode === 'bash' && !toStdin && positionals(pieces) > 0) {
        argv.push({ kind: 'lit', text: 'custom-tool', notes: '$0' })
      }

      for (const piece of pieces) {
        if (piece.kind === 'stdin') continue
        if (piece.kind === 'literal') {
          argv.push({ kind: 'lit', text: asString(piece.text) })
          continue
        }
        if (piece.orphan === true) continue
        if (piece.kind === 'flag') {
          const as = asString(piece.as)
          // With a stdin JSON slot a flag is just a boolean key in the object.
          if (toStdin) continue
          const active = piece.active === true
          argv.push({
            kind: 'flag',
            name: asString(piece.name),
            text: as || '（未填 as）',
            active,
          })
          continue
        }
        // variable
        if (piece.rawStdin === true) continue
        if (toStdin) continue
        argv.push({ kind: 'variable', name: asString(piece.name), text: slotText(piece) })
        if (piece.repeat === true) {
          argv.push({ kind: 'variable', name: '', text: slotText(piece), absent: true, notes: '…逐项' })
        }
      }

      return { argv, stdin, toStdin }
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

        // Same rule the host enforces: the session directory, or one absolute
        // path. A model argument can never move it.
        if (tool.cwd !== undefined) {
          if (typeof tool.cwd !== 'string' || tool.cwd === '') at('cwd', '工作目录不能为空')
          else if (tool.cwd !== '.' && !isAbsolutePath(tool.cwd)) {
            at('cwd', '工作目录要么是 .（会话目录），要么是一个绝对路径')
          }
        }

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
            at(where, 'boolean 参数应该用 flag 绑定，而不是 arg')
          }
          if (binding.repeat === true || binding.join !== undefined) {
            if (isObject(spec) && spec.type !== 'array') at(where, 'repeat / join 只能用于 array 参数')
            if (binding.repeat === true && binding.join !== undefined) at(where, 'repeat 与 join 不能同时使用')
          }
          if (binding.stdin === 'raw' && asString(binding.arg) === '') {
            at(where, 'stdin: raw 需要 arg')
          }
        })

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

        // A parameter nobody mentions reaches the model and does nothing.
        const used = new Set(bindings.filter(isObject)
          .map((binding) => (binding.arg !== undefined ? binding.arg : binding.flag))
          .filter((value) => typeof value === 'string'))
        for (const paramName of Object.keys(parameters)) {
          if (!used.has(paramName)) {
            at(`parameters.${paramName}`, `参数 ${paramName} 没有放进命令行，模型填了也不会被用到`, 'warning')
          }
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
            : tone === 'mode' ? { ...S.chip, ...S.chipMode }
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

    function NumberInput({ value, onChange, disabled, placeholder, min, max, step }) {
      return h('input', {
        type: 'number',
        min,
        max,
        step,
        style: S.input,
        value,
        disabled,
        placeholder,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function TextArea({ value, onChange, disabled, placeholder, rows }) {
      return h('textarea', {
        style: S.area,
        value,
        disabled,
        placeholder,
        rows: rows ?? 3,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function Select({ value, onChange, options, disabled, labels }) {
      return h('select', {
        style: S.select,
        value,
        disabled,
        onChange: (event) => onChange(event.target.value),
      }, options.map((option) => h('option', { key: option, value: option },
        labels ? labels[option] ?? option : option)))
    }

    function disabledStyle(kind) {
      if (kind === 'primary') {
        return { ...S.buttonPrimary, background: C.bg3, color: C.textTertiary, borderColor: C.borderL1, cursor: 'default' }
      }
      if (kind === 'danger') return { ...S.buttonDanger, ...S.disabled }
      if (kind === 'small') return { ...S.buttonSmall, ...S.disabled }
      if (kind === 'icon') return { ...S.iconButton, ...S.disabled }
      return { ...S.button, ...S.disabled }
    }

    function Button({ kind, disabled, onClick, children, title }) {
      const base = kind === 'primary' ? S.buttonPrimary
        : kind === 'small' ? S.buttonSmall
          : kind === 'danger' ? S.buttonDanger
            : kind === 'icon' ? S.iconButton
              : S.button
      return h('button', {
        type: 'button',
        title,
        style: disabled ? disabledStyle(kind) : base,
        disabled,
        onClick,
      }, children)
    }

    function Checkbox({ checked, onChange, label, disabled }) {
      return h('label', { style: disabled ? { ...S.check, ...S.disabled } : S.check },
        h('input', {
          type: 'checkbox',
          checked,
          disabled,
          onChange: (event) => onChange(event.target.checked),
        }),
        label ? h('span', null, label) : null)
    }

    function Switch({ checked, onChange, disabled, label }) {
      return h('label', { style: disabled ? { ...S.switchWrap, ...S.disabled } : S.switchWrap },
        h('span', {
          style: checked ? { ...S.switchTrack, background: C.brand, borderColor: C.brand } : S.switchTrack,
        }, h('span', {
          style: checked
            ? { ...S.switchKnob, left: 15, background: '#fff' }
            : S.switchKnob,
        })),
        h('input', {
          type: 'checkbox',
          checked,
          disabled,
          style: { display: 'none' },
          onChange: (event) => onChange(event.target.checked),
        }),
        label ? h('span', { style: S.hint }, label) : null)
    }

    function Segmented({ value, onChange, options, disabled }) {
      return h('div', { style: S.seg }, options.map((option) => h('button', {
        key: option.value,
        type: 'button',
        disabled,
        style: option.value === value ? { ...S.segItem, ...S.segItemOn } : S.segItem,
        onClick: () => onChange(option.value),
      }, option.label)))
    }

    /** JSON in a textarea: keeps raw text while it is invalid, adopts on change. */
    function JsonField({ value, onChange, disabled, placeholder, rows }) {
      const serialized = (input) => JSON.stringify(input ?? null)
      const text = (input) => {
        if (input === undefined || input === null) return ''
        if (Array.isArray(input) && input.length === 0) return ''
        if (isObject(input) && Object.keys(input).length === 0) return ''
        try {
          return JSON.stringify(input, null, 2)
        } catch {
          return String(input)
        }
      }
      const adopted = React.useRef(serialized(value))
      const [draft, setDraft] = React.useState(text(value))
      const [problem, setProblem] = React.useState('')
      const incoming = serialized(value)
      // Compare the *content*, not the object identity: the parent rebuilds the
      // object on every render, and adopting on identity would reformat the
      // textarea under the cursor on each keystroke.
      if (incoming !== adopted.current) {
        adopted.current = incoming
        setDraft(text(value))
        setProblem('')
      }
      const commit = (next) => {
        setDraft(next)
        if (next.trim() === '') {
          adopted.current = serialized(undefined)
          setProblem('')
          onChange(undefined)
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
        h('textarea', {
          style: S.area,
          value: draft,
          disabled,
          placeholder,
          rows: rows ?? 3,
          spellCheck: false,
          onChange: (event) => commit(event.target.value),
        }),
        problem ? h('span', { style: S.error }, `JSON 无效：${problem}`) : null)
    }

    function Panel({ title, meta, children, last }) {
      return h('div', { style: last ? S.panelLast : S.panel },
        h('div', { style: S.panelHead },
          h('span', { style: S.panelTitle }, title),
          meta ? h('span', { style: S.panelMeta }, meta) : null,
          h('span', { style: S.grow })),
        h('div', { style: S.panelBody }, children))
    }

    const code = (text) => h('code', { style: S.code }, text)

    function OptionRow({ title, detail, checked, onChange, disabled }) {
      return h('label', {
        style: { ...S.option, ...(checked ? S.optionOn : S.optionOff) },
      },
      h('input', {
        type: 'checkbox',
        checked,
        disabled,
        onChange: (event) => onChange(event.target.checked),
      }),
      h('span', null,
        h('span', { style: S.optionTitle }, title),
        detail ? h('span', { style: S.optionDetail, title: '' }, h('br'), detail) : null))
    }

    // ---------------------------------------------------------------- pieces

    function PieceRow({ piece, index, total, disabled, mode, onChange, onRemove, onMove }) {
      const [open, setOpen] = React.useState(false)
      const patch = (fields) => onChange({ ...piece, ...fields })
      const isVariable = piece.kind === 'variable' && piece.orphan !== true
      const isFlag = piece.kind === 'flag'
      const isArray = asString(piece.type) === 'array'

      const head = [
        h('div', { key: 'kind', style: S.pieceKind },
          h(Select, {
            value: piece.kind,
            disabled,
            options: PIECE_KINDS,
          labels: PIECE_LABEL,
          onChange: (next) => {
            if (next === 'literal') onChange({ id: piece.id, kind: 'literal', text: '' })
            else if (next === 'stdin') onChange({ id: piece.id, kind: 'stdin' })
            else if (next === 'flag') {
              onChange({ id: piece.id, kind: 'flag', name: asString(piece.name), as: '', description: '' })
            } else {
              onChange({
                id: piece.id,
                kind: 'variable',
                name: asString(piece.name),
                rawStdin: false,
                prefix: '',
                suffix: '',
                join: '',
                repeat: false,
                json: false,
                omitIfEmpty: false,
                allowLeadingDash: false,
                allowResponseFile: false,
                type: 'string',
                items: '',
                required: false,
                default: '',
                description: '',
              })
            }
          },
        }))
      ]

      if (piece.kind === 'literal') {
        head.push(h('div', { key: 'text', style: S.pieceGrow },
          h(TextInput, {
            mono: true,
            value: asString(piece.text),
            disabled,
            placeholder: '原样放进 argv 的一个元素，例如 --short',
            onChange: (next) => patch({ text: next }),
          })))
      } else if (piece.kind === 'stdin') {
        head.push(h('div', { key: 'fixed', style: { ...S.pieceGrow, ...S.hint } },
          '全部参数打包成一份 JSON 写到 stdin；键名就是各个变量名。'))
      } else if (piece.kind === 'flag') {
        head.push(h('div', { key: 'name', style: S.pieceGrow },
          h(TextInput, {
            mono: true,
            value: asString(piece.name),
            disabled,
            placeholder: '开关对应的参数名，例如 sort_keys',
            onChange: (next) => patch({ name: next }),
          })))
      } else {
        head.push(h('div', { key: 'name', style: S.pieceGrow },
          h(TextInput, {
            mono: true,
            value: asString(piece.name),
            disabled,
            placeholder: '变量名，模型看到的参数名',
            onChange: (next) => patch({ name: next }),
          })))
      }

      head.push(h('button', {
        key: 'twist',
        type: 'button',
        title: open ? '收起' : '展开',
        disabled,
        style: S.iconButton,
        onClick: () => setOpen((value) => !value),
      }, open ? '▾' : '▸'))
      head.push(h('button', {
        key: 'up',
        type: 'button',
        title: '上移',
        disabled: disabled || index === 0,
        style: index === 0 ? { ...S.iconButton, ...S.disabled } : S.iconButton,
        onClick: () => onMove(index, -1),
      }, '↑'))
      head.push(h('button', {
        key: 'down',
        type: 'button',
        title: '下移',
        disabled: disabled || index === total - 1,
        style: index === total - 1 ? { ...S.iconButton, ...S.disabled } : S.iconButton,
        onClick: () => onMove(index, 1),
      }, '↓'))
      head.push(h('button', {
        key: 'drop',
        type: 'button',
        title: '删除这一格',
        disabled,
        style: S.buttonDanger,
        onClick: () => onRemove(index),
      }, '×'))

      const body = []
      if (open) {
        if (piece.kind === 'literal') {
          body.push(h('div', { key: 'note', style: S.note },
            '字面值不来自模型：它是定义的一部分，模型改不了。'))
        }
        if (isVariable || isFlag) {
          const fields = [
            h(Field, { key: 'type', label: isFlag ? '类型（固定为 boolean）' : '类型' },
              isFlag
                ? h('div', { style: S.hint }, 'boolean')
                : h(Select, {
                  value: asString(piece.type, 'string'),
                  disabled,
                  options: PARAM_TYPES,
                  onChange: (next) => patch({ type: next }),
                })),
            h(Field, { key: 'required', label: '必填' },
              h(Checkbox, {
                checked: piece.required === true,
                disabled,
                label: '模型必须填',
                onChange: (next) => patch({ required: next }),
              })),
            h(Field, { key: 'default', label: '默认值（JSON 文本）' },
              h(TextInput, {
                mono: true,
                disabled,
                value: asString(piece.default),
                placeholder: isFlag ? 'false' : '留空表示没有默认值',
                onChange: (next) => patch({ default: next }),
              })),
          ]
          body.push(h('div', { key: 'fields', style: S.grid3 }, fields))
          if (isVariable && isArray) {
            body.push(h('div', { key: 'items', style: S.grid3 },
              h(Field, { label: '数组元素类型' },
                h(Select, {
                  value: asString(piece.items, 'string'),
                  disabled,
                  options: PARAM_ITEMS,
                  onChange: (next) => patch({ items: next }),
                }))))
          }
          body.push(h(Field, { key: 'desc', label: '说明（模型读这一行）' },
            h(TextInput, {
              value: asString(piece.description),
              disabled,
              placeholder: '这个参数是什么意思，接受什么样的值',
              onChange: (next) => patch({ description: next }),
            })))
          if (isFlag) {
            body.push(h(Field, {
              key: 'as',
              label: '为真时插入',
              hint: '多个 argv 元素用空格分隔；模型给 false 或不给时整格不出现。',
            }, h(TextInput, {
              mono: true,
              value: asString(piece.as),
              disabled,
              placeholder: '例如 --sort 或 --verbose',
              onChange: (next) => patch({ as: next }),
            })))
          } else {
            const rows = []
            if (piece.rawStdin !== true) {
              rows.push(h(Field, {
                key: 'prefix',
                label: '前缀（贴在这一格前面）',
                hint: '和值同属一个 argv 元素，例如 --glob=',
              }, h(TextInput, {
                mono: true,
                value: asString(piece.prefix),
                disabled,
                onChange: (next) => patch({ prefix: next }),
              })))
              rows.push(h(Field, {
                key: 'suffix',
                label: '后缀（贴在这一格后面）',
                hint: '同上，例如 .json',
              }, h(TextInput, {
                mono: true,
                value: asString(piece.suffix),
                disabled,
                onChange: (next) => patch({ suffix: next }),
              })))
              if (asString(piece.join) !== '' && isArray) {
                rows.push(h(Field, {
                  key: 'join',
                  label: '合并分隔符',
                  hint: '把数组连成一个 argv 元素',
                }, h(TextInput, {
                  mono: true,
                  value: asString(piece.join),
                  disabled,
                  onChange: (next) => patch({ join: next }),
                })))
              }
            }
            if (rows.length > 0) body.push(h('div', { key: 'prefixes', style: S.grid3 }, rows))

            const options = []
            if (isArray) {
              options.push(h(OptionRow, {
                key: 'join',
                title: '所有值挤成一格',
                detail: h('span', null, '传 ', code('[a,b]'), ' 得到一格 ', code('a,b'), '（分隔符在下面填）'),
                checked: asString(piece.join) !== '',
                disabled,
                onChange: (next) => patch({ join: next ? (asString(piece.join) || ',') : '' }),
              }))
              options.push(h(OptionRow, {
                key: 'repeat',
                title: '一个值占一格，有几个值就占几格',
                detail: h('span', null, '传 ', code('[a,b]'), ' 得到两格：', code('a'), ' ', code('b')),
                checked: piece.repeat === true,
                disabled,
                onChange: (next) => patch({ repeat: next }),
              }))
            }
            options.push(h(OptionRow, {
              key: 'json',
              title: '原样输出成 JSON 文本',
              detail: h('span', null, code('[1,2]'), ' 变成一格 ', code('[1,2]'), '，不会拆成 1 和 2'),
              checked: piece.json === true,
              disabled,
              onChange: (next) => patch({ json: next }),
            }))
            options.push(h(OptionRow, {
              key: 'omit',
              title: '没给值就整格不要',
              detail: '模型不传这个参数时不出现空串，而不是留一格空的',
              checked: piece.omitIfEmpty === true,
              disabled,
              onChange: (next) => patch({ omitIfEmpty: next }),
            }))
            options.push(h(OptionRow, {
              key: 'dash',
              title: '允许值以横杠开头',
              detail: h('span', null, '默认拦掉 ', code('--help'), ' 这类值，避免被当成程序的选项'),
              checked: piece.allowLeadingDash === true,
              disabled,
              onChange: (next) => patch({ allowLeadingDash: next }),
            }))
            options.push(h(OptionRow, {
              key: 'at',
              title: '允许值以 @ 开头',
              detail: h('span', null, '默认拦掉 ', code('@file'), '，避免程序把它当成参数文件'),
              checked: piece.allowResponseFile === true,
              disabled,
              onChange: (next) => patch({ allowResponseFile: next }),
            }))
            body.push(h('div', { key: 'opts', style: S.options },
              h('div', { style: S.optionsTitle }, '这个参数在命令行里长什么样'),
              ...options))
          }
        }
        if (piece.kind === 'stdin') {
          body.push(h('div', { key: 'note', style: S.note },
            'PowerShell 模式会自动这样做，不用再加一条。'
            + '脚本用 $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json 取值。'))
        }
      }

      return h('div', { key: piece.id, style: S.piece },
        h('div', { style: S.pieceHead }, ...head),
        body.length > 0 ? h('div', { style: S.pieceBody }, ...body) : null)
    }

    function PreviewStrip({ preview, mode }) {
      const chips = preview.argv.map((item, index) => {
        const ghost = item.absent === true || (item.kind === 'flag' && item.active !== true)
        const color = TONE[item.kind] ?? TONE.lit
        return h('span', {
          key: `${index}:${item.kind}:${item.text}`,
          title: item.notes ?? '',
          style: {
            ...S.chipBox,
            ...(ghost ? S.chipGhost : null),
            color,
            borderColor: ghost ? C.borderL2 : 'transparent',
          },
        },
        item.name ? h('b', { style: { fontWeight: 600, fontSize: 10.5 } }, item.name) : null,
        h('span', null, item.text))
      })

      const legend = [
        ['prog', '程序'],
        ['script', '脚本 / 命令文本'],
        ['lit', '字面值'],
        ['variable', '变量'],
        ['flag', '开关'],
        ['stdin', 'stdin'],
      ].map(([kind, label]) => h('span', { key: kind, style: S.legendItem },
        h('span', { style: { ...S.legendDot, background: TONE[kind] } }),
        label))

      const stdinRow = preview.stdin === null
        ? null
        : preview.stdin.kind === 'raw'
          ? h('div', { key: 'stdin', style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' } },
            h('span', { style: { ...S.hint, color: TONE.stdin } }, 'stdin →'),
            ...preview.stdin.names.map((name) => h('span', {
              key: name,
              style: { ...S.chipBox, color: TONE.stdin, borderColor: C.borderL1 },
            }, h('b', { style: { fontWeight: 600, fontSize: 10.5 } }, '原样'), h('span', null, name))),
            h('span', { style: { ...S.chipBox, ...S.chipEmpty } }, '这个值原样写进 stdin，不拆不改'))
          : h('div', { key: 'stdin', style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' } },
            h('span', { style: { ...S.hint, color: TONE.stdin } }, 'stdin →'),
            ...preview.stdin.names.map((name) => h('span', {
              key: name,
              style: { ...S.chipBox, color: TONE.stdin, borderColor: C.borderL1 },
            }, h('b', { style: { fontWeight: 600, fontSize: 10.5 } }, 'JSON 键'), h('span', null, name))),
            h('span', { style: { ...S.chipBox, ...S.chipEmpty } }, '一份 JSON 对象，键名就是上面这些'))

      return h('div', { style: S.panelBody },
        h('div', { style: S.legend }, ...legend,
          h('span', { key: 'ghost', style: S.legendItem }, '虚线框 = 可能没有')),
        h('div', { style: S.preview },
          chips.length > 0 ? chips : h('span', { style: S.previewEmpty }, '还没有任何 argv 元素')),
        stdinRow,
        h('div', { style: S.hint },
          `${preview.argv.filter((item) => item.absent !== true).length} 个 argv 元素`
          + '；每个框就是程序实际收到的一个元素，值由模型填，所以这里只显示形状。'))
    }

    // ------------------------------------------------------------- tool card

    function ToolCard({
      tool,
      index,
      total,
      disabled,
      savedAt,
      issues,
      onChange,
      onRemove,
      onMove,
      onDuplicate,
    }) {
      const [open, setOpen] = React.useState(index === 0)
      const [flagPreview, setFlagPreview] = React.useState({})
      const mine = issuesFor(issues, index)
      const errors = mine.filter((issue) => issue.severity !== 'warning')
      const warnings = mine.filter((issue) => issue.severity === 'warning')

      // The headline only follows the persisted name, so typing a new name does
      // not rename the card (and remount its inputs) on every keystroke.
      const committed = React.useRef(asString(tool.name))
      React.useEffect(() => { committed.current = asString(tool.name) }, [savedAt])

      const set = (fields) => onChange({ ...tool, ...fields })
      const mode = asString(tool.mode, 'executable')
      const pieces = piecesOf(tool).map((piece) => (
        piece.kind === 'flag' ? { ...piece, active: flagPreview[piece.id] === true } : piece
      ))
      const preview = previewOf(tool, pieces)
      const orphanCount = pieces.filter((piece) => piece.orphan === true).length

      const setPieces = (next) => onChange(applyPieces(tool, next))
      const updatePiece = (at, next) => setPieces(pieces.map((piece, i) => (i === at ? next : piece)))
      const removePiece = (at) => setPieces(pieces.filter((_, i) => i !== at))
      const movePiece = (at, delta) => {
        const target = at + delta
        if (target < 0 || target >= pieces.length) return
        const next = [...pieces]
        const [item] = next.splice(at, 1)
        next.splice(target, 0, item)
        setPieces(next)
      }
      const addPiece = (kind) => {
        const base = { id: `n${pieces.length}:${kind}`, kind }
        if (kind === 'literal') setPieces([...pieces, { ...base, text: '' }])
        else if (kind === 'stdin') setPieces([...pieces, { ...base }])
        else if (kind === 'flag') {
          setPieces([...pieces, {
            ...base, name: 'flag_name', as: '--flag', description: '', required: false,
          }])
        } else {
          setPieces([...pieces, {
            ...base, name: `param${pieces.length + 1}`, type: 'string', items: '',
            required: false, default: '', description: '',
            rawStdin: false, prefix: '', suffix: '', join: '',
            repeat: false, json: false, omitIfEmpty: false,
            allowLeadingDash: false, allowResponseFile: false,
          }])
        }
      }

      const modeRows = []
      if (mode === 'executable') {
        modeRows.push(h(Field, {
          key: 'exe',
          label: '可执行文件',
          hint: '写名字就按 PATH 找；写绝对路径就用那一份。',
        }, h(TextInput, {
          mono: true,
          disabled,
          value: asString(tool.executable),
          placeholder: 'C:/Software/Git/cmd/git.exe 或 git',
          onChange: (next) => set({ executable: next }),
        })))
      }
      if (mode === 'script') {
        modeRows.push(h(Field, {
          key: 'interp',
          label: '解释器',
          hint: '写绝对路径就用那一份（venv 选 venv 里的）；只写名字则按 PATH 找。',
        }, h(TextInput, {
          mono: true,
          disabled,
          value: asString(tool.interpreter),
          placeholder: 'C:/venvs/myproj/Scripts/python.exe 或 python',
          onChange: (next) => set({ interpreter: next }),
        })))
        modeRows.push(h(Field, {
          key: 'script',
          label: '脚本路径',
          hint: '这个文件本身不在插件里，改它要自己负责。',
        }, h(TextInput, {
          mono: true,
          disabled,
          value: asString(tool.script),
          placeholder: 'C:/Users/me/tools/report.py',
          onChange: (next) => set({ script: next }),
        })))
      }
      if (mode === 'bash' || mode === 'powershell') {
        modeRows.push(h(Field, {
          key: 'command',
          label: '命令文本（固定，模型改不了）',
          hint: mode === 'bash'
            ? '模型的值只经位置参数（"$@"）或环境变量进来，永远不会拼进这段文本。'
            : '参数只能走 stdin JSON：-Command 之后的东西会进命令文本，不是 $args。',
        }, h(TextArea, {
          disabled,
          value: asString(tool.command),
          rows: 4,
          placeholder: mode === 'bash' ? 'grep -rn -- "$@"' : '$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json',
          onChange: (next) => set({ command: next }),
        })))
      }

      const customCwd = typeof tool.cwd === 'string' && tool.cwd !== '' && tool.cwd !== '.'

      const diagnostics = errors.length === 0 && warnings.length === 0
        ? h('div', { style: S.ok }, '✓ 本地检查通过；保存后由宿主最终校验')
        : h('div', { style: S.issues },
          ...errors.map((issue) => h('div', { key: `e-${issue.path}` },
            `• ${issue.path}: ${issue.message}`)),
          ...warnings.map((issue) => h('div', {
            key: `w-${issue.path}`,
            style: { color: C.warning },
          }, `• ${issue.path}: ${issue.message}`)))

      return h('div', { style: open ? { ...S.card, ...S.cardOpen } : S.card },
        h('div', { style: S.cardHead, onClick: () => setOpen((value) => !value) },
          h('span', { style: S.twist }, open ? '▼' : '▶'),
          h('span', { style: S.cardName }, committed.current || '（未命名）'),
          asString(tool.name) !== committed.current
            ? h(Chip, { key: 'unsaved', tone: 'dirty' }, '未保存')
            : null,
          h(Chip, { key: 'mode', tone: 'mode' }, MODE_LABEL[mode] ?? mode),
          errors.length > 0 ? h(Chip, { key: 'err', tone: 'bad' }, `${errors.length} 处错误`) : null,
          tool.enabled === false ? h(Chip, { key: 'off' }, '已停用') : null,
          h('span', { key: 'grow', style: S.grow }),
          h('span', { onClick: (event) => event.stopPropagation(), style: { display: 'inline-flex' } },
            h(Switch, {
              checked: tool.enabled !== false,
              disabled,
              onChange: (next) => set({ enabled: next }),
            }))),
        open ? h('div', { style: S.cardBody },
          h(Panel, { title: '身份' },
            h('div', { style: S.grid2 },
              h(Field, {
                label: '工具名',
                hint: '小写字母开头，a-z 0-9 _；这是模型看到的工具名',
              }, h(TextInput, {
                mono: true,
                disabled,
                value: asString(tool.name),
                onChange: (next) => set({ name: next }),
              })),
              h(Field, {
                label: '标题（可选）',
                hint: '界面显示用，不进模型上下文',
              }, h(TextInput, {
                disabled,
                value: asString(tool.title),
                onChange: (next) => set({ title: next }),
              }))),
            h(Field, {
              label: '描述',
              hint: '模型据此决定是否调用：写清用途与边界',
            }, h(TextArea, {
              disabled,
              rows: 3,
              value: asString(tool.description),
              onChange: (next) => set({ description: next }),
            })),
            h(Field, {
              label: '何时使用（可选）',
              hint: '会追加到描述后面，作为 When to use 段落',
            }, h(TextArea, {
              disabled,
              rows: 2,
              value: asString(tool.whenToUse),
              onChange: (next) => set({ whenToUse: next }),
            }))),

          h(Panel, {
            title: '命令',
            meta: MODE_LABEL[mode] ?? mode,
          },
          h(Segmented, {
            value: mode,
            disabled,
            options: MODES.map((value) => ({ value, label: MODE_LABEL[value] })),
            onChange: (next) => set({ mode: next }),
          }),
          ...modeRows),

          h(Panel, { title: '执行预览', meta: '不执行，只是形状' }, h(PreviewStrip, { preview, mode })),

          h(Panel, {
            title: '命令片段',
            meta: `${pieces.filter((piece) => piece.orphan !== true).length} 格`,
          },
          h('div', { style: S.toolbar },
            h(Button, { kind: 'small', disabled, onClick: () => addPiece('literal') }, '＋ 字面值'),
            h(Button, { kind: 'small', disabled, onClick: () => addPiece('variable') }, '＋ 变量'),
            h(Button, { kind: 'small', disabled, onClick: () => addPiece('flag') }, '＋ 开关'),
            mode === 'powershell' ? null : h(Button, {
              kind: 'small',
              disabled,
              onClick: () => addPiece('stdin'),
            }, '＋ stdin（JSON）')),
          h('div', { style: S.pieces },
            ...pieces.map((piece, at) => h(PieceRow, {
              key: piece.id,
              piece,
              index: at,
              total: pieces.length,
              disabled,
              mode,
              onChange: (next) => {
                if (next.kind === 'flag' && next.active !== undefined) {
                  setFlagPreview((current) => ({ ...current, [next.id]: next.active === true }))
                }
                updatePiece(at, next)
              },
              onRemove: removePiece,
              onMove: movePiece,
            }))),
          orphanCount > 0
            ? h('div', { style: S.note },
              `有 ${orphanCount} 个参数没有出现在命令行里：把它们拖进「命令片段」，或者删掉对应变量。`)
            : null),

          h(Panel, { title: '执行' },
            h('div', { style: S.grid2 },
              h(Field, {
                label: '工作目录',
              }, h(Segmented, {
                value: customCwd ? 'custom' : 'session',
                disabled,
                options: [
                  { value: 'session', label: '会话目录' },
                  { value: 'custom', label: '指定路径' },
                ],
                onChange: (next) => set({ cwd: next === 'session' ? undefined : (asString(tool.cwd) || '/') }),
              })),
              h(Field, {
                label: '超时（毫秒）',
                hint: '1000 – 600000',
              }, h(NumberInput, {
                disabled,
                min: 1000,
                max: 600000,
                step: 1000,
                value: asNumber(tool.timeoutMs, 120000),
                onChange: (next) => set({ timeoutMs: next === '' ? undefined : Number(next) }),
              }))),
            customCwd
              ? h(Field, {
                label: '绝对路径',
                hint: '模型改不了这个路径',
              }, h(TextInput, {
                mono: true,
                disabled,
                value: asString(tool.cwd),
                placeholder: 'C:/work/project',
                onChange: (next) => set({ cwd: next }),
              }))
              : h('div', { style: S.hint }, '用会话当前的工作目录；想钉死就切到「指定路径」。'),
            h('div', { style: S.grid2 },
              h(Field, { label: '审批' }, h(Select, {
                value: asString(tool.approval, 'inherit'),
                disabled,
                options: APPROVALS,
                labels: APPROVAL_LABEL,
                onChange: (next) => set({ approval: next }),
              })),
              h(Field, {
                label: '并发',
                hint: 'exclusive：同一工具串行；parallel：允许重叠',
              }, h(Select, {
                value: asString(tool.concurrency, 'exclusive'),
                disabled,
                options: CONCURRENCY,
                labels: CONCURRENCY_LABEL,
                onChange: (next) => set({ concurrency: next }),
              }))),
            h('div', { style: S.grid2 },
              h(Field, {
                label: '输出解析',
                hint: 'json 会用 output.schema 校验',
              }, h(Select, {
                value: asString(tool.output?.parse, 'text'),
                disabled,
                options: PARSES,
                onChange: (next) => set({ output: { ...(isObject(tool.output) ? tool.output : {}), parse: next } }),
              })),
              h(Field, { label: '编码默认值' },
                h(Checkbox, {
                  checked: tool.encodingDefaults !== false,
                  disabled,
                  label: '自动注入 UTF-8 环境（python/java）',
                  onChange: (next) => set({ encodingDefaults: next }),
                }))),
          asString(tool.output?.parse, 'text') === 'json'
            ? h(Field, {
              label: '输出 schema（JSON Schema 子集，JSON 文本）',
              hint: '失败会报 OUTPUT_SCHEMA_MISMATCH',
            }, h(JsonField, {
              disabled,
              rows: 4,
              value: asString(tool.output?.schema) === '' ? undefined : tryParseJson(asString(tool.output?.schema)).value,
              placeholder: '{"type":"object","properties":{"count":{"type":"integer"}},"required":["count"],"additionalProperties":false}',
              onChange: (next) => set({
                output: { ...(isObject(tool.output) ? tool.output : {}), schema: next === undefined ? undefined : JSON.stringify(next) },
              }),
            }))
            : null),

          h(Panel, {
            title: '高级',
            meta: '固定值，不来自模型',
            last: true,
          },
          h(Field, { label: '环境变量' }, h(JsonField, {
            disabled,
            rows: 3,
            value: tool.env,
            placeholder: '{"NO_COLOR":"1"}',
            onChange: (next) => set({ env: next }),
          })),
          h(Field, {
            label: '凭据引用（credentials）',
            hint: '形如 [{"env":"GH_TOKEN","ref":"github_token"}]；值每次调用时解析，不落盘',
          }, h(JsonField, {
            disabled,
            rows: 3,
            value: tool.credentials,
            placeholder: '[{"env":"GH_TOKEN","ref":"github_token"}]',
            onChange: (next) => set({ credentials: next }),
          })),
          h(Field, { label: '调用示例（examples）' }, h(JsonField, {
            disabled,
            rows: 3,
            value: tool.examples,
            placeholder: '[{"name":"格式化一个配置文件","args":{"path":"./package.json"}}]',
            onChange: (next) => set({ examples: next }),
          }))),

          h('div', { style: S.toolbar },
            h(Button, { kind: 'small', disabled, onClick: () => onDuplicate(index) }, '复制'),
            h(Button, { kind: 'small', disabled: disabled || index === 0, onClick: () => onMove(index, -1) }, '↑ 上移'),
            h(Button, { kind: 'small', disabled: disabled || index === total - 1, onClick: () => onMove(index, 1) }, '↓ 下移'),
            h('span', { style: S.grow }),
            h(Button, { kind: 'danger', disabled, onClick: () => onRemove(index) }, '删除这个工具')),
          diagnostics)
        : null)
    }

    // ------------------------------------------------------------------ page

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
            onChange: (next) => setTool(index, next),
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
       * Exposed for `test/client.test.js` only. `piecesOf`/`applyPieces` are the
       * one conversion that could silently eat a field, so they are reachable
       * from a test harness instead of being trusted by inspection.
       */
      __internal: { piecesOf, applyPieces, previewOf, collectIssues, slotText },
    }
  },
})
