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

### 为什么偶尔只落到「消息」而不是「词」

- markdown 改写了文本（`**`、反引号、链接、表格），原文与 DOM 文本不一致 → 已用「命中点前后 24 字 + 3 段 14 字切片」多档 needle 兜底；
- 文本跨多个节点且中间夹着不可见元素；
- 命中位于折叠的思考/工具卡片里 → 只在**严格行**内点 `button[aria-expanded="false"]`，且排除 composer 子树。

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
