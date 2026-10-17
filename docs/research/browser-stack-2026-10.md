# 浏览器技术栈复核与 v1 做法（2026-10）

> 日期 2026-10-17。在 `browser-sharing.md`（2026-10-16）的基础上复核和补全，旧报告不改。版本号来自当天的 `npm view` / PyPI。「实测」是指在本机 scratchpad 里跑过的无害验证：只用了本地假站点、example.com 和 wikipedia.org，没有碰任何真实账号。脚本和输出在 `scratchpad/research/browser/`（下文简写为 `R/`）。查不到原文的内容标为「未核实」。

## 结论：v1 具体怎么做

**一句话**：Chrome 由我们自己起（有界面，跑在 Xvfb 里），编排器自己持有一条 CDP 连接，负责装登录态、导出登录态、推远程画面和检测验证码。每个 session 再起一个 Playwright MCP 进程，用 `--cdp-endpoint` 连上同一个 Chrome，交给 agent。带认证的 SOCKS5 走本地 gost 转发。人看远程画面用 CDP screencast 加输入转发，嵌进控制台。

### 组件清单

| # | 组件 | v1 做法 |
|---|---|---|
| 1 | Chrome 配置表 | 每条配置包括：一句说明（给 agent 选用）、代理（`socks5://user:pass@host:port` 或直连）、出口所在地、时区 / 语言 / 窗口尺寸、并发键（平台 × 账号）及其上限、登录探测 URL、是否保存 IndexedDB |
| 2 | 登录态保险箱 | 每个 Chrome 配置一行：`version`、加密的 storageState（AES-GCM，密钥放环境变量或 KMS）、`updated_by`、健康状态。只有编排器能解密 |
| 3 | 租约 / 排队 | 按并发键做信号量，租约带 TTL 和心跳。满了就排队，session 显示「等待浏览器」 |
| 4 | browser-runner（Node 服务，跑在 Docker 里） | 负责起和杀 Xvfb、Chrome、MCP，持有编排器 CDP 连接，提供 screencast 的 WebSocket，检测验证码，做合并回写。使用 playwright-core 1.64.x |
| 5 | 代理转发 | 每个带认证代理的 Chrome 配置常驻一个 gost，监听 `127.0.0.1:<port>`，上游是带认证的 SOCKS5。这个进程由 runner 托管，不是每个 session 起一个 |
| 6 | Playwright MCP | 固定版本 `@playwright/mcp@0.0.83`，以 stdio 方式运行，每个 session 一个进程，参数 `--cdp-endpoint <ws> --output-dir <sess>/mcp`。由 agent 运行时按工具白名单暴露，**必须屏蔽 `browser_run_code_unsafe`**，也不开 `--caps storage` |
| 7 | 控制台远程画面 | canvas 显示 screencast 帧，鼠标、滚轮、键盘事件转发过去。中文输入和粘贴的做法：页面里放一个隐藏 textarea，在 `compositionend` / `paste` 事件里取到文字，调用 `Input.insertText` 发过去 |
| 8 | 验证码检测 | 每次工具调用后，先用 URL / iframe 域名 / 关键词规则判断，规则拿不准时再让 qwen2.5-vl:7b 看截图。命中就截图、挂起 session、通知负责人 |

### 时序（agent session）

1. agent 读各 Chrome 配置的说明，选定一个，请求浏览器。runner 按并发键申请租约，拿不到就排队。
2. 读出保险箱的 vN 并解密，在内存里记作 `base`。
3. 如果代理需要认证，确认对应的 gost 在跑（没跑就拉起来）；直连的配置跳过这一步。
4. 起 `Xvfb :N`，再起 Chrome（有界面，`DISPLAY=:N`，环境变量 `TZ=<时区>`），参数：
   `--user-data-dir=/tmp/sess-x --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 --proxy-server=socks5://127.0.0.1:<gost> --host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE 127.0.0.1" --force-webrtc-ip-handling-policy=disable_non_proxied_udp --disable-blink-features=AutomationControlled --lang=<语言> --accept-lang=<语言> --window-size=1366,768 --no-first-run`。
   从 stderr 读出 `DevTools listening on ws://…`。
5. runner 执行 `connectOverCDP(ws)`，再对 `contexts()[0]` 调 `setStorageState(base)`，一次装进 cookie、localStorage 和 IndexedDB（实测，见 §5）。然后打开探测 URL，确认仍是登录状态。
6. 起 Playwright MCP（stdio，`--cdp-endpoint ws`），交给子 agent。agent 和 runner 用的是同一个默认 context，所以登录态是共享的（实测）。
7. 每次工具调用后做一次验证码检测。命中后：截图，session 状态改为「已挂起」，agent 循环暂停，通知负责人。负责人在控制台打开远程画面处理（runner 对 agent 当前页开 `Page.startScreencast`），处理完点「继续」，session 恢复。
8. 结束时执行 `storageState({indexedDB: 配置项})`，再做一次健康探测。探测通过才做三方合并（以 `base` 为基准，只写本 session 改过的项）并用版本号 CAS 写成 vN+1，冲突就重读重试。探测失败就不回写，把账号标成「需要人工」。
9. 关掉 MCP，关掉 Chrome（杀整个进程组），关掉 Xvfb，执行 `rm -rf /tmp/sess-x`，释放租约。

人工「打开浏览器」登录走同一条链路，只是不起 MCP。人点「保存登录状态」时，用整份导出替换保险箱内容并把版本号加一（同样走 CAS）。

上面第 4～9 步的端到端链路已经在本机跑通，用的是 headless=new 代替有界面模式（见 `R/t-v1.mjs` 和 `R/t-v1.out`）：agent 通过 MCP 看到 `OK sid=…`、`ls=zh`、`idb=idb-token`、`webdriver=false`、`tz=America/New_York`；screencast 能出帧；站点在 session 中轮换 cookie 后，合并写回 v3，同时保留了另一个 session 写入的 cookie；新 session 用 v3 登录正常；临时目录和进程都没有残留。

## 和旧报告不一致或需要修正的地方

| 旧报告 | 修正 / 补充 |
|---|---|
| 首选里并列了两种做法：`--cdp-endpoint` 和「更简单的 `--isolated --storage-state`」 | **v1 定为 CDP 方案。** `--isolated --storage-state` 不能控制代理转发和启动参数，还要给 agent 开 `--caps storage` 才能导出登录态（会暴露 cookie 工具） |
| 「`addCookies` 不含 localStorage，需要另外按 origin 注入」 | 用 `context.setStorageState()`，在 CDP 连接的默认 context 上一次装入 cookie、localStorage 和 IndexedDB，实测可用 |
| 人工接管按 ① noVNC ② CDP screencast 的顺序推荐 | **v1 改为 screencast 优先**：中文输入和粘贴可以直接用 `Input.insertText` 实现（实测），能复用控制台的鉴权，不需要额外端口。noVNC 只作为运维兜底，理由见 §4 |
| 「用正式版 Chrome 的新版 headless 也可以」 | 新版 headless 的 UA 里仍然有 `HeadlessChrome/153`；自己 spawn、不带 `--enable-automation` 时，`navigator.webdriver` **依然是 true**（实测）。所以必须有界面运行，并加 `--disable-blink-features=AutomationControlled` |
| 没提 SOCKS5 认证 | Playwright 遇到带认证的 SOCKS5 会直接报错 `Browser does not support socks5 proxy authentication`（实测），需要本地转发 |
| 没提快照体积 | 0.0.83 的动作类工具只返回快照文件的链接；全量 `browser_snapshot` 对一个长页面是 73 万字符（实测）。必须用 `depth`、`target` 或 `browser_find` |
| 没提危险工具 | 默认工具集（core）里有 `browser_run_code_unsafe`，官方描述是 "RCE-equivalent"，而且没有开关可以关掉（实测），只能在 agent 侧屏蔽 |
| Docker | 官方 MCP Docker 镜像「only supports headless chromium」，不能用于有界面的场景，需要自建镜像 |

## 1. Playwright MCP 复核

- **版本**：`@playwright/mcp` 0.0.83（2026-09-28 发布，npm `latest`），依赖 playwright 1.64.0-alpha。近几个版本：0.0.81 起 headless 浏览器空闲 1 小时后自动关闭，Linux 下默认关闭打包 Chromium 的 sandbox；0.0.83 给 `browser_find` 加了 `filename` 参数（来源：GitHub releases）。
- **参数现状**（`R/../browser-poc/pwmcp-help.txt` 和 README）：
  - `--cdp-endpoint` / `--cdp-header` / `--cdp-timeout` 都在。
  - `--isolated` 的含义是「profile 只放在内存里」。
  - `--storage-state` 只对 isolated 模式有效。
  - `--proxy-server` / `--proxy-bypass` 没有认证参数。
  - `--user-data-dir` 不传时，`--help` 说用临时目录，README 说用按工作区持久化的 profile，两者仍不一致。
  - `--extension` 用来连接人正在用的 Chrome，需要装扩展。服务器场景用不到。
  - `--caps`：`--help` 只列了 vision / pdf / devtools，但 README 还写了 storage / network / testing / config。vision 会多出 6 个坐标类工具（`browser_mouse_click_xy` 等），实测默认 25 个工具，加 vision 后 31 个。
  - 截图：`browser_take_screenshot` 返回图片，实测 jpeg 约 160KB。`--image-responses allow|omit|only` 控制是否回传图片。
- **怎么接**：用我们自己起的 Chrome 加 `--cdp-endpoint`，不让 MCP 自己启动浏览器。理由：
  - 代理转发、指纹参数、时区和语言都由我们控制；
  - 编排器自己持有 CDP 连接，装和导登录态、screencast、验证码截图都不需要把能力开给 agent；
  - MCP 崩了可以重连，Chrome 不受影响；
  - 清理也由我们负责。
- **一个进程能不能服务多个 session**：能，但 v1 不用。实测在 HTTP 模式下加 `--isolated`，一个 MCP 进程服务两个客户端时，只起**一个**浏览器，每个客户端各有一个隔离的 context：A 登录后 B 看到的是 `NOT-LOGGED-IN`（`R/t-mcp-http.out`）。但 `--cdp-endpoint` 是进程级参数，而每个 Chrome 有自己的代理和登录态，所以 v1 每个 session 起一个 stdio 进程。实测单个 MCP 进程 PSS 约 110MB（`R/t-mcpmem.out`），这个开销可以接受。
- **控制 token**（`R/t-mcp.out`，页面是维基百科长条目）：
  - 动作类工具（navigate、click 等）在 0.0.83 里**不再内联快照**，只返回约 285 字符，加一个 `.yml` 文件链接（源码里是 `snapshotToFile`）。只有显式调用 `browser_snapshot` 才内联返回。
  - 注意：agent 运行时如果读不到 MCP 的输出目录，这个链接就没用，agent 只能显式拿快照。
  - 全量快照 731,736 字符（约 18 万 token）；`depth=3` 是 901 字符，`depth=6` 是 1.2 万字符。
  - `browser_find("Jeff Bezos")` 返回 1.8 万字符（25 处命中，带祖先路径）。
  - `tools/list` 本身约 5 千 token。
  - 建议写进 agent 提示词：先用 `depth` 4～6 看结构，再用 `target`（ref）展开局部，用 `browser_find` 定位，不要拿全量快照。另外考虑加 `--snapshot-mode none`，以及截图时用 `--image-responses omit`（截图只给 runner 留证，不回传给模型）。
- **安全**：屏蔽 `browser_run_code_unsafe`（它可以直接调 `context.storageState()` 拿到包括 HttpOnly 在内的全部 cookie）。`browser_evaluate` 能读到非 HttpOnly 的 cookie 和 localStorage，按需保留并写审计日志。旧报告提到的 `--allowed-origins` 官方明确说 "*does not* serve as a security boundary"。

## 2. 其他选项简评

| 选项 | 现状（2026-10） | 结论 |
|---|---|---|
| Chrome DevTools MCP 1.11.0（Apache-2.0） | 有 `--browserUrl/--wsEndpoint`、`--isolated`、`--proxyServer`（没写认证）；`--slim` 只留 3 个工具；`pageIdRouting` 默认开启；默认上报使用统计和 CrUX，要加 `--no-usage-statistics --no-performance-crux`；仍然没有导入 storageState 的参数 | 可以作为备选 MCP（也能连我们的 CDP），v1 不换 |
| browser-use 0.13.11（MIT，Python） | 有 MCP 模式，但需要它自己的 LLM key；`ProxySettings` 有用户名和密码字段，但 Chromium 不支持 SOCKS5 认证，端到端能不能用**未核实** | 它更像 agent 框架，和我们自己的 planner 重叠 |
| Stagehand 4.2.1（MIT） | v4 直接走 CDP，不再依赖 Playwright；核心 API 是 `act/observe/extract`；MCP 是单独的包（`mcp-server-browserbase` 2.4.3） | 以后可以考虑做提取类子 agent 的底座，v1 不用 |
| Browserless | SSPL-1.0 或商业许可；实时画面 / hybrid automation、持久 session 都是付费功能 | 内部商用要付费，不选 |
| Steel（steel-browser，Apache-2.0） | Docker 可以自托管；README 里的 UI 只是调试 / 日志视图，没写可交互的远程画面；自托管能不能保存 profile **未核实** | 不选 |
| kernel-images（Apache-2.0） | Docker 里跑有界面的 Chromium，开放 CDP 9222；远程画面用 WebRTC（代码改自 Neko），支持读写和复制粘贴，也可以退回 noVNC；可以设为只读 | **v2 的头号备选**：如果 screencast 不够用，直接换成它 |
| Neko（Apache-2.0，约 2.2 万★） | WebRTC 远程桌面，有 Chromium 镜像，支持多人交接控制权；需要 UDP 端口段或 mux，不能走 HTTP 反向代理；中文输入法**未核实** | 同上，适合需要整桌面的场景 |
| Kasm / KasmVNC | KasmVNC 是 GPL-2.0；Chromium 内核的客户端剪贴板是无缝的；有用户报告 fcitx5 打的中文进不了 Chrome（kasmtech issue 233） | 不选 |

## 3. SOCKS5 认证、转发与 DNS

- **现状**：Playwright 不论在 launch 还是 context 上，只要给 SOCKS5 带用户名密码，都会报 `Browser does not support socks5 proxy authentication`（实测 `R/t-socks.out`）。Playwright 文档只说 `username/password` 用于 HTTP 代理。
- **转发**：实测本地无认证 SOCKS5 → 上游带认证 SOCKS5 这条链路可以通（用 Node 写的 30 行转发模拟 gost 的作用；上游日志显示 `auth ok` 和 `connect DOMAIN example.com`）。
  - 生产用 gost：`gost -L socks5://127.0.0.1:11080 -F socks5://heyagent:<密码>@10.0.8.21:1080`。`-L/-F` 链式转发来自官方文档；`-F` 里带 `user:pass` 的写法来自社区帖子；版本按 v3 固定（**上线前用 `gost -V` 和上游日志实测**）。
  - microsocks 只是 SOCKS5 服务端，README 里没有上游链式转发的说明，不适合做这件事。
  - 如果供应商同时提供带认证的 HTTP 代理，Chrome 可以直接用（Playwright 会帮忙应答认证），不需要转发。
- **怎么管**：转发进程按「Chrome 配置」常驻，同一配置的多个 session 共用，由 runner 托管（启动、健康检查、端口分配、配置改了就重启）。只监听 127.0.0.1，密码不出现在 Chrome 的命令行里。gost 挂了，该配置的新 session 就失败并告警，**不能自动退回直连**。
- **防 DNS 泄漏**：
  - Chrome 用 `socks5://` 时把域名交给代理端解析。实测代理收到的是 `ATYP=DOMAIN`，所以没有 `socks5h` 的问题。
  - Chromium 文档提醒 DNS 预取等组件可能绕过代理，建议加 `--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE <代理主机>"`。代理在本机，所以写成 `EXCLUDE 127.0.0.1`。
  - gost 自己会不会在本地解析域名**未核实**，要在上游日志里确认收到的是域名。
  - WebRTC 加 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`。这个参数在当前版本的 Chrome 里是否仍然有效**未核实**，上线前要用 WebRTC 泄漏检测页实测。
  - Chromium 的 SOCKS5 代理只代理 TCP。

## 4. 远程画面（人登录用）

| 做法 | 延迟 | 开发量 | 内网 Docker 部署 | 中文输入 / 粘贴 |
|---|---|---|---|---|
| **CDP screencast + 输入转发**（v1） | 画面帧经 runner 的 WebSocket 中转。本机 headless 实测约 54fps，每帧约 8KB；内网端到端延迟预计几十毫秒（**未实测**，ack 流控下受 RTT 影响） | 中：canvas 显示、坐标缩放、鼠标 / 滚轮 / 键盘映射、标签页跟随、JS 弹窗处理，约 1～2 人周（估算） | 不需要新端口和新组件，复用控制台的 WebSocket 和鉴权 | **好**：浏览器本地的输入法组好字以后发 `Input.insertText`（实测「亚马逊 买家 账号」可以上屏），粘贴同理。协议里 insertText 的说明本身就是「emoji 键盘或 IME」场景 |
| noVNC（Xvfb + x11vnc + websockify） | 一般在几十到上百毫秒（**未核实**） | 小：现成组件，iframe 嵌入即可 | 每个 session 多一个 x11vnc 和一个 websockify 端口，要在反向代理上加鉴权 | **差**：VNC 传的是 keysym，中文要在容器里装 fcitx，有 Chrome 收不到输入的报告；noVNC 剪贴板有非 ASCII 字符变成「?」的报告（x11vnc 也测过） |
| Kasm / Neko / kernel-images（WebRTC） | 低（WebRTC，官方称比 VNC 快得多；**无实测数字**） | 小到中：要接入它们的容器和鉴权 | 需要 UDP 端口段或 mux，可能还要 TURN；不能走 HTTP 反向代理；每个 session 是一整个桌面容器 | 粘贴：kernel-images 支持；中文输入法：**未核实** |

**v1 推荐 CDP screencast。** 原因：人在这个场景里主要是登录、粘贴密码和过验证码，粘贴和中文输入是刚需；画面能直接走控制台现有的鉴权；不需要新增端口。

screencast 的已知短板：
- 只有页面内容，看不到地址栏、原生文件选择框、HTTP Basic 认证框和打印框；
- 新标签页、弹窗要靠 `context.on("page")` 跟随切换；
- 拖动滑块类验证码要求把人的 mouseMoved 事件连续转发过去；
- `Page.startScreencast` 在协议里标为 experimental。

兜底方案：同一个容器里给运维留一个 x11vnc + noVNC 入口（Xvfb 本来就有），只在内网开放给管理员。如果真用起来，screencast 体验不够，v2 换 kernel-images。注意：有界面 Chrome 在 Xvfb 下能否正常 screencast，本机没有 Xvfb，**未实测**。

## 5. 登录态合并回写

- **存什么**：
  - cookie 和 localStorage 一定要存（storageState 默认就包含）。
  - IndexedDB 需要 `storageState({indexedDB: true})`（Playwright v1.51 加入，官方举的例子是 Firebase Auth 把 token 放在 IndexedDB），做成按 Chrome 配置开关，默认关闭，原因是体积可能很大。
  - sessionStorage Playwright 不提供持久化（官方原话），实测导出导入后丢失。v1 不存。
  - `opfs`（v1.63）和 passkey `credentials`（v1.61）v1 也不存。
- **哪些站点把登录态放在 cookie 以外**：
  - 用 Firebase Auth 的站点（IndexedDB）；
  - 不少 SPA 后台把 JWT 存在 localStorage（常见做法，**未针对具体站点核实**）；
  - 风控常把设备 ID 放在 localStorage 里，丢了就要求重新验证（**未核实**）。
  - 亚马逊、Temu、TikTok Shop、1688 的登录态具体放在哪里**未核实**。v1 先默认存 cookie + localStorage，探测失败时再给该配置打开 IndexedDB。
- **v1 最简做法**：
  - 第 5 步装入时用 `setStorageState(base)`。
  - 第 8 步导出后做三方合并：cookie 以 `name|domain|path` 为键，只写本 session 新增、修改或删除的项；localStorage 按 origin + key 用同样方式合并；IndexedDB 只要某个 origin 有变化，就整份覆盖该 origin。然后用 version 做 CAS。实测合并结果正确（`R/t-v1.out`）。
  - 健康探测失败就不回写。
  - 合并逻辑约 30 行，见 `R/t-v1.mjs` 里的 `merge()`。

## 6. 反自动化风险

- **headless 和 headed**：
  - 旧版 headless 已在 Chrome 132 从主程序里移除，单独成为 chrome-headless-shell；新版 headless 和有界面版是同一个程序。
  - 实测：headless-shell 的 UA 是 `HeadlessChrome/153.0.8010.12`、plugins 为 0；新版 headless 的 UA 仍然是 `HeadlessChrome/153`。
  - `navigator.webdriver` 在 Playwright launch 和我们自己 spawn（只开 `--remote-debugging-port`）两种情况下都是 true，加 `--disable-blink-features=AutomationControlled` 后变成 false（`R/t-state-fp.out`、`R/t-mem.out`）。
  - 已知的其他检测点：Playwright 和 Puppeteer 默认会调 `Runtime.enable`，页面能察觉到；还有注入的全局变量。rebrowser-patches、patchright 是针对这些的补丁，但它们自己也承认补不全。
- **平台风控强度**（定性，大多**未核实**）：
  - TikTok：被描述为社交媒体里反爬最先进的之一，有滑块和旋转验证码（Scrapfly）。
  - Temu：社区普遍认为难。
  - 1688 / 阿里系：有滑块验证（经验，**未核实**）。
  - 亚马逊：相对宽松，但有 Robot Check 验证码，账号风控严（**未核实**）。
- **为什么要「headed + 固定指纹 + 真实账号人工登录」**：
  - 人在**同一个服务器 Chrome**里登录，平台看到的登录设备和之后 agent 用的设备是同一台：同一个 IP、UA、时区、字体和窗口。这比任何「反检测」补丁都可靠。
  - 有界面运行可以去掉 `HeadlessChrome` 这类硬特征。
  - 固定指纹（不随机化）可以避免「每次都像新设备」而反复触发验证。
  - 实测时区用 `TZ` 环境变量、语言用 `--lang` + `--accept-lang` 就能生效（`R/t-locale.out`）；CDP 连接的默认 context 不能用 Playwright 的 `locale/timezoneId` 参数。
  - 建议镜像里装 Google Chrome 正式版，不用 Playwright 打包的 Chromium（两者编解码器等特征不同，**未核实**目标站点会不会检测这一点）。
- **验证码识别**：只检测，不自动破解。破解违反平台条款，而且公开评测里 VLM 对复杂验证码的成功率只有 2.5%（MCA-Bench，基于 Qwen2.5-VL-7B）。
  - 第一层是规则：frame URL 命中 `google.com/recaptcha/`、`hcaptcha.com`、`arkoselabs.com`、`geetest.com` 等，或者页面标题 / 正文命中「验证」「滑块」「Robot Check」「captcha」等关键词。
  - 第二层：规则拿不准或页面卡住时，把截图交给内网 qwen2.5-vl:7b 做是或否判断，输出 JSON。小 VLM 做「是不是验证码页」这种分类，目前没找到公开评测，需要自己攒几十张样本验证。误报的代价只是多叫一次人。
- **条款**：亚马逊等平台的条款普遍限制机器人和自动化访问。Amazon 诉 Perplexity Comet 案，2026-08-04 第九巡回法院撤销了初审禁令，但案件还没有结论。上线前需要业务方确认使用边界，这里不展开。

## 7. 资源估算与 Docker

- **实测**（Chromium 153，headless=new，1366×768，打开维基百科页面，`R/t-mem.out`）：
  - 单开时 PSS 为 545MB；5 个同时开，每个 276～380MB，合计 1.69GB（共享库被分摊了）。
  - 加载期间每个约占 0.2～0.5 个核，持续数秒；空闲时 0～4%。
  - 另外每个 session 的 MCP 进程约 110MB。
- **估算**：有界面模式还有 Xvfb 软件渲染、screencast 编码，电商页面又更重（大量 JS、图片、广告），所以按每个 session **1～1.5GB 内存、峰值约 1 vCPU** 规划（估算）。
  - 同时 5 个 session：**8 vCPU / 16GB**；同时 10 个：**16 vCPU / 32GB**。
  - 参考：Browserless 官方给 headless 的建议是 2 CPU / 4GB 跑 5～10 个，我们是有界面加真实电商页面，所以保守一些。
  - 每台机器都要设并发上限，超了就排队。
- **Docker 注意事项**：
  - 内存：用 `--shm-size=2g`（Browserless 推荐，并且建议不要用 `--disable-dev-shm-usage`）或 `--ipc=host`（Playwright 推荐，原话是不加的话 Chromium 可能 OOM 崩溃）。
  - 进程：加 `--init`，防止 PID 1 和僵尸进程问题；runner 按进程组杀 Chrome。
  - sandbox：会访问外部网站，最好保留 sandbox，用非 root 用户加 Playwright 的 `seccomp_profile.json`；`--no-sandbox` 只作为临时方案。
  - 字体：中文装 `fonts-noto-cjk`（Ubuntu noble 有这个包，安装后约 91MB），emoji 装 `fonts-noto-color-emoji`。
  - 时区和语言：每个 Chrome 用 `TZ` 环境变量加 `--lang/--accept-lang` 设置，不依赖容器的全局设置；容器里装 `tzdata`。
  - 镜像：自建，内容包括 Ubuntu noble、Google Chrome 正式版、Xvfb、gost、Node 和固定版本的 `@playwright/mcp@0.0.83`。不用官方 MCP 镜像，因为它只支持 headless。
  - Chrome 136 起，默认 profile 不允许开调试端口；我们总是传独立的 `--user-data-dir`，不受影响。CDP 只绑 127.0.0.1。

## 风险和待确认

1. **screencast 的人工体验**（最不确定）：有界面 Chrome 在 Xvfb 下的帧率和延迟、滑块验证码的拖动手感、弹窗和新标签页的处理都没有实测。如果不达标，换 kernel-images（WebRTC），开发量会转到容器编排上。
2. **gost 的细节**：`-F` 带认证的写法、是否把域名透传给上游、v3 的具体语法，都要拿真实代理（10.0.8.21:1080）实测。
3. **WebRTC 和 DNS 防泄漏参数**在 Chrome 153 上是否有效，要用检测页验证。
4. **各平台登录态位置和风控强度**：亚马逊、Temu、TikTok Shop、1688 的具体情况都未核实，要在人工登录后观察 storageState 内容，以及换一个 session 后是否仍保持登录。
5. **qwen2.5-vl:7b 判断验证码的准确率和耗时**未实测，需要准备样本集。
6. **同一账号多 session 并发**仍然有 cookie 轮换冲突，并发上限先保守设为 1（旧报告的结论不变）。
7. Playwright MCP 还是 0.0.x，每个版本都可能有行为变化（例如 0.0.83 改了快照返回方式）。版本要固定，升级前回归测试。
8. 平台条款风险由业务方确认。

## 参考链接（访问日期均为 2026-10-17）

- Playwright MCP：https://github.com/microsoft/playwright-mcp ；releases：https://github.com/microsoft/playwright-mcp/releases ；npm：`npm view @playwright/mcp`（0.0.83）
- Playwright 文档：认证 https://playwright.dev/docs/auth ；`storageState` / `setStorageState`：https://playwright.dev/docs/api/class-browsercontext ；Docker：https://playwright.dev/docs/docker ；代理：https://playwright.dev/docs/api/class-browsertype
- CDP：Page.pdl（screencast 为 experimental）https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Page.pdl ；Input 说明见 playwright-core 的 `types/protocol.d.ts`
- Chromium SOCKS 文档：https://www.chromium.org/developers/design-documents/network-stack/socks-proxy/ ；WebRTC 策略：https://chromium.googlesource.com/chromium/src.git/+/be2e0415f2fe42c419ce1660c9acd331f3a174ba
- gost：https://gost.run/en/getting-started/quick-start/ 、https://gost.run/en/tutorials/protocols/socks/ ；社区示例 https://lowendtalk.com/discussion/comment/3642045/ ；microsocks：https://github.com/rofl0r/microsocks
- Chrome DevTools MCP：https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/docs/configuration.md
- browser-use：https://pypi.org/pypi/browser-use/json ；Stagehand v4：https://docs.stagehand.dev/v4/first-steps/introduction
- Browserless：https://raw.githubusercontent.com/browserless/browserless/main/README.md ；sizing：https://docs.browserless.io/enterprise/docker/best-practices
- Steel：https://raw.githubusercontent.com/steel-dev/steel-browser/main/README.md ；kernel-images：https://raw.githubusercontent.com/onkernel/kernel-images/main/README.md ；Neko：https://github.com/m1k1o/neko 、https://neko.m1k1o.net/docs/v3/configuration/webrtc
- KasmVNC 剪贴板：https://kasm.com/kasmvnc/docs/latest/clientside.html ；Kasm 中文输入法 issue：https://github.com/kasmtech/workspaces-issues/issues/233 ；noVNC 非 ASCII 剪贴板：https://groups.google.com/g/novnc/c/WZBSoMpfv7s
- headless 变更：https://developer.chrome.com/blog/removing-headless-old-from-chrome ；Chrome 136 调试端口：https://developer.chrome.com/blog/remote-debugging-port
- 检测：https://blog.castle.io/how-to-detect-headless-chrome-bots-instrumented-with-playwright/ 、https://github.com/rebrowser/rebrowser-patches 、https://github.com/Kaliiiiiiiiii-Vinyzu/patchright
- TikTok 反爬：https://scrapfly.io/blog/posts/how-to-scrape-tiktok-python-json ；MCA-Bench：https://arxiv.org/html/2506.05982v6
- Amazon 诉 Perplexity：https://courthousenews.com/ninth-circuit-lifts-block-on-ai-powered-shopping-assistant/ 、https://www.engadget.com/2230471/
- 字体包：https://packages.ubuntu.com/noble/fonts-noto-cjk
