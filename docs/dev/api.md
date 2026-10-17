# HeyAgent 接口说明

> 2026-10-17，分支 `m1-session-engine`，M1 P3。以工作区里的代码为准（含 P3 里还没提交的改动，例如 `engine.runTodoNow`、`settings` 表的实时推送触发器）。
> 写给 M2、M3 的开发者：不翻代码就能对接后端。覆盖当前全部接口：tRPC（查询、配置写、engine、实时推送共 86 个 procedure）、文件（2 个 HTTP 路由）、外部事件（1 个）、健康检查和登录。
> 和 `docs/dev/m0-api.md` 的关系：M0 那份写的是「只读阶段」，里面「M0 没有任何写接口」已经过时，接口清单以本文为准。它的第 2 节（前端怎么接、时间、权限、加载状态）、第 3.1 节（返回形状和原型的差异）、第 4 节（页面到接口的对照）、第 5 节（实时推送）仍然有效，本文不重复，只在冲突时以本文和代码为准。

## 目录

1. 通用约定
2. 健康检查和登录
3. 查询（只读）
4. 配置写
5. engine（运行、待办、附件、通知）
6. 文件（HTTP）
7. 外部事件（HTTP）
8. 实时推送
9. 附录：审计 action 一览、已知限制

---

## 1. 通用约定

### 1.1 地址和鉴权

| 项 | 值 |
|---|---|
| API | `http://<host>:3100`（`PORT` 可改）。前端始终同源访问 `/api`：开发时 Vite（5180）代理到 3100，整套 pod 里由 Caddy（8080）转发，不需要 CORS |
| 登录态 | better-auth 的会话 cookie（`better-auth.session_token`，HttpOnly，7 天；HTTPS 下名字以登录响应的 `Set-Cookie` 为准） |
| 例外 | `GET /api/health` 不要登录；`POST /api/events` 不用 cookie，用事件令牌（第 7 节） |
| 其余所有接口 | 必须登录。没登录：tRPC 返回 HTTP 401 / `UNAUTHORIZED`，文件接口返回 401 `{"error":"请先登录"}` |

「谁能调」一列里：**员工**指普通账号，**主管**指 `role = admin` 的账号（`Me.isAdmin = true`）。

### 1.2 tRPC 的 HTTP 调法

路径是 `/api/trpc/<命名空间>.<名字>`，例如 `/api/trpc/tasks.get`、`/api/trpc/engine.notifications.list`（engine 下还有一层 `notifications`）。**没有 transformer**：输入输出都是普通 JSON，时间是字符串，没有 Date、Map。

| 类型 | 调法 |
|---|---|
| query | `GET /api/trpc/<path>?input=<URL 编码的 JSON>`。没有输入（或输入全可选且不传）时可以省略 `input` |
| mutation | `POST /api/trpc/<path>`，`Content-Type: application/json`，body 是输入 JSON。没有输入的 mutation（`settings.regenerateEventToken`、`settings.clearEventToken`）也要带一个合法的 JSON body，例如 `{}`；空 body 会解析失败 |
| subscription | `GET /api/trpc/live.onChange`，带 `Accept: text/event-stream`（SSE），见第 8 节 |
| 批量 | `httpBatchLink` 把同一时刻的多个调用合成一个请求，路径用逗号连接并加 `batch=1`：`GET /api/trpc/me.get,tasks.list?batch=1&input={"0":{},"1":{}}`；mutation 同样 `POST /api/trpc/a.x,b.y?batch=1`，body 是 `{"0":<输入 0>,"1":<输入 1>}`。返回一个数组，顺序和请求一致，每一项是 `{"result":{"data":…}}` 或 `{"error":…}`；各项状态码不一致时整体 HTTP 状态是 207，要逐项看 |

成功响应：`{"result":{"data":<输出>}}`。出错响应（没有调用栈）：

```json
{"error":{"message":"找不到任务 T-9999","code":-32004,"data":{"code":"NOT_FOUND","httpStatus":404,"path":"tasks.get"}}}
```

curl 示例（cookie 用占位符；`<COOKIE>` 是登录后拿到的 `better-auth.session_token` 值）：

```bash
# 登录，把 cookie 存到文件（带 Origin，见 2.2）
curl -i -c cookies.txt -H 'content-type: application/json' -H 'Origin: http://localhost:5180' \
  -d '{"email":"<EMAIL>","password":"<PASSWORD>"}' http://localhost:3100/api/auth/sign-in/email

# query：--get + --data-urlencode 会把 input 拼进查询串并做 URL 编码
curl -s -b 'better-auth.session_token=<COOKIE>' --get http://localhost:3100/api/trpc/tasks.get \
  --data-urlencode 'input={"id":"T-1042"}'

# mutation：立即运行一个任务
curl -s -b 'better-auth.session_token=<COOKIE>' -H 'content-type: application/json' \
  -d '{"taskId":"T-1042","note":"这次只处理新数据"}' http://localhost:3100/api/trpc/engine.runNow
# → {"result":{"data":{"sessionId":"R-1042-3"}}}
```

前端用 `@trpc/client` 的 `httpBatchLink` + `httpSubscriptionLink`（`apps/web/src/lib/trpc.ts`），页面里写 `useQuery(trpc.tasks.list.queryOptions())`；写操作用 `lib/mutations.ts` 的 `useAction`（成功后让所有查询失效，出错弹 toast）。

### 1.3 错误码

| tRPC 码 | HTTP | 出现的情况 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 没登录或会话过期（`请先登录`） |
| `FORBIDDEN` | 403 | `can()` 不通过。`message` 是给人看的中文，例如「只有主管能新建任务」 |
| `NOT_FOUND` | 404 | id 对不上 |
| `BAD_REQUEST` | 400 | 输入不合 zod schema（`message` 是 zod issue 数组的 JSON 字符串，前端 `errorMessage()` 会取出里面的 `message`）；业务校验不过（明文密钥、模型同一家、状态不对等） |
| `CONFLICT` | 409 | 被别的东西用着不能删、已存在、已经处理过、状态竞争。`message` 里写清了是谁在用（例如「正被 2 个任务选用：T-1「…」」） |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | mutation 没带 `Content-Type: application/json` |
| `METHOD_NOT_SUPPORTED` | 405 | 用 GET 调 mutation，或用 POST 调 query |
| `INTERNAL_SERVER_ERROR` | 500 | 没预料到的错误（服务端日志里有栈，响应里没有）；query 的输出对不上 schema 也是这个 |

后面各表的「主要错误」只列这个接口特有的；所有 procedure 都可能 `UNAUTHORIZED`，所有带输入的都可能 `BAD_REQUEST`（输入校验），不再重复。

### 1.4 id、时间、金额、密钥

| 项 | 约定 |
|---|---|
| id | 可读文本，界面上直接显示（`packages/shared/src/ids.ts`）：任务 `T-1042`；运行（session）手动 / 待办 / 事件触发 `R-<任务号>-<第几次>`（`R-1024-1`），cron 触发 `R-<任务号>-<MMDD 上海日期>`（`R-1040-1016`，同天第二次加 `-2`）；记忆 `m-011`；技能 `sk-<英文短名>` 或 `sk-<序号>`；规则 `rl-…`；MCP 服务器 `mcp-…`；Chrome `br-…`；浏览器账号 `acc-<Chrome 短名>-<平台>`；要人办的事 `ap-/vf-/lg-/mr-/ss-<两位以上序号>`（审批 / 验收 / 登录 / 记忆审核 / 技能修改）；人加的待办 `td-09`；模型服务 `<类型>-<序号>`（第一个就是类型名，如 `openrouter`），模型 `<服务 id>/<模型名>`；文件 `f-<16 位十六进制>`；通知和审计是整数。种子数据沿用原型的 id，所以不要假设「新建的都符合上面的格式」 |
| 时间 | **输出一律 ISO 8601（UTC）字符串**，如 `2026-10-16T01:12:00.000Z`；界面按上海时间（+08:00，固定偏移）显示，用 `@heyagent/shared` 的 `fmtDateTime` 等（见 m0-api 2.2）。输入里的时间只有两处：待办的 `at`（上海时间 `YYYY-MM-DDTHH:mm`，或带时区的 ISO）和 cron（5 段，按上海时间算） |
| 空值 | 库里为空的字段在输出里直接省略，不会出现 `null`（`ChangeEvent.id` 是例外） |
| 金额 | `costUsd` 是美元；模型价格 `priceIn/priceOut` 是每百万 token 的美元数 |
| 密钥 | 任何接口都不返回密钥原文：模型 key 只给掩码（`apiKeyMasked`），MCP 环境变量只给「名字=••••」，代理密码只给 `hasPassword`，通知渠道地址只给 `urlMasked`，事件令牌只在生成时返回一次、之后只给尾号 `hint`。写接口里「值不填 = 保留已存的值」 |
| 平台通用 | 接口和字段里没有任何业务概念（岗位、平台名、客户……）。业务全部是配置：任务、技能、记忆、规则、工具、浏览器 |

### 1.5 权限

`can(user, action, resource)` 在 `packages/shared/src/permissions.ts`，前后端共用。**主管对所有动作恒为 true**；员工的规则：

| action | 员工能做的 | 资源参数 |
|---|---|---|
| `view` | 能（员工能看全部） | 无 |
| `task.create` | 不能 | 无 |
| `task.manage` | 自己负责的任务 | `ownerId` |
| `session.resume` | 自己负责任务的运行 | `taskOwnerId` |
| `humanItem.resolve` | 分给自己的 | `assigneeId` |
| `todo.create` | 给自己负责的任务加 | `taskOwnerId` |
| `todo.run` | 自己加的，或自己负责任务下的 | `createdById`、`taskOwnerId` |
| `todo.manage` | 自己加的 | `createdById` |
| `browser.login` | 能（员工和主管都能用） | 无 |
| `config.manage` | 不能 | 无 |
| `user.manage` | 不能 | 无 |
| `settings.manage` | 不能 | 无 |

后端按它拒绝请求（`FORBIDDEN`），前端按它显示或隐藏按钮，所以前端 `can(me, …)` 的结果和后端一致。查询没有按角色过滤，只有 `users.list` 和 `settings.get` 要求主管。

### 1.6 写操作的共同点

- 配置类写操作在**一个事务**里完成「改数据 + 记审计」，任何一步失败整体回滚。审计写进 `audit_events`（谁、action、目标表、目标 id、detail），**detail 里不放密钥原文**。各接口的 action 名见下面各表和附录。
- 写成功后，库里的触发器会 `NOTIFY` 变化的表，所有登录的页面通过 `live.onChange` 收到（第 8 节）。下面各表的「推送」列写的是会推的表名。
- 定时相关的写（任务的 cron、待办）保存后会调引擎同步 pg-boss（`syncTaskSchedule`、`syncTodo`）。API 进程只**发任务**，真正跑 agent 的是 worker 进程。
- `update` 类接口是**整体替换**，不是补丁：任务、技能、规则的字段和关联列表都要完整传。

---

## 2. 健康检查和登录

### 2.1 `GET /api/health`

不要登录。`200 {"ok":true,"db":"ok"}`；数据库连不上 `503 {"ok":false,"db":"down"}`。

### 2.2 `/api/auth/*`（better-auth 1.7.10）

邮箱 + 密码，加 admin 插件（`role = "admin"` 是主管）。**公开注册已关闭**，账号只能由主管用 `users.create` 建。前端封装在 `apps/web/src/lib/auth.ts`。

| 操作 | 请求 | 说明 |
|---|---|---|
| 登录 | `POST /api/auth/sign-in/email`，JSON `{ "email", "password" }` | 成功 200 并 `Set-Cookie`。密码错 401；`Origin` 不在 `TRUSTED_ORIGINS` 里 403；尝试太多 429。停用（banned）的账号登不上 |
| 退出 | `POST /api/auth/sign-out` | 清 cookie |
| 当前会话 | `GET /api/auth/get-session` | 没登录返回 `200 null`（不像 tRPC 查询回 401），外壳用它判断显示登录页 |
| 当前用户（页面用） | tRPC `me.get` | 比 get-session 多职位、`isAdmin`、`needsMeCount` |

- better-auth 会校验 `Origin`：带会话 cookie 的 POST（退出）必须带 `Origin`，且在 `TRUSTED_ORIGINS` 里（浏览器自动带；curl 要自己加 `-H 'Origin: http://localhost:5180'`，否则 403 `MISSING_OR_NULL_ORIGIN`）。内网用别的地址访问时，把它加进 `.env` 的 `TRUSTED_ORIGINS`（逗号分隔）。
- `auth.handler` 挂了 better-auth 的全部内置路由（`GET`/`POST /api/auth/*`），但**控制台只用上表几个**；账号管理一律走 tRPC 的 `users.*`、`me.changePassword`，它们会补审计和「至少留一个主管」之类的校验，别直接调 better-auth 的 admin 路由。

---

## 3. 查询（只读）

均为 `query`，都要求登录。返回形状是 `packages/shared/src/schemas.ts` 里同名 schema，输出经 zod 校验。和原型字段的差异见 m0-api 3.1。

| 接口 | 谁能调 | 输入 | 返回 | 错误 / 说明 |
|---|---|---|---|---|
| `me.get` | 登录即可 | 无 | `Me`：`id name title isAdmin email needsMeCount`。`needsMeCount` = 等我处理的事，主管算全部未处理的，员工只算分给自己的 | `NOT_FOUND`（用户被删了） |
| `staff.list` | 登录即可 | 无 | `Staff[]`：`id name title isAdmin`。全部的人，用来把 id 显示成名字 | |
| `platforms.list` | 登录即可 | 无 | `Platform[]`：`id name`，按 position | |
| `tasks.list` | 登录即可 | 无 | `TaskDef[]`，新建的在前。字段：`id title goal steps[]{id text wait checkpoint?} ownerId createdAt enabled schedule?{cron text} nextRunAt? modelId memoryIds skillIds toolIds ruleIds`。`toolIds` 不含每个任务都自带的内置工具 | |
| `tasks.get` | 登录即可 | `{ id }` | `TaskDef` | `NOT_FOUND` |
| `sessions.list` | 登录即可 | `{ taskId? }`（可整个省略） | `SessionRun[]`，开始时间新的在前 | 见下面「SessionRun」 |
| `sessions.get` | 登录即可 | `{ id }` | `SessionRun` | `NOT_FOUND` |
| `todos.board` | 登录即可 | 无 | `{ humanItems: HumanItem[]; humanTodos: HumanTodo[] }`：还没处理的「要人办的事」（按急迫程度 `urgency` 小的在前，再按时间）和有效的「人加的待办」（新的在前） | 运行卡不在这里，用 `sessions.list` + shared 的 `boardCards` 拼 |
| `memories.list` | 登录即可 | 无 | `MemoryRef[]`，按 id。含已拒绝、已归档的，页面自己筛。`note.lastUsed` 是服务端按当前时间生成的文字；待审核的带 `reviewItemId` | |
| `skills.list` | 登录即可 | 无 | `Skill[]`：带 `version updatedAt body toolIds`，有待审核的修改建议时带 `suggestion{taskId summary reviewerId createdAt itemId?}` | |
| `rules.list` | 登录即可 | 无 | `RuleRef[]`：`id name trigger action toolIds compiledTrigger?`（`compiledTrigger` 是 M3 填的） | |
| `tools.list` | 登录即可 | 无 | `{ tools: Tool[]; mcpServers: McpServer[]; savedSecrets: Record<名字, {by byId at}> }`。HTTP 工具的模板里密钥只以 `{{名字}}` 出现；`McpServer.env` 是每行「名字=••••」 | |
| `browsers.list` | 登录即可 | 无 | `BrowserProfile[]`：代理（无密码，只有 `hasPassword`）、`sites[]`（账号、状态、并发上限、`running` = 没释放的账号租约数）、`vaultVersion`、`cookieCount` | |
| `models.overview` | 登录即可 | 无 | `{ providers: ModelProvider[]; defaults: {run plan verify} }`。`status` 有 `ok / error / unconfigured`；`apiKeyMasked` 只有掩码 | |
| `users.list` | **主管**（`user.manage`） | 无 | `UserAccount[]`：`id name email title isAdmin disabled createdAt`，按创建时间 | `FORBIDDEN` |
| `settings.get` | **主管**（`settings.manage`） | 无 | `SettingsView`：`maxCostUsd maxSteps eventFallbackDays eventToken?{hint createdAt} channels[]{id name kind urlSecretName enabled urlMasked?}`。没配过的设置返回默认值（2 美元、100 步、7 天） | `FORBIDDEN` |

另有 3 个 engine 下的查询（`engine.taskAttachments`、`engine.sessionFiles`、`engine.notifications.list`），放在第 5 节。

### SessionRun

`sessions.list`/`get` 的一条（一次运行 = 一个 session）：`id taskId parentSessionId? startedAt endedAt? status modelId tokensIn tokensOut costUsd exploredSteps? checkpoints[] events[] waiting? verification?`。

| 字段 | 说明 |
|---|---|
| `status` | `running`（执行中）、`waiting`（挂起等时间或事件）、`needs_human`（等人处理）、`verifying`、`done`、`failed` |
| `checkpoints[]` | `title kind target? stepId? status(done/open/skipped) progress? records[]{at text synced} skipReason?` |
| `events[]` | 过程事件，按 `seq`（session 内从 1 递增）排。`kind`：`plan think tool checkpoint rule wait resume human verify done error`；工具调用带 `toolId input output ms tokensIn tokensOut`（输入输出各最多 5 万字符，更长的截断） |
| `waiting` | 挂起时才有：`{ what, trigger, since }`，`trigger` 是 `time / cron / event / time_or_event` 之一（带 `at`、`event`、`fallbackDays` 等） |
| 失败原因 | **没有单独的 `error` 字段**，在 `kind = "error"` 的事件里（取消、花费 / 步数上限被拒、模型出错都是这样） |
| 触发来源 | 不在 `SessionRun` 里；快照里有 `source`（`manual / cron / todo / event`），第一条 `plan` 事件的 detail 里也写了 |

`sessions.list` 一次返回**全部** session 和它们的全部事件（没有分页）。session 多了以后会变重，需要时按 `taskId` 筛，或另行加分页。

---

## 4. 配置写

均为 `mutation`。除特别说明外：写在事务里，同时记审计；输入 schema 在 `packages/shared/src/config.ts`（前端表单也用它校验）；逻辑在 `apps/server/src/data/config/*.ts`。字符串输入都会先 `trim`，必填的至少 1 个字。

### 4.1 账号

| 接口 | 谁能调 | 输入 | 返回 | 主要错误 | 审计 / 推送 |
|---|---|---|---|---|---|
| `me.changePassword` | 登录即可（改自己的） | `{ currentPassword, newPassword }`，新密码 8 到 128 位 | `{ ok: true }` | `BAD_REQUEST`：新旧一样、现在的密码不对 | `user.change_password`；其他设备上的会话作废，当前会话保留；不推送 |
| `users.create` | 主管（`user.manage`） | `{ email, name(≤50), title(≤50，默认空), role: "admin" 或 "user", password(8-128) }`，邮箱转小写 | `{ id }` | `FORBIDDEN`；`BAD_REQUEST`：邮箱已有账号、格式不对 | `user.create`；推 `users` |
| `users.update` | 主管 | `{ id, name, title, role }` | `{ id }` | `NOT_FOUND`；`BAD_REQUEST`：不能取消自己的主管身份、不能把最后一位主管改成员工 | `user.update`；推 `users` |
| `users.setDisabled` | 主管 | `{ id, disabled }` | `{ id, disabled }` | `NOT_FOUND`；`BAD_REQUEST`：不能停用自己、不能停用最后一位主管 | `user.disable` / `user.enable`；停用 = better-auth ban，已登录的会话立刻失效；推 `users` |
| `users.resetPassword` | 主管 | `{ id, password(8-128) }` | `{ id }` | `NOT_FOUND` | `user.reset_password`；目标用户的所有会话作废（重置自己的除外）；不推送 |

账号类写操作经 better-auth admin 插件的服务端接口，用请求里的 cookie 认人，better-auth 自己的报错会被换成中文并映射成 `FORBIDDEN` / `BAD_REQUEST`。

### 4.2 任务和待办

**任务输入**（`taskInputSchema`，新建和修改共用，修改多一个 `id`）：

| 字段 | 类型 | 必填 | 限制 / 说明 |
|---|---|---|---|
| `title` | string | 是 | 1 到 200 字：一句话要 agent 做什么 |
| `goal` | string | 是 | 1 到 1000 字：做到什么算完成（三方 AI 按它验收） |
| `steps` | array | 是 | 最多 50 项，可以是空数组。每项 `{ id?, text(1-500), wait: boolean, checkpoint?(≤500) }`。`id` 不填按 `s1、s2…` 生成，重复会自动改名；`wait` 表示这一步允许挂起；`checkpoint` 的文字会被 `recognizeCheckpoints` 识别成检查点（访问页面、发消息、数量、产物、确认、备注） |
| `modelId` | string | 否 | 不填（或空串）用默认「执行」模型 |
| `ownerId` | string | 否 | 负责人，不填是自己。**只有新建时生效**；修改时只有主管能改负责人，员工传了会被忽略 |
| `schedule` | `{ cron, text? } 或 null` | **是**（必须带这个键，`null` = 只跑一次） | `cron` 是 5 段（分 时 日 月 周，上海时间），不合法会 `BAD_REQUEST`；`text` ≤100，不填就用 cron 原文 |
| `enabled` | boolean | 否 | 默认 `true`。关掉就不会运行，也不会按定时运行 |
| `memoryIds` `skillIds` `toolIds` `ruleIds` | string[] | 否 | 默认空，各最多 200 个，都要存在。只有 `active` 的记忆、`published` 的技能会在运行时进快照；每个任务自带的内置工具不用传（传了也不存） |

| 接口 | 谁能调 | 输入 | 返回 | 主要错误 | 审计 / 推送 / 副作用 |
|---|---|---|---|---|---|
| `tasks.create` | 主管（`task.create`） | 任务输入 | `{ id }`（`T-<序号>`） | `FORBIDDEN`；`BAD_REQUEST`：没有可用模型、模型不存在、执行模型和默认验收模型是**同一家**（`sameFamily`）、记忆 / 技能 / 规则 / 工具 id 不存在、负责人不存在 | `task.create`；推 `tasks` 和 `task_*` 关联表；同步 cron（`syncTaskSchedule`），写 `nextRunAt` |
| `tasks.update` | 负责人或主管（`task.manage`） | 任务输入 + `id` | `{ id }` | `NOT_FOUND`、`FORBIDDEN`、`BAD_REQUEST`（同上） | `task.update`（detail.changed 是改了的字段）；同步 cron；整体替换步骤和四个关联列表。已经在跑的 session 不受影响（它有自己的快照） |
| `tasks.setEnabled` | 负责人或主管 | `{ id, enabled }` | `{ id, enabled }` | `NOT_FOUND`、`FORBIDDEN` | `task.enable` / `task.disable`；同步 cron |
| `tasks.delete` | 负责人或主管 | `{ id }` | `{ id }` | `CONFLICT`：已有运行记录（运行记录要留着查，只能停用） | `task.delete`；取消 cron；关联表和任务附件跟着删 |

**待办输入**（`todoInputSchema`）：`{ taskId, title(1-500), trigger }`，`trigger` 按 `kind` 分四种：

| `kind` | 字段 | 含义 |
|---|---|---|
| `time` | `at` | 到点触发一次。`at` 是上海时间 `YYYY-MM-DDTHH:mm`（datetime-local 的值），也认带时区的 ISO；认不出 `BAD_REQUEST` |
| `cron` | `cron`，`text?`(≤100) | 按 cron 反复触发，待办一直有效 |
| `event` | `event`(1-200)，`fallbackDays`(1-90) | 等外部事件。`fallbackDays` 到期还没等到，只提醒加待办的人和任务负责人，待办还在 |
| `time_or_event` | `at`，`event` | 先到哪个算哪个，触发一次 |

| 接口 | 谁能调 | 输入 | 返回 | 主要错误 | 审计 / 推送 / 副作用 |
|---|---|---|---|---|---|
| `todos.create` | 任务负责人或主管（`todo.create`） | 待办输入 | `{ id }`（`td-<序号>`） | `NOT_FOUND`（任务）、`FORBIDDEN`（只能给自己负责的任务加） | `todo.create`；推 `human_todos`；`syncTodo`：time 排延迟任务，cron 注册定时，event 排兜底提醒 |
| `todos.update` | 加这条的人或主管（`todo.manage`） | 待办输入 + `id` | `{ id }` | `NOT_FOUND`、`FORBIDDEN`；换到别的任务时，新任务也要满足 `todo.create` | `todo.update`；重新 `syncTodo`。已经触发过（`done`）的待办改了也不会重新生效 |
| `todos.delete` | 加这条的人或主管 | `{ id }` | `{ id }` | `NOT_FOUND`、`FORBIDDEN` | `todo.delete`；取消 cron / 延迟任务 |

「立即执行」一条待办是 `engine.runTodoNow`（第 5 节）。

### 4.3 记忆、技能、规则

| 接口 | 谁能调 | 输入 | 返回 | 主要错误 | 审计 / 推送 |
|---|---|---|---|---|---|
| `memories.create` | 主管（`config.manage`） | `{ content(1-1000), appliesTo(1-100) }`（`appliesTo` 写「分类 · 对象」或只写分类） | `{ id }`（`m-<序号>`） | `FORBIDDEN` | `memory.create`；人加的记忆直接 `active`；推 `memories` |
| `memories.update` | 主管 | `{ id, content, appliesTo }` | `{ id }` | `NOT_FOUND`；`CONFLICT`：还在等审核 | `memory.update`；推 `memories` |
| `memories.approve` | 审核人或主管（`humanItem.resolve`，对象是 `reviewerId`；没有审核人的只有主管能批） | `{ id }` | `{ id, status: "active" }` | `NOT_FOUND`、`FORBIDDEN`；`CONFLICT`：已经审核过 | `memory.approve`；同一事务里把待办里对应的那件事标成已处理；推 `memories`、`human_items` |
| `memories.reject` | 同上 | `{ id, reason?(≤500) }` | `{ id, status: "rejected" }` | 同上 | `memory.reject`；同上 |
| `memories.archive` | 主管 | `{ id }` | `{ id }` | `NOT_FOUND`；`CONFLICT`：还在等审核 | `memory.archive`；选用了它的任务下一次运行读不到 |
| `memories.delete` | 主管 | `{ id }` | `{ id }` | `NOT_FOUND`；`CONFLICT`：被任务选用着（提示里列出任务） | `memory.delete` |

记忆审核、技能修改这两类「要人办的事」不能用 `engine.resolveHumanItem` 处理（会 `BAD_REQUEST`：「请在记忆页、技能页处理」），要用 `memories.approve/reject` 和下面的 `skills.acceptSuggestion/rejectSuggestion`。

| 接口 | 谁能调 | 输入 | 返回 | 主要错误 | 审计 / 推送 |
|---|---|---|---|---|---|
| `skills.create` | 主管 | `{ name(1-100), dept(1-50), description(1-300), body(≤50000，SKILL.md 正文，可为空串), toolIds }` | `{ id, version: 1 }`。id 是 `sk-<name 的英文短名>`（重名加 `-2`），全中文名用 `sk-<序号>` | `BAD_REQUEST`：工具不存在 | `skill.create`；新建的是**草稿**（`draft`），发布后建任务才能选；写 `skill_versions`；推 `skills`、`skill_tools` |
| `skills.update` | 主管 | 同上 + `id` | `{ id, version }`（每次保存版本 +1） | `NOT_FOUND`、`BAD_REQUEST` | `skill.update`（detail 有 version、changed）；整体替换 `toolIds` |
| `skills.setStatus` | 主管 | `{ id, status: "published" / "draft" / "disabled" }` | `{ id, status }` | `NOT_FOUND`；`CONFLICT`：改成非 `published` 时被任务选用着 | `skill.publish` / `skill.draft` / `skill.disable`；状态没变就什么都不做（不记审计） |
| `skills.acceptSuggestion` | 审核人或主管（`humanItem.resolve`，对象是建议的 `reviewerId`） | `{ id }`（**技能 id**，不是待办 id） | `{ id, version }` | `NOT_FOUND`；`FORBIDDEN`；`CONFLICT`：没有待审核的建议、或技能在建议之后又被改过，diff 对不上 | `skill.suggestion.accept`；把 diff 合并进正文成新一版；处理掉待办里那件事；推 `skills`、`skill_suggestions`、`human_items` |
| `skills.rejectSuggestion` | 同上 | `{ id, reason?(≤500) }` | `{ id }` | 同上（无 diff 冲突） | `skill.suggestion.reject` |
| `rules.create` | 主管 | `{ name(1-100), trigger(1-500), action(1-500), toolIds }` | `{ id }`（`rl-<短名>` 或 `rl-<序号>`） | `BAD_REQUEST`：工具不存在 | `rule.create`；推 `rules`、`rule_tools` |
| `rules.update` | 主管 | 同上 + `id` | `{ id }` | `NOT_FOUND` | `rule.update`；触发条件文字改了，`compiledTrigger` 清空（M3 重新翻译） |
| `rules.delete` | 主管 | `{ id }` | 被删掉的 `RuleRef`（页面「撤销」时交给 `restore`） | `NOT_FOUND`；`CONFLICT`：被任务选用着 | `rule.delete` |
| `rules.restore` | 主管 | `{ id, name, trigger, action, toolIds }`（就是 `delete` 返回的内容） | `{ id }` | `CONFLICT`：id 已存在 | `rule.restore`；已经不存在的工具 id 会被丢掉 |

### 4.4 工具、密钥、MCP 服务器

内置工具（`source = builtin`）由引擎在启动时同步，**不能改、不能删**。

**HTTP 工具输入**（`httpToolInputSchema`，修改多 `id`）：

| 字段 | 说明 |
|---|---|
| `id?` | 模型里的名字，正则 `^[a-z][a-z0-9_.-]{1,63}$`；新建时不填就按 URL 路径最后一段生成 `http.<段>`；重名自动加 `-2` |
| `name` | 1-100 字 |
| `description` | 1-2000 字：告诉模型什么时候用 |
| `summary?` | ≤200 字；不填取 `description` 的第一句 |
| `http` | `{ method: GET/POST/PUT/PATCH/DELETE, url: 以 http(s):// 开头, headers: Record<string,string>（默认 {}）, body?: ≤50000 字 }`。模板里 `{参数}` 由模型填，`{{名字}}` 是密钥占位符 |
| `risk` | `read / write / external / money` |
| `secrets` | `Record<密钥名, 值>`（默认 {}）：这次新填的密钥值，只进不出；密钥名要符合 `^[A-Z][A-Z0-9_]{0,63}$` 且不能以 `NOTIFY_` 开头 |

保存前的检查（任一不过都是 `BAD_REQUEST`）：URL、请求头、请求体里出现**明文密钥**（`moveSecrets` 认出的 `?key=…`、`Authorization: Bearer …`、`"api_key":"…"`、`sk-…` 之类）；`{{名字}}` 不合密钥名规则；模板引用的 `{{名字}}` 既没存过、这次也没填值。

| 接口 | 谁能调 | 输入 | 返回 | 主要错误 | 审计 / 推送 |
|---|---|---|---|---|---|
| `tools.createHttp` | 主管 | HTTP 工具输入 | `{ id }` | `BAD_REQUEST`（上面几条） | `tool.create`（detail.secretsSet 是这次写入的密钥名）；推 `tools`、`secrets` |
| `tools.updateHttp` | 主管 | 输入 + `id` | `{ id }` | `NOT_FOUND`；`BAD_REQUEST`：目标不是 HTTP 工具（内置不能改，MCP 工具要改它所在的服务器）+ 上面几条 | `tool.update`（detail.changed） |
| `tools.deleteHttp` | 主管 | `{ id }` | 被删掉的 `Tool` | `NOT_FOUND`；`BAD_REQUEST`：不是 HTTP 工具；`CONFLICT`：被任务、规则或技能用着 | `tool.delete`；密钥是全局的，不跟着删 |
| `tools.restoreHttp` | 主管 | `{ id, name, summary, description, http, risk }`（`deleteHttp` 返回的内容） | `{ id }` | `CONFLICT`：id 已存在 | `tool.restore` |
| `tools.createSecret` | 主管 | `{ name, value(1-10000) }` | `{ name }` | `CONFLICT`：已存在（要换值用 `updateSecret`） | `secret.create`；加密存，原文不进审计；推 `secrets` |
| `tools.updateSecret` | 主管 | 同上 | `{ name }` | `NOT_FOUND` | `secret.update`；版本 +1，旧密文作废 |
| `tools.deleteSecret` | 主管 | `{ name }` | `{ name }` | `NOT_FOUND`；`CONFLICT`：工具模板或通知渠道还在引用 | `secret.delete` |

**MCP 服务器输入**（`mcpServerInputSchema`，修改多 `id`）：

| 字段 | 说明 |
|---|---|
| `name` | 1-100 字 |
| `transport` | `stdio`（本机起进程）或 `http`（连地址） |
| `command?` | stdio 必填：启动命令（含参数，按空白和引号拆，不经过 shell），≤2000 字 |
| `url?` | http 必填：以 `http(s)://` 开头 |
| `note` | ≤300，默认空 |
| `env` | `{ name, value? }[]`（≤50）。stdio 是环境变量名（`^[A-Za-z_][A-Za-z0-9_]*$`），http 是请求头名（`^[A-Za-z0-9-]+$`）。**`value` 不填 = 保留服务器上已存的值**（新加的行必须填）；值可以写 `{{名字}}` 引用全局密钥；去掉的行连密文一起删 |
| `tools?` | 连接后读到并勾选的工具 `{ id(^[A-Za-z][A-Za-z0-9_.-]{0,63}$), name, summary, description?, risk }[]`（≤200）。**不传 = 不改工具**；传了就是整体替换（取消勾选的必须没人用） |

命令、地址里出现明文密钥（`hasPlainSecret`）会 `BAD_REQUEST`：放进环境变量 / 请求头，或写 `{{名字}}`。

| 接口 | 谁能调 | 输入 | 返回 | 主要错误 | 审计 / 推送 |
|---|---|---|---|---|---|
| `tools.createMcpServer` | 主管 | MCP 输入 | `{ id }`（`mcp-<短名>`） | `BAD_REQUEST`：缺命令 / 地址、明文密钥、名字格式不对、重复；`CONFLICT`：工具名被别的工具占了 | `mcp_server.create`；新建的 `status` 是 `error`（还没连过），`engine.listMcpServerTools` 连上后改成 `connected`；推 `mcp_servers`、`tools`、`secrets` |
| `tools.updateMcpServer` | 主管 | 输入 + `id` | `{ id }` | `NOT_FOUND`、`BAD_REQUEST`、`CONFLICT`（取消勾选的工具还在被使用） | `mcp_server.update`；**换了 transport**，之前存的环境变量 / 请求头全部删除，要重新填 |
| `tools.deleteMcpServer` | 主管 | `{ id }` | `{ id }` | `NOT_FOUND`；`CONFLICT`：它的工具被使用着 | `mcp_server.delete`；环境变量密文一起删 |

### 4.5 浏览器

**Chrome 输入**（`browserProfileInputSchema`，修改多 `id`）：`name`(1-100)、`description?`(≤500，给 agent 看的说明，它靠这句话选用哪个 Chrome)、`proxy`、`exitIp?`(≤100)、`timezone?`(≤64)、`locale?`(≤32)。`proxy` 是：

- `{ kind: "none" }`；
- `{ kind: "socks5", host(1-200), port(1-65535 整数), username?, password?, clearPassword? }`。密码只加密存；**`password` 不填 = 不改**；`clearPassword: true` 去掉已存的密码；改成 `none` 也会删密码。

| 接口 | 谁能调 | 输入 | 返回 | 主要错误 | 审计 / 推送 |
|---|---|---|---|---|---|
| `browsers.create` | 主管 | Chrome 输入 | `{ id }`（`br-<短名>`）。`exitIp` 不填存「第一次打开时检测」 | `FORBIDDEN` | `browser_profile.create`（detail.passwordSet）；推 `browser_profiles`、`secrets` |
| `browsers.update` | 主管 | 输入 + `id` | `{ id }` | `NOT_FOUND` | `browser_profile.update`（detail.password 是 `set / cleared / kept`）。`exitIp` 不填就保留原值 |
| `browsers.delete` | 主管 | `{ id }` | `{ id }` | `NOT_FOUND`；`CONFLICT`：它的账号还有没释放的租约（有 session 在用） | `browser_profile.delete`；账号、保险箱、代理密码一起删 |
| `platforms.create` | 主管 | `{ name(1-100), id?(^[a-z0-9][a-z0-9-]{0,39}$) }` | `{ id }`（不填按名字生成英文短名） | `CONFLICT`：同名或 id 已被用 | `platform.create`；推 `platforms` |
| `platforms.delete` | 主管 | `{ id }` | `{ id }` | `NOT_FOUND`；`CONFLICT`：平台下还有账号 | `platform.delete` |
| `browsers.createAccount` | 主管 | `{ profileId, platformId, account(1-200), maxConcurrent(1-20，默认 1), probeUrl?(http(s):// 开头，或空串), saveIndexedDb(默认 false) }` | `{ id }`（`acc-<Chrome 短名>-<平台>`，重复加 `-2`） | `NOT_FOUND`（Chrome）；`BAD_REQUEST`（平台不存在）；`CONFLICT`：同一 Chrome 同一平台同一账号已有 | `browser_account.create`；新账号 `status = expired`（要登录），等人在远程画面里登录（M2） |
| `browsers.updateAccount` | 主管 | `{ id, account?, maxConcurrent?, probeUrl?, saveIndexedDb? }`（都是可选，传哪个改哪个） | `{ id }` | `NOT_FOUND` | `browser_account.update`（一个字段都没传就什么都不做、不记审计） |
| `browsers.deleteAccount` | 主管 | `{ id }` | `{ id }` | `NOT_FOUND`；`CONFLICT`：有租约在用 | `browser_account.delete` |

### 4.6 模型

`kind` 只有 `ollama`、`openrouter`。连接服务**不花钱**：OpenRouter 用公开的 `GET /models` 读模型目录（只留 `supported_parameters` 含 `tools` 的模型，因为 agent 每一步都要调工具），有 key 时再 `GET /key` 核对；Ollama 用 `GET /api/tags`。超时 15 秒。

| 接口 | 谁能调 | 输入 | 返回 | 主要错误 | 审计 / 推送 |
|---|---|---|---|---|---|
| `models.createProvider` | 主管 | `{ kind, name?(≤100), baseUrl(http(s)://), apiKey? }`。OpenRouter 必须带 `apiKey`（默认地址 `https://openrouter.ai/api/v1`） | `{ id, check: ProviderCheck }` | `BAD_REQUEST`：没填 key、**连不上**（`message` 是原因，不存）、key 不对 | `model_provider.create`；**先连一次，连上才存**，同时写入模型目录；key 加密存；推 `model_providers`、`models`、`secrets` |
| `models.updateProvider` | 主管 | `{ id, name?, baseUrl, apiKey? }`（`apiKey` 不填沿用已存的） | `{ id, check }` | `NOT_FOUND`、`BAD_REQUEST`（同上） | `model_provider.update`；先用新配置连一次，连上才存并刷新模型列表 |
| `models.testProvider` | 主管 | `{ id }` | `ProviderCheck`：`{ ok, latencyMs?, models?, message }` | `NOT_FOUND`。**连不上不抛错**，返回 `ok: false` 和原因 | `model_provider.test`；写回 `status`（`ok/error`）、`checkedAt`、`latencyMs` |
| `models.refreshProvider` | 主管 | `{ id }` | `ProviderCheck` | 同上（不抛错） | `model_provider.refresh`；只用公开接口、不带 key；成功才更新模型目录。目录里没了的模型会删掉，**除非还是默认模型** |
| `models.deleteProvider` | 主管 | `{ id }` | `{ id, defaults }`（删完后三个角色的默认模型，会自动换成别家的） | `NOT_FOUND`；`CONFLICT`：有任务在用它的模型 | `model_provider.delete`；key 密文一起删 |
| `models.setDefaults` | 主管 | `{ run, plan, verify }`（模型 id，都必填） | 原样返回输入 | `BAD_REQUEST`：执行和验收是**同一家**（验收就不算第三方）、模型不存在 | `model_defaults.update`（detail 有 before / after）；推 `model_defaults` |

### 4.7 全局设置

| 接口 | 谁能调 | 输入 | 返回 | 主要错误 | 审计 / 推送 |
|---|---|---|---|---|---|
| `settings.updateLimits` | 主管（`settings.manage`） | `{ maxCostUsd(0.01-1000), maxSteps(1-10000 整数), eventFallbackDays(1-90 整数) }`，三个都必填 | 原样返回输入 | `FORBIDDEN` | `settings.update`（detail 有 before / after）；推 `settings`。引擎每一步都重新读这三个值，所以改了立即对所有运行生效；只有人批准「花费 / 步数到上限继续」后被单独调高过上限的 session，用的是自己的上限 |
| `settings.regenerateEventToken` | 主管 | 无（body 给 `{}`） | `{ token, hint, createdAt }`。`token` 形如 `hae_<32 位 base64url>`，**原文只在这次返回**，库里只存 sha256；`hint` 是最后 4 位 | `FORBIDDEN` | `settings.event_token.regenerate`；旧令牌立刻失效；推 `settings` |
| `settings.clearEventToken` | 主管 | 无（body 给 `{}`） | `{ ok: true }` | `FORBIDDEN` | `settings.event_token.clear`；之后 `POST /api/events` 一律 401 |
| `settings.saveChannel` | 主管 | `{ id?, name(1-50), kind: "feishu" / "wecom" / "webhook", url?, enabled(默认 true) }`。新建不带 `id`，必须带 `url`；修改带 `id`，`url` 不填 = 不改 | `{ id }`（`ch-<6 位十六进制>`） | `NOT_FOUND`（渠道）；`BAD_REQUEST`：新建没填地址 | `settings.channel.create` / `settings.channel.update`；地址加密存进 `secrets`（名字 `NOTIFY_<渠道 id>_URL`，所以密钥名不能以 `NOTIFY_` 开头）；推 `settings`、`secrets` |
| `settings.deleteChannel` | 主管 | `{ id }` | `{ id }` | `NOT_FOUND` | `settings.channel.delete`；地址密文一起删 |

通知渠道怎么推：引擎发通知时，除了写站内通知，还会把文字 POST 给**所有启用的渠道**（失败只记日志，不影响站内通知）。`feishu` 发 `{ msg_type: "text", content: { text } }`，`wecom` 发 `{ msgtype: "text", text: { content } }`，`webhook` 发 `{ title, body, link, taskId, sessionId, at }`。

---

## 5. engine（`appRouter.engine`）

运行（session）由 API 进程**发任务**、worker 进程**执行**：下面这些接口返回时 agent 往往还没开始跑，进度通过 `sessions.get` + 实时推送（`sessions`、`session_events` 等表）看。代码在 `apps/server/src/trpc/engine-router.ts`，引擎逻辑在 `apps/server/src/engine/*.ts`。

| 接口 | 类型 | 谁能调 | 输入 | 返回 |
|---|---|---|---|---|
| `engine.runNow` | mutation | 任务负责人或主管（`task.manage`） | `{ taskId, attachmentFileIds?: string[]（≤20）, note?: string（≤2000）}` | `{ sessionId }` |
| `engine.runTodoNow` | mutation | 加这条待办的人、任务负责人或主管（`todo.run`） | `{ todoId }` | `{ resumedSessionId?, startedSessionId? }`（二选一） |
| `engine.cancel` | mutation | 任务负责人或主管（`task.manage`） | `{ sessionId, reason?: string（≤500）}` | `{ sessionId }` |
| `engine.resumeNow` | mutation | 任务负责人或主管（`session.resume`） | `{ sessionId }` | `{ sessionId }` |
| `engine.resolveHumanItem` | mutation | 分给他的人或主管（`humanItem.resolve`） | `{ itemId, how: "approve" / "reject" / "done", note?: string（≤4000）}` | `{ resumedSessionId?, endedSessionId? }` |
| `engine.fireEvent` | mutation | 主管（`config.manage`） | `{ event: 1-200 字, data?: 对象 }` | `{ resumedSessionIds: string[], firedTodoIds: string[] }` |
| `engine.taskAttachments` | query | 登录即可 | `{ taskId }` | `SessionFile[]` |
| `engine.attachToTask` | mutation | 任务负责人或主管（`task.manage`） | `{ taskId, fileId }` | `SessionFile`（`scope: "task"`） |
| `engine.detachFromTask` | mutation | 任务负责人或主管 | `{ taskId, fileId }` | `{ ok: true }` |
| `engine.sessionFiles` | query | 登录即可 | `{ sessionId }` | `SessionFile[]` |
| `engine.listMcpServerTools` | **mutation** | 主管（`config.manage`） | `{ serverId }` | `{ ok, tools: {name description inputSchema}[], error?, serverName? }` |
| `engine.notifications.list` | query | 登录即可（只看自己的） | `{ limit?: 1-200（默认 50）, unreadOnly?: boolean }`，可整个省略 | `{ items: Notification[], unread: number }` |
| `engine.notifications.markRead` | mutation | 登录即可（只动自己的） | `{ ids?: number[]（≤500）}`，不给 `ids` = 全部标已读 | `{ updated: number }` |

### 5.1 `engine.runNow`

- 流程：校验任务和附件 → 在一个事务里**冻结快照**（任务当时的步骤、模型、记忆、技能、工具、规则、检查点、附件清单；之后改任务不影响这次运行）→ 建 session（状态 `running`）、检查点、第一条消息和 `plan` 事件 → 排进 `session.run` 队列。
- 错误：`NOT_FOUND`（任务；附件 id 不存在）；`FORBIDDEN`（「只有任务负责人和主管能运行这个任务」）；`BAD_REQUEST`：任务已停用（先启用）、附件「已经用在别处，请重新上传」。
- 附件规则：`attachmentFileIds` 里的文件要么是刚上传、还没用过的（`kind = upload`、没有 `sessionId` 和 `taskId`），要么本来就是这个任务的附件；重复 id 会去重。刚上传的文件会变成这次运行的附件（`kind → attachment`、`sessionId` 写成新 session）。任务附件不用传，每次运行自动带。
- 副作用：审计 `session.start`（detail 有 taskId、source: `manual`、attachments）；任务选用的记忆写上 `lastUsedAt`；推 `sessions`、`session_events`、`checkpoints`、`files`、`memories`。
- 其他触发来源（cron、待办、外部事件）走同一个函数，`source` 分别是 `cron / todo / event`，不记 `session.start` 审计（没有操作人）。

### 5.2 `engine.runTodoNow`（M1 P3 新加）

和待办到点是同一条路径（`fireTodo`）：

1. 任务有**挂起等待中**的 session（取最近一个）：用待办标题作为「等到了什么」继续它，返回 `resumedSessionId`。
2. 否则新开一次运行，待办标题作为附加说明（`note`），`source = todo`，返回 `startedSessionId`。
3. 非 cron 的待办执行后就结束（状态变 `done`，到点不会再触发一次）；cron 待办一直有效，「立即执行」不影响它的定时。

错误：`NOT_FOUND`（待办 / 任务）；`FORBIDDEN`（「只有加这条待办的人、任务负责人和主管能立即执行」）；`CONFLICT`：待办已经执行过或已经删除；`BAD_REQUEST`：任务已停用（「任务已停用，先启用再执行」，在调用 `fireTodo` 之前就拦下，待办不会被白白标成已执行）。触发失败时还会给加待办的人和任务负责人发一条站内通知（「待办『…』没能触发」）。审计 `todo.run`（detail 是返回值）。推 `human_todos` 和 session 相关表。

### 5.3 `engine.cancel`、`engine.resumeNow`

- `cancel`：把还没结束的 session 标成 `failed`，`error` 写「<姓名>取消了这次运行：<原因>」；挂起的等待作废，没处理的「要人办的事」一并取消；追加一条 `error` 事件「已取消」。正在跑的循环在下一步之前发现状态变了就停。错误：`NOT_FOUND`、`FORBIDDEN`、`CONFLICT`（已经 `done / failed`）。审计 `session.cancel`。
- `resumeNow`：只对 `waiting`（挂起等时间 / 事件）的 session。错误：`NOT_FOUND`；`FORBIDDEN`；`BAD_REQUEST`：`needs_human`（「先去待办里处理那件事」）或没有在等；`CONFLICT`：刚刚已经被别的原因继续了（到点、事件、人处理，谁先到谁生效）。给 agent 追加一条「【继续】…让你立即继续」的消息，排进 `session.run`，**同一个 session id 接着跑**。审计 `session.resume.resume_now`。

### 5.4 `engine.resolveHumanItem`

处理「要人办的事」（审批、登录、验收争议、花费 / 步数到上限）：`approve` 批准、`reject` 拒绝、`done` 已处理，可加备注。

- 错误：`NOT_FOUND`；`FORBIDDEN`（「这件事不是分给你的」）；`BAD_REQUEST`：`kind` 是记忆审核或技能修改（要去记忆页、技能页，用 `memories.approve` 等）；`CONFLICT`：已经处理过。
- 关联的 session 在等这件事时：
  - 普通请示（`ask.human`）：不论 `how` 是什么，都会继续 session，把「<姓名>处理了你提的事『…』：批准 / 拒绝 / 已处理，备注」告诉 agent，由 agent 决定下一步。返回 `resumedSessionId`。
  - 花费 / 步数上限：`approve` / `done` = 在现有基础上再给一份默认额度（设置里的 `maxCostUsd` / `maxSteps`）并继续；`reject` = 运行结束（`failed`，原因写「…到了上限，<姓名>决定不继续」），返回 `endedSessionId`。
  - 没有 session、或者 session 已经不在等它：只把这件事标成已处理，返回 `{}`。
- 审计 `human_item.resolve`（detail 有 how、note）；继续时另记 `session.resume.human`；推 `human_items`、`sessions` 等。

### 5.5 `engine.fireEvent` 和外部事件

控制台手动触发一个事件，效果和外部系统 `POST /api/events` 一样（匹配规则见第 7 节），区别是审计里 `via = console` 并记操作人。会叫醒任何人的 session，所以只给主管。审计 `event.fire`（目标表 `events`，目标 id 是事件名）；继续 session 时另记 `session.resume.event`。

### 5.6 附件和产物

文件的上传、下载见第 6 节。接口只返回 `SessionFile`：

| 字段 | 说明 |
|---|---|
| `id name mime size createdAt` | 基本信息，`createdAt` 是 ISO |
| `kind` | `upload` 刚上传、还没用；`attachment` 附件（任务的或这次运行的）；`artifact` agent 用 `file.save` 存的产物；`tool_output` 太长的工具输出全文；`screenshot` 截图 |
| `scope` | `task` = 任务附件，每次运行都带，跨运行一直有效；`session` = 只属于这一次运行 |
| `url` | 下载地址 `/api/files/<id>`（要求登录） |

- `taskAttachments`：任务当前的附件（`kind = attachment`、属于任务、不属于某次运行），按创建时间。`NOT_FOUND`（任务）。
- `attachToTask`：把一个**刚上传、没用过**的文件挂到任务上（`kind → attachment`，写上 `taskId`）。已经是这个任务的附件就原样返回（幂等）。错误：`NOT_FOUND`（任务 / 文件）、`FORBIDDEN`、`BAD_REQUEST`（文件已经用在别处，请重新上传）。审计 `task.attach`。
- `detachFromTask`：去掉任务附件，文件变回 `upload`（可以重新挂或用在 `runNow` 上），**不删文件**。已经开始的运行快照里还有它，照样能读。错误：`NOT_FOUND`（「这个任务没有这个附件」）、`FORBIDDEN`。审计 `task.detach`。
- `sessionFiles`：这次运行的附件和产物 = 快照里的附件（含任务附件，`scope: task`）+ 只属于这次运行的文件（`scope: session`），按创建时间。`NOT_FOUND`（session）。

### 5.7 `engine.listMcpServerTools`

工具页的「连接并读取工具」。**是 mutation**（会连接外部、改服务器状态）。连得上：`status → connected`，返回 `{ ok: true, tools, serverName }`；连不上：`status → error`，返回 `{ ok: false, tools: [], error, serverName }`（**不抛错**，错误在 `error` 里）。找不到服务器也是 `ok: false`，不是 `NOT_FOUND`。stdio 类型会在 **API 进程所在的机器**上起命令，所以只给主管；连接超时 20 秒。读到的工具由页面勾选后，通过 `tools.createMcpServer / updateMcpServer` 的 `tools` 字段存下来。无审计。

### 5.8 通知

站内通知（`notifications` 表）由引擎写：有事等你处理、运行出问题、兜底期限到了、待办没能触发、agent 用 `notify.staff` 等。`Notification`：`{ id(整数) title body link? taskId? sessionId? createdAt readAt? }`；`link` 是控制台的 hash 路由，如 `#/todos`、`#/tasks?id=T-1&run=R-1-1`。`list` 按新的在前，`unread` 是**全部**未读数（不受 `limit`、`unreadOnly` 影响）。没有审计。推 `notifications`（推送的 id 是接收人 id）。

---

## 6. 文件（HTTP）

代码：`apps/server/src/files/routes.ts`、`service.ts`、`storage.ts`。要求登录（cookie）。文件内容存在本地磁盘（`HEYAGENT_FILES_DIR`，默认 `.dev/files`；api 和 worker 要挂同一个目录），库里只有元数据。

### 6.1 `POST /api/files`：上传

`multipart/form-data`，文件放在字段 **`file`**。

```bash
curl -s -b 'better-auth.session_token=<COOKIE>' -F 'file=@./data.csv' http://localhost:3100/api/files
# → {"id":"f-3a9c0e51d27b4f86","name":"data.csv","mime":"text/csv","size":123,"url":"/api/files/f-3a9c0e51d27b4f86"}
```

| 项 | 说明 |
|---|---|
| 大小上限 | 环境变量 `HEYAGENT_UPLOAD_MAX_MB`，默认 **20** MB（进程启动时读）。超了返回 `413 {"error":"文件太大，最多 20 MB"}`（请求体上限比文件上限多留 64 KB 给 multipart 头） |
| 返回 | `UploadedFile`：`{ id, name, mime, size, url }` |
| 文件名 | 把 `\ / 换行 " NUL` 换成 `_`，去首尾空白，最多 200 字符；没有名字用 `file` |
| `mime` | 用浏览器给的 `Content-Type`（去掉 `; charset=…`）；没有或 `application/octet-stream` 时按扩展名推（csv、tsv、md、json、txt、log、html、xml、yaml、png、jpg、gif、webp、pdf、zip、xlsx、docx），推不出就 `application/octet-stream` |
| 状态 | 传上来的文件是 **`kind = upload`、不属于任何任务或运行**。要用它：在 `engine.runNow` 的 `attachmentFileIds` 里带上（变成这次运行的附件），或 `engine.attachToTask`（变成任务附件） |
| 错误 | `401 {"error":"请先登录"}`；`400 {"error":"要用 multipart/form-data 上传，字段名 file"}` 或 `{"error":"没有收到文件（字段名 file）"}`；`413` |
| 审计 / 推送 | 无审计；写 `files` 表，推 `files`（id 为空，因为没有 session） |

### 6.2 `GET /api/files/:id`：下载

| 项 | 说明 |
|---|---|
| 权限 | 登录即可，**不按文件归属再校验**（员工能看全部）。文件 id 是随机的，不能枚举 |
| 成功 | 200，body 是文件内容。`Content-Type` 是存的 `mime`（`text/*` 会补 `; charset=utf-8`）；`Content-Length`；`X-Content-Type-Options: nosniff`；`Cache-Control: private, max-age=300` |
| inline 还是下载 | **只有图片（`image/png`、`jpeg`、`gif`、`webp`）是 `Content-Disposition: inline`**，可以直接 `<img src>`；其他一律 `attachment`（包括 HTML、SVG、PDF），不在控制台的域名下渲染，免得脚本在登录态下执行。文件名用 `filename="…"`（非 ASCII 换成 `_`）加 `filename*=UTF-8''<编码>` |
| 错误 | `401`；`404 {"error":"找不到文件"}`；`410 {"error":"文件内容不见了"}`（库里有记录、磁盘上没有） |

没有删除接口，也不会清理一直没用上的 `upload` 文件。

---

## 7. 外部事件（HTTP）

`POST /api/events`：让外部系统叫醒在等事件的 session、触发等事件的待办。代码：`apps/server/src/engine/http.ts`、`control.ts`。

**令牌**：

- 主管在「设置」页生成（`settings.regenerateEventToken`，返回 `hae_…` 原文，只这一次；库里只存 sha256，之后只能看到尾号）。重新生成后旧令牌立刻失效；`settings.clearEventToken` 停用外部事件。
- 请求头二选一：`Authorization: Bearer <令牌>`（`Bearer` 不分大小写），或 `X-HeyAgent-Token: <令牌>`。两个都带时先看 `Authorization`；`Authorization` 不是 `Bearer` 形式时回落到 `X-HeyAgent-Token`。比较用常数时间。不用 cookie、不需要登录。

```bash
curl -s -X POST http://localhost:3100/api/events \
  -H 'Authorization: Bearer <EVENT_TOKEN>' -H 'content-type: application/json' \
  -d '{"event":"file.arrived","data":{"batch":"2026-10-17"}}'
# → {"ok":true,"resumedSessionIds":["R-1042-3"],"firedTodoIds":[]}
```

**请求体**（JSON，≤ 256 KB）：`{ "event": string（1-200 字）, "data"?: 对象 }`。`data` 必须是对象（数组、字符串不行），内容随便。

**返回**：

| 状态 | 内容 |
|---|---|
| 200 | `{ ok: true, resumedSessionIds: string[], firedTodoIds: string[] }`。没有任何匹配也是 200，两个数组为空 |
| 400 | `{ error: "内容要是 JSON：{ event, data }" }`（不是 JSON）或 `{ error: "内容要是 { event: 事件名, data?: 对象 }" }`（字段不对） |
| 401 | `{ error: "还没有配置外部事件令牌（在「设置」页生成）" }`；`{ error: "令牌不对" }` |
| 413 | `{ error: "内容太大" }` |

**匹配规则**（事件名是**完全相同、区分大小写**的字符串）：

1. **等待中的 session**：`session_waits` 里 `status = waiting`、`event` 等于事件名、且不是「等人处理」的那种（`humanItemId` 为空）。这类等待是 agent 用 `session.wait` 的 `event` 参数挂起产生的（可以同时给时间，先到哪个算哪个）。命中的 session 被继续（**同一个 session id**），agent 收到一条「【继续】等到了事件『…』（外部系统发来）。之前在等：…」的消息，`data` 的 JSON（截到 4000 字符）附在后面——目前 `data` 只是给 agent 看，不参与匹配（等待上的 `match` 条件只有内部用）。只等事件的挂起有兜底期限（设置里的 `eventFallbackDays`），到期**只提醒负责人，不自动继续**。
2. **待办**：`human_todos` 里 `status = active`、`event` 等于事件名、触发类型是 `event` 或 `time_or_event`。每条走 `fireTodo`：任务有挂起等待中的 session 就继续它，否则新开一次运行（`source = todo`）；触发后待办结束。某条待办触发失败只记日志，不影响其他。
3. 谁先到谁生效：继续用「状态还是 waiting 才改」的条件更新，到点、事件、人处理、立即继续同时到时只有一个生效，后到的什么都不做（返回的数组里不会出现它）。

每次调用都记审计 `event.fire`（目标表 `events`，目标 id 是事件名，操作人为空，detail 有 `via: "webhook"` 和两个数组）。推送的是被继续 / 新开的 session 相关表。

---

## 8. 实时推送

`live.onChange`（subscription，SSE）。代码：`apps/server/src/live/hub.ts`、`packages/shared/src/live.ts`；前端：`apps/web/src/components/shell/live-sync.tsx`。

| 项 | 说明 |
|---|---|
| 谁能订 | 登录即可。没登录且请求头带 `Accept: text/event-stream` 时，直接 HTTP 401（不然 tRPC 会在流里发错误事件、状态码仍是 200） |
| 输入 | `{ lastEventId?: string 或 null }`，可整个省略；用 `httpSubscriptionLink` 时断线重连自动带上（它以 `Last-Event-ID` 头或 `lastEventId` 查询参数传，tRPC 会并进 input），自己不用管 |
| 每条数据 | `{ table: string, id: string 或 null }`，外面包着 `tracked(id)`（`onData` 拿到 `{ id, data }`）。**只说哪张表的哪一行变了，不带内容**，客户端要自己重新查 |
| 心跳 | 服务端每 15 秒发一次；客户端 30 秒没收到任何东西自动重连 |
| 手动试 | `curl -N -b 'better-auth.session_token=<COOKIE>' -H 'Accept: text/event-stream' http://localhost:3100/api/trpc/live.onChange`；调试时 `pnpm dev:notify <表> <id>` 可以手动发一条 |

**数据从哪来**：库里的触发器在业务表增删改时 `NOTIFY heyagent_changes`，内容 `{ table, id }`；API 进程用一条专用连接 `LISTEN`，推给所有订阅的页面。`id` 是该行主键；关联表用它所属对象的 id（`session_events` / `checkpoints` / `session_waits` 推 session id，`task_*` 推任务 id，`skill_tools` 推技能 id，`browser_accounts` / `browser_vaults` 推 Chrome id，`account_leases` 推账号 id，`models` 推服务 id，`notifications` 推**接收人 id**，`files` 推 session id（任务附件为 `null`），`settings` 推设置的键名）。**没有触发器、不会推**的表：`audit_events`、`session_messages`、`skill_versions`、better-auth 的几张表。

**没有按用户过滤**：每个登录用户都会收到所有表的变化（不含内容）。是否看得到数据由重新查询时的权限决定。

**断线续传**：

- 每条数据编一个 id（`<启动号>:<序号>`），最近 1000 条留在内存里。
- 重连带 `lastEventId` 时：id 对得上就把漏掉的按顺序补发；**补不齐**（API 重启过、断得太久、缓冲溢出）就推一条 `{ table: "*", id: null }`。
- 第一次订阅（没有 `lastEventId`）**不补发历史**，只推订阅之后的变化。所以页面要先正常查一遍数据，再靠推送保持新鲜。
- `{ table: "*" }` 的意思是「什么都可能变了」：API 和数据库的 LISTEN 连接断了又连上后、`pnpm db:seed` 灌完后，也会推一条。

**`liveQueriesByTable`**：表名到「要重新拉的查询路径」的对照表（`packages/shared/src/live.ts`）。前端用 `queriesForTable(table)` 取路径，对这些路径调 `queryClient.invalidateQueries`；返回 `null`（`"*"` 或不认识的表）就**全部**失效。一次操作常连着推好几条，前端攒 250 ms 再统一失效。tRPC 查询键的第一项是路由路径数组（`["sessions","list"]`），所以匹配时 `path.join(".")`。

| 表 | 重新拉 |
|---|---|
| `users` | `me.get` `staff.list` `users.list` |
| `tasks` `task_memories` `task_skills` `task_tools` `task_rules` | `tasks.list` |
| `sessions` `session_events` `checkpoints` `checkpoint_records` `session_waits` | `sessions.list` `sessions.get` |
| `human_items` | `todos.board` `me.get` `memories.list` `skills.list` |
| `human_todos` | `todos.board` |
| `memories` | `memories.list` |
| `skills` `skill_tools` `skill_suggestions` | `skills.list` |
| `rules` `rule_tools` | `rules.list` |
| `tools` `mcp_servers` | `tools.list` |
| `secrets` | `tools.list` `models.overview` `browsers.list` |
| `browser_profiles` `browser_accounts` `browser_vaults` `account_leases` | `browsers.list` |
| `platforms` | `platforms.list` `browsers.list` |
| `model_providers` `models` `model_defaults` | `models.overview` |
| `notifications` | `engine.notifications.list` |
| `files` | `engine.sessionFiles` `engine.taskAttachments` |
| `settings` | `settings.get` |

加新表或新查询时：给表建 `heyagent_notify_change` 触发器（照 `0001_triggers.sql`），并在 `liveQueriesByTable` 里补一行，否则页面不会自动刷新。

---

## 9. 附录

### 9.1 审计 action 一览

`audit_events`：`(at, actor_id, action, target_table, target_id, detail)`，只追加，`actor_id` 为空表示系统（定时、agent、外部事件）。

| 范围 | action |
|---|---|
| 账号 | `user.create` `user.update` `user.disable` `user.enable` `user.reset_password` `user.change_password` |
| 任务 | `task.create` `task.update` `task.enable` `task.disable` `task.delete` `task.attach` `task.detach` |
| 待办 | `todo.create` `todo.update` `todo.delete` `todo.run` |
| 记忆 | `memory.create` `memory.update` `memory.approve` `memory.reject` `memory.archive` `memory.delete` |
| 技能 | `skill.create` `skill.update` `skill.publish` `skill.draft` `skill.disable` `skill.suggestion.accept` `skill.suggestion.reject` |
| 规则 | `rule.create` `rule.update` `rule.delete` `rule.restore` |
| 工具 | `tool.create` `tool.update` `tool.delete` `tool.restore` `secret.create` `secret.update` `secret.delete` `mcp_server.create` `mcp_server.update` `mcp_server.delete` |
| 浏览器 | `browser_profile.create` `browser_profile.update` `browser_profile.delete` `platform.create` `platform.delete` `browser_account.create` `browser_account.update` `browser_account.delete` |
| 模型 | `model_provider.create` `model_provider.update` `model_provider.test` `model_provider.refresh` `model_provider.delete` `model_defaults.update` |
| 设置 | `settings.update` `settings.event_token.regenerate` `settings.event_token.clear` `settings.channel.create` `settings.channel.update` `settings.channel.delete` |
| 运行 | `session.start`（`runNow`）`session.cancel` `session.resume.resume_now` `session.resume.human` `session.resume.event`（控制台触发，webhook 没有操作人所以不记）`human_item.resolve` `event.fire` |

### 9.2 已知限制（写代码时要知道）

- `sessions.list` 没有分页，一次返回全部 session 和全部事件；session 多了以后需要按 `taskId` 筛或加分页。
- `SessionRun` 没有 `error` 字段，失败原因要去 `kind = "error"` 的事件里找。
- `engine.listMcpServerTools` 对 stdio 类型会在 API 机器上起进程；`engine.sessionFiles`、`taskAttachments`、通知这几个查询只要求登录。
- 上传后一直没用上的文件不会被清理，也没有删除文件的接口。
- `live.onChange` 的补发缓冲在内存里（1000 条，API 重启就没了），客户端必须能处理 `table: "*"`。
- 事件名匹配是精确匹配；外部事件的 `data` 目前不参与匹配，只作为文字交给 agent。
