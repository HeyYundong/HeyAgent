# HeyAgent v1 后端选型：调度、持久化、后端框架

> 调研日期 2026-10-17。版本号除另注外均为当天 `npm view <包> version` 的结果（npm 的 `latest` 标签）。方括号里的编号对应文末参考链接。查不到原始来源的内容标注为「未核实」。

## 1. 结论和推荐

| 层 | 推荐 | 一句话理由 |
|---|---|---|
| 语言 / 运行时 | TypeScript + Node 22.12+（pg-boss 12 要求 `node >=22.12.0`，npm engines 字段） | 与前端共享 zod schema 和类型。下面所有候选库都是 TS 一等支持，没有必须用 Python 的理由（见 §9） |
| 调度 / 队列 | **pg-boss 12.38.0**，加上自建的 `session_waits` 表 | 只依赖 Postgres；cron、延迟任务、按组并发、事务内入队都有 [1][2][3][4] |
| 数据库 | **PostgreSQL 18**（当前 18.6，EOL 2030-11-14）[10] | 当前最新的 GA 大版本。19 还只是 RC1（2026-10-15）|
| 向量 | v1 **不装 pgvector** | 记忆是手动选的，不需要检索。以后要用时把镜像换成 `pgvector/pgvector:pg18` 即可 [11] |
| ORM | **Drizzle 0.45.4**（稳定版；1.0 还在 beta.22） | 写法贴近 SQL；pg-boss 有现成的 `fromDrizzle` 事务适配器 [4]；better-auth 的 peer 依赖支持它 |
| API | **Hono 4.13.13** + `@hono/node-server` 2.1.5 + **tRPC 11.19.0** | 业务接口用 tRPC 共享类型；webhook、文件上传下载、外部事件入口用普通 Hono 路由 |
| 实时推送 | **SSE**（tRPC `httpSubscriptionLink` + `tracked(seq)` 断线续传）[13] | 推送是单向的，tRPC 官方也推荐 SSE；跨进程广播用 PG `LISTEN/NOTIFY` |
| 认证 | **better-auth 1.7.10**：邮箱密码 + admin 插件，以后用 generic-oauth 接飞书 [15][16][17] | Lucia 已于 2025-03 弃用 [18]；Auth.js 已归 better-auth 团队维护 [19] |
| 加密 | `node:crypto` AES-256-GCM 信封加密（每条记录一个 DEK，由主密钥 KEK 包裹）；KEK 放 Docker secret 文件 | 不新增依赖；KEK 带版本号，轮换时只重新包裹 DEK |
| 文件 | **本地磁盘卷**，外加一层 `BlobStore` 接口；以后需要 S3 再换 SeaweedFS | MinIO 社区版已于 2026-04-25 归档，Docker Hub 镜像已下架 [20][21] |
| LLM 可观测性 | v1 **不上** Langfuse | 自托管要 6 个组件 [24]，比我们整个栈还重；session 过程页加事件表已经够用 |

**Compose 只有 3 个服务**：`app`（API 和 worker 同一个镜像，可以拆成两个容器）、`postgres`、反向代理（Caddy 或 nginx）。没有 Redis，也没有单独的工作流引擎。

**为什么选 pg-boss，不选 Temporal、Inngest 这类「持久化执行引擎」**：session 的消息历史和状态存在我们自己的库里，agent 循环本身就是可以重入的（从库里加载历史，接着往下跑）。执行引擎只需要做三件事：到点叫醒、把唤醒派给某个 worker、排队限流。这三件事 pg-boss 都在同一个 Postgres 里完成，而且能**和业务写入放在同一个事务里**（`send(..., { db: fromDrizzle(tx) })` [4]），状态变更和唤醒任务要么一起成功，要么一起回滚。Temporal、Inngest、DBOS 的「step 回放」解决的是函数中途崩溃后的确定性重放，而我们的检查点本来就落在自己的表里，这部分能力是重复的，还会带来额外的进程和心智负担。

**备选**：DBOS 5.3.0（MIT，是一个库，只依赖 Postgres）。如果以后希望 agent 循环的每一步都由引擎自动做检查点，可以考虑迁移过去，见 §2。

## 2. 任务队列 / 持久化执行对比

| 方案 | 版本 / 许可证 | 单机自托管组件 | cron / 延迟任务 | 等事件 + 超时 | 按 key 并发 | 重启恢复 | 运维负担 |
|---|---|---|---|---|---|---|---|
| **pg-boss** | 12.38.0 / MIT | 只要 Postgres（库内建表） | `schedule(name, cron, data, {tz, key})`，支持 cron 和 RRULE，存在 schedule 表里；`startAfter` 做延迟 [3][4] | 没有内建，需要自建等待表，到期用延迟任务 | 有。`work()` 的 `groupConcurrency` 跨节点生效，但文档说明可能「短暂超限」[2] | 作业全部在 PG 里；active 作业超过 `expireInSeconds`（最大 86400）后重试 [4] | 低 |
| graphile-worker | 0.18.0 / MIT | 只要 Postgres | crontab（可补跑）、`run_at` [5] | 没有内建 | 只有「同名队列串行」，即每个 key 并发为 1；N>1 需要外挂限流 [5] | 有 | 低 |
| BullMQ | 6.3.15 / MIT | 再加一个 **Redis** | `upsertJobScheduler` 支持 cron；新任务要等上一个任务开始处理才生成 [7] | 没有内建 | 按组并发是 **Pro 付费功能** [6] | 取决于 Redis 持久化配置 | 中（多一个有状态服务） |
| Inngest 自托管 | server v1.46.0（2026-10-06）/ **SSPL，到期转 Apache-2.0** [8a]；SDK 4.24.0 / Apache-2.0 | 单个二进制；默认 SQLite + 内嵌 Redis，生产建议外接 PG 和 Redis；`start` 命令仍标 Beta [8] | 有 | `step.waitForEvent(id, {event, timeout, match/if})`，返回 `null \| 事件` [8b] | `concurrency: {key, limit}`；sleep 和 waitForEvent 期间**不占槽位** [8c] | 有 | 中：PG 里的旧行不会自动清理，官方不保证给自托管提供支持 [8] |
| Temporal | server v1.32.1（10-08）[9]；TS SDK 1.24.0 / MIT | server 由多个服务组成，外加 PG 和可选的 Elasticsearch；官方的 Compose 只当作起点 [9a] | 有 | Signal 加计时器（未在本次核实具体 API） | 未核实 | 有（事件溯源） | **高**：schema 要手动升级，Helm 和镜像版本要配套 [9a] |
| Trigger.dev 自托管 | SDK 4.7.4 / MIT | webapp、PG、Redis、ClickHouse、镜像仓库、对象存储、s2、supervisor、docker-socket-proxy；最低配置为 3 vCPU / 6 GB 加 4 vCPU / 8 GB [12] | 有 | `wait.forToken`，timeout 到期返回 `ok:false` [12a] | 有 concurrencyKey | 有 | **高**。而且自托管**不支持 checkpoint** [12]，按 v4 发布说明，等待中的 run 没有 checkpoint 就会一直占着并发槽位（推断）[12b] |
| Hatchet | SDK 1.38.0 / MIT | Hatchet Lite 是单镜像，只要 PG；官方定位为「开发和低流量」；生产推荐 PG + RabbitMQ [14] | 有 | `ctx.waitForEvent`，可以用 or-group 组合 sleep 和事件；durable task 等待期间会被**驱逐、释放槽位** [14a] | 有，用 CEL 表达式按 key 限并发（2026-09 公告）[14b] | 有 | 中 |
| DBOS | 5.3.0 / MIT | **只是一个库**，只依赖 PG；Conductor 是可选的控制面 [22] | 可以在运行时用 `DBOS.createSchedule` 动态建 cron；入队支持 `delaySeconds` [22b][22c] | `DBOS.recv(topic, timeoutSeconds)`，超时返回 `null`；外部用 Client 的 `send` [22a] | 分区队列：`queuePartitionKey` + `partitionConcurrency`，并发限制全局生效 [22c] | 启动时扫描 PENDING 的 workflow，用已存的 step 输出重放 [22] | 低；但 workflow 代码要能安全重放，升级时需要 patch 机制 |

**各方案怎么实现「挂起 session、几天后继续」**（前提都是 session 状态存在我们自己的库里）：

- **pg-boss / graphile-worker**：挂起时写一条 `session_waits` 记录，同时投一个延迟任务（`startAfter = 到点时间或兜底期限`）。事件到达时用 CAS 把 wait 标记为已触发，再投一个 `resume` 任务。进程随即空闲，整个过程只占 PG 里的几行数据。见 §3。
- **Inngest / Hatchet**：每个 session 对应一个长期存在的函数实例，挂起写成 `waitForEvent` 或 or-group。好处是「先到先继续」原生就有；代价是多一个服务，而且「立即继续」「撤销等待」「改等待条件」都要绕到引擎的 API 上去做。
- **DBOS**：每个 session 是一个 workflow，挂起写成 `recv(topic, timeout)`，事件来了调用 `send(sessionId, ...)`。可以做，但 workflow 在等待期间仍是进程里的一个 Promise，重启后要从头重放（未核实长时间等待时的内存行为）。
- **Temporal / Trigger.dev**：能力最全，但对 5～20 人、单机的规模来说过重。Trigger.dev 自托管没有 checkpoint，基本不适合「挂起几天」这种场景。

## 3. 「挂起和继续」推荐实现草图（pg-boss + 自建等待表）

```ts
// 表：sessions(id, status, version)、session_waits(id, session_id, kind, match jsonb, resume_at, deadline_at, status)
//     session_events(seq bigserial, session_id, type, payload)   ← 落库后 NOTIFY，由 SSE 推送
async function suspend(tx, s, w) {                 // 在 run-segment 作业里，由 agent 决定挂起
  await casUpdate(tx, sessions, s.id, s.version, { status: 'suspended' })  // WHERE version = ? 防并发
  const wait = await insertWait(tx, { sessionId: s.id, ...w, deadlineAt: w.resumeAt ?? addDays(now, 7) })
  await boss.send(w.resumeAt ? 'wake' : 'remind', { waitId: wait.id },
                  { startAfter: wait.deadlineAt, db: fromDrizzle(tx) })    // 和状态写入在同一个事务
  await appendEvent(tx, s.id, 'suspended', w)
}                                                   // 作业返回，worker 空闲，不再占进程
async function fire(waitId, cause) {               // 到点、外部事件、审批、「立即继续」都走这里
  await db.transaction(async (tx) => {
    const n = await tx.update(waits).set({ status: 'fired', cause })
      .where(and(eq(waits.id, waitId), eq(waits.status, 'waiting')))      // 先到先继续：只有一路能成功
    if (n.rowCount === 0) return
    await boss.send('resume', { sessionId }, { singletonKey: sessionId, db: fromDrizzle(tx) })
  })
}
// 外部事件入口（POST /hooks/:source）：SELECT 状态为 waiting 且 match <@ 事件 jsonb 的 wait（GIN 索引），逐条 fire()
boss.work('wake',   ({ data }) => fire(data.waitId, 'timer'))
boss.work('remind', ({ data }) => stillWaiting(data.waitId) && notifyOwner(data.waitId))  // 只提醒，不继续
boss.work('resume', async ({ data }) => {
  if (!(await acquireAccountLease(data.sessionId))) return suspend(/* kind:'account' */)  // 账号满了就排队
  await runAgentLoop(data.sessionId)               // 从自己的库加载历史；每一步 appendEvent；花费超过 20 美元就 suspend(kind:'approval')
})
// 人加的待办：cron 用 boss.schedule('todo', cron, {todoId}, { key: todoId, tz: 'Asia/Shanghai' })；
//   handler 里：如果任务有挂起中的 session 就 fire(它的 wait)，否则新建一次运行
// 重启：作业和 wait 都在 PG 里；active 作业超时后由 pg-boss 重试，resume 先检查 session.status 保证幂等
```

账号并发建议**自建租约表**（`account_leases`，`SELECT ... FOR UPDATE` 锁住账号行，计数小于 N 才发放；释放租约时 fire 最早的 `kind='account'` 等待），不直接用 pg-boss 的 `groupConcurrency`。原因有两个：一个 session 跨多个作业、可能用到多个账号；而 `groupConcurrency` 是按作业计数，并且会短暂超限 [2]。

## 4. 数据库和 ORM

| 项 | 事实 | 结论 |
|---|---|---|
| PostgreSQL 18 | 18.6，2025-09-25 发布，EOL 2030-11-14 [10] | **选它** |
| PostgreSQL 17 | 17.11，EOL 2029-11-08 [10] | 可以用，但没有理由选旧版 |
| PostgreSQL 19 | 2026-10-15 发布 RC1，尚未 GA [10] | v1 不用；GA 半年后再评估是否升级 |
| pgvector | 0.8.7，支持 PG 13+，有 `pgvector/pgvector:pg18` 镜像 [11] | v1 不装 |
| Drizzle | `drizzle-orm` 0.45.4（latest），1.0.0-beta.22（beta 标签）；`drizzle-kit` 0.31.11；CVE-2026-39356（SQL 标识符转义）在 0.45.2 修复 [26] | **选它**，版本锁在 `^0.45.2`；1.0 GA 后再迁移 |
| Prisma | `@prisma/client` 7.10.1；**但 `prisma`（CLI）的 latest 标签指向 8.0.0-rc.23**，直接 `npm i prisma` 会装到 RC；Prisma 8 拆成 CLI 加按数据库分的包，GA 预计 2026-10 [27]；better-auth 的 peer 依赖只支持 `prisma ^5\|^6\|^7` | 不选。现在正处在大版本切换期，风险最高 |

## 5. API 层与实时推送

| 选项 | 版本 | 评价 |
|---|---|---|
| Hono | 4.13.13 | 轻量，Web 标准 API；better-auth 有官方的 Hono 集成；SSE 有 `streamSSE` 辅助函数；用 `@hono/trpc-server` 0.4.2 挂载 tRPC |
| Fastify | 5.12.7 | 插件生态成熟（`@fastify/websocket` 11.3.4），也完全够用。选 Hono 只是因为更轻、和 tRPC / better-auth 的组合示例更多，并不是 Fastify 不行 |
| tRPC v11 | 11.19.0 | 在 monorepo 里前后端直接共享类型；subscription 默认走 SSE，用 `tracked(id, data)` 让客户端断线后带上 `lastEventId` 自动续传 [13] |
| REST + zod/OpenAPI | `@hono/zod-openapi` 1.6.3，zod 4.6.7 | 外部调用方（webhook、以后可能出现的第三方）需要 REST。所以 webhook 和文件接口走 REST，内部控制台走 tRPC |
| SSE 还是 WebSocket | — | **SSE**。推送是单向的（事件流推到看板和过程页），用户操作走普通 mutation。注意：浏览器在 HTTP/1.1 下每个域名最多 6 个连接（MDN [28]），反代要开 HTTP/2，并关闭缓冲（nginx 设 `proxy_buffering off`）；一个页面只开一条流，按 channel 多路复用 |

事件流的做法：先写入 `session_events`（`seq` 单调递增），提交后 `NOTIFY session_events, '<session_id>:<seq>'`；各进程 `LISTEN` 到通知后推给已订阅的 SSE 连接；客户端带 `lastEventId=seq` 重连时，从表里补齐缺失的事件。

## 6. 认证

| 方案 | 状态 | 评价 |
|---|---|---|
| **better-auth** 1.7.10 / MIT | 活跃 | 有邮箱密码；admin 插件支持角色、自定义权限、管理员建号、封禁、模拟登录、重置密码 [16]，对应「主管 / 员工」；generic-oauth 插件可以接任意 OAuth2 / OIDC，支持自定义 `getUserInfo` [17]，飞书和企业微信可以走这条路（对接细节未核实）；有 Drizzle 适配器 |
| Auth.js | 2025-09-22 起由 better-auth 团队维护，新项目推荐用 better-auth [19] | 不选 |
| Lucia | 2025-03 弃用，官网只留一份单文件参考实现 [18] | 不选 |
| 自建 | — | argon2id 哈希 + `sessions` 表 + httpOnly / SameSite=Lax cookie，约 200 行。可以完全掌控，但以后接 OAuth、做封禁、做模拟登录都要自己写 |

推荐 better-auth。关闭公开注册，只允许管理员建号（是否有 `disableSignUp` 这个配置项，本次**未核实**；不行的话就在路由层拦截注册接口）。

## 7. 加密（内网没有 KMS）

- **算法**：用 `node:crypto` 的 AES-256-GCM，不新增依赖。每条密文用独立的随机 DEK（32 字节），IV 随机 12 字节；AAD 绑定 `表名:行ID:版本号`，防止把密文挪到别的行上用。另一个选择是 `libsodium-wrappers` 0.8.4 的 XChaCha20-Poly1305（24 字节 nonce，随机生成更安全）。`age-encryption` 0.3.1 面向文件加密，不适合按行存储。
- **信封结构**：`{v:1, kekId:'kek-2026a', wrappedDek, iv, tag, ct}`。DEK 由 KEK 用 AES-GCM 包裹后存进库里。
- **主密钥（KEK）怎么保管**：32 字节随机数，以 Docker Compose secret 的形式挂载到 `/run/secrets/heyagent_kek_<id>`（宿主机上的文件为 root 所有，权限 400）[25]。不放进 `.env`、git、数据库，也不放进和数据库同一份的备份里。离线留两份（例如公司密码管理器里一份、封存的纸质件一份），由两人分别保管。**KEK 丢失意味着保险箱和密钥全部无法恢复**，必须写进运维手册。
- **轮换**：加入新的 `kek-2026b`，新写入一律用新 KEK；后台作业逐行用新 KEK 重新包裹 DEK（只重包 DEK，不重加密数据，几秒就能完成）；全部重包后下线旧 KEK。怀疑 DEK 泄露时，对受影响的记录重新加密。
- **不给模型和页面看**：HTTP 工具在发请求的那一刻才在 worker 内解密并注入 header；事件落库前统一脱敏；页面只显示「已设置 / 末 4 位」。
- **保险箱版本 CAS**：`UPDATE vault SET blob=$new, version=version+1 WHERE id=$id AND version=$base`，影响 0 行说明有冲突。这时读出当前版本 `theirs`，与 session 签出时的 `base`、本次写入的 `ours` 做三方合并（cookie 以 `(name, domain, path)` 为键，localStorage 以 `(origin, key)` 为键；双方都改了同一键时取 expires 较新的那个）后重试。需要保留最近 N 个历史版本（同样加密），供合并时取 `base`。

## 8. 文件存储

| 方案 | 状态 | 评价 |
|---|---|---|
| **本地磁盘卷** | — | **v1 选它**。按 `sha256` 分目录存放，元数据（大小、mime、所属 session、上传人）放在 PG；下载走 API 做权限校验；备份时和 `pg_dump` 一起用 restic 或 rsync |
| MinIO 社区版 | 2025-10 起只提供源码，2025-12 进入维护模式，**2026-04-25 仓库归档**，README 写明「不再维护」，引导用户转向 AIStor（另有许可证）[20]；2026-09 中旬 Docker Hub 上的 `minio/minio` 已拉不到，历史镜像只在 quay.io 上还有 [21]；代码仍是 AGPLv3 | **不用**。没有安全更新 |
| SeaweedFS | Apache-2.0；单个 `weed` 二进制，`weed mini` 是「为单节点调优、可用于单节点生产」的模式 [23] | 以后需要 S3 接口时的首选替代 |
| Garage | AGPL-3.0；最低 1 GB 内存；设计重点是跨机房复制 [23a] | 可以用，但单机场景用不上它的优势 |

`BlobStore` 接口只定义 `put / get / delete / stat` 四个方法，先实现本地磁盘版；以后换 SeaweedFS 时，只需要用 `@aws-sdk/client-s3`（3.1152.0）再写一个实现。

## 9. 可观测性，以及为什么不用 Python

- **Langfuse**：自托管需要 web、worker、PG、ClickHouse、Redis 或 Valkey、S3 共 6 个组件，官方的 Compose 只定位为「单机、无高可用」[24]；核心代码是 MIT，`ee/` 目录另有许可证，LICENSE 的版权方是 ClickHouse, Inc. [24a]。v1 的必要性**低**：`session_events` 已经记录了每次模型调用的模型名、token、花费、耗时、输入输出摘要，过程页能直接展示；再加上 pino 结构化日志和 `@pg-boss/dashboard` 就够用。以后真正需要提示词评测或 A/B 时，再评估 Langfuse 或 OTel 导出。
- **Python**：没有明显更合适的理由。Playwright 对 Node 是一等支持，调度、ORM、认证的 TS 生态都成熟。如果以后电脑自动化子 agent 必须用 Python 库，可以单独做成一个 Python worker，通过 HTTP 或 PG 队列接进来，不影响主栈。

## 10. 风险和待确认

1. **pg-boss 的作业时长上限**：`expireInSeconds` 最大 86400 秒 [4]。单个 run-segment 必须在 24 小时内结束，否则会被判定超时重试，因此 agent 循环要定期主动挂起或续租。需要实测 `heartbeatSeconds` 的行为。
2. **事件怎么进来还没定**：1688 消息、WhatsApp 审批、验证码处理完成，是轮询还是 webhook？`match` 的 jsonb 结构要和事件源一起设计。
3. **挂起时是否释放账号租约**：建议释放，继续时重新排队。但如果浏览器登录态绑定在「这个 session 正在用的那个浏览器」上，需要和浏览器共享方案（`browser-sharing.md`）对齐。
4. **cron 时区**：pg-boss 默认 UTC [3]，所有 schedule 都要显式传 `tz: 'Asia/Shanghai'`。
5. **Drizzle 1.0 和 Prisma 8 都处在大版本切换期**，lockfile 要锁死版本；Drizzle 升 1.0 时，迁移文件格式可能变化（未核实）。
6. **飞书 / 企业微信登录**能否直接用 better-auth generic-oauth（是否是标准 OIDC、userinfo 字段长什么样）未核实，接入时要做 PoC。
7. **KEK 的保管人和备份流程**需要公司指定。没有 KMS，这是整个加密方案里最弱的一环。
8. **SSE 经过公司内网代理时是否被缓冲**，部署时要实测。
9. 我没有核实的项：Temporal 等待事件的具体 API、DBOS 长时间等待时的内存行为、Hatchet server 版本号、graphile-worker 对 PG 版本的要求、Garage 最新版本。

## 11. 参考链接（均于 2026-10-17 访问）

- [1] pg-boss 仓库：https://github.com/timgit/pg-boss
- [2] pg-boss Workers（`groupConcurrency` / `localGroupConcurrency`）：https://pgboss.io/api/workers
- [3] pg-boss Scheduling：https://pgboss.io/api/scheduling ；队列策略：https://pgboss.io/api/queues
- [4] pg-boss Jobs（`startAfter`、`singletonKey`、`group`、`db`、`expireInSeconds`）：https://pgboss.io/api/jobs ；适配器：https://pgboss.io/api/adapters
- [5] graphile-worker：https://worker.graphile.org/docs
- [6] BullMQ Pro 按组并发：https://docs.bullmq.io/bullmq-pro/groups/concurrency
- [7] BullMQ Job Schedulers：https://docs.bullmq.io/guide/job-schedulers
- [8] Inngest 自托管：https://www.inngest.com/docs/self-hosting ；[8a] 许可证：https://raw.githubusercontent.com/inngest/inngest/main/LICENSE.md ，版本：https://api.github.com/repos/inngest/inngest/releases/latest ；[8b] https://www.inngest.com/docs/reference/functions/step-wait-for-event ；[8c] https://www.inngest.com/docs/guides/concurrency
- [9] Temporal releases：https://github.com/temporalio/temporal/releases/latest ；[9a] https://docs.temporal.io/self-hosted-guide/deployment
- [10] PostgreSQL 版本策略：https://www.postgresql.org/support/versioning/
- [11] pgvector：https://github.com/pgvector/pgvector
- [12] Trigger.dev Docker 自托管：https://trigger.dev/docs/self-hosting/docker ，https://trigger.dev/docs/self-hosting/overview ；[12a] https://trigger.dev/docs/wait-for-token ；[12b] v4 发布说明：https://newreleases.io/project/github/triggerdotdev/trigger.dev/release/@trigger.dev%2Fsdk@4.0.0-v4-beta.24
- [13] tRPC Subscriptions：https://trpc.io/docs/server/subscriptions
- [14] Hatchet 自托管：https://docs.hatchet.run/self-hosting ，https://docs.hatchet.run/self-hosting/hatchet-lite ；[14a] https://docs.hatchet.run/v1/task-eviction ，https://docs.hatchet.run/v1/durable-event-waits ；[14b] https://hatchet.run/announcement/new-concurrency-features ；许可证：https://github.com/hatchet-dev/hatchet
- [15] better-auth：https://www.better-auth.com/docs/introduction ；[16] admin 插件：https://www.better-auth.com/docs/plugins/admin ；[17] generic-oauth：https://www.better-auth.com/docs/plugins/generic-oauth
- [18] Lucia 弃用说明：https://lucia-auth.com/
- [19] Auth.js 并入 better-auth：https://www.better-auth.com/blog/authjs-joins-better-auth
- [20] MinIO 仓库（2026-04-25 归档）：https://github.com/minio/minio
- [21] MinIO 镜像从 Docker Hub 下架：https://www.stablebuild.com/blog/minio-images-disappeared-from-docker-hub ；https://itsfoss.com/news/minio-moves-away-from-open-source/
- [22] DBOS 架构：https://docs.dbos.dev/architecture ；[22a] https://docs.dbos.dev/typescript/tutorials/workflow-communication ；[22b] https://docs.dbos.dev/typescript/tutorials/scheduled-workflows ；[22c] https://docs.dbos.dev/typescript/tutorials/queue-tutorial
- [23] SeaweedFS：https://github.com/seaweedfs/seaweedfs ；[23a] Garage：https://garagehq.deuxfleurs.fr/ ，许可证讨论：https://git.deuxfleurs.fr/Deuxfleurs/garage/issues/840
- [24] Langfuse 自托管：https://langfuse.com/self-hosting ；[24a] https://github.com/langfuse/langfuse/blob/main/LICENSE
- [25] Docker Compose secrets：https://docs.docker.com/compose/how-tos/use-secrets/
- [26] CVE-2026-39356（drizzle-orm 标识符转义 SQL 注入，CVSS 7.5，在 0.45.2 / 1.0.0-beta.20 修复）：https://osv.dev/vulnerability/CVE-2026-39356 ，https://nvd.nist.gov/vuln/detail/CVE-2026-39356 ；Drizzle 版本说明：https://orm.drizzle.team/docs/latest-releases
- [27] Prisma 8 介绍：https://www.prisma.io/docs/v8 ；发布状态：https://www.prisma.io/docs/orm/release-status
- [28] MDN EventSource（HTTP/1.1 连接数限制）：https://developer.mozilla.org/en-US/docs/Web/API/EventSource
- 版本号：2026-10-17 执行 `npm view <包> version` 和 `npm view <包> dist-tags`
