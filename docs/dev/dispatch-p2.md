# 派活第二期（开发说明，2026-10-18）

> **状态：已完成（2026-10-18）。** 用户确认了第 8 节 11 个问题（全部按建议）和设计稿（`design/BRIEF-dispatch-p2.md`）；实现记录、联调记录在文末。
> 方案：`docs/dev/dispatch.md`（用户 2026-10-18 确认）第 13 节「第二期」。第一期的说明和实现记录：`docs/dev/dispatch-p1.md`；接口：`docs/dev/api.md` 第 16 节。
> 文中写「现在」的，都是读 main（1e7254d）的代码确认过的，后面写了文件和函数名。

## 0. 一页纸

第二期做 5 件事，外加 1 个小修：

| # | 做什么 | 一句话 |
|---|---|---|
| 1 | **导入直接导成派活** | 读包的 AI 看到「一个任务找出一批事、交给另一个任务一件件办，中间靠本机服务或队列串起来」时，把办事的任务设成「可以被派活」，并让找事的任务能派活给它。导入时自动配好，不用再按方案 12.3 节手动改 |
| 2 | **派活方能等结果** | 单结束时，叫醒正在等 `work.done:<单号>` 的运行；新内置工具 `work.list`，查自己派过的单 |
| 3 | **被派的运行写结构化结果** | 新内置工具 `work.report`，写几个「名字 → 值」，写回单上，派活方和派活页都能看到。建议顺便让它能报「这件办不成」（问题 5） |
| 4 | **没办成自动重试** | 任务上配「自动重试 N 次，间隔 M 分钟」，默认 0（不重试）。只对运行出错重试，人取消、人选了不继续、agent 说办不成的都不重试 |
| 5 | **看板收起被派的卡片** | 同一个任务被派来、在「挂起等待」的运行有 2 个及以上时，看板上收成一张「处理 XX · 23 个在等」，点开看清单 |
| 小修 | **没有检查点就不提检查点** | 任务没写步骤（检查点清单是空的）时，不给 agent `checkpoint.mark`，系统提示里也不提检查点 |

**最要你拍板的 3 件事**（全部在第 8 节）：
- 接受派活的任务，导入时有定时要不要**自动去掉**（问题 2）；
- `work.report` 要不要能报「**这件办不成**」（问题 5）；
- 自动重试**哪些失败算**（问题 7）。

**分包**：先由监工写骨架，包括 shared 的形状、迁移 `0018`、原型；然后后端、前端各交给一个子 agent。整体约 2～3 个工作日，含真模型联调。界面改的地方先出原型给你看，确认后再写正式代码。

---

## 1. 导入直接导成派活（方案第 10 节）

### 1.1 方案格式

`packages/shared/src/imports.ts` 的 `planTaskSchema` 加一个可选字段。旧的方案里没有它，照样能读：

```ts
/** 可以被派活（null / 不写 = 不能）。fromKeys：谁能派活给它（方案里的任务 key） */
dispatch: z.object({
  params: z.array(taskDispatchParamSchema).max(20),
  maxRunning: z.number().int().min(1).max(20),
  fromKeys: z.array(key).max(20),
}).nullable().optional(),
```

派活方不需要新字段，只要在 `toolKeys` 里有一个内置工具「派活」（`kind = builtin`，`refId = work.dispatch`）。

### 1.2 给模型的格式（`imports/prompt.ts` 的 `planModelSchema.tasks`）

照现在的写法，结构扁平、字段全部必填（严格模式不认可选字段）：

| 字段 | 说明（给模型看的） |
|---|---|
| `acceptsDispatch: boolean` | 这个任务是「一次办一件事」的，要别的任务把一件件事派给它时为 true |
| `dispatchParams: [{ name, description, required, dedupe }]` | 每件事要带的参数。用哪个判断「是不是同一件事」就把它标 dedupe。不接受派活的写空数组 |
| `dispatchMaxRunning: number` | 同时最多办几件。包里没说就写 1 |
| `dispatchFromKeys: string[]` | 哪些任务派活给它（任务 key） |

`toPlan` 负责转换：`acceptsDispatch = false` 时 `dispatch = null`，并忽略其余三个字段。

### 1.3 系统提示（`READER_SYSTEM`，内容通用，不写任何业务）

在「本平台的概念和填法」的「任务」后面加一条：

> - 派活：一个任务找出一批要办的事，交给另一个任务一件一件办（原来靠本机的待办服务、队列、数据库或文件串起来，例如一个定时巡检把事写进待办服务，另一个从里面领一件办一件）时，导成「派活」：
>   - 办事的任务 `acceptsDispatch = true`。参数写清每件事要带什么（名字用中文，一两个字段就够），用来判断是不是同一件事的那个标 dedupe。`dispatchFromKeys` 写找事的任务。一般不定时（cron 写空字符串）。
>   - 找事的任务在 `toolKeys` 里加内置工具「派活」（kind = builtin，refId = work.dispatch）。步骤里写「把每件要办的事用『派活』派给『<办事任务的标题>』，参数填……」。写**标题**，不要写 t1、t2 这种 key（导入后 key 就没了）。
>   - 中间那个本机的待办服务、队列，以及它的工具契约（领单、标记完成这类）不导入，在 unused 里写「用平台自带的『派活』代替」。
>   - 办事任务原来「先领一件」「领到了再办」的步骤去掉：平台会把这件事的参数放在运行的第一条消息里。

另外，「只有函数定义、没有接口地址的工具契约」那条，加一句：「领单、派单、标记完成这类，用平台自带的『派活』代替」。

### 1.4 整理（`imports/organize.ts`，由代码做）

- `fromKeys` 只留方案里存在、不是自己的任务 key，去掉的写进 warnings。`include` 没勾的任务在导入时再过滤（见 1.5），因为人在向导里可能改勾选。
- 派活方的 `toolKeys` 里没有「派活」：`plan.tools` 里没有 `refId = work.dispatch` 的就补一项（kind builtin，why 写「把事派给『xx』」），再把它的 key 加进派活方的 `toolKeys`。
- 参数：名字去空白、去重，最多 20 个。名字为空的去掉。一个参数都没有的不处理，任务照样能被派活，只是派的时候要自己填 key。
- `maxRunning` 卡在 1～20 之间。
- **接受派活又有定时的：去掉定时，写一条 warnings**（「『xx』会被派活，不用定时；原来的定时『每分钟』已去掉，要的话在向导里加回来」）。这是问题 2 的建议做法。
- `dispatch` 不为空、但 `fromKeys` 是空的：照样导入，因为人可以在派活页手动派。写一条提醒「还没有任务派活给它」。

### 1.5 导入（`imports/commit.ts`）

- ⑥ 建任务时带上 `dispatch: { params, maxRunning }`，先不带 `dispatchFrom`（派活方可能还没建）。
- 全部任务建完后加一步 ⑥b：对每个有 `dispatch` 的任务，把 `fromKeys` 里**勾上了**的换成 id，写进 `task_dispatch_sources`。这里在 `data/config/tasks.ts` 里抽一个事务内的 `setDispatchSources(tx, taskId, sourceIds)`，校验和 `writeLinks` 一样。没勾上的派活方去掉；去掉以后一个都不剩的，在导入结果的 follow-up 里提醒。
- 撤销（`imports/undo.ts`）不用改：关联表随任务级联删除。
- 导入后不发 `work.pump`：刚导入时还没有单。

### 1.6 导入后还要做的事（`imports/follow-ups.ts`）

- 现在的「试跑」（`try_run`）对能被派活的任务改成「派一张试试」，链接到 `#/work?task=<id>&new=1`（派活页打开「派一张」弹窗，已选好任务）。只要这个任务名下有过一张单，就算办完。
- 派活方的「试跑」不变。

### 1.7 向导页（`pages/imports/wizard.tsx` 的任务那一步，加修改弹窗 `edit-dialogs.tsx` 的 `TaskForm`）

- 任务卡片（`TasksStep`）：
  - 接受派活的任务多一行：「接受派活：参数 单号（必填，去重）· 同时最多 1 个 · 来自「巡检」」，图标 `InboxIcon`；
  - 派活方多一行：「派活给「处理一张搜品单」」，图标 `SendIcon`；
  - 派活方没勾上时，接受派活那行写「来自：（没有勾上的任务）」。
- 修改弹窗：加「被派活」一组，样子和任务配置弹窗（`pages/tasks/task-dialog.tsx`）的那组一样，包括开关、参数行、名额、谁能派活给它。「谁能派活给它」的选项是方案里的其他任务。最好把任务弹窗里那组抽成一个共用组件，两边一起用。
- 原型先改 `design/prototype/src/pages/imports/`，给你确认。

### 1.8 验证

- 单元测试（假模型）：`toPlan` 的转换；`organize` 的六条规则；`commit` 建出来的任务带 `dispatch`，`task_dispatch_sources` 写对，包括派活方排在后面、派活方没勾的情况；撤销后关联也没了。
- 真模型：用你的 `sourcing-agent-portable.zip` 再读一次（Opus 5.5，上次约 4 分钟、$1.1）。看三点：t2 被导成接受派活、参数是单号；t1 选上了「派活」；sourcing-todo 的 8 个契约进了 unused，并写明「用派活代替」。

---

## 2. 派活方等结果

### 2.1 单结束时叫醒

- 单结束的地方有 4 类，结束时都按事件名 `work.done:<单号>` 叫醒等它的运行：
  - `settle.ts` 的 `writeSettled`（办完 / 没办成）；
  - `manage.ts` 的「不办了」；
  - 清扫补写（`sweep.ts`）；
  - 自动重试用完（第 4 节）。只有**最终结束**才叫醒，中间排队重试的不叫醒。
- 做法：在结束的那个事务里，用 pg-boss 发一个新任务 `work.notify`（参数是单号）。worker 处理时调 `waitsForEvent(db, "work.done:W-57", data)`，再调 `resume`，就是 `control.ts` 里 `fireEventImpl` 的那一段，不过从内部直接调，不经过外部事件的令牌。不在结束的事务里直接 resume，是因为 resume 会开别的事务，还要发 `session.run`。
- `data` 是 `{ item: "W-57", status: "done" | "failed" | "cancelled", title, summary?, error?, report? }`。被叫醒的运行看到的是 resume 消息里的这段事件数据，现在 `fireEventImpl` 就是这么拼的。

### 2.2 先结束、后等（竞态）

agent 派完单就调 `session.wait(event: "work.done:W-57")`，但单可能在它挂起之前就办完了，这样它会一直等到兜底期限。为此：`session.wait` 的处理（`tools/builtin.ts`）在事件名是 `work.done:` 开头时，先查那张单：

- 已经结束：不挂起，直接返回「W-57 已经办完：总结……」（和叫醒时的内容一样）；
- 单不存在，或者不是这个任务派的：报错。

要防的是「查的时候还没结束，挂起之前结束了」这个窗口。办法是挂起的事务（`suspendInTx`）提交以后，再查一次单的状态：已经结束就自己补发一个 `work.notify`。叫醒是幂等的，等待记录 resume 一次就变成 resumed，所以多发没有副作用。

### 2.3 一次等好几张

**建议不新加「等好几张」的工具**（问题 3）：

- agent 用现成的 `session.wait` 一次等一张。被叫醒后调 `work.list` 看还有哪些没结束，再等下一张。
- 系统提示（派活方的「可以派活给」那一节）加一句：「要等结果时：用 session.wait 等事件 work.done:<单号>，一次等一张；醒来后用 work_list 看其余的」。
- 缺点：等 N 张单要醒 N 次，每次调一次模型。派活的典型用法是「派完就走」（巡检派完就结束），要等结果的少；以后真有「派 50 张、全办完再汇总」的用法，再加 `work.wait(items, mode: all)`。

### 2.4 新内置工具 `work.list`（模型看到的名字 `work_list`，中文名「查派过的活」）

- 加进 `BUILTIN_TOOLS` 和 shared 的 `builtinToolInputs`，风险 `read`。**不单独选**：任务选了「派活」就自动带上，和「选了技能就自动带上 skill.load」一样（`sessions.ts`）。理由是只有派活的任务用得着它。
- 输入：
  ```ts
  "work.list": z.object({
    items: z.array(z.string()).max(50).optional().describe("按单号查，例如 [\"W-57\"]"),
    status: z.enum(["queued", "running", "done", "failed", "cancelled", "open"]).optional()
      .describe("open = 还没结束的（排队 + 在办）"),
    thisRun: z.boolean().optional().describe("只看这次运行派的（默认看这个任务派过的全部）"),
    limit: z.number().int().min(1).max(50).optional(),
  })
  ```
- 只能查**这个任务派出去的**单（`from_task_id` = 自己的任务），别的任务的单查不到。
- 返回格式和 `work.dispatch` 的一样，每张一行，最新的在前，默认 20 张：
  `- W-57「搜品单 PSS-0012」办完（10-18 14:02）：已建源商品 3 个… · 结果：源商品数=3`
- 还有更多没列出来时，最后加一行「还有 37 张，用 status / items 缩小范围」。

---

## 3. 被派的运行写结构化结果：`work.report`

### 3.1 工具

- 名字「报结果」（`work_report`），风险 `read`（只写自己这张单，不对外）。**只在被派来的运行里自动带上**（快照里有 `dispatch` 时），任务不用选。
- 输入：
  ```ts
  "work.report": z.object({
    data: z.record(z.string().max(40), z.union([z.string().max(1000), z.number(), z.boolean()]))
      .describe("结果的几个字段，例如 { \"源商品数\": 3, \"后台已回填\": true }；最多 20 个"),
    outcome: z.enum(["done", "not_done"]).optional()
      .describe("not_done = 这件事办不成（例如找不到、对方拒绝），写了就结束这张单，不再重试"),
    reason: z.string().max(1000).optional().describe("outcome = not_done 时必填：为什么办不成"),
  })
  ```
- 可以调多次，每次把 `data` 合并进去，同名字段以后一次为准。
- 存进 `work_items.result.data`（`workResultSchema` 加可选的 `data`）。单还在办的时候就写进去，派活页能看到「已报：源商品数 3」。
- 系统提示（被派来的那一句）加：「有要交回去的结果（数字、是 / 否、编号），用 work_report 写；办不成就用它报 not_done 并写原因」。

### 3.2 要不要声明「结果有哪些字段」

**建议第二期不声明**（问题 4）。理由：

- 参数要声明，是为了去重和当场拒单。结果没有这个需要，派活方和人看的都是文字。
- 以后要在派活页按结果统计（「今天一共建了多少源商品」），再在任务上加「结果字段」的声明。

### 3.3 「这件办不成」（问题 5）

现在被派的运行只有两种结局：

- 说做完了 → 单「办完」；
- 运行失败 → 单「没办成」。

但有一种常见情况：agent 认真办了，结论是办不成，比如找不到同款，或者商家都不做。现在它只能「说做完了」，单记成「办完」，派活页上分不出来；或者故意让验收不通过，那就要转人工，白花一轮验收。

**建议**：`work.report(outcome: "not_done", reason)` 记下「办不成」。运行照常结束：

- 运行本身是「已完成」，验收照常做，看的是「有没有如实办、如实报」；
- 单在结束时记成**没办成**，`error` = agent 写的原因，前面加「agent 判断办不成：」；
- 不自动重试；
- 照常给负责人发失败通知。

这样派活页上「没办成」里能分出「运行出错」和「agent 判断办不成」两种（单上加 `failKind: "error" | "not_done" | "cancelled_run"`，页面显示成不同的说明）。

### 3.4 显示

- 派活页单详情的「结果」区块：总结下面一个 `Table`（字段、值）显示 `data`。
- 没办成的 `Alert` 里，按 `failKind` 写「运行出错」或「agent 判断办不成」。
- `work.dispatch`、`work.list` 的返回和 2.1 的叫醒数据里，都带上 `data`，压成一行：`源商品数=3，后台已回填=是`。

---

## 4. 没办成自动重试

### 4.1 配置

`taskDispatchSchema` 加两个字段，旧数据没有就当 0：

```ts
retries: z.number().int().min(0).max(5).default(0),          // 没办成自动重试几次
retryDelayMinutes: z.number().int().min(1).max(1440).default(10), // 隔多久再试
```

任务弹窗「被派活」那组加一行：「没办成自动重试」用 `Select`（不重试 / 1～5 次），选了次数才出现「间隔」的 `Select`（1、5、10、30、60 分钟，2、6、24 小时）。「?」里写：「只对运行出错重试（模型调用失败、程序出错、验收判失败等）；人取消的、选了不继续的、agent 判断办不成的不重试。会对外发消息的任务慎用：重试可能重复发」。

### 4.2 哪些算、哪些不算（问题 7）

| 运行怎么结束的 | 重试吗 |
|---|---|
| `loop.ts` 的 `failSession`：模型解析失败、模型调用重试完还失败、引擎意外出错、验收判失败（`decision.action === "fail"`） | **重试** |
| `failSession`：规则命中「让运行失败」（`before.action === "fail"`） | 不重试（规则就是要它停） |
| 人取消运行（`cancelSessionImpl`） | 不重试 |
| 花费 / 步数上限，人选「不继续」 | 不重试 |
| 验收争议，人判「失败」 | 不重试 |
| agent 报「办不成」（3.3） | 不重试 |
| 清扫补写（运行没了、漏写） | 重试 |

`settleWorkItemInTx` 的 `outcome` 加一个 `retryable: boolean`，5 处调用各自填。`failSession` 要区分规则失败和别的失败，加一个参数。

### 4.3 怎么重试

- `writeSettled` 里，`retryable && 这一轮已经自动重试的次数 < retries` 时，单不记「没办成」，而是：
  - 回到**排队**，`error` 写这次的原因；
  - `not_before = now + 间隔`；
  - `log` 记 `retry_scheduled`（第几次、原因、什么时候再试）。
- 「这一轮已经自动重试的次数」新加一列 `auto_retries`。人点「重办」时清零，所以重办以后又有完整的 N 次。`attempts` 照旧记一共开过几次运行。
- 新列 `work_items.not_before timestamptz`（方案第三期本来就有「过多久再办」，第二期先给重试用）。领单（`pump.ts`）取排队单时加条件 `not_before is null or not_before <= now()`。
- 到点怎么开：
  - 写 `not_before` 时，同一个事务里发一个**延迟**的 `work.pump`（pg-boss 的 `startAfter`）；
  - 每分钟的清扫已经会给「有排队单的任务」发 `work.pump`，算兜底；
  - 现在 `work.pump` 是 `stately` 加 singletonKey，延迟的那个和别的可能合并掉，所以兜底要靠清扫：清扫的条件改成「有**到点的**排队单」。
- 通知：还会重试的那次失败，**不发**失败通知（`failSession` 结尾的 `notifyUsers`）；最后一次没办成才发，正文写「自动重试了 2 次都没办成：原因」（问题 8）。
- 派活方：中间重试的不叫醒（2.1）。`work.dispatch` 再派同一张单时返回「排队（第 2 次重试，10:35 以后）」。

### 4.4 显示

- 派活页单的状态徽章：排队且 `not_before` 在将来 → 「排队 · 10:35 重试」。
- 处理记录（`Trace`）里每次失败一行，后面跟「10 分钟后自动重试（第 1 / 2 次）」。

---

## 5. 看板收起被派的卡片（方案 9.5 节）

### 5.1 规则

- 只收「挂起等待」那一列（`waiting`）：同一个任务、`source = dispatch` 的运行有 **2 个及以上**时，收成一张。
- 执行中、验收中的不收：它们受名额限制，一般只有一两个，而且每个都在变。
- 「要人办的事」那列不收：每件都要人一件件处理（问题 9）。
- 收起的卡片：
  - 标题是任务名；
  - 一行「派来的活 · 23 个在等」；
  - 一行「最早 10-17 14:02 起等 · 最近一个 10-18 09:40 到点」（取等待里最早到点的时间）。
- 点开：右侧 `Sheet`，列出这 23 个运行，每行是运行编号、派活单号和标题、在等什么、什么时候继续，点了进运行详情。底部「去派活页看全部」按钮，链接 `#/work?task=<id>&status=running`。

### 5.2 改的地方

- `packages/shared/src/domain.ts` 的 `BoardCard` 加一种：
  `{ kind: "group"; id: string; column: "waiting"; task: TaskDef; runs: SessionRun[] }`。`boardCards` 先照现在的规则算出全部卡片，再把符合 5.1 的合并成一张。纯函数，在 `domain.test.ts` 加用例。
- `pages/todos/board.tsx` 加 `GroupCard`，点开用 `Sheet`（在 `sheets.tsx` 里加一个）。原型先改。
- 列头的数字：按卡片数还是按运行数？建议**按运行数**，收起的卡片算 23（问题 9）。

---

## 6. 小修：没有检查点就不提检查点

现在的情况：

- `checkpoint.mark` 是每个任务都自带的（shared `ALWAYS_ON_BUILTIN_TOOLS`）；
- 系统提示「怎么工作」里写死了「哪些检查点没完成以及原因」「验收员会逐条核对检查点」（`engine/prompt.ts` 最后一节）。

所以没写步骤的任务，比如被派的「处理一张 xx」，检查点清单是空的，agent 照样会去调 `checkpoint.mark`，被拒以后还在总结里写「检查点清单为空」。

改法：

- 快照里 `checkpoints` 为空时，`checkpoint.mark` **不放进**给模型的工具清单。在 `ToolGateway` 组工具清单的地方过滤，快照的 `tools` 不改，规则页、任务页照样显示它是自带的。
- 系统提示「怎么工作」：
  - 有检查点时，照现在这样写；
  - 没有时，写「全部做完后，直接回复一段总结（做了什么、结果在哪、没做成的以及原因）」，验收那句改成「验收员会按目标核对结果和证据」。
- 这一节本来就在快照冻结的范围里（系统提示每次运行算一次），不影响前缀缓存。
- 测试：没有步骤的任务，给模型的工具里没有 `checkpoint_mark`，系统提示里没有「检查点」三个字；有步骤的不变。

---

## 7. 分包和改的文件

### 7.1 监工先做（骨架）

- shared：
  - `imports.ts`：`planTaskSchema.dispatch`；
  - `dispatch.ts`：`taskDispatchSchema` 的 `retries`、`retryDelayMinutes`；`workResultSchema.data`；`workItemSchema` 的 `notBefore`、`autoRetries`、`failKind`；新的 log 种类 `retry_scheduled`、`reported`；
  - `engine.ts`：`work.list`、`work.report` 的输入；
  - `domain.ts`：`BoardCard` 的 `group`。
- 迁移 `apps/server/drizzle/0018_dispatch_p2.sql`：`work_items` 加 `not_before`、`auto_retries`、`fail_kind`，加索引 `(task_id, status, not_before)`。`tasks.dispatch` 是 jsonb，新字段不用迁移。
- 原型：`design/prototype` 里改向导任务卡片和修改弹窗、任务弹窗的重试、派活页的结果字段和重试状态、看板收起的卡片和清单。截图给你看，**确认后**再开子 agent。

### 7.2 后端（1 个子 agent，Opus 5.5 high）

- `imports/prompt.ts`、`organize.ts`、`commit.ts`、`follow-ups.ts`；`data/config/tasks.ts`（`setDispatchSources`）；
- `engine/dispatch/`：`settle.ts`（重试、`failKind`、叫醒）、`pump.ts`（`not_before`）、`sweep.ts`、`manage.ts`（不办了时叫醒、重办时 `auto_retries` 清零）；新文件 `notify.ts`（`work.notify` 队列）；
- `engine/tools/builtin-defs.ts`、`builtin.ts`（`work.list`、`work.report`，以及 `session.wait` 遇到 `work.done:` 的处理）；
- `engine/sessions.ts`（自动带上 `work.list`、`work.report`）、`engine/prompt.ts`（第 6 节、派活提示里的两句）、`engine/loop.ts`（`failSession` 区分规则失败、还会重试的不通知）、`engine/control.ts`、`engine/humans.ts`（`retryable`）、`engine/queue.ts`、`worker-runtime.ts`（`work.notify`）；
- 工具网关里过滤 `checkpoint.mark`；`docs/dev/api.md` 第 16 节补充。
- 测试用真 PostgreSQL 私有库、假模型。

### 7.3 前端（1 个子 agent，Opus 5.5 high）

- `pages/imports/wizard.tsx`、`edit-dialogs.tsx`（任务卡片两行、被派活一组）；
- 抽出 `pages/tasks/` 里「被派活」那组成共用组件，加重试两项；
- `pages/work/`（结果字段表、重试状态、`failKind` 的说明、URL `new=1` 打开派一张）；
- `pages/todos/board.tsx`、`sheets.tsx`（收起的卡片）；
- `docs/guide.md` 的「派活」一节补充：等结果、报结果、重试、导入；
- 只用 shadcn 预设组件。上面用到的都是 registry 组件，预计不用走例外流程。

### 7.4 监工收尾

- 审两个包的改动，合并；
- 跑全部测试、typecheck、lint、build；
- 真模型联调：
  1. 重新导入搜品的包，看自动配好的派活关系；
  2. 用一对演示任务，派活方派 3 张后 `session.wait` 等其中一张，看能不能被叫醒；
  3. 被派的一张用 `work.report` 报「办不成」；
  4. 一张故意让模型配置出错，看重试 2 次后才没办成、只通知一次；
  5. 看板上 3 个在等的收成一张。
- 写实现记录，commit，push 到 main。:8080 的 pod 不重建，等你说。

---

## 8. 需要你拍板的问题

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | 导入时**只在包内**配派活关系，还是也能派给系统里已有的任务 | **只在包内**。派给已有任务要 AI 去猜「库里哪个任务是它」，容易配错；要的话导入后在任务弹窗里手动加 |
| 2 | 接受派活的任务，包里有定时（比如搜品 t2 每分钟一次），**导入时要不要自动去掉** | **自动去掉**，写一条提醒，向导里能加回来。方案第 10 节原来写的是「只提醒、不去掉」。但被派的任务按定时跑出来的运行没有参数，不知道该办哪件，只会白花钱；搜品 t2 就是这样 |
| 3 | 派活方等好几张单：第二期只能**一次等一张**（醒来用 `work.list` 看其余的），还是加 `work.wait`（等全部办完再醒） | **一次等一张**。典型用法是派完就走；真有「全部办完再汇总」的业务再加 |
| 4 | `work.report` 的结果字段要不要像参数一样**先在任务上声明** | **不声明**，agent 自由写，最多 20 个。以后要按结果统计时再加声明 |
| 5 | `work.report` 能不能报「**这件办不成**」：运行照常结束，单记没办成，原因是 agent 写的，不重试 | **能**。「找不到」「对方拒绝」这种认真办了的结论，现在只能记成「办完」，派活页上分不出来 |
| 6 | 自动重试的默认值：**默认不重试**，最多 5 次，默认间隔 10 分钟 | 照这个。会对外发消息的任务，「?」里提醒慎用 |
| 7 | 哪些失败**自动重试**：只有运行出错（模型、程序出错、验收判失败、运行记录丢了）重试；人取消、人选不继续、人判验收失败、规则让它失败、agent 说办不成都不重试 | 照 4.2 节的表 |
| 8 | 还会重试的那次失败**发不发通知** | **不发**，最后一次没办成才发，写清重试了几次。派活页和处理记录里每次都看得到 |
| 9 | 看板：只收「**挂起等待**」那一列、**2 个及以上**才收，列头数字按运行数算 | 照这个。执行中受名额限制，数量少；「要人办的事」要一件件处理，不收 |
| 10 | 检查点小修：没有检查点时**连工具也不给**（不只是改提示） | **连工具也不给**。光改提示，agent 看到工具清单里有它，还是会调 |
| 11 | 派活页「派一张」能不能用 URL 直接打开（`#/work?task=…&new=1`），导入后的「派一张试试」要用 | 能 |

---

## 9. 开发（2026-10-18 开工）

### 9.1 已定

- 第 8 节 11 个问题全部按建议。
- 设计稿用户 2026-10-18 确认：说明在本地 `design/BRIEF-dispatch-p2.md`，原型在 `design/prototype/`，截图在 `design/shots/dispatch-p2/`。这三处都在主目录 `/mnt/toshiba/Projects/HeyAgent/design/` 下，不进 git，只读。设计稿「我先定了的」5 条也按原型做，但有两条只是原型的做法，正式版不照做：
  - 看板抽屉里点一行，正式版跳到 Session 页那次运行；
  - 看板和派活页的数字正式版是同一份数据。
- 派活方案的第一期说明照样适用：`docs/dev/dispatch-p1.md` 第 0 节（先读的）、第 5 节（开发环境）。子 agent 的规矩：**不 commit、不 push、不切分支**。代码里不写任何业务词。

### 9.2 骨架（监工已经写好，两个包都照它）

- shared：
  - `dispatch.ts`：
    - `taskDispatchSchema` 加可选的 `retries`、`retryDelayMinutes`，不写分别当 0 和 `WORK_RETRY_DELAY_DEFAULT`；
    - `workItemSchema` 加 `failKind`、`notBefore`、`autoRetries`；
    - `workResultSchema.data`，以及 `workReportValueSchema`、`WORK_REPORT_MAX_FIELDS`、`workReportLine`；
    - `workFailKindSchema`；log 加 `retry_scheduled`（带 `retry`、`notBefore`）和 `reported`；
    - `WORK_LIST_TOOL_ID`、`WORK_REPORT_TOOL_ID`、`workDoneEvent`、`WORK_DONE_EVENT_PREFIX`。
  - `engine.ts`：内置工具输入 `work.list`、`work.report`。
  - `imports.ts`：`planTaskSchema.dispatch`。
  - `domain.ts`：`BoardCard` 加 `group`，`boardCards` 还没改。
- server：
  - 迁移 `drizzle/0018_dispatch_p2.sql`：`work_items` 加 `fail_kind`、`not_before`、`auto_retries` 和一个索引；`db/schema.ts` 同步改了。
  - `work/service.ts` 的 `toWorkItem` 读出这三个字段。
  - `tools/builtin.ts` 里 `work.list`、`work.report` 是桩。
- web：`pages/todos/board.tsx` 遇到 `group` 卡片先返回 null。

### 9.3 包 A（后端）

照第 1～6 节做。只是前端的那些不用做：1.7、3.4、4.4、5.2 的页面部分。要点：

- 第 1 节：`prompt.ts`、`organize.ts`、`commit.ts`（拆出 `setDispatchSources`）、`follow-ups.ts`。
- 第 2 节：叫醒（新队列 `work.notify`）、`session.wait` 遇到 `work.done:`、`work.list`。
- 第 3 节：`work.report`、`failKind`。
- 第 4 节：重试（`settleWorkItemInTx` 的 `retryable`、`not_before`、延迟的 `work.pump`、清扫只看到点的排队单、还会重试的不发失败通知）。
- 第 6 节：没有检查点时不给 `checkpoint.mark`、系统提示不提检查点。
- `domain.ts` 的 `boardCards` 合并规则（第 5.1 节）也由包 A 做，纯函数，`packages/shared/test/domain.test.ts` 加用例。
- 排队名次：等重试的单（`not_before` 在将来）不算名次。
- 「重办」把 `auto_retries` 清零，`not_before`、`fail_kind` 置空。
- 演示数据 `seed/work-fixture.ts` 补上几种新情况：带 `data` 的办完、agent 报办不成、等重试、重试用完。另加一个能被派活、配了 `retries: 2` 的任务。
- `docs/dev/api.md` 第 16 节补充；本文件最后加「实现记录（包 A）」。
- 测试（真库、假模型），每一条都要覆盖：
  - 导入：toPlan、organize 六条、commit 两遍连关联（派活方排在后面、没勾上）、撤销；
  - 叫醒：办完、没办成、不办了、清扫，四处都叫醒；中间重试的不叫醒；先结束后等的直接返回；挂起窗口的补发；
  - `work.list`：只看自己任务的、`thisRun`、`open`；
  - `work.report`：合并、`not_done` 记没办成且不重试、不是被派的运行拿不到这个工具；
  - 重试：会重试的那几种和不重试的那几种各一个用例；到点才领；重办清零；只在最后一次通知；
  - 检查点：没步骤时工具清单和系统提示里都没有检查点；
  - `boardCards`。
- 跑通：server 全部测试、shared 测试、`pnpm -r typecheck`、`pnpm lint`、`pnpm build`。

### 9.4 包 B（前端）

**照原型做，样子和原型一样。** 原型里改过的文件有：

- `src/pages/tasks/dispatch-fields.tsx`（新）、`multi-pick.tsx`（新）、`new-task-dialog.tsx`、`task-detail.tsx`；
- `src/pages/imports/wizard.tsx`、`edit-dialogs.tsx`、`result.tsx`；
- `src/pages/work/index.tsx`、`parts.tsx`、`dialogs.tsx`；
- `src/pages/todos/board.tsx`、`sheets.tsx`、`index.tsx`。

要做的：

- 把任务弹窗（`pages/tasks/task-dialog.tsx`）的「被派活」一组抽成共用组件，加上重试两项。导入的修改弹窗（`pages/imports/edit-dialogs.tsx`）也用这个组件，「谁能派活给它」的选项是方案里的其他任务。
- 向导任务卡片加两行。导入结果的「派一张试试」走 `#/work?task=<id>&new=1`，派活页认 `new=1`。
- 派活页：
  - 结果字段表、「已报：…」；
  - 两种没办成：按 `failKind` 写标题；
  - 等重试的徽章「排队 · HH:mm 重试」、顶部提示和处理记录（log 的 `retry_scheduled`）；
  - 重试用完的提示。
- 任务抽屉的「派活」区块加重试那一句。
- 看板：`group` 卡片和 `GroupSheet`，点一行跳到 Session 页那次运行，列头数字按运行数算。`boardCards` 的合并逻辑包 A 在写；包 B 先在页面里按原型写好卡片和抽屉，合并逻辑等监工合并后联调，也可以先在本地临时造一个 group 卡片调样子。
- `docs/guide.md` 的「派活」一节补充：等结果、报结果、重试、导入。
- 验证：lint、build；浅色、暗色、窄屏截图都看过。截图方法见 `dispatch-p1.md` 第 4 节最后。

### 9.5 环境

| | 包 A（后端） | 包 B（前端） |
|---|---|---|
| worktree | `/mnt/toshiba/Projects/HeyAgent/.claude/worktrees/dispatch-p2-be` | `/mnt/toshiba/Projects/HeyAgent/.claude/worktrees/dispatch-p2-web` |
| 分支 | `feat/dispatch-p2-be` | `feat/dispatch-p2-web` |
| 数据库 | `heyagent_d2be`、`heyagent_d2be_test` | `heyagent_d2web`、`heyagent_d2web_test` |
| 端口 | 不用 | API 3123，Vite 5193 |

- 两个分支都从骨架那次提交开出来。`.env` 和 `.dev/kek` 由监工放好（已 gitignore），里面的库都可以随便清。
- 包 B 起服务：
  ```bash
  PORT=3123 TRUSTED_ORIGINS=http://localhost:5193 BETTER_AUTH_URL=http://localhost:5193 pnpm --filter @heyagent/server dev
  ```
  ```bash
  WEB_PORT=5193 API_PORT=3123 pnpm --filter @heyagent/web dev
  ```
  做完关掉，包括 `tsx watch`。
- 不要动 8080 上的 pod；不要停 5173 上的原型；不调真模型。

## 实现记录（包 A，2026-10-18）

代码：新文件 `engine/dispatch/notify.ts`（`work.notify` 队列、叫醒、挂起后补查）、`engine/dispatch/agent-tools.ts`（`work.list`、`work.report`）；改了 `engine/dispatch/settle.ts`（重试、`failKind`、办不成、叫醒）、`pump.ts`（`not_before`）、`sweep.ts`、`manage.ts`、`dispatch.ts`（`describeItem`）、`engine/loop.ts` `control.ts` `humans.ts`（`retryable`、通知）、`queue.ts` `worker-runtime.ts`（`work.notify`）、`sessions.ts`（自动带上两个工具）、`gateway.ts` `prompt.ts`（检查点、两句提示）、`tools/builtin-defs.ts` `tools/builtin.ts`（两个工具、`session.wait` 遇到 `work.done:`）、`work/service.ts`（等重试的不算名次）、`imports/prompt.ts` `organize.ts` `commit.ts` `follow-ups.ts` `catalog.ts`、`data/config/tasks.ts`（`setDispatchSources`）、`seed/work-fixture.ts`；shared 的 `domain.ts`（`boardCards` 合并）、`imports.ts`（`planProblems`、`planTaskSchema.dispatch` 的重试两项）、`schemas.ts`（`TaskDef.dispatch` 的重试两项）。接口说明 `docs/dev/api.md` 16.8 节。测试 `apps/server/test/dispatch-p2.test.ts`（17 个用例），`packages/shared/test/domain.test.ts` 加 3 个。

**取舍、和说明不一样的地方**：

1. **`work.list`、`work.report` 不进 `tools` 表**：说明写「加进 `BUILTIN_TOOLS`」。加了，但标 `implied`，`syncBuiltinTools` 和导入的内置工具清单（`builtinToolList`）用 `SELECTABLE_BUILTIN_TOOLS` 跳过它们。理由：进了表就会出现在任务的「用哪些」、工具页、导入 AI 的清单里，人或 AI 会去单独选，和「不单独选」矛盾；`work.report` 被选进普通任务也没意义。它们只在快照里由 `sessions.ts` 自动加。`bootstrap.test.ts` 跟着改成按 `SELECTABLE_BUILTIN_TOOLS` 数。
2. **延迟的 `work.pump` 用自己的 singletonKey**（`<任务 id>@<到点时间>`）：说明担心延迟的和别的合并掉。实测 pg-boss 的 stately 是「同一个 key 在 created 状态最多一个」，延迟的任务排在那里时也算 created，用同一个 key 会**反过来**把之后的即时 `work.pump` 都合并掉（新派的单要等到重试到点才开）。换成自己的 key 以后两边互不影响；领单本身有 advisory lock，同时跑两个也不会超名额。清扫照说明只看到点的排队单，兜底。
3. **办不成先记在单上**：agent 在运行中途报 `not_done` 时，单上先写 `failKind = 'not_done'`、`error = 'agent 判断办不成：原因'`（单还是在办，接口里 `failKind` 只在没办成时才显示，所以页面看到的是 null；`error` 会是这句话）。运行结束时（不管是说做完了、出错还是被人取消）只要这次运行报过办不成，单就记 `failed / not_done`、不重试、保留 `result`（总结 + 产物 + `data`）。`outcome: "done"` 可以撤回。人在派活页点「不办了」照旧记不办了。
4. **`work.report` 的 `result`**：这次运行第一次报时整个换成 `{ summary: "", fileIds: [], data }`（不再挂着重办以前那次运行的总结），之后合并；单结束时 `data` 只保留这次运行报的（按 `log` 里有没有这次运行的 `reported` 判断）。运行出错的没办成照第一期置空 `result`（包括 `data`），等重试的也置空。
5. **办不成的通知**：被派的运行完成时本来不发通知；agent 报办不成的，运行是「已完成」，另发一条「<任务>：没办成」（正文是原因）。2026-10-19 起这种运行记「没完成」（`incomplete`），通知标题改成「<任务>：没完成」。还会重试的失败不发；最后一次没办成的正文「自动重试了 N 次都没办成：原因」。人取消、人选不继续、人判验收失败这几处第一期就不发通知，没改。
6. **叫醒的范围**：说明列了 4 处，另外「领单时开不出运行」（第一期记没办成的那种）也是最终结束，一样发 `work.notify`；那种单 `failKind = 'error'`，不重试（多半是配置坏了）。`work.cancel` 取消等重试的单也叫醒。
7. **`session.wait` 等 `work.done:`**：说明只说「单不存在，或者不是这个任务派的：报错」，按 `from_task_id` 判断，所以**人派的单**（`from_task_id` 为空）agent 等不了；`work.list` 同样只看 `from_task_id`。已经结束时不挂起，返回「不用等了，派活单已经结束：…」+ 事件数据，内容和叫醒消息一样。
8. **规则让它失败**记 `failKind = 'error'`（不是 `cancelled_run`）：skeleton 的注释里 `cancelled_run` 只写了人做的三种，规则不是人点的；只是不重试。
9. **`failSession` 的参数**：加了 `options: { retryable, failKind? }`，默认 `retryable: true`（模型解析失败、模型调用失败、引擎出错、验收判失败都走默认），只有规则那处传 `false`。
10. **检查点小修**连第一条消息也改了：没有检查点时「请按系统提示里的目标和步骤开始工作」（原来写「目标、步骤和检查点」）。快照的 `tools` 不改；已经在跑、快照里没有检查点的老运行继续时也会失去 `checkpoint_mark`（系统提示变一次，前缀缓存失效一次）。
11. **导入的自动重试**：按包 B 的联调要求，`planTaskSchema.dispatch` 加了可选的 `retries`、`retryDelayMinutes`（读包 AI 的格式里**没有**这两项，默认不重试；人在向导里改），organize 卡范围（0～5、1～1440），commit 建任务时带上。
12. **导入后的「派一张试试」**：没有新的 follow-up 种类，用 `try_run`：不带 `action`、`link = #/work?task=<id>&new=1`，名下有过一张单就算办完；派活方没勾上（一个派活方都没连上）时在这一项的说明里提醒，没有另加一项。标题「派一张试试「<任务标题>」」。
13. **`describeItem`**（`work.dispatch` / `work.list` 的一行）：等重试的写「排队（第 n 次重试，MM-DD HH:mm 以后），上次：原因」；agent 判断办不成的写「没办成（agent 判断办不成：…）」，不写「等人处理」；办完 / 没办成的带「 · 结果：件数=3」。
14. **演示数据**：加了一个「核对一张…的回填」任务（`retries: 2`、间隔 10 分钟、名额 2），一张等第 1 次重试（8 分钟后）、一张重试 2 次都没办成；原来的任务上加了一张带 `data` 的办完、一张 agent 报办不成、一张在办已报的。`pnpm --filter @heyagent/server dev:work-fixture` 在私有开发库上跑过。

**改了 shared 的地方（都只加可选字段 / 纯函数）**：

- `schemas.ts`：`TaskDef.dispatch` 加 `retries?`、`retryDelayMinutes?`（不加的话 `tasks.list` 的输出校验会剥掉，前端保存一次就清掉重试）。
- `imports.ts`：`planTaskSchema.dispatch` 加 `retries?`、`retryDelayMinutes?`；`planProblems` 查 `dispatch.fromKeys` 引用的任务存在、不是自己。
- `domain.ts`：`boardCards` 按 5.1 合并（新函数 `groupDispatchedWaiting`，不导出）。

**要包 B 知道的**：

- `WorkItem.failKind` 只在 `failed` 时有值；在办时 agent 已经报了办不成的，`failKind` 是 null、`error` 是「agent 判断办不成：…」。
- 在办的单报过结果：`result = { summary: "", fileIds: [], data }`，「已报：…」用 `result.data`（`workReportLine` 压成一行）。办不成的单 `result` 保留（`summary` 是 agent 最后那段总结，可能有 `data`）；运行出错的没办成 `result` 为 null。
- 等重试：`status = queued`、`notBefore` 有值、`queuePosition = null`、`autoRetries` = 这是第几次重试、`error` = 上一次出错的原因；`log` 的 `retry_scheduled` 带 `retry`、`notBefore`、`note`（原因），前面紧跟一条 `run_ended`（`note: "failed"`）。重试用完：`failed / error`，`autoRetries` = 重试过的次数，对照任务的 `dispatch.retries` 就能写「自动重试了 2 次都没办成」。办不成的单 `run_ended` 的 `note` 是 `"not_done"`。
- `tasks.update` 是整体替换：`dispatch` 里的 `retries`、`retryDelayMinutes` 要带上，不带就是不重试。
- 看板 `group` 卡片的 `runs` 按开始时间先后；最早到点的时间要页面自己从 `runs[].waiting.trigger` 算。
- 导入结果里能被派活的任务的「派一张试试」是 `kind: "try_run"`、没有 `action`、有 `link`。

**验证**：`pnpm --filter @heyagent/server test` 20 个文件 304 个用例全过（新增 17 个），`pnpm --filter @heyagent/shared test` 55 个全过（新增 3 个），`pnpm -r typecheck`、`pnpm lint`、`pnpm build` 通过。全部用假模型，没有跑真模型。业务词检查没有新增命中（新代码里没有；演示数据在 `seed/` 里）。

## 监工联调记录（2026-10-18）

- **合并**：两个包合并以后，又合了 main 的 bced78c（「比图」改名「比物」，新写的演示数据跟着改）。合并后跑了一遍检查：
  - server 测试 20 个文件 304 个用例，shared 测试 55 个，全部通过；
  - `pnpm -r typecheck`、`pnpm lint`、`pnpm build` 通过；
  - 仓库里搜「比图」，0 处。
- **真模型联调**用的是私有库，执行模型 Claude Haiku 5.5：
  - **一共 3 个任务**：
    - A 是派活方，让它把 3、7、−2 派给 B，把 5 派给 C，然后等 3 那一张；
    - B「算平方」，负数报办不成；
    - C 配了重试 2 次、间隔 1 分钟，模型故意配成一个不存在的 id。
  - **结果**：
    - **派活方等结果**：A 用 `session.wait` 等 `work.done:W-1`，W-1 办完后被叫醒，用 `work.list` 看了其余几张，然后总结。
    - **报结果**：W-1、W-2 办完，单上有报的结果（`平方=9`、`平方=49`）。
    - **办不成**：W-3 是「没办成 · agent 判断办不成：不处理负数」，运行本身是完成的，没有重试。
    - **自动重试**：W-4 一共跑了 3 次，间隔 1 分钟，最后记成「没办成 · 运行出错，自动重试了 2 次」。负责人只收到 1 条失败通知。
    - **检查点**：B 的 3 次运行都没有调 `checkpoint.mark`，过程和总结里也没有出现「检查点」。
  - **派活页**：用真数据截了 W-3、W-4 的图，显示正常。顺手改了一处：「agent 判断办不成」的原因前面带着同样的前缀，和标题重复，详情里去掉了。
- **重新导入真实的搜品包** `sourcing-agent-portable.zip`：读包用 Claude Opus 5.5，花了 $1.28。
  - t2「处理一张搜品单」被导成接受派活：参数是「搜品单号」（必填、去重）和「标题」（可选），名额 1，来自 t1。
  - t1 选上了内置工具「派活」，步骤里写的是派给 t2 的**标题**，不是 key。
  - sourcing-todo 的插件和 `sync_tasks` 契约进了 unused，原因是「用平台自带的『派活』代替」。
  - 包里写了默认关闭自动执行，所以两个任务都导成了停用；t2 原来就没有定时，这次没有触发「去掉定时」那条规则。
  - 点「导入」后：
    - `task_dispatch_sources` 写对了（t2 ← t1）；
    - t2 的「还要做的事」是「派一张试试」，链接 `#/work?task=…&new=1`；
    - 撤销后，两个任务和它们的派活关系都删干净了。
- **没联调到的**：
  - 看板收起被派的卡片：有单元测试和前端截图（用的是假数据），没有用真模型凑出 2 个以上在等的运行；
  - 「接受派活又有定时就去掉定时」：有单元测试，真包里没碰到这种情况。
- 8080 的 pod 没有重建。迁移 0018 要等重建时才会执行。
