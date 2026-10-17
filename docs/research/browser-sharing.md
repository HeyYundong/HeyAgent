# 浏览器按需启动 + 共享登录态 调研

> 调研日期 2026-10-16。版本号取自 npm / PyPI / GitHub 当天的数据。标「未核实」的内容没有在官方原文里找到，使用前要再确认。

## 一句话结论

**能做到，而且不需要买新产品。** 推荐自建：一个加密的「登录态保险箱」+ 每个任务临时起一个干净的 Chrome，由 Playwright MCP 交给 agent 控制。开始时把登录态装进去，结束时只把有变化的 cookie 合并回保险箱，然后关掉浏览器、删掉临时目录。本机已经跑通完整链路（见 §7）。

## 给老板的要点

- **账号只登录一次**：人在「远程画面」里登录（或处理验证码），系统把登录态存进保险箱。之后每个任务各开一个临时浏览器，自动带上登录态，用完就销毁，不会越开越多。
- **多个任务可以同时用同一个账号**，但有上限。平台会周期性「换钥匙」（轮换 cookie），一个任务换了钥匙，其他任务手里的旧钥匙可能当场失效（本机已复现）。所以要按账号限制并发数，并且回写时做合并，不能简单覆盖。
- **最大的风险是封号，不是技术问题**：同一账号的 IP、浏览器指纹要跟人登录时保持一致；尽量用有界面的真 Chrome；平台条款普遍禁止机器人抓取（Amazon 2026 年还屏蔽过别家的购物 agent）。上线前需要业务和法务确认使用边界。
- **成本**：自建只花服务器钱，开源组件许可证都是 Apache-2.0 或 MIT。云浏览器大约 0.06～0.12 美元/小时，但默认是海外 IP，1688 等国内平台不合适，而且 cookie 会存到境外。

## 1. 推荐方案

| | 方案 | 适用场景 | 理由 |
|---|---|---|---|
| **首选** | 自建「保险箱 + 每 session 一个临时 Chrome」：Playwright MCP 通过 `--cdp-endpoint` 连到编排器起的 Chrome；或者更简单的 `--isolated --storage-state` | 默认 | 完全符合「用时启动、用完关闭、共用一份 cookie」；微软维护，约 3.8 万星，Apache-2.0；cookie 不交给 agent；可以自托管在国内机房，用固定出口 IP |
| 备选 A | **每个账号一个常驻 Chrome，每个 session 开自己的标签页或窗口**（同一个默认 context，cookie 天然共享） | 同一账号并发高，或平台轮换 cookie 很频繁 | 对平台来说只有「一台设备」，cookie 永远是最新的，不需要回写合并。代价是一个浏览器崩溃会影响所有 session，并且要自己管理标签页归属（chrome-devtools-mcp 的 `pageIdRouting`、chrome-use 的标签组都是这个思路） |
| 备选 B | 云浏览器的 profile：**Browserbase Contexts** 或 **Kernel Profiles** | 没有运维人力，需要海外 IP，或者想要现成的 Live View | 自带加密存储和可交互的实时画面。但两家都明确说不要多个 session 同时写同一个 profile，写回是整份覆盖、不合并 |

## 2. 方案对比

| 方案（版本 / 许可证） | 按需启动、用完关闭 | 共享 cookie 的方式 | 同账号多 session 并发 | MCP | 人工接管 / 远程查看 | 部署 | 成本 | 成熟度 |
|---|---|---|---|---|---|---|---|---|
| **Playwright MCP** 0.0.83，Apache-2.0 | ✅ 每个 MCP 进程一个浏览器；`--isolated` 只在内存里；`--idle-timeout` 会自动关闭空闲浏览器 | `--storage-state` 导入；`--caps storage` 提供 `browser_storage_state` 导出（实测）；`--cdp-endpoint` 连到外部浏览器 | ✅ 每个 session 一个进程加 `--isolated`；也有 `--shared-browser-context` | 原生 | 没有内置；可以开有界面的浏览器，配 Xvfb + noVNC；`--extension` 可连接人正在用的 Chrome | 自托管 | 免费 | 高，约 3.8 万★ |
| **chrome-devtools-mcp** 1.11.0，Apache-2.0 | ✅ `--isolated` 使用临时目录，关闭后自动清理 | ❌ 没有导入 storageState 的参数，要靠编排器预先注入后用 `--browserUrl` / `--wsEndpoint` 连接；`new_page` 支持 `isolatedContext` | ✅ `--pageIdRouting` 默认开启，按 pageId 路由，适合多个 session 共用一个浏览器 | 原生 | 同上 | 自托管 | 免费；**默认会上报使用统计，并把 URL 发给 CrUX**，需要加 `--no-usage-statistics --no-performance-crux` | 高，Google 出品，约 5.4 万★ |
| **browser-use** 0.13.11，MIT | ✅ | `storage_state` 文件：启动时加载，定期和关闭时保存，**保存时与已有内容合并**；也支持 `user_data_dir`、`cdp_url` | ⚠️ 多个进程同时写同一个文件，没有锁（官方文档没提） | `uvx --from 'browser-use[cli]' browser-use --mcp`；它自带的 agent 工具需要单独的 LLM key；文档没写 MCP 模式怎么配置 storage_state（**未核实**） | 云版有 live preview | 自托管 / 云 | 免费；云版另计 | 高，约 11.8 万★，但它是 Python 库，比 MCP 更适合自己写编排 |
| **chrome-use**（leeguooooo/chrome-use）v1.5.232，Apache-2.0 | ⚠️ 主要模式是接管人自己正在用的真 Chrome；`--launch` 独立模式会另起浏览器 | 直接用真 Chrome 的登录态 | ✅ 每个 `--session` 一个标签组，在同一个 Chrome 里 | `chrome-use mcp` | 人就坐在这个浏览器前面 | 桌面端（扩展 + native messaging） | 免费 | 低：个人项目，2026-01 创建，约 200★ |
| **Claude in Chrome**（Anthropic 扩展） | ❌ 用的是人自己的 Chrome | 用户自己的登录态 | 单用户 | 只能给 Claude 用 | 遇到登录或验证码时暂停，交给人处理 | 桌面端 | Claude 订阅 | 正式产品，但不适合在服务器上跑多个 session |
| **Browserbase** Contexts | ✅ | `browserSettings.context = {id, persist}`，session 关闭时保存，加密存储 | ⚠️ 官方原话："Avoid having multiple sessions using the same Context at once" | 官方 MCP 支持 `--contextId` 和 `--persist` | ✅ Live View（`debuggerFullscreenUrl`），可以点击、输入，也可以设为只读 | 云 | $20/月含 100 小时，并发 25，超出 $0.12/小时 | 高 |
| **Steel** Profiles | ✅ | `persistProfile` / `profileId`；单个 profile 上限 300MB，30 天不用会被删除 | 文档没说明 | 社区 MCP，58★ | ✅ `debugUrl`，`interactive=true/false`；**URL 不需要鉴权** | 云；steel-browser 开源可以自托管（自托管是否支持 profile **未核实**） | $0.10/小时 | 中 |
| **Kernel** Profiles | ✅ | `save_changes: true`；按组织密钥端到端加密 | ⚠️ "Only one browser can safely write"，保存时整份替换、不合并 | 有 | ✅ `browser_live_view_url`，加 `readOnly=true` 可只读 | 云；kernel-images 开源 | 按 GB·秒计费，约 $0.06/GB·小时 | 中 |
| **Hyperbrowser** Profiles | ✅ | `profile: {id, persistChanges}`，默认只读 | 只读时可以并行使用；写入行为没说明 | 官方 MCP | ✅ `liveUrl` | 云 | 未核实 | 中 |

**「chrome-use」是什么**：GitHub 上确实有这个项目（leeguooooo/chrome-use），最初基于 vercel-labs/agent-browser，现已独立。它通过浏览器扩展驱动**人自己的、已登录的 Chrome**，每个 session 一个标签组，支持 MCP。这和用户要的「每次新起、用完就关」正好相反，它适合个人桌面，不适合服务器上的多任务。用户说的也可能是 browser-use（同名系列里最主流的）或 Claude in Chrome。三者都已列入上表。

## 3. 推荐架构（首选）

```
 人（控制台）──登录 / 处理验证码──┐            ┌── 保险箱（加密，按 平台 × 账号 存一份）
                                  ▼            │   {version, storageState, 健康状态, 出口IP, UA}
 任务 → 编排器 ──① 租用账号（并发上限、TTL）──┘
            │ ② 起临时 Chrome：--user-data-dir=/tmp/sess-xxx，CDP 只绑 127.0.0.1，固定代理和 UA
            │ ③ 编排器通过 CDP 注入 cookie 和 localStorage（agent 拿不到明文）
            │ ④ 启动 Playwright MCP --cdp-endpoint ws://… → 交给子 agent
            │    └─ 遇到验证码或掉线 → 控制台通过 noVNC 或 CDP screencast 实时画面接管
            │ ⑤ 结束：健康探测 → 导出 storageState → 三方合并 + 版本号 CAS 写回
            └ ⑥ 关闭浏览器，删除临时目录，释放租约
```

- 简化版：第 ②～④ 步可以合并成 `npx @playwright/mcp --isolated --storage-state <临时解密文件> --headless`，结束前由编排器调用 `browser_storage_state` 导出。缺点是这个导出工具对 agent 也可见，需要编排器过滤，而且远程接管不如自己持有 CDP 连接方便。
- 人工接管有三条路，按推荐顺序：① 有界面的 Chrome 跑在 Xvfb 里，配 x11vnc + noVNC，嵌进控制台，体验等同于真机；② 用 CDP 的 `Page.startScreencast` 推画面、`Input.dispatchMouseEvent/KeyEvent` 回传操作，这是 Browserbase Live View 的同类做法，本机已验证可以拿到帧；③ 在 `--extension` 模式下让人用自己的 Chrome 处理。人处理完以后，**新 cookie 就在这个 session 的浏览器里**，走第 ⑤ 步的正常回写即可。如果是专门的「重新登录」任务，就整份替换保险箱并把版本号加一。

## 4. 共享 cookie 的五种机制

| 机制 | 怎么做 | 坑 |
|---|---|---|
| storageState 快照 + 回写 | `context.storageState()` 导出，`newContext({storageState})` 导入 | **不含 sessionStorage**（Playwright 官方说明）；IndexedDB 要显式开启；多 session 回写会互相覆盖，需要合并（见 §5）；文件本身就等于账号权限 |
| 共用同一个 user-data-dir | 所有浏览器指向同一个目录 | 真 Chrome 有 profile 锁，第二个会报 `Failed to create a ProcessSingleton`（实测）；**chrome-headless-shell 没有这把锁，能同时打开，可能写坏 SQLite**（实测）；Chrome 136 起，默认 profile 不允许开调试端口 |
| 复制 profile 目录 | 每个 session 复制一份模板目录 | 体积大（Steel 的上限是 300MB）；运行中复制会得到不一致的数据库；cookie 用系统密钥加密，换机器或换用户可能解不开；回写只能整份覆盖 |
| 常驻 Chrome + CDP 开标签页 | 多个 session 用 `connectOverCDP` 连同一个浏览器，在默认 context 里开页面 | cookie 实时共享（实测），不需要回写；但一处退出登录，所有 session 一起掉线；session 之间可能抢标签页；进程是单点故障；CDP 端口等于完整控制权，只能绑本机 |
| 云 profile / context | 创建 session 时指定 id 和 persist | 各家都提示不要并发写；写回是整份覆盖；数据在境外；关闭后要等几秒才同步完 |

## 5. 并发与回写

1. **按账号发租约**：每个「平台 × 账号」设并发上限。只读搜索建议从 2～3 开始，对轮换 cookie 激进的平台设为 1，或者改用备选 A。超出上限的任务排队。租约带 TTL，防止崩溃后租约一直不释放。
2. **三方合并**：以 session 领取时的快照为 base。只把「本 session 相对 base 改过」的 cookie（按 `name|domain|path` 作键）写进保险箱的当前版本，没改动的保持保险箱里的值。写回时用版本号做 CAS，冲突就重读重试。localStorage 按 origin + key 用同样的方式处理。这样，后关闭、持有旧 cookie 的 session 不会把新 cookie 覆盖掉（实测）。
3. **登录失效的 session 不回写**：写回前先做健康探测（访问一个需要登录的页面或接口，检查是否被跳到登录页），失败就丢弃本次结果，并把账号标记为「需要人工」。
4. **中途发现被轮换**：session 遇到掉线时，先从保险箱拉最新版本，用 `addCookies` 热更新后重试一次，仍然失败再上报。
5. **发现失效的信号**：session 开始和结束时的探测；agent 上报「看到登录页或验证码」；后台每 N 小时用只读探测保活；监控关键 cookie 的 `expires`。失效后在控制台提醒负责人重新登录。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 同一账号同时出现多个设备或 IP，触发风控或封号 | 每个账号固定一个出口 IP（和人登录时一致，国内平台用国内 IP）；UA、时区、语言、窗口尺寸和人登录时保持一致；限制并发；高并发账号用备选 A，对平台来说只是一台设备 |
| 无头浏览器被识别 | 不用 chrome-headless-shell（UA 里带 `HeadlessChrome`），改用正式版 Chrome，有界面运行在 Xvfb 中，或至少用新版 headless；不要承诺「反检测」，各家的 stealth 能力都只是尽力而为 |
| 平台条款 | Amazon Conditions of Use 禁止 "data mining, robots, or similar data gathering and extraction tools"；第三方条款跟踪站显示，2026-05 新增了「agent 必须表明身份」的条款（**未在官网原文核实**）；2026-09 Amazon 屏蔽了 Meta 的购物 agent。Temu、TikTok Shop、1688 以各自条款原文为准。需要法务确认，频率要像真人，优先用官方 API |
| cookie 泄露 | 保险箱加密存储（KMS / age / sops），文件权限 600，访问留审计记录；cookie 不进 prompt、日志和 trace，不把导出工具开放给 agent；CDP 只绑 127.0.0.1（Chrome 136 收紧调试端口正是因为有人借此窃取 cookie）；Steel 的 `debugUrl` 不需要鉴权，要在前面加带鉴权的反向代理；session 结束后删除临时目录（实测可以删干净） |
| agent 被网页提示注入，在已登录账号上做危险操作 | 用 `--allowed-origins` / `--allowedUrlPattern` 限制可访问的域名；搜品账号只给只读权限，尽量不绑定支付方式；下单、改资料这类操作走人工审批 |
| 隐私上报 | chrome-devtools-mcp 默认开启使用统计和 CrUX URL 上报，需要显式关闭 |

## 7. 本机验证（未接触任何真实账号）

脚本目录：`/tmp/claude-1000/-mnt-toshiba-Projects-HeyAgent/f5a5874c-3877-4626-bd8a-cb20c17939f4/scratchpad/browser-poc/`。使用 playwright-core 1.64.1 + chrome-headless-shell（build 1243），启动参数照抄 `design/tools/shot.mjs`。

- `server.mjs`：本地假站点。`/login` 下发 HttpOnly 的 `sid`，并写入 localStorage；`/check` 校验登录态；`/refresh` 轮换 sid，**旧值立即作废**。
- `poc.mjs` 的结果：
  - [1] 浏览器 A 登录，导出 storageState（包含 HttpOnly cookie 和 localStorage）后关闭。
  - [2] 全新浏览器 B 导入后访问 `/check`，返回 `OK sid=72d9…`，localStorage 也恢复了。
  - [3] C、D 从同一份快照并发启动。C 触发轮换后，D 立刻变成 `NOT-LOGGED-IN`。如果按「谁最后关闭谁覆盖」，保险箱会被写成已作废的旧 sid；三方合并后，保险箱 v2 保存的是 C 的新 sid（D 没有改动，因此不回写），新浏览器 E 用它访问返回 `OK`。
  - [4] 一个常驻浏览器，两个 `connectOverCDP` 连接：session1 登录后，session2 在默认 context 里直接是登录状态；`newContext()` 则是隔离的、未登录的。
  - [5] 同一个 user-data-dir 开两个 headless-shell：**两个都能启动**，没有锁。
- `lock.mjs`：换成完整版 Chromium 1243，profile 中生成了 `SingletonLock`，第二个启动报 `Failed to create a ProcessSingleton … profile is already in use`。
- `mcp.mjs`：以 stdio 方式运行 `@playwright/mcp@0.0.83 --isolated --storage-state … --caps storage`，`browser_navigate /check` 返回 `OK`；`browser_storage_state` 能导出文件；`--caps storage` 还会暴露 `browser_cookie_*`、`browser_localstorage_*` 等 17 个工具（说明不能把这个能力开给 agent）。
- `arch.mjs`（首选架构的端到端验证）：起临时 Chrome（CDP 绑 127.0.0.1）→ 编排器 `addCookies` → Playwright MCP `--cdp-endpoint` 访问 `/check` 返回 `OK` → CDP screencast 收到 800×600 的 jpeg 帧 → 站点轮换后编排器导出到新 sid → 关闭浏览器，临时目录已删除。注意：`addCookies` 不包含 localStorage，需要额外按 origin 注入。
- 两个 MCP 的 `--help` 原文保存在 `pwmcp-help.txt` 和 `cdmcp-help.txt`。另外发现一处出入：Playwright MCP 0.0.83 的 `--help` 说不指定 `--user-data-dir` 时会用临时目录，而官网文档说默认是按工作区持久化的 profile。**建议总是显式传 `--isolated`**。

## 8. 参考链接

- Playwright MCP：https://github.com/microsoft/playwright-mcp · profile 文档 https://playwright.dev/mcp/configuration/user-profile · 认证与 storageState https://playwright.dev/docs/auth
- chrome-devtools-mcp：https://github.com/ChromeDevTools/chrome-devtools-mcp（`docs/advanced-usage.md`、`docs/tool-reference.md`）
- Chrome 136 调试端口变更：https://developer.chrome.com/blog/remote-debugging-port
- browser-use：https://github.com/browser-use/browser-use · 参数 https://docs.browser-use.com/open-source/customize/browser/all-parameters · 认证 https://docs.browser-use.com/open-source/customize/browser/authentication · MCP https://docs.browser-use.com/open-source/customize/integrations/mcp-server
- chrome-use：https://github.com/leeguooooo/chrome-use · Claude in Chrome：https://code.claude.com/docs/en/chrome
- Browserbase Contexts https://docs.browserbase.com/platform/browser/core-features/contexts · Live View https://docs.browserbase.com/features/session-live-view · 价格 https://www.browserbase.com/pricing · MCP https://github.com/browserbase/mcp-server-browserbase
- Steel Profiles https://docs.steel.dev/overview/profiles-api/overview · Live Sessions https://docs.steel.dev/overview/sessions-api/embed-sessions/live-sessions · 价格 https://steel.dev/pricing
- Kernel Profiles https://www.kernel.sh/docs/browsers/profiles · Live View https://www.kernel.sh/docs/browsers/live-view · 价格 https://www.kernel.sh/pricing
- Hyperbrowser Profiles https://hyperbrowser.ai/docs/sessions/profiles
- Amazon 屏蔽购物 agent 的报道：https://searchenginejournal.com/amazon-blocked-metas-muse-and-robots-txt-had-nothing-to-say/590494
