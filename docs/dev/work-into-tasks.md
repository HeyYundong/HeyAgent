# 去掉「派活」页：排队的单进会话页，每张单进被派任务的详情

2026-10-21，用户确认的原型（worktree 里的 `mock3/local.html`，不进 git）。代码分支 `work-into-tasks`。做法照上一次去掉「待办」页（`docs/dev/todos-into-sessions.md`）。

## 1. 改了什么

| 以前 | 现在 |
|---|---|
| 侧边栏「工作 → 派活」（左边单的列表，右边单详情） | 去掉。接口 `work.*` 都留着 |
| 会话页标签：执行中（默认）/ 等人处理 / 等待中 / 验收中 / 已结束 | 最前面加「排队中」（默认还是执行中）：全部任务里排队的派活单（还没开运行，没有 session） |
| 会话页右上角「执行中 · 等人处理 · 今天花了」 | 「排队 · 执行中 · 等人处理 · 今天花了」；看「已结束」时再加「办成 X · 没办成 Y · 成功率 Z%」 |
| 会话列表按开始时间倒序，不能换 | 「开始」「结束」表头能点：按这一列排、再点换方向（服务端排序，空的在最后） |
| 会话列表来源「派活 W-3」是字 | W-3 是链接：在被派任务的抽屉里打开那张单 |
| 任务详情「派活」区块：一行数字（排队 / 在办 / 今天办成 / 没办成）点了去派活页 | 「派来的活」：名额一行、参数和谁能派一行；没结束 / 办成 / 没办成（带张数）+ 搜单号、参数；单的列表，「再看更多」；右上角「派一张」 |
| 派活页右边的单详情 | 任务抽屉里（`?work=W-…`，最上面「← 返回任务 T-…」），会话页「排队中」点开的抽屉里也是它 |
| 任务卡片只写「被派活 · 同时最多 N 个」 | 下面多一行「排队 3 · 在办 2」（只写不是 0 的） |
| 派活方「派出去的活」右上角「去派活页」（`?from=`） | 去掉；派给的任务名是链接，最近一次有新单的运行也是链接 |
| 派一张：派活页右上角，或任务抽屉底部；派出去后提示「去派活页」 | 任务抽屉底部和「派来的活」右上角；提示「去看 W-…」（任务抽屉里打开那张单）。`?dispatch=1` 直接打开 |
| 人派的单写「某某在派活页派的」 | 「某某手动派的」（单详情、处理记录、运行第一条消息和「运行开始」事件） |

## 2. 文件

- 删除：`apps/web/src/pages/work/`。
- 搬家（`git mv`）：`work/parts.tsx` → `tasks/work-parts.tsx`（加 `workLink`、`useWorkQueueStats`、`queueWaitText`）；`work/dialogs.tsx` → `tasks/work-dialogs.tsx`（「已经有了」的「去看 W-…」改成任务抽屉）；`work/index.tsx` → `tasks/work-detail.tsx`（只留单详情 `WorkDetail` 和它的提示、结果、处理记录；新 `WorkItemView` 带着改参数 / 不办了 / 重办的弹窗；`quotaText`）。
- 新增：`tasks/work-section.tsx`（`DispatchInSection`「派来的活」、`TaskDispatchDialog` 从 `task-detail.tsx` 搬来）、`sessions/queue.tsx`（`QueueTable` `QueueItems`）、本文件。
- 改：`tasks/task-detail.tsx`（换区块、`?dispatch=1`、「派出去的活」）、`tasks/index.tsx`（`?work=`、卡片一行、旧链接查单）、`tasks/run-detail.tsx`（单的链接）、`sessions/index.tsx`（排队中、排序、成功率）、`sessions/list.tsx`（`SortHead`、来源链接）、`lib/router.ts`（`work` 不再是页面，旧地址跳转）、`App.tsx`、`components/shell/app-sidebar.tsx`、`imports/result.tsx`（认 `dispatch=1`）、「看懂架构」`todo` 一课提一句排队中。
- 服务端：`data/session-page.ts`（`sort` `dir` `endedOutcome`）、`work/service.ts`（`offset`、`workQueueStats`）、`trpc/work-router.ts`（`queueStats`）、`imports/follow-ups.ts` 和 `engine/dispatch/dispatch.ts`（链接）、`engine/sessions.ts`（「手动派的」）、`engine/tools/builtin-defs.ts` `imports/organize.ts`（文字不再提派活页）、`assistant/prompt.ts`（页面名去掉「派活」；在任务页看单时告诉助手）。
- shared：`sessionPageInputSchema` 加 `sort` `dir`，`sessionPageSchema` 加 `endedOutcome`；`workListInputSchema` 加 `offset`；新 `workQueueStatsSchema` / `WorkQueueStats`；`liveQueriesByTable` 的 `tasks` `sessions` `work_items` 加 `work.queueStats`。
- 测试：`session-page.test.ts`（排序：两列、两个方向、各标签、空的在最后；`endedOutcome`：和 `outcomeOf` 一致、跟着筛选、复核中不算）、`dispatch.test.ts`（`work.queueStats`：数字、`holders`、关了被派活的也列、没被派活的不列、要登录；`offset` 翻页）、`dispatch-p2.test.ts`（「派一张试试」的链接）。

## 3. 网址和接口

- 会话页：`#/sessions?status=queue`（排队中）；点一张单 `&id=W-…`（会话页按 `W-` 开头认出是单）；`?page=` 照旧（排队中按 `work.list` 的 `offset` 翻，一页 50 张，个数 = `counts.queued`）。排队中只跟着 `?task=` 和搜索（`work.list` 的 `q`：单号、标题、参数），来源、结果两个下拉不显示（排队的单没有来源和结果）；数字也只跟着任务和搜索。「只看等我处理」开着时排队中让给它。
- 排序：`?sort=started|ended`、`?dir=asc`（默认 `desc` 不写），每个运行标签都能用（排队中不用）；换排序回第 1 页。默认（不写进网址）：「已结束」按结束时间倒序，别的标签（和只看等我处理）按开始时间倒序；换标签、开关只看等我处理时清掉排序，回到那个标签的默认。不挡运行的事（等人处理第 1 页）照旧在最上面。
- 任务页：`#/tasks?id=T-…&work=W-…` 在抽屉里看单（和 `&run=` 看运行同一个办法；两个都有时先看运行，返回回到单）；`&dispatch=1` 打开「派一张」（负责人、主管，关掉时去掉）。只有 `?work=W-…`、没有 `?id=` 时（旧链接跳过来的）先 `work.get` 查派给了谁，再 `location.replace` 换成带 `id` 的；查不到提示「找不到派活单」回任务页。
- 旧地址（`lib/router.ts` 的 `fromWork`，地址栏用 `replaceState` 换掉）：`#/work?id=W-…` → `#/tasks?work=W-…`（再如上查任务；带了 `task` 的直接 `#/tasks?id=…&work=…`）；`#/work?task=T-…`（`&new=1`）→ `#/tasks?id=T-…`（`&dispatch=1`）；`#/work?from=T-…` → `#/tasks?id=T-…`；其余 `#/work…` → `#/sessions?status=queue`。库里旧通知的链接靠它照样能点。
- 链接：导入后「派一张试试」`#/tasks?id=<任务>&dispatch=1`（`follow-ups.ts`；前端照样认旧的 `#/work…`）；「今天被派的单到了上限」通知 `#/tasks?id=<任务>`（`dispatch.ts`）；运行详情「派活触发 · W-…」「看派活单」「派出去的活」、会话列表来源、「派一张」的提示和「已经有了」都指向 `#/tasks?id=<被派任务>&work=<单号>`。
- `sessions.page` 新字段（`api.md` 3 节）：输入 `sort: "started" | "ended"`（默认 started）、`dir: "asc" | "desc"`（默认 desc），`ORDER BY <列> <方向> NULLS LAST, id <方向>`；输出 `endedOutcome: { achieved, notAchieved }`：已结束的运行，筛选同 `counts`（来源、任务、结果、搜索），口径同 `outcomeOf`，复核中（`done`、没结果）两边都不算。页面上成功率 = round(办成 /（办成 + 没办成）× 100)，都是 0 写「—」。
- `work.list` 新输入 `offset`（给了就不看 `cursor`）。新接口 `work.queueStats`（`api.md` 16.2）：全部被派任务的 `{ taskId, enabled, dispatchable, maxRunning, queued, running, occupied, holders }`，三条查询；任务卡片的「排队 · 在办」和排队中的「在等什么」用。
- 「在等什么」（`queueWaitText`）：等自动重试的写「第 n 次出错，14:49 自动重试」；任务关了被派活 / 停用了写「单先排着」；名额满了写「名额满了：R-…、R-… 在跑」（超过 3 个写「等 N 个」），前面还有的写「前面还有 n 张」；有空位写「有空位，马上开始」。
- 助手：提示词的页面名去掉 `work`；在任务页看单（`?work=`）时上下文写「正在看派给它的派活单 W-…」。

## 4. 没动的

- 接口 `work.list|get|taskStats|lookup|dispatch|updateParams|redo|cancel`、权限 `work.manage` 的名字和行为都没改；agent 的内置工具（派活、查派过的活、报结果）没改，只改了「派活」说明里提派活页的一句。
- 单详情的内容（提示、参数、结果、处理记录、「⋯」三个操作和确认）照搬，只改了「在派活页派的」的说法。
- 历史文档（`dispatch-p1.md` `dispatch-p2.md` 等）不改；`dispatch.md` 9.2、9.3 节加了一句指过来。
