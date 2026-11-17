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

    /** 会话正文的行锚点（官方 ui-chat 的稳定属性，见社区插件实现）；按版本退化。 */
    const FLOW_SELECTOR = '[data-slot="conversation.chat.flow"], [data-chat-flow]'
    const ROW_SELECTORS = ['[data-chat-anchor-key][data-chat-turn]', '[data-chat-turn]', '[data-chat-anchor-key]']

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /** 取可见面积最大的正文根（slot 座位本身可能是 0 尺寸）；找不到就顺行锚点往上找滚动容器。 */
    function flowRoot() {
      let best = null
      let bestArea = 0
      for (const el of document.querySelectorAll(FLOW_SELECTOR)) {
        const rect = el.getBoundingClientRect()
        const area = rect.width * rect.height
        if (area > bestArea) {
          bestArea = area
          best = el
        }
      }
      if (best) return best
      const row = document.querySelector('[data-chat-turn], [data-chat-anchor-key]')
      if (row) return scrollParent(row)
      return null
    }

    /** 行的可见文字（去空白，便于宽松匹配）。 */
    function rowText(row) {
      return String(row.innerText || row.textContent || '').replace(/\s+/g, '')
    }

    /** 正文行（依次尝试几种锚点选择器，兼容不同小版本）。 */
    function flowRows(flow) {
      for (const selector of ROW_SELECTORS) {
        const rows = flow.querySelectorAll(selector)
        if (rows.length > 0) return Array.from(rows)
      }
      return []
    }

    /** 在正文里找包含匹配串的行；needles 由长到短。 */
    function findRow(flow, needles) {
      const rows = flowRows(flow)
      for (const needle of needles) {
        const flat = needle.replace(/\s+/g, '')
        if (flat.length < 6) continue
        for (const row of rows) if (rowText(row).includes(flat)) return row
      }
      return null
    }

    /** 最近的纵向滚动容器（行本身通常不是滚动容器）。 */
    function scrollParent(el) {
      let node = el
      while (node && node !== document.body && node !== document.documentElement) {
        const style = window.getComputedStyle(node)
        if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) return node
        node = node.parentElement
      }
      return document.scrollingElement || document.documentElement
    }

    /** 落点：scrollTop 数值计算，不再用 scrollIntoView（会把宿主吸顶栏一起拽走）。 */
    function landRow(flow, row) {
      const scroller = scrollParent(row) || scrollParent(flow)
      const flowRect = scroller.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      const offset = Math.min(140, Math.max(24, flowRect.height / 4))
      const target = scroller.scrollTop + (rowRect.top - flowRect.top) - offset
      scroller.scrollTop = Math.max(0, target)
    }

    /** 命中行闪一下，方便肉眼找到。 */
    function flashRow(row) {
      const previous = row.style.outline
      const previousOffset = row.style.outlineOffset
      row.style.outline = '2px solid #f5b400'
      row.style.outlineOffset = '-2px'
      row.style.transition = 'outline-color .4s'
      setTimeout(() => {
        row.style.outline = previous
        row.style.outlineOffset = previousOffset
      }, 2600)
    }

    /** 展开目标轮次里折叠的思考 / 工具卡片（命中常在这些折叠块里）。 */
    async function expandTurn(flow, turn) {
      const rows = flowRows(flow).filter((row) => String(row.getAttribute('data-chat-turn')) === String(turn))
      let clicked = 0
      for (const row of rows) {
        for (const toggle of row.querySelectorAll('[aria-expanded="false"]')) {
          try {
            toggle.click()
            clicked++
          } catch {
            // 忽略
          }
          if (clicked >= 8) break
        }
        if (clicked >= 8) break
      }
      if (clicked > 0) await sleep(160)
      return clicked
    }

    /**
     * 打开会话并滚到那段正文（借用社区插件的做法）：
     * 1) 若当前停在插件面板页，先 selectPanel(null) 回到对话，否则正文根本不可见；
     * 2) openSession 打开目标会话，轮询等 `[data-chat-flow]` 出现；
     * 3) loadThrough(seq) 把目标事件读进来（分页会话里最关键的一步）；
     * 4) 按行锚点找包含匹配串的行，用 scrollTop 数学落点（宿主会重排/重滚，
     *    所以巡逻式重试几次）；找不到就展开该轮的折叠块再找；
     * 5) 全程失败才提示，并把失败原因写清楚。
     */
    async function jumpTo(ctx, hit) {
      const raw = String(hit.text || hit.snippet || '').replace(/^…|…$/g, '').replace(/\s+/g, ' ').trim()
      setState({ open: false, hover: -1, note: '' })
      // 1) 先回到对话视图（面板页会盖住会话）
      try {
        const info = ctx.layout && ctx.layout.panelInfo ? ctx.layout.panelInfo.getSnapshot() : null
        if (info && info.activePanelId != null && typeof ctx.layout.selectPanel === 'function') ctx.layout.selectPanel(null)
      } catch {
        // 拿不到 panelInfo 就直接继续
      }
      // 2) 打开会话
      try {
        ctx.uiWorkspace.openSession(hit.sid)
      } catch (error) {
        setState({ open: true, note: `打开会话失败：${String((error && error.message) || error)}` })
        return
      }
      // 3) 等正文容器出现（最多 ~6s）
      let flow = null
      for (let index = 0; index < 30; index++) {
        flow = flowRoot()
        if (flow) break
        await sleep(200)
      }
      // 4) 把目标事件加载进来
      try {
        const binding = ctx.sessions && ctx.sessions.binding ? ctx.sessions.binding(hit.sid) : undefined
        const session = binding && binding.session
        if (session && typeof session.loadThrough === 'function') await session.loadThrough(hit.seq)
      } catch {
        // 已加载完就忽略
      }
      const needles = [raw.slice(0, 60), raw.slice(0, 30), raw.slice(0, 16)].filter(
        (text, index, all) => text.length >= 6 && all.indexOf(text) === index,
      )
      if (needles.length === 0) return
      // 5) 巡逻落点：宿主开完会话会重排，隔一会儿再看
      for (let round = 0; round < 20; round++) {
        flow = flowRoot() || flow
        if (flow) {
          const row = findRow(flow, needles)
          if (row) {
            landRow(flow, row)
            await sleep(120)
            landRow(flow, row)
            flashRow(row)
            return
          }
          // 折叠的思考/工具内容：展开目标轮次再找
          if (round === 4 && hit.turn) {
            const expanded = await expandTurn(flow, hit.turn)
            if (expanded > 0) continue
          }
          // 目标可能在更早的位置：先滚到顶部逼出更早的行
          if (round === 8) {
            const scroller = scrollParent(flow)
            if (scroller && scroller.scrollTop > 0) {
              scroller.scrollTop = 0
              await sleep(200)
              continue
            }
          }
        }
        await sleep(300)
      }
      const rowCount = flow ? flowRows(flow).length : 0
      setState({
        open: true,
        note: flow
          ? `已打开会话，但没定位到这段（正文行 ${rowCount} 个；可能被折叠或分页未加载）——预览可读全文`
          : '已打开会话，但没找到对话正文容器（页面可能还没切到对话视图）',
      })
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
    exports.inject = ['slots', 'uiWorkspace', 'sessions', 'layout']
    return module.exports
  },
})
