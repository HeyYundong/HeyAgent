# M0 接口说明（给包 3：控制台接真实数据）

> 2026-10-17 · 包 1 产出。后端代码在 `apps/server`，共享类型在 `packages/shared`（包名 `@heyagent/shared`）。
> 这份文档回答三件事：前端怎么连后端；原型每个页面读的每样数据现在从哪个接口拿、形状是什么；和原型相比改了什么。

## 1. 总览

| 路由 | 用途 |
|---|---|
| `GET /api/health` | 健康检查，不要求登录。`{"ok":true,"db":"ok"}`，数据库连不上时 503 |
| `/api/auth/*` | better-auth 1.7.10：邮箱 + 密码登录、退出、取当前会话 |
| `/api/trpc/*` | tRPC 11.19：页面数据（全部是 query，只读）和实时推送（subscription，走 SSE） |

- **全部 tRPC 接口都要求登录**。没登录时 query 返回 HTTP 401（tRPC 错误码 `UNAUTHORIZED`）；订阅请求（`Accept: text/event-stream`）也直接回 401。
- **只读**：M0 没有任何写接口。页面上的写操作照包 3 第 6 步统一弹 toast。
- **输出都经过 zod 校验**：每个接口的返回形状就是 `@heyagent/shared` 里对应的 schema，类型用 `z.infer` 导出，前端直接 import 类型，不用自己写。
- **端口**：API 3100；`apps/web` 的 Vite dev server 5180，把 `/api` 代理到 `http://127.0.0.1:3100`。前端始终同源访问 `/api`，cookie 自动带上，不需要 CORS。

## 2. 前端怎么接

### 2.1 依赖和类型

- 前端要装（精确版本）：`@trpc/client@11.19.0`、`@trpc/tanstack-react-query@11.19.0`、`@tanstack/react-query`（版本由包 3 定，`npm view` 核对后精确锁定）、`@heyagent/shared`（`workspace:*`）。登录可以用 `better-auth@1.7.10` 的 `better-auth/client`，也可以直接 `fetch`（见 2.3）。
- 路由的类型：`import type { AppRouter } from "@heyagent/server/trpc"`。`apps/server/package.json` 的 `exports["./trpc"]` 指向 `src/trpc/router.ts`，只给类型用；前端在 `package.json` 里把 `@heyagent/server` 加为 `workspace:*` 的 devDependency。
- `@heyagent/shared` 的 `package.json` 有一个 `source` 条件指向 `src/index.ts`，`types`/`default` 指向构建好的 `dist`。前端两种用法任选：
  - 推荐：`tsconfig.app.json` 加 `"customConditions": ["source"]`，`vite.config.ts` 加 `resolve: { conditions: ["source"] }`，直接用源码，不用先构建 shared；
  - 或者先 `pnpm --filter @heyagent/shared build`，按 `dist` 用。
  用 `source` 条件时，前端的 tsc 会顺带检查 `apps/server/src` 和 `packages/shared/src`（只用到类型）。这两处都是 ESM + `.js` 后缀的 import，`moduleResolution: "bundler"` 能正常解析；前端 tsconfig 的 `types` 需要包含 `node`（server 代码用到 Node 类型）。
- tRPC 客户端：query 用 `httpBatchLink`，订阅用 `httpSubscriptionLink`，用 `splitLink` 按 `op.type === "subscription"` 分开，`url` 都是 `/api/trpc`。不用配 transformer（返回里没有 Date、Map，时间都是字符串）。

### 2.2 时间：接口给 ISO，显示用 shared 的函数转回原型写法

接口里**所有时间字段都是 ISO 8601（UTC）字符串**，例如 `"2026-10-16T01:12:00.000Z"`。原型里写的是上海时间的显示文字（`"2026-10-16 09:12"`、`"09:58"`、`"10-15 15:40"`），代码里到处是 `startedAt.slice(5)`、`event.at` 直接显示、`localeCompare` 排序。替换规则：

| 原型写法 | 现在 |
|---|---|
| `x.startedAt`、`x.createdAt` 直接显示（`2026-10-16 09:12`） | `fmtDateTime(x.startedAt)` |
| `x.startedAt.slice(5)`（`10-16 09:12`） | `fmtShort(x.startedAt)` |
| 只显示时分 | `fmtClock(iso)` |
| 运行里的 `event.at`、检查点 `record.at`（当天的运行写 `09:58`，跨天的写 `10-15 15:40`） | `eventTimeText(at, run)` |
| sessions/data.ts 的 `startText`（今天 / 昨天 / 10-14） | `startText(run.startedAt)`（shared/sessions.ts，默认以当前时间为「现在」） |
| `endedText`、`pausedMs`、`duration`、`groupOf`、`sortRuns`、`isToday` | shared/sessions.ts 同名函数，直接接 ISO |
| `a.startedAt.localeCompare(b.startedAt)` 排序 | 照旧可用（ISO UTC 字符串可以直接按字典序比较） |
| todos/cron.ts 的 `shortTime(text)`、`addDays(text, n)` 接 `YYYY-MM-DD HH:mm` | 先 `fmtDateTime(iso)` 再传给它；或用 shared 的 `addDaysIso` |
| 原型里写死的「现在」（`NOW = "2026-10-16 16:30"`、tasks/cron.ts 的 `NOW`） | 用当前时间。`Elapsed` 组件改成 `Date.now() - Date.parse(run.startedAt)` |

`fmtDateTime` 等函数按固定的 +08:00 换算，不依赖浏览器时区（上海没有夏令时）。`triggerText`、`runNow`、`nextRunText` 这些 shared 函数内部已经做了格式化，返回的文字和原型一致。

### 2.3 登录（better-auth）

| 操作 | 请求 | 说明 |
|---|---|---|
| 登录 | `POST /api/auth/sign-in/email`，JSON `{ "email", "password" }` | 成功 200，`Set-Cookie: better-auth.session_token=…`（HttpOnly，7 天）。密码错 401。公开注册已关闭 |
| 退出 | `POST /api/auth/sign-out` | 清掉会话 cookie |
| 当前会话 | `GET /api/auth/get-session` | 没登录返回 `null` |
| 当前用户（页面用这个） | tRPC `me.get` | 见 3.1，比 get-session 多了职位、`isAdmin`、待办数字 |

- better-auth 会校验 `Origin`：带着会话 cookie 的 POST（例如退出）必须带 `Origin` 头，而且来自 `TRUSTED_ORIGINS`，浏览器会自动带；用 curl 调要自己加 `-H "Origin: http://localhost:5180"`，否则返回 403 `MISSING_OR_NULL_ORIGIN`。登录请求如果带了 `Origin`，也必须在名单里（`.env.example` 里已有 `http://localhost:5180`、`http://127.0.0.1:5180`、`http://localhost:8080`）。内网用别的地址访问时（例如 `http://192.168.31.100:5180`），要把它加进 `.env` 的 `TRUSTED_ORIGINS`。
- 任何 tRPC 查询返回 `UNAUTHORIZED` 时跳到登录页。
- 演示账号（`pnpm db:seed` 灌的，密码是 `.env` 里的 `SEED_PASSWORD`，开发默认 `heyagent-dev`）：

| 人 | 邮箱 | 角色 |
|---|---|---|
| 林舟 · 运营主管 | `linzhou@heyagent.local` | 主管（`isAdmin: true`） |
| 王悦 · 搜品专员 | `wangyue@heyagent.local` | 员工 |
| 李静 · 采购专员 | `lijing@heyagent.local` | 员工 |
| 陈强 · 物流专员 | `chenqiang@heyagent.local` | 员工 |
| Emily Zhao · 客户经理（AM） | `emilyzhao@heyagent.local` | 员工 |

用户 id 沿用原型（`u-lin`、`u-wang`……），所以页面里 `ownerId === user.id` 这类判断不用改。

### 2.4 权限

`can(user, action, resource)` 在 `@heyagent/shared`（permissions.ts），前后端共用。`user` 直接传 `me.get` 的结果。原型里散落的判断可以换成它，结果相同：

| 原型 | `can` |
|---|---|
| `isAdmin` 才显示「新建任务」 | `can(me, "task.create", {})` |
| `canManage = isAdmin \|\| task.ownerId === user.id`（开关、立即运行、存为任务步骤） | `can(me, "task.manage", { ownerId: task.ownerId })` |
| 看板「立即继续」`mineTask(card.task.id)` | `can(me, "session.resume", { taskOwnerId: task.ownerId })` |
| 处理要人办的事 `isAdmin \|\| item.assigneeId === user.id`；记忆、技能的 `canReview` | `can(me, "humanItem.resolve", { assigneeId })`（记忆用 `memory.reviewerId`，技能用 `suggestion.reviewerId`） |
| 加待办的 `taskOptions` | `can(me, "todo.create", { taskOwnerId })` |
| 待办 `canRun` / `canManage` | `"todo.run"` / `"todo.manage"` |
| 记忆、技能、规则、工具、浏览器、模型页的 `isAdmin` 按钮 | `can(me, "config.manage", {})` |
| 远程画面「打开浏览器」「去登录」（大家都能用） | `can(me, "browser.login", {})` |

### 2.5 加载、出错、空状态

原型的 `PageFrame` 靠演示开关的 `state` 切换骨架屏 / 出错 / 空。改成按查询状态：`isPending` → 骨架屏；`isError` → 出错提示，「重试」调 `refetch()`；数据为空 → `empty`。演示开关整个去掉（`lib/demo.tsx` 的 `user`、`isAdmin` 换成 `me.get`）。

### 2.6 原型里留在前端的东西

下面这些是界面文案或模拟的写操作，不是数据，**照旧留在前端原文件里**，不走接口：
`tasks/data.ts` 的 `PLACEHOLDER`；`skills/data.ts` 的 `BODY_TEMPLATE`；`todos/data.ts` 的 `todoEvents`、`cronPresets`、`MODES`；`tools/data.ts` 的 `DIALOG_TEXT`、`MORE_ON_SERVER`、`DISCOVER_SAMPLES`（M1 接真实的「连接并读取工具」后去掉）；`tools/curl.ts`、`tools/secrets.ts`；`tasks/cron.ts`、`todos/cron.ts`（cron 的人话预览）；`browsers/data.ts` 的 `LOGIN_URL`、`HOME_URL`、`MAX_ITEMS`、`blankProfile`、`platformIdOf`、`proxyRows`、`vaultRows`；`models/data.ts` 的 `DEFAULT_URL`、`newProvider`、`discoveredModels`、`connectionRows`；`lib/router.ts`。
`pages/learn/` 不接接口，照包 3 第 7 步复制演示数据。

需要搬的中文标签和纯函数都已经在 `@heyagent/shared`：`runStatusLabel`、`accountStatusLabel`、`toolSourceLabel`、`riskLabel`、`riskNotes`（原 `RISK_NOTES`）、`memoryStatusLabel`、`evidenceLabel`、`skillStatusLabel`、`checkpointKinds`、`checkpointKindLabel`、`humanItemKindLabel`、`boardColumns`、`loopStages`、`providerKindLabel`（原 `KIND_LABEL`）、`providerStatusLabel`（新增）、`modelRoles`（原 `ROLES`）、`sessionGroups`（原 sessions/data.ts 的 `groups`）、`EVENT_FALLBACK_DAYS`；函数见第 4 节。

## 3. 接口一览

调用写法：`trpc.<路由>.useQuery(input)`。下表「返回」一列的类型都从 `@heyagent/shared` 导出。

| 接口 | 输入 | 返回 | 说明 |
|---|---|---|---|
| `me.get` | 无 | `Me` | 当前登录的人 + `needsMeCount` |
| `staff.list` | 无 | `Staff[]` | 全部的人（原型 `staff`），用于 `staffName` |
| `platforms.list` | 无 | `Platform[]` | 原型 `platforms` |
| `tasks.list` | 无 | `TaskDef[]` | 全部任务，新建的在前 |
| `tasks.get` | `{ id }` | `TaskDef` | 找不到返回 404（`NOT_FOUND`） |
| `sessions.list` | `{ taskId? }`（可省略） | `SessionRun[]` | 全部 session，开始时间新的在前；每条带全部检查点、全部过程事件、在等什么、验收 |
| `sessions.get` | `{ id }` | `SessionRun` | 一个 session |
| `todos.board` | 无 | `{ humanItems: HumanItem[]; humanTodos: HumanTodo[] }` | 还没处理的「要人办的事」（按急迫程度排）和有效的「人加的待办」 |
| `memories.list` | 无 | `MemoryRef[]` | 全部记忆（含已拒绝、已归档），按 id 排 |
| `skills.list` | 无 | `Skill[]` | 带 SKILL.md 正文、版本、修改建议 |
| `rules.list` | 无 | `RuleRef[]` | |
| `tools.list` | 无 | `{ tools: Tool[]; mcpServers: McpServer[]; savedSecrets: Record<string, SavedSecret> }` | |
| `browsers.list` | 无 | `BrowserProfile[]` | 每个 Chrome 带登录过的网站、保险箱版本、并发 |
| `models.overview` | 无 | `{ providers: ModelProvider[]; defaults: ModelDefaults }` | |
| `live.onChange` | `{ lastEventId? }`（客户端自动带） | 订阅，每条 `ChangeEvent` | 见第 5 节 |

M0 数据量小，`sessions.list` 一次返回全部 session 和全部事件（12 个 session、73 条事件，约 36 KB）。M1 起 session 多了会加分页、列表只带最后几条事件，到时另行通知。

### 3.1 返回形状（和原型的对照）

字段名和含义都沿用原型。下面只列**和原型不一样的地方**；没列的字段和原型完全一致。数据库里为空的字段直接省略（对应原型的 `?:`），不会出现 `null`。

**`Me`** = 原型 `Staff` + `email`、`needsMeCount`（等我处理的事：主管算全部未处理的，员工只算分给自己的，就是原型的 `needsMeCount(userId, isAdmin)`）。

**`TaskDef`**：`createdAt`、`nextRunAt` 是 ISO。

**`SessionRun`**
- `startedAt`、`endedAt`、`waiting.since`、`verification.at`、`checkpoints[].records[].at`、`events[].at` 都是 ISO（显示见 2.2）。
- `events[]` 多了 `seq`（session 内从 1 开始递增，可以当 React key），按 `seq` 排好。
- `waiting.trigger` 里的 `at`、`next` 是 ISO。
- 新增 `parentSessionId?`（以后子 agent 用，现在都没有）。

**`HumanItem`** = 原型 `HumanItem` + `detail`（原型 `todos/data.ts` 的 `humanDetails[item.id]`，原样合并进来）+ `memoryId?`、`skillId?`（记忆审核、技能修改对应的对象）。页面里 `humanDetails[item.id]` 换成 `item.detail`。`createdAt` 是 ISO。`detail` 里的文字（例如「24 小时内没人处理会自动拒绝（2026-10-17 10:58）」）是原型原文，里面的时间没有随种子平移。

**`HumanTodo`**：`createdAt`、`trigger.at`、`trigger.next` 是 ISO。

**`MemoryRef`** = 原型 `MemoryRef` +
- `note: { evidence?, lastUsed? }`：原型 `memory/data.ts` 的 `memoryNotes[memory.id]`，合并进来。页面里 `memoryNotes[memory.id] ?? {}` 换成 `memory.note`。`lastUsed` 由服务端按当前时间生成，格式和原型一样：「最近一次：今天 16:10，T-1036 的运行开始时读到」。
- `reviewItemId?`：待审核时，待办里那件事的 id。原型「去待办处理 →」用的是 `memory.id`（种子数据里两者相同），请改用 `reviewItemId`，以后新提议的记忆两者不再相同。
- `createdAt` 是 ISO（原型有的只有日期）。

**`Skill`**（原型技能页的 `Skill` = `SkillRef` + 版本 + 正文，已经拼好）：
- `version`、`updatedAt`（ISO）、`body`：原型 `skills/data.ts` 的 `skillVersions`、`skillBodies`，合并进来。页面里的 `initialSkills` 直接换成查询结果。
- `suggestion.itemId?`：用法同 `reviewItemId`；`suggestion.createdAt` 是 ISO。

**`RuleRef`** + `compiledTrigger?`（翻译后的触发条件，M3 填，现在都没有）。

**`Tool`**（原型工具页的 `Tool`）：`description` 已经合并（原型 `tools/data.ts` 的 `DESCRIPTIONS`），页面里的 `INITIAL` 直接换成查询结果。`http.method` 可以是 `GET | POST | PUT | PATCH | DELETE`（同原型 tool-dialog 的 `Method`）。`http` 模板里密钥只以 `{{名字}}` 出现。

**`McpServer`**（原型 tool-dialog 的 `Server`）：`env` 是每行「名字=••••」，只有名字，值是掩码；页面 `HowToCall` 按 `=` 前面取名字，不用改。

**`savedSecrets`**（原型 `SAVED_SECRETS`）：`Record<名字, { by: 姓名, byId, at: ISO }>`。原型 `at` 是 `"10-08"`，显示用 `fmtShort(at).slice(0, 5)` 或 `fmtDate(at)`。

**`BrowserProfile`**（原型 `Chrome`）：
- `updatedAt`、`sites[].lastLoginAt` 是 ISO。
- `running`、`sites[].running` 来自没释放的账号租约（`account_leases`）。
- 新增 `sites[].accountId`、`proxy.hasPassword?`、`timezone?`、`locale?`、`sites[].probeUrl?`、`sites[].saveIndexedDb?`（方案 2.3.6 要加的字段，界面暂时不用显示）。
- 代理密码、cookie 内容都不返回。

**`ModelProvider`**（原型 `models/data.ts` 的 `Provider`：`id` 和 `kind` 分开，页面里的 `initialProviders` 直接换成查询结果）：
- `status` 多了 `"unconfigured"`（未配置，`providerStatusLabel` 里是「未配置」）。未配置时 `baseUrl` 为空字符串，`models` 为空，**没有** `checkedAt`、`latencyMs`。原型 `connectionRows` 和列表的 `延迟 ${p.latencyMs} ms` 要处理这种情况。
- `checkedAt` 是 ISO。`apiKeyMasked` 只有掩码。
- `models[].vision`：新增，能不能看图。

### 3.2 种子数据里的模型（B 路线）

按 m0.md 包 1 第 4 步：Ollama 保留一条「未配置」；OpenRouter 5 个模型，价格是 2026-10-17 从 OpenRouter 模型列表取的（每百万 token，美元）：

| id | 名字 | 输入 / 输出 | 上下文 |
|---|---|---|---|
| `openrouter/anthropic/claude-opus-5.5` | Claude Opus 5.5 | 4 / 20 | 1000K |
| `openrouter/anthropic/claude-sonnet-5.5` | Claude Sonnet 5.5 | 2 / 10 | 1000K |
| `openrouter/anthropic/claude-haiku-5.5` | Claude Haiku 5.5 | 0.1 / 0.5 | 1000K |
| `openrouter/google/gemini-3.8-flash` | Gemini 3.8 Flash | 0.825 / 4.125 | 1049K |
| `openrouter/qwen/qwen3.8-flash` | Qwen3.8 Flash | 0.15 / 0.47 | 1000K |

默认：执行 Sonnet、规划 Opus、验收 Gemini 3.8 Flash（和执行不同家，原型的同家校验照样通过）。原型 R-1031-1 里「三方 AI（qwen3:32b）开始验收」改成了「三方 AI（Gemini 3.8 Flash）开始验收」。`contextText` 对 1049 会显示「1.049M」，要好看可以在前端改成保留一位小数。

## 4. 页面 → 接口

按原型的文件逐个列。「原型读的」是原型从 `@/mock/shared`、`./data` 拿的东西，「现在」是替换成什么。shared 函数都改成了「数据作为参数传入」，签名见下表。

### 4.1 外壳（`components/shell/*`、`lib/demo.tsx`、`lib/resolved.ts`）

| 文件 | 原型读的 | 现在 |
|---|---|---|
| `app-sidebar.tsx` | `useDemo().user`（名字、职位）、`humanItems` + `useResolved()` 算待办数字 | `me.get`：`name`、`title`、`needsMeCount`。处理掉的事 M1 由后端改状态，`lib/resolved.ts` 去掉 |
| `site-header.tsx` | 演示菜单（`useDemo`） | 去掉演示菜单，主题开关保留 |
| `simple-page.tsx` | `useDemo().state`、`retry` | 按查询状态，见 2.5 |
| `agent-loop-strip.tsx` | `loopStages` | shared 的 `loopStages` |
| `lib/demo.tsx` | `staff`、`ADMIN_USER_ID`、`STAFF_USER_ID` | 删掉，当前用户来自 `me.get` |

### 4.2 任务（`pages/tasks/*`）

| 文件 | 原型读的 | 现在 |
|---|---|---|
| `index.tsx` | `tasks`、`runs`、`staffName`、`useDemo` | `tasks.list`、`sessions.list`、`staff.list`、`me.get`。`runsOf(taskId)` = shared `runsOfTask(runs, taskId)`；`staffName(staff, id)` |
| `parts.tsx` | `runStatusLabel`、`checkpointKindLabel`、`humanItems`（`runNow` 里找挡住运行的事）、`staffName`、`triggerText` | 标签从 shared 来；`runNow(run, humanItems, staff)`、`checkpointSummary`、`nextRunText(task, latest)` 已在 shared（`humanItems` 来自 `todos.board`）。`Elapsed` 见 2.2 |
| `task-detail.tsx` | `memories`、`rules`、`skills`、`modelName`、`toolIdsOfTask`、`toolName`、`ALWAYS_ON_TOOL_IDS`、`findById` | `memories.list`、`rules.list`、`skills.list`、`tools.list`、`models.overview`。`ALWAYS_ON_TOOL_IDS` = `alwaysOnToolIds(tools)`；`toolIdsOfTask(task, alwaysOnIds)`；`toolName(tools, id)`；`modelName(allModels(providers), id)` |
| `run-detail.tsx` | `humanItems`（验收卡片的「去待办处理」）、`modelDefaults.verify`、`modelName`、`toolName` | `todos.board`、`models.overview`（`defaults.verify`）、`tools.list`。`event.at` 用 `eventTimeText(event.at, run)` |
| `new-task-dialog.tsx` | `memories`（生效的）、`skills`（已发布的）、`tools`（非自带）、`rules`、`allModels`、`modelDefaults`、`modelFamily`、`sameFamily`、`modelName`、`checkpointKindLabel`、`recognizeCheckpoints`、`ALWAYS_ON_TOOL_IDS`、`PLACEHOLDER` | 同上几个查询；`recognizeCheckpoints` 在 shared。`PLACEHOLDER` 留在前端。提交走只读 toast，`nextNumber` 不再需要 |
| `cron.ts` | 无 | 留在前端（`NOW` 换成当前时间） |

### 4.3 Session（`pages/sessions/*`）

| 文件 | 原型读的 | 现在 |
|---|---|---|
| `index.tsx` | `runs`、`tasks`、`money`、`RunDetail` | `sessions.list`、`tasks.list`。`groupOf`、`sessionGroups`、`isToday`、`sortRuns` 在 shared |
| `list.tsx` | `tasks`、`modelName`、`staffName`、`endedText`、`startText` | `tasks.list`、`models.overview`、`staff.list`；`endedText`、`startText` 在 shared（接 ISO） |
| `data.ts` | 无（工具函数） | 搬到 shared/sessions.ts，这个文件可以删 |

### 4.4 待办（`pages/todos/*`）

| 文件 | 原型读的 | 现在 |
|---|---|---|
| `index.tsx` | `boardCards()`、`humanItems`、`humanTodos`、`runs`、`tasks`、`humanDetails`、`useResolved` | `todos.board` + `sessions.list` + `tasks.list`。卡片 = shared `boardCards({ runs, tasks, humanItems, humanTodos })`；`humanDetails[item.id]` → `item.detail`。处理、继续、加待办这些写操作 M0 只弹 toast |
| `board.tsx` | `boardColumns`、`humanItemKindLabel`、`staffName`、`humanDetails`（涉及金钱的徽章） | shared 标签；`item.detail.pay`；`run.waiting.since` 用 `fmtShort`；`run.endedAt` 用 `fmtShort` |
| `sheets.tsx` | `boardColumns`、`runs`（`suspendedRun`）、`tasks`、`modelName`、`staffName`、`triggerText`、`NOW` | `suspendedRun(runs, taskId)` 在 shared；`NOW` 换成当前时间；时间见 2.2 |
| `human-sheet.tsx` | `humanDetails`、`runs`、`rules`、`humanItemKindLabel`、`staffName` | `item.detail`、`sessions.list`、`rules.list` |
| `todo-dialog.tsx` | `EVENT_FALLBACK_DAYS`、`MODES`、`cronPresets`、`todoEvents`、`NOW` | `EVENT_FALLBACK_DAYS` 在 shared；其余留在前端 |

### 4.5 记忆（`pages/memory/*`）

| 文件 | 原型读的 | 现在 |
|---|---|---|
| `index.tsx` | `memories`、`memoryNotes`、`evidenceLabel`、`memoryCategory`、`memoryStatusLabel`、`staffName`、`tasksUsing("memoryIds", id)` | `memories.list`（`memory.note`、`memory.reviewItemId`）、`tasks.list`、`staff.list`。`tasksUsing(tasks, "memoryIds", id)`。原型页面自己过滤只显示生效和待审核的 |
| `memory-dialog.tsx` | 类型 | `MemoryRef` 从 shared 来 |

### 4.6 技能（`pages/skills/*`）

| 文件 | 原型读的 | 现在 |
|---|---|---|
| `index.tsx` | `skills`、`skillVersions`、`skillBodies`、`BODY_TEMPLATE`、`skillStatusLabel`、`riskLabel`、`tools`、`staffName`、`tasksUsing("skillIds", id)` | `skills.list`（已带 `version`、`updatedAt`、`body`、`suggestion.itemId`）、`tools.list`、`tasks.list`、`staff.list`。`updatedAt` 显示用 `fmtDate` |

### 4.7 规则（`pages/rules/*`）

| 文件 | 原型读的 | 现在 |
|---|---|---|
| `index.tsx` | `rules`、`tools`、`riskLabel`、`toolName`、`tasksUsing("ruleIds", id)` | `rules.list`、`tools.list`、`tasks.list` |
| `rule-dialog.tsx` | `tools`、`toolName` | `tools.list` |

### 4.8 工具（`pages/tools/*`）

| 文件 | 原型读的 | 现在 |
|---|---|---|
| `index.tsx` | `tools` + `DESCRIPTIONS`、`mcpServers`、`rules`、`riskLabel`、`toolSourceLabel`、`RISK_NOTES`、`SAVED_SECRETS`、`TODAY`、`tasksUsing("toolIds", id)` | `tools.list`（`tools` 已带 `description`；`mcpServers`；`savedSecrets`）、`rules.list`、`tasks.list`。`RISK_NOTES` = shared `riskNotes`。`tasksUsing(tasks, "toolIds", id, alwaysOnToolIds(tools))`（自带的工具算全部任务）。`TODAY` 只用于新存的密钥，M0 不需要 |
| `tool-dialog.tsx` | `MORE_ON_SERVER`、`DISCOVER_SAMPLES`、`DIALOG_TEXT`、类型 | 留在前端；类型 `Tool`、`McpServer`、`SavedSecret` 从 shared 来 |

### 4.9 浏览器（`pages/browsers/*`）

| 文件 | 原型读的 | 现在 |
|---|---|---|
| `index.tsx` | `browserProfiles`、`accountStatusLabel`、`staffName`、`recentRunsUsing`、`limitText`、`proxyText`、`problemCount`、`siteKey`、`platformName`、`proxyRows`、`vaultRows` | `browsers.list`、`platforms.list`、`sessions.list`、`tasks.list`、`staff.list`。`recentRunsUsing(browserId, runs, tasks)`、`limitText`、`proxyText`、`problemCount`、`siteKey` 在 shared；`platformName` = `platforms.find(...)?.name ?? id`；`vaultRows` 里的 `updatedAt` 用 `fmtDateTime`，`lastLoginAt` 同理 |
| `browser-view-dialog.tsx` | `platforms`、`LOGIN_URL`、`HOME_URL` | `platforms.list`；网址常量留在前端 |
| `browser-dialog.tsx`、`site-limit-dialog.tsx` | `blankProfile`、`MAX_ITEMS` | 留在前端 |

### 4.10 模型（`pages/models/*`）

| 文件 | 原型读的 | 现在 |
|---|---|---|
| `index.tsx` | `initialProviders`、`modelDefaults`、`modelFamily`、`sameFamily`、`KIND_LABEL`、`ROLES`、`contextText`、`priceText`、`defaultsAfterRemove`、`tasksOnProvider`、`connectionRows` | `models.overview`（`providers` 就是原型的 `Provider[]`，`defaults`）、`tasks.list`。`tasksOnProvider` = `tasks.filter((t) => provider.models.some((m) => m.id === t.modelId))`。注意 `status: "unconfigured"`（见 3.1） |
| `provider-dialog.tsx` | `DEFAULT_URL`、`KIND_LABEL`、`newProvider` | 留在前端（`KIND_LABEL` 也可以用 shared 的 `providerKindLabel`） |

### 4.11 shared 里的函数

| 函数 | 签名 | 原型 |
|---|---|---|
| `findById` | `(list, id)` | 同 |
| `staffName` | `(staff, id)` | `staffName(id)` |
| `toolName` | `(tools, id)` | `toolName(id)` |
| `modelName` | `(models, id)`；`allModels(providers)` 先拼出全部模型 | `modelName(id)` |
| `modelFamily`、`sameFamily` | 同 | 同（`ollama/llama3.3:70b` → Meta、`ollama/qwen3:32b` → 阿里通义 有回归测试） |
| `contextText`、`priceText`、`defaultsAfterRemove` | 同 | models/data.ts |
| `triggerText` | `(trigger)` | 同（时间按上海时间显示） |
| `runNow` | `(run, humanItems, staff)` | tasks/parts.tsx |
| `checkpointSummary`、`nextRunText`、`suspendedRun(runs, taskId)` | | tasks/parts.tsx、todos/sheets.tsx |
| `boardCards` | `({ runs, tasks, humanItems, humanTodos })` | `boardCards()` |
| `needsMeCount` | `(humanItems, userId, isAdmin)` | 同（页面直接用 `me.needsMeCount` 也行） |
| `alwaysOnToolIds` | `(tools)` | `ALWAYS_ON_TOOL_IDS` |
| `toolIdsOfTask` | `(task, alwaysOnIds)` | `toolIdsOfTask(task)` |
| `tasksUsing` | `(tasks, field, id, alwaysOnIds?)` | `tasksUsing(field, id)` |
| `runsOfTask`、`latestRun` | `(runs, taskId)` | 同 |
| `memoryCategory` | 同 | 同 |
| `recognizeCheckpoints` | 同 | lib/checkpoint.ts |
| `siteKey`、`limitText`、`proxyText`、`problemCount`、`recentRunsUsing(browserId, runs, tasks)` | | browsers/data.ts |
| `groupOf`、`sortRuns`、`pausedMs`、`duration`、`endedText`、`startText(iso, now?)`、`isToday(run, now?)` | | sessions/data.ts |
| `fmtDateTime`、`fmtDate`、`fmtShort`、`fmtClock`、`eventTimeText`、`relativeDayText`、`shanghaiToIso`、`addDaysIso` | | 新增，见 2.2 |
| `can` | `(user, action, resource)` | 新增，见 2.4 |

## 5. 实时推送

- 订阅：`trpc.live.onChange.useSubscription(undefined, { onData })`（或 `@trpc/tanstack-react-query` 的 `subscriptionOptions`）。每条数据是 `{ table: string; id: string | null }`，外面包着 tracked 的 id（`onData` 拿到的是 `{ id, data }`）。
- 数据源：库里的触发器在业务表增删改时 `NOTIFY heyagent_changes`，内容 `{ table, id }`；API 进程 `LISTEN` 后推给订阅的页面。关联表的 `id` 是它所属对象的 id（例如 `session_events` 推的是 session id）。
- **断线续传**：每条带 `tracked(id)`，`httpSubscriptionLink` 断线重连时自动带上最后收到的 id，服务端补发漏掉的。补不齐（API 重启过、断太久）时推一条 `{ table: "*", id: null }`。`pnpm db:seed` 灌完也会推一条 `table: "*"`。
- **前端怎么处理**：用 shared 的 `queriesForTable(table)` 拿到要失效的查询路径（例如 `sessions` → `["sessions.list", "sessions.get"]`），对这些路径调 `queryClient.invalidateQueries`；返回 `null`（`"*"` 或不认识的表）就全部失效。一次操作可能连着推好几条，建议攒 200～300 ms 再统一失效。完整对照表在 `packages/shared/src/live.ts` 的 `liveQueriesByTable`。
- 服务端每 15 秒发一次 SSE 心跳；客户端 30 秒没收到任何东西会自动重连。
- 演示：
  - `pnpm dev:notify sessions R-1024-1`：手动发一条；
  - 直接改库：`scripts/dev-db.sh psql` 里执行 `update sessions set status = 'running' where id = 'R-1035-1';`，订阅的页面马上收到 `{ table: "sessions", id: "R-1035-1" }`。

## 6. 开发环境

```bash
cp .env.example .env              # 第一次
scripts/dev-kek.sh                # 生成 .dev/kek（主密钥）
scripts/dev-db.sh up              # 起开发数据库（heyagent、heyagent_test 两个库）
pnpm install
pnpm db:migrate
pnpm db:seed                      # 可以重复执行：每次先清空业务表再灌
pnpm dev                          # API：http://localhost:3100
```

- `pnpm test` 会清空并重建 `heyagent_test` 库，不碰开发库。
- 镜像：`podman build -f deploy/api.Containerfile -t heyagent-api .`。容器启动时先执行迁移，`HEYAGENT_SEED_DEMO=1` 时再灌演示数据，然后起 API。要的环境变量同 `.env.example`；`HEYAGENT_KEK_FILE` 指向挂进来的主密钥文件（M0 的 API 进程不解密任何东西，只有种子脚本用到主密钥）。
- 主密钥怎么挂进容器（实测）：容器里以 `node` 用户（uid 1000）运行。直接 `-v .dev/kek:/run/secrets/kek:ro` 挂进去会 `EACCES`，因为 `.dev/kek` 权限是 600，rootless Podman 下容器的 uid 1000 映射到的不是宿主机的你。两种可行的办法：
  - `podman secret create heyagent-kek .dev/kek`，再 `--secret heyagent-kek`，文件出现在 `/run/secrets/heyagent-kek`，权限 0444，能读（推荐，和服务器上一致）；
  - 或者 `--userns=keep-id`，让容器里的 uid 1000 就是宿主机的你。

## 7. 和原型契约的差异汇总

1. 所有时间字段改成 ISO 8601（UTC）字符串，显示用 shared 的格式化函数（2.2）。
2. 原型分散在页面 `data.ts` 里、按 id 查的补充数据合并进了对象：`HumanItem.detail`、`MemoryRef.note`、`Skill.version/updatedAt/body`、`Tool.description`。
3. 新增字段（都是可选或补充，不影响原有字段）：`Me.email/needsMeCount`、`RunEvent.seq`、`SessionRun.parentSessionId`、`HumanItem.memoryId/skillId`、`MemoryRef.reviewItemId`、`Skill.suggestion.itemId`、`RuleRef.compiledTrigger`、`ModelInfo.vision`、`BrowserSite.accountId/probeUrl/saveIndexedDb`、`BrowserProxy.hasPassword`、`BrowserProfile.timezone/locale`、`SavedSecret.byId`。
4. `ModelProvider.status` 多了 `"unconfigured"`，这时 `checkedAt`、`latencyMs` 省略（原型里这两个是必填）。
5. `McpServer.env` 只给「名字=••••」，`ModelProvider.apiKeyMasked` 只给掩码；代理密码、保险箱内容不返回。
6. 记忆审核、技能修改的待办 id 以后不再等于记忆 / 技能 id，请用 `reviewItemId`、`suggestion.itemId` 关联（种子数据里两者仍然相同，所以现在不改也能工作）。
7. `tasks.list` 按创建时间倒序，`memories.list` 按 id，`todos.board.humanItems` 按急迫程度再按时间；原型数组的顺序是手写的，部分列表的初始顺序会和原型略有不同（任务页本来就按状态重排）。
