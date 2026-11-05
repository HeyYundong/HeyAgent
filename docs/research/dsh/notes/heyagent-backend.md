# HeyAgent 后端现状清单（给「全量换成 DeepSeek Harness fork」写目标架构用）

> 读的是 worktree `dsh-fork-assessment`（HEAD `9e1bf55`，= main `c99199d` + 一份调研文档）。只读代码和 `docs/dev/*`，没有跑。
> 路径都相对仓库根；`S/` = `apps/server/src/`，`SH/` = `packages/shared/src/`。browser/、desktop/ 的内部实现不展开，只写引擎怎么用它们。
> 已有的迁移评估在 `docs/research/dsh-fork-assessment.md`（结论是不建议全量 fork），本文只列现状，不重复结论。

---

## 1. 进程和部署

### 1.1 进程

| 进程 | 入口 | 做什么 | 端口 |
|---|---|---|---|
| **postgres** | 镜像 `docker.io/pgvector/pgvector:0.8.7-pg18-trixie` | 业务库 + pg-boss（schema `pgboss`）+ pgvector + LISTEN/NOTIFY | 5432，只绑 127.0.0.1 |
| **api** | `S/index.ts`（Hono + `@hono/node-server`） | 启动时依次：`bootstrap()` → `ChangeHub.start()`（LISTEN）→ `initEngineClient()`（**只发任务**的 pg-boss，借 drizzle 连接池，不跑 schedule/supervise）→ 后台补算 embedding 的两个循环（`gallery/background.ts`、`memory/embed.ts`）→ HTTP 服务 → 挂两个 WebSocket upgrade（浏览器 / 桌面远程画面）。**api 不跑 agent 循环** | 3100（`HOST=127.0.0.1`） |
| **worker** | `S/worker.ts` → `engine/worker-runtime.ts` 的 `startEngineWorker` | 完整 pg-boss（自己的池 max 5，跑 cron/维护/心跳检查），注册全部队列处理函数；`syncBuiltinTools`；清沙箱目录；建默认比对标准；起 `BrowserManager` + 内部控制接口；桌面租约巡查（30 s）、虚拟机对账（30 s）、开机健康检查（5 s）；把库里还标 `running` 且有快照的 session 全部重排 `session.run`；收回中途的比物 | 内部控制 3190（`HEYAGENT_BROWSER_CONTROL_PORT`，只绑 127.0.0.1，带令牌头） |
| **web** | `deploy/web.Containerfile` + `deploy/Caddyfile` | Caddy：`/api/*` 反代 127.0.0.1:3100（`flush_interval -1`，SSE 不缓冲）；其余静态文件（hash 路由，只有 index.html） | 8080（对外唯一入口） |
| desktop-agent（可选） | `apps/desktop-agent`（Python，约 2.3k 行） | 跑在 Windows 桌面上的代理（另一个 agent 负责），worker 经 `desktops.mcpUrl` / `agentUrl` 连 | — |

- 同一份代码两个入口（`docs/dev/conventions.md` 第 1 节）。worker 镜像多 Chrome、Xvfb、gost、bubblewrap、`/opt/sandbox-root`（独立 Debian + Python 3.12 + Node 24 + socat，`deploy/worker.Containerfile`）。worker `securityContext`：drop ALL，只加 `SYS_CHROOT`（Chrome sandbox 要；bwrap 前用 `setpriv` 清掉）。
- 部署：一个 Podman pod（`deploy/pod.yaml`，`shareProcessNamespace: true`），卷 `pgdata` / `files`（`/data/files`，`HEYAGENT_FILES_DIR`）/ `secrets`（KEK 文件 `/run/heyagent-secrets/kek`、OpenRouter key 文件）。服务器上用 Quadlet（`deploy/quadlet/heyagent.kube`），备份 `deploy/systemd/heyagent-backup.timer` + `scripts/backup.sh`。`scripts/pod.sh up|down|reset|logs|status`（down 先停 web/worker/api，再给 postgres 60 s 正常关机）。
- api 容器的 `deploy/api-entrypoint.sh`：等库能 `select 1` → 跑迁移（`S/db/migrate.ts`，drizzle）→ 可选灌演示数据（`HEYAGENT_SEED_DEMO=1`）→ 起 API。worker 等 `/api/health` 通过才起。
- 只用 Podman（3.4 没 compose/Quadlet），不用 Docker。时区一律 `Asia/Shanghai`（`SCHEDULE_TZ`）。

### 1.2 api ↔ worker 怎么通信

1. **pg-boss 12.38 队列**（同一个库）。所有「发任务」都可以在业务事务里发（`queue.ts` 的 `sendInTx` 用 `fromDrizzle(tx)`），和业务写入一起提交/回滚。完整列表（`S/engine/queue.ts` 的 `QUEUES`）：

| 队列 | 策略 | singletonKey | 处理函数 | 做什么 |
|---|---|---|---|---|
| `session.run` | stately | sessionId | `engine/loop.ts` `runSession` | 执行或继续一个 session。心跳 30 s、单任务最多 3600 s、retryLimit 50；`localConcurrency` 默认 4（`HEYAGENT_WORKER_CONCURRENCY`） |
| `session.wake` | standard | — | `waits.ts` `onWake` | 到点叫醒挂起的 session（`startAfter = resumeAt`） |
| `session.remind` | standard | — | `waits.ts` `onRemind` | 兜底期限到了，**只提醒**负责人 |
| `todo.fire` / `todo.remind` | standard | — | `schedule.ts` | 人加的待办到点触发 / 兜底提醒（任务里带当时的触发时间，改了时间旧任务自动作废） |
| `task.cron` / `todo.cron` | standard | （schedule key = 对象 id） | `schedule.ts` `onTaskCron` / `onTodoCron` | pg-boss 自带 cron；任务可设「上一次没跑完就跳过」 |
| `import.read` | stately | importId | `imports/reader.ts` `runImportRead` | 读导入包（解压、挪密钥、读包 agent、整理方案），最多 60 min |
| `compare.run` | stately | comparisonId | `compare/run.ts` `runComparison` | 一次视觉模型比对 |
| `work.pump` | stately | taskId | `dispatch/pump.ts` `pumpTask` | 给被派任务领单（按名额开运行）；先放行等名额的运行；撞每日花费上限时通知 |
| `work.sweep` | standard，cron `* * * * *` | — | `dispatch/sweep.ts` `sweepWork` | 每分钟清扫：补写漏掉的单结束、发到点的 pump、过时复核；末尾调子 agent 清扫 |
| `work.notify` | standard | — | `dispatch/notify.ts` | 单最终结束时叫醒等 `work.done:<单号>` 的运行 |
| `desktop.vm` | stately | desktopId | `desktop/vm/lifecycle.ts` `runVmJob` | 系统开的虚拟机往目标状态走一步 |
| `routine.compile` | stately | versionId | `routine/compile.ts` `handleCompileJob` | 固化：一版脚本往下走一步 |
| `routine.sweep` | standard，cron `*/5 * * * *` | — | `routine/sweep.ts` | 补发漏掉/丢掉的 `routine.compile` |
| `subagent.pump` | stately | `all` | `subagents/pump.ts` | 全系统按名额放行排队的子运行 |
| `subagent.notify` | stately | parentSessionId | `subagents/notify.ts` | 子运行结束后看要不要叫醒父运行 |

2. **LISTEN/NOTIFY**：迁移里给几乎所有业务表装了 `<table>_notify_change` 触发器（`drizzle/0001_triggers.sql` 起，约 40 张表），`NOTIFY heyagent_changes '{table,id}'`（`SH/live.ts` 的 `LIVE_CHANNEL`）。api 里 `S/live/hub.ts` 的 `ChangeHub` 一条专用连接 LISTEN，每条变化编号 `bootId:n`，内存保留最近 1000 条，前端断线重连带 `lastEventId` 补发；补不齐或重连后发 `{table:"*"}` 让前端全部重拉。**推送只是「哪张表哪行变了」，前端自己重新查 tRPC。** 向量表（`gallery_embeddings`、`memory_embeddings`）不推。
3. **api → worker 的同步 HTTP**：只有浏览器——api 按 `browser_workers.control_url` 找 worker 内部控制接口（`S/browser/control.ts`：`POST /browsers/login`、`/browsers/autologin`、`/browsers/:id/close`、`GET /health`），远程画面 WebSocket 由 api 转到 worker 里的 Chrome（`S/lib/ws-relay.ts`）。桌面画面转到桌面服务。
4. **跨进程停运行**：取消、父结束连带停子、清扫都在别的进程改 `sessions.status`；worker 里 `engine/stop-watch.ts` 每 `stopPollMs`（1 s）查一次在跑的运行，已结束就 abort 信号（正在调的模型、正在起的 Chrome 立刻停）。

### 1.3 实时 / 流式端点

| 端点 | 协议 | 用途 |
|---|---|---|
| tRPC `live.onChange` | SSE（tRPC subscription，`/api/trpc/*`，未登录 401） | 表变化推送（上面的 ChangeHub） |
| `POST /api/assistant/chat`、`POST /api/assistant/apply` | POST + `text/event-stream` | 右下角助手流式回答 / 处理确认卡（`S/assistant/routes.ts`） |
| `GET /api/browser/view/:browserId` | WebSocket | Chrome 远程画面（CDP screencast + 鼠标键盘），api → worker（`S/browser/view-relay.ts`） |
| `GET /api/desktop/view/:desktopId` | WebSocket | 桌面远程画面（`S/desktop/view-relay.ts`） |

WebSocket 校验 Origin（受信任来源）+ better-auth 会话；画面帧在客户端跟不上时丢（缓冲 > 1 MB 不转）。

---

## 2. 领域模型（64 张表 + pgboss）

`S/db/schema.ts`（1841 行），迁移 `apps/server/drizzle/0000…0038`（1428 行 SQL）。主键是可读文本 id（`T-1024`、`R-1024-1`、`W-57`…，规则在 `SH/ids.ts`，序列在 schema 里）。枚举值直接取 shared 的 zod schema。`session_events`、`session_messages` 有触发器**禁止 UPDATE**（只追加）。

### 2.1 账号、审计、通知（运行时/系统）

| 表 | 用途 / 关键列 |
|---|---|
| `users` | better-auth 用户 + admin 插件：`role`（`admin` = 主管，其余员工）、`banned*`、`title`（职位） |
| `auth_sessions` / `auth_accounts` / `auth_verifications` | better-auth 的登录会话、凭据（密码哈希在 `auth_accounts.password`）、验证码 |
| `api_keys` | 外部系统用的密钥，只存 sha256 + `hint`；做的事算在 `created_by_id` 头上 |
| `audit_events` | 只追加审计：`actor_id action target_table target_id detail` |
| `notifications` | 站内通知：`user_id title body link task_id session_id read_at` |

### 2.2 配置（人配的，运行开始时冻进快照）

| 表 | 用途 / 关键列 |
|---|---|
| `tasks` | 任务：`title goal steps(jsonb) deliverables(jsonb) owner_id enabled schedule_cron/schedule_text/next_run_at model_id browser_profile_ids allowed_domains allow_browser_evaluate/vision/fetch desktop_ids allow_desktop_vision verify_model_id review_model_id subagent_model_id dispatch(jsonb：params、results、maxRunning、allowApi、events、dailyBudgetUsd、autoRetries…) cron_skip_if_running routine_mode(off/first) auto_solidify routine_skip_test auto_memory auto_memory_limit` |
| `task_memories` / `task_skills` / `task_tools` / `task_rules` | 任务 ↔ 记忆 / 技能 / 工具 / 规则（`position` 保序，`taskLink` 生成） |
| `task_dispatch_sources` | 谁能派活给这个任务（`task_id` 被派、`source_task_id` 派活方） |
| `task_memory_entries` | 任务自己的经验（运行总结候选经人审后写入）：`content source_session_id` |
| `memories` | 全局记忆：`content(≤1000) applies_to status(active/pending/rejected/archived) source_kind(human/agent) source_* web_unverified evidence reviewer_id last_used_* embed_error embed_tried_at` |
| `memory_embeddings` | `(memory_id, model_id)` → `vector(1024)` + `content_hash`（md5(applies_to\n content)）；不建 HNSW，精确扫 |
| `skills` / `skill_versions` / `skill_tools` | 技能（SKILL.md 正文 `body`、`status` published/draft/disabled、`version`）、每版快照、技能要的工具 |
| `skill_suggestions` | agent 提的技能修改（`diff`，待审） |
| `rules` / `rule_tools` | 规则：自然语言 `trigger` `action` + 翻译结果 `compiled_trigger compiled_text compile_draft` + `confirmed_by_id/at`（**人确认后才生效**）；命中后调用的工具 |
| `tools` | 工具：`source`（builtin/mcp/http/routine）`risk`（read/write/external/money）`http`（模板 jsonb）`server_id` `always_on` `routine_id` |
| `mcp_servers` | MCP 服务器：`transport`（stdio/http）`command url env_keys status` |
| `secrets` | 信封加密密钥：`scope`（http_tool/mcp_env/model_provider/browser_proxy/browser_account/import/desktop）`ref_id name version enc(jsonb) masked`；唯一 `(scope, ref_id, name)` |
| `model_providers` | 模型服务：`kind`（ollama/openrouter/anthropic/openai/deepseek/custom）`base_url api_key_secret_id status supports_json_schema` |
| `models` | 模型目录：`provider_id name context_k price_in price_out vision kind manual`（id 形如 `openrouter/anthropic/claude-…`） |
| `model_defaults` | 各角色默认模型：`role` ∈ run / plan / verify / embed / assistant / review / solidify |
| `settings` | 全局键值（见第 5.6 节） |
| `platforms` | 网站（`domains`），浏览器账号按「平台 × 账号」管并发 |
| `browser_profiles` / `browser_accounts` / `browser_vaults` | Chrome 配置（代理、出口、时区语言）、登录过的平台账号（`max_concurrent probe_url status`）、加密登录态（`version` CAS，AAD 绑 `browser_vaults:id:version`） |
| `desktops` / `desktop_vms` | 桌面（手动登记的 / 系统开的 Windows 虚拟机：`state desired op storage_path …`） |
| `human_todos` | 人加的待办（任务的额外触发器）：`trigger_kind`（time/cron/event/time_or_event）`at cron next_at event fallback_days status` |
| `compare_standards` | 比对标准：`prompt pass_score model_id is_default` |
| `routine_library` / `routine_library_versions` | 流程库登记（`slug status published_version requires risk fail_streak`）、发布记录 |

### 2.3 运行时

| 表 | 用途 / 关键列 |
|---|---|
| `sessions` | 一次运行。`kind`（run / routine_test / sub）`status`（running / needs_human / waiting / verifying / done / incomplete(旧) / failed）`outcome`（只用 achieved / not_achieved）`outcome_reason outcome_by review(jsonb，含 pending)` `parent_session_id work_item_id triggered_by model_id` 用量 `tokens_in/out cost_usd step_count` 上限 `cost_limit_usd max_steps` **`snapshot`（冻结的任务配置）** `event_seq msg_seq`（序号计数器）`rule_state`（finishNudged、subagentNudged 等一次性标记）`browser_profile_id desktop_id`（整次运行只用这一个）`verification digest sub_result routine(jsonb，固化脚本状态)` `error explored_steps` |
| `session_messages` | 发给模型的完整消息历史（AI SDK `ModelMessage` 原样）：`(session_id, seq)` 只追加；压缩时原行标 `compacted`、`summary` 放压缩后内容 |
| `session_events` | 过程记录：`kind`（plan/think/tool/checkpoint/rule/wait/resume/human/verify/done/error）`title detail tool_id input output ms tokens trace(jsonb：录下的定位代码、前后网址、网络请求范围、routineStep/scriptStep/library…)`，只追加 |
| `checkpoints` / `checkpoint_records` | 每个运行的检查点（`kind` visit/message/count/artifact/confirm/note、`target status(done/open/skipped) skip_reason`）、记录（`synced` = 规则自动写的，agent 改不了） |
| `session_waits` | 等待：`what trigger_kind resume_at event match(jsonb) cron fallback_days deadline_at status(waiting/fired/cancelled) fired_cause human_item_id reminded_at pending(jsonb：等审批的工具调用 + decision + state executing/done)` |
| `human_items` | 要人办的事：`kind`（approval / verify / login / memory / skill / routine）`assignee_id task_id session_id rule_id memory_id skill_id routine_version_id urgency detail(jsonb，渲染用) status resolution` |
| `files` | 文件元数据（内容在文件卷 `storage_path`）：`session_id task_id kind`（upload/attachment/artifact/screenshot/…）`path`（session 空间路径，agent 写的文件可覆盖）`mime size` |
| `work_items` | 派活单：`task_id key(去重键) params status(queued/running/done/failed/cancelled) session_id attempts via(agent/human/api/event) priority from_* depth result error fail_kind outcome not_before auto_retries log` |
| `account_leases` / `desktop_leases` | 「平台 × 账号」租约、桌面占用（`expires_at` 续租、`hold_until`） |
| `browser_workers` / `browser_instances` / `browser_actions` | worker 心跳和控制地址、开着的 Chrome、浏览器操作历史（90 天） |
| `routines` / `routine_versions` / `routine_journal` | 固化流程（`active_version direct_streak fallback_streak status`）、每版脚本（`status` drafting/testing/review/failed/approved/rejected、`code input_schema output_schema commits test_report round …`）、**脚本工具桥的重放日志**（`session_id seq op tool input_hash reply stop instance_id`） |
| `routine_calls` | 库流程每次被调一行（`via depth result stop_* steps ms`） |
| `imports` | 导入记录：`status`（reading/review/imported/failed/undone）`read_log plan step result cost_usd` |
| `comparisons` | 比物记录：`file_a/b standard_* score confidence verdict reasons dimensions differences raw via session_id api_key_id dedupe_key` |
| `gallery_images` / `gallery_embeddings` | 图库（`text(jsonb) tags`，GIN）/ 向量（HNSW，每模型一行） |
| `assistant_chats` / `assistant_messages` / `assistant_proposals` | 助手对话（只本人可见）、消息（原样 ModelMessage）、改动确认卡（`calls changes status`） |

**配置 vs 运行时**：配置 = tasks（及 4 张关联表、dispatch_sources、task_memory_entries）、memories、skills、rules、tools、mcp_servers、secrets、model_providers/models/model_defaults、browser_profiles/accounts/vaults、platforms、desktops/desktop_vms、settings、users/api_keys、compare_standards、human_todos、routine_library；运行时 = sessions、session_messages、session_events、checkpoints(+records)、session_waits、human_items、files、work_items、leases、browser_instances/actions、routines/versions/journal/calls、imports、comparisons、gallery_*、assistant_*、notifications、audit_events。

**快照**（`SH/engine.ts` `sessionSnapshotSchema`，开始运行时由 `engine/sessions.ts` `buildSnapshot` 冻结）：task（id/title/goal/ownerId/steps/deliverables）、modelId、verify/review/subagent 模型、memories（手选 + 自动挑的带 auto 分数）、autoMemory 状态、taskMemory、skills（含正文和版本）、tools（含 http 模板）、rules（含 compiledTrigger）、checkpoints、attachments、note、source、dispatch（单号、参数、要交回的结果）、dispatchTargets、browser（允许的 Chrome、域名白名单、evaluate/vision/fetch 开关）、desktop、routine（先跑的那一版）、sub（子目标）、libraryRoutines。**任务以后再改不影响这次运行。**

---

## 3. 一次运行的生命周期

### 3.1 创建（全部在一个事务里：快照 + 插 session + 第一条消息 + 「运行开始」事件 + 发 `session.run` + 审计）

- 统一入口 `engine/sessions.ts` `startSessionInTx`（`engine/api.ts` `startSession` 是包装）。前置检查：任务存在；停用的只挡自动触发（`manual` 和派活「现在就办」可越过）；附件归属合法；**任务没设复核模型、也没有默认复核模型就不开始**。
- 来源（`snapshot.source`）：
  - `manual`：tRPC `engine.runNow`（带附件、附加说明）。
  - `cron`：`task.cron` → `schedule.ts` `onTaskCron`（`cron_skip_if_running` 时上一次还在 running/verifying 就跳过；开不了就通知负责人）。
  - `todo`：人加的待办（`todo.fire` / `todo.cron` / 事件）→ `fireTodo`：任务有挂起的 session 就继续最近那个（`latestWaitingSession`，不含子运行），否则新开。
  - `event`：`POST /api/events`（`engine/http.ts`，令牌 sha256 存 settings）或控制台触发 → `control.ts` `fireEventImpl`：①叫醒按事件名 + match 等待的 session，②触发待办，③按任务 `dispatch.events` 派单（`dispatch/events.ts`）。
  - `dispatch`：派活单被 `work.pump` 领到时（`dispatch/pump.ts`，同一个事务里建 session、单改「在办」）。
  - `sub`：父运行调 `subagent.start`（`subagents/start.ts`）：从父快照派生子快照（`SH` `deriveSubSnapshot`），id `<父>.<n>`，**先全部挂起排队**（等 `subagent.queue:<父>`），由 `subagent.pump` 放行。
  - `routine_test`：固化试跑（`routine/test-run.ts`），只跑脚本。
  - 助手（copilot）**不开运行**，只改配置；它能 `create_task`、`create_todo`，但没有「立即运行」工具。

### 3.2 领取

worker `boss.work(session.run)` → `runSession(db, sessionId, { signal })`。singletonKey 保证同一个 session 同时只有一个任务在跑/排。状态不是 `running` 或没快照直接 `skipped`。worker 被杀：心跳停 → pg-boss 重试给活着的 worker；worker 正常退出时还 running 的主动重排；worker 启动时把所有 running 的重排一次。

### 3.3 agent 循环（`S/engine/loop.ts` 1360 行）

1. `resolveAutoMemory`（`memory/retrieval.ts`）：快照里 `autoMemory.status = pending` 才挑：查询文字 = 标题 + 目标 + 步骤 + 说明 + 派活参数，算向量（缺的记忆向量顺手补算 ≤ 64 条），在 active、非手选、非 web_unverified 的记忆里按余弦相似度取 ≥ 门槛（按模型标定，`autoMemoryMinScore`）的前 N 条（默认 5），超时 20 s；结果写回快照，以后挂起再继续、重启都不再挑。出错不挡运行。
2. 起 `watchRunStop`（停运行的中止信号）。
3. 是否先跑固化脚本（`snapshot.routine` 且还没跑过 / 停下等人 / 中途被杀）→ 见第 6 节；否则 `resolveModel`（失败直接 `failSession`）。
4. `ToolGateway.create`（`engine/gateway.ts`）：把快照里的工具展开成给模型的工具定义（**不带 execute**）。工具名点换下划线。
5. `buildSystemPrompt`（`engine/prompt.ts`）：**只由快照拼，整个 session 不变**（为 prompt caching）；节：任务 / 要交付的东西 / 派来的活 / 步骤 / 检查点清单 / 记忆（必须遵守）/ 可能相关的记忆 / 任务记忆 / 技能目录（只名字+一句话，`skill.load` 读全文）/ 规则（告诉 agent 由系统执行）/ 工具 / 可以派活给 / 浏览器 / 桌面 / 附件 / 空间文件 / 运行代码 / 拆给子 agent 或「你是子 agent」/ 怎么工作。会变的东西（现在几点、等到了什么）放在消息里。
6. 首次进入跑 `runStartHooks`。
7. 读消息历史 `loadMessages`；若有已决定的**审批工具调用**（`session_waits.pending.decision`）：先处理——批准就把 pending 标 `executing` 再执行（上次执行到一半 worker 没了 → 不重复执行，告诉 agent「不确定执行没有」），拒绝就把「被拒绝：理由，不要绕过去」作为工具结果；再执行同一步里后面没执行的调用。
8. `repairDanglingCalls`：最后一条 assistant 消息里没结果的工具调用补一个「被中断了（worker 重启），不确定有没有执行成功」，保持消息历史合法。
9. 主循环每一步：
   - 被停 / 状态不是 running → `stopped`。
   - 跑满 `maxRunMs`（30 min）→ 自己排一个新的 `session.run`、写「交接」事件、退出（`handoff`）。
   - 上限：普通运行花费 ≥ `cost_limit_usd ?? session.maxCostUsd`（父运行按「父 + 全部子」合计 `familyCost`）或步数 ≥ 上限 → `hitLimit` 生成 approval 类 human item、挂起；**子运行**到上限直接记没办成收尾，不问人。
   - `runBeforeStepHooks`（规则 `cost_over`：挂起等确认或失败）。
   - `maybeCompact`（`engine/compact.ts`）：历史 token 接近「模型上下文 60%」（或设置 `context.compactMaxTokens` 更小者）时，把较早的大块工具输出（网页快照、接口返回、图片）换成摘要 + 文件引用；摘要用「规划」模型写（不可用就摘录头尾）；检查点、问人、步骤、挂起类工具结果、assistant 的话、user 消息保留原文，最近几条不动；**库里原行只标 compacted，不删**。
   - `callWithRetry` → `model.ts` `callModel`（AI SDK 7 `generateText`，`maxRetries: 0`，一次一步，不传 temperature/top_p）。可重试错误按 2 s 起翻倍重试 3 次，每次写 error 事件。
   - **模型最终失败**（2026-11-03）：普通运行 → 被派的先看派活单能否自动重试（能就标失败、单回排队，判断和结算同一事务），否则 `askAboutModelError` 生成「模型调用失败，要不要重试」（重试 = 从失败那一步重新调模型，失败那步没写消息、不算步数；不继续 = 记失败）；子运行、试跑照旧 `failSession`。
   - 调模型期间被停：用量花费照记，回复不记，停。
   - 累计 tokens/cost、`step_count + 1`；写 `think` 事件（花费、缓存命中）；追加 assistant 消息。
   - **只回文字**：父运行还有没结束的子 agent → 提醒一次（`rule_state.subagentNudged`），再只回文字就先停掉子 agent；没调 `run.finish` → 提醒一次（`rule_state.finishNudged`，挂起再继续也只提醒一次）；再回文字就按「说做完了」处理（`agentSaysDone`）。
   - **有工具调用**：`processCalls` 依次交给 `gateway.call()`；每个调用前重新读 session 状态。
10. 网关 `call()`（`gateway.ts`）顺序：`runBeforeToolHooks`（内置检查：工具在本任务范围里 + zod 参数校验；规则：deny / ask_human）→ 执行（内置 / HTTP / MCP / 浏览器组 / 桌面组 / 图库组 / 比物组 / 库流程）→ 被停就不记结果 → 隐藏密钥原文、超长输出截断（`toolOutputMaxChars` 8000，全文存文件）→ 写 `tool` 事件（含 trace）→ `runAfterToolHooks`（规则 after_tool、page_needs_human、自动记录检查点、截图、通知）。`browser.batch` 在网关里展开成逐步普通调用；固化脚本、`code.run(tools)`、库流程的每一步也都回到 `call()`（带 routineStep/scriptStep/library），要审批的一步停在它前面、不发起审批（普通运行的固化脚本会发起审批，见第 6 节）。
11. 工具结果的三种特殊结局（`ToolOutcome`）：`finish`（run.finish：同一步后面的调用补「没执行」，没办成直接收尾，办成走 `agentSaysDone`）、`suspend`（结果和挂起同一事务落库）、`approval`（`suspendForApproval`：整步剩余调用存进 `pending`，生成 approval 事项）。工具给的图片另追加一条 user 消息（file part）。
12. `agentSaysDone` → `runFinishHooks`：规则 `agent_done` 的动作（通知、`verify` 三方验收）。三方验收（`engine/verify.ts`）：状态改 `verifying`，另一家族的模型（同家族直接失败）逐条判检查点 + 交付物，结构化输出存 `sessions.verification`；不过的前 `verify.maxRounds - 1` 轮把问题反问 agent（continue），最后一轮生成 `verify` 类 human item（算通过 / 算失败 / 补充说明后继续）。
13. 收尾 `finishRun`：**顺序 = 最终结论定 → 关资源（工具连接、Chrome 写回登录态）→ 写过程 → 写最终状态**。一个事务里：追加剩下的消息、`outcomeFactsInTx` + `judgeByRules`（`engine/outcome.ts`：agent 自报没办成、检查点没达成、被派任务必交的结果缺了 → 没办成；三方验收通过 → 办成）、状态 `done`、结果（定论的）或 `review.pending`、`done` 事件、子运行写 `sub_result`、`afterRunEndedInTx`。事务之后 `reviewAfterFinish`（`engine/review.ts`：便宜模型看目标、交付物、检查点、报告、整次过程 `log-text.ts reviewLog`、产物、派活参数和交回结果、最后一张截图，判办成/没办成；出错重试一次，还错记没办成；复核期间人改过结果的不覆盖；复核用量记进运行）→ 结算派活单 → `notifyFinished`（没办成通知负责人；办成站内不推送；被派的办成不通知；子运行不通知）→ `afterRunSettled`（固化统计、自动固化）。
14. 失败 `failSession`：状态 failed + 结果没办成 + error 事件 + `afterRunEndedInTx`（被派的：可重试且没用完 → 单回排队；子运行叫醒父；父停子）+ 固化试跑收尾，之后通知负责人（还会自动重试的、子运行、试跑不通知）。
15. `runSession` 的返回值（done/suspended/failed/handoff/stopped/skipped）只描述这次怎么停下，不是结果。`finally` 关网关。

### 3.4 挂起和继续（`S/engine/waits.ts`、`humans.ts`、`control.ts`）

- **挂起** `suspendInTx`（调用方事务内）：条件更新 status `running → waiting / needs_human` + 写 `session_waits` + 排 `session.wake`（resumeAt）/ `session.remind`（deadlineAt）+ `wait` 事件；被派的运行若这种等待不占名额就发 `work.pump`；子运行等人处理就发 `subagent.pump`。挂起时 `closeGateway`：MCP 断开、Chrome 写回登录态并关掉（遇验证码/登录页等人处理时保留 `browser.humanHoldMinutes`=30 分钟，**保留的 Chrome 在原 worker 进程内存里**（`BrowserManager.forSession`），只有回到同一个 worker 才能接着用），worker 释放。
- **能等什么**：
  - 时间 / 外部事件 / 时间或事件（agent 调 `session.wait`，可带 match 条件、兜底天数 `wait.eventFallbackDays`=7）；
  - 人（`needs_human` + `human_item_id`）：`ask.human`、规则 ask_human 审批工具调用、花费/步数上限、`cost_over` 规则、模型调用失败、三方验收争议、验证码/登录页（`login` 类，browser/desktop 发起，含 `desktop.ask_human`）；
  - 资源：`browser.profile:<id>`（Chrome 配置被占）、`browser.lease:<账号>`（平台账号并发满）、`desktop:<id>` / `desktop:any`；
  - 派活：`work.done:<单号>`（等派出去的单结果）、`work.slot:<任务>`（被派的运行醒来时名额满了，等名额，原来那次继续的消息存在 `match.slot`）；
  - 子 agent：`subagent.all:<父>` / `subagent.any:<父>`（父等子），`subagent.queue:<父>`（子排队）。
  - 事件名前缀保留给内部（`SH/dispatch.ts` `reservedEventPrefix`），外部事件不能用。
- **继续** `resumeInTx`：条件更新 wait `waiting → fired`（**谁先到谁生效**：到点、事件、人处理完、立即继续、待办、名额放行）→ 被派运行名额满就转去等名额 → session 改回 running（可带 `sessionPatch`，如调高上限）→ 追加 user 消息「【继续】现在是 …（上海时间）。<等到了什么>」（审批工具调用不加消息，结果由引擎作为工具结果写，消息顺序才合法）→ `resume` 事件 → 发 `session.run`（**任何 worker 都能接**，全靠库里的消息历史、快照、等待记录）→ 审计。
- **兜底期限** `onRemind`：到期只提醒负责人，**不自动继续**。挂起几天/几周后继续是常态（agent 等商家回复一天）。
- 人处理事项 `resolveHumanItemImpl`（tRPC `engine.resolveHumanItem`）：approve / reject / done + 备注；memory、skill 类走记忆页、技能页；routine 类走 `routine.review`；verify 类走 `resolveVerifyDisputeImpl`。上限、`ruleStop`、`modelError` 被拒绝 = 运行结束（failed，结果没办成，`outcome_by human`）；上限同意 = 再给一份默认额度。
- **立即继续** `resumeNowImpl`（不看名额）；**取消** `cancelSessionInTx`：未结束的 → failed + 结果没办成（human）+ 作废等待和事项 + `afterRunEndedInTx`（被派单不自动重试）+ 试跑收尾；正在跑的循环靠 stop-watch / 每步检查停下。
- **人改结果** `setOutcomeImpl`：只改结果列，写过程，被派单跟着改结果不改状态。

### 3.5 结束时的统一入口和兜底

- `engine/run-ended.ts` `afterRunEndedInTx`：所有 6 处结束点（finishRun、reviewAfterFinish、failSession、取消、上限不继续、验收争议判定）都在结束事务里调：①`settleWorkItemInTx`（单跟运行结果走：办成 → 办完；没办成 → 没办成不重试；运行出错且自动重试没用完 → 回排队 `not_before`；最终结束发 `work.notify`；发 `work.pump` 空名额）；②子运行 → 叫醒父、放行排队；③父运行 → 停掉没结束的子运行。
- 漏掉的由 `work.sweep`（每分钟）/ 子 agent 清扫 / `routine.sweep` 补；过时的 `review.pending` 由清扫记没办成。

### 3.6 并发和名额

| 限制 | 在哪 |
|---|---|
| 每个 worker 同时跑几个 session | `session.run` localConcurrency 4 |
| 每个 worker 最多几个 Chrome | `browser.maxPerWorker` 4（`browser/manager.ts`，满了排队） |
| 一个 Chrome 配置同时只给一个运行；一个运行从头到尾只用一个 Chrome | `browser/instance.ts`、`sessions.browser_profile_id` |
| 「平台 × 账号」并发（默认 1） | `account_leases` + `browser/leases.ts`（30 s 续租，过期清扫叫醒最早的） |
| 一台桌面同时一个运行 | `desktop_leases` |
| 被派任务同时在跑几个（`dispatch.maxRunning`）；agent 自己挂起、等人处理不占名额，等浏览器/桌面/子 agent 占 | `dispatch/pump.ts`（advisory lock + `for update skip locked`），`SH` `holdsDispatchSlot`，`work/service.ts occupiedSlots` |
| 派活上限：深度 3、每次运行 100 张、每任务每天 500、排队 1000、每日花费上限 | `dispatch/dispatch.ts`、`budget.ts` |
| 子 agent：每父同时 3、每父共 10、全系统 8、每个 1 美元 / 60 步、只一层 | `subagents/pump.ts`、设置 `subagent.*` |
| 花费 / 步数上限（默认 2 美元 / 不限） | `loop.ts hitLimit` |

---

## 4. agent 能看到的工具

### 4.1 内置（`S/engine/tools/builtin-defs.ts` 定义，`builtin.ts` 执行；worker 启动时 `syncBuiltinTools` 同步进 `tools` 表，不可改删）

每个任务都自带（`ALWAYS_ON_BUILTIN_TOOLS`）：
- `checkpoint.mark` 勾检查点（完成/跳过+理由；`status=doing` 指定自动记录记到哪条）
- `session.wait` 挂起等待（到点 / 事件 / 两者，带兜底期限）
- `ask.human` 问人，等回答后继续
- `plan.set` 写下 / 更新打算怎么做
- `run.finish` 收尾报结果（办成 / 没办成 + 对照目标的依据），调用后运行结束

可选 / 自动带上（`implied`）：
- `run.not_done`（旧快照兼容）、`skill.load` 读技能全文、`memory.propose` 提议记忆（→ pending 记忆 + memory 事项）、`skill.propose` 提议改技能（→ skill_suggestions + skill 事项）、`notify.staff` 站内通知 + 推渠道
- 空间文件：`file.save`（按路径存，同路径覆盖；文本/代码/Excel）、`file.list`、`file.edit`（按原文替换）、`file.delete`、`file.read`（附件和空间文件：文本、图片交给模型看、表格按行列）
- `code.run` 在 bwrap 沙箱跑 Python / Node / Shell（第 6.4 节），可带 `tools`（Node 脚本经工具桥调本运行的工具）
- 派活：`work.dispatch`、`work.list`（派活方自动带）、`work.report`（被派的运行自动带：把结果字段写回单，或报 not_done）
- 子 agent：`subagent.start`、`subagent.wait`（all/any/none）、`subagent.cancel`

### 4.2 工具组（任务选一项，网关展开成一组）

- **浏览器** `browser`（`S/browser/tools.ts`）：`browser.use`（指定 Chrome）+ Playwright MCP 0.0.83 的工具（navigate、snapshot、click、type、fill_form、select_option、hover、drag/drop、file_upload、tabs、take_screenshot、console、network_requests…）+ 自有：`browser.open`、`browser.batch`（连做几步）、`browser.extract`、`browser.find`、`browser.wait_any`、`browser.login`、`browser.fill_captcha`、`browser.clipboard_read/clipboard_paste`、`browser.copy_image`；开「允许看画面」才有 `browser.look` + 坐标工具（`browser.mouse_click_xy` 等）；开「允许直接调接口」才有 `browser.fetch` 并记网页请求到空间 `network/requests.jsonl`；开 evaluate 才有执行脚本。`browser_run_code_unsafe` 被网关屏蔽。引擎依赖：懒分配 Chrome、挂起等 `browser.profile:` / `browser.lease:`、调完检测验证码/登录页（`page_needs_human` 信号 → 截图 + login 事项挂起，规则只能加动作）、URL 白名单（调前检查 + 浏览器层拦截主文档）、`gateway.screenshot()`（规则截图存证、复核最后一张截图）、`holdBrowserForHuman`、`pageLines`（交接给 agent 的页面概况）、`browser_actions` 历史。
- **桌面** `desktop`（`S/desktop/tools.ts`）：`desktop.use` + Windows-MCP 白名单 12 个（snapshot、click、type、scroll、move、shortcut、wait、wait_for、app、clipboard、multi_select、multi_edit）+ `desktop.look`（开关）、`send_file`、`fetch_file`、`ask_human`。懒占用、`sessions.desktop_id` 整次只用一台、等 `desktop:<id>`/`desktop:any`。
- **图库** `gallery`（`S/gallery/tools.ts`）：检索（以图搜图 / 按描述 / 标签 JSON 条件）、比对、看一张、传图、改文本标签（不能删）。
- **比物** `compare`（`S/compare/tools.ts`）：比两张图（等结果）、看一条、记录、标准。

### 4.3 配置出来的工具

- **HTTP**（`S/engine/tools/http.ts`）：模板 URL/头/体，`{参数}` 由模型填（URL 编码、JSON 转义或原样 JSON），`{{名字}}` 执行时解密替换（只扫一遍，模型填的值里的 `{{}}` 不替换），JSON 体先解析校验，30 s 超时、2 MB 上限，返回里的密钥原文换成 `[已隐藏]`。可从 cURL 导入（`data/config/tools.ts`），模板里有明文密钥拒绝保存。
- **MCP**（`S/engine/tools/mcp.ts`）：`@ai-sdk/mcp` 连 stdio 或 HTTP，环境变量/请求头加密存 `secrets(mcp_env)`，值里可再写 `{{}}`；session 内复用连接，挂起和结束断开。
- **库流程** `routine.<短名>`（`S/routine/library/tool.ts`）：一次调用起沙箱跑整段库流程脚本，每步回到调用方网关；跑不通把步骤和停点交回 agent。

---

## 5. 规则、记忆、技能、密钥、模型、设置

### 5.1 规则（`SH/rules.ts`、`S/engine/rule-compile.ts`、`rules.ts`、`hooks.ts`）

- 人写一句话（触发 + 怎么办 + 会用的工具）→ 保存时用「规划」默认模型翻译成结构化 `compiledTrigger` + 动作（zod 约束输出），程序再校验规整（工具、员工必须存在，域名规整，组合必须是 v1 支持的）→ 显示「系统理解为…」（程序按结构生成）→ **人确认后才生效**。翻译不进去 = 「v1 还不支持」，**绝不退回让模型运行时自己判断**。
- 触发：`before_tool`（工具 id 或风险 external/money）、`after_tool`（某些/任意工具）、`url_not_allowed`（域名白名单）、`page_needs_human`、`cost_over`（美元）、`agent_done`、`agent_proposes`（memory/skill）。
- 动作：`deny`（拦下，理由给 agent）、`ask_human`（挂起等审批，给负责人 / 主管 / 指定人）、`screenshot`、`notify`、`sync_checkpoint`（`engine/checkpoint-sync.ts`：访问网页 → 访问记录、外发工具 → 消息原文、file.save → 文件链接，标 synced，agent 改不了）、`verify`（交给三方验收）。
- 运行时只执行**快照里人确认过的**规则（没确认的开始时写一条事件说明）；每次命中写 `rule` 事件；审批通过的调用带 `approvedRuleIds`，同一条规则不再拦，其他规则照常。
- 钩子阶段（`hooks.ts`）：onRunStart / beforeStep / beforeTool / afterTool / onFinish，可 `registerHook`。

### 5.2 记忆和检索（pgvector）

- 全局记忆 `memories`（人建或 agent 提议，**agent 提的必须人审**）；任务手选（`task_memories`）冻进快照，写 `last_used_*`。
- 自动挑选（`docs/dev/memory-retrieval.md`、`S/memory/retrieval.ts`、`embed.ts`）：embedding 模型 = `model_defaults.embed`（和图库共用，1024 维，OpenRouter `/embeddings`，`gallery/embed.ts`）；api 进程后台循环补算（每批 32、失败隔 10 分钟、advisory lock 防多进程、「要算」由 SQL 比 md5 判断，改记忆不用通知）；运行开始时在 worker 里挑（见 3.3 第 1 步）。任务开关 `auto_memory`（新任务默认开）+ `auto_memory_limit`。
- 任务记忆 `task_memory_entries`：负责人点「总结」→ `engine/digest.ts` 用第三方模型（和执行模型不同家）读过程写总结 + 提候选，候选存 `sessions.digest`，人审核后才写入；进系统提示「任务记忆」一节。
- 网页/文件/工具输出里写给 AI 的话一律当数据（防投毒：提示 + 人审两道关）。

### 5.3 技能

`skills` + `skill_versions`（每次保存 +1 版）+ `skill_tools`；快照冻结正文和版本；系统提示只列目录，agent 用 `skill.load` 读全文；`skill.propose` → 人在技能页批准（合并成新一版）或拒绝（`data/config/skills.ts`）。

### 5.4 密钥 / 保险箱（`S/lib/crypto.ts`、`S/engine/secrets.ts`）

- 信封加密：每条数据一把随机 DEK（AES-256-GCM），DEK 用 KEK 包；AAD = `表名:行id:版本号`；KEK 文件多行 `版本:base64`，最大版本加密新数据，`scripts/kek-rotate.ts` 只重包 DEK。
- 执行时才解密，**模型永远只看到 `{{名字}}`**；工具返回、事件、错误里出现原文换成 `[已隐藏]`；接口只给 `masked`；参数里的密钥字段在审批详情里也掩码（`maskSecretFields`）。
- 登录态保险箱 `browser_vaults`：开始装进 Chrome，结束先探测仍登录再三方合并写回（只写本 session 改过的项，版本 CAS 冲突重试），探测不过不写回、账号标需人工；agent 手里没有导出 cookie 的工具。代理密码、账号密码、桌面密钥也在 `secrets`。

### 5.5 模型服务（`S/engine/model.ts`、`S/data/config/models.ts`）

- kind：OpenRouter（`@openrouter/ai-sdk-provider`）、直连 Anthropic（Messages API，顶层 `cache_control` 自动缓存、新 Claude 开服务端拒答兜底 `fallbacks`、历史有 thinking 块时 `drop_block`）、OpenAI（Responses API，`store:false`）、DeepSeek、**custom**（`@ai-sdk/openai-compatible`，任何 OpenAI 兼容 `/chat/completions`，key 可选，模型可手动加）、ollama（保留，调用报未配置）。
- **`supports_json_schema` 开关**（只看 custom）：开 → 结构化输出发 `response_format: json_schema`；关（默认）→ 只发 `json_object`，JSON Schema 写进系统提示（`schemaInPrompt`），不合 schema 时按文字再抠一次 JSON（`extractJson`）+ zod 校验。
- 结构化输出 `callStructured`（`generateText + Output.object`）用于：规则翻译、复核、三方验收、压缩摘要、比物、总结、固化员、`ha.judge`；`engine/structured.ts` 的 `lenientEnum`（大小写、中英文同义）+ `callStructuredWithFix`（格式不对把原话和错处告诉模型改一次）。
- 花费：OpenRouter 用返回的 `usage.cost`；直连按 `models.price_*` 估，缓存命中打折。不传 temperature/top_p。
- 列模型用公开 `GET /models`（OpenRouter 不花钱），测试连接 `GET /key`；直连按名字去 OpenRouter 目录查价格。
- 角色：run（执行）、plan（规划：规则翻译、压缩、导入读包、助手兜底）、verify（三方验收、总结）、review（复核）、embed、assistant、solidify（固化员）。验收和执行**不能同一家族**（保存默认模型、建任务、验收时都查）。

### 5.6 设置（`settings` 表，`SH/config.ts` 的 `SETTING_KEYS`/`SETTINGS_DEFAULTS`，`S/engine/settings.ts`、`S/data/config/settings.ts`）

`session.maxCostUsd`(2) `session.maxSteps`(0=不限) `wait.eventFallbackDays`(7) `events.token`(sha256) `notify.channels`（飞书 / 企业微信群机器人 / 通用 webhook，URL 存全局密钥）`browser.maxPerWorker`(4) `browser.visionCheck` `browser.visionModel` `browser.captchaSolve`(true) `browser.humanHoldMinutes`(30) `verify.maxRounds`(2) `context.compactMaxTokens`(0) `dispatch.maxDepth/maxPerSession/maxPerTaskPerDay/maxQueued` `subagent.maxParallel/maxPerRun/maxRunningGlobal/maxCostUsd/maxSteps` `assistant.maxSteps/maxCostUsd`，另有桌面存放位置。环境变量里的时间参数见 `S/engine/runtime.ts`（重试基数、30 min 交接、stop-poll、上传 20 MB、沙箱各种上限）。

---

## 6. 固化（routines）和沙箱

### 6.1 从运行写出脚本（`S/routine/compile.ts`、`material.ts`、`prompt.ts`、`checks.ts`、`test-run.ts`、`review.ts`、`auto.ts`）

- 触发：人点「固化成流程」，或办成后自动（`auto.ts`：任务 `auto_solidify`，被派的/定时的默认开；跳过条件：有一版在写/试跑/待审、24 h 内固化过、最近一版被拒或失败不满 7 天）。
- 一版脚本是状态机（`routine_versions.status`）：drafting → testing →（不过回 drafting，最多 `ROUTINE_MAX_ROUNDS` 轮）→ review / failed；`routine.compile` 每次只走一步，不等试跑。
- 材料（`material.ts`）：每次工具调用一段（参数、录下的 Playwright 定位代码、前后网址、成败、输出开头），**系统标出输入出现的位置**；修版给旧脚本和停点；`code.run` 写的脚本原文；网页调过的接口按「方法 + 路径模板」归类。
- 固化员 = `solidify` 角色模型，输出脚本 + input/output JSON Schema + commits + 给人看的步骤。程序检查（`checks.ts`，AST）：只许 `import ha from "heyagent"`，禁 eval/Function/require/动态 import/process/globalThis，用到的工具都在任务里。
- 试跑：开 `kind = routine_test` 的运行，用原运行的输入，**走到第一个 `ha.commit` 前停**，`work.report`/`run.finish`/`checkpoint.mark` 只记不生效，和原运行交的结果逐项比；试跑结束（任何方式）都在结束事务里发 `routine.compile`（`runtime/test-end.ts`）。
- 每一版都要人审核（`human_items.kind = routine`，`routine.review` 启用 / 不用 + 理由）。

### 6.2 不调模型地跑（`S/routine/runtime/run.ts`、`bridge.ts`、`handoff.ts`、`judge.ts`、`stats.ts`）

- 任务 `routine_mode = first` 且有启用版本：快照冻进 `snapshot.routine`，运行先在沙箱跑脚本（`routine.mjs` + SDK `apps/server/sandbox-sdk/heyagent`，不挂出网代理，`/workspace` 只读，512 MB，≤ 1000 次调用，默认 10 min）。
- **工具桥**（`bridge.ts`）：unix socket 挂到沙箱 `/tmp/.tools`，一行一个 JSON（op = tool / commit / verified / log / fail / now / done），每个 tool 请求交给本运行的 `gateway.call()`——规则、白名单、审批、验证码检测、过程记录和 agent 自己调完全一样；一次只处理一个请求，每次前看运行还在不在。
- 结局：跑通 → 报办成走「说做完了」规则（三方验收可能反问 → 进 agent 循环）/ 报没办成直接收尾；`ha.fail("input")` → 没办成；要审批 → 保留 Chrome、生成审批（`pending.routineStep`），批准后**从头重跑脚本，按 `routine_journal` 重放**（hash 对得上直接回记下的结果、不真做；Chrome 换了或被拒不重放 → 交 agent）；要挂起 → 照常挂起；跑不通 → `buildHandoff` 写「做了哪几步 ✓/✗、停在哪、会改东西的步骤做没做、现在的页面」，**同一个网关、同一个 Chrome** 交给 agent 接着做（这时才 `resolveModel`）。
- `ha.judge`：用本运行的执行模型答一道判断题（选项外重试一次），花费记到运行，步数不加。
- 统计（`stats.ts`）：试用期连续 3 次直接办成转正式；连续 3 次交给 agent 自动停用并通知。

### 6.3 流程库（`S/routine/library/*`）

转过正式的版本由主管发布进库 → `tools` 一行 `routine.<短名>`（source = routine，risk 和 requires 由 AST 分析算，`analyze.ts`，禁环、最多一层嵌套）；任务选用 → 快照冻 `libraryRoutines`（含传递依赖，用不了的带 `unavailable`）；当工具调（4.3）或脚本里 `ha.routine()`；每次调用记 `routine_calls`，连续失败自动停用；撤下要没人用。

### 6.4 沙箱（`S/sandbox/*`，`docs/dev/session-space.md`）

- bubblewrap：新的 user/PID/net/IPC/UTS 命名空间、清环境变量、根是只读 `/opt/sandbox-root`、`/workspace` 可写（session 空间文件的镜像，`workspace.ts` 按 manifest 增量同步，跑完对比前后把新建/改动/删除写回 `files`，不跟随符号链接）、附件/下载/截图/工具输出全文只读挂 `/workspace/<目录>`、HOME 是这个 session 自己的目录、没有 /proc；ulimit 限内存（Python/bash 1 GB，Node 堆另限、虚存 4 GB）、CPU、进程数、文件大小，墙钟超时杀进程组（默认 60 s，最多 600 s）；沙箱目录在 worker 本地，运行结束删掉（挂起、交接的留着），worker 启动清理孤儿。
- 出网代理（`proxy.ts`）：每次 `code.run` 起一个（unix socket → 沙箱里 socat 转 127.0.0.1:3128），HTTP 转发 + CONNECT，代理自己解析 DNS，回环/私网/链路本地/CGNAT/组播/保留/IPv6 ULA 等一律 403，直连解析出的 IP（防 DNS 重绑定），端口默认 80/443/8080/8443，返回「访问了哪些主机」。固化脚本和库流程**不挂代理**（只能经工具桥）。
- 理由：worker 里有 `DATABASE_URL` 和 KEK，**代码绝不在 worker 进程里直接跑**。

---

## 7. 前端用的接口

### 7.1 tRPC（`S/trpc/router.ts` + 子 router，全部 `protectedProcedure`，权限在 data/config 里按 `SH/permissions.ts` 的 `can()` 查）

| 组 | 过程 |
|---|---|
| `me` | get、changePassword |
| `users` | list、create、update、setDisabled、resetPassword |
| `staff` | list |
| `platforms` | list、create、update、delete |
| `tasks` | list、get、create、update、setEnabled、delete、saveStepsFromSession |
| `taskMemory` | list、add、update、delete、summarize（digest）、review |
| `sessions` | list、page（服务端分页 50）、setOutcome、subagents、get |
| `todos` | board、create、update、delete |
| `memories` | list、create、update、approve、reject、archive、delete |
| `skills` | list、create、update、setStatus、acceptSuggestion、rejectSuggestion |
| `rules` | list、create、update、delete、restore、compile、confirm |
| `tools` | list、createHttp/updateHttp/deleteHttp/restoreHttp、createSecret/updateSecret/deleteSecret、createMcpServer/updateMcpServer/deleteMcpServer |
| `browsers` | list、create、update、delete、createAccount、updateAccount、deleteAccount |
| `models` | overview、create/update/delete/test/refreshProvider、addModel/updateModel/deleteModel、setDefaults |
| `settings` | get、updateLimits/Browser/Agent/Dispatch/Subagent/Assistant、regenerateEventToken、clearEventToken、saveChannel、deleteChannel |
| `engine`（engine-router） | runNow、runTodoNow、cancel、resumeNow、resolveHumanItem、resolveVerifyDispute、fireEvent、taskAttachments、attachToTask、detachFromTask、sessionFiles、listMcpServerTools、notifications.{list, markRead} |
| `browser` | openForLogin、autoLogin、close、live、sessionBrowser、accountStatus、history |
| `desktops` / `desktop` | list、create、update、delete、test、host、createTemplate、createVm、vmAction、setStorageSettings、sessionDesktop、release |
| `gallery` / `apiKeys` | list、get、embedding、stats、tags、update、delete、deleteMany；apiKeys list/create/delete |
| `compare` | list、get、create、again、delete、models、standards、create/update/delete/setDefaultStandard |
| `work` | list、get、taskStats、queueStats、lookup、dispatch、updateParams、redo、startNow、cancel |
| `imports` | list、get、savePlan、setSecret、compileRule、commit、undo、abandon、stop、reread、attachMcpTools |
| `assistant` | chats、get、delete、updateSettings、defaults |
| `routine` | get、version、compile、review、setMode、setPaused、restore |
| `routineLibrary` | list、get、candidates、preview、publish、update、setPaused、withdraw、calls |
| `live` | onChange（SSE） |

### 7.2 REST（Hono，`S/app.ts`；对外说明在 `docs/dev/api.md` 1871 行）

- `GET /api/health`；`GET/POST /api/setup`（没有任何账号时第一个人建管理员，advisory lock，校验 Origin）；`/api/auth/*`（better-auth）；`/api/trpc/*`。
- 文件（`S/files/routes.ts`）：`POST /api/files`（multipart 上传，先「未使用」）、`GET /api/files/:id`（图片内联，其他一律附件下载）、`GET /api/files/:id/sheet?rows=`（表格预览）。
- 导入：`POST /api/imports`（zip 上传）、`GET /api/imports/:id/file`。
- 外部事件：`POST /api/events`（`Authorization: Bearer <令牌>` 或 `X-HeyAgent-Token`，`{event, data}`）。
- 图库：`POST /api/gallery/images|search|compare`、`GET /api/gallery/images[/:id[/file|/thumb]]`、`PATCH/DELETE /api/gallery/images/:id`、`GET /api/gallery/tags|stats`、`POST /api/gallery/mcp`（MCP Streamable HTTP）。
- 比物：`POST/GET /api/compare`、`GET/DELETE /api/compare/:id`、`POST /api/compare/:id/again`、`GET /api/compare/standards|models|files/:fileId`、`POST /api/compare/mcp`（工具名照原 Lens MCP）。
- 派活：`POST/GET /api/work-items`、`GET /api/work-items/:id`、`POST /api/work-items/:id/cancel`。
- 助手 SSE、两个 WebSocket 见 1.3。
- 对外接口鉴权（`S/lib/api-auth.ts`）：带 Bearer 就只认 API 密钥（不退回 cookie），否则 cookie；密钥调用权限按创建人**现在**的角色。

---

## 8. 非 agent 功能

- **右下角助手 copilot**（`S/assistant/*`，`docs/dev/copilot.md`）：每人自己的对话（最多保留 N 段）；`streamText` 一次一步、边出边发；工具 17 个查的（list/get 任务、记忆、技能、规则、工具、模型、Chrome、桌面、会话、运行文件、员工、`view_image`、`read_file`）直接执行，29 个改的（建/改/删任务、任务记忆、待办、记忆审核、技能、规则、HTTP 工具、MCP…）**不执行，先 prepare（校验、`can()` 查权限、读改前值）存成确认卡** `assistant_proposals`，人点「应用」才按顺序逐项调 `data/config/*` 的现成函数（各项单独成败，结果交回模型），「不要」告诉模型；有卡没处理又发新消息 → 卡过期。改前改后在卡上 Git 式 diff。能附图（缩成 1024 JPEG）和文本 / PDF（unpdf）/ Word（mammoth）文件，库里只存文件 id。模型：对话设定 → 助手默认 → plan；上限 `assistant.maxSteps/maxCostUsd`。系统提示只讲平台概念（不写业务）。
- **导入**（`S/imports/*`，`docs/dev/imports.md`，只有主管）：上传别的 agent 框架打的 zip → worker `import.read`：解压 → **模型看到任何内容前先扫出明文密钥**（`redact.ts`：.env、JSON/YAML 键、Authorization/Cookie、带密码 URL、常见 token 形状、PEM），值加密存 `secrets(import)`，文字里换 `{{名字}}` → 读包 agent（只读工具，分层列目录，最多 55 min，每步写 `read_log`）→ 代码整理方案（`organize.ts`，按库里现状对齐负责人、模型、Chrome、已有配置）+ 翻译新规则 → 7 步向导人确认 → `commit.ts` 一个事务建全部（复用配置写函数）→ `undo.ts` 一键撤销（新建的删、跑过的任务只停用、被别处用着的留下、技能恢复旧版）。
- **图库**（`S/gallery/*`）：传图（缩略图、sharp）、标签 + JSON 文本、向量（HNSW + 迭代扫描）、以图搜图/按描述/条件检索、比对；页面、HTTP、MCP、agent 工具共用 `service.ts`；api 进程后台补算向量。
- **比物**（`S/compare/*`）：两张图缩到长边 1024 + 比对标准交给视觉模型，结构化回总分、把握度、结论、各项分、差异；worker `compare.run`；四个入口（页面、HTTP 默认等 90 s、MCP、agent 工具）一个函数；默认标准「同款判断」由 bootstrap / worker 建。
- **文件 / 表格**（`S/files/*`）：存储接口 + 本地磁盘（以后换对象存储只换 `storage.ts`）；归属规则（task_id 有、session_id 空 = 任务附件，跨运行；session_id 有 = 只属于那次运行）；SheetJS 0.20.3（从 cdn.sheetjs.com 装，不用 npm 的 xlsx）读 xlsx/xls/csv/ods（按 id 缓存）、写 xlsx/xls；agent `file.read` 给带行号的制表符文本。
- **在线表格 / 文档**（`docs/dev/online-sheets.md`）：浏览器工具组里的剪贴板工具（`clipboard_read/paste`、`copy_image`，CDP 隔离世界调 `navigator.clipboard`，前要 `bringToFront`）+ 按需看画面 / 按坐标点；每个 Chrome 自己的 Xvfb 所以剪贴板天然隔离。属于浏览器能力。
- **用户 / 登录**（`S/auth.ts`）：better-auth 1.7.10 邮箱 + 密码 + admin 插件，**关闭公开注册**，账号只由主管建；首个管理员由第一个打开控制台的人设置。角色只有两种：主管（admin，全部能做、改配置、用户、设置、API 密钥）和员工（看全部，只能操作自己负责/分给自己的：`SH/permissions.ts` 的 `Action` 列表，前后端共用）。
- **通知**（`S/engine/notify.ts`）：站内 `notifications` + 推 webhook 渠道（飞书 / 企微文本、通用 JSON），推送失败不影响站内。
- **人加的待办**（`human_todos`，`engine/schedule.ts`）：按时间 / cron / 事件触发任务（有挂起的就继续它），带兜底提醒；界面已并进任务详情和会话页（`docs/dev/todos-into-sessions.md`、`work-into-tasks.md`）。
- **任务结构图 / 交付物**（`docs/dev/task-structure.md`）：`tasks.deliverables` 进系统提示、复核、验收（缺一项不能判办成）。
- **桌面虚拟机**：worker 经宿主 Podman API 建/开/关/重置 Windows 虚拟机、做模板、选 SSD/HDD 存放（`S/desktop/vm/*`，另一个 agent 负责）。
- bootstrap（`S/bootstrap/index.ts`，每次 api 启动、幂等）：默认设置、按 `.env` 的 OpenRouter key 建服务 + 刷新模型 + 设默认模型（失败后台重试）、同步内置工具、默认比对标准、默认 embedding 模型；不灌演示数据。

---

## 9. 重写必须保留的不变式和来之不易的行为

**平台和配置**
1. **平台通用，代码不写业务**（`docs/dev/conventions.md` 第 0 节）：岗位、平台名、业务对象只在配置和种子里；每个里程碑跑 grep 检查。缺能力只补通用能力。
2. **快照冻结**：运行开始时冻结任务全部配置；任务后来改了不影响在跑的运行；子运行从父快照派生、不重读任务配置；旧快照字段缺失要兼容（`run.not_done`、`allowVision` 默认 false、`deliverables` 可选…）。
3. **系统提示整个 session 不变**（prompt caching），会变的信息放消息；继续时追加「【继续】现在是 X（上海时间）。等到了…」。

**持久化和崩溃恢复**
4. **每一步先落库再继续**；`session_events`/`session_messages` 只追加（DB 触发器禁 UPDATE），序号由 sessions 行上的计数器在行锁下发（api、worker 同时追加不撞号）。注意：工具事件是**执行后**写的；「执行前持久化」只对审批过的调用成立（`pending.state = executing` 先写，崩了不重复执行）。
5. **进程随时可被杀**，同一个 session id 从库接着跑：pg-boss 心跳 + 重试；worker 启动重排 running；`repairDanglingCalls` 补中断结果；固化脚本按 `routine_journal` 重放；导入读包、比物从头再来；30 min 主动交接。
6. **挂起几天后在原 session 继续**：不依赖任何进程内存（唯一例外：等人处理时保留的 Chrome，过期即关）；任何 worker 都能接。
7. 挂起 = 一个事务（状态 + 等待 + 延迟任务），继续 = 条件更新「谁先到谁生效」，后到的什么都不做；兜底期限只提醒、不自动继续。
8. 状态和结果分开：`status` 只管流程，`outcome` 只有办成 / 没办成；结束顺序固定（结论 → 关资源/写回登录态 → 写过程 → 写最终状态 → 事务外复核）；6 处结束都走 `afterRunEndedInTx`，每分钟清扫兜底。
9. 业务写入和发队列任务在同一事务（`sendInTx`），不会有「写了库没发任务」或反过来。

**安全和「模型绕不过」**
10. 工具定义不带 execute，**模型提出的每个调用都经网关**：范围检查、schema 校验、规则、执行、截断、隐藏密钥、落库、后置规则。batch、固化脚本、`code.run(tools)`、库流程的每一步也逐步走网关；批/脚本里要审批的步骤停在它之前。
11. 规则：只有人确认过的翻译结果生效，翻译失败就是「不支持」，不退回让模型判断；规则在程序里执行；被拒的调用告诉 agent「不要换个办法绕过去」。
12. 密钥：模型只见 `{{名字}}`、执行时解密、输出里原文换 `[已隐藏]`；信封加密 AAD 绑定行和版本；接口只给掩码；导入包在模型看到前先挪走密钥；HTTP/MCP 模板里写明文拒绝保存。
13. 浏览器：agent 拿不到完整 cookie（两条 CDP 连接，屏蔽 `browser_run_code_unsafe`，evaluate 按任务开放）；URL 白名单由我们检查（MCP 自带的不是安全边界）；代理挂了报错，**不自动直连**；一个 Chrome 同时一个运行、一个运行一个 Chrome。
14. 代码执行只在 bwrap 沙箱，出网只经防 SSRF 的代理；固化脚本完全无网，只能经工具桥。
15. 网页内容不可信：新记忆、技能修改、每一版固化脚本都要人审；对外/涉钱动作可配审批（money 风险的审批有「确定批准吗」二次确认）。

**结果判定**
16. 复核一定做（任务没有复核模型就不能开始）；办成 = 硬规则过 + 复核判办成（或三方验收通过）；证据不足、复核出错、没复核模型都记没办成；「结果导向」——没拿到目标要的东西就是没办成；人可改结果，复核回来不覆盖人的。
17. 三方验收的模型和执行模型不能同一家族；验收不过先反问、最后交给人。
18. 子 agent 不复核、不问人、不通知；到上限直接没办成；父运行花费按「父 + 子」合计；父结束子跟着停；只一层。
19. 只回文字不报结果：提醒一次（标记存 `rule_state`，挂起再继续也只一次），再不报就按说做完了交复核。

**失败、上限、并发**
20. 模型调用失败（重试 3 次后）不直接失败：交给人「重试 / 不继续」，重试从失败那一步重来不重做前面；被派的先用派活单自动重试。
21. 花费 / 步数到上限 → 问负责人，同意再给一份额度；`cost_over` 规则同理。
22. 派活：同任务同去重键只有一张单（唯一约束）；领单在一个事务里（advisory lock + skip locked），单和运行一起成；名额只算占资源的等待；醒来名额满就等名额、比新单先放行；「立即继续」不看名额；被派单结果跟运行结果走，没办成不重试，运行出错才按设置重试。
23. 停运行要立刻生效：stop-watch 中止正在调的模型和正在起的 Chrome；被停后不再记这次调用结果，但花了的钱照记。

**其他**
24. 实时：DB 触发器推 `{table,id}`，前端按需重拉；断线可补发，补不齐整体重拉。
25. 权限前后端同一份 `can()`；员工看全部、只操作自己负责的；对外 API 密钥按创建人现在的角色。
26. 定时一律 Asia/Shanghai；cron 用 pg-boss schedule，按对象 id 作 key（改了覆盖、删了取消）；改时间后旧的延迟任务自己作废。
27. 不传 temperature；Anthropic 开 prompt caching；OpenAI `store:false`（挂起几天也不依赖对方存记录）；thinking 块对不上前文时丢弃不报错。
28. 运行编号、记录都可读（`T-`、`R-`、`W-`、`<父>.<n>`），通知里的链接是 hash 路由（`#/tasks?id=…&run=…`、`#/sessions?status=human&id=…`）。

---

## 10. 规模（行数，不含空文件，`apps/server/src` 非测试代码共 59,957 行）

| 模块 | 行数 | 备注 |
|---|---|---|
| `engine/`（根） | 10,218 | loop 1360、gateway 959、sessions 714、verify 629、log-text 549、model 493、rules 494、humans 491、prompt 437、waits 395、rule-compile 342、schedule 294、digest 292、compact 248、queue 243、review 236、control 232、… |
| `engine/tools/` | 2,183 | builtin 921、http 574、builtin-defs 393、mcp 295 |
| `engine/dispatch/` | 1,670 | dispatch 402、manage 356、settle 185、pump 160、sweep 156… |
| `engine/subagents/` | 1,053 | |
| **引擎合计** | **15,124** | |
| `routine/`（根） | 3,231 | material 1083、compile 629、checks 519、prompt 369 |
| `routine/runtime/` | 2,053 | bridge 1164、run 402 |
| `routine/library/` | 1,657 | service 706 |
| **固化合计** | **6,941** | 另有 `apps/server/sandbox-sdk/heyagent` 817 行（JS SDK） |
| `sandbox/` | 1,494 | code-run 549、runner 333、workspace 328、proxy 284 |
| `browser/` | 7,850 | （另一个 agent 负责） |
| `desktop/` | 2,968 | （另一个 agent 负责）+ `apps/desktop-agent` Python 2,266 |
| `data/`（配置写操作 + loaders） | 4,118 | models 824、loaders 702、tools 392、settings 318、tasks 303… |
| `imports/` | 3,386 | |
| `assistant/` | 3,139 | tools 1400、run 545、store 358 |
| `trpc/` | 1,706 | router 440、engine-router 412 |
| `db/`（schema 1841） | 1,880 | 迁移 SQL 1,428 行（39 个） |
| `gallery/` | 1,498 | |
| `compare/` | 1,391 | |
| `files/` | 1,098 | service 557、sheets 370 |
| `work/` | 502 | |
| `memory/` | 415 | |
| `lib/`（crypto、api-auth、ws-relay） | 322 | |
| `bootstrap/` | 199 | |
| `live/` | 143 | |
| 根文件（app、index、worker、auth、env） | 305 | |
| `seed/`（演示数据和测试夹具） | 4,914 | |
| `scripts/`（kek-rotate 等） | 564 | |
| `packages/shared/src` | 8,139 | zod schema、纯函数（前后端共用，含快照、规则、派活、子 agent、固化的类型和判断函数） |
| 测试 `apps/server/test` + `test-browser` | 32,692 | vitest 连真 PostgreSQL 18（`heyagent_test`），不 mock 数据库 |

开发文档：`docs/dev/*.md` 共约 1.09 万行（solidify 1493、sub-agents 1087、routine-library 840、dispatch 系列 1745、api.md 1871），`docs/v1-plan.md` 527 行。
