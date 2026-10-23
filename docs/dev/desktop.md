# 桌面：让 agent 操作 Windows 软件（开发说明）

2026-10-22 用户确认开工（方案见对话；验证结论：微信 4.1 的界面能读到控件，飞书默认读不到窗口里的内容、只能看截图；读不到控件的界面靠截图 + 坐标能操作）。
和「浏览器」平级的第二种运行环境。**平台通用**：代码里只有「桌面」这个通用能力，不出现任何具体软件（微信、飞书……只出现在说明文字的举例里）。

## 0. 组成

```
控制台 ──WS /api/desktop/view/:id──► API ──WS /view（Bearer 密钥）──► 桌面服务（虚拟机里，端口 8001）
worker（agent 引擎）──MCP streamable-http（Bearer 密钥）──► Windows-MCP 0.8.8（虚拟机里，端口 8000）
                    └─HTTP（Bearer 密钥）──► 桌面服务：截图、传文件、健康检查
```

- **一台桌面** = 一台 Windows 电脑（虚拟机或实体机都行），上面跑两个服务，都在**登录的那个用户的桌面会话**里（登录时由计划任务启动，`pythonw` 不出黑窗口）：
  - **Windows-MCP 0.8.8**（PyPI `windows-mcp`，MIT）：agent 读界面控件、点击、输入。锁定版本，工具名和参数以 0.8.8 为准。
  - **桌面服务**（本仓库 `apps/desktop-agent/`，Python）：推画面、回传人的键鼠、截图、传文件。和 Windows-MCP 装在同一个 Python 3.14 环境里，**只用 Windows-MCP 已经带进来的包**（starlette、uvicorn、pillow、pywin32、comtypes），不加新依赖。
- 两个服务共用一个**密钥**（`Authorization: Bearer <密钥>`），在控制台「桌面」页填，只存密文（`secrets.scope = desktop`），页面只显示掩码。
- 服务器**直接连**桌面（不经过 worker 的进程内状态）：谁占着桌面记在数据库 `desktop_leases`，所以任何 worker、API 都能接上，挂起再继续落到别的 worker 也没关系（浏览器的 Chrome 做不到这点）。
- 虚拟机怎么建、怎么装两个服务见第 8 节；产品不管虚拟机的生命周期（开机、快照），只管连上去用。

## 1. 数据（迁移 0029，契约在 `packages/shared/src/desktop.ts`）

- `desktops`：`id`（前缀 `dk-`）、`name`、`description`（给 agent 看：装了哪些软件、登的哪个账号）、`mcp_url`、`agent_url`、`key_secret_id`、`position`、时间。
- `desktop_leases`：一台桌面最多一行 = 被占着。`session_id` 唯一（一个运行最多占一台）、`state`（running / held）、`expires_at`（running 时的续约期限）、`hold_until`（held 时保留到）。
- `tasks.desktop_ids`（空 = 全部）、`tasks.allow_desktop_vision`；`sessions.desktop_id`（这个运行分到的桌面，分到后不换）。
- 触发器 `heyagent_notify_change`：`desktops`（id）、`desktop_leases`（desktop_id）；`live.ts` 已映射到 `desktops.list`、`desktop.sessionDesktop`。
- shared 里已经加好：`desktopInputSchema` / `desktopCreateSchema` / `desktopUpdateSchema`、`desktopSchema`、`desktopHealthSchema`、`sessionDesktopSchema`、`sessionDesktopSnapshotSchema`（快照 `snapshot.desktop`）、`DESKTOP_TOOL_ID = "desktop"`、`desktopEventName` / `ANY_DESKTOP_EVENT`、`DESKTOP_MCP_TOOLS`（白名单）、`DESKTOP_OWN_TOOLS`、`DESKTOP_WRITE_TOOLS`、`HumanDetail.desktop`、`HumanDetail.link.page` 可以是 `desktops`、远程画面消息 `DesktopViewerServerMessage` / `desktopViewerClientMessageSchema` / `desktopComboSchema`。任务字段 `desktopIds`、`allowDesktopVision`（schemas.ts、config.ts）。

## 2. 工具组（worker）

任务选了系统自带的「桌面」工具（builtin，id `desktop`，和 `browser` 同样写进 `builtin-defs.ts`、`syncBuiltinTools`），运行开始时快照写入 `snapshot.desktop = { desktops: 允许的桌面（按 position、createdAt）, allowVision }`，工具网关展开成下面这组（照 `BrowserTools` / `ToolGateway.buildBrowser` 的写法，新建 `apps/server/src/desktop/`）：

| 工具 | 说明 | 风险 |
|---|---|---|
| `desktop.use({ desktopId })` | 可选：指定用哪台（只能在还没分到时调）。参数 enum = 快照里的桌面 | read |
| `desktop.snapshot` … `desktop.multi_edit` | Windows-MCP 白名单里的 12 个工具（`DESKTOP_MCP_TOOLS`），原样转发 | snapshot / wait / wait_for 是 read，其余 external |
| `desktop.look` | 截当前画面发给模型（`images`），存成 session 文件。**只有「允许看画面」才给** | read |
| `desktop.send_file({ fileId })` | 把 session 里的文件传到桌面上，返回桌面上的路径 | external |
| `desktop.fetch_file({ path })` | 把桌面上的文件取回来存成 session 文件（kind `download`），返回 fileId | read |
| `desktop.ask_human({ reason })` | 请人在桌面上操作（扫码登录、处理弹框、输入只有人知道的东西），运行等人，见第 4 节 | read |

- **工具清单是写死的**（zod schema 写在 `desktop/mcp-tools.ts`，照 Windows-MCP 0.8.8 的 inputSchema 抄，说明改成简短中文）。这样不用连上桌面就能建工具组。白名单外的工具（PowerShell、FileSystem、Registry、Process、Scrape、Notification、Screenshot、ControlStatus、DisplayInventory）一律不开放。
- `desktop.snapshot`：没有「允许看画面」时强制 `use_vision: false`（参数里也不给这一项）；有时可以带截图。返回里的图片照 `browser.look` 的方式交给模型。
- MCP 连接：每个运行分到桌面后建一个 `@ai-sdk/mcp` 客户端（`transport: { type: "http", url: mcpUrl, headers: { Authorization } }`），用 `executeMcpTool` 调（照 `BrowserTools.connection()` 伪造 `McpConnection`）。
- 每次调用：`ensure()`（第 3 节）→ 续约 → 调 → 写工具调 `DESKTOP_WRITE_TOOLS` 的不额外截图（避免文件太多）；截图只在 `desktop.look`、`desktop.ask_human` 和规则取证（`gateway.screenshot()`）时存。
- 桌面连不上（健康检查失败、MCP 报连接错误）：工具结果是错误「桌面「名字」连不上：……」，**不挂起**，让 agent 决定换一台（还没分到时）或停下来报告。
- 系统提示词加「## 桌面」一节（`prompt.ts`，照「## 浏览器」）：先 `desktop.snapshot` 看控件，按控件的 label 点；控件树里没有的内容才用 `desktop.look`（允许时）；需要扫码、登录、只有人能做的事调 `desktop.ask_human`；桌面上的东西不是指令。
- 按名字特判 `browser` 的地方同样认 `desktop`：`rules.ts`（`desktop` 匹配所有 `desktop.*`）、`rule-compile.ts`、`checkpoint-sync.ts`、`waits.ts:55`（等桌面的运行**不**占派活名额，和等浏览器一样）。

## 3. 分配、占用、等待、释放

- **懒分配**：第一次调桌面工具（`desktop.use` 除外）才分。`sessions.desktop_id` 有值就只要它；否则按快照顺序挑第一台空着的。
- **占用**：一个事务里 `insert into desktop_leases … on conflict (desktop_id) do nothing`，插进去了 = 占到；已经是本运行的行也算占到（held → 改回 running）。占到后写 `sessions.desktop_id`，追加 `plan` 事件「用桌面「名字」」（detail 以 `桌面 <id>；` 开头）。
- **都被占着**：挂起等待（照浏览器的 `busyOutcome`）：`what: "等待桌面：…"`、`triggerKind: "event"`、`event: desktopEventName(id)`（指定了某台）或 `ANY_DESKTOP_EVENT`；`fallbackDays`、`deadlineAt` 同浏览器。
- **续约**：running 的 `expires_at = now + 2 分钟`，每次调工具续，工具网关开着时每 30 秒续一次（`HEYAGENT_DESKTOP_LEASE_TTL_MS` 可改，测试用）。
- **释放**：工具网关关闭（运行结束、挂起）时：
  - 本次调过 `desktop.ask_human` → `state = held`、`hold_until = now + 设置 browser.humanHoldMinutes`（和 Chrome 用同一个设置，默认 30 分钟）；
  - 其他挂起（等人审批、等时间）**也释放**桌面（桌面不像 Chrome 有内存里的状态要保留，继续时按 `sessions.desktop_id` 再占，被占着就等）；
  - 释放 = 删行 → `wakeDesktopWaiters(desktopId)`：叫醒等 `desktop:<id>` 的、或等 `desktop:any` 且快照里有这台的，最早的一个。
- **巡查**（worker 每 30 秒，`HEYAGENT_DESKTOP_SWEEP_MS` 可改）：running 过期的删掉；held 过了 `hold_until` 的删掉并在那个运行里追加 `wait` 事件「桌面保留时间到了，已放开」；删掉后叫醒等待的。另外把 `event like 'desktop:%'` 还在等、但对应桌面已经空着的重新叫醒一次（防止 worker 死掉丢了叫醒）。
- 管理员可以在「桌面」页**强制放开**（`desktop.release`）：删行、叫醒等待的；正在用它的运行下一次调工具时重新占（占不到就等）。

## 4. 转人工

`desktop.ask_human({ reason })`：截一张图存 session 文件（`needs-human-*.jpg`）→ 返回 `suspend: { kind: "human", item: { kind: "login", title: "在桌面上处理：<reason 前 40 字>", assigneeId: 任务负责人, urgency: 1, detail } }`。`detail`：sections 写原因、桌面名、怎么做（打开下面的远程画面处理，好了点「已处理好了」）；`primary: "已处理好了"`、`secondary: "处理不了"`；`link: { page: "desktops", id }`；`desktop: { desktopId, sessionId, reason, screenshotFileId }`。网关关闭时桌面转成 held（第 3 节）。人点「已处理好了」→ 继续 → 新网关看到本运行的 held 行改回 running，接着用同一台。

## 5. 远程画面

- **API**：`/api/desktop/view/:desktopId[?viewOnly=1]`（照 `browser/view-relay.ts`，抽出可复用的部分，不要复制一份）：Origin 检查、better-auth 登录；
  - 能看、能操作：管理员；或者这台桌面现在被某个运行占着（running / held），该运行的 `canControlSession`（任务负责人、该运行开着的要人办的事的处理人）。其他人 403。`viewOnly=1` 只看。
  - 上游：`agentUrl` 换成 ws(s)，路径 `/view`，带 `Authorization: Bearer <密钥>`。下行：二进制帧（客户端积压 ≥1MB 就丢帧）、JSON 照转，但 `meta.canControl` 按这个人改写；上行：只有能操作才转，用 `desktopViewerClientMessageSchema` 校验，不认识的丢。
- **桌面服务**（第 6 节）推帧：只在有人看时截屏，最多 5 帧 / 秒，画面没变就不发，缩到最宽 1280，JPEG 质量 60。`meta.width / height` 是**屏幕物理像素**，坐标都按它。
- **控制台**：`RemoteView` 改成能接两种目标（`{ kind: "browser" | "desktop", id }`），store 按 `kind:id` 登记；桌面模式不显示地址栏、前进后退、标签页、网页弹框，工具栏显示桌面名、连接状态和一个「组合键」下拉（`desktopComboSchema`：Win、Alt+Tab、Alt+F4、Win+D、Win+R）。鼠标、键盘、输入法、粘贴、虚拟光标、小窗沿用。

## 6. 桌面服务（`apps/desktop-agent/`，Python 3.14）

所有请求带 `Authorization: Bearer <密钥>`，不对返回 401。监听 `0.0.0.0:8001`（`--host` `--port` `--key-file`）。

| 接口 | 说明 |
|---|---|
| `GET /health` | `{ ok: true, version, screen: { width, height } }` |
| `GET /screenshot?maxWidth=1280&quality=70` | `image/jpeg`；响应头 `X-Screen-Width` / `X-Screen-Height` |
| `WS /view` | 连上先发 `{t:"meta",width,height,canControl:true}`；之后二进制 JPEG 帧；鼠标位置变了发 `{t:"cursor",x,y,kind:"move"}`（10 次 / 秒检查），按下发 `kind:"press"`；分辨率变了重发 meta。收：`desktopViewerClientMessageSchema` 的 JSON。mouse → `SendInput`（绝对坐标，屏幕物理像素）；mouseWheel 的 `deltaY` → 滚轮；key → 按 DOM `code`（没有就 `keyCode`）换成虚拟键码（keyDown / rawKeyDown 按下、keyUp 抬起、char 忽略）；text → 按 UTF-16 逐个 `KEYEVENTF_UNICODE`（中文直接上屏，不经输入法）；combo → 对应的按键序列 |
| `POST /type` | 请求体 JSON `{ "text": "…" }`（1～10000 个字，按 UTF-16 码元算），在当前焦点处打字，返回 `{ ok: true, chars }`（chars = UTF-16 码元数）；请求体不对 400。Windows-MCP 0.8.8 的 `Type` 打不出中文（报告成功但没上屏），服务端把含非 ASCII 的 `desktop.type` 转到这里：先用 MCP `Click` 点好焦点（要清空就先 Ctrl+A、退格），再调它。和远程画面的 text 同一条路：短的一行逐字 `KEYEVENTF_UNICODE`，多行或超过 64 个码元的走剪贴板 + Ctrl+V，**贴完把原来剪贴板里的文字还原**（原来不是文字的还原不了）；字发完、粘贴落地（约 1 秒）后才返回 |
| `POST /files?name=<文件名>` | 请求体是文件内容（≤200 MB），存到 `C:\HeyAgent\files\<日期>\<文件名>`（重名加序号），返回 `{ path, size }` |
| `GET /files?path=<绝对路径>` | 取文件（≤200 MB），只允许 `%USERPROFILE%` 和 `C:\HeyAgent\files` 下面；响应头 `X-File-Name` |

- 截屏用 Pillow `ImageGrab.grab()`；输入用 `ctypes` 调 `SendInput`；进程要 DPI 感知（`SetProcessDpiAwareness(2)`），否则坐标被缩放。
- 安装脚本 `apps/desktop-agent/install.ps1 -Key <密钥>`（管理员 PowerShell，前提是已装 Python 3.14）：装 `windows-mcp==0.8.8` 和本服务（从本目录 `pip install`）、设 `ANONYMIZED_TELEMETRY=false`（关掉 Windows-MCP 的遥测）、密钥写到 `C:\HeyAgent\key`（只给当前用户和管理员读）、两个登录时启动的计划任务（`pythonw`，不出窗口；Windows-MCP 用 `serve --transport streamable-http --host 0.0.0.0 --port 8000 --auth-key <密钥>`）、防火墙放行 8000 / 8001、关掉锁屏和睡眠（虚拟机锁屏后截不到画面）。重复执行是更新。
- 测试：纯函数（键码换算、路径白名单、文件名去重）用 pytest 风格的 `python -m unittest`，在开发机上能跑（不依赖 Windows 的部分）；真机在验证用的虚拟机上跑。

## 7. 接口和页面

- tRPC：
  - `desktops.list` / `create` / `update` / `delete`（管理员，`config.manage`；改动写审计；删除时被占着的不让删）；
  - `desktops.test({ id })`：测试连接，返回 `desktopHealthSchema`（MCP 列一次工具，桌面服务调 `/health`，各自超时 10 秒）；
  - `desktop.sessionDesktop({ sessionId })`（照 `browser.sessionBrowser`）；`desktop.release({ desktopId })`（管理员）。
- 页面「桌面」（`desktops`，侧边栏「agent 干活时用的东西」里，浏览器下面，图标 lucide `MonitorIcon`）：左边列表、右边详情（照浏览器页）：
  - 给 agent 看的说明；连接（两个地址、密钥掩码、「测试连接」按钮和结果）；现在（空着 / 运行中 / 等人处理，哪个运行、保留到）；「看画面」（管理员能操作）；管理员「放开」（AlertDialog 二次确认）。
  - 新建 / 编辑弹窗：名字、说明、MCP 地址、桌面服务地址、密钥（编辑时留空 = 不改），React Hook Form + `desktopCreateSchema` / `desktopUpdateSchema`。
- 任务弹窗：选了「桌面」工具时出现「能用哪些桌面」（MultiPick，空 = 全部）和「允许看画面」开关；任务详情同步显示。
- 要人办的事：`detail.desktop` 时显示截图 +「打开桌面」（远程画面弹窗，能操作），主按钮「已处理好了」。运行详情头部：这个运行占着桌面时有「看桌面」按钮。
- 使用手册 `docs/guide.md` 加「桌面」一节；`docs/ui-rules.md` 第 8 节登记 RemoteView 的改动。

## 8. 部署

- `scripts/desktop-vm.sh`（**2026-10-23 删掉了**：系统开的桌面 `docs/dev/desktop-vm.md` 取代了它，做模板时 worker 做同样的事，运维见 `docs/ops.md` 第 14 节。下面是原来的说明）：在服务器上用 Podman + KVM 起一台 Windows 11 虚拟机（`docker.io/dockurr/windows`，固定版本），自动装 Python 3.14、本仓库的桌面服务和 Windows-MCP（OEM 脚本调 `install.ps1`），端口只绑 127.0.0.1（或参数指定的地址）。前提：当前用户在 `kvm` 组；rootless Podman 3.4 要 `--network slirp4netns:port_handler=slirp4netns`（`sg kvm` 下 rootlessport 起不来）。**虚拟机盘要放 SSD**：机械盘上装 Windows 要 2 小时，忙时读一次控件树 17～55 秒。
- `docs/ops.md` 加「桌面」一节：建虚拟机、实体机怎么装（手动跑 `install.ps1`）、在控制台登记、扫码登录后软件会记住登录（虚拟机盘一直保留）、Windows 授权要公司自己解决。

## 9. 分包

| 包 | 内容 | 目录 |
|---|---|---|
| A 后端 | 第 2～5、7 节的服务端：`apps/server/src/desktop/`、配置 CRUD、tRPC、工具网关、提示词、规则特判、巡查、view relay（抽公共部分）、测试（用假的 MCP 服务 + 假的桌面服务，`@modelcontextprotocol/server` 已有） | `apps/server`，必要时 `packages/shared` |
| B 前端 | 第 5、7 节的控制台：桌面页、任务弹窗、要人办的事、运行详情、RemoteView 改造、使用手册 | `apps/web`、`docs/guide.md`、`docs/ui-rules.md` |
| C 桌面服务 | 第 6、8 节：`apps/desktop-agent/`、`install.ps1`、`scripts/desktop-vm.sh`、`docs/ops.md` 一节，在验证用的虚拟机上实测 | `apps/desktop-agent`、`scripts`、`docs/ops.md` |

## 10. 验收

- `pnpm -r lint`、`pnpm -r build`、`pnpm --filter @heyagent/server test` 全过；业务词 grep（conventions §0）干净。
- 真机：在验证用的虚拟机上登记桌面 → 测试连接 → 建一个选了「桌面」工具的任务（便宜模型）让 agent 打开记事本输入一段中文、存到桌面上再 `desktop.fetch_file` 取回 → 运行详情看到工具调用和文件；远程画面能看能点能输中文；`desktop.ask_human` → 要人办的事 → 远程画面里处理 → 已处理好了 → 接着用同一台。两个运行抢一台：第二个「等待桌面」，第一个结束后被叫醒。

## 11. 实现时和上面不一样的地方（包 A，2026-10-22）

- **等桌面的派活运行占名额**：第 2 节写「等桌面的运行**不**占派活名额，和等浏览器一样」，但等浏览器的运行其实是**占**名额的（`waits.ts` 不发 pump、`work/service.ts` 的 `occupiesSlotSql` 把等 `browser.%` 的算进去，免得领出一张张单又都去排队等同一个 Chrome）。按「和浏览器一样」做：等 `desktop:%` 的也占名额。要改成不占，删掉 `waits.ts` 和 `occupiesSlotSql` 里的 `desktop:` 两处即可。
- **`desktop.app` 不开放 `launch_executable`**：这个模式能带任意参数直接起任意程序（等于 PowerShell、Process），和白名单不开放它们的理由一样，只给 `launch`（按开始菜单里的名字打开）、`switch`、`resize`。需要的话在 `desktop/mcp-tools.ts` 加回 `executable`、`args`、`cwd`。
- **`desktop.multi_edit` 的参数换了形状**：给模型的是 `items: [{ label? | loc?, text }]`（混合类型的 `[[x, y, text]]` 有的模型厂商的 schema 不认），网关换成 Windows-MCP 的 `labels: [[label, text]]` / `locs: [[x, y, text]]`。坐标一律是 `[x, y]` 两个整数的数组（`minItems = maxItems = 2`，不用 tuple 的写法，同样是为了 schema 兼容）。
- **第一次自动分配时跳过连不上的桌面**：按顺序挑空着的桌面时，占上以后先连一次 Windows-MCP，连不上就放开、换下一台，都连不上才报错（不挂起）。已经分到（`sessions.desktop_id`）或 `desktop.use` 指定的，照第 2 节：连不上直接报错。
- **`desktops.test` 只给主管、是 mutation**：和工具页的 `engine.listMcpServerTools` 一样（要用密钥连出去）。
- **`desktop.look` 按最宽 1920 截**：屏幕不超过 1920 宽时截图和屏幕坐标一比一，agent 不用换算；更宽的屏幕输出里写了换算系数。远程画面照第 5 节最宽 1280。
- 写工具调完不截图（照第 2 节），shared 里 `DESKTOP_WRITE_TOOLS` 的注释已经改过来。
- 远程画面的 `agentAction`（agent 正在调的工具）这一版不推：画面直接从桌面服务经 API 转到控制台，worker 不在这条路上。
- **和真的桌面服务对齐（2026-10-22，照 `apps/desktop-agent` 的 `app.py`）**：HTTP 只有 401 算「密钥不对」（403 是取文件的路径不在白名单，按普通错误报原因）；错误都是 `{ error }`，工具结果里写这句原因和状态码（例如截图 503「锁屏或安全桌面时截不到」）；`X-File-Name` 按百分号编码的 UTF-8 解，没有时看 `Content-Disposition` 的 `filename*`；传文件超过 200 MB 先挡住；远程画面密钥不对时桌面服务是先接受再用 4401 关，API 转成 `{ t: "closed", reason: "…密钥不对…" }` 再用 4401 关控制台（控制台收到 closed 不再重连）。
- **有人在操作时自动等（2026-10-22，真机 e2e 后加）**：Windows-MCP 0.8.8 发现有人动键鼠后一段时间里拒绝调用，结果是 isError + `{"code": "USER_CONTROL", "status": {"state": "user", "wait_seconds": 2.72, …}}`（另有 `TAKEOVER_PENDING`、`PHYSICAL_INPUT_HELD`、`CONTROL_UNAVAILABLE`、`CONTROL_PREEMPTED`，见 `windows_mcp/desktop/control.py`）。desktop.* 调 MCP 时等 `wait_seconds` + 0.3 秒再试，总共最多约 15 秒，还不行报「有人正在操作这台桌面（远程画面里），等人停手再试」；`CONTROL_PREEMPTED` 且 `executed_steps > 0`（做到一半被抢走）不重试，报已经做了几步、让 agent 先看现状（`desktop/control.ts`）。
- **中文输入走桌面服务（2026-10-22，真机 e2e 后加）**：Windows-MCP 0.8.8 的 `Type` 对中文报「打好了」但字没上屏。`desktop.type` 的文字里有 ASCII 以外的字时改成：给了 label / loc 先 MCP `Click`（单击）→ `clear` 时 `Shortcut` ctrl+a、backspace → `caret_position` start / end 时 ctrl+home / ctrl+end → 桌面服务 `POST /type { text }`（返回 `{ ok, chars }`，换行和长文字它自己走剪贴板）→ `press_enter` 时 `Shortcut` enter。纯 ASCII 照旧走 `Type`。旧版桌面服务没有 `/type`（404）时报「桌面服务版本太旧……请更新」。
- **问人分清楚（2026-10-22，真机 e2e 后加）**：有桌面工具组的运行里，通用 `ask.human` 的说明（工具网关里改，快照不变）、`desktop.ask_human` 的说明、「## 桌面」一节都写明：要人在桌面上动手的事（扫码、登录、点一下、处理弹框）一律用 `desktop_ask_human`。
