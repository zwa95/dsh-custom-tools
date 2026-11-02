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

    /**
     * The host's own UI kit. `@deepseek-ai/dsh-client-ui-primitives` is one of
     * the *predefined* modules of the shell's ModuleLoader registry (the same
     * place `react` comes from), so this require resolves without us declaring
     * any dependency.
     *
     * The plugin guide warns against it — the package ships no types and its
     * props can change without notice — so every control below is a thin
     * adapter instead of a direct call: the page keeps the props it always
     * had, and a missing export degrades to the plain DOM control rather than
     * throwing, because an exception inside a slot render blanks the whole
     * settings section.
     */
    const H = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives')
      } catch (error) {
        if (typeof console !== 'undefined') {
          console.warn('[dsh-custom-tools] host UI kit unavailable; using plain controls', error)
        }
        return null
      }
    })()

    /** Host exports are components (function or forwardRef object) or nothing. */
    const host = (name) => (H !== null && H[name] != null ? H[name] : null)

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
      borderL3: 'var(--dsw-alias-border-l3, rgba(127,127,127,0.28))',
      textPrimary: 'var(--dsw-alias-label-primary, inherit)',
      textSecondary: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
      textTertiary: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.7))',
      bg1: 'var(--dsw-alias-bg-layer-1, transparent)',
      bg2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
      bg3: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.12))',
      /**
       * `--dsw-alias-brand-primary` is NOT an accent: it resolves to the label
       * colour (near-white in dark, near-black in light) because the harness
       * fills primary buttons with it and puts inverted text on top. Painting a
       * control with it, then drawing a white knob or white label over it,
       * yields a featureless white blob (dark theme) or a black blob (light).
       * Chromatic accents come from `link`; filled buttons use the button pair.
       */
      brand: 'var(--dsw-alias-link, #4176e6)',
      buttonFill: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4176e6))',
      buttonLabel: 'var(--dsw-alias-label-primary-inverted, #fff)',
      /**
       * One literal grey, not a layer alias: off must stay legible on the card
       * (bg-layer-3 is #353638 against a #232324 card — invisible), and it has
       * to sit under a white knob in either theme.
       */
      switchOff: 'rgba(127,127,127,0.42)',
      knob: '#fff',
      error: 'var(--dsw-alias-state-error, #d33)',
      warning: 'var(--dsw-alias-state-warning, #c98a00)',
      success: 'var(--dsw-alias-state-success, #2f9e5f)',
      radius: 'var(--dsw-alias-radius-l2, 8px)',
      radiusSmall: 'var(--dsw-alias-radius-l1, 6px)',
      mono: '12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      monoFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
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
      // `minmax(0, 1fr)` is load-bearing: a plain `1fr` column is at least as
      // wide as its widest item, so one long unbreakable row (an argv chip, a
      // mono path) would push the settings panel into horizontal scroll.
      wrap: { display: 'grid', gap: 12, maxWidth: 900, minWidth: 0, gridTemplateColumns: 'minmax(0, 1fr)' },
      header: { display: 'grid', gap: 4 },
      titleRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 15, fontWeight: 600, color: C.textPrimary },
      lead: { margin: 0, fontSize: 12, color: C.textSecondary, lineHeight: 1.6 },
      toolbar: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      card: {
        display: 'grid',
        gap: 0,
        minWidth: 0,
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
      cardBody: { padding: '2px 12px 12px', borderTop: `1px solid ${C.borderL1}`, minWidth: 0 },
      panel: { padding: '10px 0', borderBottom: `1px solid ${C.borderL1}`, minWidth: 0 },
      panelLast: { padding: '10px 0 0', borderBottom: 'none' },
      panelHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
      panelTitle: { fontSize: 12, fontWeight: 600, color: C.textSecondary, letterSpacing: '.02em' },
      panelMeta: { fontSize: 11, color: C.textTertiary },
      panelBody: { display: 'grid', gap: 8, minWidth: 0 },
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, minWidth: 0 },
      grid3: {
        display: 'grid',
        gridTemplateColumns: 'minmax(120px, 1fr) minmax(120px, 1fr) minmax(160px, 1.5fr)',
        gap: 8,
        alignItems: 'start',
      },
      // Prefix/suffix rows hold two fields most of the time and three when the
      // array gets an explicit separator; auto-fit gives each one an equal share
      // of the row instead of pinning them to a three-column preset.
      gridFit: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, alignItems: 'start', minWidth: 0 },
      field: { display: 'grid', gap: 4, fontSize: 12, minWidth: 0, alignContent: 'start' },
      labelRow: { display: 'flex', alignItems: 'center', gap: 4, minHeight: 14 },
      label: { fontSize: 11, color: C.textTertiary },
      hint: { fontSize: 11, color: C.textTertiary, lineHeight: 1.5 },
      // The label row of a Checkbox sits at input height so the box lines up
      // with the Select and Input beside it in the same grid row.
      control: { display: 'flex', alignItems: 'center', minHeight: 32, fontSize: 12 },
      info: { display: 'inline-flex', alignItems: 'center', color: C.textTertiary, cursor: 'help' },
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
        minWidth: 0,
        minHeight: 64,
        padding: '5px 8px',
        borderRadius: C.radiusSmall,
        border: `0.5px solid ${C.borderL3}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        resize: 'vertical',
        outline: 'none',
      },
      areaMono: {
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        minHeight: 64,
        padding: '5px 8px',
        borderRadius: C.radiusSmall,
        border: `0.5px solid ${C.borderL3}`,
        background: 'transparent',
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
      menu: { minWidth: 160 },
      selectChevron: { display: 'inline-flex', alignItems: 'center', marginLeft: 2, opacity: 0.7 },
      // The host Button is content-sized; inside a field column it has to fill
      // the cell and push the chevron to the trailing edge, or a row of three
      // controls reads as three different widths.
      selectButton: { width: '100%', justifyContent: 'space-between' },
      selectLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
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
        background: C.buttonFill,
        color: C.buttonLabel,
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
        boxSizing: 'border-box',
        width: 34,
        height: 18,
        borderRadius: 999,
        background: C.switchOff,
        border: `1px solid ${C.borderL2}`,
        transition: 'background .12s',
      },
      switchKnob: {
        position: 'absolute',
        top: 1,
        left: 1,
        width: 14,
        height: 14,
        borderRadius: 999,
        background: C.knob,
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        transition: 'left .12s, background .12s',
      },
      preview: {
        display: 'flex',
        flexWrap: 'wrap',
        minWidth: 0,
        overflow: 'hidden',
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
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        padding: '1px 7px',
        borderRadius: 4,
        border: '1px solid transparent',
        background: 'rgba(255,255,255,.04)',
        whiteSpace: 'pre',
      },
      chipEmpty: { borderStyle: 'dashed', borderColor: C.borderL1, color: C.textTertiary },
      pieceHead: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
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
      row: { display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 },
      rowGrow: { flex: 1, minWidth: 0 },
      // One input plus an optional trailing button on a single grid row. A grid
      // (not a flex row) is what makes the field claim the whole line: the
      // kit's `Input` sizes itself against its container, and a flex item with
      // `width: auto` collapses it back to ~20 characters.
      shellRow: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap: 6,
        alignItems: 'center',
        minWidth: 0,
      },
      // The main-column panel is its own scroll box: the shell clips whatever
      // the panel draws (no page-level wheel target), so the panel has to own
      // `overflow-y` and take the column's full height. A centred max-width
      // keeps a 1200px column from looking like the editor was left-aligned.
      pageScroll: {
        height: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehavior: 'contain',
      },
      pageBody: {
        width: '100%',
        maxWidth: 1040,
        margin: '0 auto',
        padding: '22px 26px 44px',
        boxSizing: 'border-box',
        minWidth: 0,
      },
      // Dialog chrome. The kit `Modal` owns the overlay when it is there; these
      // styles are what the plain-DOM fallback paints, and they are also the
      // body rhythm used inside the kit dialog so both read the same.
      dialogBody: { display: 'grid', gap: 8, minWidth: 0 },
      dialogText: { margin: 0, fontSize: 12, color: C.textSecondary, lineHeight: 1.6 },
      dialogFoot: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' },
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'rgba(0, 0, 0, 0.45)',
      },
      dialog: {
        boxSizing: 'border-box',
        width: 'min(680px, 92vw)',
        maxHeight: '86vh',
        overflow: 'auto',
        display: 'grid',
        gap: 10,
        padding: '14px 16px',
        borderRadius: C.radiusSmall,
        border: `1px solid ${C.borderL2}`,
        background: C.bg1,
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.45)',
      },
      dialogHead: { display: 'flex', alignItems: 'center', gap: 8 },
      dialogTitle: { fontSize: 14, color: C.textPrimary },
      confirmBody: { display: 'grid', gap: 4, fontSize: 12, color: C.textSecondary, lineHeight: 1.6 },
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
      inherit: '跟随会话',
      always: '每次批准',
    }
    const CONCURRENCY = ['exclusive', 'parallel']
    const CONCURRENCY_LABEL = {
      exclusive: '串行',
      parallel: '并行',
    }
    const PARSES = ['text', 'json']
    const ARRAY_MODES = ['spread', 'join']
    const ARRAY_MODE_LABEL = {
      spread: '每值一格',
      join: '合并为一格',
    }
    const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'array']
    const PARAM_ITEMS = ['string', 'number', 'integer', 'boolean']

    const PIECE_KINDS = ['literal', 'variable', 'flag', 'stdin']
    const PIECE_LABEL = {
      literal: '字面值',
      variable: '变量',
      flag: 'flag',
      stdin: 'stdin',
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

    /**
     * Keys that mark a plain object as a tool definition rather than a wrapper
     * around them. Mirrors `TOOL_HINTS` in `src/config/document.js`: the page
     * and the CLI have to agree on what a pasted document is.
     */
    const TOOL_HINTS = [
      'name', 'title', 'description', 'whenToUse', 'mode', 'enabled',
      'executable', 'interpreter', 'script', 'command', 'args', 'cwd',
      'approval', 'concurrency', 'timeoutMs', 'env', 'encodingDefaults',
      'credentials', 'parameters', 'output', 'examples',
    ]

    const TEMPLATES = {
      executable: {
        name: 'my_tool',
        title: '',
        description: '运行外部程序并返回标准输出。',
        mode: 'executable',
        executable: 'git',
        args: [{ literal: 'status' }, { literal: '--short' }],
        parameters: {},
        output: { parse: 'text' },
      },
      script: {
        name: 'my_script',
        title: '',
        description: '用解释器执行脚本文件，参数以 argv 传入。',
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
        description: '运行固定 bash 脚本，参数以位置参数传入。',
        mode: 'bash',
        command: 'printf "%s\\n" "$@"',
        args: [{ arg: 'value' }],
        parameters: { value: { type: 'string', required: true } },
        output: { parse: 'text' },
      },
      powershell: {
        name: 'my_pwsh',
        title: '',
        description: '运行固定 PowerShell 脚本，参数以 stdin JSON 传入。',
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
        return { ok: false, message: '服务未返回结果（连接可能已断开）' }
      }
      if (result.ok === false) {
        const error = result.error ?? {}
        return { ok: false, message: `${asString(error.code, 'error')}: ${asString(error.message)}` }
      }
      return { ok: true, value: result.ok === true ? result.value : result }
    }

    function namespaceList(value) {
      // describe() answers with a wrapper (`{ namespaces: [...] }`, older builds
      // say `views`), not with the bare list — unwrap first, then fall back.
      const bag = value?.namespaces ?? value?.views ?? value
      if (Array.isArray(bag)) return bag
      if (isObject(bag)) return Object.values(bag)
      return []
    }

    function findNamespace(value, ns) {
      const list = namespaceList(value)
      const exact = list.find((entry) => isObject(entry)
        && (entry.ns === ns || entry.namespace === ns || entry.id === ns))
      if (exact !== undefined) return exact
      // A scoped entry reports `include:custom-tools`; accept the suffix so the
      // page keeps working whichever id the loader happens to hand out.
      return list.find((entry) => isObject(entry)
        && [entry.ns, entry.namespace, entry.id].some((candidate) => typeof candidate === 'string'
          && candidate.endsWith(`:${ns}`))) ?? null
    }

    const EMPTY_CONFIG = { tools: [], deferLoading: false }

    function readConfig(value) {
      if (!isObject(value)) return { ...EMPTY_CONFIG, tools: [] }
      const tools = Array.isArray(value.tools) ? value.tools.filter(isObject) : []
      return { tools: clone(tools), deferLoading: value.deferLoading === true }
    }

    // --------------------------------------------------------------- sidebar

    /**
     * The id shared by the sidebar icon and the main panel it opens — the same
     * pair the shipped Plugins page uses (`sidebar.panellist` id ↔ `main` key).
     */
    const PANEL_ID = 'custom-tools'

    /**
     * Whether the rail icon is shown is a *client* preference, not tool config:
     * it changes nothing the Host executes, and keeping it out of the plugin
     * config means toggling it can never invalidate a generation or bump the
     * settings revision. `localStorage` survives reloads and app restarts.
     */
    const SIDEBAR_PREF_KEY = 'dsh-custom-tools:sidebar-entry'
    const sidebarListeners = new Set()

    function readSidebarPref() {
      try {
        return globalThis.localStorage?.getItem(SIDEBAR_PREF_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeSidebarPref(next) {
      try {
        globalThis.localStorage?.setItem(SIDEBAR_PREF_KEY, next ? '1' : '0')
      } catch {
        // Private mode or a locked-down webview: the switch still works for
        // this session, it just will not remember the choice.
      }
      for (const listener of sidebarListeners) {
        try {
          listener(next)
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('[dsh-custom-tools] sidebar listener failed', error)
        }
      }
    }

    // ------------------------------------------------------------- documents

    /** A ```json fence pasted from a chat or a doc page is punctuation, not content. */
    const FENCE = /^```[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/u

    function stripFence(text) {
      const body = asString(text).replace(/^\uFEFF/u, '').trim()
      const match = FENCE.exec(body)
      return match === null ? body : match[1].trim()
    }

    /**
     * Read a pasted JSON document as tools — the same three shapes the CLI's
     * `add` takes: one definition, an array of them, or the `{ tools: [...] }`
     * bundle `export` writes. Import is where exports actually travel, so both
     * ends accepting all three is the whole point.
     */
    function parseToolDocument(text) {
      const body = stripFence(text)
      if (body === '') return { ok: false, error: '内容为空：粘贴一个工具定义 JSON。' }
      const parsed = tryParseJson(body)
      if (!parsed.ok) return { ok: false, error: '不是合法 JSON：检查引号、逗号与括号。' }
      const value = parsed.value
      let tools
      if (Array.isArray(value)) tools = value
      else if (isObject(value) && Array.isArray(value.tools)) tools = value.tools
      else if (isObject(value) && TOOL_HINTS.some((key) => value[key] !== undefined)) tools = [value]
      else {
        return {
          ok: false,
          error: '无法识别：需要单个工具对象、工具对象数组，或 {"tools": [...]}。',
        }
      }
      if (tools.length === 0) return { ok: false, error: '文档里没有工具定义。' }
      const foreign = tools.findIndex((tool) => !isObject(tool))
      if (foreign !== -1) return { ok: false, error: `第 ${foreign + 1} 项不是对象。` }
      const names = new Set()
      for (const tool of tools) {
        const name = asString(tool.name)
        if (name === '') continue
        if (names.has(name)) return { ok: false, error: `工具名 ${name} 在文档里出现了两次。` }
        names.add(name)
      }
      return { ok: true, tools: tools.map(clone) }
    }

    /** Which names an import would add versus overwrite, in document order. */
    function planImport(existing, incoming) {
      const known = new Map(existing.map((tool, index) => [asString(tool.name), index]))
      return incoming.map((tool) => {
        const name = asString(tool.name)
        const index = known.get(name)
        return { name, index: index === undefined ? -1 : index, replacing: index !== undefined }
      })
    }

    /** Apply a plan: replacements land in place, new tools append. */
    function applyImport(existing, incoming) {
      const tools = existing.map(clone)
      for (const tool of incoming) {
        const name = asString(tool.name)
        const index = tools.findIndex((entry) => asString(entry.name) === name)
        if (index === -1) tools.push(clone(tool))
        else tools[index] = clone(tool)
      }
      return tools
    }

    /** `navigator.clipboard` is absent outside a secure context; keep a fallback. */
    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard
          && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // fall through to the selection trick
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.left = '-9999px'
        document.body.appendChild(area)
        area.select()
        const copied = document.execCommand('copy')
        document.body.removeChild(area)
        return copied
      } catch {
        return false
      }
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
      // An array parameter must declare `items`; the page shows `string` when
      // the stored definition predates that rule, so write what it shows.
      if (type === 'array') parameter.items = asString(piece.items) || 'string'
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
        // An array is still one variable: the slot is where its values land, and
        // how many argv elements that becomes is the engine's business. Drawing
        // a second, ghosted copy said "repeat" but read as "two parameters".
        argv.push({ kind: 'variable', name: asString(piece.name), text: slotText(piece) })
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

        if (asString(tool.description).trim() === '') at('description', '描述不能为空：模型依靠它判断是否调用')

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
        // For a shell tool the field is optional, but an explicit empty string is
        // not "use the default" downstream — it becomes the program name — so
        // the card deletes the key instead and this rule catches hand-written JSON.
        if ((mode === 'bash' || mode === 'powershell') && tool.executable !== undefined
          && (typeof tool.executable !== 'string' || tool.executable.trim() === '')) {
          at('executable', 'shell 可执行文件要么留空（默认 bash / pwsh），要么写名字或绝对路径')
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
            if (!isObject(spec)) at(where, `flag 引用了未声明的参数 ${binding.flag}`)
            else if (spec.type !== 'boolean') at(where, `flag 必须引用 boolean 参数，${binding.flag} 是 ${spec.type}`)
            if (binding.as === undefined) at(where, 'flag 要写 as：值为 true 时插入的 argv 元素')
            if (binding.stdin !== undefined) at(where, 'flag 不能同时使用 stdin')
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
            at(`parameters.${paramName}`, `参数 ${paramName} 未出现在命令行中，传入也不会被使用`, 'warning')
          }
        }
      })

      return issues
    }

    function issuesFor(issues, index) {
      return issues.filter((issue) => issue.tool === index)
    }

    // -------------------------------------------------------------- controls

    /** The page's own tone words map onto the host Tag's `data-tone` set. */
    const CHIP_TONE = { dirty: 'warning', bad: 'danger', ok: 'success', mode: 'neutral' }

    function Chip({ children, tone }) {
      const Tag = host('Tag')
      if (Tag !== null) return h(Tag, { tone: CHIP_TONE[tone] ?? 'outline' }, children)
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

    /**
     * Long explanations belong behind a question mark: a paragraph of grey text
     * under every control turns the page into a wall while nobody reads it
     * twice. The host tooltip draws the popover; without the kit the text
     * degrades to a native `title` so nothing is lost.
     */
    function Info({ text }) {
      const Tip = host('Tooltip')
      const Icon = host('IconQuestionOutlineRegular')
      const glyph = Icon === null
        ? h('span', { style: { fontSize: 10, lineHeight: 1 } }, '?')
        : h(Icon, { size: 12 })
      if (Tip === null) return h('span', { title: text, style: S.info }, glyph)
      return h(Tip, { label: text, side: 'top', align: 'center', delayMs: 120, maxWidth: 320 },
        h('span', { style: S.info, tabIndex: 0, 'aria-label': text }, glyph))
    }

    function Field({ label, hint, info, children }) {
      return h('label', { style: S.field },
        h('span', { style: S.labelRow },
          h('span', { style: S.label }, label),
          info ? h(Info, { key: 'info', text: info }) : null),
        children,
        hint ? h('span', { style: S.hint }, hint) : null)
    }

    /**
     * Host `Input` takes every native input prop (`...rest` lands on the raw
     * `<input>`; `className` styles the wrapper), so only the mono face is
     * ours to add. Both extras are load-bearing inside a grid column:
     * `minWidth: 0` defeats the grid item's `min-width: auto`, and `width: 100%`
     * is what actually makes the input follow its column — an input left on
     * `width: auto` keeps its ~20-character intrinsic width and paints over the
     * field beside it.
     */
    const monoStyle = { fontFamily: C.monoFamily, minWidth: 0, width: '100%' }
    const plainInputStyle = { minWidth: 0, width: '100%' }

    function TextInput({ value, onChange, disabled, placeholder, mono }) {
      const Input = host('Input')
      if (Input !== null) {
        return h(Input, {
          value,
          disabled,
          placeholder,
          style: mono ? monoStyle : plainInputStyle,
          spellCheck: false,
          onChange: (event) => onChange(event.target.value),
        })
      }
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
      const Input = host('Input')
      if (Input !== null) {
        return h(Input, {
          type: 'number',
          min,
          max,
          step,
          value,
          disabled,
          placeholder,
          style: plainInputStyle,
          onChange: (event) => onChange(event.target.value),
        })
      }
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

    /**
     * The host has no textarea primitive (`InlineEditor` commits on Enter, which
     * would fight the page's explicit Save), so this stays a native element —
     * but painted with the same tokens as the inputs around it.
     */
    function TextArea({ value, onChange, disabled, placeholder, rows, mono, readOnly }) {
      return h('textarea', {
        style: mono === true ? S.areaMono : S.area,
        value,
        disabled,
        readOnly: readOnly === true,
        placeholder,
        rows: rows ?? 3,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
      })
    }

    /**
     * A native `<select>` cannot inherit the shell's styling (popup included),
     * so the closed control is an outline Button and the list is the host Menu.
     * `options` stays a plain value array and `labels` keeps the display names,
     * because `piecesOf` relies on the values being the persisted kind strings.
     */
    function Select({ value, onChange, options, disabled, labels, title }) {
      const Menu = host('Menu')
      const Base = host('Button')
      const Chevron = host('IconChevronDownOutlineRegular')
      const [open, setOpen] = React.useState(false)
      if (Menu === null || Base === null) {
        return h('select', {
          style: S.select,
          value,
          disabled,
          onChange: (event) => onChange(event.target.value),
        }, options.map((option) => h('option', { key: option, value: option },
          labels ? labels[option] ?? option : option)))
      }
      const shown = labels ? labels[value] ?? value : value
      return h(Menu, {
        open: open && disabled !== true,
        onClose: () => setOpen(false),
        portal: true,
        compact: true,
        autoFocus: true,
        align: 'start',
        selectedId: value,
        className: S.menu,
        items: options.map((option) => ({
          id: option,
          label: labels ? labels[option] ?? option : option,
        })),
        onSelect: (next) => {
          setOpen(false)
          onChange(next)
        },
        anchor: h(Base, {
          variant: 'outline',
          size: 'sm',
          disabled,
          title: title ?? shown,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: () => setOpen((current) => !current),
          style: S.selectButton,
        }, h('span', { key: 'value', style: S.selectLabel }, shown), Chevron !== null
          ? h('span', { key: 'chevron', style: S.selectChevron }, h(Chevron, { size: 12 }))
          : null),
      })
    }

    function disabledStyle(kind) {
      if (kind === 'primary') {
        // Outlined instead of a filled-but-faded button: `bg3` on the card is
        // ~1.1:1 in dark theme, so a disabled Save used to read as a smudge.
        return {
          ...S.buttonPrimary,
          background: 'transparent',
          color: C.textTertiary,
          borderColor: C.borderL2,
          cursor: 'default',
        }
      }
      if (kind === 'danger') return { ...S.buttonDanger, ...S.disabled }
      if (kind === 'small') return { ...S.buttonSmall, ...S.disabled }
      if (kind === 'icon') return { ...S.iconButton, ...S.disabled }
      return { ...S.button, ...S.disabled }
    }

    function Button({ kind, disabled, onClick, children, title, style }) {
      const Base = host('Button')
      if (Base !== null) {
        // Host variants: primary | ghost | outline | toolbar. Ghost has no
        // border, which reads as a label rather than a control, so only the
        // square tool buttons use it; `danger` keeps the outline and takes its
        // colour from the error token instead of a fill the kit lacks.
        // `size`/`padding` are forced for squares because the kit's `sm` is a
        // 28px-tall pill with 10px side padding, which would stretch a lone
        // glyph into a wide rectangle.
        const variant = kind === 'primary' ? 'primary' : kind === 'icon' ? 'ghost' : 'outline'
        const square = kind === 'icon' ? { width: 28, height: 28, padding: 0 } : null
        const tint = kind === 'danger' ? { color: C.error } : null
        const merged = square === null && tint === null && style == null
          ? undefined
          : { ...square, ...tint, ...style }
        return h(Base, { variant, size: 'sm', disabled, title, onClick, style: merged }, children)
      }
      const base = kind === 'primary' ? S.buttonPrimary
        : kind === 'small' ? S.buttonSmall
          : kind === 'danger' ? S.buttonDanger
            : kind === 'icon' ? S.iconButton
              : S.button
      return h('button', {
        type: 'button',
        title,
        style: disabled ? disabledStyle(kind) : { ...base, ...style },
        disabled,
        onClick,
      }, children)
    }

    // Square tool button: a host icon when the kit exports one, otherwise the
    // old text glyph, so a kit-less host still shows ↑ ↓ × instead of blanks.
    function iconButton(options) {
      const Icon = host(options.icon)
      const label = Icon == null ? options.glyph : h(Icon, { size: 14 })
      return h(Button, {
        key: options.key,
        kind: 'icon',
        title: options.title,
        disabled: options.disabled,
        onClick: options.onClick,
        style: options.danger ? { color: C.error } : undefined,
      }, label)
    }

    function Checkbox({ checked, onChange, label, disabled }) {
      const Base = host('Checkbox')
      if (Base !== null) return h(Base, { checked, onChange, label, disabled })
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
      const Base = host('Switch')
      if (Base !== null) return h(Base, { checked, onChange, disabled, label })
      return h('label', { style: disabled ? { ...S.switchWrap, ...S.disabled } : S.switchWrap },
        h('span', {
          style: checked ? { ...S.switchTrack, background: C.brand, borderColor: C.brand } : S.switchTrack,
        }, h('span', {
          style: checked ? { ...S.switchKnob, left: 17 } : S.switchKnob,
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

    function Segmented({ value, onChange, options, disabled, label }) {
      const Base = host('SegmentedControl')
      const id = React.useId()
      if (Base !== null) {
        return h(Base, { id, value, options, onChange, disabled, label })
      }
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
          style: S.areaMono,
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
            placeholder: '例如 --short',
            onChange: (next) => patch({ text: next }),
          })))
      } else if (piece.kind === 'stdin') {
        head.push(h('div', { key: 'fixed', style: { ...S.pieceGrow, ...S.hint } },
          '所有参数以一份 JSON 写入 stdin，键名为各变量名。'))
      } else if (piece.kind === 'flag') {
        head.push(h('div', { key: 'name', style: S.pieceGrow },
          h(TextInput, {
            mono: true,
            value: asString(piece.name),
            disabled,
            placeholder: '例如 sort_keys',
            onChange: (next) => patch({ name: next }),
          })))
      } else {
        head.push(h('div', { key: 'name', style: S.pieceGrow },
          h(TextInput, {
            mono: true,
            value: asString(piece.name),
            disabled,
            placeholder: '模型可见的参数名',
            onChange: (next) => patch({ name: next }),
          })))
      }

      head.push(iconButton({
        key: 'twist',
        icon: open ? 'IconChevronDownOutlineRegular' : 'IconChevronRightOutlineRegular',
        glyph: open ? '▾' : '▸',
        title: open ? '收起' : '展开',
        disabled,
        onClick: () => setOpen((value) => !value),
      }))
      head.push(iconButton({
        key: 'up',
        icon: 'IconChevronUpOutlineRegular',
        glyph: '↑',
        title: '上移',
        disabled: disabled || index === 0,
        onClick: () => onMove(index, -1),
      }))
      head.push(iconButton({
        key: 'down',
        icon: 'IconChevronDownOutlineRegular',
        glyph: '↓',
        title: '下移',
        disabled: disabled || index === total - 1,
        onClick: () => onMove(index, 1),
      }))
      head.push(iconButton({
        key: 'drop',
        icon: 'IconCloseOutlineRegular',
        glyph: '×',
        title: '删除该项',
        danger: true,
        disabled,
        onClick: () => onRemove(index),
      }))

      const body = []
      if (open) {
        if (piece.kind === 'literal') {
          body.push(h('div', { key: 'note', style: S.note },
            '固定文本，属于定义本身，模型不可修改。'))
        }
        if (isVariable || isFlag) {
          const fields = [
            h(Field, { key: 'type', label: '类型', info: isFlag ? 'flag 参数的取值恒为 boolean。' : undefined },
              isFlag
                ? h('div', { style: S.hint }, 'boolean')
                : h(Select, {
                  value: asString(piece.type, 'string'),
                  disabled,
                  options: PARAM_TYPES,
                  // Switching *into* array defaults to one argv per element.
                  // That is the shape nearly every CLI wants (`rg -g a -g b`);
                  // the engine's "no repeat" default joins with a space into a
                  // single argv, which is almost never what anyone means.
                  onChange: (next) => (next === 'array' && piece.type !== 'array'
                    ? patch({ type: 'array', repeat: true, items: asString(piece.items) || 'string' })
                    : patch({ type: next })),
                })),
            h(Field, { key: 'required', label: '必填', info: '为真时模型必须提供该参数。' },
              h('div', { style: S.control },
                h(Checkbox, {
                  checked: piece.required === true,
                  disabled,
                  label: '必须提供',
                  onChange: (next) => patch({ required: next }),
                }))),
            h(Field, { key: 'default', label: '默认值', info: 'JSON 字面量。留空表示没有默认值。' },
              h(TextInput, {
                mono: true,
                disabled,
                value: asString(piece.default),
                placeholder: isFlag ? 'false' : '无',
                onChange: (next) => patch({ default: next }),
              })),
          ]
          body.push(h('div', { key: 'fields', style: S.grid3 }, fields))
          if (isVariable && isArray) {
            body.push(h('div', { key: 'items', style: S.grid3 },
              h(Field, { label: '元素类型', info: '数组必须声明元素类型，模型的入参按它校验。' },
                h(Select, {
                  // `items` is required for an array; show the value the save
                  // will write even when the stored definition predates it.
                  value: asString(piece.items) || 'string',
                  disabled,
                  options: PARAM_ITEMS,
                  onChange: (next) => patch({ items: next }),
                }))))
          }
          body.push(h(Field, { key: 'desc', label: '说明', info: '作为参数描述提供给模型，说明取值含义。' },
            h(TextInput, {
              value: asString(piece.description),
              disabled,
              placeholder: '参数含义与取值',
              onChange: (next) => patch({ description: next }),
            })))
          if (isFlag) {
            body.push(h(Field, {
              key: 'as',
              label: '为真时插入',
              info: '可写多个 argv 元素，用空格分隔。模型传 false 或不传时该项不出现。',
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
                label: '前缀',
                info: '与该值同属一个 argv 元素，例如 --glob=',
              }, h(TextInput, {
                mono: true,
                value: asString(piece.prefix),
                disabled,
                onChange: (next) => patch({ prefix: next }),
              })))
              rows.push(h(Field, {
                key: 'suffix',
                label: '后缀',
                info: '与该值同属一个 argv 元素，例如 .json',
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
                  info: '把数组连接成单个 argv 元素。',
                }, h(TextInput, {
                  mono: true,
                  value: asString(piece.join),
                  disabled,
                  onChange: (next) => patch({ join: next }),
                })))
              }
            }
            if (rows.length > 0) body.push(h('div', { key: 'prefixes', style: S.gridFit }, rows))

            const options = []
            if (isArray) {
              // Two shapes cover nearly every CLI: one argv per element, or one
              // argv holding the whole list. The engine joins with a space when
              // nothing is set, so "合并为一格" shows the real separator (empty
              // means space) instead of inventing a comma the config never had.
              body.push(h('div', { key: 'arity', style: S.gridFit },
                h(Field, {
                  label: '数组输出',
                  info: '每值一格：一个元素占一个 argv。合并为一格：整组值进同一个 argv 元素。',
                }, h(Select, {
                  value: piece.repeat === true ? 'spread' : 'join',
                  disabled,
                  options: ARRAY_MODES,
                  labels: ARRAY_MODE_LABEL,
                  onChange: (next) => (next === 'spread'
                    ? patch({ repeat: true, join: '', joinSet: false })
                    : patch({ repeat: false })),
                })),
                piece.repeat === true
                  ? null
                  : h(Field, {
                    label: '分隔符',
                    info: '相邻值之间插入的文本；留空时用空格连接。',
                  }, h(TextInput, {
                    mono: true,
                    disabled,
                    value: asString(piece.join),
                    placeholder: '空格',
                    onChange: (next) => patch({ join: next, joinSet: next !== '' }),
                  }))))
            }
            options.push(h(OptionRow, {
              key: 'json',
              title: '按 JSON 输出',
              detail: h('span', null, code('[1,2]'), ' 变成一格 ', code('[1,2]'), '，不会拆成 1 和 2'),
              checked: piece.json === true,
              disabled,
              onChange: (next) => patch({ json: next }),
            }))
            options.push(h(OptionRow, {
              key: 'omit',
              title: '空值省略',
              detail: '模型不传该参数时不出现空串。',
              checked: piece.omitIfEmpty === true,
              disabled,
              onChange: (next) => patch({ omitIfEmpty: next }),
            }))
            options.push(h(OptionRow, {
              key: 'dash',
              title: '允许 - 开头',
              detail: h('span', null, '默认拦掉 ', code('--help'), ' 这类值，避免被当成程序的选项'),
              checked: piece.allowLeadingDash === true,
              disabled,
              onChange: (next) => patch({ allowLeadingDash: next }),
            }))
            options.push(h(OptionRow, {
              key: 'at',
              title: '允许 @ 开头',
              detail: h('span', null, '默认拦掉 ', code('@file'), '，避免程序把它当成参数文件'),
              checked: piece.allowResponseFile === true,
              disabled,
              onChange: (next) => patch({ allowResponseFile: next }),
            }))
            body.push(h('div', { key: 'opts', style: S.options },
              h('div', { style: S.optionsTitle }, '参数形态'),
              ...options))
          }
        }
        if (piece.kind === 'stdin') {
          body.push(h('div', { key: 'note', style: S.note },
            'PowerShell 模式已内置该项，无需重复添加。脚本内用 $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json 取值。'))
        }
      }

      return h('div', { key: piece.id, style: S.piece },
        h('div', { style: S.pieceHead }, ...head),
        body.length > 0 ? h('div', { style: S.pieceBody }, ...body) : null)
    }

    function PreviewStrip({ preview, mode }) {
      // One box per argv element, and only the text the program will actually
      // receive. A variable shows the slot shape (`<path>`, prefix and suffix
      // included) and a flag shows the literal it expands to (`--quiet`) in a
      // dashed box — the parameter name is the author's word, not the program's.
      // An array gets no special treatment: it is one variable, one slot.
      const chips = preview.argv.map((item, index) => {
        const conditional = item.kind === 'flag'
        const color = TONE[item.kind] ?? TONE.lit
        return h('span', {
          key: `${index}:${item.kind}:${item.text}`,
          // The chip can be clipped by `overflow: hidden` (a long command text
          // is one argv element), so the tooltip carries the whole element and
          // the note behind it.
          title: item.notes === undefined || item.notes === ''
            ? item.text
            : `${item.text} — ${item.notes}`,
          style: {
            ...S.chipBox,
            ...(conditional ? { borderStyle: 'dashed', borderColor: C.borderL2 } : null),
            color,
          },
        },
        h('span', null, item.text))
      })

      const legend = [
        ['prog', '程序'],
        ['script', '脚本 / 命令文本'],
        ['lit', '字面值'],
        ['variable', '变量'],
        ['flag', 'flag'],
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
            h('span', { style: { ...S.chipBox, ...S.chipEmpty } }, '该值原样写入 stdin，不拆分。'))
          : h('div', { key: 'stdin', style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' } },
            h('span', { style: { ...S.hint, color: TONE.stdin } }, 'stdin →'),
            ...preview.stdin.names.map((name) => h('span', {
              key: name,
              style: { ...S.chipBox, color: TONE.stdin, borderColor: C.borderL1 },
            }, h('b', { style: { fontWeight: 600, fontSize: 10.5 } }, 'JSON 键'), h('span', null, name))),
            h('span', { style: { ...S.chipBox, ...S.chipEmpty } }, '一份 JSON 对象，键名为上述变量名。'))

      return h('div', { style: S.panelBody },
        h('div', { style: S.legend }, ...legend,
          h('span', { key: 'ghost', style: S.legendItem }, '虚线：按条件出现')),
        h('div', { style: S.preview },
          chips.length > 0 ? chips : h('span', { style: S.previewEmpty }, '暂无 argv 元素')),
        stdinRow,
        h('div', { style: S.hint },
          `${preview.argv.length} 个 argv 元素`
          + '：每个框对应程序收到的一个参数；值由调用方提供，此处只呈现结构。'))
    }

    // ---------------------------------------------------------------- dialogs

    /**
     * The kit's `Modal` when the host ships one, a plain overlay otherwise. Only
     * the props the host's Modal actually takes are used — `open`, `title`,
     * `description`, `closeLabel`, `footer`, `onClose`, `children` — so an
     * older client that has the primitive gets the native dialog and a client
     * without it still gets a working one.
     */
    function Dialog({ open, title, description, wide, onClose, footer, children }) {
      const Modal = host('Modal')
      const body = h('div', { style: S.dialogBody }, children)
      if (Modal !== null) {
        return h(Modal, {
          open,
          title,
          description,
          closeLabel: '关闭',
          onClose,
          footer: footer === undefined ? null : h('div', { style: S.dialogFoot }, footer),
        }, wide ? h('div', { style: { width: 'min(720px, 88vw)', maxWidth: '100%' } }, body) : body)
      }
      if (!open) return null
      return h('div', { style: S.overlay, onClick: onClose },
        h('div', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
          style: wide ? { ...S.dialog, width: 'min(720px, 92vw)' } : S.dialog,
          onClick: (event) => event.stopPropagation(),
        },
        h('div', { style: S.dialogHead },
          h('strong', { style: S.dialogTitle }, title),
          h('span', { style: S.grow }),
          h(Button, { kind: 'icon', title: '关闭', onClick: onClose }, '✕')),
        description ? h('p', { style: S.dialogText }, description) : null,
        body,
        footer === undefined ? null : h('div', { style: S.dialogFoot }, footer)))
    }

    /**
     * Paste-a-document dialog. It never writes: parsing and confirmation happen
     * in the caller, so the same box serves "import into the page" and "replace
     * this one card".
     */
    function ImportDialog({ open, title, description, text, error, busy, submitLabel, onText, onCancel, onSubmit }) {
      return h(Dialog, {
        open,
        title,
        description,
        wide: true,
        onClose: onCancel,
        footer: [
          h(Button, { key: 'cancel', disabled: busy, onClick: onCancel }, '取消'),
          h(Button, { key: 'submit', kind: 'primary', disabled: busy, onClick: onSubmit }, submitLabel),
        ],
      },
      h(TextArea, {
        value: text,
        rows: 16,
        mono: true,
        disabled: busy,
        placeholder: '{\n  "name": "my_tool",\n  "description": "这个工具做什么",\n  "mode": "executable",\n  "executable": "git",\n  "args": [{ "literal": "status" }]\n}\n\n也可以粘贴数组，或 {"tools": [...]}。',
        onChange: onText,
      }),
      error ? h('p', { style: S.error }, error) : null,
      h('p', { style: S.hint }, '导入只改编辑区，点「保存」才会写入 profile。'))
    }

    /** Read-only JSON for one tool, with a copy button. */
    function ExportDialog({ open, title, text, onClose }) {
      const [copied, setCopied] = React.useState(false)
      React.useEffect(() => { if (!open) setCopied(false) }, [open])
      return h(Dialog, {
        open,
        title,
        description: '这段 JSON 可以直接给同事，粘贴进「从 JSON 导入」或 /custom-tools add 都能用。',
        wide: true,
        onClose,
        footer: [
          h(Button, {
            key: 'copy',
            kind: 'primary',
            onClick: async () => { setCopied(await copyText(text)) },
          }, copied ? '已复制' : '复制'),
          h(Button, { key: 'close', onClick: onClose }, '关闭'),
        ],
      },
      h(TextArea, { value: text, rows: 16, mono: true, readOnly: true, onChange: () => {} }))
    }

    /** Second look before an import overwrites something that already exists. */
    function ConfirmDialog({ open, title, description, detail, confirmLabel, onCancel, onConfirm }) {
      return h(Dialog, {
        open,
        title,
        description,
        onClose: onCancel,
        footer: [
          h(Button, { key: 'cancel', onClick: onCancel }, '取消'),
          h(Button, { key: 'confirm', kind: 'danger', onClick: onConfirm }, confirmLabel),
        ],
      },
      detail.length === 0 ? null : h('div', { style: S.confirmBody },
        ...detail.map((line) => h('div', { key: line }, line))))
    }

    /** "＋ 新增" — one button with the four modes behind it. */
    function AddMenu({ disabled, onPick }) {
      const Menu = host('Menu')
      const [open, setOpen] = React.useState(false)
      if (Menu === null) {
        return h('span', { style: S.row },
          ...MODES.map((mode) => h(Button, {
            key: mode,
            kind: 'small',
            disabled,
            onClick: () => onPick(mode),
          }, MODE_LABEL[mode])))
      }
      return h(Menu, {
        open: open && disabled !== true,
        // The kit renders `anchor` verbatim and never opens itself.
        anchor: h(Button, {
          kind: 'small',
          disabled,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: () => setOpen((current) => !current),
        }, '＋ 新增'),
        items: MODES.map((mode) => ({ id: mode, label: MODE_LABEL[mode] })),
        portal: true,
        compact: true,
        align: 'end',
        autoFocus: true,
        onClose: () => setOpen(false),
        onSelect: (id) => {
          setOpen(false)
          onPick(id)
        },
      })
    }

    // ------------------------------------------------------------- tool card

    /** Host chevrons when the kit is there; the ASCII pair is the fallback. */
    function twistIcon(open) {
      const Icon = host(open ? 'IconChevronDownOutlineRegular' : 'IconChevronRightOutlineRegular')
      return Icon !== null ? h(Icon, { size: 12 }) : (open ? '▼' : '▶')
    }

    /**
     * Card actions live behind one ⋯ instead of a footer row: the header is
     * where a card is grabbed, duplicated or dropped, and a destructive button
     * does not belong in the reading flow of every open card.
     *
     * `Menu` renders its `anchor` verbatim, so the button owns the open state
     * (the kit never opens itself). Separators carry an empty id because the
     * kit renders `item.id` as the separator's only child.
     */
    function CardMenu({
      open,
      disabled,
      canMoveUp,
      canMoveDown,
      onOpenChange,
      onExport,
      onImport,
      onDuplicate,
      onMoveUp,
      onMoveDown,
      onRemove,
    }) {
      const anchor = iconButton({
        icon: 'IconEllipsisOutlineRegular',
        glyph: '⋯',
        title: '更多操作',
        disabled,
        onClick: () => onOpenChange(!open),
      })
      const Base = host('Menu')
      if (Base === null) return anchor
      const items = [
        { id: 'export', label: '导出 JSON', disabled },
        { id: 'import', label: '从 JSON 导入…', disabled },
        { id: '', type: 'separator' },
        { id: 'duplicate', label: '复制', disabled },
        { id: 'up', label: '上移', disabled: disabled || canMoveUp !== true },
        { id: 'down', label: '下移', disabled: disabled || canMoveDown !== true },
        { id: '', type: 'separator' },
        { id: 'remove', label: '删除', danger: true, disabled },
      ]
      const actions = {
        export: onExport,
        import: onImport,
        duplicate: onDuplicate,
        up: onMoveUp,
        down: onMoveDown,
        remove: onRemove,
      }
      return h(Base, {
        open,
        anchor,
        items,
        portal: true,
        compact: true,
        align: 'end',
        autoFocus: true,
        onClose: () => onOpenChange(false),
        onSelect: (id) => {
          onOpenChange(false)
          const run = actions[id]
          if (run) run()
        },
      })
    }

    function ToolCard({
      tool,
      index,
      total,
      names,
      disabled,
      savedAt,
      issues,
      onChange,
      onRemove,
      onMove,
      onDuplicate,
      onReplace,
    }) {
      // Every card starts folded: the page is a list to scan first and open
      // second, and an expanded card pushes the rest of the list off-screen.
      const [open, setOpen] = React.useState(false)
      const [flagPreview, setFlagPreview] = React.useState({})
      const [menuOpen, setMenuOpen] = React.useState(false)
      // Card-level JSON in/out. `pending` holds a parsed definition that is
      // waiting for the overwrite confirmation.
      const [exportOpen, setExportOpen] = React.useState(false)
      const [importOpen, setImportOpen] = React.useState(false)
      const [importText, setImportText] = React.useState('')
      const [importError, setImportError] = React.useState('')
      const [pending, setPending] = React.useState(null)
      const mine = issuesFor(issues, index)
      const errors = mine.filter((issue) => issue.severity !== 'warning')
      const warnings = mine.filter((issue) => issue.severity === 'warning')

      // The headline only follows the persisted name, so typing a new name does
      // not rename the card (and remount its inputs) on every keystroke.
      const committed = React.useRef(asString(tool.name))
      React.useEffect(() => { committed.current = asString(tool.name) }, [savedAt])

      const set = (fields) => onChange({ ...tool, ...fields })
      // For a shell tool, `executable` is the shell binary and an *absent* field
      // means "use the default". Writing '' instead would run the empty name,
      // so a blank box deletes the key rather than storing an empty string.
      const setShellExecutable = (next) => {
        const copy = { ...tool }
        if (next.trim() === '') delete copy.executable
        else copy.executable = next
        onChange(copy)
      }
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

      // ---------------------------------------------------- json in and out
      const openImport = () => {
        setImportText('')
        setImportError('')
        setPending(null)
        setImportOpen(true)
      }

      const submitImport = () => {
        const parsed = parseToolDocument(importText)
        if (parsed.ok !== true) {
          setImportError(parsed.error)
          return
        }
        if (parsed.tools.length !== 1) {
          setImportError(`一张卡片一次只接收 1 个工具定义；粘贴的文档里有 ${parsed.tools.length} 个，请到页面右上角整份导入。`)
          return
        }
        const next = parsed.tools[0]
        // A definition without a name inherits the card's, so "export, edit a
        // field, paste back" does not force re-typing the name.
        if (asString(next.name) === '') next.name = asString(tool.name)
        const wanted = asString(next.name)
        const elsewhere = names.some((name, position) => position !== index && asString(name) === wanted)
        if (wanted !== '' && elsewhere) {
          setImportError(`工具名 ${wanted} 已被另一个工具使用。`)
          return
        }
        setImportError('')
        setImportOpen(false)
        setPending({ tool: next, name: wanted })
      }

      const confirmReplace = () => {
        if (pending === null) return
        onReplace(index, pending.tool)
        setPending(null)
      }

      const modeRows = []
      if (mode === 'executable') {
        modeRows.push(h(Field, {
          key: 'exe',
          label: '可执行文件',
          info: '只写名字时按 PATH 查找；绝对路径按原样使用。',
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
          info: '只写名字时按 PATH 查找；绝对路径按原样使用（venv 请填 venv 内的解释器）。',
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
          info: '脚本文件由你维护，插件不会改动它。',
        }, h(TextInput, {
          mono: true,
          disabled,
          value: asString(tool.script),
          placeholder: 'C:/Users/me/tools/report.py',
          onChange: (next) => set({ script: next }),
        })))
      }
      if (mode === 'bash' || mode === 'powershell') {
        const shell = mode === 'bash' ? 'bash' : 'pwsh'
        const hasShell = asString(tool.executable) !== ''
        modeRows.push(h(Field, {
          key: 'shell-exe',
          label: mode === 'bash' ? 'Bash 可执行文件' : 'PowerShell 可执行文件',
          info: `留空则用 PATH 上的 ${shell}：`
            + (mode === 'bash'
              ? 'Windows 上会自动找 Git Bash / MSYS2（System32 里的 WSL 启动器会被跳过）。'
              : '找不到 pwsh 时回退到 Windows PowerShell 5.1。')
            + ' 也可以填绝对路径，指向特定安装。',
        }, h('div', {
          style: hasShell
            ? { ...S.shellRow, gridTemplateColumns: 'minmax(0, 1fr) auto' }
            : S.shellRow,
        },
        h(TextInput, {
          mono: true,
          disabled,
          value: asString(tool.executable),
          placeholder: mode === 'bash'
            ? 'C:/Program Files/Git/bin/bash.exe'
            : 'C:/Program Files/PowerShell/7/pwsh.exe',
          onChange: (next) => setShellExecutable(next),
        }),
        hasShell
          ? h(Button, { kind: 'small', disabled, onClick: () => setShellExecutable('') }, '用默认')
          : null)))
        modeRows.push(h(Field, {
          key: 'command',
          label: '命令文本',
          info: mode === 'bash'
            ? '固定文本，模型不可修改。参数只经位置参数（"$@"）或环境变量传入，不会拼接进这段文本。'
            : '固定文本，模型不可修改。参数经 stdin 的 JSON 传入；-Command 之后的文本不属于 $args。',
        }, h(TextArea, {
          disabled,
          mono: true,
          value: asString(tool.command),
          rows: 4,
          placeholder: mode === 'bash' ? 'grep -rn -- "$@"' : '$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json',
          onChange: (next) => set({ command: next }),
        })))
      }

      const customCwd = typeof tool.cwd === 'string' && tool.cwd !== '' && tool.cwd !== '.'

      const diagnostics = errors.length === 0 && warnings.length === 0
        ? h('div', { style: S.ok }, '校验通过，保存后由宿主确认')
        : h('div', { style: S.issues },
          ...errors.map((issue) => h('div', { key: `e-${issue.path}` },
            `• ${issue.path}: ${issue.message}`)),
          ...warnings.map((issue) => h('div', {
            key: `w-${issue.path}`,
            style: { color: C.warning },
          }, `• ${issue.path}: ${issue.message}`)))

      return h('div', { style: open ? { ...S.card, ...S.cardOpen } : S.card },
        h('div', { style: S.cardHead, onClick: () => setOpen((value) => !value) },
          h('span', { style: S.twist }, twistIcon(open)),
          h('span', { style: S.cardName }, committed.current || '未命名'),
          asString(tool.name) !== committed.current
            ? h(Chip, { key: 'unsaved', tone: 'dirty' }, '未保存')
            : null,
          h(Chip, { key: 'mode', tone: 'mode' }, MODE_LABEL[mode] ?? mode),
          errors.length > 0 ? h(Chip, { key: 'err', tone: 'bad' }, `${errors.length} 处错误`) : null,
          tool.enabled === false ? h(Chip, { key: 'off' }, '已停用') : null,
          h('span', { key: 'grow', style: S.grow }),
          h('span', {
            onClick: (event) => event.stopPropagation(),
            style: { display: 'inline-flex', alignItems: 'center', gap: 4 },
          },
          h(CardMenu, {
            key: 'menu',
            open: menuOpen,
            disabled,
            canMoveUp: index > 0,
            canMoveDown: index < total - 1,
            onOpenChange: setMenuOpen,
            onExport: () => setExportOpen(true),
            onImport: openImport,
            onDuplicate: () => onDuplicate(index),
            onMoveUp: () => onMove(index, -1),
            onMoveDown: () => onMove(index, 1),
            onRemove: () => onRemove(index),
          }),
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
                info: '模型看到的工具名。小写字母开头，可用 a-z、0-9、_。',
              }, h(TextInput, {
                mono: true,
                disabled,
                value: asString(tool.name),
                onChange: (next) => set({ name: next }),
              })),
              h(Field, {
                label: '标题',
                info: '可选。仅用于界面显示，不进入模型上下文。',
              }, h(TextInput, {
                disabled,
                value: asString(tool.title),
                onChange: (next) => set({ title: next }),
              }))),
            h(Field, {
              label: '描述',
              info: '模型据此判断是否调用，需写清用途与边界。',
            }, h(TextArea, {
              disabled,
              rows: 3,
              value: asString(tool.description),
              onChange: (next) => set({ description: next }),
            })),
            h(Field, {
              label: '何时使用',
              info: '可选。追加到描述末尾，作为 When to use 段落。',
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

          h(Panel, { title: '执行预览' }, h(PreviewStrip, { preview, mode })),

          h(Panel, {
            title: '命令片段',
            meta: `${pieces.filter((piece) => piece.orphan !== true).length} 项`,
          },
          h('div', { style: S.toolbar },
            h(Button, { kind: 'small', disabled, onClick: () => addPiece('literal') }, '＋ 字面值'),
            h(Button, { kind: 'small', disabled, onClick: () => addPiece('variable') }, '＋ 变量'),
            h(Button, { kind: 'small', disabled, onClick: () => addPiece('flag') }, '＋ flag'),
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
              `${orphanCount} 个参数未出现在命令行中：加入「命令片段」，或删除对应变量。`)
            : null),

          h(Panel, { title: '执行' },
            h('div', { style: S.grid2 },
              h(Field, {
                label: '工作目录',
                info: '默认跟随会话当前目录；选择「指定路径」后可填固定路径，模型不可修改。',
              }, h(Segmented, {
                value: customCwd ? 'custom' : 'session',
                disabled,
                options: [
                  { value: 'session', label: '会话目录' },
                  { value: 'custom', label: '指定路径' },
                ],
                // Switching to "custom" has to write a value that the mode test
                // above treats as custom. Carrying the current cwd over would be
                // a no-op while it still reads `'.'`, so the segment would
                // appear dead until something else made the card dirty.
                onChange: (next) => set({ cwd: next === 'session' ? '.' : (customCwd ? asString(tool.cwd) : '/') }),
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
                info: '固定路径，模型不可修改。',
              }, h(TextInput, {
                mono: true,
                disabled,
                value: asString(tool.cwd),
                placeholder: 'C:/work/project',
                onChange: (next) => set({ cwd: next }),
              }))
              : null,
            h('div', { style: S.grid2 },
              h(Field, {
                label: '审批',
                info: '跟随会话：按会话的审批设置；每次批准：每次调用都要确认。',
              }, h(Select, {
                value: asString(tool.approval, 'inherit'),
                disabled,
                options: APPROVALS,
                labels: APPROVAL_LABEL,
                onChange: (next) => set({ approval: next }),
              })),
              h(Field, {
                label: '并发',
                info: '串行：同一工具不并发；并行：允许重叠调用。',
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
                info: 'json 输出会按 output.schema 校验。',
              }, h(Select, {
                value: asString(tool.output?.parse, 'text'),
                disabled,
                options: PARSES,
                onChange: (next) => set({ output: { ...(isObject(tool.output) ? tool.output : {}), parse: next } }),
              })),
              h(Field, { label: '编码', info: '为 python / java 子进程注入 UTF-8 相关环境变量。' },
                h('div', { style: S.control },
                  h(Checkbox, {
                    checked: tool.encodingDefaults !== false,
                    disabled,
                    label: '注入 UTF-8 环境变量',
                    onChange: (next) => set({ encodingDefaults: next }),
                  })))),
          asString(tool.output?.parse, 'text') === 'json'
            ? h(Field, {
              label: '输出 schema',
              info: 'JSON Schema 子集，以 JSON 文本填写；校验失败报 OUTPUT_SCHEMA_MISMATCH。',
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
            meta: '静态值，模型不可改',
            last: true,
          },
          h(Field, { label: '环境变量', info: '附加到子进程的固定环境变量。' }, h(JsonField, {
            disabled,
            rows: 3,
            value: tool.env,
            placeholder: '{"NO_COLOR":"1"}',
            onChange: (next) => set({ env: next }),
          })),
          h(Field, {
            label: '凭据引用',
            info: '形如 [{"env":"GH_TOKEN","ref":"github_token"}]；每次调用时解析，不写入磁盘。',
          }, h(JsonField, {
            disabled,
            rows: 3,
            value: tool.credentials,
            placeholder: '[{"env":"GH_TOKEN","ref":"github_token"}]',
            onChange: (next) => set({ credentials: next }),
          })),
          h(Field, { label: '调用示例', info: '给模型参考的示例调用，不影响执行。' }, h(JsonField, {
            disabled,
            rows: 3,
            value: tool.examples,
            placeholder: '[{"name":"格式化一个配置文件","args":{"path":"./package.json"}}]',
            onChange: (next) => set({ examples: next }),
          }))),

          diagnostics)
        : null,

        // JSON in/out dialogs sit outside the folded body: exporting a folded
        // card is the common case.
        h(ExportDialog, {
          key: 'export-dialog',
          open: exportOpen,
          title: `导出 ${asString(tool.name) || '未命名工具'}`,
          text: JSON.stringify(applyPieces(tool, piecesOf(tool)), null, 2),
          onClose: () => setExportOpen(false),
        }),
        h(ImportDialog, {
          key: 'import-dialog',
          open: importOpen,
          title: `从 JSON 导入到 ${asString(tool.name) || '未命名工具'}`,
          description: '粘贴一个工具对象，整份替换这张卡片的定义。',
          text: importText,
          error: importError,
          busy: false,
          submitLabel: '导入',
          onText: (next) => { setImportText(next); setImportError('') },
          onCancel: () => setImportOpen(false),
          onSubmit: submitImport,
        }),
        pending === null ? null : h(ConfirmDialog, {
          key: 'confirm-dialog',
          open: true,
          title: `用粘贴的定义覆盖「${pending.name}」？`,
          description: '这张卡片的当前定义会被整份替换；改动仍只在编辑区，点「保存」才写入 profile。',
          detail: [
            `名称：${pending.name}`,
            `模式：${MODE_LABEL[asString(pending.tool.mode, 'executable')] ?? asString(pending.tool.mode)}`,
          ],
          confirmLabel: '覆盖定义',
          onCancel: () => { setPending(null); setImportOpen(true) },
          onConfirm: confirmReplace,
        }))
    }

    // ------------------------------------------------------------------ page

    /**
     * The rail glyph for the sidebar entry. The shipped Plugins page renders
     * `IconPluginPinwheelOutlineRegular` the same way: take the size the owner
     * passes and let `currentColor` follow the row's active state.
     */
    function SidebarGlyph({ size }) {
      const Icon = host('IconSlidersTwoOutlineRegular')
      if (Icon !== null) return h(Icon, { size: size ?? 16 })
      return h('svg', {
        width: size ?? 16,
        height: size ?? 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
      },
      h('path', { d: 'M2.5 4.5h11M2.5 11.5h11' }),
      h('circle', { cx: 5.5, cy: 4.5, r: 1.6 }),
      h('circle', { cx: 10.5, cy: 11.5, r: 1.6 }))
    }

    /**
     * The same editor as the settings section, dropped into the main column.
     * The settings sheet is ~600px wide and owns its own chrome; the main panel
     * is the whole column, so the page wrapper only adds breathing room and the
     * editor draws itself once (no second heading, no second save row).
     *
     * The column clips its children, so the panel owns the scroll box. Its
     * height cannot come from `height: 100%` — the slot host does not promise a
     * definite height for the child — so it is measured from the viewport and
     * kept in step with resizes.
     */
    function makeSidebarPage(SectionPage) {
      return function SidebarPage() {
        const ref = React.useRef(null)

        React.useEffect(() => {
          const node = ref.current
          if (!node || typeof globalThis.innerHeight !== 'number') return undefined
          const fit = () => {
            const rect = node.getBoundingClientRect()
            // Before layout the box sits at the origin; measuring then would
            // size the panel to the whole viewport and it would never overflow.
            if (rect.top < 8) return
            const available = globalThis.innerHeight - rect.top
            if (available > 120) node.style.height = `${Math.round(available)}px`
          }
          // First frame is not always laid out yet, so measure on the next one.
          const raf = typeof globalThis.requestAnimationFrame === 'function'
            ? globalThis.requestAnimationFrame(() => fit())
            : globalThis.setTimeout(fit, 16)
          const observer = typeof globalThis.ResizeObserver === 'function'
            ? new globalThis.ResizeObserver(fit)
            : null
          if (observer && node.parentElement) observer.observe(node.parentElement)
          globalThis.addEventListener?.('resize', fit)
          return () => {
            if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(raf)
            else globalThis.clearTimeout?.(raf)
            observer?.disconnect()
            globalThis.removeEventListener?.('resize', fit)
          }
        }, [])

        return h('div', {
          ref,
          // Focusable so keyboard scrolling (PageDown/Space) works once the
          // panel is clicked — the column itself is not a tab stop.
          tabIndex: 0,
          role: 'region',
          'aria-label': '自定义工具',
          style: S.pageScroll,
        },
          h('div', { style: S.pageBody },
            h(SectionPage, { mode: 'page' })))
      }
    }

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

      return function SectionPage(props) {
        // 'page' means the main-column panel: wider, and it must not draw the
        // sheet's second toolbar — the footer row is the only save surface there.
        const pageMode = props?.mode === 'page'
        const [phase, setPhase] = React.useState('loading')
        const [problem, setProblem] = React.useState('')
        const [banner, setBanner] = React.useState(null)
        const [draft, setDraft] = React.useState(null)
        const [saved, setSaved] = React.useState(null)
        const [revision, setRevision] = React.useState(undefined)
        const namespace = React.useRef(NS)
        const [busy, setBusy] = React.useState(false)
        // `savedAt` bumps on every successful load/save: cards use it to know
        // when the persisted name changed and the headline may be redrawn.
        const [savedAt, setSavedAt] = React.useState(0)
        // Row identity for React keys. Keying a card by its *name* remounts the
        // whole card on every keystroke, which steals focus from the name input.
        const rowIds = React.useRef([])
        const nextRowId = React.useRef(1)
        // Page-level JSON import: the dialog text, its parse error, and the plan
        // waiting for an "overwrite these" confirmation.
        const [importOpen, setImportOpen] = React.useState(false)
        const [importText, setImportText] = React.useState('')
        const [importError, setImportError] = React.useState('')
        const [pendingImport, setPendingImport] = React.useState(null)
        // The rail entry is a client preference, not tool config: toggling it
        // must not touch the settings revision, so it lives beside the draft
        // instead of inside it.
        const [sidebarOn, setSidebarOn] = React.useState(readSidebarPref)

        async function load() {
          setPhase('loading')
          setProblem('')
          try {
            const api = settings()
            if (!api || typeof api.describe !== 'function') {
              setPhase('error')
              setProblem('当前客户端未挂载 remote.settings，无法读写插件配置。')
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
              setProblem(`设置文档中没有命名空间 ${NS}：插件未启用或加载失败。`)
              return
            }
            namespace.current = asString(view.ns ?? view.namespace ?? view.id, NS)
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

        // Whole-page JSON import. `rowIds` is index-parallel to `tools`, so a
        // replacement keeps its row id and only appended tools get new ones —
        // otherwise every imported card would remount.
        const commitImport = (incoming) => {
          const next = applyImport(config.tools, incoming)
          const ids = [...rowIds.current]
          while (ids.length < next.length) ids.push(nextRowId.current++)
          rowIds.current = ids.slice(0, next.length)
          const added = next.length - config.tools.length
          edit({ ...config, tools: next })
          setImportOpen(false)
          setBanner({
            tone: 'ok',
            title: '已导入到编辑区。',
            text: added > 0
              ? `新增 ${added} 个工具；点「保存」写入 profile。`
              : '覆盖了已有定义；点「保存」写入 profile。',
          })
        }

        const openImport = () => {
          setImportText('')
          setImportError('')
          setPendingImport(null)
          setImportOpen(true)
        }

        const importTools = () => {
          const parsed = parseToolDocument(importText)
          if (parsed.ok !== true) {
            setImportError(parsed.error)
            return
          }
          const plan = planImport(config.tools, parsed.tools)
          const replacing = plan.filter((entry) => entry.replacing === true)
          if (replacing.length === 0) {
            commitImport(parsed.tools)
            return
          }
          // Close the paste box so the confirmation is the only thing on screen;
          // cancelling reopens it with the text still in place.
          setImportOpen(false)
          setPendingImport({ tools: parsed.tools, names: replacing.map((entry) => entry.name) })
        }

        const save = async () => {
          if (busy || revision === undefined) return
          if (errorCount > 0) {
            setBanner({
              tone: 'bad',
              title: '校验未通过，未提交：',
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
            // The settings document comes back schema-normalised, so a tool the
            // user never touched already carries `repeat: false`, `json: false`,
            // `required: false` and friends. Writing those back would bury the
            // definition in defaults on every save, so rebuild each tool's
            // args/parameters from its pieces first — that pass only emits the
            // keys that carry meaning.
            const tools = config.tools.map((tool) => applyPieces(tool, piecesOf(tool)))
            const ops = [
              { op: 'set', path: ['tools'], value: tools },
              { op: 'set', path: ['deferLoading'], value: config.deferLoading === true },
            ]
            const result = unwrap(await api.mutate(namespace.current, ops, revision))
            if (!result.ok) {
              setBanner({
                tone: 'bad',
                title: '保存失败：',
                text: /conflict/u.test(result.message)
                  ? `${result.message}（配置已在别处更新，请先重新读取）`
                  : result.message,
              })
            } else {
              setBanner({
                tone: 'ok',
                title: '已保存。',
                text: '后续调用使用新定义；进行中的调用沿用启动时的版本。',
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
          h('div', { key: 'header', style: pageMode ? { ...S.header, paddingTop: 0 } : S.header },
            h('div', { key: 't', style: S.titleRow },
              h('h3', { key: 'title', style: pageMode ? { ...S.title, fontSize: 19 } : S.title }, '自定义工具'),
              h(Chip, { key: 'rev' }, revision === undefined ? 'revision …' : `revision ${revision}`),
              dirty ? h(Chip, { key: 'dirty', tone: 'dirty' }, '未保存') : null,
              errorCount > 0 ? h(Chip, { key: 'bad', tone: 'bad' }, `${errorCount} 处错误`) : null,
              dirty ? null : h(Chip, { key: 'clean', tone: 'ok' }, '已同步')),
            h('p', { key: 'lead', style: S.lead },
              '把本机程序、脚本或 shell 命令声明成工具。模型只能提供参数值；程序、命令文本、工作目录与环境变量名'
              + '都来自定义，工具以宿主权限运行。')),
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
          // One order for both surfaces: actions first, then the two global
          // switches, then the cards. The settings sheet used to repeat the
          // save row at the bottom, which read as two different toolbars.
          body.push(h('div', { key: 'toolbar', style: S.toolbar },
            h(Button, { key: 'save', kind: 'primary', disabled: busy || !dirty, onClick: save },
              busy ? '保存中…' : '保存'),
            h(Button, { key: 'revert', disabled: busy || !dirty, onClick: revert }, '放弃修改'),
            h(Button, { key: 'reload', disabled: busy, onClick: () => load() }, '重新读取'),
            h('span', { key: 'grow', style: S.grow }),
            h(AddMenu, { key: 'add', disabled: busy, onPick: addTool }),
            h(Button, { key: 'import', kind: 'small', disabled: busy, onClick: openImport }, '从 JSON 导入')))

          body.push(h('div', { key: 'defer', style: S.toolbar },
            h(Checkbox, {
              checked: config.deferLoading === true,
              disabled: busy,
              label: '延迟加载工具定义',
              onChange: (next) => edit({ ...config, deferLoading: next }),
            }),
            h(Checkbox, {
              checked: sidebarOn,
              disabled: busy,
              label: '在侧边栏显示入口',
              onChange: (next) => {
                setSidebarOn(next)
                writeSidebarPref(next)
              },
            }),
            h('span', { key: 'grow2', style: S.grow }),
            h('span', { key: 'count', style: S.status },
              `共 ${config.tools.length} 个，启用 ${config.tools.filter((tool) => tool.enabled !== false).length} 个`)))

          if (config.tools.length === 0) {
            body.push(h('div', { key: 'empty', style: S.empty },
              h('strong', null, '还没有工具定义'),
              h('span', null, '用「＋ 新增」建立第一个工具，或用「从 JSON 导入」粘贴一份别人分享的定义；也可以直接编辑 profile 的 cordis.patch.yml。')))
          }

          body.push(...config.tools.map((tool, index) => h(ToolCard, {
            key: rowIds.current[index] ?? `row-${index}`,
            tool,
            index,
            total: config.tools.length,
            names: config.tools.map((entry) => asString(entry.name)),
            disabled: busy,
            savedAt,
            issues,
            onChange: (next) => setTool(index, next),
            onRemove: removeTool,
            onMove: moveTool,
            onDuplicate: duplicateTool,
            onReplace: setTool,
          })))

          body.push(h('div', { key: 'hint', style: S.hint },
            '本页只编辑定义，不执行命令。试跑请在会话内使用：'
            + '/custom-tools preview <名字> {"参数":"值"} 查看 argv，'
            + '/custom-tools test <名字> {"参数":"值"} 实际执行一次。'))

          body.push(h(ImportDialog, {
            key: 'page-import',
            open: importOpen,
            title: '从 JSON 导入工具',
            description: '粘贴单个工具对象、对象数组，或 {"tools":[...]}；导入只改编辑区，点「保存」才写入 profile。',
            text: importText,
            error: importError,
            busy: false,
            submitLabel: '导入',
            onText: (next) => { setImportText(next); setImportError('') },
            onCancel: () => setImportOpen(false),
            onSubmit: importTools,
          }))

          body.push(pendingImport === null ? null : h(ConfirmDialog, {
            key: 'page-confirm',
            open: true,
            title: '覆盖已有工具？',
            description: '下列工具名已经存在，导入会用粘贴的定义整份替换它们；改动仍只在编辑区，点「保存」才写入 profile。',
            detail: pendingImport.names.map((name) => `将被覆盖：${name}`),
            confirmLabel: '覆盖这些工具',
            onCancel: () => { setPendingImport(null); setImportOpen(true) },
            onConfirm: () => {
              const pending = pendingImport
              setPendingImport(null)
              commitImport(pending.tools)
            },
          }))
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
        // The main panel is always there — an unselected panel costs nothing and
        // keeps `selectPanel('custom-tools')` valid the moment the icon appears.
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID },
          makeSidebarPage(SectionPage),
        ))
        // The icon is the only optional half, and the shipped account section
        // shows the pattern: register lazily, keep the disposer, call it when
        // the preference flips.
        ctx.slots.inject('sidebar.panellist', () => {
          let unregister
          const sync = (enabled) => {
            if (enabled && unregister === undefined) {
              unregister = ctx.slots.register(
                { name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: '自定义工具' },
                SidebarGlyph,
              )
            } else if (!enabled && unregister !== undefined) {
              unregister()
              unregister = undefined
            }
          }
          sync(readSidebarPref())
          const listener = (next) => sync(next)
          sidebarListeners.add(listener)
          return () => {
            sidebarListeners.delete(listener)
            if (unregister !== undefined) {
              unregister()
              unregister = undefined
            }
          }
        })
      },
      /**
       * Exposed for `test/client.test.js` only. `piecesOf`/`applyPieces` are the
       * one conversion that could silently eat a field, so they are reachable
       * from a test harness instead of being trusted by inspection.
       */
      __internal: {
        piecesOf,
        applyPieces,
        previewOf,
        collectIssues,
        slotText,
        findNamespace,
        readSidebarPref,
        writeSidebarPref,
        readConfig,
        stripFence,
        parseToolDocument,
        planImport,
        applyImport,
      },
    }
  },
})
