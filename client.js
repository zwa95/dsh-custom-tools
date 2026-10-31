/**
 * Browser half of dsh-custom-tools.
 *
 * It mounts one `settings.section` page and talks to the host exclusively
 * through the shipped `ctx.remote.settings` namespace — `describe()` to read
 * this row's volatile config and `mutate()` to write it. There is no private
 * HTTP bridge and no dependency on host runtime code: everything the page
 * knows about a tool is the JSON the settings document already contains.
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

    const styles = {
      wrap: { display: 'grid', gap: 14, maxWidth: 820 },
      header: { display: 'grid', gap: 4 },
      title: { margin: 0, fontSize: 15, fontWeight: 600 },
      lead: { margin: 0, fontSize: 12, opacity: 0.72, lineHeight: 1.6 },
      toolbar: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      card: {
        display: 'grid',
        gap: 10,
        padding: 12,
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.28))',
        borderRadius: 'var(--dsw-alias-radius-l2, 8px)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
      },
      cardHead: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
      field: { display: 'grid', gap: 4, fontSize: 12 },
      label: { fontSize: 12, opacity: 0.8 },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 30,
        padding: '4px 8px',
        borderRadius: 'var(--dsw-alias-radius-l2, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
        font: 'inherit',
      },
      textarea: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 68,
        padding: '6px 8px',
        borderRadius: 'var(--dsw-alias-radius-l2, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
        font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
        resize: 'vertical',
      },
      button: {
        boxSizing: 'border-box',
        minHeight: 30,
        padding: '0 12px',
        borderRadius: 'var(--dsw-alias-radius-l2, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      primary: {
        borderColor: 'var(--dsw-alias-brand-primary, #3b7ddd)',
        background: 'var(--dsw-alias-brand-primary, #3b7ddd)',
        color: '#fff',
      },
      danger: { color: 'var(--dsw-alias-state-error, #d33)' },
      status: { fontSize: 12, opacity: 0.75 },
      error: { fontSize: 12, color: 'var(--dsw-alias-state-error, #d33)' },
      empty: {
        display: 'grid',
        gap: 8,
        padding: 16,
        fontSize: 13,
        opacity: 0.8,
        border: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
        borderRadius: 'var(--dsw-alias-radius-l2, 8px)',
      },
    }

    // ---------------------------------------------------------------- helpers

    const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
    const asString = (value, fallback = '') => (typeof value === 'string' ? value : fallback)
    const asNumber = (value, fallback) =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback

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

    const EMPTY = { tools: [], deferLoading: false }

    function readValue(value) {
      const source = isObject(value) ? value : {}
      return {
        tools: Array.isArray(source.tools) ? source.tools.filter(isObject).map((tool) => ({ ...tool })) : [],
        deferLoading: source.deferLoading === true,
      }
    }

    const MODES = ['executable', 'script', 'bash', 'powershell']
    const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access']
    const APPROVALS = ['inherit', 'always']

    /** Fields the quick form does not cover, edited as one JSON object. */
    const ADVANCED_KEYS = [
      'whenToUse', 'env', 'credentials', 'output', 'examples',
      'concurrency', 'encodingDefaults', 'scriptTrust', 'scriptSha256',
    ]

    const TEMPLATES = {
      executable: {
        name: 'my_tool',
        description: '一句话说明这个工具做什么，以及什么时候该用它。',
        mode: 'executable',
        executable: 'git',
        args: [{ literal: 'status' }, { literal: '--short' }],
        parameters: {},
        output: { parse: 'text' },
      },
      script: {
        name: 'my_script',
        description: '用解释器运行一个脚本文件。',
        mode: 'script',
        interpreter: 'python',
        script: 'C:/Users/me/tools/report.py',
        args: [],
        parameters: {},
        output: { parse: 'text' },
      },
      bash: {
        name: 'my_bash',
        description: '运行一段固定的 bash 脚本；模型参数只经 $@ 传入位置参数。',
        mode: 'bash',
        command: 'printf "%s\\n" "$@"',
        args: [{ arg: 'value' }],
        parameters: { value: { type: 'string', required: true } },
        output: { parse: 'text' },
      },
      powershell: {
        name: 'my_pwsh',
        description: '用 PowerShell 7 运行一段固定脚本；参数从 stdin 的 JSON 读取。',
        mode: 'powershell',
        command: '$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json; $payload | ConvertTo-Json -Compress',
        args: [{ stdin: 'json' }],
        parameters: { value: { type: 'string' } },
        output: { parse: 'text' },
      },
    }

    // --------------------------------------------------------------- controls

    function Field({ label, hint, children }) {
      return h('label', { style: styles.field },
        h('span', { style: styles.label }, label),
        children,
        hint ? h('span', { style: { fontSize: 11, opacity: 0.65 } }, hint) : null)
    }

    function TextInput({ value, onChange, disabled, placeholder, mono }) {
      return h('input', {
        style: mono ? { ...styles.input, font: styles.textarea.font } : styles.input,
        value,
        disabled,
        placeholder,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function TextArea({ value, onChange, disabled, rows, placeholder }) {
      return h('textarea', {
        style: { ...styles.textarea, minHeight: rows ? rows * 18 : 68 },
        value,
        disabled,
        placeholder,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function Select({ value, options, onChange, disabled }) {
      return h('select', {
        style: styles.input,
        value,
        disabled,
        onChange: (event) => onChange(event.target.value),
      }, options.map((option) => h('option', { key: option, value: option }, option)))
    }

    function Button({ children, onClick, disabled, kind }) {
      const style = kind === 'primary' ? { ...styles.button, ...styles.primary }
        : kind === 'danger' ? { ...styles.button, ...styles.danger }
          : styles.button
      return h('button', { style, type: 'button', disabled, onClick }, children)
    }

    /**
     * A JSON textarea that keeps invalid text on screen and reports why.
     *
     * The text is adopted from `value` only when that value's identity changes
     * (reload, template swap), so typing in a sibling field never fights the
     * editor.
     */
    function JsonField({ label, value, onChange, disabled, rows, hint }) {
      const format = (input) => JSON.stringify(input ?? null, null, 2)
      const [text, setText] = React.useState(() => format(value))
      const [problem, setProblem] = React.useState('')
      const adopted = React.useRef(value)
      if (value !== adopted.current) {
        adopted.current = value
        setText(format(value))
        setProblem('')
      }

      const commit = (next) => {
        setText(next)
        if (next.trim() === '') {
          setProblem('')
          onChange(null)
          return
        }
        try {
          onChange(JSON.parse(next))
          setProblem('')
        } catch (error) {
          setProblem(error instanceof Error ? error.message : String(error))
        }
      }

      return h('div', { style: styles.field },
        h('span', { style: styles.label }, label),
        h(TextArea, { value: text, onChange: commit, disabled, rows, placeholder: 'JSON' }),
        problem
          ? h('span', { style: styles.error }, `JSON 有误：${problem}`)
          : hint ? h('span', { style: { fontSize: 11, opacity: 0.65 } }, hint) : null)
    }

    // ------------------------------------------------------------------ cards

    function ToolCard({ tool, index, total, disabled, onChange, onRemove, onMove }) {
      const set = (patch) => onChange(index, { ...tool, ...patch })
      const mode = asString(tool.mode, 'executable')

      const targetField = mode === 'executable'
        ? h(Field, { label: '可执行文件', hint: '填 PATH 名（如 git）或绝对路径' },
          h(TextInput, {
            value: asString(tool.executable),
            disabled,
            placeholder: 'git',
            onChange: (next) => set({ executable: next }),
          }))
        : mode === 'script'
          ? h('div', { style: styles.grid2 },
            h(Field, { label: '解释器', hint: '如 python / node / pwsh' },
              h(TextInput, {
                value: asString(tool.interpreter),
                disabled,
                onChange: (next) => set({ interpreter: next }),
              })),
            h(Field, { label: '脚本路径' },
              h(TextInput, {
                value: asString(tool.script),
                disabled,
                placeholder: 'C:/Users/me/tools/report.py',
                onChange: (next) => set({ script: next }),
              })))
          : h(Field, {
            label: mode === 'bash' ? 'bash 脚本文本（参数以 $@ 追加）' : 'PowerShell 脚本文本（参数由 $args 或 stdin 传入）',
            hint: '脚本文本由作者固定，模型参数永不拼进脚本文本',
          }, h(TextArea, {
            value: asString(tool.command),
            disabled,
            rows: 4,
            onChange: (next) => set({ command: next }),
          }))

      const advanced = Object.fromEntries(
        ADVANCED_KEYS.filter((key) => tool[key] !== undefined).map((key) => [key, tool[key]]),
      )

      const applyAdvanced = (next) => {
        const patch = {}
        for (const key of ADVANCED_KEYS) patch[key] = next !== null && isObject(next) && key in next ? next[key] : undefined
        set(patch)
      }

      return h('div', { style: styles.card },
        h('div', { style: styles.cardHead },
          h('strong', { style: { fontSize: 13 } }, asString(tool.name, '(未命名)')),
          h('span', { style: styles.status }, mode),
          tool.enabled === false ? h('span', { style: styles.error }, '已禁用') : null,
          h('span', { style: { flex: 1 } }),
          h(Button, { disabled: disabled || index === 0, onClick: () => onMove(index, -1) }, '↑'),
          h(Button, { disabled: disabled || index === total - 1, onClick: () => onMove(index, 1) }, '↓'),
          h(Button, { kind: 'danger', disabled, onClick: () => onRemove(index) }, '删除')),

        h('div', { style: styles.grid2 },
          h(Field, { label: '工具名', hint: '小写字母开头，仅 a-z 0-9 _' },
            h(TextInput, {
              value: asString(tool.name),
              disabled,
              placeholder: 'my_tool',
              onChange: (next) => set({ name: next }),
            })),
          h(Field, { label: '标题（可选）' },
            h(TextInput, {
              value: asString(tool.title),
              disabled,
              onChange: (next) => set({ title: next }),
            }))),

        h(Field, { label: '描述', hint: '模型据此决定是否调用；写清用途与边界' },
          h(TextArea, {
            value: asString(tool.description),
            disabled,
            rows: 2,
            onChange: (next) => set({ description: next }),
          })),

        h('div', { style: styles.grid2 },
          h(Field, { label: '模式' },
            h(Select, {
              value: mode,
              options: MODES,
              disabled,
              onChange: (next) => set({ mode: next }),
            })),
          h(Field, { label: '启用' },
            h('input', {
              type: 'checkbox',
              checked: tool.enabled !== false,
              disabled,
              onChange: (event) => set({ enabled: event.target.checked }),
            }))),

        targetField,

        h('div', { style: styles.grid2 },
          h(Field, { label: '工作目录', hint: '相对路径基于当前会话目录' },
            h(TextInput, {
              value: asString(tool.cwd, '.'),
              disabled,
              onChange: (next) => set({ cwd: next }),
            })),
          h(Field, { label: '沙箱档位', hint: '只能收紧会话档位，不会放宽' },
            h(Select, {
              value: asString(tool.sandbox, 'workspace-write'),
              options: SANDBOXES,
              disabled,
              onChange: (next) => set({ sandbox: next }),
            }))),

        h('div', { style: styles.grid2 },
          h(Field, { label: '审批' },
            h(Select, {
              value: asString(tool.approval, 'inherit'),
              options: APPROVALS,
              disabled,
              onChange: (next) => set({ approval: next }),
            })),
          h(Field, { label: '超时（毫秒）', hint: '1000 – 600000' },
            h(TextInput, {
              value: String(asNumber(tool.timeoutMs, 120000)),
              disabled,
              onChange: (next) => set({ timeoutMs: Number(next) || 0 }),
            }))),

        h(JsonField, {
          label: '参数映射（args）',
          hint: 'literal / arg / flag 等条目的数组，决定 argv 如何组装',
          value: tool.args ?? [],
          disabled,
          rows: 5,
          onChange: (next) => set({ args: next ?? [] }),
        }),

        h(JsonField, {
          label: '模型参数（parameters）',
          hint: 'JSON Schema 子集：type / required / description / enum / items …',
          value: tool.parameters ?? {},
          disabled,
          rows: 5,
          onChange: (next) => set({ parameters: next ?? {} }),
        }),

        h(JsonField, {
          label: '高级（env / credentials / output / examples …）',
          hint: '留空或 {} 表示不声明；键名写错会在保存后被校验器指出',
          value: advanced,
          disabled,
          rows: 4,
          onChange: applyAdvanced,
        }))
    }

    // ------------------------------------------------------------------- page

    /** Build the page component bound to the live client context. */
    function makeSectionPage(ctx) {
      const settings = () => ctx.get('remote')?.settings

      return function SectionPage() {
        const [phase, setPhase] = React.useState('loading')
        const [message, setMessage] = React.useState('')
        const [problem, setProblem] = React.useState('')
        const [draft, setDraft] = React.useState(null)
        const [revision, setRevision] = React.useState(undefined)
        const [busy, setBusy] = React.useState(false)

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
            setDraft(readValue(view.value))
            setRevision(view.revision)
            setPhase('ready')
          } catch (error) {
            setPhase('error')
            setProblem(error instanceof Error ? error.message : String(error))
          }
        }

        React.useEffect(() => { load() }, [])

        const current = draft ?? EMPTY
        const edit = (next) => { setDraft(next); setMessage('') }

        const setTool = (index, next) => {
          edit({ ...current, tools: current.tools.map((tool, i) => (i === index ? next : tool)) })
        }
        const removeTool = (index) => {
          edit({ ...current, tools: current.tools.filter((_, i) => i !== index) })
        }
        const moveTool = (index, delta) => {
          const tools = [...current.tools]
          const target = index + delta
          if (target < 0 || target >= tools.length) return
          const [item] = tools.splice(index, 1)
          tools.splice(target, 0, item)
          edit({ ...current, tools })
        }
        const addTool = (kind) => {
          edit({ ...current, tools: [...current.tools, JSON.parse(JSON.stringify(TEMPLATES[kind]))] })
        }

        const save = async () => {
          if (busy || revision === undefined) return
          setBusy(true)
          setMessage('')
          try {
            const api = settings()
            const ops = [
              { op: 'set', path: ['tools'], value: current.tools },
              { op: 'set', path: ['deferLoading'], value: current.deferLoading === true },
            ]
            const result = unwrap(await api.mutate(NS, ops, revision))
            if (!result.ok) {
              setMessage(`保存失败：${result.message}`)
            } else {
              setMessage('已保存。下一次工具调用就会用新定义；正在运行的调用会跑完它启动时的那一版。')
              await load()
            }
          } catch (error) {
            setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
          } finally {
            setBusy(false)
          }
        }

        const body = [
          h('div', { key: 'header', style: styles.header },
            h('h3', { key: 't', style: styles.title }, '自定义工具'),
            h('p', { key: 'l', style: styles.lead },
              '声明可执行文件、脚本或固定脚本命令，并声明模型可以填写的参数。参数只以精确的 argv / stdin 值传给程序，永远不会拼进 shell 脚本；沙箱档位只能收紧，不能放宽。')),
        ]

        if (phase === 'loading') body.push(h('p', { key: 'loading', style: styles.status }, '读取中…'))
        if (problem) body.push(h('p', { key: 'problem', style: styles.error }, problem))
        if (message) body.push(h('p', { key: 'message', style: styles.status }, message))

        if (phase === 'ready') {
          body.push(h('div', { key: 'toolbar', style: styles.toolbar },
            h(Button, { kind: 'primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
            h(Button, { disabled: busy, onClick: () => { setDraft(null); load() } }, '放弃修改'),
            h(Button, { disabled: busy, onClick: () => load() }, '重新读取'),
            h('span', { style: styles.status }, `revision = ${String(revision)}`),
            h('span', { style: { flex: 1 } }),
            ...MODES.map((mode) => h(Button, {
              key: mode,
              disabled: busy,
              onClick: () => addTool(mode),
            }, `＋ ${mode}`))))

          if (current.tools.length === 0) {
            body.push(h('div', { key: 'empty', style: styles.empty },
              h('strong', null, '还没有任何工具'),
              h('span', null, '点上面的「＋ 模式」按钮挑一个模板。'),
              h('span', { style: styles.status },
                '典型的第一件事：把某个 CLI 收紧成一条固定命令，只让模型填参数。')))
          }

          body.push(...current.tools.map((tool, index) => h(ToolCard, {
            key: `${index}:${asString(tool.name)}`,
            tool,
            index,
            total: current.tools.length,
            disabled: busy,
            onChange: setTool,
            onRemove: removeTool,
            onMove: moveTool,
          })))

          body.push(h('div', { key: 'foot', style: styles.toolbar },
            h(Button, { kind: 'primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
            h(Button, { disabled: busy, onClick: () => { setDraft(null); load() } }, '放弃修改'),
            h('span', { style: styles.status },
              `共 ${current.tools.length} 个工具，启用 ${current.tools.filter((tool) => tool.enabled !== false).length} 个`)))
        }

        return h('div', { style: styles.wrap }, body)
      }
    }

    return {
      // Only `slots` and `remote` are hard requirements: the page reads and
      // writes through `ctx.remote.settings`, so an absent settings namespace
      // degrades to an inline explanation instead of a section that never mounts.
      inject: ['slots', 'remote'],
      apply(ctx) {
        const SectionPage = makeSectionPage(ctx)
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            { name: 'settings.section', id: 'custom-tools', order: 60, label: '自定义工具' },
            SectionPage,
          )
        })
      },
    }
  },
})
