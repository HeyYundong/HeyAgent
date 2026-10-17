# M0 包 2：浏览器基础镜像 + 远程画面实测（2026-10-17）

> 复核 `browser-stack-2026-10.md`。那份调研是在开发机上用 headless 代替跑的；这次全部在 **rootless Podman 3.4.4 容器里，用有界面 Google Chrome 155 + Xvfb** 跑。
> 访问范围只有容器内的本地测试页、example.com、wikipedia.org，没有登录任何账号，没有碰电商网站。
> 脚本在 `spikes/browser/`，本报告引用的原始输出在 `spikes/browser/results/2026-10-17/`（下文简写 `R/`）。下文数字都是实测的，跑不了的项单独写明。
> 开发机是 28 核 / 32GB，同时还有包 1 的 agent 在构建、跑测试，CPU 数字会有波动。完整跑了 3 遍，波动大的项给出 3 遍的范围。

## 结论

| 项 | 结论 |
|---|---|
| 镜像 | 能构建，1.25GB。Chrome、Node、gost 都固定版本，并校验了 sha256 和上游签名 |
| sandbox | **在 rootless Podman 的默认 seccomp 下就能开**，`chrome://sandbox` 显示 "adequately sandboxed"。可以进一步加固到 `--cap-drop=all --cap-add=SYS_CHROOT` 加 `no-new-privileges`。不需要 `--no-sandbox`，也不需要 Playwright 的 seccomp 配置 |
| 指纹 | UA 里没有 `HeadlessChrome`，`navigator.webdriver=false`，时区和语言按参数生效，中文和 emoji 字形正常。新发现两个问题：`AutomationControlled` 参数会让启动时的标签页多出一条提示条；容器里没有 WebGL |
| 远程画面 | **能用**。帧率：动画页 60fps，滚动维基长页面 13fps。延迟：在容器里从输入到出新帧，p50 是 31～33ms；从试用页按键到看到新画面，p50 是 37ms。短板是带宽和 CPU：滚动文字页约 12Mbps，60fps 时 screencast 要多占约 1.6 核 |
| 输入转发 | 鼠标、滚轮、键盘、组合键、中文 `insertText`、输入法组字、粘贴、拖动滑块、新标签页跟随、alert / confirm / prompt **全部通过**（runner 侧 19/19，试用页端到端 11/11） |
| Playwright MCP | 用 `--cdp-endpoint` 连同一个 Chrome，能导航、能拿快照，和编排器共用登录态。默认 25 个工具里有 `browser_run_code_unsafe`。新发现：**编排器的 Playwright 连接如果没有挂 dialog 监听，会替 agent 把弹框自动关掉** |
| gost | v3.3.0 实测能通。上游收到的全是域名（ATYP=DOMAIN），本地 **0 次** DNS 查询（对照组直连时有 18 次）。密码错或 gost 挂掉时直接报错，**不会**退回直连 |
| 资源 | 有界面 Chrome 打开维基长页面：开 1 个时 PSS 586MB；开 3 个合计 1.25GB；开 5 个合计 1.91GB，每个 346～398MB。每个 Xvfb 约 13MB，每个 MCP 进程约 115MB |

## 1. 镜像 `deploy/browser-base.Containerfile`

构建命令：`podman build -f deploy/browser-base.Containerfile -t localhost/heyagent-browser-base:m0 deploy/`。镜像大小 **1.25GB**（`podman images`）。

| 内容 | 版本 | 来源和校验 | 层大小 |
|---|---|---|---|
| Ubuntu | 24.04（noble） | `docker.io/library/ubuntu:24.04` | 80.7MB |
| Google Chrome 正式版 | 155.0.8059.84-1 | 从 `dl.google.com/linux/chrome/deb/pool/...` 下载固定版本的 .deb。sha256 取自仓库的 `Packages` 文件；`Packages` 的 sha256 又写在 `InRelease` 里，用 Google Linux 签名钥（主钥 `EB4C 1BFD 4F04 2F6D DDCC EC91 7721 F63B D38B 4796`，签名子钥 `0E22…648F`）验过签名 | Chrome 加 apt 包这一层共 934MB，其中 `/opt/google` 443MB，字体 104MB |
| Xvfb、xauth、`fonts-noto-cjk`、`fonts-noto-color-emoji`、tzdata | noble 仓库 | apt | （含在上面这一层） |
| Node | 24.22.0（LTS Krypton） | nodejs.org 官方 tarball。sha256 取自 `SHASUMS256.txt.asc`，签名者是 Node 发布人 Richard Lau（`C82F A3AE 1CBE DC6B E46B 9360 C43C EC45 C17A B93C`），这把钥匙在 nodejs/node README 的发布人列表里，签名已验证 | 141MB |
| gost | v3.3.0（2026-08-30 正式版） | GitHub go-gost/gost release 的 `gost_3.3.0_linux_amd64.tar.gz`，sha256 和 release 里的 `checksums.txt`、GitHub 资产摘要三方一致 | 49.8MB |
| `@playwright/mcp` / `playwright-core` | 0.0.83 / 1.64.1 | npm，装在 `/opt/browser/node_modules`；`playwright-mcp` 链接到 `/usr/local/bin` | 48.2MB |
| 用户 | `browser`（uid 1000） | 删掉基础镜像自带的 `ubuntu` 用户后建的 | |

几点说明：
- Chrome 的 postinst 会写 apt 源，镜像里删掉了。这样 Chrome 版本只由 Containerfile 里的 ARG 决定，不会跟着 `apt upgrade` 变。
- **开发机构建踩到的坑**：Podman 3.4.4 配的 crun 0.17 不认 seccomp 配置里的 `defaultErrnoRet`，容器里遇到不认识的系统调用时返回 EPERM，而不是 ENOSYS。实测：`syscall(452)`（fchmodat2）在默认 seccomp 下返回 errno 1，加 `seccomp=unconfined` 后返回 38。24.04 的 tar 1.35 加 glibc 2.39 解包时会调 fchmodat2，拿到 EPERM 就不回退，于是解包失败。所以 Node 和 gost 改在一个 22.04 的 fetch 阶段里下载、校验、解包，再 `COPY` 进来。服务器上的 Podman 4.4+ 预计没有这个问题（**未验证**）。
- `@playwright/mcp` 0.0.83 精确依赖 `playwright` / `playwright-core` 的 `1.64.0-alpha-1790635538000`，所以镜像里 alpha 版和顶层的 1.64.1 两份并存。npm 的传递依赖没有用锁文件锁定，见遗留问题。

## 2. 每项实测

### 2.1 启动和 sandbox（`t-sandbox.mjs`，`R/sandbox-*.json`）

每种容器参数都是先起 Xvfb，再起有界面 Chrome（不加 `--no-sandbox`），打开 `chrome://sandbox`，再打开本地测试页确认能渲染。

| 容器参数 | 能否启动 | sandbox 状态 | 关掉 Chrome 后的僵尸进程 |
|---|---|---|---|
| **推荐**：`--init --shm-size=2g --security-opt no-new-privileges --cap-drop=all --cap-add=SYS_CHROOT` | 能 | Namespace + PID/网络命名空间 + Seccomp-BPF，"adequately sandboxed" | 0 |
| Podman 默认（只加 `--init --shm-size=2g`） | 能 | 同上 | 0 |
| `--userns=keep-id` | 能 | 同上 | 0 |
| 不给 `--shm-size`（默认 64MB） | 能 | 同上 | 0 |
| `--security-opt seccomp=unconfined` | 能 | 同上，说明不需要放宽 seccomp | 0 |
| `--cap-drop=all`（不留 SYS_CHROOT） | **不能**：zygote 起不来，报 `Check failed: sys_chroot("/proc/self/fdinfo/") == 0` | — | — |
| 不加 `--init`（PID 1 是 node） | 能 | 正常 | **5 个**（`chrome_crashpad` ×2，`chrome` ×3） |
| `--no-sandbox` | 能 | Layer 1 显示 None，"NOT adequately sandboxed" | 0 |

结论：
- Chrome 用的是 user namespace sandbox。Podman 默认的 seccomp（containers-common 0.44）无条件放行 `clone` 和 `unshare`（已核对 `/usr/share/containers/seccomp.json`），所以不像 Docker 那样需要 Playwright 的 `seccomp_profile.json`。
- 不需要 setuid 的 `chrome-sandbox`，所以 `no-new-privileges` 可以加。
- 唯一要保留的 capability 是 `SYS_CHROOT`。
- `--init` 是必须的；如果不用 `--init`，runner 自己当 PID 1 时就要负责回收僵尸进程。
- CDP 只监听在 `127.0.0.1:<随机端口>`（读 `/proc/net/tcp` 确认）。有界面模式下 `--remote-debugging-address=127.0.0.1` 照样生效。

### 2.2 指纹（`t-fingerprint.mjs`，`R/fingerprint.json`，截图 `R/fp-local-zh.png`、`R/fp-zhwiki.jpg`）

| 检查项 | zh-CN + Asia/Shanghai | en-US + America/New_York |
|---|---|---|
| UA | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36`，brands 为 `Google Chrome 155` / `Chromium 155`，**没有 Headless** | 同左 |
| `navigator.webdriver` | false | false |
| 时区 | `Asia/Shanghai`，`GMT+0800 (China Standard Time)` | `America/New_York`，`GMT-0400 (Eastern Daylight Time)` |
| 语言 | `navigator.languages = [zh-CN, zh]`，请求头 `Accept-Language: zh-CN,zh;q=0.9` | `[en-US, en]`，`en-US,en;q=0.9` |
| 其他 | plugins 5 个，`window.chrome` 存在，screen 1366×768，视口 1365×680，`Noto Sans CJK SC` 可用 | 同左 |
| 中文截图 | 本地测试页里的中、繁、日、韩文字和 emoji 都正常；zh.wikipedia「汉语」条目正常 | — |

新发现：
1. **`--disable-blink-features=AutomationControlled` 会触发「不受支持的命令行标记」提示条**，只出现在启动时打开的那个标签页上。这个标签页的视口是 1365×624，其他标签页是 1365×680。逐个去掉参数对比过，确认就是这个参数引起的。这个参数又不能去：去掉后，即使是有界面模式，`webdriver` 也会变回 true（实测）。处理办法：runner 连上 Chrome 后新开一个标签页，再关掉启动标签页（`lib/browser.mjs` 的 `dropStartupTab`）。
2. **没有 WebGL**：容器里没有 GPU，`getContext("webgl")` 返回 null。加 `--enable-unsafe-swiftshader` 后有 WebGL，但 renderer 显示为 `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) ...))`。这两种情况都带有明显的「服务器 / 虚拟机」特征，见遗留问题。
3. `hardwareConcurrency=28`、`deviceMemory=32` 直接反映宿主机配置。同一台机器上是固定的，换机器就会变。
4. **容器刚启动的约 2 秒内起 Chrome，外网请求会报 `ERR_NETWORK_CHANGED`**。原因是网卡的 IPv6 链路本地地址还在做重复地址检测（`/proc/net/if_inet6` 里的标志位从 `c0` 变成 `80`），检测结束时地址状态一变，Chrome 就认为网络变了，中断正在进行的请求。等地址稳定后再起 Chrome 就好了（`waitNetworkSettled`）。runner 常驻时只影响容器刚起来的那一下。

### 2.3 远程画面：帧率、单帧大小、CPU、延迟（`t-screencast.mjs`，`R/screencast.json`）

测试条件：视口 1365×680，JPEG，ack 收到就立即回（除非另外注明）。每项采样 10 秒。

CPU 的计法：单核 = 100%，Chrome 按整个进程组算，「容器」是 cgroup 的总数。node 指接收帧的一方，相当于 runner。

| 场景 | fps | 单帧 KB（平均 / p95） | 码率 | Chrome CPU | node CPU | 容器 CPU |
|---|---|---|---|---|---|---|
| 静态页，开 screencast | 0（内容不变就不出帧） | — | 0 | 7% | 0.1% | 7% |
| 动画页，不开 screencast（基线） | — | — | — | 25% | — | 26% |
| 动画页 q60 | **60** | 12.5 / 12.6 | 5.8Mbps | 184% | 17% | 203% |
| 动画页 q80 | 60 | 15.1 / 15.2 | 7.1Mbps | 187% | 13% | 201% |
| 动画页 q60，ack 延迟 50ms | 36～51（3 遍不一致） | 12.5 | 3.5～5.0Mbps | 167～181% | | |
| 动画页 q60，ack 延迟 100ms | 22.5 | 12.5 | 2.2Mbps | 133～144% | | |
| 动画页 q60，`everyNthFrame=2` | 30 | 12.5 | 2.9Mbps | 150% | 6% | 161% |
| 动画页 q60，`maxWidth/maxHeight=960/540`（实际图片 960×478） | 60 | 7.9 | 3.7Mbps | 144% | 11% | 156% |
| 维基长页面滚动，不开 screencast（基线） | — | — | — | 43% | — | 47% |
| 维基长页面滚动 q60（每 100ms 一次滚轮） | **13.2** | **115.5 / 129.5** | **11.9Mbps** | 111% | 11% | 127% |
| 同上 q40 | 13.5 | 90.6 / 104.6 | 9.6Mbps | 101% | 10% | 114% |
| 同上 q60，缩到 960×478 | 13.8 | 61.6 / 71.8 | 6.6Mbps | 91% | 7% | 99% |

**延迟**：
- 从 CDP 发出输入，到收到反映这次变化的第一帧（容器内、本机，不含网络）：按键 p50 31～33ms、p95 32～35ms；鼠标 p50 31～33ms、p95 32～38ms（3 遍，每遍各 30 次）。
- 试用页端到端：浏览器 → WebSocket → viewer → CDP → 出帧 → WebSocket → 浏览器 canvas。容器内回环下 p50 37.1ms、p95 37.6ms、最大 43ms（30 次）。
- 真实内网 RTT 下的延迟**没测**。开发机没有第二台机器，只能用 ack 延迟模拟：如果 ack 等观看端确认后才回，RTT 50ms 时帧率掉到 36～51fps，RTT 100ms 时掉到 22fps。所以 runner 应该收到帧就立刻 ack，慢的观看端靠丢帧应对。试用页就是这么做的：WebSocket 缓冲超过 1MB 就丢帧。

结论：screencast 的帧率和延迟足够人工登录、过滑块用。代价有两个：
- 文字多的页面单帧 100KB 以上，滚动时每个观看者约 12Mbps；
- 60fps 时 Chrome 要多花约 1.6 核做合成和 JPEG 编码。

人工接管不常发生，时间也短，可以接受。如果要做成「同时看很多个」的监看墙，需要缩图并降帧（缩到 960 宽可以省约 45% 的流量）。

### 2.4 输入转发（`t-input.mjs`，`R/input.json`，19/19 通过）

全部用远程画面会用到的原始 CDP 命令（`Input.dispatchMouseEvent`、`dispatchKeyEvent`、`insertText`），再读页面状态核对：

| 项 | 结果 |
|---|---|
| 点击输入框后键入 `abc` | 通过 |
| Ctrl+A 后 Backspace 清空 | 通过 |
| `Input.insertText` 输入「亚马逊 买家 账号 😀 第二行」，并触发 input 事件 | 通过 |
| `mouseMoved` 触发 `:hover` | 通过 |
| 连点按钮 3 次 | 通过 |
| `mouseWheel` 滚动 | 通过（scrollY=800） |
| Tab 移动焦点、Enter 触发按钮 | 通过 |
| 自写的拖动滑块（mousedown → 30 次 mousemove → mouseup） | 通过，页面收到 30 次 mousemove |
| 原生 range 滑块 | 通过（value=100） |
| `target=_blank` 链接、`window.open` 打开新标签页时 `context.on("page")` 触发；切过去后 screencast 有帧 | 通过 |
| alert / confirm / prompt 经 `page.on("dialog")` 拿到消息和默认值，分别接受、取消、填写 | 通过 |

注意两点：
- **弹框打开期间，renderer 是阻塞的**，`mouseReleased` 这类 CDP 调用要等弹框关掉才会返回。转发输入时不要 `await`，否则 runner 会卡住。
- **标签页可见性**（`t-visibility.mjs`，`R/visibility.json`）：编排器用 Playwright `connectOverCDP` 连接时，默认会对每个页面开 `Emulation.setFocusEmulationEnabled`。结果是后台标签页也认为自己 `visible`、有焦点，照常渲染（后台页 1.5 秒出 71 帧）。加 `{ noDefaults: true }` 后（Playwright MCP 的 `--cdp-endpoint` 模式就是这么连的，已在源码里确认），后台页是 `hidden`，1.5 秒只出 1 帧，`bringToFront` 之后恢复到 75 帧。**runner 应该用 `noDefaults: true`，切换远程画面时先 `bringToFront`**，这样页面的可见性和真人使用时一致。

### 2.5 手动试用页（端口 5190）

- 文件：`spikes/browser/viewer/server.mjs` 和 `viewer/index.html`。
- 一键起停：`spikes/browser/run-viewer.sh start | stop | status | logs`。
- 功能：
  - canvas 显示画面；
  - 鼠标（不节流，拖滑块要连续的 move 事件）、滚轮、键盘转发；
  - 隐藏的 textarea 跟着点击位置移动，输入法的候选框就出现在点的地方；`compositionend` 和 paste 时调用 `Input.insertText`；
  - 新标签页自动跟随，有标签栏，可以切换和关闭；
  - JS 弹框显示成页面里的对话框；
  - 后退、前进、刷新；地址栏只允许本地测试页、example.com、wikipedia.org。
- 端到端自测 `t-viewer-e2e.mjs`（在 viewer 容器里再起一个 Chrome 扮演用户，`R/viewer-e2e.json`），**11/11 通过**：
  - canvas 点击加键入；Backspace 和 Ctrl+A；
  - 输入法组字：用 `Input.imeSetComposition` 模拟拼音组字过程，上屏「中文输入」；
  - 粘贴；滚轮；
  - 人手式拖动滑块（40 步，带抖动）；
  - alert / confirm / prompt 三种弹框；
  - 新标签页自动跟随；
  - 按键到画面的延迟（数字见 2.3）。
- 另外从**另一个容器**通过宿主机内网 IP `192.168.31.100:5190` 打开过试用页，画面正常，说明端口发布没问题。
- 测完已经 `stop`，5190 端口已关闭。演示时执行 `spikes/browser/run-viewer.sh start`。
- 这是实测页面，不是产品界面，没有用 shadcn 组件，也没有鉴权。正式版在 `apps/web` 里按 UI 规则重做。

### 2.6 Playwright MCP 0.0.83（`t-mcp.mjs`，`R/mcp.json`）

| 项 | 结果 |
|---|---|
| 连接方式 | `playwright-mcp --cdp-endpoint <ws> --output-dir …`，stdio。服务端版本显示为 `Playwright 1.64.0-alpha-1790635538000` |
| 工具 | 默认 25 个，`tools/list` 本身约 2 万字符。**`browser_run_code_unsafe` 在里面**，描述原文是 "Run a Playwright code snippet. Unsafe: executes arbitrary JavaScript in the Playwright server process and is RCE-equivalent."。**agent 侧必须屏蔽** |
| 导航 | `browser_navigate` 返回 382 字符，快照只给 `.yml` 文件链接 |
| 快照 | `browser_snapshot` 的参数有 `target / filename / depth / boxes`。测试页用 `depth=6` 时 1,208 字符 |
| 点击 | **`browser_click` 的参数是 `element / target / doubleClick / button / modifiers`，用 `target` 传 ref，不是 `ref`**（传 `ref` 会报 "expected string, received undefined → at target"） |
| 共用 context | MCP 点击「点我计数」后，编排器在自己的连接里能看到计数变成 1 |
| example.com | 正常；在 MCP 里执行 `browser_evaluate` 看到 `webdriver=false`，UA 里没有 Headless |
| 内存 | MCP 进程 PSS 115～120MB |
| MCP 退出后 | Chrome 还活着，编排器还能开新页面 |
| **弹框归属** | 编排器的 Playwright 连接**没挂** dialog 监听时，Playwright 会自动关掉弹框：MCP 回报 "Modal state: alert … can be handled by browser_handle_dialog"，但页面上弹框其实已经被关掉了。编排器挂一个什么都不做的监听后，弹框保留住，MCP 的 `browser_handle_dialog` 能正常接受 |

结论：runner 要在每个页面上挂 `page.on("dialog")`，并且自己不处理，弹框留给 agent（通过 MCP）或人（通过远程画面）。具体归谁，按 session 当前是 agent 在跑还是人在接管来决定。

### 2.7 gost 转发（`t-gost.mjs`，`R/gost.json`）

链路：Chrome → `socks5://127.0.0.1:11080`（gost，无认证）→ 本地测试用的带认证 SOCKS5 上游。上游密码故意设成 `p@ss:w0rd/测试`。

查 DNS 泄漏的做法：容器加 `--dns=127.0.0.1`，127.0.0.1:53 上跑一个 DNS 记录器，所有走系统解析的查询都会被记下来。上游测试服务器自己解析域名时直接问真实 DNS，不经过记录器。

| 场景 | 导航结果 | 上游看到的 | 本地 DNS 查询 |
|---|---|---|---|
| 对照：直连不走代理 | 200 | — | **18 条**（example.com、Google 各服务的 A / HTTPS 记录），说明记录器有效 |
| 命令行 `-L socks5://127.0.0.1:11080 -F socks5://heyagent:<URL 编码的密码>@127.0.0.1:<port>` | example.com（http、https）、en.wikipedia.org 都是 200 | 认证 ok；ATYP 全部是 DOMAIN；19 个主机 | **0** |
| 配置文件 `-C`（推荐，YAML 文件权限 0600） | 同上 | 认证 ok；全部 DOMAIN；20 个主机 | **0** |
| 同上，但不加 `--host-resolver-rules` | 同上 | 全部 DOMAIN | **0** |
| 同上，加 `--disable-background-networking --disable-component-update` | 同上 | 15 个主机 | 0 |
| 上游密码错 | `ERR_SOCKS_CONNECTION_FAILED`，gost 日志有 `auth failure` | 认证失败 | 0（没有退回直连） |
| gost 没起 | `ERR_PROXY_CONNECTION_FAILED` | — | 0（没有退回直连） |

另外两点：
- **Chrome 自己的后台流量也走代理**：一个新 profile 在几秒钟里会连约 13 个 Google 地址，包括 `clients2.google.com`、`update.googleapis.com`、`accounts.google.com`、`optimizationguide-pa.googleapis.com`、`content-autofill.googleapis.com`、`mtalk.google.com:5228`、`edgedl.me.gvt1.com` 等。这些流量都走代理，没有泄漏，但会消耗住宅代理的流量。加上面两个参数后只少了 5 个。
- WebRTC：没有 STUN 服务器时，带不带 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` 都只有 mDNS 的 `.local` host 候选，**这次区分不出这个参数的效果**（要 STUN，见遗留问题）。

### 2.8 资源（`t-resources.mjs`，`R/resources*.json`）

测试条件：同时开 N 个有界面 Chrome，每个带一个 Xvfb，同时打开维基长页面（英文和中文的「中国历史」「第二次世界大战」「United States」）。页面加载完再等 5 秒后读内存。PSS 是每个 Chrome 整个进程组的合计，每组 12～13 个进程，全部能读到。

| N | 每个 Chrome 的 PSS | Chrome 合计 | 每个 Xvfb | 容器 cgroup 内存增量 | 加载时 10 秒内 CPU | 空闲 10 秒 CPU |
|---|---|---|---|---|---|---|
| 1 | 586MB（3 遍为 586～590） | 586MB | 15MB | 337MB | 每个 25～46%；容器 33～56% | 每个 4～10% |
| 3 | 387～442MB | 1.25GB | 13MB | 1.05GB | 每个 27～53%；容器 105～160% | 每个 4～11%；容器 15～31% |
| 5 | 346～398MB | **1.91GB**（3 遍为 1.91～1.94） | 12MB | 1.79～1.84GB | 每个 23～53%；容器 182～259% | 每个 3～18%；容器 30～64% |
| 5（`/dev/shm` 只有 64MB） | 355～409MB | 1.93GB | 12MB | 1.82GB | 容器 190% | 容器 46% |

- **`/dev/shm` 用量一直是 0**：Chrome 155 的共享内存走 memfd（cgroup 里的 shmem 在 5 个 Chrome 时是 112～120MB），64MB 的 `/dev/shm` 也能正常开 5 个。`--shm-size=2g` 只是保险。tmpfs 按实际用量占内存，设大了不浪费。
- 和原调研的 headless 数字比：单开时 545MB 对 586MB，开 5 个时合计 1.69GB 对 1.91GB。有界面模式大约多 10%，另外每个 session 还要加 Xvfb 13MB 和 MCP 115MB。
- 按维基页面算，每个 session 约 0.5～0.7GB。电商页面会更重，所以原方案「每个 session 按 1～1.5GB、峰值 1 核」规划仍然偏保守、可用。**没有测电商页面**（按要求不碰）。

## 3. 推荐参数

### Chrome 启动参数（以 `spikes/browser/lib/browser.mjs` 的 `chromeArgs` 为准）

```text
环境变量：DISPLAY=:<Xvfb 显示号>  TZ=<时区，例如 Asia/Shanghai>
/opt/google/chrome/chrome
  --user-data-dir=<每个 session 一个临时目录>
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=0     # 从 stderr 读 "DevTools listening on ws://…"
  --disable-blink-features=AutomationControlled                      # 去掉就 webdriver=true；副作用是启动标签页有提示条，见 2.2
  --lang=<zh-CN> --accept-lang=<zh-CN,zh>
  --window-size=1366,768 --window-position=0,0
  --no-first-run --no-default-browser-check --password-store=basic --disable-features=Translate
  # 有代理时：
  --proxy-server=socks5://127.0.0.1:<gost 端口>
  --host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"         # 实测不加也没有本地 DNS 查询，作为兜底保留
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp          # 效果还没验证，见遗留问题
```

不要加：`--no-sandbox`、`--headless`、`--enable-automation`、`--disable-dev-shm-usage`。

Xvfb：`Xvfb -displayfd 3 -screen 0 1366x768x24 -nolisten tcp -noreset`。用 `-displayfd` 让 Xvfb 自己挑空闲的显示号，runner 并发起多个时不用自己分配。

gost：用 `gost -C <0600 的 YAML>`，写法见 `t-gost.mjs` 的 `yaml()`。不用命令行 `-F user:pass@`，因为密码会出现在 `/proc/<pid>/cmdline` 里。如果非要用命令行，密码必须 URL 编码（实测带 `@ : /` 和中文的密码编码后能用）。

### runner 编码要点（实测得出）

1. 用 `chromium.connectOverCDP(ws, { noDefaults: true })` 连接，不让 Playwright 对已有页面开 focus emulation。
2. 连上后先新开一个标签页、关掉启动标签页（`dropStartupTab`）。
3. 每个页面都挂 `page.on("dialog")`，并且自己不处理，否则 Playwright 会自动关掉弹框。弹框交给 agent 或人处理。
4. 远程画面切换标签页时，先 `bringToFront`，再对新页面 `Page.startScreencast`。新标签页用 `context.on("page")` 跟随。
5. screencast 收到帧就立即 ack，慢的观看端靠丢帧应对。转发输入时不 `await`，因为弹框期间这些调用会被阻塞。
6. Chrome 和 Xvfb 都用 `detached` 起，关闭时 `kill(-pgid)` 杀整个进程组，再删临时目录。实测没有残留进程。
7. 容器刚启动时，先等 `/proc/net/if_inet6` 里没有 tentative 标志的地址再起 Chrome；或者遇到 `ERR_NETWORK_CHANGED` 时重试一次。

### `podman run` 参数

```bash
podman run --init --shm-size=2g \
  --security-opt no-new-privileges --cap-drop=all --cap-add=SYS_CHROOT \
  localhost/heyagent-browser-base:m0 ...
```

- 不需要：`--security-opt seccomp=…`（默认就够）、`--ipc=host`、`--privileged`、`--no-sandbox`。
- CDP 不对外发布端口；只发布 runner 自己的 API 和 screencast WebSocket 端口。
- 实测脚本 `run-spikes.sh` 的全部项目和 `run-viewer.sh`，用的都是这一组参数。

## 4. 和原调研（`browser-stack-2026-10.md`）不一致或需要补充的地方

| 原调研 | 这次实测 |
|---|---|
| Docker 注意事项：sandbox 用「非 root 用户 + Playwright 的 `seccomp_profile.json`」 | rootless Podman 的默认 seccomp 就能开完整的 sandbox，不需要额外的 seccomp 配置；还能加固到 `--cap-drop=all --cap-add=SYS_CHROOT` 加 `no-new-privileges`。只有 SYS_CHROOT 不能去掉 |
| 内存：`--shm-size=2g`，否则 Chromium 可能 OOM | Chrome 155 用 memfd，`/dev/shm` 用量为 0，64MB 也能开 5 个。`--shm-size` 改为保险项，不是必需项 |
| screencast：本机 headless 约 54fps，每帧约 8KB | 有界面时动画页 60fps、每帧 12.5KB；**真实文字页滚动只有 13fps、每帧 115KB、约 12Mbps**。原来的 8KB 是简单页面上的数字，严重低估了带宽 |
| 延迟「预计几十毫秒（未实测）」 | 本机（不含网络）31～37ms 已实测；真实网络 RTT 仍未测 |
| 有界面 Chrome 在 Xvfb 下能否 screencast「未实测」 | 能，帧率和延迟数字见 2.3 |
| 时序第 5 步：`connectOverCDP(ws)` | 要加 `{ noDefaults: true }`。否则所有标签页都认为自己可见、有焦点，后台页照样渲染 |
| 新标签页靠 `context.on("page")` 跟随 | 对的；另外还要 `bringToFront`，见上一行 |
| 没提弹框归属 | 编排器的 Playwright 连接会自动关掉弹框，MCP 的 `browser_handle_dialog` 随之失效。必须挂监听 |
| 必须加 `--disable-blink-features=AutomationControlled` | 对，有界面模式下不加也是 webdriver=true。但它会让启动标签页多一条提示条，需要换掉启动标签页 |
| 资源：headless 单开 545MB，5 个合计 1.69GB | 有界面单开 586MB，5 个合计 1.91GB；每个 Xvfb 另加 12～15MB |
| gost：`-F` 带 `user:pass` 的写法来自社区帖子，未核实；gost 是否在本地解析域名未核实 | v3.3.0 已实测：`-F` 写法可用，特殊字符要 URL 编码；推荐改用配置文件。上游收到的全是域名，本地 0 次 DNS 查询 |
| 防 DNS 泄漏要加 `--host-resolver-rules` | 实测不加也没有本地 DNS 查询（DNS 记录器加直连对照组验证）。保留它作为兜底 |
| 没提 Chrome 自己的后台流量 | 新 profile 会经代理连约 13 个 Google 地址，消耗代理流量，关后台联网参数只能减掉一部分 |
| Playwright MCP 的动作类工具用 ref | 0.0.83 的 `browser_click` 参数名是 `target`，给 agent 的提示词和网关校验要按这个写 |
| 镜像「Ubuntu noble + Chrome + Xvfb + gost + Node + MCP」 | 内容一致，1.25GB。另外：开发机 Podman 3.4.4 下 24.04 的 tar 会因为 seccomp 返回 EPERM 而解包失败，加了一个 22.04 的 fetch 阶段绕开；MCP 自带一份 playwright 1.64.0-alpha |
| 没提 | 容器刚起 2 秒内起 Chrome 会遇到 `ERR_NETWORK_CHANGED`；没有 GPU 时没有 WebGL |

## 5. 遗留问题

1. **真人试用还没做**：真实输入法（搜狗、macOS 拼音等）、真实内网 RTT 下的手感和延迟，要用户用 `run-viewer.sh start` 后在自己电脑上试。自动化测试用的是 CDP 模拟的组字过程。
2. **WebRTC 防泄漏参数的效果没验证**：要有 STUN 服务器才能看到 srflx 候选。外部 STUN 超出这次允许访问的范围，本地也没有 STUN 实现。建议 M2 在镜像外起一个内网 STUN（例如 coturn）再测。
3. **真实代理（10.0.8.21:1080）没测**：上游用的是本地测试服务器。gost 在真实供应商代理下的表现，包括 UDP、超时和断线重连，上线前要测。
4. **WebGL 和硬件指纹**：没有 WebGL，或者显示为 SwiftShader，都是服务器特征；`hardwareConcurrency` 和 `deviceMemory` 暴露的是宿主机配置。要不要处理（GPU 直通、固定的 CPU 配额、或者接受现状），需要结合目标平台的风控观察来定。
5. **screencast 的 CPU 和带宽**：60fps 时每个观看中的 session 约多占 1.6 核，文字页滚动约 12Mbps。如果以后要做多路同时监看，要用 `maxWidth`、`everyNthFrame` 或者只在交互时开 screencast。
6. **Chrome 后台流量**：经代理连 Google 服务会消耗住宅代理的流量。要不要加 `--disable-background-networking` 一类的参数（它们只能去掉一部分），需要权衡「像普通浏览器」和「省流量」。
7. **npm 传递依赖没有锁文件锁定**：镜像里是 `npm install` 精确版本的顶层包。M2 做 runner 镜像时改成用 pnpm lockfile 安装。
8. **没在 Podman 4.4+ 上验证**：服务器版本上 crun 的 EPERM 问题预计没有了，sandbox 参数预计照样可用，部署阶段要复测。
9. **镜像体积**：1.25GB，可以再瘦一点（主镜像里的 curl、xz-utils 已经用不到；`chrome-sandbox` 的 setuid 位在 `no-new-privileges` 下没用，可以去掉），但收益不大。
10. **这次没覆盖的场景**：noVNC 兜底入口（镜像里没装 x11vnc）、文件上传选择框、HTTP Basic 认证框、下载。screencast 本来就看不到这些，M2 要另外设计处理方式。
11. Chrome 的 stderr 里有大量 dbus 连接失败的报错，不影响功能。runner 收日志时可以过滤掉。

## 6. 复现

```bash
# 构建镜像（约 12 分钟，大部分时间在下载 apt 包）
podman build -f deploy/browser-base.Containerfile -t localhost/heyagent-browser-base:m0 deploy/
cd spikes/browser
npm install                       # 只装 @modelcontextprotocol/sdk 和 ws；playwright-core 用镜像里的
./run-spikes.sh                   # 全部项目，约 12 分钟，输出在 out/<时间>/
./run-spikes.sh gost mcp          # 只跑指定的项目：sandbox fingerprint visibility input screencast mcp gost resources
./run-viewer.sh start             # 试用页 http://<本机 IP>:5190/，用完 ./run-viewer.sh stop
podman exec heyagent-browser-viewer node /opt/browser/spike/t-viewer-e2e.mjs   # 试用页端到端自测（要先 start）
```

本报告引用的原始输出放在 `spikes/browser/results/2026-10-17/`。`out/` 已经写进 `.gitignore`。
