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
      ask: '询问',
      'tool-call': '工具调用',
      'tool-result': '工具结果',
      'ask-result': '询问结果',
      'search-result': '搜索结果',
    }
    const TYPE_COLOR = {
      user: '#4c8dff',
      assistant: '#2fb67c',
      reasoning: '#b07cff',
      ask: '#e0578d',
      'tool-call': '#e8a33d',
      'tool-result': '#8a94a6',
      'ask-result': '#e0578d',
      'search-result': '#4fb3bf',
    }
    /** 顶层类型 + 勾选时默认一起带上的子类型（用户可再单独取消）。 */
    const TYPE_GROUPS = [
      { id: 'user', label: '提问' },
      { id: 'assistant', label: '回答' },
      { id: 'reasoning', label: '思考' },
      { id: 'tool-call', label: '工具调用', includes: ['ask'] },
      { id: 'tool-result', label: '工具结果', includes: ['ask-result', 'search-result'] },
      { id: 'ask', label: '询问', child: true },
      { id: 'ask-result', label: '询问结果', child: true },
      { id: 'search-result', label: '搜索结果', child: true },
    ]
    const ALL_TYPES = TYPE_GROUPS.map((group) => group.id)
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
      /** 渐进渲染：先画满一屏，滚到底再追加。 */
      visible: 24,
      status: null,
      error: null,
      workspaces: null,
      hover: -1,
      previewOn: true,
      help: false,
      typesOpen: false,
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
          visible: 24,
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

    /** 正文行（依次尝试几种锚点选择器，兼容不同小版本）。 */
    function flowRows(flow) {
      for (const selector of ROW_SELECTORS) {
        const rows = flow.querySelectorAll(selector)
        if (rows.length > 0) return Array.from(rows)
      }
      return []
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

    /** 只保留字母/数字（含 CJK）的「骨架」：markdown 的 ** ` # > [] 等符号一律消失。 */
    const KEEP_CHAR = /[\p{L}\p{N}]/u
    function skeleton(text) {
      const out = []
      const value = String(text)
      for (const ch of value) if (KEEP_CHAR.test(ch)) out.push(ch)
      return out.join('')
    }

    /** 行文字 → 逐字骨架索引（跳过折叠/隐藏节点），用于把「词」定位成 Range。 */
    function charIndex(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement
          if (!parent) return NodeFilter.FILTER_REJECT
          if (parent.closest('[hidden], [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT
          const style = window.getComputedStyle(parent)
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT
          return NodeFilter.FILTER_ACCEPT
        },
      })
      const chars = []
      const where = []
      let node = walker.nextNode()
      while (node) {
        const value = node.nodeValue || ''
        for (let i = 0; i < value.length; i++) {
          const ch = value[i]
          if (!KEEP_CHAR.test(ch)) continue
          chars.push(ch)
          where.push([node, i])
        }
        node = walker.nextNode()
      }
      return { text: chars.join(''), where }
    }

    /** 一段骨架文字里是否含某个骨架 needle。 */
    function textHit(text, needles) {
      for (const needle of needles) {
        if (needle.length >= 4 && text.includes(needle)) return true
      }
      return false
    }

    /** 在行内把 needle 变成 DOM Range（骨架比较，天然忽略 markdown/标点/空白）。 */
    function findRangeIn(row, needles) {
      const index = charIndex(row)
      for (const needle of needles) {
        if (needle.length < 4) continue
        const at = index.text.indexOf(needle)
        if (at < 0) continue
        const start = index.where[at]
        const end = index.where[at + needle.length - 1]
        if (!start || !end) continue
        try {
          const range = document.createRange()
          range.setStart(start[0], start[1])
          range.setEnd(end[0], end[1] + 1)
          return range
        } catch {
          // 跨 shadow/边界等情况，换下一个 needle
        }
      }
      return null
    }

    /** 把一段 Range 滚到可视区（scrollTop 数学，绝不 scrollIntoView）。 */
    function scrollRange(scroller, range) {
      const rect = range.getBoundingClientRect()
      const box = scroller.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return false
      const target = scroller.scrollTop + (rect.top - box.top) - box.height * 0.35
      scroller.scrollTop = Math.max(0, target)
      return true
    }

    /** 在给定矩形上画一个 2 秒的浮层高亮（不动 React DOM）。 */
    function flashBox(rect) {
      if (!rect || rect.width === 0 || rect.height === 0) return
      // 不在视口内就干脆不画：以前会把框画到页面顶部（用户看到"黄框跑到最上面"）
      if (rect.top < -20 || rect.top > window.innerHeight - 8) return
      // 行可能是一整段"工作过程"，整块描边会看起来像选中了全部——限制高度
      const height = Math.min(Math.max(rect.height, 14) + 4, 180)
      const box = document.createElement('div')
      box.style.cssText = [
        'position:fixed',
        `left:${Math.round(rect.left) - 3}px`,
        `top:${Math.round(rect.top) - 2}px`,
        `width:${Math.max(rect.width, 10) + 6}px`,
        `height:${height}px`,
        'border:2px solid #f5b400',
        'background:rgba(245,180,0,.18)',
        'border-radius:3px',
        'pointer-events:none',
        'z-index:99999',
        'transition:opacity .5s',
      ].join(';')
      document.body.appendChild(box)
      window.setTimeout(() => {
        box.style.opacity = '0'
        window.setTimeout(() => box.remove(), 520)
      }, 2200)
    }

    /** 给命中位置画一个 2 秒的浮层高亮（不动 React DOM，避免打乱渲染）。 */
    function flashRange(range) {
      flashBox(range.getBoundingClientRect())
    }

    /**
     * 展开只发生在 `jumpTo` 里：命中行的行内展开（expandRowOnce）。
     * 不再有「按轮次跨行点 aria-expanded」的版本——那会把整列工具卡（pill）
     * 全点开，而且点不到真正那一张。
     */

    /**
     * 打开会话并滚到那段正文（做法参考社区 dsh-conversation-search）：
     * 1) 若停在插件面板页，先 selectPanel(null) 回到对话，否则正文根本不可见；
     * 2) openSession 打开目标会话，轮询等 `[data-chat-flow]` 出现；
     * 3) loadThrough(seq) 把目标事件读进来（分页会话里最关键的一步）；
     * 4) 当前视口扫一遍；没命中就**逐屏扫描**（先上后下，步长 0.72 视口高），
     *    因为长会话的 DOM 只渲染视口附近的行；
     * 5) 命中行里用 Range 精确定位到「词」再滚（不用 scrollIntoView，避免吸顶栏被拽走）。
     */
    async function jumpTo(ctx, hit) {
      // 会话里的原文带 markdown（**、`、#…），渲染后这些符号会消失。
      // 不去掉的话 needle 永远匹配不到，只能落到"展开整轮"的兜底上。
      const snippet = String(hit.snippet || '').replace(/^…/, '').replace(/…$/, '')
      const hitRanges = Array.isArray(hit.ranges) ? hit.ranges : []
      const firstRange = hitRanges.length > 0 ? hitRanges[0] : [0, 0]
      const matchText = firstRange[1] > 0 ? snippet.slice(firstRange[0], firstRange[0] + firstRange[1]) : ''
      const context = snippet.slice(Math.max(0, firstRange[0] - 24), Math.min(snippet.length, firstRange[0] + firstRange[1] + 24))
      const chunks = []
      for (let i = 0; i + 10 <= matchText.length && chunks.length < 4; i += 8) chunks.push(matchText.slice(i, i + 14))
      // 用「骨架」比较：** ` # > [] 这类 markdown 符号在渲染后消失，
      // 原样匹配会永远失败（用户看到的就是"跳不到、还展开上面几行"）。
      const strictNeedles = [context, matchText].map(skeleton).filter((text) => text.length >= 8)
      const looseNeedles = [snippet.slice(0, 32), String(hit.text || '').slice(0, 48), ...chunks]
        .map(skeleton)
        .filter((text) => text.length >= 6 && strictNeedles.indexOf(text) === -1)
      if (strictNeedles.length === 0 && looseNeedles.length === 0) return
      // 面板保持打开：关掉再开会让结果列表滚回顶部
      setState({ hover: -1, note: '正在跳转…' })
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
      // 3) 等正文容器出现（最多 ~6s）；若停在「轨迹」视图，先切回对话
      let flow = null
      for (let index = 0; index < 30; index++) {
        flow = flowRoot()
        if (flow) break
        if (index === 4 || index === 12) {
          const tabs = Array.from(document.querySelectorAll('button, [role="tab"], a')).filter((el) =>
            /^(对话|会话|Conversation|Chat)$/i.test(String(el.textContent || '').trim()),
          )
          if (tabs[0]) {
            try {
              tabs[0].click()
            } catch {
              // 忽略
            }
            await sleep(200)
          }
        }
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
      // 5) 落点：先在当前视口找；长会话里目标行往往还没渲染，就上下逐屏扫
      const EXPANDABLE = { reasoning: 1, 'tool-result': 1, 'tool-call': 1, ask: 1, 'ask-result': 1, 'search-result': 1 }
      const textCache = new Map()
      const expandedRows = new Set()
      let looseRange = null

      const textOf = (row) => {
        let text = textCache.get(row)
        if (text === undefined) {
          text = skeleton(row.innerText || row.textContent || '')
          textCache.set(row, text)
        }
        return text
      }

      /** 目标轮次的行优先，避免被同一轮里的"思考"抢先。 */
      const orderedRows = () => {
        const rows = flowRows(flow)
        if (!hit.turn) return rows
        const want = String(hit.turn)
        return rows.slice().sort((a, b) => Number(b.getAttribute('data-chat-turn') === want) - Number(a.getAttribute('data-chat-turn') === want))
      }

      /**
       * 只在「命中的那一行」内部展开折叠卡。
       * 之前按轮次跨行点 [aria-expanded=false]，会把整列的工具卡（用户说的 pill）
       * 全点开，而且点不到真正那一张——现在一次只碰一行，最多 3 个开关。
       */
      const expandRowOnce = async (row) => {
        if (expandedRows.has(row)) return false
        expandedRows.add(row)
        // 折叠控件的写法各版本不同：aria-expanded 的任意元素、<summary>、
        // 以及文字为「查看/展开/显示」的可点行都算候选；仍只在这一个行内。
        const selector = [
          '[aria-expanded="false"]',
          'details:not([open]) > summary',
          'button',
          '[role="button"]',
        ].join(', ')
        let clicked = 0
        for (const toggle of row.querySelectorAll(selector)) {
          if (toggle.closest('[data-slot="conversation.composer.bar"], [data-slot="conversation.composer.dock"], [data-composer]')) continue
          const expandedAttr = toggle.getAttribute('aria-expanded')
          const isSummary = toggle.tagName === 'SUMMARY'
          const label = String(toggle.getAttribute('aria-label') || toggle.textContent || '').trim()
          // 只点看起来像"展开/查看"的控件，避免误点复制、重试等按钮
          if (expandedAttr !== 'false' && !isSummary && !/查看|展开|显示|详情|View|Show|Expand|Details/i.test(label)) continue
          try {
            toggle.click()
            clicked++
          } catch {
            // 忽略
          }
          if (clicked >= 3) break
        }
        // 没有 aria/summary 控件时：DSH 的折叠头常常是普通 div（参考 chat-demo 的
        // summary 头就是 onClick 的 div），退而按"工具名 / 查看 / 展开"文字点它的可点祖先。
        if (clicked === 0) {
          const toolName = String(hit.tool || '').trim()
          const heads = Array.from(row.querySelectorAll('div, span, p'))
            .filter((el) => {
              const text = String(el.textContent || '').trim()
              if (text === '' || text.length > 80) return false
              return (toolName !== '' && text.includes(toolName)) || /查看|展开|详情|View|Expand|Show/i.test(text)
            })
            .slice(-3)
          for (const el of heads) {
            const target = el.closest('button, [role="button"], [tabindex="0"], a') || el
            try {
              target.click()
              clicked++
            } catch {
              // 忽略
            }
            if (clicked >= 3) break
          }
        }
        if (clicked > 0) {
          await sleep(170)
          textCache.clear()
        }
        return clicked > 0
      }

      /** 跳转失败时把现场 DOM 结构发给宿主落盘，便于按真实结构继续修。 */
      const diagnose = async (stage) => {
        try {
          const rows = flow ? flowRows(flow).slice(0, 6) : []
          const payload = {
            stage,
            hit: { type: hit.type, turn: hit.turn, tool: hit.tool, seq: hit.seq, sid: hit.sid },
            needles: strictNeedles.slice(0, 2),
            rowCount: flow ? flowRows(flow).length : 0,
            selector: flow ? ROW_SELECTORS.find((item) => flow.querySelector(item)) || 'none' : 'none',
            rows: rows.map((row) => ({
              turn: row.getAttribute('data-chat-turn'),
              attrs: Array.from(row.attributes).map((attr) => `${attr.name}=${String(attr.value).slice(0, 40)}`),
              textLen: String(row.innerText || '').length,
              heads: Array.from(row.querySelectorAll('[aria-expanded], summary, [role="button"], button'))
                .slice(0, 8)
                .map((el) => `${el.tagName}:${el.getAttribute('aria-expanded')}:${String(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20)}`),
              html: row.outerHTML.slice(0, 1500),
            })),
          }
          await fetch(`${API}?action=diagnose`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
        } catch {
          // 诊断失败不影响使用
        }
      }

      /**
       * 扫当前 DOM：严格串命中就返回 Range；短切片只在 useLoose 时认，
       * 且只记成 looseRange（不立刻落点），避免落到"思考"预览上。
       * hit.tool 有值时优先只看含该工具名的卡片（工具结果正文通常折叠着）。
       */
      const scan = async (useLoose, ignoreTool) => {
        if (!flow) return null
        const toolName = ignoreTool ? '' : skeleton(hit.tool || '')
        for (const row of orderedRows()) {
          const text = textOf(row)
          const strictHit = textHit(text, strictNeedles)
          if (!strictHit && !(useLoose && textHit(text, looseNeedles))) continue
          if (toolName !== '' && !text.includes(toolName)) continue
          let range = (strictHit && findRangeIn(row, strictNeedles)) || findRangeIn(row, looseNeedles)
          if (!range && EXPANDABLE[hit.type] === 1) {
            const changed = await expandRowOnce(row)
            if (changed) range = (strictHit && findRangeIn(row, strictNeedles)) || findRangeIn(row, looseNeedles)
          }
          if (!range) continue
          if (strictHit) return range
          if (!looseRange) looseRange = range
        }
        return null
      }

      const land = async (range) => {
        const anchor = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
        const scroller = scrollParent(anchor || flow)
        const previous = scroller.style.scrollBehavior
        scroller.style.scrollBehavior = 'auto'
        scrollRange(scroller, range)
        await sleep(150)
        scrollRange(scroller, range)
        scroller.style.scrollBehavior = previous
        flashRange(range)
      }

      /**
       * 展开该轮的「工作过程」卡片。
       * DOM 里它是 `[data-chat-flow-kind="turn-process"][data-chat-turn=N]` 里一个
       * 带 `aria-expanded=false` 的按钮（文案像「已完成，用时 4分50秒」）；折叠时
       * 里面的思考 / 工具行文本长度是 0，不展开就永远找不到。
       */
      const expandTurnProcess = async (turn) => {
        if (!flow || !turn) return false
        const rows = Array.from(flow.querySelectorAll('[data-chat-flow-kind="turn-process"]'))
        const target =
          rows.find((row) => String(row.getAttribute('data-chat-turn')) === String(turn)) ||
          (rows.length === 1 ? rows[0] : null)
        if (!target) return false
        const toggle =
          target.querySelector('button[aria-expanded="false"]') ||
          Array.from(target.querySelectorAll('button, [role="button"]')).find((el) => /用时|已完成|工作过程/.test(String(el.textContent || ''))) ||
          target.querySelector('button')
        if (!toggle) return false
        try {
          toggle.click()
        } catch {
          return false
        }
        await sleep(280)
        textCache.clear()
        return true
      }

      let range = await scan(true, false)
      if (!range && hit.tool) range = await scan(true, true)
      // 5a) 目标在折叠的「工作过程」里：展开该轮卡片后重扫
      if (!range && hit.turn) {
        const expanded = await expandTurnProcess(hit.turn)
        if (expanded) range = (await scan(true, false)) || (await scan(true, true))
      }

      // 5b) 折叠步骤：思考 / 运行命令 / 上下文注入 这些行折叠时 innerText 很短，
      //     按文本永远匹配不到——直接点该轮里每个「折叠步骤头」的 aria-expanded 开关。
      let anchorRow = null
      if (!range && flow && hit.turn) {
        const want = String(hit.turn)
        const turnRows = flowRows(flow).filter((row) => String(row.getAttribute('data-chat-turn')) === want)
        const foldable = turnRows.filter((row) => row.querySelector('[aria-expanded="false"]')).slice(0, 10)
        for (const row of foldable) {
          const toggle = row.querySelector('[aria-expanded="false"]')
          if (!toggle) continue
          try {
            toggle.click()
          } catch {
            continue
          }
          await sleep(160)
          textCache.clear()
          range = (await scan(true, false)) || (await scan(true, true))
          if (range) break
          if (!anchorRow) anchorRow = row
        }
        if (!range) {
          // 兜底落点优先选「工作过程」卡片本身，而不是该轮第一行（那会看起来像跳到了最上面）
          const processRow = Array.from(flow.querySelectorAll('[data-chat-flow-kind="turn-process"]')).find(
            (row) => String(row.getAttribute('data-chat-turn')) === want,
          )
          anchorRow = anchorRow || processRow || turnRows[0] || null
        }
      }
      if (range) {
        await land(range)
        setState({ note: '' })
        return
      }
      // 5c) 至少停在该轮：只滚一次，不来回扫
      if (anchorRow) {
        const scroller = scrollParent(anchorRow)
        const previous = scroller.style.scrollBehavior
        scroller.style.scrollBehavior = 'auto'
        scroller.scrollTop = Math.max(
          0,
          scroller.scrollTop + anchorRow.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 120,
        )
        scroller.style.scrollBehavior = previous
        flashBox(anchorRow.getBoundingClientRect())
        void diagnose('anchor-row')
        setState({ note: '已定位到该轮的工具调用（正文在折叠卡里，点开即可）' })
        return
      }
      // 5d) 目标行根本不在 DOM：才做有界滚动（上行 12 屏、下行 12 屏），且不再展开
      if (flow) {
        const firstRow = flowRows(flow)[0]
        const scroller = firstRow ? scrollParent(firstRow) : scrollParent(flow)
        if (scroller && scroller.scrollHeight > scroller.clientHeight + 8) {
          const home = scroller.scrollTop
          const previous = scroller.style.scrollBehavior
          scroller.style.scrollBehavior = 'auto'
          const step = Math.max(140, Math.round(scroller.clientHeight * 0.72))
          for (let i = 0; i < 12 && !range; i++) {
            const next = Math.max(0, scroller.scrollTop - step)
            if (next === scroller.scrollTop) break
            scroller.scrollTop = next
            await sleep(80)
            flow = flowRoot() || flow
            range = await scan(true, false)
          }
          for (let i = 0; i < 12 && !range; i++) {
            const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
            const next = Math.min(max, scroller.scrollTop + step)
            if (next === scroller.scrollTop) break
            scroller.scrollTop = next
            await sleep(80)
            flow = flowRoot() || flow
            range = await scan(true, false)
          }
          scroller.style.scrollBehavior = previous
          if (!range && !looseRange) scroller.scrollTop = home
        }
      }
      if (range) {
        await land(range)
        setState({ note: '' })
        return
      }
      // 只有短切片命中：落到近似位置，并说明是近似
      if (looseRange) {
        await land(looseRange)
        setState({ note: '已定位到近似位置（原文可能被 markdown 改写）' })
        return
      }
      const rowsNow = flow ? flowRows(flow) : []
      const usedSelector = flow ? ROW_SELECTORS.find((selector) => flow.querySelector(selector)) || 'none' : 'none'
      const probe = strictNeedles[0] || looseNeedles[0] || ''
      void diagnose('not-found')
      setState({
        note: flow
          ? `没定位到：正文行 ${rowsNow.length} 个（选择器 ${usedSelector}），找的是「${probe.slice(0, 14)}」`
          : '没找到对话正文容器（页面可能还没切到对话视图）',
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
            'button',
            {
              type: 'button',
              style: { ...S.select, cursor: 'pointer' },
              onClick: () => setState({ typesOpen: !s.typesOpen }),
            },
            s.types.length === 0 ? '全部类型' : `类型：${s.types.map((t) => TYPE_LABEL[t] ?? t).join(' · ')}`,
          ),
        ),
        s.typesOpen
          ? h(
              'div',
              { style: S.helpBox },
              TYPE_GROUPS.map((group) =>
                h(
                  'label',
                  { key: group.id, style: { ...S.label, marginRight: '12px', opacity: group.child ? 0.85 : 1 } },
                  h('input', {
                    type: 'checkbox',
                    checked: s.types.includes(group.id),
                    onChange: () => {
                      const has = s.types.includes(group.id)
                      let next = has ? s.types.filter((t) => t !== group.id) : [...s.types, group.id]
                      // 勾父类型时默认带上子类型（可再单独取消）
                      if (!has && group.includes) next = Array.from(new Set([...next, ...group.includes]))
                      setState({ types: next })
                      schedule(ctx)
                    },
                  }),
                  group.label,
                ),
              ),
              h('div', { style: { marginTop: '4px', color: 'GrayText' } }, '勾「工具调用」默认带「询问」；勾「工具结果」默认带「询问结果 / 搜索结果」。'),
            )
          : null,
        h(
          'div',
          {
            style: S.list,
            // 渐进渲染：滚到底再追加，几百条也不会一次画完
            onScroll: (event) => {
              const el = event.currentTarget
              if (el.scrollTop + el.clientHeight < el.scrollHeight - 120) return
              if (s.visible >= s.hits.length) return
              setState({ visible: Math.min(s.hits.length, s.visible + 40) })
            },
          },
          s.hits.length === 0
            ? h('div', { style: { padding: '14px', color: 'GrayText' } }, s.loading ? '搜索中…' : '没有命中')
            : s.hits.slice(0, s.visible).map((hit, i) =>
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
                ? `${s.hits.length} 条${s.visible < s.hits.length ? `（已显示 ${s.visible}，滚到底继续加载）` : ''} · ${s.status.tookMs ?? '?'} ms · 索引 ${s.status.ready ? '就绪' : s.status.building ? '构建中' : '未就绪'} · 拖动标题栏可移动`
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
