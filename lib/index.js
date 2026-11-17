/**
 * dsh-history-search host half — 本地会话历史的全文索引 + HTTP 检索。
 *
 * 覆盖 提问 / 回答 / 思考 / 工具调用 / 工具结果；每条文档带 会话、seq、轮次、
 * cwd。索引分两层：
 *   - `docs` 普通表存原文与归一化文本（norm = 小写 + 去空白 + 去标点）；
 *   - `docs_fts` FTS5 trigram 表存 norm，用于 ≥3 字符的子串快速检索；
 *     少于 3 字符（如两字中文）退化到 `instr` 扫描。
 * 命中后按请求的真实模式（是否忽略大小写/空格/标点，或正则）做精确后筛，
 * 再在原文上定位，返回片段与高亮区间。
 *
 * @module dsh-history-search
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-history-search'
export const inject = ['webServer', 'sessionQuery']

const API = '/api/history-search'
/** 旧库结构版本；不一致就整库重建（派生数据，可丢）。 */
const SCHEMA_VERSION = 3

const DEFAULTS = {
  path: join(homedir(), '.dsh', 'history-search', 'index.db'),
  limit: 100,
  rebuildOnStart: true,
}

/* ---------------------------------------------------------------- 文本工具 -- */

const PUNCT = /[\p{P}\p{S}]+/gu
const SPACE = /[\s\u3000]+/gu

function normalize(text, mode) {
  let out = text
  if (mode.punct) out = out.replace(PUNCT, '')
  if (mode.space) out = out.replace(SPACE, '')
  if (mode.lower) out = out.toLowerCase()
  return out
}

const INDEX_MODE = { lower: true, space: true, punct: true }

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 消息 content → 纯文本；只取真正的文本块（排除 reasoning 块）。 */
function blocksText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
    else if (block.type === 'tool-result' && Array.isArray(block.content)) parts.push(blocksText(block.content))
  }
  return parts.join('\n')
}

function streamReasoning(stream) {
  if (!Array.isArray(stream)) return ''
  const parts = []
  for (const rec of stream) {
    if (!rec || rec.type !== 'reasoning-chunks') continue
    if (Array.isArray(rec.texts)) parts.push(rec.texts.join(''))
  }
  return parts.join('\n')
}

/** 一条会话的事件流 → 可检索文档 + 标题。 */
function extractSession(events) {
  const docs = []
  let title = ''
  let turn = 0
  /** 同一会话里 callId → 工具名，供 tool/result 反查（必须在循环外，跨事件保留）。 */
  const callNames = new Map()
  for (const event of events) {
    const type = event && event.type
    const data = event && event.data
    if (!data) continue
    if (type === 'turn/start' && typeof data.turn === 'number') {
      turn = data.turn
      continue
    }
    if (type === 'session/title' && typeof data.title === 'string' && data.title.trim() !== '') {
      title = data.title.trim()
      continue
    }
    const push = (kind, text, tool) => {
      const trimmed = typeof text === 'string' ? text.trim() : ''
      if (trimmed === '') return
      docs.push({ seq: event.seq, type: kind, turn, time: event.time ?? 0, tool: tool ?? '', text: trimmed.slice(0, 20000) })
    }
    if (type === 'user/message') push('user', blocksText(data.content ?? data.message?.content))
    else if (type === 'assistant/message') push('assistant', blocksText(data.message?.content))
    else if (type === 'tool/call') {
      const name = data.name ?? ''
      if (data.callId) callNames.set(String(data.callId), name)
      push('tool-call', `${name}\n${data.arguments ?? ''}`, name)
    } else if (type === 'tool/result') {
      // 结果正文常常在折叠卡片里，带上工具名，跳转时才能定位到正确的那张卡
      const callId = data.message?.toolCallId ?? data.message?.source?.callId ?? ''
      const name = callNames.get(String(callId)) ?? ''
      push('tool-result', blocksText(data.message?.content), name)
    }
  }
  return { docs, title }
}

/** 从会话日志里抽思考文本（assistant/message 的 stream 记录）。 */
function extractReasoning(events) {
  const out = []
  let turn = 0
  for (const event of events) {
    if (!event || !event.data) continue
    if (event.type === 'turn/start' && typeof event.data.turn === 'number') turn = event.data.turn
    if (event.type !== 'assistant/message') continue
    const text = streamReasoning(event.data.stream)
    if (text.trim() === '') continue
    out.push({ seq: event.seq, type: 'reasoning', turn, time: event.time ?? 0, text: text.trim().slice(0, 20000) })
  }
  return out
}

/* ------------------------------------------------------------------- HTTP -- */

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function parseQuery(req) {
  const raw = req.url ?? ''
  const at = raw.indexOf('?')
  return new URLSearchParams(at < 0 ? '' : raw.slice(at + 1))
}

/* ------------------------------------------------------------------- 插件 -- */

/**
 * @param ctx - host root context
 * @param config - { path, limit, rebuildOnStart }
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  mkdirSync(dirname(cfg.path), { recursive: true })

  const db = new DatabaseSync(cfg.path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -131072;
    PRAGMA mmap_size = 268435456;
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `)
  // 结构版本对不上就重建（派生数据）。
  const current = db.prepare("SELECT v FROM meta WHERE k = 'schema'").get()?.v
  if (current !== String(SCHEMA_VERSION)) {
    db.exec(`
      DROP TABLE IF EXISTS docs;
      DROP TABLE IF EXISTS docs_fts;
      DROP TABLE IF EXISTS sessions;
    `)
    db.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(SCHEMA_VERSION))
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      sid   TEXT NOT NULL,
      seq   INTEGER NOT NULL,
      type  TEXT NOT NULL,
      turn  INTEGER,
      time  INTEGER,
      cwd   TEXT,
      tool  TEXT,
      text  TEXT NOT NULL,
      norm  TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(norm, tokenize = 'trigram');
    CREATE TABLE IF NOT EXISTS sessions (
      sid        TEXT PRIMARY KEY,
      title      TEXT,
      workspace  TEXT,
      cwd        TEXT,
      indexed_at INTEGER NOT NULL,
      doc_count  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS docs_sid ON docs(sid);
    CREATE INDEX IF NOT EXISTS docs_cwd ON docs(cwd);
    CREATE INDEX IF NOT EXISTS docs_type ON docs(type);
  `)

  const state = { ready: false, building: false, builtAt: 0, lastError: null, docs: 0, sessions: 0 }

  const insertDoc = db.prepare('INSERT INTO docs (sid, seq, type, turn, time, cwd, tool, text, norm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const insertFts = db.prepare('INSERT INTO docs_fts (rowid, norm) VALUES (?, ?)')
  const deleteDocs = db.prepare('DELETE FROM docs WHERE sid = ?')
  const deleteFts = db.prepare('DELETE FROM docs_fts WHERE rowid IN (SELECT id FROM docs WHERE sid = ?)')
  const upsertSession = db.prepare(`
    INSERT INTO sessions (sid, title, workspace, cwd, indexed_at, doc_count) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET title = excluded.title, workspace = excluded.workspace,
      cwd = excluded.cwd, indexed_at = excluded.indexed_at, doc_count = excluded.doc_count
  `)
  const sessionRow = db.prepare('SELECT 1 AS ok FROM sessions WHERE sid = ?')
  const countDocs = db.prepare('SELECT count(*) AS n FROM docs')
  const countSessions = db.prepare('SELECT count(*) AS n FROM sessions')

  /** 会话 id → 工作区显示名（registry 归属匹配，兜底 cwd 目录名）。 */
  const workspaceLabel = (sessionId, cwd) => {
    try {
      const workspaces = ctx.workspaceRegistry?.list?.()
      if (Array.isArray(workspaces)) {
        const hit = workspaces.find((ws) => ws && Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId))
        if (hit) return (hit.title || String(hit.path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '').trim()
      }
    } catch {
      // 忽略
    }
    return String(cwd ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  }

  const indexOne = async (sessionId) => {
    const observation = await ctx.sessionQuery.observeSession(sessionId)
    try {
      const events = observation.events ?? []
      const { docs, title } = extractSession(events)
      const reasoning = extractReasoning(events)
      const all = docs.concat(reasoning).sort((a, b) => a.seq - b.seq)
      const cwd = observation.header?.cwd ?? null
      db.exec('BEGIN')
      try {
        deleteFts.run(sessionId)
        deleteDocs.run(sessionId)
        for (const doc of all) {
          const info = insertDoc.run(sessionId, doc.seq, doc.type, doc.turn, doc.time, cwd, doc.tool ?? '', doc.text, normalize(doc.text, INDEX_MODE))
          insertFts.run(Number(info.lastInsertRowid), normalize(doc.text, INDEX_MODE))
        }
        upsertSession.run(sessionId, title || '', workspaceLabel(sessionId, cwd), cwd, Date.now(), all.length)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return all.length
    } finally {
      try {
        if (typeof observation.release === 'function') observation.release()
        else observation[Symbol.dispose]?.()
      } catch {
        // 忽略
      }
    }
  }

  const yieldLoop = () => new Promise((resolve) => setTimeout(resolve, 4))

  const refresh = async (sessionIds) => {
    const targets = new Set(sessionIds ?? [])
    try {
      const records = await ctx.sessionQuery.listSessions()
      for (const record of records) {
        const id = record.header.id
        if (record.live) targets.add(id)
        else if (!sessionRow.get(id)) targets.add(id)
      }
    } catch (error) {
      state.lastError = `listSessions: ${error instanceof Error ? error.message : String(error)}`
      throw error
    }
    let indexed = 0
    for (const id of targets) {
      try {
        await indexOne(id)
        indexed++
        await yieldLoop()
      } catch (error) {
        ctx.logger?.warn?.(`dsh-history-search: 索引 ${id} 失败 ${String(error)}`)
      }
    }
    return indexed
  }

  const rebuild = async () => {
    if (state.building) return
    state.building = true
    const started = Date.now()
    try {
      const records = await ctx.sessionQuery.listSessions()
      for (const record of records) {
        try {
          await indexOne(record.header.id)
        } catch {
          // 单个会话坏了不影响整体
        }
        await yieldLoop()
      }
      state.ready = true
      state.builtAt = Date.now()
      state.lastError = null
      state.docs = countDocs.get().n
      state.sessions = countSessions.get().n
      ctx.logger?.debug?.(`dsh-history-search: 重建完成 ${records.length} 个会话 / ${state.docs} 文档 / ${Date.now() - started}ms`)
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error)
    } finally {
      state.building = false
    }
  }

  /* ------------------------------------------------------------ 检索实现 -- */

  /** 用请求的模式在原文上找出所有命中区间（返回 [start, len] 列表）。 */
  const findRanges = (text, pattern) => {
    const ranges = []
    if (!(pattern instanceof RegExp)) return ranges
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text)) !== null && ranges.length < 200) {
      if (match[0] === '') {
        pattern.lastIndex++
        continue
      }
      ranges.push([match.index, match[0].length])
    }
    return ranges
  }

  /** 由命中区间生成片段（上下文各留 60 字符）。 */
  const buildSnippet = (text, ranges) => {
    if (ranges.length === 0) return { snippet: text.slice(0, 160), ranges: [] }
    const [first] = ranges
    const from = Math.max(0, first[0] - 60)
    const to = Math.min(text.length, first[0] + first[1] + 120)
    const prefix = from > 0 ? '…' : ''
    const snippet = prefix + text.slice(from, to) + (to < text.length ? '…' : '')
    const offset = prefix.length
    const shifted = ranges
      .filter(([start]) => start >= from && start < to)
      .map(([start, len]) => [start - from + offset, len])
    return { snippet, ranges: shifted }
  }

  const search = (params) => {
    const started = performance.now()
    const q = (params.get('q') ?? '').trim()
    const mode = {
      lower: params.get('lower') === '1',
      space: params.get('space') === '1',
      punct: params.get('punct') === '1',
    }
    const regexMode = params.get('regex') === '1'
    const scope = params.get('scope') ?? 'all'
    const sid = params.get('sid') ?? ''
    const workspace = params.get('workspace') ?? ''
    const types = (params.get('types') ?? '').split(',').filter(Boolean)
    const limit = Math.min(Math.max(Number(params.get('limit')) || cfg.limit, 1), 200)

    if (q === '') return { ok: true, total: 0, tookMs: 0, hits: [] }

    // 构造「精确」匹配器
    let pattern = null
    if (regexMode) {
      try {
        pattern = new RegExp(q, mode.lower ? 'giu' : 'gu')
      } catch (error) {
        return { ok: false, error: `正则无效：${error instanceof Error ? error.message : String(error)}` }
      }
    } else {
      const gap = mode.space || mode.punct ? '[\\s\\p{P}\\p{S}]*' : ''
      pattern = new RegExp(q.split('').map(escapeRegExp).join(gap), mode.lower ? 'giu' : 'gu')
    }

    // 范围过滤（先落到 SQL，剪枝）
    const where = []
    const whereArgs = []
    if (scope === 'session' && sid !== '') {
      where.push('d.sid = ?')
      whereArgs.push(sid)
    }
    if (scope === 'lastturn' && sid !== '') {
      where.push('d.sid = ? AND d.turn = (SELECT max(turn) FROM docs WHERE sid = ?)')
      whereArgs.push(sid, sid)
    }
    if (scope === 'workspace' && workspace !== '') {
      where.push('d.cwd = ?')
      whereArgs.push(workspace)
    }
    if (types.length > 0) {
      where.push(`d.type IN (${types.map(() => '?').join(',')})`)
      whereArgs.push(...types)
    }

    /** 候选行（id, sid, seq, type, turn, time, cwd, text）。 */
    let rows = []
    if (regexMode) {
      // 正则无法用索引：分页扫全表，命中够了就停。
      const stmt = db.prepare(`SELECT d.id, d.sid, d.seq, d.type, d.turn, d.time, d.cwd, d.tool, d.text FROM docs d ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.id`)
      for (const row of stmt.iterate(...whereArgs)) {
        pattern.lastIndex = 0
        if (pattern.test(row.text)) {
          rows.push(row)
          if (rows.length >= 400) break
        }
      }
    } else {
      const needle = normalize(q, INDEX_MODE)
      const coarse = needle.length >= 3
      if (coarse) {
        const phrase = `"${needle.replace(/"/g, '""')}"`
        const sql = `SELECT d.id, d.sid, d.seq, d.type, d.turn, d.time, d.cwd, d.tool, d.text
          FROM docs_fts f JOIN docs d ON d.id = f.rowid
          WHERE docs_fts MATCH ?${where.length ? ' AND ' + where.join(' AND ') : ''}
          LIMIT 500`
        rows = db.prepare(sql).all(phrase, ...whereArgs)
      } else {
        const sql = `SELECT d.id, d.sid, d.seq, d.type, d.turn, d.time, d.cwd, d.tool, d.text
          FROM docs d WHERE instr(d.norm, ?) > 0${where.length ? ' AND ' + where.join(' AND ') : ''}
          LIMIT 500`
        rows = db.prepare(sql).all(needle, ...whereArgs)
      }
    }

    const titleOf = db.prepare('SELECT title, workspace FROM sessions WHERE sid = ?')
    const cache = new Map()
    const hits = []
    for (const row of rows) {
      const ranges = findRanges(row.text, pattern)
      if (ranges.length === 0) continue
      const built = buildSnippet(row.text, ranges)
      let meta = cache.get(row.sid)
      if (!meta) {
        const found = titleOf.get(row.sid)
        meta = { title: found?.title || '', workspace: found?.workspace || '' }
        cache.set(row.sid, meta)
      }
      hits.push({
        sid: row.sid,
        seq: row.seq,
        type: row.type,
        turn: row.turn,
        time: row.time,
        title: meta.title || `#${String(row.sid).slice(0, 8)}`,
        workspace: meta.workspace,
        cwd: row.cwd ?? null,
        tool: row.tool ?? '',
        snippet: built.snippet,
        ranges: built.ranges,
        text: row.text.length > 4000 ? row.text.slice(0, 4000) : row.text,
      })
      if (hits.length >= limit) break
    }
    hits.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
    return { ok: true, total: hits.length, tookMs: Math.round((performance.now() - started) * 10) / 10, hits, ready: state.ready, building: state.building }
  }

  /** 工作区清单（面板的范围下拉）。 */
  const listWorkspaces = () => {
    const rows = db.prepare("SELECT cwd, count(*) AS n, max(workspace) AS label FROM sessions WHERE cwd IS NOT NULL AND cwd <> '' GROUP BY cwd ORDER BY n DESC").all()
    return rows.map((row) => ({ cwd: row.cwd, label: row.label || row.cwd, sessions: row.n }))
  }

  const route = {
    kind: 'exact',
    path: API,
    handler: (req, res) => {
      try {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        const params = parseQuery(req)
        const action = params.get('action')
        if (action === 'status') {
          return json(res, 200, {
            ok: true,
            ready: state.ready,
            building: state.building,
            builtAt: state.builtAt,
            lastError: state.lastError,
            docs: countDocs.get().n,
            sessions: countSessions.get().n,
          })
        }
        if (action === 'workspaces') return json(res, 200, { ok: true, items: listWorkspaces() })
        if (action === 'reindex') {
          void rebuild()
          return json(res, 200, { ok: true, started: true })
        }
        if (action === 'sessions') {
          const rows = db.prepare('SELECT sid, title, workspace, doc_count FROM sessions ORDER BY indexed_at DESC LIMIT 500').all()
          return json(res, 200, { ok: true, items: rows })
        }
        json(res, 200, search(params))
      } catch (error) {
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  ctx.effect(() => ctx.webServer.register(route), 'dsh-history-search: routes')

  // 每轮结束 / 改标题后增量重建该会话（1.5s 防抖）。
  const pending = new Map()
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      if (!event) return
      if (event.type !== 'turn/end' && event.type !== 'session/title') return
      const id = session?.id
      if (!id) return
      const previous = pending.get(id)
      if (previous) clearTimeout(previous)
      pending.set(id, setTimeout(() => {
        pending.delete(id)
        void indexOne(id).catch(() => {})
      }, 1500))
    })
    return () => {
      off()
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, 'dsh-history-search: incremental')

  if (cfg.rebuildOnStart) {
    void (async () => {
      try {
        await refresh()
        if (countSessions.get().n === 0) await rebuild()
        state.ready = countSessions.get().n > 0
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error)
        try {
          await rebuild()
        } catch {
          // rebuild 自己记录
        }
      }
    })()
  }
}
