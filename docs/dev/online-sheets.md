# 在线表格 / 文档：剪贴板工具 + 按需看图（开发说明）

用户 2026-10-19 定的。问题：agent 在 Chrome 里操作在线表格（腾讯文档、飞书、WPS、Google Sheets 等）很傻——这类表格的格子画在 `<canvas>` 上，
无障碍快照里只有工具栏，看不到格子、点不中格子；截图又不发给模型（`--image-responses omit`）。

目标：agent 能在 Chrome 里 ① 大块读写在线表格的数据；② 从任意网页「复制图片」贴进在线文档 / 表格；③ 需要时看画面、按坐标点。
只做通用能力，不针对哪家平台（平台的操作差异写进技能，是配置）。

已经有的，不用做：浏览器下载存成运行文件（`browser/downloads.ts`）、xlsx 读写（`files/sheets.ts`，725b843）。

## 实测（第 0 步，2026-10-19，worker 镜像里 Xvfb + 有界面的 Chrome，`connectOverCDP(..., { noDefaults: true })`）

- `context.grantPermissions(["clipboard-read","clipboard-write"], { origin })` 后，在 CDP 隔离环境（`Page.createIsolatedWorld` + `Runtime.evaluate`，
  `userGesture: true, awaitPromise: true`）里调 `navigator.clipboard`：
  - `writeText` 后 `page.keyboard.press("Control+V")` 贴进 textarea：制表符、换行原样 ✅
  - 选中文字 → `Control+C` → `readText()` 读回 ✅
  - `navigator.clipboard.write([new ClipboardItem({"image/png": blob})])` 后 `Control+V` 贴进 contenteditable：网页收到真的 paste 事件，
    `clipboardData.files` 里是 `image/png`，contenteditable 插入了 `<img>` ✅
  - `read()` 读回 `image/png` ✅
- **限制：标签页必须在前台、有焦点**，不然 `NotAllowedError: Document is not focused`。每次剪贴板操作前先 `page.bringToFront()`。
- 每个 Chrome 有自己的 Xvfb（`-displayfd` 自动分配），剪贴板天然按运行隔离。
- 测试脚本：本说明附录。

## 一、三个剪贴板工具（选了「浏览器」工具就有，不受开关控制）

放在 `browser/tools.ts` 的 `entries()` 里（和 `browser.use`、`browser.fill_captcha`、`browser.batch` 一样是网关自己的工具），实现建议放新文件 `browser/clipboard.ts`。`copy_image`、`clipboard_paste` 也能放进 `browser.batch` 连着做（`clipboard_read` 是只读的，不能放）。
都要：懒启动 / 分配 Chrome（和别的浏览器工具同一套），远程画面动作提示（`viewer.announce` + `browserActionTag` / `browserActionLabel` 加上这几个名字），
操作历史（`record`），过程记录里记一行（读写了什么类型、多少行 / 多大，不记内容）。

### `browser.copy_image` —— 「右键 → 复制图片」

右键菜单是 Chrome 原生菜单，Playwright 点不到，所以由这个工具做同样的事。

- 输入：`{ element: string（给人看的描述）, ref: string（browser_snapshot 里的元素 ref） }`；开了「允许看画面」时也可以不给 ref、给 `{ x, y }`（视口 CSS 像素）。
- 找图：ref 指向的元素本身是 `<img>` 就用它的 `currentSrc`；是 `<picture>` / 链接 / 容器就找里面唯一的（或最大的）`<img>`；
  否则看 `background-image: url(...)`；`<canvas>` 试 `toDataURL`。坐标模式用 `document.elementFromPoint` 再同样往下 / 往上找。
- **ref 的解析要验证**：ref 是 Playwright MCP 那条连接的快照生成的，我们自己的 Playwright 连接不一定认 `aria-ref=`。
  稳妥做法：网关内部通过 MCP 调 `browser_evaluate`（`{ element, ref, function }`，内部调用，不受「允许执行脚本」开关限制，也不给 agent）
  拿到图片地址、尺寸，并给元素打一个一次性的 `data-heyagent-pick="<随机串>"` 属性，我们这边再按这个属性定位（截图兜底用），用完删掉。
  先试 `page.locator("aria-ref=…")` 行不行，行就更简单；两种都要在浏览器测试里覆盖。
- 取原图：**必须走 Chrome 自己的网络栈**（代理、登录态、白名单都在 Chrome 里；Playwright 的 `context.request` 是 Node 发的请求，会绕过 gost 代理、暴露服务器真实 IP，禁止用）。
  建议 CDP `Network.loadNetworkResource`（`frameId` 用当前页主 frame，`options: { disableCache: false, includeCredentials: true }`，返回的 stream 用 `IO.read` 读完 `IO.close`）。
  `data:` 地址直接解。拿不到（报错、不是图片、超过 20 MB）就**退回元素截图**（我们这边按元素截 PNG）。
- 用 `sharp` 转成 PNG（Chrome 剪贴板只收 `image/png`），写进剪贴板，同时存成这次运行的文件（kind 用 `screenshot` 以外的合适值，
  看 `files/service.ts` 的 `FileKind`；没有合适的就加一个 `clipboard`，界面里的文件列表要能显示）。
- 输出：`已复制图片（宽×高，来源：原图 / 元素截图），剪贴板里现在是这张图；文件 id：xxx。点到要放的位置后调 browser.clipboard_paste 粘贴。`

### `browser.clipboard_read`

- 输入：`{ copy?: boolean（先按一次 Ctrl+C，默认 false）, offset?: number（从第几行接着看，默认 0） }`
- 读 `navigator.clipboard.read()`：
  - 有 `text/plain`：像表格（有制表符且多行）就按行列整理返回（标出总行数、列数，每行带行号；单元格里的引号 / 换行按 Excel 的 TSV 规则解）；否则原样返回。
    太长（比如超过 20000 字）分段：返回一段并提示 `offset`；同时把完整内容存成 `.tsv` / `.txt` 运行文件，告诉文件 id（可以 `file.read` 读）。
  - 有图片：存成运行文件，返回文件 id 和宽高。
  - 空：说清楚剪贴板是空的（如果 `copy: true`，提示可能没选中东西）。

### `browser.clipboard_paste`

- 输入：三选一 `{ text: string } | { table: string[][] } | { fileId: string }`。
  - `table` 编成 TSV（含制表符、换行、引号的格子按 Excel 规则加引号）。可以同时写一份 `text/html` 的 `<table>`（在线表格认 html 时格式更准），要实测各家不出错再加。
  - `fileId`：只能是这次运行的文件或附件（和 `file.read` 一样的检查），必须是图片；`sharp` 转 PNG 再写。
- 写进剪贴板后，在**当前焦点**处按 `Control+V`（不替 agent 点位置：先用 browser_click / 名称框把焦点放好）。
- 输出：说粘贴了什么（几行几列 / 图片宽高），提醒用 `browser.clipboard_read({copy:true})` 读回核对或 `browser.look` 看一眼（开了看图时）。

### 公共做法

- 当前页 = `instance.currentPage()`；`about:blank`、`chrome://` 这类页面直接报错说明。
- 操作前 `bringToFront()`，按当前页 origin `grantPermissions`；在隔离环境里调剪贴板（网页自己的脚本看不到；不需要「允许执行脚本」）。
- 按键用我们这边 Playwright 的 `page.keyboard`（真实按键，网页收到的是正常 paste 事件）。
- 读写剪贴板失败（焦点、权限）给能看懂的错误，不要把英文异常原样甩给 agent。

## 二、「允许看画面」（任务开关，默认关）

和「允许在网页里执行脚本」同一条路：`tasks.allow_browser_vision`（迁移）→ `@heyagent/shared` 的任务 schema `allowBrowserVision`（默认 false）→
`sessions.ts` 快照 `browser.allowVision` → 网关 / 系统提示。全仓库 grep `allowBrowserEvaluate` / `allowEvaluate`，每一处都照着加（导入、助手改配置的 schema、任务详情显示等）。

- 界面：`pages/tasks/task-dialog.tsx` 照「允许在网页里执行脚本」那一项加一个 `Checkbox` + `Field`：
  「允许看画面」，说明「agent 可以截当前画面给模型看、按坐标点击（在线表格、画布类网页用得上）。每看一次多花一张图的模型费用。」只用 registry 组件和主题 token（`docs/ui-rules.md`）。
- 打开后多两样：
  - `browser.look`：截当前标签页可见区域（JPEG，按视口 CSS 像素尺寸，DPR 不是 1 时缩到 CSS 尺寸，保证坐标对得上），**作为图片发给模型**
    （照 `file.read` 发图片的方式，`ToolOutcome.images`），同时存档成运行文件。输出写明画面宽高、坐标原点和单位，「可以直接用于 browser_mouse_click_xy」。
  - Playwright MCP 的坐标工具（`--caps vision`）：`browser_mouse_click_xy` `browser_mouse_move_xy` `browser_mouse_drag_xy` `browser_mouse_down` `browser_mouse_up` `browser_mouse_wheel`。
    做法：`mcp.ts` 的 `baseArgs` 一律加 `--caps vision`（工具清单进程里只列一次、全局缓存），没开开关的任务在 `entries()` 里把这几个过滤掉（和 `browser_evaluate` 一样）。
    远程画面的 agent 光标（`AgentCursor`）如果是按元素位置显示的，坐标工具也要显示在 x、y 上（看现有实现，简单就接上）。
- 别的工具的截图照旧只存档、不发给模型；只有 agent 主动调 `browser.look` 才发图。
- 系统提示（`engine/prompt.ts` 浏览器那段）：开了时加一句什么时候用 `look`（找菜单、确认结果、canvas 类页面），别每步都看。

## 三、系统提示里的通用用法（不针对哪家平台）

浏览器那段加几行：在线表格 / 文档的格子画在画布上、快照看不到——
读写数据走剪贴板（名称框 / 定位框里填 `A1:H200` 回车选中 → `clipboard_read({copy:true})`；点到起始格 → `clipboard_paste({table})`），不要逐格点；
写完读回同一块核对；贴图先点到位置，再 `copy_image` → `clipboard_paste({fileId})`；贴不进时用网页的「插入 → 图片 → 本地上传」配合 `browser_file_upload`。
平台各自的操作（名称框在哪、快捷键）是技能，不写进代码；另外在 `docs/skills/online-sheets.md` 写一份「在线表格和文档」技能草稿，用户自己加到技能里。

## 四、测试

- 单元测试：TSV 编码 / 解析（引号、换行、制表符、空格子、不等长行）、表格整理和分段。
- 浏览器测试（`scripts/browser-test.sh test-browser/clipboard.test.ts`，worker 镜像里跑，照 `downloads.test.ts` 的写法起本地测试站点）：
  - 测试页：一张 `<img>`（本地站点上的 PNG，带登录 cookie 才给的那种也来一张）、一个背景图元素、一个 `contenteditable`（记录 paste 事件的 types / files）、一个 textarea、一段选中后可复制的表格文字。
  - `copy_image`（ref 方式）→ 点 contenteditable → `clipboard_paste({fileId})`：paste 事件里有 `image/png`，尺寸等于原图；运行文件存上了。
  - 原图拿不到时（比如地址 404）走元素截图。
  - `clipboard_paste({table})` 贴进 textarea 得到正确 TSV；选中表格文字 → `clipboard_read({copy:true})` 读回行列。
  - 开关：没开时没有 `browser.look` 和坐标工具；开了时 `look` 返回图片、`browser_mouse_click_xy` 能点中元素。
- 引擎测试（mock 模型）：工具出现在网关里、输出格式、过程记录。
- 跑完：`pnpm lint`、`pnpm build`、`pnpm test`（服务端用私有库）、`scripts/browser-test.sh`（全部浏览器测试）。

## 附录：第 0 步测试脚本要点

```js
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin })
const cdp = await ctx.newCDPSession(page)
const { frameTree } = await cdp.send("Page.getFrameTree")
const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "heyagent-clip" })
const iso = (expression) => cdp.send("Runtime.evaluate", { expression, contextId: executionContextId, awaitPromise: true, userGesture: true, returnByValue: true })
await page.bringToFront()
await iso(`navigator.clipboard.writeText("X1\\tY1\\nX2\\tY2")`)
await page.keyboard.press("Control+V")
```
