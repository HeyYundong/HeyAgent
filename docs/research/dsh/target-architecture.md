# HeyAgent 整体换到 DeepSeek Harness fork：目标架构

> 2026-11-05 写。dsh 看的是提交 `8bd07339`（`0.2.2-alpha.3`），HeyAgent 看的是 main `c99199d`。没有运行任何代码。
> 依据是 `docs/research/dsh/notes/` 下的六份调研笔记（`dsh-core.md`、`dsh-host-ui.md`、`dsh-capabilities.md`、`dsh-browser-desktop.md`、`heyagent-backend.md`、`heyagent-frontend.md`，正文里的「笔记 xxx」指它们）和之前的评估 `docs/research/dsh/fork-assessment.md`；关键接口另外回到源码核对过。
> 标注：**[源码]** = 读过 dsh 源码确认；**[文档]** = 只见于 dsh 文档或 README；**[推断]** = 我的推断；**[未核实]** = 需要动手前先验证。
> 路径：`dsh:` 开头是 dsh 仓库里的路径；`S/` = `apps/server/src/`，`SH/` = `packages/shared/src/`。
> 用户已经定了整体替换，本文不再讨论该不该换，只写怎么换。和用户已定的 16 条有出入的地方，都放在第 21 节「待用户定」，正文按推荐写，并标出「偏离第 N 条」。

---

## 1. 结论和总图

### 1.1 一句话

前端不动；`/api` 换成一个 dsh fork 的主机进程（heyagent-api），里面挂着我们现有的 Hono/tRPC 代码；agent 循环换成 dsh 的 `agent-loop`，跑在 N 个 dsh 无界面进程（heyagent-worker）里，从 pg-boss 领运行，跑完或挂起就把 agent 丢掉；Chrome 拆到一个独立的 browser-host 进程；所有状态都在 Postgres。

### 1.2 几条总原则（后面每一节都按这几条推）

1. **业务状态放我们的表，dsh 会话日志只放「模型看得到的东西」。** dsh 的规矩是「模型能看到的必须是会话事件」（`dsh:docs/architecture.md`）[文档]。我们的状态（等待、要人办的事、检查点、结果、派活单、租约）全部留在现有表里，不往 dsh 日志里塞自定义事件。原因见 4.4。
2. **先把 dsh 日志 flush 落库，再提交我们的业务事务；业务事务必须能从日志重新推出来。** 进程在两者之间被杀，下一个 worker 恢复会话后，从日志里的工具结果（`meta`、`error.info` 会持久化 [源码 `dsh:packages/core/tools/src/contracts.ts`，笔记 1.2]）重新推出「该挂起 / 该收尾」，再补提交。这替代现在「工具结果和挂起同一个事务」的写法。
3. **一个运行同一时刻只在一个 worker 里有活的 Agent。** 活着 = 持有会话写租约。挂起、交接、结束都先 `flush` 再 `handle.dispose()`，内存里不留东西。等几天的运行不占任何进程。
4. **跨进程只经 Postgres。** 表 + `LISTEN/NOTIFY` + pg-boss。dsh 自己没有跨进程命令通道 [源码，笔记 dsh-core 6.2]，我们补。
5. **尽量不改 dsh 核心。** 新功能写成我们自己的插件包，靠组合包（只列允许项）挂进去；必须改核心的登记在 `docs/dev/dsh-patches.md`（第 16 节，目前只有 2 处必改）。

### 1.3 进程和数据流总图

```text
浏览器（同源，cookie）
   │ https / wss
   ▼
Caddy :8080（pod 唯一入口）
   ├── /            → 静态文件 apps/web/dist（不变，hash 路由）
   └── /api/*       → 127.0.0.1:3100  heyagent-api
                        │  dsh 主机进程（组合包 heyagent-api.yml）
                        │  ├ dsh host-webserver（只绑 127.0.0.1）
                        │  │  ├ 前缀路由 /api/trpc /api/auth /api/setup /api/files /api/imports
                        │  │  │  /api/gallery /api/compare /api/events /api/work-items /api/assistant /api/health
                        │  │  │      → 现有 Hono app.fetch（tRPC、better-auth、文件、助手 SSE…原样）
                        │  │  ├ 升级路由 /api/browser/view/*  → browser-host 的画面口
                        │  │  │          /api/desktop/view/*  → Windows 上的桌面代理（不变）
                        │  │  └ /api/<ns>/<method>、/api/remote.mux → Typert 网关（第 2 阶段才给前端用）
                        │  ├ ChangeHub：LISTEN heyagent_changes → live.onChange（不变）
                        │  ├ 只发任务的 pg-boss（不变）
                        │  └ 不跑 agent 循环
                        ▼
┌───────────────────────── Postgres 18 + pgvector ─────────────────────────┐
│ 业务表 64 张（基本不变） + 新表 dsh_sessions / dsh_session_events / run_inbox │
│ schema pgboss；NOTIFY 通道 heyagent_changes（推前端）、heyagent_run_control（控运行）│
└──────────────────────────────────────────────────────────────────────────┘
       ▲  领任务 / 写日志 / 写记录                    ▲ 租约、实例、保险箱
       │                                              │
heyagent-worker ×N（dsh 无界面进程，组合包 heyagent-worker.yml）
   ├ pg-boss 领 session.run.dsh（以及迁移完后的其他队列）
   ├ ctx.agents.create / resume → agent-loop → whenIdle → flush → dispose
   ├ 我们的插件：模型适配器、运行记录投影、工具、规则闸门、等待、收尾复核、子运行、派活、固化
   ├ heyagent-browser 提供方 ── CDP(tap) / HTTP 控制口 ──► browser-host
   └ heyagent-desktop 提供方 ── HTTP(Windows-MCP :8000 / 桌面代理 :8001) ──► Windows 桌面或虚拟机

heyagent-browser-host ×1..N（普通 Node 进程，不是 dsh 进程）
   Xvfb + 有界面 Chrome + gost、登录态保险箱读写、导航白名单拦截、下载、
   远程画面（CDP screencast）、等人处理时保留的 Chrome、给人登录用的 Chrome
```

### 1.4 一次运行的数据走向（概览）

```text
api: 立即运行 → 一个事务：快照 + sessions 行 + run_inbox(第一条消息) + 发 session.run.dsh
worker: 领到 → create(会话 id = 运行 id) → 取 run_inbox → agent.followup
        agent-loop 每步：pre-step(我们查上限/停止) → 模型(我们的适配器) → 工具流程(我们的闸门+工具)
        dsh 事件 ──session/event──► PG 会话存储：同一事务写 dsh_session_events + 投影出的 session_events + 用量
        ──NOTIFY──► api ChangeHub ──SSE──► 前端重拉 sessions.get（和今天一样）
挂起/结束: whenIdle → flush → dispose(关 Chrome 或交给 browser-host 保留) → 业务事务(等待/结果/派活结算)
继续: api 改等待记录 + 写 run_inbox(【继续】消息) + 发 session.run.dsh → 任意 worker resume
```

---

## 2. 进程和部署

### 2.1 进程清单

| 进程 | 是什么 | 入口（新） | 端口 | 镜像要的东西 |
|---|---|---|---|---|
| postgres | 不变 | — | 5432（127.0.0.1） | `docker.io/pgvector/pgvector:0.8.7-pg18-trixie` |
| heyagent-api | dsh 主机进程，`boot()` 起我们的组合 | `S/dsh-api.ts` | 3100（127.0.0.1） | Node ≥24.9 |
| heyagent-worker ×N | dsh 无界面进程 | `S/dsh-worker.ts` | 无对外端口 | Node ≥24.9、bubblewrap、`/opt/sandbox-root`、`@playwright/mcp` 0.0.83（只连 CDP，不带 Chrome） |
| heyagent-browser-host ×1..N | 普通 Node 进程 | `S/browser-host.ts` | 控制口 3190、CDP tap 口段（只绑 127.0.0.1） | Chrome、Xvfb、gost、`SYS_CHROOT` |
| web | Caddy，不变 | `deploy/Caddyfile` | 8080 | 不变 |
| 旧 worker（迁移期） | 现在的 `S/worker.ts`，只领旧引擎的 `session.run` 和其他队列 | 不变 | — | 不变 |

说明：

- **进程怎么起。** dsh 的 `app-boot` 给嵌入方留了直接按配置文件启动的入口：`installFailLoud(bin)` + `boot(bin, configPath)` [文档 `dsh:packages/boot/app-boot/README.md`「Starting the app」]。我们不用 dsh 的 profile 目录和 `dsh` 命令行，入口文件直接 `boot('heyagent-worker', <组合文件>)`。组合文件就是 Loader YAML，行的 `name` 可以写绝对路径、`file:` URL 或包名 [文档 同上]。
- **`DSH_HOME`。** 一些包会算 `dshHomePath(...)`。给每个容器设一个空目录（例如 `/var/lib/heyagent/dsh-home`），并在第 0 步加一条检查：跑完一次运行后这个目录必须还是空的（证明没有包往本地写会话、凭据、附件）[推断]。
- **webserver 只能绑具体 IP，不能 `0.0.0.0`** [源码 `dsh:packages/host/webserver/src/index.ts:358-365`]。pod 共享网络命名空间，绑 `127.0.0.1` 正好。
- **Node 升到 ≥24.9**（dsh `package.json` `engines.node`）[源码]。容器镜像钉到具体小版本；开发机也要升（现在 22.23）。pnpm 跟 dsh 对齐到 `11.28.5`（dsh `packageManager`）[源码]。
- **worker 镜像变小。** Chrome、Xvfb、gost 搬到 browser-host 镜像；worker 只留 Node、bwrap 沙箱根、Playwright MCP。worker 的 `securityContext` 可以去掉 `SYS_CHROOT`（Chrome sandbox 才要）[推断]。
- 启动顺序：postgres → api（等库、跑迁移，`deploy/api-entrypoint.sh` 不变）→ browser-host、worker（等 `/api/health`）。`scripts/pod.sh` 的停机顺序加上 browser-host（先停 worker，再停 browser-host 让它写回登录态，再停 api，最后 postgres）。

### 2.2 pod 和卷

- 还是一个 Podman pod（`deploy/pod.yaml`），多一个 browser-host 容器。卷不变：`pgdata`、`files`（`/data/files`，api、worker、browser-host 都挂，browser-host 写下载和截图）、`secrets`（KEK，api、worker、browser-host 都要读：worker 要解密 HTTP 工具密钥，browser-host 要解密保险箱）。
- 虚拟机要的 Podman socket（`HEYAGENT_PODMAN_SOCKET`）只挂给跑 `desktop.vm` 任务的进程（迁移期是旧 worker，最后是新 worker）。
- 只用 Podman，不用 Docker（`docs/dev/conventions.md` 第 3 节）。

### 2.3 并发上限放在哪

| 限制 | 现在 | 新架构 |
|---|---|---|
| 每个 worker 同时几个运行 | `session.run` localConcurrency 4 | 不变：`session.run.dsh` localConcurrency 4 = 每个 worker 最多 4 个活的 Agent。dsh 本身对 Agent 数量不设上限、也不回收 [源码，笔记 dsh-core 2.7]，必须靠这个数 |
| 每台机器几个 Chrome | `browser.maxPerWorker` 4（每个 worker） | 变成每个 browser-host 的上限，设置键名不变，意思改成「每个浏览器宿主」 |
| 其余（账号租约、桌面租约、派活名额、子 agent 名额、花费步数） | 库里 | 不变，代码照搬 |

---

## 3. 组合包与插件清单

### 3.1 为什么从零写允许清单

dsh 的 `dsh-base` 默认挂了多处外发（第 15 节）。叠在它上面再逐个关，上游一加新行就会漏。`sdk-minimal` 的做法是「这一份 insert 就是完整的插件树，不叠 dsh-base」[源码 `dsh:packages/bundle/sdk-minimal/cordis.patch.yml` 文件头]。我们照这个写，只列需要的行。

两个组合文件：`apps/server/dsh/heyagent-api.yml`、`apps/server/dsh/heyagent-worker.yml`，共用一份 `heyagent-base.yml`（两边都要的行）。三个文件统称 `heyagent-base` 组合。

### 3.2 两边都挂的

| 行 id | 包 | 作用 | 备注 |
|---|---|---|---|
| `timer` | `@deepseek-ai/cordis-plugin-timer` | 计时器服务 | sdk-minimal 也挂 [源码] |
| `heyagent-pg` | 我们：`S/dsh/pg` | 提供 `ctx.heyagentDb`（drizzle + pool，复用 `S/db/client.ts`）和 KEK（`S/lib/crypto.ts loadKeyring`） | 其他我们的插件都 inject 它 |
| `credentials` | 我们：`S/dsh/credentials`（实现 `@deepseek-ai/dsh-credentials` 的 `CredentialProvider`） | 接现有 `secrets` 表的信封加密 | 见 4.6 |

### 3.3 heyagent-worker 挂的

dsh 的包（全部是正式包，除了标明的）：

| 行 id | 包 | 为什么要 | 配置要点 |
|---|---|---|---|
| `llm` | `@deepseek-ai/dsh-llm` | `ctx.llm`，适配器注册表 | — |
| `llm-retry` | `@deepseek-ai/dsh-llm-retry` | 模型失败按适配器的 `providerRetryPolicy` 重试 | 配置为空对象 [源码 `llm-retry/src/index.ts:25`]，重试次数由我们的适配器给 |
| `token-meter` | `@deepseek-ai/dsh-token-meter` | 压缩要它量上下文 | — |
| `session` | `@deepseek-ai/dsh-session` | `ctx.sessions` | — |
| `session-projection` | `@deepseek-ai/dsh-session-projection` | agent-loop 硬依赖 | — |
| `session-checkpoint-policy` | `@deepseek-ai/dsh-session-checkpoint-policy` | 每次调模型前、每个顶层工具执行前把日志落盘 | inject `llm, sessionPersistence, sessions, tools` [源码] |
| `system-prompt` | `@deepseek-ai/dsh-system-prompt` | 提示词分节 | `includeHarnessIdentity: false`、`includeRuntimeContext: false`、`personaPrefix: ''`（照 sdk-minimal [源码]） |
| `tools` | `@deepseek-ai/dsh-tools` | 工具注册和执行流程 | — |
| `tool-executor-native` | `@deepseek-ai/dsh-tool-executor-native` | 直接执行模型的工具调用 | 不挂 `tool-executor-ptc`（模型不用 `run_code`） |
| `tool-timeout` | `@deepseek-ai/dsh-tool-call-timeout-policy` | 按工具的 `timeoutMs` 超时 | 81 行 [源码] |
| `agent` | `@deepseek-ai/dsh-agent` | `ctx.agents` | — |
| `agent-loop` | `@deepseek-ai/dsh-agent-loop` | 循环本体 | `agents: []` |
| `compaction` / `compaction-basic` / `compaction-tool-result-pruner` / `compaction-image-offload` | `@deepseek-ai/dsh-compaction*` | 上下文压缩 | 摘要模型指向我们的适配器、用「规划」角色模型；见 9.6 和第 21 节第 3 条 |
| `working-directory` | `@deepseek-ai/dsh-working-directory` | `tool-skill` 硬依赖 [源码 inject 列表] | 根目录 = worker 本地的运行空间目录 |
| `skills` / `tool-skill` | `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-tool-skill` | 技能目录和 `skill` 工具 | 来源由我们注册，见 9.3 |
| `browser-use` | `@deepseek-ai/dsh-browser-use` | 浏览器提供方名字注册表（48 行） | — |
| `computer-use` | `@deepseek-ai/dsh-computer-use` | 桌面提供方名字注册表（48 行） | — |
| （库，不是行） | `@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-ptc-runtime`、`@deepseek-ai/dsh-attachment` | 被我们的插件 import | `mcp-client` 在每个 agent 的作用域里按需挂 |

我们的插件（都在 `S/dsh/` 下，见第 17 节目录树）：

| 行 id | 位置 | 做什么 | 主要搬哪段现有代码 |
|---|---|---|---|
| `heyagent-session-persistence` | `S/dsh/persistence` | Postgres 版 `SessionPersistence`（`ctx.sessionPersistence`） | 新写 |
| `heyagent-attachments` | `S/dsh/attachments` | Postgres/`files` 卷版 `AttachmentStore`（`ctx.attachments`） | `S/files/storage.ts`、`service.ts` |
| `heyagent-llm` | `S/dsh/llm` | 包住 AI SDK 的 `LlmAdapter`，路由名 `heyagent` | `S/engine/model.ts` |
| `heyagent-record` | `S/dsh/record` | dsh 事件 → `session_events`、用量、步数 | `S/engine/records.ts`、`sessions.ts` 里写事件的部分 |
| `heyagent-run` | `S/dsh/run` | 驱动：领 `session.run.dsh`、create/resume、每轮之后判断、flush/dispose、跨进程控制 | `S/engine/loop.ts`（外层）、`stop-watch.ts`、`worker-runtime.ts` 的运行部分 |
| `heyagent-context` | `S/dsh/context` | 系统提示分节、记忆、技能来源、检查点动态上下文 | `S/engine/prompt.ts`、`S/memory/retrieval.ts` |
| `heyagent-tools` | `S/dsh/tools` | 内置工具、HTTP 工具、用户配置的 MCP、图库组、比物组 | `S/engine/tools/*`、`S/gallery/tools.ts`、`S/compare/tools.ts` |
| `heyagent-gate` | `S/dsh/gate` | `tools/pre-execute` / `post-execute` 闸门：范围、参数校验、规则、截断、掩码、检查点同步 | `S/engine/gateway.ts`、`rules.ts`、`hooks.ts`、`checkpoint-sync.ts`、`secrets.ts` |
| `heyagent-waits` | `S/dsh/waits` | 挂起、等待、审批、要人办的事、上限、模型失败转人工 | `S/engine/waits.ts`、`humans.ts`、`control.ts` |
| `heyagent-finish` | `S/dsh/finish` | `run.finish`、只回文字提醒、三方验收、结果判定、复核、结束统一入口 | `S/engine/verify.ts`、`outcome.ts`、`review.ts`、`run-ended.ts` |
| `heyagent-subagents` | `S/dsh/subagents` | 子运行工具 | `S/engine/subagents/*` |
| `heyagent-dispatch` | `S/dsh/dispatch` | 派活工具 | `S/engine/dispatch/agent-tools.ts` 等 |
| `heyagent-browser` | `S/dsh/browser` | 浏览器提供方（worker 侧） | `S/browser/tools.ts`、`mcp.ts`、`extract.ts`、`clipboard.ts`、`site-api.ts`、`page-brief.ts`、`form-readback.ts`、`detect.ts`、`captcha.ts` |
| `heyagent-desktop` | `S/dsh/desktop` | 桌面提供方 | `S/desktop/tools.ts`、`mcp-tools.ts`、`client.ts`、`control.ts`、`leases.ts` |
| `heyagent-routine` | `S/dsh/routine` | 我们的 `PtcRuntime` 实现 + 固化运行器 | `S/routine/runtime/*`、`S/sandbox/runner.ts` |
| `heyagent-sandbox` | `S/dsh/sandbox` | `code_run` 工具（bwrap + 出网代理） | `S/sandbox/*` |
| `heyagent-jobs` | `S/dsh/jobs` | 其他 pg-boss 队列（迁移最后一步才挂） | `S/engine/worker-runtime.ts` 里注册的其余处理函数 |
| `heyagent-desktop-vm` | `S/dsh/desktop-vm` | 虚拟机生命周期服务 + `desktop.vm` 任务 + 30 秒对账 | `S/desktop/vm/*` |

### 3.4 heyagent-api 挂的

| 行 id | 包 | 作用 | 备注 |
|---|---|---|---|
| `webserver` | `@deepseek-ai/dsh-host-webserver` | HTTP 承载、前缀路由、升级路由 | `host: '127.0.0.1'`、`port: 3100`；gzip 关掉（Caddy 做，避免 SSE 被缓冲；选项值[未核实]）。要打补丁 P-01（第 16 节） |
| `typert` / `typert-loader` | `@deepseek-ai/dsh-typert-registry`、`@deepseek-ai/dsh-typert-loader` | Typert 注册 | 照 dsh-base 的行 [源码 `bundle/base/cordis.patch.yml:46-51`] |
| `typert-gateway` | `@deepseek-ai/dsh-api-gateway` | `/api/<ns>/<method>`、`/api/remote.mux` | inject `typert, remoteAccess` [源码] |
| `remote-access` | `@deepseek-ai/dsh-api-remote-access` | 非 owner 访问者的角色和策略 | 网关硬依赖 |
| `connection` | `@deepseek-ai/dsh-client-connection` | `/api` 前缀、Host/Origin 检查、认证 | inject `credentials` [源码 `index.ts:93`]；第 2 阶段打补丁 P-02 |
| `heyagent-http` | 我们：`S/dsh/http` | 把现有 Hono `createApp()` 挂成十来个前缀路由 | `S/app.ts`、`S/auth.ts`、`S/index.ts` |
| `heyagent-view-relay` | 我们：`S/dsh/view-relay` | 两个远程画面 WebSocket | `S/browser/view-relay.ts`（目标改成 browser-host）、`S/desktop/view-relay.ts`、`S/lib/ws-relay.ts` |
| `heyagent-live` | 我们：`S/dsh/live` | ChangeHub | `S/live/hub.ts` |
| `heyagent-background` | 我们：`S/dsh/background` | bootstrap、图库/记忆补算向量、只发任务的 pg-boss | `S/bootstrap/*`、`S/gallery/background.ts`、`S/memory/embed.ts`、`S/engine/queue.ts initEngineClient` |
| `heyagent-principal`（第 2 阶段） | 我们：`S/dsh/principal` | `PrincipalMap` 加 `user`、注册 remote-access 策略 | 新写 |

**明确不挂**（两边都不挂）：`session-log-deepseek`、`plugin-package-inventory-deepseek`、`deepseek-llm-api-extensions`、`llm-deepseek*`、`deepseek-account*`、`authorization`、`session-telemetry-otel`、`otel`、`command-feedback`、`message-feedback`、`anonymous-user-id`、`web` / `web-search-deepseek` / `web-deepseek-api`、`plugin-manager`、`tool-plugin-manager`、`plugin-market`、`hmr`、`config-editor`、`settings`、`credentials-local`、`session-persistence-jsonl`、`storage-*`、`attachment-local`、`spill-local`、`session-title*`、`session-query*`、`session-projection-cache`、`schedule`、`jobs-local`、`subagent*`、`agent-team`、`user-approval`、`user-questions`、`goal*`、`permission-presets`、`sandbox*`、`tool-fs`、`tool-bash*`、`terminal*`、`frontend-static`、`web-app`、`client-modules`、`client-hmr`、所有 `client/ui-*`、所有 `experimental/*`。

为什么不挂 `user-approval`：工具流程遇到 `ask` 时会调 `ctx.approval.request`，没有这个服务就直接拒绝 [源码 `pipeline.ts:431-472`，笔记 capabilities 1.3]。我们的闸门从不返回 `ask`（第 6 节），所以不需要它。

### 3.5 外发检查做成测试

- 组合文件里每一行的包名，和一份签入的允许清单 `apps/server/dsh/allowlist.txt` 比，多一行就测试失败。
- 对 pnpm 工作区里实际装的 dsh 包目录跑一次 grep：`deepseeksvc.com`、`api.deepseek.com`、`platform.deepseek.com`、`registry.npmjs.org`、`npmmirror`、`jsdelivr`、`unpkg`、`otlp`。命中的包如果不在「不挂」清单之外，要逐条解释。
- 第 0 步的抓包验证见 18.2。

---

## 4. 数据和存储

### 4.1 表的去留

| 类别 | 表 | 去留 |
|---|---|---|
| 配置（任务、技能、记忆、规则、工具、模型、浏览器、桌面、设置、用户…） | 约 30 张 | **不变** |
| 运行 | `sessions` | 保留。加两列：`engine text not null default 'legacy'`（`legacy` / `dsh`）、`engine_state jsonb`（驱动自己的小状态：上次处理到哪个 dsh 序号、收尾到哪一步，见 5.10） |
| | `tasks` | 加一列 `engine text not null default 'legacy'`：「用新引擎」开关，新建运行时抄进 `sessions.engine` |
| | `session_events` | **保留，照旧给前端读**。新引擎由 `heyagent-record` 投影写入（4.4） |
| | `session_messages` | **只给旧引擎**。新引擎的模型历史在 `dsh_session_events`。旧引擎退役后只读，留着看历史 |
| | `checkpoints`、`checkpoint_records`、`session_waits`、`human_items`、`files`、`work_items`、`account_leases`、`desktop_leases`、`routine*`、`notifications`、`audit_events`… | **不变** |
| | `session_waits.pending` | jsonb 结构加字段（6.3）：`dshCallId`、`toolName`、`args`、`state`、`resultFileId` |
| 浏览器 | `browser_workers` | 表名不改（前端实时推送按表名，`SH/live.ts`），行的意思改成「一个 browser-host 进程」；`control_url` 指向 browser-host |
| | `browser_instances` | 加 `host_id`（哪个 browser-host）、`cdp_tap_url`、`held_for_session` |
| 新增 | `dsh_sessions`、`dsh_session_events` | dsh 会话日志（4.2） |
| | `run_inbox` | 要交给运行的消息和控制指令（4.5） |
| 按需 | `dsh_kv_units`、`dsh_kv_records` | dsh `storage` 的 KV 后端。当前允许清单里**没有包用 `storage`**（grep 过：只有 schedule、workspace、projection-cache、cua 等用，全在「不挂」里）[源码]。先不做，见第 21 节第 7 条 |

迁移文件接在现有 `apps/server/drizzle/0038` 后面，照规矩写 `IF NOT EXISTS`。

### 4.2 dsh 会话存储：`heyagent-session-persistence`

**接口**（`dsh:packages/session/session-persistence/src/index.ts`、`handle.ts`）[源码]：服务级 `create / open / flush / stat / list`，每个会话一个 `SessionHandle`（`read / append / flush / close`）。没有 `export`，也没有删除接口。

**表：**

```sql
create table dsh_sessions (
  id text primary key,                 -- = sessions.id（运行 id，R-1024-1、R-1024-1.2）
  header jsonb not null,               -- SessionHeader（version、createdAt、parentSession…）
  inherited_event_count int not null default 0,
  format_version int not null,         -- 目前 4（SESSION_FORMAT_VERSION）
  next_seq int not null default 0,
  revision bigint not null default 0,
  owner_token uuid,                    -- 写租约令牌（fencing）
  owner_id text,                       -- 哪个 worker（排查用）
  lease_until timestamptz,
  created_at timestamptz not null default now()
);
create table dsh_session_events (
  session_id text not null references dsh_sessions(id),
  seq int not null,
  type text not null,
  event jsonb not null,                -- 整条 SessionEvent
  primary key (session_id, seq)
);
-- 和 session_events 一样装「禁止 UPDATE」触发器；不装 NOTIFY 触发器（量大，前端不读它）
```

dsh 会话 id 没有格式限制（`SessionId(id)` 只加品牌）[源码 `dsh:packages/core/session/src/types.ts:28`]，直接用运行 id。

**写入路径。** dsh 的规矩是后端自己订阅实时事件，agent-loop 不直接调后端 [源码 `session-persistence-jsonl/src/storage.ts:520+`，笔记 dsh-core 3.5]。照 JSONL 后端写三个监听：

- `session/event`（同步）→ 放进该会话写句柄的内存队列；
- `session/flush`（等待）→ 把队列写成一个事务；
- `session/disposed` → 关句柄。

后台每 200 ms 合并一批（照 JSONL 的 `LIVE_WRITE_BATCH_MAX_DELAY_MS`）。dsh 在每次调模型前都会 flush（checkpoint-policy）[源码头注释]，所以一步最多丢一次模型调用之前的内容。

**一个批次的事务：**

```sql
begin;
insert into dsh_session_events ... (n 行);
-- 我们的投影行和用量（4.4），同一个事务
insert into session_events ...;  update sessions set tokens_in=…, cost_usd=…, step_count=… where id=$1;
update dsh_sessions set next_seq = next_seq + $n, revision = revision + 1
 where id = $1 and next_seq = $first and owner_token = $tok;   -- 0 行 → SessionOwnershipLostError
commit;
```

最后一句同时保证序号连续和「只有持租约的人能写」。投影是我们的扩展：后端提供一个可选的 `projector` 钩子，`heyagent-record` 注册；dsh 自带的契约测试跑的时候不挂钩子。

**单写入方：租约 + fencing（推荐），不用 advisory lock。**

- `create` / `open('write')`：`update dsh_sessions set owner_token = gen_random_uuid(), owner_id = $worker, lease_until = now() + interval '90 seconds' where id = $1 and (owner_token is null or lease_until < now()) returning owner_token`；拿不到抛 `SessionAlreadyOwnedError`。
- 心跳每 30 秒续 `lease_until`（和 pg-boss 心跳同一个节奏）。续不上 = 租约丢了 → 立刻 `agent.cancel({ kind: 'hook', reason: 'heyagent/lease-lost' })`，不再写。
- `close`：drain 队列、写完、`owner_token = null`。
- 为什么不用 advisory lock：advisory lock 要每个活会话占一条专用连接，而且锁连接断了、进程还活着时，另一个 worker 能拿到锁，两边同时写；租约 + 每次写都比令牌，两边同时写不可能成功。代价是 dsh 原来「锁没有过期」的假设变了（JSONL 用 flock，进程不死锁不放）[源码 `lease.ts`]，安全靠 fencing 那句 `where owner_token = $tok` 保证 [推断]。

**读：** `select event from dsh_session_events where session_id = $1 and seq >= $off order by seq limit $len`，再过 `validateStoredEvents(header, events)`（未知事件类型直接拒绝，fail-closed）[源码 导出的 helper]。

**其他：** `stat` / `list` 读 `dsh_sessions`；`list` 不分页，我们自己的查询不走它。`flush()`（服务级）= 所有写句柄 drain。格式版本只认 4，旧版本直接拒（我们没有旧 dsh 数据）。

**验证：** 跑 dsh 自带的 `runPersistenceContract(name, make)`（`tests/contract.ts:139`，支持 `reopen` 做跨实例）和 `runLiveWritePathContract`（`tests/live-write-contract.ts:49`）[源码]。另加我们自己的两条：两个进程抢同一个会话只有一个能写；租约过期后旧持有者的写入被拒。

**体积：** 每个事件一行，`assistant/message` 带完整流 [源码笔记 3.6]。先用 jsonb（TOAST 自动压缩），量大了再换 zstd + bytea。保留期：结束 90 天后可以清 dsh 日志，`session_events` 留着（清理任务后加）。

### 4.3 附件：`heyagent-attachments`

dsh 的图片（工具返回截图、`browser.look`、用户附图）进模型前要变成 `ImageAttachmentRef`，由 `ctx.attachments`（抽象类 `AttachmentStore`：`imageLimits`、`validateImage`、`saveImage`、`readImage` 等）存取 [源码 `dsh:packages/attachment/attachment/src/index.ts:77-195`]。`attachment-local` 存在 `$DSH_HOME/attachments/v1`，多进程不能用。

我们的实现：内容放 `files` 卷（`S/files/storage.ts` 已经有存储接口），元数据进 `files` 表（`kind = 'attachment'`，带 `session_id`），按内容哈希去重。抽象方法的完整清单动手前逐个对一遍 [未核实全部方法]。

### 4.4 运行记录：投影，不用自定义 dsh 事件（第 4 条的选择）

**选投影。** 理由：

1. dsh 读日志是 fail-closed 的：日志里出现 `KNOWN_SESSION_EVENT_TYPES` 以外的类型，整个会话读不出来 [源码 `known-event-types.ts`，由 `scripts/gen-persistence-catalog.ts` 生成]。加自定义事件要么改核心再生成目录，要么标 `ignorable`。
2. `plugin:` 记录（`appendPluginRecord`）只许 `packages/experimental/` 下的生产代码调用，有检查脚本 `verify-plugin-record-callers` 拦；格式迁移时「尽量保留」，可能丢 [源码 `core/session/src/index.ts:471-500`]。
3. 前端读的是 `session_events` 表，靠触发器推送；状态要能 SQL 查、要和 pg-boss 任务同一事务。放进 dsh 日志反而还要再投影一次。

**怎么投：** `heyagent-record` 在每个 Agent 上挂监听，按下表把 dsh 事件变成我们的 `session_events` 行，交给 4.2 的 `projector` 钩子，和对应的 dsh 事件同一个事务落库：

| dsh 来源 | 我们的 `session_events.kind` | 字段从哪来 |
|---|---|---|
| `assistant/message`（带 `usage`）+ 适配器的花费旁路（8.4） | `think` | 花费、缓存命中、tokens；同时更新 `sessions.tokens_in/out、cost_usd、step_count` |
| `tools/result` 监听（内存里有完整结果、耗时）+ 随后的 `tool/result` 事件 | `tool` | `tool_id`（dsh 工具名 → 我们的工具 id，按快照里的对照表）、`input`、`output`（已截断掩码）、`ms`、`trace`（浏览器录下的代码、前后网址、网络请求范围、routineStep…，放在工具结果的 `meta` 里，`meta` 会持久化） |
| 恢复时 dsh 补的「中断」结果（`interruptedTurnClosers`）[源码 agent-loop `index.ts:686-833`] | `error` | 「被中断了（worker 重启），不确定有没有执行成功」，和今天 `repairDanglingCalls` 的话一样 |
| 我们自己的动作（计划、检查点、规则命中、等待、继续、人处理、验收、结束、错误） | `plan` `checkpoint` `rule` `wait` `resume` `human` `verify` `done` `error` | 和今天一样，在我们自己的业务事务里写（`S/engine/records.ts`），不经 dsh |

`session_events.seq` 照旧由 `sessions.event_seq` 在行锁下发号，两类写入不会撞号。日志文字版（`S/engine/log-text.ts`，复核、总结、固化材料用）照旧从 `session_events` 拼，基本不用改。

dsh 的 `session.append` 会拒绝 `undefined`、`Date`、`Map`、`BigInt`、`-0` 这类值 [源码 `core/session/src/index.ts`，笔记 dsh-core 3.1]。我们的工具返回值进 dsh 前必须是干净的 JSON：所有工具都走一个 `toJsonValue()` 清洗。

### 4.5 `run_inbox`：交给运行的消息

```sql
create table run_inbox (
  id bigserial primary key,
  session_id text not null references sessions(id),
  kind text not null,          -- start / resume / steer / approval_result / system
  content jsonb not null,      -- 文字 + 附件文件 id（worker 转成 dsh UserMessage）
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  consumed_seq int             -- 进 dsh 日志后的序号
);
```

为什么要它：今天 api 进程直接往 `session_messages` 追加「【继续】…」，因为谁都能写那张表。新引擎的模型历史只能由持租约的 worker 写，api 不能写。所以 api 把要说的话写进 `run_inbox`，worker 拿到会话后再 `agent.followup()` / `agent.steer()`。

**不重复交付：** 交给 dsh 的 `UserMessage` 带我们自己的来源 `{ kind: 'heyagent', inboxId }`。`MessageSourceMap` 允许各模块自己加 kind [源码 `dsh:packages/llm/llm/src/message.ts:104-115`]。worker 交付前先在会话里找有没有这个 `inboxId`，有就只补标 `consumed_at`。恢复后的校验会不会对未知来源报错 [未核实，第 0 步验证]。

### 4.6 凭据、设置、文件

- **凭据。** `heyagent-credentials` 实现 `CredentialProvider` 的全部抽象方法（`resolve / describe / set / unset / readRecord / describeRecord / listRecords / modifyRecord / deleteRecord`）[源码 `credentials/credentials/src/index.ts`]，后端是现有 `secrets` 表（`scope = 'dsh'`、`ref_id = 引用名`）+ `S/lib/crypto.ts` 的信封加密，AAD 照旧 `secrets:<id>:<version>`。谁在用：`connection` 的浏览器会话签名密钥（记录 `client-connection/browser-session`）[源码]。我们自己的模型密钥、HTTP 工具密钥、MCP 环境变量**不经它**，照旧由我们的代码在执行时解密（这样「模型只见 `{{名字}}`」的规则不变）。
- **设置。** 不挂 dsh 的 `settings` / `config-editor`（它们把改动写进 `cordis.patch.yml`）[文档]。组合文件里只有部署级的固定值（端口、绑定地址），从环境变量读。所有业务设置照旧在 `settings` 表，我们的插件自己读（`S/engine/settings.ts`）。
- **文件。** 运行空间、附件、截图、下载、产物照旧在 `files` 表 + 卷（`S/files/*`）。worker 本地的运行空间目录（沙箱用的镜像）照旧，同时作为 dsh `working-directory` 的根。

---

## 5. 一次运行的完整流程

下面每一步写：在哪个进程、哪个插件、用 dsh 的什么接口、搬哪段代码。

### 5.1 创建（api 进程，tRPC `engine.runNow` 等）

1. 照旧走 `S/engine/sessions.ts` `startSessionInTx`（前置检查、快照 `buildSnapshot`、插 `sessions`、审计）。改两处：
   - `sessions.engine` 抄任务的 `engine`；
   - `engine = 'dsh'` 时，第一条消息（任务说明、附加说明、附件 id）写 `run_inbox(kind = 'start')`，不写 `session_messages`；发的任务是 `session.run.dsh`。
2. 所有发 `session.run` 的地方（创建、继续、交接、worker 启动重排）收进一个函数 `sendRunJob(tx, session)`，按 `sessions.engine` 选队列。这样旧 worker 永远领不到新引擎的运行。
3. dsh 会话**不在 api 里建**。第一个领到的 worker 建（5.3）。

### 5.2 领取（worker，`heyagent-run`）

- `boss.work('session.run.dsh', { localConcurrency: 4 })`，singletonKey = 运行 id，心跳 30 秒，单任务最长 3600 秒（照 `S/engine/queue.ts`）。
- 读 `sessions`：不是 `running` 或 `engine != 'dsh'` → 直接 `skipped`（照今天）。
- `resolveAutoMemory`（`S/memory/retrieval.ts`）照旧，在建 Agent 之前做，结果写回快照。
- 起停止监视（5.8）。

### 5.3 建或恢复 Agent（worker，`heyagent-run`）

```ts
const exists = await ctx.sessionPersistence.stat(SessionId(runId))
const handle = exists
  ? await ctx.agents.resume({ resumeSessionId: SessionId(runId), setup })
  : await ctx.agents.create({
      sessionId: SessionId(runId),
      meta: { cwd: spaceDir(runId) },
      agentOptions: { provider: 'heyagent', model: snapshot.modelId },
      setup,
    })
```

- 接口 [源码 `dsh:packages/core/agent/src/index.ts`，笔记 dsh-core 2.2]：`create` 走 `sessionPersistence.create(header)`（拿写租约）；`resume` **先** `open(id, 'write')`（拿写租约）、读全部事件、补中断轮次的收尾、再初始化。没挂会话存储时 `resume` 直接抛错。
- 为什么先 `stat`：dsh 规定「没落盘过的会话等于不存在」[源码 README]，所以建到一半崩了，下次还是 `create`；落过盘就 `resume`。
- `setup(agentCtx, agent)` 只做组装，不驱动；抛错全部回滚 [源码 JSDoc]。在这里按**快照**往 `agentCtx` 上注册这次运行的全部东西（工具、提示分节、技能来源、闸门监听、浏览器/桌面提供方的绑定），见第 9 节。`resume` 时再传一次 `setup`，所以挂起几天后恢复，用的还是开始时冻结的快照（不变式 2）。
- 拿不到租约（`SessionAlreadyOwnedError`）→ 说明另一个 worker 还持有（例如它还在 dispose），任务按 pg-boss 退避重试。

### 5.4 恢复后先对账（worker，`heyagent-run`）

按顺序，每项都幂等：

1. **补提交上次没提交的业务事务**（原则 2）：看日志最后一轮的结束原因和最后几个工具结果。工具结果 `meta.heyagent.intent` 是 `suspend` / `finish`，但库里状态还是 `running` → 照意图补做挂起或收尾（5.9、5.10）。
2. **执行人已经批准的调用**（6.3）。
3. **交付 `run_inbox` 里没消费的消息**（4.5）：`start` 和 `resume` 用 `agent.followup()`，`steer` 用 `agent.steer()`。
4. 要先跑固化脚本（`snapshot.routine` 还没跑过 / 停下等人 / 中途被杀）→ 第 13 节，跑完或交给 agent 再往下。

### 5.5 agent 循环（worker，dsh `agent-loop` + 我们的监听）

dsh 一轮的顺序 [文档 `docs/architecture.md`「Turn flow」，和源码事件声明一致]：`turn/start` → 取输入 → `agent/pre-step` → `step/start` → 调模型 → `assistant/message` → 工具调用 → 工具流程 → `tool/result` → `step/end` → … → `agent/turn-stopping` → `turn/end`。

我们挂在各处的东西：

| 时机 | dsh 接口 | 我们做什么 | 现有代码 |
|---|---|---|---|
| 每步之前 | `agent/pre-step` 瀑布，可返回 `{ kind: 'reject' }`，轮次以 `blocked` 结束 [源码 `agent-loop/src/agent.ts:348-349`] | ①运行被停 / 状态不是 running；②跑满 30 分钟（交接）；③花费、步数上限（父运行按「父 + 子」合计）；④`cost_over` 规则；⑤有挂起请求（同一步里前面的工具要挂起）。任何一条成立就记下原因、返回 `reject` | `loop.ts hitLimit`、`hooks.ts runBeforeStepHooks` |
| 调模型 | `ctx.llm` → 我们的适配器（第 8 节） | 一次一步、不传 temperature、各家的坑 | `model.ts` |
| 模型失败 | `llm-retry` 按 `providerRetryPolicy` 重试，用完轮次以 `error{LlmFailure}` 结束 [文档] | 适配器给 3 次、2 秒起翻倍；用完交给 5.9 的「模型失败转人工」 | `loop.ts callWithRetry`、`askAboutModelError` |
| 工具前 | `tools/pre-execute` 瀑布：`allow / deny / cancel / ask` [源码 `pipeline.ts`] | 闸门（9.5），从不返回 `ask` | `gateway.ts`、`rules.ts` |
| 工具体 | 我们注册的 `ToolDefinition.execute`，`exec.concludeTurn()` 可以结束本轮 [源码 `pipeline.ts:143`] | 要挂起、要收尾的工具在这里结束本轮 | `tools/builtin.ts` 等 |
| 工具后 | `tools/post-execute` 瀑布：可以换内容、换值、`block` [源码] | 截断、隐藏密钥原文、后置规则、页面要人处理 | `gateway.ts`、`hooks.ts runAfterToolHooks` |
| 观察结果 | `tools/result`（只看） | 投影 `tool` 行、自动记检查点、截图存证、通知 | `checkpoint-sync.ts`、`records.ts` |
| 轮次要结束 | `agent/turn-stopping`（串行），这里 `agent.steer()` 能再要一步 [源码笔记 2.4] | 「只回文字不报结果」：没提醒过就 `steer` 一条提醒（标记在 `sessions.rule_state`）；父运行还有没结束的子运行同理 | `loop.ts` 里的 `finishNudged`、`subagentNudged` |

工具都标 `isConcurrencySafe: false`，一个一个执行（和今天一样）[源码：只有显式 `true` 才并行]。

### 5.6 工具结果的三种特殊结局怎么落到 dsh

今天的 `ToolOutcome` 有 `finish`、`suspend`、`approval` 三种特殊结局（`S/engine/tools/builtin.ts:90-123`）。新做法：

- **`finish`（`run.finish`）和 `suspend`（`session.wait`、`ask.human`、等浏览器/桌面/子运行/派活、页面要人处理）**：工具体返回正常结果（给模型看的话，例如「已挂起，等到 … 会叫醒你」），把意图写进结果的 `meta.heyagent.intent`（持久化），调 `exec.concludeTurn()` 结束本轮。同一步后面还有调用：闸门看到本 Agent 有挂起意图，一律 `deny`，理由「同一步前面的调用已经挂起 / 收尾，这一步没执行」（和今天补「没执行」一样）。
- **`approval`**：见 6.2。

### 5.7 每轮之后（worker，`heyagent-run`）

```text
await agent.whenIdle()
await ctx.sessions.flush(agent.session)       // dsh 日志落库（原则 2 的前半）
decision = judgeTurn(agent)                    // 看 turn/end 原因 + 本轮记下的意图
```

`judgeTurn` 的结果和处理：

| 结果 | 条件 | 处理 |
|---|---|---|
| 继续 | 三方验收要反问、模型失败后人点了重试（在别的运行里） | `agent.followup(…)`，回到循环 |
| 挂起 | 工具意图 `suspend`、pre-step 因上限 / 规则 / 审批 `reject` | 5.9 |
| 说做完了 | `run.finish` 办成、或只回文字已提醒过 | `runFinishHooks`（规则 `agent_done`、三方验收）→ 可能「继续」或 5.10 |
| 没办成收尾 | `run.finish` 没办成、子运行到上限 | 5.10 |
| 交接 | pre-step 因 30 分钟 `reject` | flush → dispose → `sendRunJob` 再排一个（`handoff` 事件），和今天一样 |
| 被停 | 停止监视触发 `agent.cancel` | dispose，什么都不再写（钱照记，已经在投影里） |
| 模型失败 | `turn/end` 是 `error` | 5.9 的「模型失败」那条 |

### 5.8 停止（跨进程，见第 7 节）

- 停止监视：每秒查一次在跑运行的状态（照 `S/engine/stop-watch.ts`），另外 LISTEN `heyagent_run_control`，收到本 worker 持有的运行就立刻查。
- 已结束 → `agent.cancel({ kind: 'user' })`。取消会中止正在调的模型和正在执行的工具（信号传到每个瀑布）[源码笔记 2.5]。浏览器起到一半由提供方的信号停下。

### 5.9 挂起（worker，`heyagent-waits`）

顺序：**flush → dispose → 业务事务**。

1. `ctx.sessions.flush(session)` 已在 5.7 做过。
2. `handle.dispose()`：停循环、等收尾、注销、拆作用域 [源码笔记 2.5]。作用域里注册的东西随之拆掉：MCP 连接断开、浏览器提供方 `close()`——普通挂起让 browser-host 写回登录态并关 Chrome；等人处理（验证码、登录页）告诉 browser-host「保留给这个运行 `browser.humanHoldMinutes` 分钟」。写租约随句柄关闭释放。
3. 业务事务：照搬 `S/engine/waits.ts suspendInTx`——条件更新 `running → waiting / needs_human` + 写 `session_waits` + 排 `session.wake` / `session.remind` + `wait` 事件 + 派活 / 子运行的 pump。

为什么先 dispose 再提交：反过来的话，事务一提交就可能被立刻叫醒（例如事件已经到了），另一个 worker 去 `resume` 会撞上还没释放的租约。先 dispose，中间崩了，状态还是 `running`，pg-boss 重试时 5.4 第 1 步按日志里的意图补提交 [推断]。

几种挂起来源（全部写成上面的同一个流程）：

| 来源 | 谁发起 | 意图写在哪 |
|---|---|---|
| `session.wait`、`ask.human` | 工具体 | 工具结果 `meta` |
| 等浏览器 / 账号 / 桌面 / 子运行 / 派活结果 / 派活名额 | 工具体（提供方、子运行、派活工具） | 工具结果 `meta` |
| 页面要人处理（验证码解不了、登录页） | 浏览器工具体 | 工具结果 `meta`（带截图文件 id） |
| 审批（规则 `ask_human`） | 闸门 | `deny` 的 `error.info` + `session_waits.pending`（6.2） |
| 花费 / 步数上限、`cost_over` | pre-step | 驱动内存里的原因；崩了重新算一遍就能得到同样结论 |
| 模型失败 | 轮次 `error` | 日志里的 `turn/end`；被派运行先看派活单能不能自动重试（照 `askAboutModelError`） |
| 三方验收争议 | 收尾流程 | 我们的表（`sessions.verification`） |

### 5.10 结束（worker，`heyagent-finish`）

顺序照旧：**结论定 → 关资源（dispose，Chrome 写回登录态）→ 写过程 → 写最终状态 → 事务外复核**。

1. 结论：`run.finish` 的参数（办成 / 没办成 + 依据）在工具结果 `meta` 里；三方验收（`S/engine/verify.ts`）在 dispose 之前做，因为可能要反问 agent 继续。验收用的是结构化调用，直接走我们的模型层（第 8 节），不经 dsh。
2. `flush` → `dispose`（关资源）。
3. 一个事务（照搬 `finishRun`）：`outcomeFactsInTx` + `judgeByRules`（`S/engine/outcome.ts`）、状态 `done`、结果或 `review.pending`、`done` 事件、子运行写 `sub_result`、`afterRunEndedInTx`（`S/engine/run-ended.ts`：派活单结算、叫醒父、停子）。
4. 事务外：`reviewAfterFinish`（`S/engine/review.ts`）→ 结算派活单 → `notifyFinished` → `afterRunSettled`（固化统计、自动固化）。复核读的是 `session_events` 拼出的过程，不用改。
5. `sessions.engine_state.finishStep` 记到哪一步了。复核在事务外，崩了由 `work.sweep` 的「过时复核」兜底（不变）。

失败（`failSession`）和取消（`cancelSessionInTx`）照旧，都走 `afterRunEndedInTx`。

---

## 6. 等待、审批、人接手

### 6.1 现在的等待种类照搬

时间 / 事件 / 时间或事件、人（`ask.human`、规则审批、上限、`cost_over`、模型失败、验收争议、验证码/登录页）、资源（`browser.profile:*`、`browser.lease:*`、`desktop:*`）、派活（`work.done:*`、`work.slot:*`）、子运行（`subagent.all/any/queue:*`）——共约 12 类，全部还是 `session_waits` 的行，继续由 `resumeInTx`（「谁先到谁生效」的条件更新）处理。**dsh 没有可以挂几天的等待** [源码：审批是进程内的 promise，笔记 capabilities 6.2]，所以这部分整块是我们的。

`resumeInTx` 只改一处：今天它往 `session_messages` 追加「【继续】现在是 …（上海时间）。<等到了什么>」，新引擎改成写 `run_inbox(kind = 'resume')`，其余（条件更新、`sessionPatch`、`resume` 事件、发任务、审计）不变。

### 6.2 审批：拦下 → 写等待 → 结束本轮 → 释放 Agent

dsh 的审批（`ctx.approval.request`）只能在打开的轮次里、用内存 promise 等，进程一重启就丢 [源码笔记 capabilities 6.1、6.2]。我们换成持久的「要人办的事」：

1. **拦下。** `heyagent-gate` 的 `tools/pre-execute` 监听命中规则 `ask_human`（快照里人确认过的规则，`approvedRuleIds` 里没有这条）：
   - 一个事务里：写 `human_items(kind = 'approval')`、`session_waits`（`status = 'waiting'` 先不写，见第 3 步）的 `pending` 草稿：`{ dshCallId, toolName, toolId, args, ruleIds, state: 'asked' }`。参数里的密钥字段照旧掩码（`maskSecretFields`）后才进事项详情。
   - 返回 `{ kind: 'deny', reason: '这一步要人审批，已经提交，审批结果出来后系统会告诉你。不要换别的办法绕过去。', info: { code: 'HEYAGENT_APPROVAL_PENDING' } }`。`deny` 的理由和 `info` 会写进这次调用的结果（持久化）[源码]。
   - 给本 Agent 记一个挂起请求。
2. **同一步后面的调用。** 闸门看到挂起请求，一律 `deny`「前面一步在等审批，这一步没执行」。
3. **结束本轮。** 下一个 `agent/pre-step` 看到挂起请求，返回 `reject`，轮次以 `blocked` 结束 [源码]。然后照 5.9：flush → dispose → 挂起事务（把草稿等待改成 `waiting`、状态改 `needs_human`、`wait` 事件、`session.remind`）。
4. **人批了。** api 的 `resolveHumanItemImpl` 照旧：批准 = `pending.decision = 'approved'`，拒绝 = `'rejected'` + 理由 → `resumeInTx` → 发任务。这一步**不写**「【继续】」消息，因为结果由 worker 作为消息交给模型。
5. **恢复时执行被批的调用**（5.4 第 2 步，`heyagent-waits`）：
   - `pending.state` 是 `asked` 且已批准 → **先在库里把 `state` 改成 `executing` 并提交**，再执行：
     ```ts
     const r = await ctx.tools.execute({
       calls: [{ /* 原调用：id = dshCallId、name、参数（原样 JSON） */ }],
       agent, signal,
     })
     ```
     `ToolBatchInput` 有 `agent` 没有 `log` 时，工具在这个 Agent 的作用域里执行，但不往会话日志写调用 / 结果事件 [源码 `core/tools/src/executor.ts:19-47`]。它照样过 `pre-execute` / `post-execute`：闸门认出这次调用在「已批准」名单里，跳过已批准的那几条规则，其他规则照常（和今天 `approvedRuleIds` 一样）。`ToolCallBlock` 的确切字段名动手前对一下 [未核实]。
   - 执行完：一个事务里写我们的 `tool` 事件（标「审批通过后执行」）、`pending.state = 'done'`、结果全文存文件。再 `agent.followup()` 一条消息：「【审批通过】刚才等审批的 <工具> 已经执行，结果：<截断后的结果>。同一步里后面那几个调用没有执行，需要的话自己再调。」带上 `inboxId` 防重复。
   - `state` 已经是 `executing`（上次执行到一半 worker 没了）→ **不再执行**，followup：「上次批准的 <工具> 执行到一半 worker 重启了，不确定执行没有。先检查结果再决定要不要重做。」——和今天一样。
   - 被拒绝 → followup：「<工具> 被拒绝了：<理由>。不要换个办法绕过去。」
6. **固化脚本里的审批**（第 13 节）走同一套，只是 `pending.routineStep` 有值，批准后从头重跑脚本、按 `routine_journal` 重放。

和今天的两处差别（第 21 节第 2 条请用户定）：

- 今天被批的调用的结果就是那次调用的工具结果；新做法里 dsh 日志的那次调用结果是「等审批」，批准后的结果是一条后来的用户消息。原因：dsh 不允许改写已记录的事件，工具前的瀑布也不允许改参数 [文档 tools.md「Arguments cannot be rewritten…」]。
- 今天同一步里被审批挡住的后续调用，批准后系统会接着执行；新做法里不自动执行，告诉模型自己决定。原因：这些调用不在一次打开的轮次里，系统替模型执行一串没批过的调用反而更难解释。

### 6.3 `session_waits.pending` 的新结构

```ts
type PendingApproval = {
  dshCallId: string        // dsh 的工具调用 id
  toolName: string         // dsh 工具名（下划线）
  toolId: string           // 我们的工具 id（点）
  args: unknown            // 原参数（库里存原文，接口只给掩码）
  ruleIds: string[]        // 这次要批的规则
  routineStep?: number     // 固化脚本里的第几步
  decision?: 'approved' | 'rejected'
  note?: string
  state: 'asked' | 'executing' | 'done'
  resultFileId?: string
}
```

### 6.4 人接手（验证码、登录页、桌面 `ask_human`）

- 流程和今天一样：截图存文件 → `human_items(kind = 'login')` 给任务负责人 → 挂起 `needs_human` → 人在远程画面里处理 → 点「已处理好了」→ `resumeInTx`。
- **Chrome 不再留在原 worker 的内存里**：提供方 `close()` 时告诉 browser-host「保留给 R-…，`browser.humanHoldMinutes` 分钟」，Chrome 在 browser-host 里 `held`。任何 worker 恢复时，提供方 `open()` 向 browser-host 认领这个保留的实例，接着用。这是把浏览器池拆出去的主要收益（11.3）。
- 桌面本来就是库里的租约（`desktop_leases.held`），任何 worker 都能接，不变。

---

## 7. 跨进程控制

dsh 的控制方法（`agent.cancel`、`steer`、`followup`）只在持有 Agent 的那个进程里有用，没有跨进程通道 [源码笔记 dsh-core 6.2 B1]。我们这样补：

| 控制 | api 做什么 | 有 worker 持有时 | 没人持有时 |
|---|---|---|---|
| 停止 / 取消 | 照旧改 `sessions.status`（`cancelSessionInTx`）+ `NOTIFY heyagent_run_control '<运行 id>'` | 停止监视收到通知（或每秒轮询）→ `agent.cancel({ kind: 'user' })` | 下次领到时状态不是 running，直接 skipped |
| 回答 `ask.human` / 处理事项 / 审批结果 | 照旧 `resolveHumanItemImpl` → `resumeInTx` | 不会有：等人时运行已经挂起、没人持有 | `run_inbox` + 发任务，worker 恢复时读 |
| 插话（运行中给 agent 补一句） | 新：tRPC `engine.steer`（第 2 阶段，前端以后加）→ 写 `run_inbox(kind = 'steer')` + NOTIFY | 收到通知 → `agent.steer(msg)`（下个步骤边界插入）[源码笔记 2.3] → 标消费 | 下次恢复时作为 followup 交付 |
| 立即继续、改上限 | 照旧（`resumeNowImpl`、`sessionPatch`） | — | — |

- 每个 worker 开一条专用连接 `LISTEN heyagent_run_control`，载荷只有运行 id；收到后只对自己内存里持有的运行动作。
- 「谁持有」不用告诉 api：`dsh_sessions.owner_id` 只用于排查和管理页显示。
- 通知丢了不要紧：停止有每秒轮询兜底；插话没被及时处理，最晚在下次恢复时交付。

---

## 8. 模型层

### 8.1 分两条路

1. **agent 循环的调用**：经 dsh 的 `ctx.llm`，由我们的适配器 `heyagent-llm` 处理。
2. **结构化的一次性调用**（规则翻译、复核、三方验收、比物、总结、固化员、`ha.judge`、导入读包、助手）：**不经 dsh**，照旧直接用我们的模型层（`S/engine/model.ts callStructured`、`S/engine/structured.ts`）。原因：dsh 的 `GenerateOptions` 没有 `response_format` / json_schema 字段 [源码 grep，笔记 capabilities 4.1]，结构化输出只能用「假工具」的办法；我们已经有的 `supports_json_schema` 开关、`schemaInPrompt`、`extractJson`、`lenientEnum`、`callStructuredWithFix` 全部原样保留。

两条路共用同一份「解析模型服务 → 建 AI SDK 模型对象 → 算花费」的代码。

### 8.2 适配器 `heyagent-llm`

实现 `LlmAdapter`（`dsh:packages/llm/llm/src/index.ts:208-300`）[源码]：

- `stream(options: GenerateOptions)`：
  1. 按 `options.model`（我们的模型 id `<providerId>/<name>`）从库里取模型服务、解密 key（`S/engine/model.ts` 的解析逻辑）；
  2. 把 dsh 的 `RequestMessage[]` / `system` / `tools: ToolSchema[]` 转成 AI SDK 的 `ModelMessage[]` 和不带 `execute` 的工具；
  3. `streamText({ model, system, messages, tools, maxRetries: 0, abortSignal, providerOptions })`，**只要一步**；
  4. 把 `fullStream` 转成 dsh 的 `StreamChunk`：`block-start / delta / block-end`（文字、推理、工具调用；工具参数保持原始 JSON 字符串），然后 `usage`，最后 `finish`。空回复报 `EMPTY_RESPONSE`，超上下文报 `CONTEXT_WINDOW_EXCEEDED`；要有流空闲看门狗（默认 5 分钟）[文档 llm-streaming.md]。
- `listModels` / `resolveModel`：从 `models` 表给上下文窗口（`context_k`）、默认最大输出、是否支持图片（`vision`）。
- `providerRetryPolicy`：返回 `ResolvedRetryPolicy`（`mode`、`maxRetries`、`retryableCodes`、`backoff`）[源码 `llm/llm/src/retry-policy.ts`]，设成 3 次、2 秒起翻倍，对上今天的 `callWithRetry`。
- 注册：`ctx.llm.registerAdapter(['heyagent'], adapter)`。所有运行的 `agentOptions.provider` 都是 `heyagent`。
- 每次选模型：开始时 `agentOptions.model`；以后要换（一般不换）用 `agent.model.select()`，会写进日志 [源码笔记 capabilities 4.3]。

今天由 `generateText` 一次拿完整结果，换成 `streamText` 逐块转发是唯一的行为变化，速度要在第 0 步第 4 项和第 3 阶段重测。

### 8.3 要保留的坑（逐条写进适配器的测试）

| 坑 | 在哪处理 | 现有代码 |
|---|---|---|
| 不传 temperature / top_p | 适配器忽略 `options.temperature`（dsh 自己的 auto-review 会传 0，我们不挂它） | `model.ts` |
| Anthropic：顶层 `cache_control` 自动缓存、新 Claude 服务端拒答兜底 `fallbacks`、历史里 thinking 块对不上时 `drop_block` | `providerOptions`；转换历史时处理推理块。dsh 的推理块里能不能带回签名之类的厂商数据 [未核实] | `model.ts` |
| OpenAI Responses `store: false` | `providerOptions` | `model.ts` |
| OpenRouter `:batch` / `:free` 后缀、`usage.cost` | 模型 id 解析、花费 | `model.ts`、`docs/dev/compare.md` 记的坑 |
| custom 服务 `supports_json_schema` | 只影响结构化调用那条路，循环不受影响 | `structured.ts` |
| DeepSeek 速度 | 第 0 步、第 3 阶段重跑测试任务 A/B/C | `docs/dev/browser-speed.md` |
| 图片 | dsh 的 `image` 块带 `ImageAttachmentRef`，适配器从 `ctx.attachments.readImage` 取字节转成 AI SDK 的 file part | `loop.ts` 追加图片消息那段 |

`attributionHeaders()` 只有一个 `user-agent` [源码 `llm/llm/src/attribution.ts:64`]，我们不调它，用自己的 UA。

### 8.4 花费

- dsh 的 `TokenUsage` 只有 token 数，没有钱 [源码笔记 capabilities 4.1]；pi-ai 的价格也被它故意清零 [源码 `llm-pi-ai/src/catalog.ts:35`]。
- 适配器每次调用算好花费（OpenRouter 用返回的 `usage.cost`，直连按 `models.price_*` 估、缓存打折，照 `model.ts`），通过进程内事件 `heyagent/llm-cost`（`sessionId`、`costUsd`、usage）交给 `heyagent-record`。`GenerateOptions` 带 `sessionId` [源码]。记录插件在写对应 `assistant/message` 的那个事务里累加到 `sessions.cost_usd`。被停时「回复不记、钱照记」：中途取消的调用没有 `assistant/message`，花费单独写一条 `think` 事件。

### 8.5 pi-ai

可选。`llm-pi-ai` 支持 OpenAI 兼容和 OpenRouter [源码]，但我们不需要两个适配器。组合文件里不挂；以后真想试，加一行、路由名用别的（例如 `pi`），按任务切。

---

## 9. 工具、技能、记忆、规则

### 9.1 工具在哪注册

全部在 `setup(agentCtx)` 里按快照注册到 `agentCtx.tools`（只对这个 Agent 可见，Agent 没了自动注销）[源码 `core/agent/src/runtime-types.ts:203`]。**不用 `tools.restrict`**：它的允许名单只能写全局注册过的工具 [源码 `core/tools/src/index.ts:162`]，我们每个运行的工具本来就不同，直接只注册该有的。

工具名：dsh / 模型那边用下划线（`browser_click`），我们的 id 用点（`browser.click`），对照表从快照生成，闸门、记录、规则都用它换算（今天网关已经这么做）。

| 工具 | 怎么注册 | 现有代码 |
|---|---|---|
| 内置（`checkpoint.mark`、`session.wait`、`ask.human`、`plan.set`、`run.finish`、`skill.load`→见 9.3、`memory.propose`、`skill.propose`、`notify.staff`、`file.*`、`work.*`、`subagent.*`） | 原生 `ToolDefinition`：`parameters` 用快照里的 JSON Schema，`execute` 里先 zod 校验参数，`output.schema: {}`，`output.render` 返回文字 | `tools/builtin-defs.ts`、`builtin.ts` |
| HTTP 工具 | 同上；执行时解密 `{{名字}}`，30 秒超时（`timeoutMs: 30000`，由 timeout-policy 执行） | `tools/http.ts` |
| 用户配置的 MCP | 每个服务器在 Agent 作用域里挂一个 dsh `mcp-client`：`const scope = createScope(ctx, agent); await scope.ctx.plugin(McpClient, McpClient.Config({ transport, serverName, command/args/env 或 url/headers, failOnStartupError: false, reconnect: { enabled: false } }))`（参照 `dsh:packages/experimental/browser-use-runtime/src/mcp.ts:131-157`）[源码]。环境变量 / 请求头在这里解密传入。任务只选了其中几个工具 → `scope.ctx.tools.restrict({ deny: [没选的] })`（browser-use-runtime 就是这样藏工具的）[源码]；对作用域自己注册的工具是否生效 [未核实] | `tools/mcp.ts` |
| 图库组、比物组 | 原生 `ToolDefinition`，体里调现有 service | `S/gallery/tools.ts`、`S/compare/tools.ts` |
| 浏览器组、桌面组 | 提供方插件注册（第 11、12 节） | — |
| 库流程 `routine.<短名>` | 原生 `ToolDefinition`，体里调第 13 节的运行器 | `S/routine/library/tool.ts` |
| `code.run` | `heyagent-sandbox` 注册 | `S/sandbox/code-run.ts` |

注意：dsh 保留了工具名 `run_code` [源码]，我们的 `code.run` 在模型那边叫 `code_run`，不冲突。

### 9.2 系统提示

- 规矩不变：**只由快照拼，整个运行不变**（为 prompt caching）。
- 用 `agentCtx.systemPrompt.section({ name, order, text })` 分节注册：任务、交付物、派来的活、步骤、检查点清单、记忆（必须遵守 / 可能相关）、任务记忆、规则说明、工具说明、可以派活给、浏览器、桌面、附件、空间文件、运行代码、子 agent 说明、怎么工作。文字照搬 `S/engine/prompt.ts` 的各段。
- 关掉 dsh 自己加的身份和运行时上下文（3.3 的配置）。MCP 服务器的说明会作为作用域分节加进来 [源码笔记 capabilities 2]，这和今天不同；要不要留，第 1 阶段看一下实际提示词再定。
- 加一个测试：同一份快照，新旧两边拼出的系统提示逐字相同（允许 MCP 说明那一段例外）。
- **会变的东西放消息里**，照旧。检查点的完成情况改用 `agentCtx.systemPrompt.context({ name: 'heyagent:checkpoints', text })`：dsh 只在内容变了的时候把它作为一条用户角色快照记进日志，不破坏前缀缓存 [文档 system-prompt.md]。这样压缩把早先的 `checkpoint.mark` 结果摘要掉以后，模型还看得到当前清单。

### 9.3 技能

- `agentCtx.skills.registerProvider(() => provider)`，`provider.list()` 返回快照里的技能（名字、一句话说明、`invocation: { modelInvocable: true, userInvocable: false }`、`locator = skillId`），`get()` 返回快照里冻结的正文 [源码 `skill/skill/src/index.ts:390,439`]。**从快照读，不从库里读**（快照冻结的是开始那一刻库里的版本，不变式 2）。偏离第 9 条的字面说法，意思一样。
- 技能目录由 `tool-skill` 在第一次 pre-step 注入成一条 `<system-reminder>`，模型用 `skill({ name })` 读全文 [源码 `tool-skill/src/index.ts:181,217,263`]。这替代今天系统提示里的「技能目录」一节和 `skill.load` 工具。名字要 kebab-case [文档]：快照生成时转换，原名放说明里。
- `skill.propose` 不变。

### 9.4 记忆

- 手选 + 自动挑选的记忆在快照里，进系统提示分节（9.2）。
- 自动挑选（pgvector）照旧在 5.2 做，`S/memory/retrieval.ts` 不变。
- `memory.propose` 不变。

### 9.5 规则和闸门：`heyagent-gate`

挂在每个 Agent 的作用域上（`agentCtx.on('tools/pre-execute', …)`、`agentCtx.on('tools/post-execute', …)`、`agentCtx.on('tools/result', …)`），只看这个 Agent 的调用 [源码 events.ts]。顺序照搬 `S/engine/gateway.ts call()`：

**工具前（`tools/pre-execute`）：**

1. 本 Agent 有挂起请求 → `deny`「没执行」（5.6）。
2. 工具在本运行的范围里（按快照）→ 不在就 `deny`。
3. zod 参数校验（`defineTool` 之外的原生工具，注册表不校验参数 [源码 `core/tools/src/index.ts:128-141`]）→ 不合格 `deny` 并带错处。
4. 规则 `before_tool` / `url_not_allowed`：`deny`（理由给 agent，「不要换个办法绕过去」）或 `ask_human`（6.2）。
5. 命中都写 `rule` 事件。

**工具后（`tools/post-execute`）：** 隐藏密钥原文、超长截断（`toolOutputMaxChars` 8000，全文存文件），返回 `{ kind: 'accept', content }`；规则 `after_tool` 的拦截用 `block`。

**观察（`tools/result`）：** `sync_checkpoint`（访问记录、外发原文、文件链接，标 `synced`）、`screenshot`、`notify`、`page_needs_human` 信号（由浏览器工具体先判定，这里只加规则动作）。

**有没有规则改写工具参数？** 逐条看了现在的动作：`deny`、`ask_human`、`screenshot`、`notify`、`sync_checkpoint`、`verify`，都不改参数（`SH/rules.ts`、`S/engine/rules.ts`）。dsh 不允许改参数 [文档]，对规则没有影响。但网关里有几处「执行时改参数」，都改成在工具体里做：

| 现在的做法 | 新做法 |
|---|---|
| HTTP 工具、MCP 环境变量里的 `{{名字}}` 执行时解密替换 | 本来就在工具体 / 挂载时做，不变 |
| 自动登录的 `{{username}}` / `{{password}}` 只在调用里替换 | 在登录工具体里替换（browser-host，11.2） |
| `desktop.snapshot` 没开「允许看画面」时强制 `use_vision: false` | 我们自己注册桌面工具（12.2），模型看到的 schema 里不放 `use_vision`，工具体按快照的开关填 |
| `browser.batch` 在网关里展开成逐步调用 | 工具体里逐步 `ctx.tools.execute({ calls: [一步], agent, signal })`，每步照样过闸门 [源码：有 agent 时在作用域里执行]；第一步要挂起 / 审批就停在它前面 |

### 9.6 压缩

推荐换成 dsh 的（偏离风险见第 21 节第 3 条）：

- `compaction-basic`：`thresholdRatio` 设成 0.6（今天是「模型上下文 60%」）、`summarizationProvider: heyagent`、`summarizationModel` = 「规划」默认模型 [文档 config-catalog]。
- `compaction-tool-result-pruner`：先裁旧的大工具输出（今天也是先换大块工具输出）。
- `compaction-image-offload`：丢旧图片。
- 我们原来的保护（检查点、问人、计划、挂起类结果原文保留）dsh 没有。用 9.2 的动态检查点上下文补「检查点状态」，其余靠第 1 阶段对比真实长任务后再定。
- 删 `S/engine/compact.ts`。

---

## 10. 子 agent 和派活

### 10.1 子运行：保留我们的语义，不用 dsh 的子 agent

dsh 的子 agent 在同一个进程里，父离线时收不到结果（「does not restore an offline parent」），名额满了直接拒绝不排队 [文档 subagent README:170，笔记 capabilities 7]。我们的语义是：子运行是独立的运行行 `<父>.<n>`、走队列、父挂起或在别的 worker 也能收到结果。所以：

- 不挂 `dsh-subagent`、`tool-subagent`、`tool-subagent-control`、`agent-team`。
- `heyagent-subagents` 注册 `subagent.start` / `subagent.wait` / `subagent.cancel` 三个工具，工具体调现有 service（`S/engine/subagents/start.ts`、`results.ts`、`settle.ts`）：
  - `start`：从父快照派生子快照（`SH deriveSubSnapshot`），建 `<父>.<n>`、`engine` 跟父一样，先挂起排队等 `subagent.queue:<父>`，由 `subagent.pump` 放行。和今天一模一样。
  - `wait`：工具体返回挂起意图（等 `subagent.all / any:<父>`）并结束本轮（5.6）。
  - 子运行结束时 `afterRunEndedInTx` 叫醒父（不变）。
- 子运行在 dsh 那边就是一个普通会话，`SessionHeader.parentSession` 可以填父 id 方便排查，但我们不靠它。
- 名额、只一层、子运行不复核不问人不通知、父结束子跟着停、花费合计：全部是现有代码，不变。
- 子运行用自己的 Chrome（`docs/dev/sub-agents.md` 5.4），所以 dsh「资源按活的 Agent 归属」对我们正合适：一个运行 = 一个 Agent = 一个资源（11.3）。

### 10.2 派活

- 派活的核心全在库和队列里（`S/engine/dispatch/*`：领单 advisory lock + skip locked、名额、去重键、结算、清扫、每日花费），和 agent 循环无关，**原样保留**。
- `heyagent-dispatch` 只注册三个工具 `work.dispatch`、`work.list`、`work.report`，工具体调现有函数（`dispatch/agent-tools.ts`）。等结果 / 等名额照 5.6 写挂起意图。
- `work.pump`、`work.sweep`、`work.notify` 这些队列处理函数迁移期留在旧 worker，最后一步挂进新 worker 的 `heyagent-jobs`（3.3）。

### 10.3 定时、待办、外部事件

pg-boss cron（`task.cron`、`todo.cron`）、`todo.fire`、`POST /api/events` 全部不变。不用 dsh 的 `schedule`：它单进程计时、两个进程会重复触发、崩溃可能重复投递 [文档 schedule.md，笔记 capabilities 8.2]。

---

## 11. 浏览器

### 11.1 推荐：把浏览器池拆成独立的 browser-host 进程

**问题。**

1. 今天等人处理时保留的 Chrome 在原 worker 进程的内存里（`BrowserManager.forSession`），只有回到同一个 worker 才能接着用（`docs/dev/desktop.md` 第 0 节）。
2. 新架构里 worker 挂起就 dispose Agent；dsh 的资源（`SessionResources`）按活的 Agent 对象归属，Agent 一没，资源就关 [源码 `browser-use-runtime/src/index.ts`，笔记 browser 1.2]。Chrome 放在 worker 里，等人处理时根本留不住。

**拆分后：**

| 放在 browser-host（长寿命、跟着 Chrome 走） | 放在 worker 的 `heyagent-browser` 提供方（跟着 Agent 走） |
|---|---|
| `manager.ts` 池、上限、排队；`instance.ts` Xvfb + Chrome；`chrome.ts`；`gost.ts` 代理 | `SessionResources<RunBrowser>`：`open(agent)` 向 browser-host 认领 / 申请实例，拿到 tap 地址；`close()` 告诉它关掉或保留 |
| 编排用的那条 Playwright CDP 连接：登录态装载和三方合并写回（`vault.ts`）、主文档导航白名单拦截、账号租约检查（`leases.ts` 的导航那部分）、对话框监视、下载（`downloads.ts`）、网络日志（`network-log.ts`） | Playwright MCP 0.0.83（stdio 子进程，`--cdp-endpoint <browser-host 的 tap 地址>`，参数照 `mcp.ts`） |
| `cdp-tap.ts`（知道 agent 的光标和活动标签页）、`viewer.ts` 远程画面 | 我们的工具和每次调用的处理：导航检查、遮挡重试、页面扫一遍、截图存档、验证码/登录检测、页面概况、录代码 trace、计时（`tools.ts`、`page-brief.ts`、`detect.ts`、`form-readback.ts`、`timing.ts`） |
| 等人处理时 `held` 的 Chrome；给人登录用的 Chrome（「打开 Chrome」）；自动登录小 agent（`auto-login.ts`，只在这里用 `{{password}}`） | 自有工具 `browser.extract / find / wait_any / fetch / look / copy_image / clipboard_*`：worker 自己再开一条到 tap 的 Playwright CDP 连接（`extract.ts`、`site-api.ts`、`clipboard.ts`）；验证码求解（`captcha.ts`，用视觉模型） |
| 控制口 3190（替代 worker 的控制口）：`POST /instances`（申请）、`/instances/:id/claim`、`/release`（关或保留）、`/agent-action`（当前工具名，给画面用）、`/browsers/login`、`/browsers/autologin`、`GET /instances/:id/view`（WS）、`/health` | — |

**为什么推荐：**

- 等人处理时的 Chrome 和任何 worker 都无关，任何 worker 都能接着用（满足不变式 6，去掉今天唯一的例外）。
- worker 侧的资源只是一条连接，Agent 没了关掉、恢复时再连，正好对上 dsh「资源跟着 Agent」的设计。
- api 的远程画面直接连 browser-host，不再经 worker。
- worker 镜像不用带 Chrome。

**代价：**

- 要新写 browser-host 的控制接口（约十个端点）和 worker 侧的客户端；今天 worker 里的直接函数调用变成本机 HTTP。
- 一个 Chrome 上同时有三条 CDP 客户端（browser-host 编排、worker 工具、Playwright MCP）。今天已经是两条，再加一条风险不大，但要在第 0 步第 4 项里验证 [未核实]。
- browser-host 要读库和 KEK（保险箱、代理密码），安全边界和今天的 worker 一样。

**备选：** 先把 Chrome 留在 worker（照搬，等人处理时保留的 Chrome 留不住，恢复后重开 Chrome、重新登录），等第 3 阶段再拆。不推荐，因为浏览器层本来就要整体移植一遍，拆两次更贵。

### 11.2 提供方插件 `heyagent-browser`（worker 侧）

照 Stagehand 提供方的写法 [源码 `browser-use-stagehand-native/src/index.ts`，笔记 browser 1.4]：

```ts
export const inject = ['browserUse', 'agents', 'tools', 'heyagentDb']
export function apply(ctx: Context) {
  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName('heyagent-browser'))
    const resources = new SessionResources<RunBrowser>(ctx, {
      label: 'heyagent-browser',
      exclusive: false,                    // 独占靠我们库里的租约，不靠 dsh
      open: (agent, signal) => openRunBrowser(agent, signal),   // 挑 Chrome 配置、租约、向 browser-host 申请或认领、起 MCP
    })
    yield () => resources.dispose()
  }, 'heyagent-browser')
}
```

- `SessionResources` 在 dsh 的 experimental 包里（197 行）。我们**抄一份**到 `S/dsh/browser/session-resources.ts`（保留 MIT 版权声明），不依赖 experimental 包。
- 懒启动：第一次调浏览器工具才 `resources.get(agent)`（Stagehand 也是懒的；`mountSessionMcp` 是建 Agent 时就起，起不来连 Agent 都建不了，不用它）[源码]。
- 调用串行：`resources.run(agent, exec.signal, op)` [源码]。
- 工具：`setup` 里按快照注册（`browser.use`、Playwright MCP 的那些、自有工具；`browser_run_code_unsafe` 不注册；evaluate、坐标工具、`look`、`fetch` 按快照的开关决定注册不注册）。MCP 工具列表照今天的办法缓存，所以注册时不用 Chrome 已经起来。
- 工具体里调 MCP 用我们自己的 MCP 客户端（今天 `S/browser/mcp.ts` 的做法），**不用 dsh `mcp-client`**：dsh 的 `mcp-client` 挂上就连、工具名固定 `mcp__<服务器>__<工具>`、按服务器列表注册，而我们要懒启动、自己的工具名、每次调用前后的处理。第 21 节第 6 条。
- 等 Chrome 配置 / 等账号：工具体返回挂起意图（`browser.profile:*`、`browser.lease:*`）并结束本轮（5.6）。
- 页面要人处理：截图 → 挂起意图（`needs_human`，带 `hold: true`）→ 提供方 `close()` 时让 browser-host 保留。
- 当前工具名推给 browser-host 的 `/agent-action`（画面上的「agent 在做什么」），在 `tools/execute` 包装里做。

### 11.3 其余照搬

整次运行只用一个 Chrome（`sessions.browser_profile_id`）、一个 Chrome 配置同一时间只给一个运行、账号租约 30 秒续租、URL 白名单由我们检查、代理挂了不直连、agent 拿不到完整 cookie、`browser_actions` 历史——全部原样，代码搬到上面两边之一。

---

## 12. 桌面

### 12.1 提供方插件 `heyagent-desktop`

- `ctx.computerUse.register(ComputerUseProviderName('heyagent-desktop'))` [源码，48 行的注册表]。手动登记的桌面和系统开的虚拟机放在同一个提供方后面（一个组合只能有一个桌面提供方 [源码]）。
- `SessionResources<DesktopConn>`（`exclusive: false`）：`open(agent)` 照 `S/desktop/leases.ts acquireDesktop`（new / mine / busy）占租约，`loadDesktopTarget` 解密 Bearer 密钥，连 Windows-MCP（streamable-http，带 `Authorization`）；`close()` 普通挂起放租约，`ask_human` 时改成 `held`。租约本来就只在库里，任何 worker 都能接。
- 工具：`setup` 里注册我们的 12 个白名单工具（schema 照 `SH/desktop.ts DESKTOP_MCP_TOOLS` 写死，所以不用连桌面就能注册）+ `desktop.use / look / send_file / fetch_file / ask_human`。危险工具（PowerShell、FileSystem、Registry、Process、`launch_executable`）不注册。
- 工具体里调 Windows-MCP：推荐照旧用 `@ai-sdk/mcp` 客户端（`S/desktop/client.ts connectDesktopMcp`），不用 dsh `mcp-client`。偏离第 12 条的字面说法，理由同 11.2：dsh `mcp-client` 会把服务器的全部工具以 `mcp__…` 名字注册给 Agent，而我们要固定白名单、写死的 schema、懒占用、改参数（`use_vision`、CJK 走 `/type`）。第 21 节第 6 条。
- `USER_CONTROL` 等状态的等待重试（`control.ts`）、非 ASCII 输入走桌面代理 `POST /type`、`look` 限 1920 宽：照搬。

### 12.2 虚拟机生命周期：`heyagent-desktop-vm`

- 服务插件（`ctx.desktopVm`），挂在 worker 里（要 Podman socket）。照搬 `S/desktop/vm/*`：Podman REST、`dockurr/windows` 按摘要钉版本、qcow2 写时复制、模板封存、端口、健康检查、存放位置 SSD/HDD、内存预留检查。
- pg-boss `desktop.vm`（stately，singletonKey = 桌面 id）+ 30 秒对账 + 5 秒开机健康检查：照旧，迁移最后一步从旧 worker 搬到新 worker。
- api 侧的 tRPC（`desktops.*` 改 `desired` / `op` + 审计）不变。

### 12.3 不动的

Python 桌面代理（`apps/desktop-agent`）、安装脚本、远程画面转发（api → 桌面代理 `/view`，`S/desktop/view-relay.ts`）都不动。

---

## 13. 固化流程和沙箱

### 13.1 运行器：dsh 的 `PtcRuntime` 接口，执行在我们的 bwrap 里

dsh 的 PTC 运行时（`ptc-runtime-node`）的沙箱只管文件，不管网络，整个 `/` 都能读 [源码 `sandbox-local/src/profiles.ts:17-20`：没有 `--unshare-net`]；而我们的规矩是固化脚本完全无网、只能经工具桥（不变式 14）。所以：

- `heyagent-routine` 写一个 `PtcRuntime` 子类（`@deepseek-ai/dsh-ptc-runtime`：`resolve(req) → spec`、`run(spec) → PtcRunResult`、`release(owner)`）[源码 `ptc-runtime/ptc-runtime/src/index.ts:105-169`]，注册成 `ctx.ptcRuntime`。
- `run()` 里照旧用 `S/sandbox/runner.ts` 起 bwrap：新的 user/PID/net/IPC/UTS 命名空间、只读 `/opt/sandbox-root`、`/workspace` 只读、512 MB、≤1000 次调用、默认 10 分钟；脚本 + `apps/server/sandbox-sdk/heyagent` 照旧；工具桥照旧是 unix socket `/tmp/.tools`（`S/routine/runtime/bridge.ts`）。
- 因为执行器是我们自己的，**已经审过的脚本形状不用改**（还是 `import ha from "heyagent"`）。如果换成 `ptc-runtime-node`，它的 per-call 模式是「异步函数体」，不认 import [文档]，旧脚本全要转。
- 绑定：`bindings: [{ global: 'ha', functions: { tool, commit, verified, log, fail, now, judge, routine } }]`。`tool(name, args)` 的实现：

```ts
const r = await ctx.tools.execute({ calls: [toCall(name, args)], agent, signal })   // 走同一条工具流程
await writeJournal(tx, { sessionId, seq, op: 'tool', tool, inputHash, reply, stop })  // routine_journal
```

  每一步过同一套闸门（规则、白名单、审批、验证码检测、过程记录）——今天网关的保证（不变式 10）由 dsh 的工具流程 + 我们的闸门继续保证。不带 `log`，所以过程记录由我们写（`session_events` 的 `trace.routineStep`），和今天一样。
- 运行时机：在 Agent 建好（工具已在作用域里）、交付第一条消息**之前**跑（5.4 第 4 步）。`ctx.tools.execute` 在轮次外也能用 [源码 executor.ts「including outside a turn」]。
- 结局照旧（`S/routine/runtime/run.ts`、`handoff.ts`）：跑通 → 报办成 → 规则 / 三方验收；`ha.fail` → 没办成；要审批 → 6.2（`pending.routineStep`），批准后从头重跑、按 journal 重放；要挂起 → 照常挂起；跑不通 → `buildHandoff` 写交接说明，作为第一条消息 `followup` 给同一个 Agent（同一个 Chrome）接着做。
- `ha.judge` 用结构化调用那条路（8.1），花费记进运行。

说实话，这里用 dsh 的 `PtcRuntime` 接口，换来的主要是形式统一（以后想让模型也写 `run_code` 脚本时接得上），执行和安全全是我们的。第 21 节第 8 条。

### 13.2 写脚本、试跑、审核、流程库

固化员（`routine/compile.ts`、`material.ts`、`checks.ts`）、试跑（`routine_test` 运行，`engine` 跟原任务）、人审、流程库（`routine/library/*`）全部是库 + 队列 + 结构化调用，**原样保留**。固化材料读 `session_events.trace`，新引擎的投影要把录下的定位代码、前后网址、网络请求范围原样写进 `trace`（11.2 的工具 `meta`）。

### 13.3 `code.run`

`heyagent-sandbox` 注册 `code_run` 工具，体里照旧调 `S/sandbox/code-run.ts`（bwrap + 每次一个出网代理、防 SSRF、返回访问过的主机）。带 `tools` 时经工具桥回到 `ctx.tools.execute`（同 13.1）。不用 dsh 的 `bash` / `sandbox`。理由同上：worker 里有 `DATABASE_URL` 和 KEK，代码绝不在 worker 进程里直接跑。

---

## 14. 接口、认证、前端

### 14.1 第 1 阶段：前端一行不改

- `heyagent-http` 插件里 `createApp({ db, auth, hub, keyring })`（`S/app.ts`，现有代码），用 `@hono/node-server` 的 `getRequestListener(app.fetch)` 得到 `(req, res)` 处理函数，注册成 webserver 的前缀路由：

```ts
for (const path of ['/api/trpc', '/api/auth', '/api/setup', '/api/health', '/api/files', '/api/imports',
                    '/api/gallery', '/api/compare', '/api/events', '/api/work-items', '/api/assistant']) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path, handler: listener }))
}
```

  webserver 先查精确路由、再按最长前缀匹配 [源码 `host/webserver/src/index.ts:654-661`]，所以 `/api/trpc` 比 `connection` 占的 `/api` 前缀优先。直接注册在 webserver 上的路由没有 dsh 的认证 [源码笔记 host 1.2]，正好：认证照旧由 better-auth cookie + `S/lib/api-auth.ts`（API 密钥）做，Origin 检查照旧。
- `AppRouter` 类型还是 `apps/server/src/trpc/router.ts` 导出，前端 `tsc` 照旧检查，不用造兼容类型。
- `live.onChange`（SSE）、助手 SSE（`/api/assistant/chat|apply`）、上传下载、表格预览都在 Hono 里，不变。SSE 经 webserver 原始路由会不会被缓冲 [未核实]，第 0 步顺手验证。
- **两个远程画面 WebSocket**：webserver 的升级路由只支持精确路径 [源码 `index.ts:455-465、597`]，`/api/browser/view/:id` 挂不上。打补丁 P-01：`registerUpgrade` 加 `kind: 'prefix'`（约 20 行）。不打补丁的办法是把地址改成 `/api/browser/view?id=…`，要改前端 `components/remote-view/use-remote-view.ts:40` 一处，违背「第一阶段前端不改」。
- 浏览器画面的转发目标从「worker 的控制口」改成「browser-host 的控制口」（按 `browser_instances.host_id`），鉴权（看 / 操作的权限）照旧在 `S/lib/ws-relay.ts`。
- Caddy 不用改：`/api/*` 照旧反代 3100。

### 14.2 新接口：Typert `@Remote`

以后新写的接口可以写成 `TypertRemoteService` 的 `@Remote` 方法 [源码笔记 host 2.1]，走 `/api/<ns>/<method>` 和 `/api/remote.mux`。要先做两件事：

1. Typert 代码生成要在 monorepo 里跑（`scripts/generate-typert.ts` 只从 dsh 的主机聚合入口出发）[文档]；我们的包在 dsh 仓库外，要用生成器的 package 模式 `writePackageArtifacts()` [文档，未试过]。
2. 前端要一个小客户端：一元调用是 `POST /api/<ns>/<method>` + JSON 信封，流是 `/api/remote.mux` 上的 JSON 帧 [源码笔记 host 2.3]。

第 1 阶段不需要，等第一次真要用时（例如插话、直接看 dsh 会话流）再做，连同 14.3。

### 14.3 认证：fork `client/connection`（第 2 阶段，补丁 P-02）

现状 [源码]：每个合法浏览器 cookie 都映射成同一个 `browserPeer`（principal `owner`）（`rpc-host.ts:94、129-138`）；精确 Fetch 路由对非 owner 一律 403，处理函数还拿不到 Peer（`rpc-host.ts:213-220`）；只有 owner 的流能回答瀑布（`api/gateway/src/index.ts:584`）；`admit()` 是写死的，`connection/request` 瀑布只能拒绝不能换身份（`client/connection/src/index.ts:143-158`）。

要改的文件：

| 文件 | 改什么 |
|---|---|
| `packages/client/connection/src/browser-auth.ts` | 去掉「启动令牌 `?token=` 换 HMAC cookie」；改成认 better-auth 的会话 cookie：查 `auth_sessions`（加 30 秒内存缓存，因为今天 `isAuthenticated` 是同步的）；`/connect?token=` 那条给 CLI 的路关掉 |
| `packages/client/connection/src/rpc-host.ts` | `admit()` 改成异步，按 userId 缓存每个用户一个 Peer：`createPeer({ principal: { kind: 'user', userId, role } })`；精确 Fetch 路由去掉 `principal.kind !== 'owner'` 的 403，改成每个路由自己声明 `access(peer)`，并把 `peer` 传给 `route.fetch(request, peer)` |
| `packages/client/connection/src/index.ts`、`rpc.ts` | `ConnectionFetchRoute` 类型加 `access`、`fetch` 加 `peer` 参数；配置里加 `authenticate` 钩子（由我们的插件提供），不再打印带令牌的地址 |
| 不改 `api/gateway/src/index.ts` | 瀑布只给 owner 回答：我们不用 dsh 的审批和提问 UI，保留原样，登记成已知限制 |

我们的插件 `heyagent-principal`：

```ts
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { user: { readonly kind: 'user'; readonly userId: string; readonly role: 'admin' | 'staff' } }
}
// 策略：主管全部允许；员工按 SH/permissions.ts 的 can() 判断（看全部、只操作自己负责的）
ctx.remoteAccess.registerPolicy('user', policy)   // 用户角色变了调 invalidate(principal)
```

principal 只能放 JSON、不能放凭据，会写进会话日志（`source.principal`）[文档]，所以只放 id 和角色。

### 14.4 前端以后要改的（不在第 1 阶段）

- 运行详情暂时还读 `session_events`。以后想要逐字流式显示模型输出，可以订 dsh 的 `session/follow` 流，自己渲染（dsh 的会话界面是 React 18 + 它自己的插件体系，不能拿来用，也违反只用 `buKEvLs` 的规矩）[源码笔记 host 4.4、5.2]。
- 插话按钮（第 7 节）。

---

## 15. 外发数据清单

### 15.1 dsh 里会往外发的，全部不挂

| 组件 | 发什么 | 默认 | 我们 |
|---|---|---|---|
| `session-log-deepseek` | 每次 DeepSeek 官方请求里带完整会话日志（≤8 MiB） | **开** [源码 Config] | 不挂 |
| `plugin-package-inventory-deepseek`、`deepseek-llm-api-extensions` | 插件包清单塞进请求 | 挂 | 不挂 |
| `session-telemetry-otel` + `otel` | 会话日志前缀发到 `dsh-otel-collector.deepseeksvc.com`，带匿名 id | 只在反馈时 | 不挂；`DSH_TELEMETRY_DISABLED` 只管这一行 [源码 `app-boot/src/profile-context.ts:39-52`]，不能当总开关 |
| `web-search-deepseek`、`web-deepseek-api`、`web` | 搜索请求发 DeepSeek | 挂 | 不挂 |
| `deepseek-account*`、`authorization` | DeepSeek 平台登录 | 挂 | 不挂 |
| `llm-deepseek*`、`agent-default-model` | 调 `api.deepseek.com` | 挂 | 不挂（DeepSeek 模型走我们的适配器 + 我们配的服务） |
| `session-title-llm` | 多一次模型调用起标题 | 挂 | 不挂 |
| `plugin-manager`、`plugin-market` | npm 源、CDN | 挂 / 实验 | 不挂 |
| `anonymous-user-id` | 写 `$DSH_HOME/.anonymous-user-id` | 懒 | 不挂（随遥测一起没了） |
| 桌面版产品统计、Electron 更新 | — | 只在桌面版 | 不用 |

来源：笔记 dsh-core 第 7 节 [源码]。

### 15.2 我们自己会往外发的（和今天一样，只列出来备查）

- 配置的模型服务（OpenRouter、Anthropic、OpenAI、DeepSeek、custom）：对话、结构化调用、embedding、`GET /models`、`GET /key`。
- 用户配置的 HTTP 工具、MCP 服务器。
- 浏览器经 gost 代理访问的网站；`code.run` 经出网代理访问的主机（只公网、限端口）。
- 通知渠道（飞书 / 企业微信 / 通用 webhook）。
- 构建时：npm 源、`cdn.sheetjs.com`（SheetJS）。运行时不连。

### 15.3 怎么证明

第 0 步第 3 项（18.2）：worker 容器的网络只通到一个记录日志的代理（复用我们的 `S/sandbox/proxy.ts` 改个记录版），进程启动时设全局 `EnvHttpProxyAgent`；绕过代理的连接直接连不上、会报错。跑一次真实运行，代理日志里只能有配置的模型服务地址。之后每次合并上游都重跑。

---

## 16. 对 dsh 核心的改动清单（`docs/dev/dsh-patches.md` 的初稿）

原则：能写成我们的包就不改核心；改了的每一处都登记：文件、为什么、上游有没有类似的 issue、合并上游时要看什么。

| 编号 | 文件 | 改什么 | 为什么 | 阶段 |
|---|---|---|---|---|
| P-01 | `packages/host/webserver/src/index.ts`（`registerUpgrade`、`upgrade` 分发约 597 行） | 升级路由支持 `kind: 'prefix'`，按最长前缀匹配（和 HTTP 路由一样） | 两个远程画面 WebSocket 的地址带 id | 第 1 阶段，必改 |
| P-02 | `packages/client/connection/src/browser-auth.ts`、`rpc-host.ts`、`index.ts`、`rpc.ts` | 见 14.3：可插拔的认证、每个用户一个 Peer、精确路由按路由声明权限并拿到 Peer、关掉启动令牌 | 多用户 | 第 2 阶段（第一次用 Typert 接口时） |
| P-03（候选） | `packages/core/agent-loop/src/agent.ts`（`preStep` 的 `reject` 分支，约 308、348 行） | 如果验证发现 `reject` 会丢掉已经取出来的收件箱消息，就改成放回收件箱 | 我们用 pre-step `reject` 结束轮次（5.5） | 第 0 步验证后定 [未核实] |

**不改的（明确写下来，免得以后有人去改）：**

- `known-event-types.ts`：我们不加自定义会话事件（4.4）。
- `session-persistence` 抽象类：我们实现它，不改它。
- 外发组件：不挂就行，不删代码（删了合并上游冲突多）。
- `SessionResources`：抄到我们的包里，不改原文件。

**合并上游的流程：** 在 fork 仓库的 `heyagent` 分支上合并上游 → 重新跑：会话存储契约测试、我们的引擎测试、外发检查（3.5、15.3）、P-01/P-02 的测试 → 再 `git subtree pull` 进 HeyAgent。

---

## 17. 仓库目录树

### 17.1 subtree，不用 submodule

推荐 **`git subtree add --prefix vendor/dsh <fork 仓库> heyagent --squash`**。理由：

- 克隆一次就全有，Podman 构建上下文、子 agent 的工作目录、CI 都不用记得 `submodule update`。
- 我们改 dsh 的地方和用到它的代码可以在同一个提交里审。
- `--squash` 只留一个合并提交，不把 dsh 的几千个提交带进我们的历史。

代价：仓库变大（dsh 约 52 万行 + 5000 多篇文档）。规定：**不在 HeyAgent 仓库里直接改 `vendor/dsh`**，改动先在 fork 仓库提交，再 `subtree pull`；CI 加一条检查：`vendor/dsh` 下的改动只能来自 subtree 合并提交。

### 17.2 pnpm 工作区

- dsh 的工作区有 overrides（`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery` 链到它自己的 `vendor/`）和 `allowBuilds` 名单 [源码 `pnpm-workspace.yaml`]。这些要搬进我们根目录的 `pnpm-workspace.yaml`，路径改成 `link:vendor/dsh/vendor/...`。
- **不要把 `vendor/dsh/packages/*/*` 全部加进工作区**：那样会装上所有包的依赖（Electron 之外还有 Playwright 浏览器、Stagehand、cua 等）。写一个脚本 `scripts/dsh-closure.ts`：从 3.3、3.4 的允许清单出发，顺着 `workspace:` 依赖算出闭包，把结果（具体目录列表）写进 `pnpm-workspace.yaml`；CI 检查列表是最新的。
- dsh 的包要先构建（`lib/index.js`）。构建命令用 dsh 自己的脚本，但只对闭包里的包跑（`pnpm --filter`）[构建细节未核实]。
- 版本：Node ≥24.9、pnpm 11.28.5、TypeScript 两边都是 6.x（dsh 允许 `>=5 <7`）[源码]；zod 两边的大版本是否一致 [未核实]。

### 17.3 目录

插件放在 `apps/server/src/dsh/` 下（第 15 条允许的「apps/server 下新目录」），理由：插件是薄的适配层，大量调用 `apps/server/src` 里现有的 service；放进单独的 `packages/dsh-*` 要么把这些 service 都搬成包，要么包反过来依赖 app，两样都不好。这也符合「同一份代码多个入口」（`docs/dev/conventions.md` 第 1 节）。

```text
HeyAgent/
├── vendor/dsh/                         git subtree（fork 仓库 heyagent 分支），只读
├── apps/
│   ├── web/                            不变
│   ├── desktop-agent/                  不变（Python）
│   └── server/
│       ├── dsh/                        组合文件（Loader YAML）
│       │   ├── heyagent-base.yml       两边共用的行
│       │   ├── heyagent-api.yml
│       │   ├── heyagent-worker.yml
│       │   └── allowlist.txt           允许挂的包名（测试比对）
│       ├── src/
│       │   ├── index.ts / worker.ts    旧入口（迁移期保留，第 6 阶段删 worker.ts、改 index.ts）
│       │   ├── dsh-api.ts              新：installFailLoud + boot('heyagent-api', …)
│       │   ├── dsh-worker.ts           新：boot('heyagent-worker', …)
│       │   ├── browser-host.ts         新：browser-host 进程入口（普通 Node）
│       │   ├── dsh/                    我们的 dsh 插件，一个目录一个插件
│       │   │   ├── pg/  credentials/  persistence/  attachments/
│       │   │   ├── llm/  record/  run/  context/  tools/  gate/
│       │   │   ├── waits/  finish/  subagents/  dispatch/
│       │   │   ├── browser/            worker 侧提供方 + session-resources.ts（抄自 dsh，带版权声明）
│       │   │   ├── desktop/  desktop-vm/  routine/  sandbox/  jobs/
│       │   │   └── http/  view-relay/  live/  background/  principal/
│       │   ├── browser-host/           从 browser/ 拆出来的池、实例、保险箱、画面、控制口
│       │   ├── browser/                worker 侧仍用的工具逻辑（tools.ts、page-brief.ts…）
│       │   ├── engine/                 现有引擎；loop.ts、gateway.ts、compact.ts、prompt.ts 第 6 阶段删，
│       │   │                           waits/humans/verify/review/outcome/run-ended/dispatch/subagents 留着给插件调
│       │   └── （其余 data/ trpc/ db/ files/ gallery/ compare/ imports/ assistant/ routine/ sandbox/ … 不变）
│       ├── drizzle/0039_dsh.sql…       新表和新列
│       └── test/dsh/                   新引擎的测试（连真 PostgreSQL，含 dsh 契约测试）
├── packages/shared/                    不变（加 engine 字段的 schema）
├── deploy/
│   ├── api.Containerfile               Node ≥24.9，入口改 dsh-api
│   ├── worker.Containerfile            去掉 Chrome/Xvfb/gost，入口改 dsh-worker
│   ├── browser-host.Containerfile      新
│   └── pod.yaml、Caddyfile、quadlet/   pod.yaml 多一个容器，其余不变
├── scripts/dsh-closure.ts              算 dsh 包闭包
└── docs/dev/
    ├── dsh-patches.md                  第 16 节
    └── dsh-engine.md                   新引擎的开发说明（本文定稿后拆过去）
```

---

## 18. 迁移：阶段、过关标准、工作量

### 18.1 两套引擎并存

- 同一个 Postgres；运行按 `sessions.engine` 走不同队列（5.1）：旧 worker 只领 `session.run`，新 worker 只领 `session.run.dsh`。
- 任务上的「用新引擎」开关（`tasks.engine`）由主管在任务设置里改（加一个小开关，用现有 `Switch` + `Field`，不算新 UI 能力）。只影响**以后新开的**运行；在跑和挂起的运行用开始时的引擎走完。
- 子运行、固化试跑跟原运行 / 原任务的引擎。
- 其他队列（导入、比物、虚拟机、固化、派活 pump/sweep、子运行 pump、cron、待办）在旧 worker 上一直跑到第 6 阶段，它们和引擎无关。
- 浏览器：旧引擎用旧 worker 里的 `BrowserManager`，新引擎用 browser-host。两边都按库里的租约和 `sessions.browser_profile_id` 避开同一个 Chrome 配置；Chrome 个数上限各算各的（并存期把两边的 `maxPerWorker` 调小）。
- api：第 1～4 阶段用旧 api 进程（`S/index.ts`），第 5 阶段才换成 dsh 主机进程。两边的接口代码是同一份。

### 18.2 阶段

**第 0 步：四项验证（约 1～1.5 周）。过不了任何一项就停。** 沿用评估第 9 节：

1. **会话存进 Postgres**：`heyagent-session-persistence` 跑通 `runPersistenceContract`（含 `reopen` 跨实例）和 `runLiveWritePathContract`；加我们的两条（两个进程抢写、租约过期后旧持有者写入被拒）。
2. **跨进程恢复**：进程 A 跑到一半（模型调用之间、工具执行中各一次）`kill -9`，进程 B `resume` 同一个会话跑完：dsh 日志连续、`session_events` 不丢不重、中断的工具补了「不确定」结果、`run_inbox` 消息只交付一次。顺带验证 pre-step `reject` 会不会丢收件箱消息（P-03）、自定义消息来源能不能通过读取校验（4.5）。
3. **外发全部关掉**：15.3 的办法，一次运行里只连配置的模型服务。`DSH_HOME` 跑完还是空的。
4. **一个真实浏览器任务**：最小 browser-host + 最小 `heyagent-browser`，跑 DeepSeek 测试任务 A。耗时和现在（约 124 秒）比，不能明显变慢（超过 20% 就停下来查）。顺带验证一个 Chrome 上三条 CDP 客户端、SSE 经 webserver 原始路由不缓冲。

**停止点 A**：四项都过，再决定进第 1 阶段。

**第 1 阶段：骨架（约 2～2.5 周）**
- 内容：subtree + 工作区闭包 + 组合文件；`heyagent-pg / credentials / persistence / attachments / llm / record / run / context / tools / gate`；`run_inbox`、新列、队列分流；内置工具、HTTP、MCP、图库、比物组；规则闸门；压缩接 dsh。
- 过关：一个不用浏览器的真实任务在新引擎上跑完，前端看到的运行详情和旧引擎同一任务的一样（事件种类、工具输入输出、用量、检查点）；系统提示逐字相同的测试过；`kill -9` 测试（任意时刻）全过；花费和 OpenRouter 后台对得上。

**第 2 阶段：等待和收尾（约 1.5～2.5 周）**
- 内容：`heyagent-waits / finish / subagents / dispatch`：全部 12 类等待、审批（6.2）、上限、模型失败转人工、只回文字提醒、三方验收、结果判定、复核、子运行、派活工具。
- 过关：把现有引擎测试里覆盖 28 条不变式的用例（`apps/server/test`）改成对新引擎也跑一遍，全过；挂起后换一个 worker 恢复的用例全过；审批「执行到一半崩了不重复执行」的用例过。

**第 3 阶段：浏览器和桌面（约 2～3 周）**
- 内容：browser-host 完整移植（池、保险箱、自动登录、验证码、剪贴板、下载、网络日志、画面、人接手、给人登录用的 Chrome）；`heyagent-browser` 全部工具；`heyagent-desktop`。
- 过关：测试任务 A/B/C 耗时不比现在（124 / 112 / 126 秒）明显慢；验证码交给人 → 换一个 worker 恢复 → 接着用保留的 Chrome；在线表格（剪贴板）用例；桌面手动登记和虚拟机各跑一个任务。

**第 4 阶段：固化和沙箱（约 1～1.5 周）**
- 内容：`heyagent-routine`（PtcRuntime + journal 重放）、`heyagent-sandbox`（`code.run`）、库流程工具。
- 过关：库里已经审过的每一版固化脚本在新引擎上跑一次（试跑模式），结果和原运行一致；审批后重放不重复做；沙箱逃逸 / SSRF 测试照旧全过。

**停止点 B**：到这里新引擎能跑所有功能。把新任务默认开关改成「新引擎」，旧任务逐个切换，观察至少一周真实运行。

**第 5 阶段：api 换成 dsh 主机进程（约 1～1.5 周）**
- 内容：`heyagent-http / view-relay / live / background`、补丁 P-01；api 镜像换入口。P-02（多用户 principal）按需。
- 过关：前端全部页面手动走一遍（浅色、暗色、窄屏）；远程画面两种、助手流式、上传下载、外部接口（`/api/events`、`/api/work-items`、`/api/gallery/mcp`）的现有测试全过。

**第 6 阶段：删旧引擎（约 0.5～1 周）**
- 内容：其他队列搬进 `heyagent-jobs`；等旧引擎的运行全部结束（见 18.3）；删 `S/worker.ts`、`engine/loop.ts`、`gateway.ts`、`compact.ts`、旧 `prompt.ts`、`browser/manager.ts` 等；`tasks.engine` / `sessions.engine` 列保留但只剩 `dsh`。
- 过关：旧 worker 容器从 pod 里去掉后，全量测试和第 3 阶段的速度测试再跑一遍。

### 18.3 旧数据

- **已结束的运行**：不转换。`session_events` 照旧显示；`session_messages` 只读保留（总结、固化材料读的是 `session_events`，不受影响）。
- **在跑的旧运行**：在旧引擎上跑完。
- **挂起很久的旧运行**（等商家回复几天、几周）：第 6 阶段前还没醒的，推荐「转换」：新建一个 dsh 会话（`ctx.agents.create` 的 `seed` 可以带事件 [源码笔记 2.2]），种子是一条用户消息：任务、之前做了什么（`log-text.ts` 的过程文字）、检查点状态、等的是什么；改 `sessions.engine = 'dsh'`。模型看不到原来逐条的工具调用，但看得到过程摘要。备选是一直保留旧 worker 直到它们结束。第 21 节第 4 条。
- 配置数据（任务、技能、规则…）不用迁。

### 18.4 工作量粗估

| 阶段 | 粗估 |
|---|---|
| 0 验证 | 1～1.5 周 |
| 1 骨架 | 2～2.5 周 |
| 2 等待和收尾 | 1.5～2.5 周 |
| 3 浏览器和桌面 | 2～3 周 |
| 4 固化和沙箱 | 1～1.5 周 |
| 5 api 换进程 | 1～1.5 周 |
| 6 删旧引擎 | 0.5～1 周 |
| **合计** | **约 9～13.5 周** |

比之前评估的 6～10 周多，原因：拆 browser-host、两套引擎并存期的分流和观察、连接层 fork、逐条不变式的回归。按「子 agent 写、主会话审」的节奏估；最大的变数是第 0 步第 2 项和第 3 阶段的速度。

### 18.5 28 条不变式落在哪

| 不变式（`heyagent-backend.md` 第 9 节） | 新架构里谁保证 |
|---|---|
| 1 平台通用 | 不变；grep 检查加上 `apps/server/src/dsh` |
| 2 快照冻结 | `setup` 只读快照（5.3）；技能来源读快照（9.3） |
| 3 系统提示不变、会变的放消息 | 9.2；检查点用 `systemPrompt.context` |
| 4 先落库再继续、只追加 | dsh 每次调模型前 flush（checkpoint-policy）；`dsh_session_events`、`session_events` 禁 UPDATE；审批先写 `executing`（6.2） |
| 5 进程随时可被杀 | 租约 + fencing（4.2）、`interruptedTurnClosers`、5.4 对账、journal 重放、30 分钟交接 |
| 6 挂起几天后任意 worker 继续 | 挂起即 dispose（5.9）；Chrome 在 browser-host（11.1） |
| 7 挂起一个事务、继续谁先到谁生效 | `suspendInTx` / `resumeInTx` 照搬；dsh 日志先落、业务事务可补（原则 2） |
| 8 状态和结果分开、结束顺序、统一入口 | 5.10 照搬 `finishRun` / `afterRunEndedInTx` |
| 9 业务写入和发任务同一事务 | `sendInTx` 照旧；`sendRunJob` 只是选队列 |
| 10 每个调用都过网关 | dsh 工具流程 + `heyagent-gate`；batch、固化、`code.run(tools)`、库流程都经 `ctx.tools.execute` |
| 11 规则只用确认过的、不退回模型判断 | 闸门只读快照里确认过的规则 |
| 12 密钥 | 执行时解密、post-execute 掩码；不经 dsh 凭据 |
| 13 浏览器安全 | browser-host + 提供方照搬；不注册 `browser_run_code_unsafe` |
| 14 代码只在 bwrap、出网只经代理 | 13.1、13.3；不用 dsh 沙箱 |
| 15 网页内容不可信、人审 | 不变 |
| 16 复核一定做 | 5.10 照搬 |
| 17 验收不同家族 | `verify.ts` 照搬 |
| 18 子 agent 规则 | 10.1 照搬 |
| 19 只回文字提醒一次 | `agent/turn-stopping` + `rule_state`（5.5） |
| 20 模型失败转人工 | `llm-retry` 用完 → 5.9 |
| 21 上限问人 | pre-step `reject` → 5.9 |
| 22 派活 | 10.2 照搬 |
| 23 停运行立刻生效 | 第 7 节：NOTIFY + 每秒轮询 → `agent.cancel` |
| 24 实时推送 | 触发器 + ChangeHub 不变；`session_events` 由投影写，照样触发 |
| 25 权限同一份 `can()` | Hono 路由照旧；Typert 用 remote-access 策略调 `can()`（14.3） |
| 26 定时上海时区、pg-boss cron | 不变 |
| 27 不传 temperature、缓存、`store:false`、thinking 丢弃 | 适配器（8.3） |
| 28 可读编号 | 会话 id = 运行 id（4.2） |

---

## 19. 风险

| 风险 | 影响 | 怎么减 |
|---|---|---|
| dsh 是 alpha、天天在提交，内部规矩多（生成的事件目录、README 检查、契约门禁） | 合并上游越来越贵 | 核心只改 2 处；允许清单 + 闭包让上游新包进不来；合并流程固定（第 16 节）；必要时停在一个上游版本不追 |
| 两份记录（dsh 日志、`session_events`）对不上 | 前端看到的和模型看到的不一致 | 同一事务写（4.2）；第 1 阶段加对账测试：从 dsh 日志重新投影一遍，和表里的一致 |
| 业务事务和 dsh 日志不在同一时刻提交 | 崩溃后状态不一致 | 原则 2：意图写进持久化的工具结果，恢复时补；每种意图都有 `kill -9` 用例 |
| 模型层从 `generateText` 换成流式 + dsh 消息格式转换 | 速度、各家的坑重新踩一遍 | 8.3 每条坑写成测试；第 0 步、第 3 阶段跑测试任务 A/B/C |
| 压缩换成 dsh 的 | 长任务里丢掉检查点、问人结果这些原文 | 动态检查点上下文；第 1 阶段挑最长的几个真实任务对比；不行就把 `compact.ts` 写成插件（第 21 节第 3 条） |
| 每个活 Agent 把整份日志放内存 | 长运行内存大 | 每 worker 4 个；挂起和 30 分钟交接都 dispose；监控 RSS |
| 一个 Chrome 上三条 CDP 客户端 | 偶发冲突（对话框、焦点、下载） | 第 0 步第 4 项验证；必要时 worker 侧的自有工具改成调 browser-host 的接口 |
| 租约过期（例如 GC 停顿超过 90 秒） | 运行被另一个 worker 接走 | fencing 保证不会两边都写成功；被接走的一方立刻 cancel；租约时长可调 |
| 两套引擎并存期 | 两个浏览器池、两套队列，排查复杂 | 并存期尽量短（停止点 B 之后一周起开始切）；管理页显示每个运行用的引擎 |
| 安全：dsh 没做过安全审计 | 我们负责 | 只挂必要的包；api 只绑 127.0.0.1；代码执行只在 bwrap |

---

## 20. 和用户已定 16 条的对照

| 条 | 本文怎么落的 | 有没有偏离 |
|---|---|---|
| 1 拓扑 | 第 1、2 节；另加 browser-host 进程 | 多一个进程（第 11 条要求评估，推荐拆） |
| 2 组合包 | 第 3 节 | 无 |
| 3 存储全在 Postgres | 第 4 节 | `storage` KV 后端暂不做（没有包要用），第 21 节第 7 条 |
| 4 一次运行 = 一个 dsh 会话、投影 | 4.4 选投影 | 无 |
| 5 挂起继续、审批替换 | 第 6 节 | 审批后的结果交付方式和后续调用有两处小变化，第 21 节第 2 条 |
| 6 跨进程控制 | 第 7 节 | 无 |
| 7 模型层 | 第 8 节 | 无 |
| 8 规则、检查点、复核 | 9.5、5.10 | 无（规则本来就不改参数） |
| 9 技能、记忆、HTTP、MCP | 第 9 节 | 技能从快照读（意思和「从库里读」一样，只是读开始时冻结的那份）；在 `setup` 里注册而不是 `agent/created` 监听（作用一样，`setup` 抛错能回滚） |
| 10 子 agent、派活 | 第 10 节 | 无 |
| 11 浏览器 | 第 11 节，推荐拆 browser-host | 浏览器的 MCP 用我们自己的客户端，第 21 节第 6 条 |
| 12 桌面 | 第 12 节 | Windows-MCP 推荐用我们自己的客户端而不是 dsh `mcp-client`，第 21 节第 6 条 |
| 13 固化 | 第 13 节 | `PtcRuntime` 是我们自己的实现，不用 `ptc-runtime-node`，第 21 节第 8 条 |
| 14 接口和前端 | 第 14 节 | 连接层 fork 推迟到第 2 阶段；WS 要打 P-01 |
| 15 仓库 | 第 17 节，subtree | 插件放 `apps/server/src/dsh/`，不建 `packages/dsh-*` |
| 16 迁移 | 第 18 节 | 无 |

---

## 21. 待用户定

**最需要拍板的 5 件：**

1. **把浏览器池拆成独立的 browser-host 进程。** 推荐拆（11.1）：等人处理时保留的 Chrome 不再绑死某个 worker，和 dsh「资源跟着 Agent」对得上。代价是多写一套本机控制接口、一个 Chrome 上多一条 CDP 连接、第 3 阶段多约 0.5～1 周。备选：先留在 worker，等人处理后恢复要重开 Chrome、重新登录。
2. **审批的两处小变化**（6.2）：①批准后的执行结果作为一条「【审批通过】…」消息交给模型，dsh 日志里那次调用本身记的是「等审批」；②同一步里被挡住的后续调用，批准后不再自动执行，告诉模型自己决定。原因是 dsh 不能改写已记录的结果、不能改参数。如果一定要保留②，可以把后续调用也存进 `pending`、批准后逐个执行，每个仍过闸门，多约 2 天。
3. **认证 / 连接层 fork 推迟。** 第 1 阶段前端的全部请求还走现有 Hono 路由（better-auth cookie），dsh 的 Typert 接口暂时没人用；`client/connection` 的多用户改造（P-02）等第一次真要写 `@Remote` 接口时再做。好处是第 1～5 阶段少改一块核心；坏处是这段时间 dsh 的 `/api/<ns>/…` 只是挂着不用。
4. **挂了很久的旧运行怎么办**（18.3）：推荐第 6 阶段把还没醒的转换成新会话（种子是一条过程摘要消息），模型看不到原来逐条的工具记录；备选是一直保留旧 worker 直到它们自然结束（可能拖几周）。
5. **压缩换成 dsh 的 `compaction-basic`**（9.6）还是把我们的 `compact.ts` 写成插件。推荐先用 dsh 的，第 1 阶段拿最长的真实任务对比；我们的做法（只换大块工具输出、保留检查点和问人原文、库里只标不删）在 dsh 里没有现成对应。

**其余：**

6. 浏览器和桌面里调 MCP，推荐用我们自己的客户端（在工具体里），只有用户配置的 MCP 服务器用 dsh `mcp-client`。理由：要懒启动、固定白名单、写死的 schema、我们自己的工具名、调用前后的处理（11.2、12.1）。
7. dsh `storage` 的 Postgres KV 后端：当前允许清单里没有包用它，推荐不做，等哪天要挂用它的包再做（约 2～3 天，有现成契约测试）。
8. 固化运行器：用 dsh 的 `PtcRuntime` 接口，执行是我们自己的 bwrap（13.1）。另一个办法是干脆不套这层接口，直接调我们的运行器，少一层；套上的好处只是以后接 `run_code` 方便。
9. 导入读包、自动登录、助手这几个「小 agent」第一阶段不搬进 dsh，照旧用我们的模型层。以后要不要搬，单独定。
10. 「模型调用失败 → 人点重试」：新引擎要先给 agent 发一条短消息（「上一步模型调用失败，现在重试」）才能再跑一步，今天是不加消息直接重调。影响很小，知会一下。
11. 浏览器画面上「agent 在做什么」的标签，由 worker 推给 browser-host；桌面画面照旧没有这个标签（今天也没有）。

---

## 22. 没核实的

动手前要先验证（大部分放进第 0 步）：

1. `agent/pre-step` 返回 `reject` 时，已经取出的收件箱消息是丢掉还是放回（5.5、P-03）。
2. 自定义消息来源 `{ kind: 'heyagent', inboxId }` 写进日志后，恢复时的读取校验会不会拒绝（4.5）。
3. `ctx.tools.execute` 用的 `ToolCallBlock` 的确切字段（`id`、`name`、参数是字符串还是对象）（6.2、13.1）。
4. webserver 原始路由上的 SSE（`live.onChange`、助手）会不会被 gzip 或缓冲；关 gzip 的配置值（3.4、14.1）。
5. `AttachmentStore` 全部抽象方法和文件类附件的接口（4.3）。
6. dsh 推理块能不能带回厂商数据（Anthropic thinking 签名），影响 `drop_block` 的处理（8.3）。
7. `restrict({ deny })` 对 `mcp-client` 在子作用域里注册的工具是否生效（9.1）。
8. Typert 生成器的 package 模式能不能给 dsh 仓库外的包生成代码（14.2）。
9. 只构建闭包里的 dsh 包需要哪些脚本和顺序；两边 zod 大版本是否一致（17.2）。
10. 一个 Chrome 上三条 CDP 客户端会不会互相干扰（11.1）。
11. `compaction-basic` 的 `thresholdRatio`、摘要模型等配置项的确切名字和行为，只看过文档（9.6）。
12. dsh 在一个进程里同时活着 4 个 Agent、每个几千条事件时的内存，没有数据（第 19 节）。
13. `boot()` 直接按配置文件启动、不用 profile 目录这条路，只看过 README，没在源码里走一遍（2.1）。
14. `streamText` 换掉 `generateText` 以后，测试任务 A/B/C 的速度。
