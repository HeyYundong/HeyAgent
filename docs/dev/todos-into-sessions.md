# 去掉「待办」页：会话接管运行和要人办的事，人加的待办挪进任务详情

2026-10-20，用户确认的原型。代码分支 `todos-into-sessions`。

## 1. 改了什么

| 以前 | 现在 |
|---|---|
| 侧边栏「待办」（看板，五列），数字是等我处理的事 | 去掉。数字挂在「会话」上（`user.needsMeCount`，算法不变） |
| 会话页标签：全部 / 进行中 / 挂起 / 已结束 | 执行中（默认）/ 等人处理 / 等待中 / 验收中 / 已结束，每个带个数，**没有「全部」**。旁边「只看等我处理 N」 |
| 会话页一次拿全部 session（`sessions.list`），前端筛 | 服务端分页 `sessions.page`（一页 50 个），见第 3 节 |
| 要人办的事在看板「等人处理」列，点开 `HumanSheet` 处理 | 「等人处理」标签里：挡住运行的事算在那次运行一行（状态写「等人处理 · 登录」，「在等什么」写那件事）；不挡运行的事（记忆审核、技能修改等）单独一行。处理面板 `HumanItemPanel` 放在运行详情最上面（每件一张），不挡运行的事点开是装着它的抽屉 |
| 运行详情的「去待办处理 →」、任务抽屉的「去待办处理」 | 去掉 / 改成「去处理」（`#/sessions?status=human&id=<运行>`），就地处理 |
| 人加的待办在看板「等待中」列，`TodoSheet` 里立即执行 / 编辑 / 删除 / 手动触发事件 | 任务详情新的一块「什么时候跑」：先一行任务自己的定时（「改」打开编辑任务），再每条人加的待办一行，「⋯」里立即执行、手动触发事件（主管、等事件的）、改、删掉；右上角「加一条」 |
| 任务抽屉头部写定时和预计下次运行 | 挪进「什么时候跑」，头部只写负责人、创建时间 |
| 看板「等待中」里收起的派活卡（`GroupSheet`） | 去掉；会话页按来源「派活」筛 |
| 等事件的运行，看板运行卡上主管「手动触发事件」 | 运行详情右上角（运行在等事件、主管） |
| 来源显示「待办」 | 「人加的」（枚举值还是 `todo`） |

## 2. 文件

- 删除：`apps/web/src/pages/todos/`（`index.tsx` `board.tsx` `sheets.tsx` `human-sheet.tsx` `data.ts` `cron.ts` `use-drag-scroll.ts`）。
- 搬家：`todos/human-browser.tsx` → `sessions/human-browser.tsx`；`todos/todo-dialog.tsx` → `tasks/todo-dialog.tsx`（`MODES`、`cronPresets` 并进来，建好后不再改 `?id=`，可以传 `initialTaskId`）；`todos/cron.ts` 的 `nextRuns` `shortTime` 并进 `tasks/cron.ts`。
- 新增：`sessions/human-item.tsx`（`HumanItemPanel`、`HUMAN_KIND_LABEL`，验收种类叫「验收争议」）、`sessions/parts.tsx`（`Part` `Block` `TextLink` `dots`）、`tasks/task-schedule.tsx`（`TaskScheduleSection`）、`components/ui/pagination.tsx`（`npx shadcn@latest add pagination`，没改）、`apps/server/src/data/session-page.ts`、`apps/server/test/session-page.test.ts`。
- `tasks/run-actions.tsx` 加 `eventOf`、`useFireEvent`、`FireEventButton`（原来在 `todos/sheets.tsx`）。
- shared：`SessionGroup` / `sessionGroups` / `groupOf` 换成五个标签；加 `statusesOfGroup`、`sessionPageInputSchema`、`sessionPageSchema`、`isNeedsMe`；删掉 `boardCards`、`BoardCard`、`boardColumns`、`BoardColumn`（只有看板和它的测试用）。`liveQueriesByTable` 加 `sessions.page`。
- `PageFrame` 的 `skeleton="board"` 去掉。
- 「看懂架构」的 `todo` 一课（id 不变）改讲会话的五个状态。

## 3. 网址和接口

- 会话页：`#/sessions?status=human|waiting|verifying|ended`（执行中不写）、`&mine=1`、`&page=N`（第 1 页不写）、`&id=<运行或要人办的事>`；`?q` `?source` `?task` `?outcome` 照旧能带进来。换标签、只看等我处理、来源、结果、任务、搜索都回第 1 页；打开一行（`?id=`）保留页码；页码超出时服务端给最后一页。打开的运行不在这一页时按 `sessions.get` 取。
- 旧地址 `#/todos`、`#/inbox` 跳到 `#/sessions?status=human`，`?id=` 照带（`lib/router.ts`，地址栏用 `replaceState` 换掉）。
- `sessions.page`（`apps/server/src/data/session-page.ts`，接口说明在 `api.md` 3 节）：筛选、搜索、数数、翻页在库里做；`mine` 只算挡住运行的事（`approval` `verify` `login`）；`counts` 不算 `group` 和 `mine`；`spentToday` 不看筛选。`sessions.list` 不变，任务页、派活页、处理面板等还在用。
- 不挡运行的事从 `todos.board` 来，只在「等人处理」和「只看等我处理」的第 1 页、列表最上面，不算进翻页；「等人处理」标签的数字 = `counts.human` + 这些事。
- 「等你处理」的通知链接：`#/sessions?status=human&id=<运行 id>`，记忆审核、技能修改是 `&id=<这件事的 id>`（`engine/notify.ts` 的 `humanItemLink`，原来是 `TODOS_LINK = "#/todos"`）。
- 助手：`create_todo` / `update_todo` 的结果链接改成那个任务（`{ page: "tasks", params: { id } }`）；提示词里的页面名去掉「待办」，`sessions` 叫「会话」。
- 其他链接：派活单详情「去处理 →」、技能页「看改动」、任务抽屉「去处理」都指向 `#/sessions?status=human&id=…`。

## 4. 没动的

- 接口 `todos.board` / `todos.create|update|delete`、`engine.runTodoNow`、权限 `todo.*` 的名字都没改。
- `human_items.session_id`：记忆审核、技能修改也带着提出它的那次运行；会话页按「挡不挡运行」分，不按有没有 session 分。
- 历史里程碑文档（m1、m2、m3 等）不改。
