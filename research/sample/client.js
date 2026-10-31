/**
 * Browser half. Mounted into the official `plugins.row.config` slot, keyed by
 * `<package name>#<row id>`; the page owner hands us `{ view, form }` where
 * `form.state` is the Host-owned value/revision and `form.mutate(ops, revision)`
 * is the write path (Host validates full Config, persists via ConfigEditor,
 * applies through volatile HMR).
 */
window.__ModuleLoader__.load({
  id: 'dsh-custom-tools-sample',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const KEY = 'dsh-custom-tools-sample#cts-page'

    const str = (v, d) => (typeof v === 'string' ? v : d)
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

    function read(value) {
      const v = value && typeof value === 'object' ? value : {}
      return {
        label: str(v.label, 'custom page'),
        count: num(v.count, 1),
        note: str(v.note, ''),
        tools: Array.isArray(v.tools)
          ? v.tools.map((t) => ({
              name: str(t && t.name, ''),
              target: str(t && t.target, ''),
              enabled: !(t && t.enabled === false),
            }))
          : [],
      }
    }

    const styles = {
      wrap: { display: 'grid', gap: 12, maxWidth: 640 },
      field: { display: 'grid', gap: 4 },
      row: { display: 'flex', gap: 8, alignItems: 'center' },
      input: {
        boxSizing: 'border-box',
        height: 32,
        padding: '0 8px',
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, #ccc)',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
        font: 'inherit',
      },
      button: {
        boxSizing: 'border-box',
        height: 32,
        padding: '0 12px',
        borderRadius: 'var(--dsw-radius-sm, 8px)',
        border: '1px solid var(--dsw-alias-border-l2, #ccc)',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      primary: {
        borderColor: 'var(--dsw-alias-brand-primary, #247bbf)',
        color: 'var(--dsw-alias-brand-primary, #247bbf)',
        fontWeight: 600,
      },
      card: {
        boxSizing: 'border-box',
        borderRadius: 'var(--dsw-radius-xl, 20px)',
        border: '1px solid var(--dsw-alias-border-l1, #ddd)',
        padding: 12,
        display: 'grid',
        gap: 8,
      },
      hint: { opacity: 0.7, fontSize: 12, margin: 0 },
      status: { fontSize: 12, margin: 0 },
    }

    function Page(props) {
      const view = props.view
      const form = props.form
      const state = form && form.state
      const status = state && state.status
      const revision = state && state.revision
      const ready = status === 'ready' && !!state.writable && state.mode === 'host'

      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')

      // Re-sync from the Host whenever the revision changes, unless mid-edit.
      React.useEffect(() => {
        setDraft(null)
      }, [revision, status])

      const current = draft || read(state && state.value)
      const edit = (next) => {
        setDraft(next)
        setMessage('')
      }

      if (view === 'summary') {
        return h('span', null, '自定义页样例：' + current.label + '（' + current.tools.length + ' 个工具）')
      }

      if (!ready) {
        return h(
          'p',
          { style: styles.hint },
          status === 'loading' ? '正在读取配置…' : '此页当前不可写（status=' + String(status) + '）',
        )
      }

      const save = async () => {
        if (!ready || busy || revision === undefined) return
        setBusy(true)
        setMessage('')
        try {
          const accepted = await form.mutate(
            [
              { op: 'set', path: ['label'], value: current.label },
              { op: 'set', path: ['count'], value: Number(current.count) || 0 },
              current.note.trim()
                ? { op: 'set', path: ['note'], value: current.note }
                : { op: 'unset', path: ['note'] },
              { op: 'set', path: ['tools'], value: current.tools },
            ],
            revision,
          )
          setMessage(accepted ? '已保存（revision ' + revision + '）' : '被拒绝：revision 已过期，请重试')
          if (accepted) setDraft(null)
        } catch (error) {
          setMessage('保存失败：' + (error && error.message ? error.message : String(error)))
        } finally {
          setBusy(false)
        }
      }

      const setTool = (index, patch) => {
        const tools = current.tools.map((t, i) => (i === index ? { ...t, ...patch } : t))
        edit({ ...current, tools })
      }

      const card = (child, key) => h('div', { style: styles.card, key }, child)

      return h(
        'div',
        { style: styles.wrap },
        h(
          'p',
          { style: styles.hint },
          '这是手写 React 页面。读写都走宿主给的 form 通道，没有自定义 RPC、没有 HTTP 路由。',
        ),
        h(
          'label',
          { style: styles.field },
          '标题',
          h('input', {
            style: styles.input,
            value: current.label,
            disabled: busy,
            onChange: (e) => edit({ ...current, label: e.target.value }),
          }),
        ),
        h(
          'label',
          { style: styles.field },
          '数量',
          h('input', {
            style: styles.input,
            type: 'number',
            value: String(current.count),
            disabled: busy,
            onChange: (e) => edit({ ...current, count: Number(e.target.value) }),
          }),
        ),
        h(
          'label',
          { style: styles.field },
          '备注（清空会走 unset）',
          h('input', {
            style: styles.input,
            value: current.note,
            disabled: busy,
            onChange: (e) => edit({ ...current, note: e.target.value }),
          }),
        ),
        h(
          'p',
          { style: styles.hint },
          'secret 字段（apiKey）永远不会出现在 form.state.value 里；它只能在 Host 侧读取。',
        ),
        h(
          'div',
          { style: styles.card },
          h('strong', null, '工具数组（' + current.tools.length + '）'),
          current.tools.length === 0
            ? h('p', { style: styles.hint }, '还没有工具。')
            : current.tools.map((tool, index) =>
                h(
                  'div',
                  { style: styles.row, key: index },
                  h('input', {
                    style: { ...styles.input, flex: '1 1 auto' },
                    placeholder: 'name',
                    value: tool.name,
                    disabled: busy,
                    onChange: (e) => setTool(index, { name: e.target.value }),
                  }),
                  h('input', {
                    style: { ...styles.input, flex: '2 1 auto' },
                    placeholder: 'target',
                    value: tool.target,
                    disabled: busy,
                    onChange: (e) => setTool(index, { target: e.target.value }),
                  }),
                  h('label', { style: styles.row }, h('input', {
                    type: 'checkbox',
                    checked: tool.enabled,
                    disabled: busy,
                    onChange: (e) => setTool(index, { enabled: e.target.checked }),
                  }), '启用'),
                  h(
                    'button',
                    {
                      style: styles.button,
                      type: 'button',
                      disabled: busy,
                      onClick: () =>
                        edit({ ...current, tools: current.tools.filter((_, i) => i !== index) }),
                    },
                    '删除',
                  ),
                ),
              ),
          h(
            'button',
            {
              style: styles.button,
              type: 'button',
              disabled: busy,
              onClick: () =>
                edit({
                  ...current,
                  tools: [...current.tools, { name: '', target: '', enabled: true }],
                }),
            },
            '添加工具',
          ),
        ),
        h(
          'div',
          { style: styles.row },
          h(
            'button',
            {
              style: { ...styles.button, ...styles.primary },
              type: 'button',
              disabled: busy,
              onClick: save,
            },
            busy ? '保存中…' : '保存',
          ),
          h(
            'button',
            {
              style: styles.button,
              type: 'button',
              disabled: busy,
              onClick: () => {
                setDraft(null)
                setMessage('')
              },
            },
            '重置',
          ),
          h('span', { style: styles.status }, message),
        ),
        h('p', { style: styles.hint }, 'revision = ' + String(revision) + ' / status = ' + String(status)),
      )
    }

    // ---- settings.section sample -------------------------------------------------
    // A left-nav settings page (the pattern most third-party plugins use). It reads
    // and writes this row's volatile Config through the SHIPPED `ctx.remote.settings`
    // namespace, so there is no private HTTP bridge in this file.
    function makeSectionPage(ctx) {
      const NS = 'cts-section'
      const renders = { n: 0 }

      function pick(result) {
        if (!result || typeof result !== 'object') return { ok: false, message: 'no result' }
        if (result.ok === false) {
          const e = result.error || {}
          return { ok: false, message: String(e.code || 'error') + ': ' + String(e.message || '') }
        }
        return { ok: true, value: result.ok === true ? result.value : result }
      }

      function namespacesOf(value) {
        const bag = value && (value.namespaces || value.views)
        if (Array.isArray(bag)) return bag
        if (bag && typeof bag === 'object') return Object.values(bag)
        return []
      }

      function findView(value) {
        const list = namespacesOf(value)
        for (const view of list) {
          if (!view || typeof view !== 'object') continue
          if (view.namespace === NS || view.ns === NS || view.id === NS) return view
        }
        return undefined
      }

      function SectionPage() {
        const [phase, setPhase] = React.useState('loading')
        const [draft, setDraft] = React.useState(null)
        const [revision, setRevision] = React.useState(undefined)
        const [message, setMessage] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [apiKey, setApiKey] = React.useState('')
        const [raw, setRaw] = React.useState('')

        function withTimeout(promise, ms) {
          return Promise.race([
            promise,
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(new Error('describe() ' + ms + 'ms 没有返回')), ms)
            }),
          ])
        }

        async function load() {
          setPhase('loading')
          setMessage('')
          try {
            const remote = ctx.get('remote')
            if (!remote) {
              setPhase('error')
              setMessage('ctx.remote 不可用（Client 未注入 remote 服务）')
              return
            }
            setMessage('已拿到 ctx.remote，正在取 remote.settings…')
            const settings = remote.settings
            if (!settings || typeof settings.describe !== 'function') {
              setPhase('error')
              setMessage('ctx.remote.settings 未挂载。ctx.remote 现有命名空间: ' + Object.keys(remote).join(', '))
              return
            }
            setMessage('已拿到 ctx.remote.settings，正在调用 describe()…')
            const result = pick(await withTimeout(settings.describe(), 6000))
            if (!result.ok) {
              setPhase('error')
              setMessage(result.message)
              return
            }
            const all = namespacesOf(result.value).map((item) => String(item && item.ns))
            setRaw('namespaces(' + all.length + '): ' + all.join(', '))
            const found = findView(result.value)
            if (!found) {
              setPhase('error')
              setMessage('describe() 里没有 ns === ' + NS + ' 的命名空间。')
              return
            }
            setDraft(read(found.value))
            setRevision(found.revision)
            setApiKey('')
            setPhase('ready')
          } catch (error) {
            setPhase('error')
            setMessage(String((error && error.message) || error))
          }
        }

        React.useEffect(() => { load() }, [])

        const current = draft || read(null)
        const edit = (next) => {
          setDraft(next)
          setMessage('')
        }
        const setTool = (index, patch) => {
          const tools = current.tools.map((t, i) => (i === index ? { ...t, ...patch } : t))
          edit({ ...current, tools })
        }

        const save = async () => {
          if (busy || revision === undefined) return
          setBusy(true)
          setMessage('')
          try {
            const remote = ctx.get('remote')
            const ops = [
              { op: 'set', path: ['label'], value: current.label },
              { op: 'set', path: ['count'], value: Number(current.count) || 0 },
              current.note.trim()
                ? { op: 'set', path: ['note'], value: current.note }
                : { op: 'unset', path: ['note'] },
              { op: 'set', path: ['tools'], value: current.tools },
            ]
            if (apiKey.trim() !== '') ops.push({ op: 'set', path: ['apiKey'], value: apiKey })
            const result = pick(await withTimeout(remote.settings.mutate(NS, ops, revision), 10000))
            if (!result.ok) {
              setMessage('保存失败：' + result.message)
            } else {
              setMessage('已保存（提交时的 revision = ' + revision + '）')
              await load()
            }
          } catch (error) {
            setMessage('保存失败：' + (error && error.message ? error.message : String(error)))
          } finally {
            setBusy(false)
          }
        }

        const body = [
          h('h3', { key: 'title', style: { margin: 0, fontSize: 15 } }, '自定义工具 · 设置分页样例'),
          h('p', { key: 'lead', style: styles.hint },
            '注册在 settings.section（设置左侧栏），读写经 shipped 的 ctx.remote.settings，没有自建 HTTP 通道、没有 Typert 代码生成。'),
        ]

        if (phase === 'loading') body.push(h('p', { key: 'load', style: styles.status }, '读取中…'))
        if (message) body.push(h('p', { key: 'msg', style: styles.status }, message))

        if (phase === 'ready') {
          body.push(h('label', { key: 'label', style: styles.field },
            '显示名',
            h('input', {
              style: styles.input,
              value: current.label,
              disabled: busy,
              onChange: (e) => edit({ ...current, label: e.target.value }),
            })))

          body.push(h('label', { key: 'count', style: styles.field },
            '数量',
            h('input', {
              style: styles.input,
              type: 'number',
              value: String(current.count),
              disabled: busy,
              onChange: (e) => edit({ ...current, count: Number(e.target.value) }),
            })))

          body.push(h('label', { key: 'note', style: styles.field },
            '备注（清空会走 unset）',
            h('input', {
              style: styles.input,
              value: current.note,
              disabled: busy,
              onChange: (e) => edit({ ...current, note: e.target.value }),
            })))

          body.push(h('label', { key: 'apiKey', style: styles.field },
            '密钥（secret，永不回显；留空表示不修改）',
            h('input', {
              style: styles.input,
              type: 'password',
              value: apiKey,
              placeholder: '已设置在 profile patch 里，客户端看不到',
              disabled: busy,
              onChange: (e) => setApiKey(e.target.value),
            })))

          const toolRows = current.tools.map((tool, index) =>
            h('div', { key: 'tool' + index, style: styles.row },
              h('input', {
                style: { ...styles.input, flex: '1 1 0' },
                value: tool.name,
                placeholder: '工具名',
                disabled: busy,
                onChange: (e) => setTool(index, { name: e.target.value }),
              }),
              h('input', {
                style: { ...styles.input, flex: '2 1 0' },
                value: tool.target,
                placeholder: '目标可执行文件',
                disabled: busy,
                onChange: (e) => setTool(index, { target: e.target.value }),
              }),
              h('label', { style: { ...styles.row, gap: 4, fontSize: 12 } },
                h('input', {
                  type: 'checkbox',
                  checked: tool.enabled,
                  disabled: busy,
                  onChange: (e) => setTool(index, { enabled: e.target.checked }),
                }),
                '启用'),
              h('button', {
                style: styles.button,
                type: 'button',
                disabled: busy,
                onClick: () => edit({ ...current, tools: current.tools.filter((_, i) => i !== index) }),
              }, '删除')))

          body.push(h('div', { key: 'tools', style: styles.card },
            h('p', { style: styles.status }, '工具列表（' + current.tools.length + '）'),
            ...(toolRows.length > 0 ? toolRows : [h('p', { key: 'empty', style: styles.hint }, '还没有工具。')]),
            h('div', { style: styles.row },
              h('button', {
                style: styles.button,
                type: 'button',
                disabled: busy,
                onClick: () => edit({ ...current, tools: [...current.tools, { name: '', target: '', enabled: true }] }),
              }, '添加工具'))))

          body.push(h('div', { key: 'actions', style: styles.row },
            h('button', {
              style: { ...styles.button, ...styles.primary },
              type: 'button',
              disabled: busy,
              onClick: save,
            }, busy ? '保存中…' : '保存'),
            h('button', {
              style: styles.button,
              type: 'button',
              disabled: busy,
              onClick: () => { setDraft(null); load() },
            }, '放弃修改并重读'),
            h('span', { style: styles.status }, 'revision = ' + String(revision))))
        }

        body.push(h('div', { key: 'actions2', style: styles.row },
          h('button', { style: styles.button, type: 'button', onClick: load }, '重新读取')))

        if (raw) {
          body.push(h('p', { key: 'raw', style: styles.hint }, raw))
        }

        return h('div', { style: styles.wrap }, body)
      }

      return SectionPage
    }

    return {
      inject: ['slots', 'remote', 'remote.settings'],
      apply(ctx) {
        ctx.slots.inject('plugins.row.config', function* () {
          yield ctx.slots.register({ name: 'plugins.row.config', key: KEY }, Page)
        })
        const SectionPage = makeSectionPage(ctx)
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            { name: 'settings.section', id: 'cts-section', order: 60, label: '自定义工具（样例）' },
            SectionPage,
          )
        })
      },
    }
  },
})
