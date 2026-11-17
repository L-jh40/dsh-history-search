/**
 * dsh-history-search client half — Ctrl+Shift+F 式的历史查找面板。
 *
 * - 可拖动窗口；右边搜索，左边浮动预览（鼠标可直接移过去滚动读全文）。
 * - 模式：普通（可叠加 忽略大小写/空格/标点）与正则。
 * - 范围：全部 / 工作区 / 当前会话 / 当前会话最后一轮。
 * - 命中区间全部标绿；点一条 → 打开会话并滚到那段文字。
 *
 * @module dsh-history-search/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-history-search',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const API = '/api/history-search'
    const TYPE_LABEL = {
      user: '提问',
      assistant: '回答',
      reasoning: '思考',
      'tool-call': '工具调用',
      'tool-result': '工具结果',
    }
    const TYPE_COLOR = {
      user: '#4c8dff',
      assistant: '#2fb67c',
      reasoning: '#b07cff',
      'tool-call': '#e8a33d',
      'tool-result': '#8a94a6',
    }
    const ALL_TYPES = ['user', 'assistant', 'reasoning', 'tool-call', 'tool-result']
    const GREEN = 'rgba(46,182,124,.42)'

    /* ------------------------------------------------------------ 共享状态 -- */

    const listeners = new Set()
    const store = {
      open: false,
      x: null,
      y: null,
      q: '',
      regex: false,
      lower: true,
      space: false,
      punct: false,
      scope: 'all',
      workspace: '',
      types: [],
      loading: false,
      hits: [],
      status: null,
      error: null,
      workspaces: null,
      hover: -1,
      previewOn: true,
      help: false,
      note: '',
    }
    const setState = (patch) => {
      Object.assign(store, patch)
      for (const fn of listeners) fn()
    }
    function useStore() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const fn = () => force((n) => n + 1)
        listeners.add(fn)
        return () => listeners.delete(fn)
      }, [])
      return store
    }

    /* -------------------------------------------------------------- 查询 -- */

    let timer = null
    let callSeq = 0

    function currentSessionId(ctx) {
      try {
        const snap = ctx.sessions?.list?.getSnapshot?.()
        // `current` 是官方会话列表快照里的当前会话；没有就走 undefined。
        return snap?.current
      } catch {
        return undefined
      }
    }

    async function loadWorkspaces() {
      if (Array.isArray(store.workspaces)) return
      try {
        const res = await fetch(`${API}?action=workspaces`)
        const body = await res.json()
        setState({ workspaces: Array.isArray(body.items) ? body.items : [] })
      } catch {
        setState({ workspaces: [] })
      }
    }

    async function runSearch(ctx) {
      const q = store.q.trim()
      if (q === '') {
        setState({ hits: [], status: null, error: null, loading: false, hover: -1 })
        return
      }
      const scope = store.scope
      const sid = currentSessionId(ctx)
      if ((scope === 'session' || scope === 'lastturn') && !sid) {
        setState({ hits: [], status: null, loading: false, error: '当前没有打开的会话：先在侧栏点开一个会话' })
        return
      }
      if (scope === 'workspace' && !store.workspace) {
        setState({ hits: [], status: null, loading: false, error: '先选一个工作区' })
        return
      }
      const mine = ++callSeq
      setState({ loading: true, error: null })
      const params = new URLSearchParams({
        q,
        lower: store.lower ? '1' : '0',
        space: store.space ? '1' : '0',
        punct: store.punct ? '1' : '0',
        regex: store.regex ? '1' : '0',
        scope,
        types: store.types.join(','),
        limit: '100',
      })
      if (sid && (scope === 'session' || scope === 'lastturn')) params.set('sid', sid)
      if (scope === 'workspace' && store.workspace) params.set('workspace', store.workspace)
      try {
        const res = await fetch(`${API}?${params.toString()}`)
        const body = await res.json()
        if (mine !== callSeq) return
        setState({
          loading: false,
          hits: Array.isArray(body.hits) ? body.hits : [],
          status: body,
          hover: -1,
          error: body.ok === false ? String(body.error ?? 'error') : null,
        })
      } catch (error) {
        if (mine === callSeq) setState({ loading: false, error: String((error && error.message) || error) })
      }
    }

    function schedule(ctx) {
      clearTimeout(timer)
      timer = setTimeout(() => {
        void runSearch(ctx)
      }, 260)
    }

    /* -------------------------------------------------------------- 跳转 -- */

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /**
     * 打开会话并滚到那段正文。
     * 1) 先关面板（否则 window.find 会命中我们自己的列表）；
     * 2) openSession 打开会话；
     * 3) 用 sessions.binding 的 loadThrough(seq) 确保那段事件已加载（分页会话里
     *    目标可能还没读进来，这是之前"跳了但看不到"的主要原因）；
     * 4) 由长到短换匹配串反复 window.find，最多约 6 秒。
     */
    async function jumpTo(ctx, hit) {
      const flat = String(hit.text || hit.snippet || '')
        .replace(/^…|…$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      setState({ open: false, hover: -1, note: '' })
      try {
        ctx.uiWorkspace.openSession(hit.sid)
      } catch (error) {
        setState({ open: true, note: `打开会话失败：${String((error && error.message) || error)}` })
        return
      }
      try {
        const binding = ctx.sessions?.binding?.(hit.sid)
        if (binding && binding.session && typeof binding.session.loadThrough === 'function') {
          await binding.session.loadThrough(hit.seq)
        }
      } catch {
        // 事件本来就加载完了，忽略
      }
      const needles = [40, 24, 14, 8]
        .map((size) => flat.slice(0, size))
        .filter((text, index, all) => text.length >= 6 && all.indexOf(text) === index)
      if (needles.length === 0) return
      for (let round = 0; round < 24; round++) {
        for (const needle of needles) {
          try {
            if (window.find(needle, false, false, true) === true) return
          } catch {
            // 忽略
          }
        }
        await sleep(250)
      }
      setState({ open: true, note: '已打开会话，但正文里没定位到这段（可能还没渲染）——可用左侧预览读全文' })
    }

    /* -------------------------------------------------------------- 样式 -- */

    const S = {
      wrap: {
        position: 'fixed',
        zIndex: 70,
      },
      panel: {
        width: '560px',
        maxWidth: 'calc(100vw - 48px)',
        maxHeight: '72vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'Canvas',
        color: 'CanvasText',
        border: '1px solid rgba(127,127,127,.45)',
        borderRadius: '12px',
        boxShadow: '0 18px 48px rgba(0,0,0,.28)',
        overflow: 'hidden',
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      },
      preview: {
        width: '420px',
        maxWidth: '40vw',
        maxHeight: '72vh',
        overflow: 'auto',
        background: 'Canvas',
        color: 'CanvasText',
        border: '1px solid rgba(127,127,127,.45)',
        borderRadius: '12px',
        boxShadow: '0 18px 48px rgba(0,0,0,.2)',
        padding: '10px 12px',
        font: '12px/1.6 ui-monospace, Consolas, "Microsoft YaHei", monospace',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 10px',
        borderBottom: '1px solid rgba(127,127,127,.25)',
        cursor: 'move',
        userSelect: 'none',
      },
      title: { fontWeight: 600, flex: 'none' },
      input: {
        flex: 1,
        minWidth: 0,
        padding: '6px 9px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,.5)',
        background: 'Field',
        color: 'FieldText',
        font: 'inherit',
        outline: 'none',
      },
      close: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '16px', lineHeight: 1, padding: '2px 6px', borderRadius: '6px' },
      bar: { display: 'flex', flexWrap: 'wrap', gap: '9px', alignItems: 'center', padding: '7px 10px', borderBottom: '1px solid rgba(127,127,127,.2)', color: 'GrayText' },
      label: { display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: 'CanvasText' },
      select: { padding: '2px 6px', borderRadius: '6px', border: '1px solid rgba(127,127,127,.5)', background: 'Field', color: 'FieldText', font: 'inherit', maxWidth: '190px' },
      list: { overflowY: 'auto', padding: '5px' },
      item: { display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', color: 'inherit', padding: '6px 8px', borderRadius: '8px', cursor: 'pointer', font: 'inherit' },
      meta: { display: 'flex', gap: '7px', alignItems: 'center', fontSize: '11px', color: 'GrayText', marginBottom: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      badge: { fontSize: '10px', padding: '1px 6px', borderRadius: '999px', color: '#fff', flex: 'none' },
      snippet: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'CanvasText' },
      mark: { background: GREEN, color: 'inherit', borderRadius: '3px', padding: '0 1px' },
      foot: { padding: '5px 10px', borderTop: '1px solid rgba(127,127,127,.2)', fontSize: '11px', color: 'GrayText' },
      helpBtn: {
        border: '1px solid rgba(127,127,127,.5)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '999px',
        width: '17px',
        height: '17px',
        lineHeight: '1',
        fontSize: '11px',
        cursor: 'pointer',
        padding: '0',
      },
      helpBox: {
        margin: '0 10px 8px',
        padding: '8px 10px',
        border: '1px solid rgba(127,127,127,.35)',
        borderRadius: '8px',
        background: 'rgba(127,127,127,.08)',
        fontSize: '11.5px',
        lineHeight: 1.7,
        color: 'CanvasText',
        whiteSpace: 'pre-wrap',
      },
      previewHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        marginBottom: '6px',
        paddingBottom: '5px',
        borderBottom: '1px solid rgba(127,127,127,.25)',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: '11px',
        color: 'GrayText',
      },
    }

    /** 把片段按区间切成 文本 / 高亮 节点。 */
    function renderSnippet(snippet, ranges) {
      if (!Array.isArray(ranges) || ranges.length === 0) return snippet
      const nodes = []
      let cursor = 0
      for (let i = 0; i < ranges.length; i++) {
        const [start, len] = ranges[i]
        if (start < cursor || start >= snippet.length) continue
        if (start > cursor) nodes.push(snippet.slice(cursor, start))
        nodes.push(h('mark', { key: `m${i}`, style: S.mark }, snippet.slice(start, start + len)))
        cursor = start + len
      }
      if (cursor < snippet.length) nodes.push(snippet.slice(cursor))
      return nodes
    }

    /* -------------------------------------------------------------- 面板 -- */

    function Panel(props) {
      const ctx = props.ctx
      const s = useStore()
      const drag = React.useRef(null)

      React.useEffect(() => {
        if (s.open) void loadWorkspaces()
      }, [s.open])

      // 拖动：按住头部。
      React.useEffect(() => {
        if (!s.open) return
        const move = (event) => {
          const start = drag.current
          if (!start) return
          setState({
            x: Math.max(0, Math.min(window.innerWidth - 120, start.x + event.clientX - start.px)),
            y: Math.max(0, Math.min(window.innerHeight - 60, start.y + event.clientY - start.py)),
          })
        }
        const up = () => {
          drag.current = null
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
      }, [s.open])

      if (!s.open) return null

      const position = s.x === null ? { right: '24px', bottom: '96px' } : { left: `${s.x}px`, top: `${s.y}px` }
      const hovered = s.hover >= 0 && s.hits[s.hover] ? s.hits[s.hover] : null

      const onHeadDown = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        drag.current = { x: rect.left, y: rect.top, px: event.clientX, py: event.clientY }
        setState({ x: rect.left, y: rect.top })
      }

      const panel = h(
        'div',
        { style: S.panel, role: 'dialog', 'aria-label': '搜索历史' },
        h(
          'div',
          { style: S.head, onPointerDown: onHeadDown },
          h('span', { style: S.title }, '搜索历史'),
          h('input', {
            style: S.input,
            autoFocus: true,
            placeholder: s.regex ? '正则表达式，例如 github.{0,6}token' : '搜提问 / 回答 / 思考 / 工具调用…',
            value: s.q,
            onPointerDown: (e) => e.stopPropagation(),
            onChange: (e) => {
              setState({ q: e.target.value })
              schedule(ctx)
            },
            onKeyDown: (e) => {
              if (e.key === 'Escape') setState({ open: false })
              if (e.key === 'Enter') void runSearch(ctx)
            },
          }),
          h('button', { type: 'button', style: S.close, title: '关闭 (Esc)', onClick: () => setState({ open: false }) }, '×'),
        ),
        h(
          'div',
          { style: S.bar },
          h('label', { style: S.label }, h('input', { type: 'checkbox', checked: s.regex, onChange: (e) => { setState({ regex: e.target.checked }); schedule(ctx) } }), '正则'),
          s.regex
            ? h('button', { type: 'button', style: S.helpBtn, title: '正则符号说明', onClick: () => setState({ help: !s.help }) }, '?')
            : null,
          h('label', { style: { ...S.label, opacity: s.regex ? 0.45 : 1 } }, h('input', { type: 'checkbox', disabled: s.regex, checked: s.lower, onChange: (e) => { setState({ lower: e.target.checked }); schedule(ctx) } }), '忽略大小写'),
          h('label', { style: { ...S.label, opacity: s.regex ? 0.45 : 1 } }, h('input', { type: 'checkbox', disabled: s.regex, checked: s.space, onChange: (e) => { setState({ space: e.target.checked }); schedule(ctx) } }), '忽略空格'),
          h('label', { style: { ...S.label, opacity: s.regex ? 0.45 : 1 } }, h('input', { type: 'checkbox', disabled: s.regex, checked: s.punct, onChange: (e) => { setState({ punct: e.target.checked }); schedule(ctx) } }), '忽略标点'),
          h('label', { style: S.label }, h('input', { type: 'checkbox', checked: s.previewOn, onChange: (e) => setState({ previewOn: e.target.checked }) }), '悬停预览'),
        ),
        s.regex && s.help
          ? h(
              'div',
              { style: S.helpBox },
              '常用正则：\n',
              '  .        任意一个字符          github.token → github的token / github token\n',
              '  .*       任意多个字符（贪婪）  github.*token → 中间隔多少字都行\n',
              '  .{0,6}   中间 0–6 个字符       github.{0,6}token → 最贴近「隔几个字」的写法\n',
              '  .+       至少一个字符          github.+token（中间必须有字）\n',
              '  \\d       数字                  \\d{4} → 四位数\n',
              '  \\w       字母数字下划线        token\\w*\n',
              '  \\s       空白                  github\\stoken\n',
              '  [abc]    其中一个字符          [Tt]oken\n',
              '  (a|b)    二选一                (token|秘钥)\n',
              '  ^  $     行首 / 行尾           ^git\n',
              '  \\b       单词边界              \\btoken\\b\n',
              '忽略大小写：勾选上面的「忽略大小写」；正则里也可写 (?i) 前缀。',
            )
          : null,
        h(
          'div',
          { style: S.bar },
          h(
            'select',
            { style: S.select, value: s.scope, onChange: (e) => { setState({ scope: e.target.value }); schedule(ctx) } },
            h('option', { value: 'all' }, '全部会话'),
            h('option', { value: 'workspace' }, '按工作区'),
            h('option', { value: 'session' }, '当前会话'),
            h('option', { value: 'lastturn' }, '当前会话 · 最后一轮'),
          ),
          s.scope === 'workspace'
            ? h(
                'select',
                { style: S.select, value: s.workspace, onChange: (e) => { setState({ workspace: e.target.value }); schedule(ctx) } },
                h('option', { value: '' }, '选择工作区…'),
                (s.workspaces ?? []).map((ws) => h('option', { key: ws.cwd, value: ws.cwd }, `${ws.label}（${ws.sessions}）`)),
              )
            : null,
          h(
            'select',
            {
              style: S.select,
              value: s.types.length === 0 ? 'all' : s.types[0],
              onChange: (e) => {
                const v = e.target.value
                setState({ types: v === 'all' ? [] : [v] })
                schedule(ctx)
              },
            },
            h('option', { value: 'all' }, '全部类型'),
            ALL_TYPES.map((t) => h('option', { key: t, value: t }, TYPE_LABEL[t])),
          ),
        ),
        h(
          'div',
          { style: S.list },
          s.hits.length === 0
            ? h('div', { style: { padding: '14px', color: 'GrayText' } }, s.loading ? '搜索中…' : '没有命中')
            : s.hits.map((hit, i) =>
                h(
                  'button',
                  {
                    key: `${hit.sid}:${hit.seq}:${i}`,
                    type: 'button',
                    style: { ...S.item, background: s.hover === i ? 'rgba(127,127,127,.14)' : 'transparent' },
                    onMouseEnter: () => setState({ hover: i }),
                    onClick: () => jumpTo(ctx, hit),
                  },
                  h(
                    'div',
                    { style: S.meta },
                    h('span', { style: { ...S.badge, background: TYPE_COLOR[hit.type] ?? '#8a94a6' } }, TYPE_LABEL[hit.type] ?? hit.type),
                    h('span', { style: { fontWeight: 600, color: 'CanvasText' } }, hit.title || `#${String(hit.sid).slice(0, 8)}`),
                    hit.workspace ? h('span', null, `· ${hit.workspace}`) : null,
                    hit.turn ? h('span', null, `第 ${hit.turn} 轮`) : null,
                    hit.time ? h('span', null, new Date(hit.time).toLocaleString('zh-CN', { hour12: false })) : null,
                  ),
                  h('div', { style: S.snippet }, renderSnippet(hit.snippet, hit.ranges)),
                ),
              ),
        ),
        h(
          'div',
          { style: S.foot },
          s.note
            ? s.note
            : s.error
              ? `错误：${s.error}`
              : s.status
                ? `${s.hits.length} 条 · ${s.status.tookMs ?? '?'} ms · 索引 ${s.status.ready ? '就绪' : s.status.building ? '构建中' : '未就绪'} · 拖动标题栏可移动`
                : 'Ctrl+Shift+F 开关本面板 · 拖动标题栏可移动 · 点结果跳转',
        ),
      )

      // 预览放在哪边：以面板中点为界，哪边空间大放哪边。
      const panelLeft = s.x === null ? Math.max(0, window.innerWidth - 24 - 560) : s.x
      const previewLeft = s.previewOn && hovered !== null && panelLeft > window.innerWidth / 2
      const preview = s.previewOn && hovered
        ? h(
            'div',
            {
              style: {
                ...S.preview,
                position: 'absolute',
                top: '0',
                ...(previewLeft ? { right: '100%', marginRight: '8px' } : { left: '100%', marginLeft: '8px' }),
              },
            },
            h(
              'div',
              { style: S.previewHead },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${TYPE_LABEL[hovered.type] ?? hovered.type} · ${hovered.title}`),
              h(
                'button',
                {
                  type: 'button',
                  style: { ...S.close, fontSize: '13px', padding: '0 4px' },
                  title: '关闭预览',
                  onClick: (event) => {
                    event.stopPropagation()
                    setState({ previewOn: false, hover: -1 })
                  },
                },
                '×',
              ),
            ),
            renderSnippet(String(hovered.text || hovered.snippet || ''), []),
          )
        : null

      return h('div', { style: { ...S.wrap, ...position }, onMouseLeave: () => setState({ hover: -1 }) }, panel, preview)
    }

    /* ------------------------------------------------------------ 入口按钮 -- */

    function FooterButton(props) {
      const s = useStore()
      return h(
        'button',
        {
          type: 'button',
          title: '搜索历史 (Ctrl+Shift+F)',
          'aria-label': '搜索历史',
          onClick: () => setState({ open: !s.open }),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            border: 'none',
            background: s.open ? 'rgba(127,127,127,.18)' : 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            padding: '6px 8px',
            borderRadius: '8px',
            font: 'inherit',
            width: props.wide ? '100%' : 'auto',
          },
        },
        h(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' },
          h('circle', { cx: 11, cy: 11, r: 6.5 }),
          h('path', { d: 'M16 16l4.5 4.5' }),
        ),
        props.wide ? h('span', null, '搜索历史') : null,
      )
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'history-search', order: 5, label: '搜索历史' }, FooterButton),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'history-search-panel', order: 100, label: '搜索历史' }, () => h(Panel, { ctx })),
      )
      const onKey = (event) => {
        if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return
        if (String(event.key).toLowerCase() !== 'f') return
        event.preventDefault()
        setState({ open: !store.open })
        if (store.open) setTimeout(() => void runSearch(ctx), 30)
      }
      window.addEventListener('keydown', onKey)
      ctx.effect(() => () => window.removeEventListener('keydown', onKey), 'dsh-history-search: shortcut')
    }

    exports.apply = apply
    exports.inject = ['slots', 'uiWorkspace', 'sessions']
    return module.exports
  },
})
