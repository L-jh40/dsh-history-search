# 维护手册（MAINTENANCE）

这份文档记录**改这个插件时必须知道的坑**，尤其是跳转与打包相关的那几条——它们都是实际踩过的。

---

## 1. 打包 / 改文件：绝对不要用 `Set-Content -Encoding utf8`

Windows PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写入 **UTF-8 BOM**，并且如果源文件本来就是 UTF-8，`Get-Content` 会先按 ANSI(GBK) 读进来，造成**二次编码的乱码**。

后果：`package.json` 带 BOM → `JSON.parse` 抛 `Unexpected token` → **DSH 启动时静默丢弃整个插件行**：

- `list_plugins` 里查不到这一行；
- `set_plugin` 报 `unknown-plugin`；
- `install_bundle` 报 `already-installed`（包在依赖里，行没了）。

恢复正常只能 `remove_bundle` → `install_bundle`。

**正确做法**：用编辑器/写文件工具直接写；改完必须校验：

```powershell
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && echo OK
# 或看首字节
[IO.File]::ReadAllBytes('package.json')[0..2]   # 不能是 239,187,191
```

发布前跑一遍这个自检（仓库里所有 `.json` 都不该有 BOM）。

---

## 2. 结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Host 半：SQLite 派生索引（`docs` + `docs_fts` trigram + `sessions`）、`/api/history-search` 路由、增量更新 |
| `lib/client.js` | 浏览器半：`sidebar.footer.action` 按钮 + `shell.overlay` 浮窗、检索、跳转 |
| `cordis.patch.yml` | 插一行 `history-search` 到 profile |

索引路径 `%USERPROFILE%\.dsh\history-search\index.db`，`SCHEMA_VERSION` 变了会整库重建（派生数据，可丢）。

### 索引的关键决定

- `norm` = 小写 + 去空白 + 去标点；粗筛用 `docs_fts`（FTS5 **trigram**，只能 ≥3 字符）或 `instr`（2 字中文走这条）。
- 粗筛后**必须按请求模式精确后筛**（`normalize(text, mode).indexOf(...)`），否则「忽略空格」会污染「忽略大小写」。
- 文档来源：`user/message`（`data.content`，**没有外层 message**）、`assistant/message`（`data.message.content`，只取 `type:'text'` 块）、`tool/call`、`tool/result`、以及从 `assistant/message.stream` 的 `reasoning-chunks` 抽出的 `reasoning`。
- **不要把 reasoning 块混进 assistant 文档**：`blocksText` 只接受 `type === 'text'`，否则「回答」里会冒出英文思考（这是修过的 bug）。
- 增量：`session/event` 的 `turn/end`、`session/title`，1.5s 防抖重建该会话。

---

## 3. 跳转：为什么这么写

跳转不是「打开会话」就完了，有四道坎，每道都踩过：

1. **面板页挡着**：点结果时若停在插件面板页（`ctx.layout.panelInfo.getSnapshot().activePanelId !== null`），`openSession` 不会让正文可见 → 先 `ctx.layout.selectPanel(null)`。
2. **目标事件没加载**：分页会话只加载尾部 → `ctx.sessions.binding(sid).session.loadThrough(seq)`。
3. **目标行没渲染**：长会话里 DOM 只有当前视口附近的若干行 → **逐屏扫描**（向上 30 屏、再向下 30 屏，步长 ≈ 0.72×视口高），每屏扫一次行文本。
4. **不能用 `scrollIntoView`**：会把宿主吸顶栏一起拽走，宿主随后弹回；必须用 `scrollTop` 数学落点。

### DOM 锚点（会随版本变，改版先核对这里）

```
正文根： [data-slot="conversation.chat.flow"] 或 [data-chat-flow]
正文行： [data-chat-anchor-key][data-chat-turn]
        （兜底：[data-chat-turn] → [data-chat-anchor-key]）
轮次号： 行上的 data-chat-turn
折叠开关：行内 button[aria-expanded="false"]
```

**定位到「词」而不是行**：对命中行做 `TreeWalker` 逐字索引（跳过空白、`display:none`、`visibility:hidden`、`aria-hidden`），把匹配串映射回具体文本节点，构造 `Range`，再用 Range 的矩形算 `scrollTop`，最后在 Range 上覆盖一个 2 秒的黄色浮层（不改 React DOM）。

### ★ 展开只能发生在「命中的那一行」内部

早期有两个版本都在"按轮次跨行点开折叠卡"：

1. `[aria-expanded="false"]` 通配 → 把 composer 里被别的插件藏起来的官方用量 pill 全点开；
2. 限定到 `[data-chat-anchor-key][data-chat-turn]` 但仍**跨行** → 点开整列工具卡（每个工具结果都是一张可折叠的卡），而且没点中真正那张。

现在的做法是 `expandRowOnce(row)`：**只对已经按文本命中的那一行**点开关，最多 3 个，并排除 composer 的两个 slot。一行只尝试一次（`expandedRows` 集合去重）。

配套：索引给 `docs` 加了 `tool` 列（`tool-call` 取 `data.name`，`tool-result` 按 `message.toolCallId` 反查工具名），搜索结果带 `tool`，跳转时优先只看含该工具名的卡片——因为工具结果的正文默认折叠，行文本里往往只剩工具名。

### ★ 扫描时关掉平滑滚动

正文容器若带 `scroll-behavior: smooth`，连续设置 `scrollTop` 会变成"快速滑动 + 在顶部抖动"。扫描与落点前临时 `style.scrollBehavior = 'auto'`，结束后还原。

### ★ 先「就地展开」，最后才滚动

工具结果的正文默认折叠，行文本里只剩工具名——所以"按文本找行"永远找不到，旧实现只能反复滚动直到超时（用户看到的就是"快速反复滚动但打不开工具卡"）。

现在的顺序（`jumpTo`）：

1. 当前 DOM 里按 `hit.turn` + `hit.tool` 找**该轮的工具卡行**；
2. 就地 `expandRowOnce(row)` 展开，展开后再在该行内找 Range；
3. 找不到就停在那一轮（`scrollTop` 一次，黄框闪一下）并提示"正文在折叠卡里"；
4. **只有目标行根本不在 DOM** 时才做有界滚动（上行 12 屏、下行 12 屏，不做展开）。

### ★ 结果列表渐进渲染

`hits` 可能几百条，一次性 `map` 会卡住主线程。现在 `store.visible` 从 24 起，列表滚到底部再 +40；新结果到达时重置为 24。页脚显示「已显示 N，滚到底继续加载」。

### ★ 类型「询问」（ask）

`ask_user_question` 的 `tool/call` 不再进 `tool-call`，而是单独成 `ask` 文档：问题 + 选项（`askText()` 解析 arguments JSON）。用户对询问的回答仍然是普通 `user/message`，两类一起用就能按"问过什么 / 怎么答的"检索。

### ★ 折叠头不是 ARIA 控件（对着 chat-demo 源码确认）

`deepseek-ai/chat-demo` 的 `AssistantMessage.tsx` 里，思考/摘要头是**普通 div + onClick**，没有 `aria-expanded`。所以只找 `button[aria-expanded=false]` 会"一个都点不开"。现在的展开顺序：ARIA 控件 → `<summary>` → 按「工具名 / 查看 / 展开」文字找可点祖先（限行内、最多 3 个）。

### ★ 失败现场诊断

跳转失败时客户端会 `POST /api/history-search?action=diagnose` 把现场（该轮行的属性、可点控件清单、outerHTML 片段）发到宿主，宿主追加写入 `%USERPROFILE%\.dsh\history-search\diagnose.log`。排查真实 DOM 先看这个文件，不要靠猜。

### ★ 排序：候选必须先按时间取，再排序

曾经写成 `... WHERE MATCH ? LIMIT 500`，然后在 JS 里按时间 sort。**MATCH 的 500 条是任意序**（FTS 的 rank/rowid），不是最新的 500 条——搜常见字（"你"）时顶部全是旧日期，本会话最近的内容压根没进候选。

现在两条 SQL 都带 `ORDER BY d.time DESC LIMIT 500`，再在 JS 里做精确后筛与排序。常见字的结果顺序才和"最近"一致。

### ★ 子类型：ask / ask-result / search-result

- `ask`：`tool/call` 且 `name === 'ask_user_question'`，文本是问题 + 选项；
- `ask-result`：对应那条 `tool/result`（用户回答的内容）；
- `search-result`：`tool/result` 且工具名匹配 `/search|fetch|web|anysearch|browse|crawl|scrape|extract/i`。

客户端里勾「工具调用」默认带 `ask`，勾「工具结果」默认带 `ask-result` + `search-result`，可单独取消。

### ★ 标点：中英文一起忽略

`PUNCT` 除了 `\p{P}\p{S}`，显式并上全角标点集合（，。！？；：、·…—～【】《》「」『』（）“”‘’），避免个别全角符号没被 `\p{P}` 覆盖。

### ★ 增量：按 step 结束就更新

原来只在 `turn/end` 触发；现在 `step/end`、`turn/end`、`session/title` 都触发，1.5s 防抖重建该会话——一轮跑很久时也能搜到中途的内容。

### 为什么偶尔只落到「消息」而不是「词」

- markdown 改写了文本（`**`、反引号、链接、表格），原文与 DOM 文本不一致 → 已用「命中点前后 24 字 + 3 段 14 字切片」多档 needle 兜底；
- 文本跨多个节点且中间夹着不可见元素；
- 命中位于折叠的思考/工具卡片里 → 只在**严格行**内点 `button[aria-expanded="false"]`，且排除 composer 子树。

### ★ 两级 needle：严格串优先，短切片只兜底

同一个词常常同时出现在「回答」正文和同一轮的「思考」侧栏里。早期实现把长串和短切片混在一个数组里按顺序试，结果短切片先命中"思考"预览，落点跑到思考上，看起来像"点回答却跳去思考"。

现在的顺序是：

1. 严格串 = 命中点前后 24 字上下文 + 完整命中词（≥8 字）；
2. 短切片（14 字，最多 4 段）只在严格串全找不到时才用，而且只记为"近似位置"，落点后提示「已定位到近似位置」；
3. 扫描时**目标轮次的行优先**（`data-chat-turn === hit.turn`）；
4. **折叠展开只对 `reasoning` / `tool-result` / `tool-call` 类型**：点"回答"时绝不点开思考。

### ★ 跳转期间不要关面板

早期在跳转开始时 `setState({ open: false })`，跳完再打开——React 重新挂载的结果列表会滚回顶部，用户体感是"跳转后搜索窗口回到最上面"。现在面板保持挂载，只在底部提示「正在跳转…」，列表的滚动位置自然保留。

### 失败提示的读法（排障入口）

| 面板底部提示 | 含义 | 下一步 |
|---|---|---|
| `没找到对话正文容器` | 没进对话视图 / 选择器全失效 | 核对上面 4 个锚点 |
| `没定位到：正文行 N 个（选择器 X）` | 行有了但文本不含 needle | N=0 → 锚点失效；N>0 → needle 与渲染文本差异 |
| `已定位到所在消息，但没框出那个词` | 行命中、Range 没构造出来 | 跨节点 / markdown 改写 |
| `打开会话失败：…` | `openSession` 抛错 | 会话 id 或权限 |

### ★ 血泪教训：不要用通配去点 `[aria-expanded="false"]`

早期版本为了展开折叠内容，对所有 `[aria-expanded="false"]` 直接 `.click()`，且行选择器有退化分支。结果退化到宽容器时，把 **composer 里被其他插件隐藏的官方用量 pill 全点开了**。

现在必须：只对**严格行** `[data-chat-anchor-key][data-chat-turn]` 操作、只点 `button[aria-expanded="false"]`、显式排除 `[data-slot="conversation.composer.bar"]` 与 `[data-composer]`、最多 4 个。

---

## 4. 性能基线（36k 文档，128MB 页缓存 + mmap）

| 查询 | 耗时 |
|---|---|
| ≥3 字符（trigram） | 2–8 ms |
| 2 字中文（`instr` 扫描） | 85–125 ms |
| 限定会话 / 最后一轮 | 25–31 ms |
| 正则（全表扫描） | ~2 s |

索引体积约 326 MB（trigram 占大头）。`PRAGMA cache_size=-131072`、`mmap_size=268435456` 是必须的，否则 2 字查询会掉到 1.5 s。

---

## 5. 发布

1. 改完 `node -e "JSON.parse(...)"` + `new Function(读 client.js)` 自检；
2. 版本号 +1（`package.json` 的 `version`，用写文件工具改，别用 `Set-Content`）；
3. 推 GitHub（`github.com` 被墙时 git push 会超时；`api.github.com` 通常可用，可走 REST blobs/trees/commits）；
4. 本地装/重装：`plugin_manager` 的 `install_bundle`（目录路径），装完 `curl /api/history-search?action=status` 应返回 200；
5. 客户端改动需要**刷新页面**（client bundle 在页面加载时取）。

---

## 6. 已知限制

- 只索引 `listSessions()` 能列出的逻辑会话；旧格式代（v0/v1/v2）需先迁移。
- 正则模式逐行扫全表，无中断。
- 跳转依赖正文渲染；扫描会滚动页面（最多约 5 秒），期间面板是关闭的。
