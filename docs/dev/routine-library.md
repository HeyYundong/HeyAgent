# 流程库：固化流程给多个任务共用、当工具调（设计，2026-10-28）

> **状态：已实现，等合并（2026-10-28，集成分支 `worktree-agent-a63a9b71c05b52516`，基于 `worktree-solidify-design` 9ed41ae）。** 约定（第 16 节）和 A / B / C 三包都已合在一起；三包和设计不一样的地方、集成时改的见第 17 节「实现记录」。真模型验收（12.3）见第 18 节（2026-10-28，在 e7cbab5 上做）。
> 监工 2026-10-28 审过，第 15 节四条都按推荐做（用户 2026-10-28：设计过的都做完，交给监工定）。
> 来由：`solidify.md` 6.1 写过「给 agent 当工具」，第 13 节挪到第三期：「多个任务共用的流程库：像技能一样在配置页管理、建任务时选」。
> 文中写「现在」的，都读分支 `worktree-solidify-design`（0d7652d）的代码确认过；写约定时按 1af8ae5（直接调网站接口、派活第三期、记忆自动挑选已合入）又对了一遍，对不上的已改（第 16.2 节）。

## 0. 一页纸

**推荐做法**：流程还是在一个任务上固化、试跑、审核、修（这个任务叫「来源任务」，现有流程一点不动）。某一版在来源任务上转了正式以后，主管把它**发布进流程库**。库里的流程变成一个工具 `routine.<短名>`，和 HTTP 工具、技能一样在建任务时选。

- **agent 调**：一次工具调用跑完整段脚本，用调用方这次运行的浏览器、登录态、规则、白名单，几秒拿回结果；跑不通把做过哪几步、停在哪交回给调用方的 agent 接着做。
- **脚本调**：调用方的固化脚本、agent 写的循环脚本里 `await ha.routine("短名", 输入)`。库流程的代码在同一个沙箱、同一个工具桥里跑，审批、挂起、接着跑、试跑都沿用现在的规矩。
- **版本**：库里记「发布的是来源流程的第几版」。用它的任务跟着发布的版本走（同技能：下一次运行用新版）。发布新版前列出不兼容的改动和受影响的任务。
- **嵌套**：库流程里还能调一层库流程，再往下不行，不许绕圈。

| # | 部分 | 一句话 |
|---|---|---|
| 1 | 发布 | 来源任务上转过正式的一版 → 主管发布进库：短名、给模型看的「什么时候用」、程序算出要的工具和风险 |
| 2 | 选 | 任务弹窗多一项「流程」，选了自动带上它要的工具。库流程在 `tools` 表里有一行（`source = routine`），规则也能管它 |
| 3 | 当工具跑 | 网关里一个工具 → 起沙箱跑库流程 → 每一步走调用方的网关 → 结果（或交接的话）交回 agent |
| 4 | 脚本里跑 | `ha.routine()`：进入是一次工具调用（过规则），里面的每一步照常走工具桥，记进同一份重放日志 |
| 5 | 成绩和停用 | 每次调用记一行。连续 3 次跑不通自动停用，通知负责人；修还是在来源任务上修 |

不做：每个任务钉住版本、别的任务「整件事先跑库流程」、在调用方的运行上修库流程（第 14 节）。

## 1. 现在有什么、缺什么

| 已有的 | 在哪 | 对流程库有什么用 |
|---|---|---|
| 一个任务一个固化流程（`routines.task_id` 唯一）、版本（`routine_versions`）、试跑、审核、试用转正式、连续跑不通停用、自动修 | `routine/*`、迁移 0031 / 0032 | 流程怎么写、怎么修都不用改，库只管「共用」 |
| 工具桥：脚本的每次调用经 `gateway.call()` 过规则、白名单、审批、检测、过程记录 | `routine/runtime/bridge.ts` | 库流程里的每一步一样走调用方的网关 |
| `call()` 可以重入：`code.run`（tools）执行期间脚本的调用直接进来 | `engine/gateway.ts`、`sandbox/code-run.ts` | 「agent 调库流程」照这个做：一次工具调用里起沙箱，脚本再回到同一个网关 |
| 重放日志：停下等人以后从头跑、按日志跳过做过的 | `routine_journal`、`bridge.ts` | 脚本里调库流程，里面的步骤记进同一份日志，接着跑不用另做 |
| 程序检查用 acorn 读出脚本用了哪些工具 | `routine/checks.ts` | 发布时照样算出库流程要的工具、调了哪些别的库流程 |
| 技能：`task_skills` 选用、按名字发布、被选用时不能停用、下一次运行用新版 | `data/config/skills.ts` | 选用、版本跟随、撤下的规矩照搬 |
| 工具：`tools` 表 + `task_tools`，快照冻进 `snapshot.tools`，规则按工具 id 管 | `engine/sessions.ts`、`engine/hooks.ts` | 库流程在 `tools` 里有一行，选、规则、助手改任务都现成 |

缺的：

- 一个流程只能给自己的任务跑（`routineForSnapshot` 只看 `routines.task_id`）。
- 没有「把一段固化好的操作当一个工具给 agent」的入口。
- 脚本里只能调工具，不能调另一个流程。

## 2. 库里的流程是什么

### 2.1 发布进库，不是独立存在

- **推荐**：库里的流程 = 某个任务上的固化流程，多了一张「库里的登记」。不另建一套「独立的流程」。
- 理由：
  - 写脚本、试跑、修都要一个任务的配置（浏览器配置、白名单、工具、原来那次运行的输入）。独立的流程没有这些，试跑、修都没处做。
  - 来源任务的运行是这个流程最好的体检：网站改了，来源任务先跑不通、先自动修。
  - 现有的固化、审核、修一行代码都不用改。
- 编号还是 `RT-<n>`：一个流程一个编号，在任务上、在库里是同一个东西。
- 来源任务停用了，库里的照常能用（只是脚本）。有运行记录的任务本来就不能删（`deleteTask`），不用管来源任务被删。

### 2.2 版本

- 来源流程照旧有自己的启用版本（`routines.active_version`，试用 → 正式）。
- 库里另记**发布的版本**（`routine_library.published_version`），两个可以不一样：来源任务在试用新的第 4 版，库里还是第 3 版。
- **只收转过正式的版本**：这一版在来源任务上连着 3 次脚本直接办成过。`routine_versions` 加 `proven_at`（转正式的时间），`routine/runtime/stats.ts` 的 `settleRoutineRun` 转正式时写。这个功能上线前转正式的，迁移里补：审计 `routine.promote` 记过的那一版，加上 `routines.status = active` 且 `active_version` 是它的（后者补上前者漏的；转过正式后又被停用、回到试用的版本，靠审计那条补）。
- **发布新版本**：来源流程有更新的、转过正式的版本时，库的详情和来源任务的「固化流程」区块都提示「第 4 版已转正式，可以发布到流程库」，同时通知发布过的主管。不自动发布。
- **回到以前的版本**：发布过的版本都能再发布（同「回到这一版」）。

### 2.3 用它的任务跟着变

- **推荐**：跟着发布的版本走，同技能。开始运行时把发布的那一版冻进快照，运行中途发布新版不影响这次。
- 发布新版前，系统对比新旧两版，列出：
  - **输入不兼容**：新加了必填的参数、去掉了参数、参数类型变了；
  - **交回少了**：旧版交回的字段新版没有；
  - **要的工具多了**：哪些在用的任务没选这些工具（发布后这些任务用不了它，见 6.2）；
  - **受影响的**：选了它的任务；脚本里 `ha.routine` 调了它的固化流程（任务、第几版）。
- 有不兼容时，发布弹窗要勾「我知道这些任务会受影响」才能发。脚本里调它的流程会跑不通、交给 agent，开着自动固化的会自动修（第 7 节）。
- 不做每个任务钉版本：多一个要人管的东西，而且钉住的旧版网站改了也跑不通。

### 2.4 状态

| 状态 | 中文 | 什么时候 | 新的运行能用吗 |
|---|---|---|---|
| `listed` | 在库里 | 发布了 | 能 |
| `paused` | 停用 | 主管停的，或连续 3 次跑不通自动停（6.6） | 不能（快照里不给，6.2） |
| `withdrawn` | 撤下 | 主管撤下（只有没有任务选用它时能撤，同技能停用） | 不能，也选不到 |

## 3. 入参和出参

- 直接用这一版的 `inputSchema` / `outputSchema`，不另声明。
- 来源任务是被派的：固化员写的 schema 常常只有 `type`，参数、结果的说明（`description`）由程序按任务声明的参数、结果补上，没写说明的才补（shared 的 `withDeclaredDescriptions`，不靠模型）。固化时存进这一版（`compile.ts`）；以前的版本在发布、改名字、详情、冻快照时按来源任务现在的声明补（`analyze.ts` 的 `withSourceDeclared`），存的那一版不改。（18.3 第 3 条）
- **给模型的参数**（工具的 JSON Schema）按 `inputSchema` 转：
  - 普通参数原样（名字、类型、说明、必填）。
  - `$attachments` 换成 `attachments`：文件 id 的数组（调用方这次运行能读的文件）。工具执行前按调用方的空间展开成 `{ id, name, mime }`，脚本里照旧读 `ha.input.$attachments`。
  - `$note` 换成 `note`：一句话。
  - 必填照 `inputSchema`（`$attachments`、`$note` 也是）。
  - **参数名照 HTTP 工具的规矩**（`engine/tools/http.ts` 的 `httpParamKeys`）：英文、数字、下划线的原样；别的（中文、带 `$` 的）换成 `p<n>`（`n` 是它在 `inputSchema` 里的序号），说明前面写「参数名：单号」。换的名字和已有的撞了往后加 `_2`。
  - 理由：几家模型的工具参数名只认英文、数字、下划线（Anthropic 的 `input_schema` 属性名有格式限制），HTTP 工具早就这样做了，不用再拿真模型验中文参数名。
  - 纯函数：shared 的 `toolSchemaOf(inputSchema) → { jsonSchema, params }`；模型给的参数转回脚本的输入 `inputOfToolArgs(args, params, files)`（`files` 是调用方能读的文件，`attachments` 按它展开，不是调用方能读的报错）。
- **没有声明输入的流程能进库**：工具参数是空对象，就是「把这段固定操作做一遍」（例如打开后台切到某个视图、导出今天的报表）。
- **交回**：
  - 库流程里的 `ha.work.report({ data })` 不再写调用方的结果，收进这次调用的交回值；
  - `ha.finish({ outcome, summary, evidence, reason })` 不再结束调用方的运行，也收进交回值；
  - `ha.checkpoint.mark` 是来源任务的检查点，调用方那里不认：不做，过程里记一句「库流程里的检查点不算」。
- 交回值（agent 在工具结果的文字和 `data` 里看到，脚本拿到返回值）：

```ts
// shared 的 routineReturnSchema
{
  routine: string,      // 短名
  name: string,         // 库里的名字
  version: number,
  outcome: "achieved" | "not_achieved",
  summary: string, evidence?: string, reason?: string,
  data: Record<string, string | number | boolean>   // work.report 收来的
}
```

- 跑不通时没有交回值：agent 拿到交接的话（5.5）；脚本里抛错（5.6）。

## 4. 当工具：id、名字、说明、风险

### 4.1 `tools` 表里一行

- 发布时写一行：`id = routine.<短名>`、`source = routine`（`tool_source` 枚举加一项）、`routine_id`（新列）、`name` = 库里的名字、`summary`、`description`、`risk`。
- 好处：任务选用就是 `task_tools`；规则的触发「调用 X 之前 / 之后」、规则翻译、助手改任务、快照都认它，不用另做一套。
- 这一行只由流程库写：工具页不列它（`data/loaders.ts` 的 `listTools` 过滤掉 `source = routine`），工具的编辑、删除接口（`data/config/tools.ts` 的 `updateHttpTool`、`deleteTool`，助手的 `assistant/tools.ts` 改工具）遇到它报「这是流程库里的流程，在流程页里改」。
- 一个库流程一行：`tools.routine_id` 唯一；`source = routine` 时 `routine_id` 非空（check 约束）。
- **短名**：发布时填，英文小写、数字、下划线，例如 `order_status`；默认按名字 `slugOf`，转不出来用 `rt<n>`。**发布后不能改**：它就是工具 id，任务、规则、脚本都按它引用。
- 给模型的名字：网关现有的 `safeName`，`routine.order_status` → `routine_order_status`。

### 4.2 给模型的说明（发布时生成，存 `tools.description`）

```text
固化好的流程（几秒做完，不用你一步步操作）。
什么时候用：<库里填的「什么时候用」>
做什么：<步骤说明，一步一行，最多 15 行；去掉交回、报结果的那几行>
要的输入：<参数：说明（必填）>
交回：<字段：说明>
会真的提交：<commits，没有就写「只读，不改东西」>
用的是你这次运行的浏览器：先不用登录、不用打开页面，流程自己会去。跑完停在最后一页。
跑不通会告诉你做过哪几步、停在哪一页，你从那里接着做，前面做过的不要重复。
```

- 「什么时候用」由发布的主管写，默认是流程的名字（`routine_versions.name`），没有就用来源任务的标题（shared 的 `defaultLibrarySummary`；发布弹窗里提示改成「要……时用」）。不用步骤说明的第一行：那是怎么做（「打开某某页」），不是什么时候用。同技能：agent 平时靠这一句决定用不用。（18.3 第 2 条）
- 「做什么」给的是别的任务的 agent，只对来源任务有意义的话去掉（`analyze.ts` 的 `libraryDescriptionSteps`）：交回值、报结果的行（`work_report`、`finish`、「交回」「报办成」）去掉，一行里只有后半句是的去掉那半句，重新编号；「派活的『X』」写成「输入的『X』」。固化员的规矩第 13 条也要求步骤说明不写交回、报结果。（18.3 第 3 条）
- 系统提示加一节，只在这次有库流程时出现（`engine/prompt.ts`）：

```text
## 固化好的流程
下面这些是别的任务办成过、固化成脚本的流程。事情里有一段正好是它做的，先调它，比你一步步做快得多：
- routine_order_status「查订单状态」：……
流程办成时交回的结果是它照固定步骤从页面上读到、核对过的（工具结果里有做过的步骤和依据），直接用，不要再一条条打开页面去核对；没办成或停下的，再自己处理。
流程停下交回给你时，从它停下的那一页接着做；同样的输入不要马上再调一次，除非你确认是偶然的（页面没加载完）。
```

- 这次用不了的（停用、缺工具）在这一节末尾写一行「这次用不了：『查订单状态』（任务没选『浏览器』）」，agent 知道为什么没有它。

### 4.3 风险等级

按脚本会不会改东西算，发布时算好存 `tools.risk`：

- 没有 `ha.commit`、用到的非浏览器工具都是只读（`read`）→ `read`；
- 否则取用到的工具里最高的：浏览器算 `external`，HTTP / MCP 按工具自己的，调了别的库流程按那个流程的风险。

规则照常按这个风险和工具 id 管。例如「调用流程『改价格』之前要人审批」是一条普通规则（5.3）。

### 4.4 要的工具（`requires`）

发布时用 `checks.ts` 的那套分析算，存进库的登记，任务弹窗和快照都用：

- `toolIds`：`ha.browser.*`、`ha.tool("browser.…")` → 「浏览器」组 `browser`（同 `checks.ts` 的 `GROUP_TOOLS`，桌面、图库、比物也按组），`ha.tool("…")` → 那个工具，`ha.file.*` 不算（读附件、存文件跟着自动带上的规矩走）；
- 浏览器的开关 `browser { fetch?, vision? }`：用了 `ha.browser.fetch` 要「允许直接调网站接口」（任务的 `allowBrowserFetch`，快照里是 `browser.allowFetch`）；用了按坐标的工具（`copyImage` 写坐标、`ha.tool` 调坐标工具）要「允许看画面」（任务的 `allowBrowserVision`，快照 `browser.allowVision`）；
- `routines`：脚本里 `ha.routine` 直接调的库流程（**短名**；第一个参数不是字面量算程序检查没过）；它们要的工具、开关一并算进 `toolIds` 和 `browser`（传递），`toolIds` 里不放 `routine.*`（调的库流程不用调用方任务选，跟着冻进快照）。
- shared：`routineRequiresSchema`、`mergeRoutineRequires`（算传递）、`missingRoutineRequires`（任务缺什么：弹窗提示、快照的 `unavailable`）。

## 5. 在调用方的运行里怎么跑

### 5.1 用谁的浏览器：调用方的

- 库流程的每一步都走调用方这次运行的网关：同一个 Chrome、同一个登录态、调用方任务的 Chrome 配置、白名单、平台账号的租约。
- 不另开浏览器。理由：
  - 另开就要另一套配置、另一个登录态，等于另开一次运行，那是派活（第 7 节）；
  - 调用方 agent 接手时要在同一页接着做。
- 调用方任务的 Chrome 配置要能登录流程要去的网站，这是选用它的人的事。遇到登录页照常挂起交给人（5.4）。
- 脚本跑完停在最后一页，交回时附上页面概况（同 `browser.batch`），agent 知道现在在哪。

### 5.2 agent 调：一次工具调用

照 `code.run`（tools）的做法，网关里每个库流程一个工具，执行时：

1. 参数按 JSON Schema 校验（网关现有的）；`attachments` 展开成 `$attachments`；再按 `inputSchema` 校验一次，不合格当场报错、不起沙箱。
2. 起沙箱：代码目录放这个库流程（`routine.mjs`）、它调的库流程（`routines/<短名>.mjs`，shared 的 `libraryModulePath`；`routine/library/snapshot.ts` 的 `libraryModules` 收齐）、SDK。不挂出网代理，`/workspace` 只读（同固化脚本）。
3. 起工具桥，新的 `mode = tool`。每一步 `gateway.call()`，调用 id `<这次的调用 id>-l<步>`，过程记录的 trace 带 `library`（5.7，`callId` = 这次的调用 id、`depth` 1）。
   - 会改东西的 `browser.fetch`（`solidify.md` 19.5）照固化脚本的规矩：前面要有自己的 `ha.commit`，不然脚本停下（`script_error`）。库流程都是固化员写、人审过的脚本，`mode = tool` 和库流程嵌在 agent 的 `code.run` 里（请求带 `via`）时也照这条，只有 agent 自己写的那一层不要求。
   - 试用期截图不做（库流程只收转过正式的，见 5.4）。
4. 结局：
   - 报了结果（`ha.finish`）→ 工具结果是交回值（第 3 节）。`not_achieved`（例如查不到）不算出错，文字写清原因。文字里也列出做过的步骤（和 5.5 停下时一样的步骤行，`wait_any` 写等到的那一种和它的定位），办成的再写一句「交回的值是流程照上面的固定步骤从页面上读到的，流程里核对过，直接用，不要再打开页面核对一遍」（18.3 第 1 条：不写的话 agent 会再一条条打开页面核对）。固化员的规矩第 7 条要求 `evidence` 写出核对了什么（例如「详情页标题和输入的名称一致」）。

```text
流程「查订单状态」第 3 版跑完了：5 步 · 6.8 秒。
结果：办成。A-1：已发货
依据：订单列表第 1 行单号是 A-1，状态一栏是「已发货」
交回：状态=已发货
做过的步骤：
1. navigate「https://erp.example.com/orders」 ✓
2. type「单号输入框」 ✓
3. click「查询」 ✓
4. wait_any「found / empty / error」 → found（getByRole('row', { name: /A-1/ })） ✓
5. extract「状态」 ✓
交回的值是流程照上面的固定步骤从页面上读到的，流程里核对过，直接用，不要再打开页面核对一遍。
现在的页面：……
{"routine":"order_status",……}
```
   - `ha.fail("input")` → 出错：「输入有问题：…（流程没改任何东西）」。
   - 别的停下 → 出错，文字是交接的话（5.5）。
   - 要挂起（验证码、登录页、等浏览器）→ 同 `code.run`（tools）：结果带上 `suspend`、`signals`、`facts`，引擎照常挂起，人处理好以后 agent 接着做。库流程不接着跑，交接的话里写清停在哪。
   - 里面某一步要人审批 → 停在它前面、不发起审批（同 `browser.batch`）。结果写「第 k 步 X 要人审批（规则…），没做：你单独调用这一步，再接着做后面的」。
5. 上限：工具调用次数、时间用固化脚本的（`routineLimits`），时间还要压在这次运行剩下的时间里。
6. 不记重放日志：worker 被杀时，引擎现有的「工具调用被中断」处理（`loop.ts`）照样补一条结果，agent 自己核对。
7. 写一行调用记录（`routine/library/stats.ts` 的 `recordRoutineCall`，`via = tool`）。

### 5.3 规则、审批

- **整个流程上的规则**：库流程是一个工具，「调用它之前要审批」「调用之后通知谁」照常生效。agent 调用时走普通的审批卡；脚本调用时见 5.6。
- **里面每一步的规则**：调用方任务的规则对里面每一步都生效，和 agent 自己调一样。来源任务的规则不跟过来：规则是任务的配置。
- **白名单**：按调用方任务的。流程要去的网站不在白名单里，那一步被拦下 → 停下交回。
- 发布的弹窗和库的详情里写清：「在别的任务里跑时，按那个任务的规则和白名单」。

### 5.4 试用期

- 库里不另设试用期：只收在来源任务上转过正式的版本（2.2）。
- 调用方自己的固化流程在试用期时，`ha.routine` 里面的 `ha.commit` 照样提交前截图（同一个工具桥，见 5.6）。
- agent 调库流程不截图：agent 自己做的提交本来也不截。

### 5.5 跑不通：交回调用方的 agent

格式照 `handoff.ts`（`solidify.md` 6.4）。现在的 `routineStepLines` 只认 `trace ? 'routineStep'`；抽出共用的「步骤行」函数（输入是一组过程记录），按 `trace->'library'->>'callId'` 取这次调用里的步骤、按 `trace.library.step` 排：

```text
流程「查订单状态」第 3 版做到第 5 步停下，没跑完：
1. navigate https://erp.example.com/orders ✓
2. type「单号输入框」✓
3. click「查询」✓
4. wait_any → found ✓
5. ✗ extract：在 getByRole('row').nth(1) 里找不到 getByRole('cell').nth(3)（页面可能改版了）
会改东西的步骤：一步都还没做。
现在的页面：「订单列表」 https://erp.example.com/orders?no=…
请从现在的页面接着把这件事做完，前面做过的不要重复。同样的输入不要再调这个流程。
```

- 做过提交、没核对的写：「第 7 步『保存』已经点了，可能已经生效：先看页面核对，不要重复保存。」
- `data` 里另给 `{ routine, name, version, steps, stoppedAt, commits }`（shared 的 `routineToolStopDataSchema`），界面和固化材料用。

### 5.6 脚本里调：`ha.routine`

```js
const r = await ha.routine("order_status", { 单号: input.单号 })
// r = { outcome, summary, evidence?, reason?, data }
if (r.outcome !== "achieved") return ha.finish({ outcome: "not_achieved", summary: r.summary, reason: r.reason ?? "查不到" })
```

能调的地方：调用方的固化脚本（先跑流程、试跑）、agent 写的 `code.run`（tools）脚本、库流程自己（嵌套，5.8）。

**在同一个沙箱、同一个工具桥里跑**，不另起沙箱：

1. **进入**：SDK 发 `tool` 请求，工具是 `routine.<短名>`、参数是输入（脚本的写法：`$attachments` 是 `{ id, name, mime }`，不转），在库流程里调的还带 `via`。它像普通的一步一样走 `gateway.call()`（带 `inline: true`，执行只是记一条「开始跑流程『查订单状态』第 3 版」）：
   - 过规则：整个流程上的审批、拦下照常；
   - 记进重放日志、算一步；
   - 先按 `inputSchema` 校验，不合格回 `step_error`；快照里没有、`unavailable` 的、层数超了、`via` 里已经有它（环）也回 `step_error`。
   - 回复的 `data` 是 shared 的 `libraryEnterReplySchema`：`{ slug, name, version, module: "routines/<短名>.mjs", depth, input }`。
2. **跑**：SDK 载入那个模块，在一个嵌套的上下文里（Node 的 `AsyncLocalStorage`）调它的 `run(input)`。在这个上下文里：
   - `ha.input` 是传进去的输入；
   - `ha.finish`、`ha.work.report` 只收进交回值，不发请求；`ha.checkpoint.mark` 不做；
   - `ha.fail(kind, reason)` 不让整个脚本停，变成抛给调用方的 `RoutineFailed`（带 `kind`），调用方可以接住；
   - 其余请求（工具、commit、verified、log、now、judge）照常发给同一个工具桥，每个请求带上嵌套的路径（`via: ["order_status"]`，从外到里的短名，shared 的 `bridgeViaSchema`），工具桥据此记 trace。
3. **出来**：SDK 发新请求 `routine_end`（shared 的 `routineEndRequestSchema`：`slug`、`depth`、`end` = finished / failed / error、`steps`、报了结果的 `result`、`ha.fail` 的 `kind`、出错的 `error` 和 `name`、`via`）。工具桥记一条过程「流程『查订单状态』跑完：7 步 · 交回 状态=已发货」、写一行调用记录（6.5，`via = script`，步数以工具桥自己数的为准）。它也记进重放日志（和 commit、log 一样是标记）。
4. 没调 `ha.finish` 就返回了 → 抛 `StepError`「库流程没报结果」。
5. `RoutineFailed` 带 `kind`（input / page）和 `routine`（短名），`index.d.ts` 已写好。

这样做，现在的规矩全都沿用：

- **审批**：里面某一步要审批，普通运行照常停下等人、批准后按日志接着跑（`solidify.md` 17.2）；agent 的脚本照常停在它前面。
- **挂起**：照常挂起、接着跑。
- **试跑**：里面的第一个 `ha.commit` 就是试跑的停点。注意：试跑现在会停在「风险不是只读的非浏览器工具」前面，进入库流程那一步要放行（只是进入，里面每一步再各自判断）。
- **试用期截图、`ha.verified`、交接的话**：都是同一个工具桥里的事，库流程里的提交也算进调用方的 `commits`，标签前面加「流程『查订单状态』：」。
- **会改东西的接口请求**（`solidify.md` 19.5）：「从上一个会改东西的请求以来新走过一个 `ha.commit`」照算，不分层：调用方脚本、库流程里的 `ha.commit` 都在同一份 `commits` 里。
- 里面没接住的错一路抛到调用方的脚本；调用方也没接住，就按现在的规矩停在那一步，交接的话写「第 6 步（流程『查订单状态』第 5 步）」。

### 5.7 过程记录

- `EventTrace` 加：

```ts
library?: {
  routineId: string   // RT-<n>
  version: number
  step: number        // 这个库流程里的第几步
  callId: string      // 这次调用：agent 调 = 模型的工具调用 id；脚本调 = 进入那一步的调用 id
  depth: number       // 1 = 直接调的；2 = 库流程里再调的
}
```

- 已写好：shared `routine.ts` 的 `libraryTraceSchema`，`eventTraceSchema.library`。
- 脚本里调的，同一条记录同时有 `routineStep`（或 `scriptStep`）和 `library`：调用方脚本的第几步、库流程的第几步都看得到。
- 进入库流程的那一步（`ha.routine`）是调用方的一步，不带 `library`；两层嵌套时 B 的进入是 A 的一步，带 A 的 `library`。界面按「B 里面的步骤的 `callId` = B 进入那一步的调用 id」套两层。
- 浏览器动作照常带 `trace.network`（`solidify.md` 19.3）。
- 复核的证据（`engine/log-text.ts`）：库流程那一段压成一行「流程『查订单状态』第 3 版：7 步，交回 …」，展开最近的几步，和 batch 的写法一样。

### 5.8 嵌套

- 库流程里可以 `ha.routine` 另一个库流程，**最多两层**：调用方 → 库流程 A → 库流程 B，B 里不能再调（`MAX_LIBRARY_DEPTH = 2`）。
- 不许绕圈：发布时按 `requires.routines` 查有没有环，有就不让发；运行时 SDK 按嵌套的路径再查一次（防发布以后别的流程改了）。
- 脚本里不能 `ha.tool("routine.xxx")`：工具桥拒掉，提示用 `ha.routine`。agent 写的脚本也一样。
- 理由：一层够用（「登录并切到某个视图」+「查一条」）；层数多了交接的话、过程都看不懂。

## 6. 建任务时选、权限、成绩

### 6.1 任务弹窗

- 「用哪些」里，技能、工具后面多一项「流程」：选项是库里在用的流程（`tools` 里 `source = routine`、库状态是 `listed`），提示写「什么时候用」。存进同一个 `toolIds`，界面上分开显示。
- 选了一个流程，自动勾上它要的工具（`requires.toolIds`），下面一行写「流程『查订单状态』要：浏览器（已帮你选上）」。要打开的开关（允许直接调网站接口）也写在这一行，不自动打开，由人决定。
- 后端保存时不拦：要的工具以后可能随新版本变，统一在开始运行时判断（6.2）。

### 6.2 开始运行时

`engine/sessions.ts` 冻快照时：

- 选了的库流程，取发布的那一版，连同它调的库流程（传递）一起冻进 `snapshot.libraryRoutines`（shared 的 `libraryRoutineSnapshotSchema`）：短名、工具 id、名字、「什么时候用」、版本、脚本、步骤说明、两个 schema、commits、`requires`、风险，`selected`（任务选了它 = true，网关给工具；只因为被调跟着冻进来的 = false，只在 `ha.routine` 里用）。代码在 `routine/library/snapshot.ts` 的 `freezeLibraryRoutines`。
- **这次用不了的**（停用、撤下、缺要的工具、缺要的开关、它调的流程用不了）：仍冻进去，带 `unavailable: 原因`。网关不给这个工具，系统提示写一行原因（4.2）。
- 调用方自己的固化脚本里 `ha.routine` 的流程：也要在任务里选上（同「用到的工具都在任务里」），才在 `libraryRoutines` 里。
- `SnapshotTool` 加 `source: "routine"` 和 `routineId`（已写好，`sessions.ts` 已带上）。
- 子 agent（`sub-agents.md`）从父运行的快照抄，`libraryRoutines` 一起抄。

### 6.3 权限

| 谁 | 能做什么 |
|---|---|
| 主管 | 发布进库、发布新版本、回到以前的版本、改名字和「什么时候用」、停用 / 重新启用、撤下（同技能，`config.manage`） |
| 来源任务负责人 | 看到「可以发布到流程库」的提示，但不能自己发（要用户定，第 15 节第 1 条） |
| 能改任务的人（负责人、主管） | 在任务弹窗里选用（同选技能） |
| 所有人 | 看流程页、详情、成绩、脚本 |

### 6.4 撤下、停用

- **撤下**：只有没有任务选用它、也没有别的库流程调它时能撤（同技能停用的规矩，`tasksUsingRef(t.taskTools, …)`）。撤下删掉 `tools` 那一行，库的登记留着，能重新发布。
- **停用**：不管有没有人选用都能停（自动停用也是这个）。`tools` 那一行留着，任务里还选着，新的运行用不了（6.2），任务详情里这一项标「停用」。

### 6.5 成绩

新表 `routine_calls`，每次调用（agent 调、脚本调都算；两层嵌套时每层各一行）一行：调用方的运行、任务、调用 id、怎么调的（`tool` / `script`）、层数、版本、结局、停下的原因（`stop_kind`、停在库流程第几步 `stop_step`、说明 `stop_reason`）、步数、用时。

- 结局：`achieved` / `not_achieved`（报了结果）、`bad_input`（输入不对、`ha.fail("input")`）、`stopped`（停下了，`stop_kind` 写原因）。
- 详情页看最近 50 次：跑完几次（办成 / 没办成）、停下几次、平均用时；按调用的任务分开列；最近 5 次停下的原因，点进那次运行。
- 调用方的运行：这次调用算一次工具调用，执行模型的步数不加（脚本里的判断题同 `ha.judge`，花费记在调用方）。
- 来源任务「固化流程」区块的成绩不变，只算来源任务自己的运行。

### 6.6 连续跑不通自动停用

- 库的登记上记 `fail_streak`：
  - 停下的原因是 `step_error`、`page`、`script_error`、`timeout`、`limit` → +1（shared 的 `LIBRARY_FAIL_STOP_KINDS`、`libraryStreakChange`）。这几种多半是页面变了或脚本的毛病；
  - 报了结果（办成、没办成都算）→ 清零；
  - 别的不动：被拦下、要审批、挂起、取消、输入不对。这些是调用方的配置、调用方给的输入，不怪流程。
- 满 3 次自动停用，`paused_reason` 写清最近三次停在哪；通知来源任务负责人和发布的主管。
- 修照旧在来源任务上修（第 7 节），修好、转正式以后再发布新版、重新启用。

## 7. 修：网站改了怎么办

- 网站改了，来源任务自己的运行一般先跑不通：照现在的规矩交给 agent、自动修、试跑、审核、试用、转正式。
- 库这边：
  - 新版转正式 → 提示「可以发布」，主管发布，用它的任务下一次运行就是新版；
  - 来源任务的流程被自动停用 → 通知发布的主管：「库里的第 3 版多半也跑不通了」，库里不跟着停（库有自己的计数）。
- 调用方脚本里 `ha.routine` 跑不通 → 调用方的运行交给 agent。调用方开着自动固化的，agent 办成以后修的是**调用方自己的**固化流程（脚本里照样调 `ha.routine`），库流程还是在来源任务上修。
- 不做「拿调用方的运行修库流程」：调用方的目标不一样，修出来的版本要在来源任务上再试跑、再转正式，链路太长。以后要做，就把调用方运行里停下的地方给来源任务的固化员当材料（第 14 节）。

## 8. 和派活的区别

| | 库流程 | 派活 |
|---|---|---|
| 什么时候办 | 当场，调用方等着结果（几秒到几分钟） | 排队，另开一次运行，可能几小时、一天 |
| 在哪办 | 调用方这次运行里：调用方的浏览器、登录态、规则、白名单、花费 | 被派任务自己的运行：它自己的配置、负责人、浏览器、名额 |
| 跑不通谁接着做 | 调用方的 agent，从停下的那一页 | 被派任务的 agent |
| 记在哪 | 调用方运行的过程里的一段 | 一张派活单 + 一次独立的运行，复核、结果单独算 |
| 去重、名额、自动重试 | 没有 | 有 |
| 要等人、要挂起一天 | 不适合（挂起的是调用方整个运行） | 适合 |
| 适合 | 一小段固定操作，好几个任务都要做：查一条记录、按格式填一张表、切到某个视图 | 一件完整的事：要自己的配置、要等、要人处理、要并行，或者要单独看结果 |

一句话：**调用方马上要用结果往下做、几分钟内能做完 → 库流程；这件事要单独记一笔、有自己的配置和负责人、可能要等 → 派活。**

- 两个能一起用：被派的任务可以选库流程；被派的任务开着「先跑流程」，就是现在「派活给有固化流程的任务」的用法。
- 库流程里也能 `ha.tool("work.dispatch")` 派活，和别的工具一样要调用方任务选了「派活」；派活的层数上限照旧。
- 使用手册加一段「库流程还是派活」，内容就是上面的表和一句话。

## 9. 界面

全部用 registry 组件。页面简单：区块标题下不放说明，说明放「?」。

### 9.1 新页面「流程」（配置组，「技能」后面，lucide `WorkflowIcon`）

- **左边**：`PickGroup` 分两组「在库里」「停用 / 撤下」。每项：名字，下面一行 `routine.<短名>` · 第几版 · 几个任务在用。停用的加 `Badge`（`ghost`）「停用」。
- **右边详情**（`DetailPanel`）：
  - 头部：名字、状态 `Badge`（在库里 `outline`、停用 `ghost`、撤下 `ghost`）、「第 3 版 · 来源 T-…『…』」（链到任务详情）。「⋯」（`DropdownMenu`）：改名字和说明、发布新版本、版本记录、看脚本、停用 / 重新启用、撤下。停用、撤下用 `AlertDialog`。
  - 有更新的提示：`Alert`「来源任务上第 4 版已转正式」+ 按钮「发布第 4 版」（主管才有按钮）。
  - 停用的原因：`Alert`（`destructive`）。
  - 区块（`DetailSection`）：
    - **什么时候用**：一段字。
    - **做什么**：步骤说明，一步一行；会改东西的步骤后面 `Badge`（`secondary`）「提交」。
    - **输入 / 交回**：两张小 `Table`（名字、说明、必填）。
    - **要的工具**：`Badge` 一排；风险一个 `Badge`（`riskLabel`）。
    - **谁在用**：`Item` 列表：任务（链接）、最近一次调用的时间和结局；调它的库流程也列在这里。
    - **成绩**：一行「最近 50 次：跑完 46（办成 44）· 停下 4 · 平均 6.2 秒」；下面按任务一张 `Table`；最近 5 次停下的：`Item`（停在第几步、原因、哪次运行）。
- **发布 / 发布新版本**（`Dialog` + `Field`，React Hook Form + zod）：
  - 第一次发布：选来源任务（`Combobox`，只列有转过正式版本的任务）→ 版本（`Select`，只列转过正式的）→ 名字、短名（第一次发布才能填）、什么时候用（`Textarea`）。
  - 下面只读地列出：要的工具、风险、会改东西的步骤；新版本再列不兼容的改动和受影响的（`Alert` + 列表）、`Checkbox`「我知道这些任务会受影响」。
  - 程序检查不过（有环、层数超了、短名重了）在弹窗里写原因，按钮置灰。
- **版本记录**：`Dialog` 里一张 `Table`：版本、发布的人、时间、当时在用几个任务（数据是 `routineLibrary.get` 的 `publishes`）；以前的版本能「回到这一版」（`AlertDialog` 确认，同样列受影响的，走 `preview` + `publish`）。
- **看脚本**：复用 `routine-parts.tsx` 的 `RoutineVersionView`。
- 加载 `Skeleton`；空的时候 `Empty`：「还没有库里的流程。在任务的『固化流程』里转了正式的流程，主管可以发布到这里，给别的任务当工具用。」

### 9.2 任务弹窗、任务详情

- 弹窗：「流程」`MultiPick`（6.1），选了以后一行 `text-xs text-muted-foreground` 说明自动选上了哪些工具、还要打开哪个开关。
- 任务详情的配置区（技能、工具那里）多一行「流程」：每个一个 `Badge`，停用 / 用不了的 `Badge`（`ghost`）+ `Tooltip` 写原因。
- 来源任务的「固化流程」区块：
  - 在库里的，加一行「在流程库里：`routine.order_status` 第 3 版 · 6 个任务在用」，点了去流程页。
  - 有转过正式、还没发布的版本：主管看到「⋯ → 发布到流程库」，打开 9.1 的发布弹窗（来源任务、版本已选好）；负责人看到一行提示「可以请主管发布到流程库」。

### 9.3 运行过程

- agent 调的：工具那一行写「流程『查订单状态』第 3 版」+ `Badge`「库流程」，下面一行结局「跑完 · 7 步 · 4.8 秒 · 交回 状态=已发货」或「停在第 5 步：找不到『查询』，交回 agent」。里面的步骤用 `TraceCollapsible` 收在它下面，按 `trace.library.callId` 归，超过 8 步默认收起（同 `code.run` 的脚本步骤）。
- 脚本里调的：「流程」那一步下面同样收起；两层的再套一层 `TraceCollapsible`。出来时记的「流程『…』跑完 / 自己停下了 / 没跑完」那一条按 `libraryCall.callId` 并进进入那一行（`nestLibrary` 的 `group.end`）：那一行的用时是整次调用的（取那一条里写的，停下的按两条的时间差），下面一行结局照 agent 调的写「跑完 · 7 步 · 4.8 秒 · 交回 …」或停在哪，不再单独占一行；一步都没做的调用也一样。（18.3 第 4 条）
- 审批卡（脚本里那一步要审批的）：现在写「固化流程『A』第 k 步」，库流程里的再加「（流程『查订单状态』第 j 步）」。
- 窄屏照现在的过程页。

### 9.4 别的

- 工具页不列库流程（4.1）。规则页的工具选择里列出来，标「流程」。
- 使用手册：新加 5.15「流程库」，5.14 末尾那句「还不能当工具给别的任务用」改掉；5.2 内置工具表后面加一句库流程在哪里选。

## 10. 数据和接口（约定已写好）

### 10.1 迁移 `0036_routine_library.sql`

编号：另一个人同时在写「子 agent」的约定，也会生成 0036，谁后合并谁改成 0037（改文件名、`_journal.json` 的 tag、重新生成 snapshot）。

| 改动 | 内容 |
|---|---|
| 新表 `routine_library` | `routine_id`（主键，引用 `routines`，级联）、`slug`（唯一）、`title`、`summary`、`status`（枚举 `routine_library_status`：listed / paused / withdrawn，默认 listed）、`published_version`、`requires`（jsonb，`RoutineRequires`）、`risk`、`fail_streak`、`paused_reason`、`published_by_id`、`published_at`、`created_at`、`updated_at`；推送触发器（推 `routine_id`） |
| 新表 `routine_library_versions` | 发布记录，每发布一次一行：`id`（identity）、`routine_id`（引用 `routine_library`，级联）、`version`、`published_by_id`、`published_at`、`requires`、`risk`、`compat`（jsonb，`RoutineCompatIssue[]`）、`task_count`（当时在用几个任务）；索引 (`routine_id`, `published_at`)；推送触发器 |
| 新表 `routine_calls` | `id`（identity）、`routine_id`（引用 `routines`，级联）、`version`、`session_id`（调用方，级联）、`task_id`（级联）、`call_id`、`via`（枚举 `routine_call_via`：tool / script）、`depth`、`result`（枚举 `routine_call_result`：achieved / not_achieved / bad_input / stopped）、`stop_kind`、`stop_step`、`stop_reason`、`steps`、`ms`、`at`；索引 (`routine_id`, `at`)、(`session_id`)、(`task_id`, `at`)；推送触发器 |
| `routine_versions` | 加 `proven_at`。迁移里补：审计里 `routine.promote` 记过的那一版（`detail.version`）取最近一次的时间；现在 `status = active` 的流程，`active_version` 那一版还没补上的取流程的 `updated_at` |
| `tools` | 加 `routine_id`（引用 `routines`，级联，唯一）；`tool_source` 加 `routine`；check 约束 `tools_routine_check`：`source::text <> 'routine' or routine_id is not null`（转成 text 再比：同一个迁移事务里还不能用枚举的新值） |

实时推送（`shared/live.ts`）：`routine_library` → `routineLibrary.list / get / candidates`、`routine.get`、`tasks.list`；`routine_library_versions` → `routineLibrary.get`；`routine_calls` → `routineLibrary.get / calls`；`task_tools` 多失效 `routineLibrary.list / get`。

### 10.2 shared

| 在哪 | 有什么 |
|---|---|
| 新 `routine-library.ts` | 上限 `MAX_LIBRARY_DEPTH`（2）、`LIBRARY_PAUSE_AFTER_FAILS`（3）、`LIBRARY_STATS_WINDOW`（50）、`LIBRARY_RECENT_STOPS`（5）、`LIBRARY_DESCRIPTION_STEPS`（15）、`LIBRARY_CALLS_PAGE`（50）；短名 `routineSlugSchema`、`routineToolId`、`routineSlugOfToolId`、`isRoutineToolId`、`defaultRoutineSlug`、`libraryModulePath`；要的工具 `routineRequiresSchema`、`mergeRoutineRequires`、`missingRoutineRequires`、`routineBrowserFlagLabel`；参数 `toolSchemaOf`、`inputOfToolArgs`、`routineObjectSchema`；兼容 `compareRoutineSchemas`、`routineRequiresAdded`、`routineCompatIssueSchema`；交回 `routineReturnSchema`、`routineToolStopDataSchema`；快照 `libraryRoutineSnapshotSchema`；调用记录 `routineCallSchema`、via / result 和中文、`LIBRARY_FAIL_STOP_KINDS`、`libraryStreakChange`；工具桥协议 `bridgeViaSchema`、`libraryEnterReplySchema`、`routineEndRequestSchema`；接口的输入输出（10.3）。纯函数的测试在 `packages/shared/test/routine-library.test.ts` |
| `routine.ts` | `routineLibraryStatusSchema` 和中文（放这里是因为 `routineSummarySchema.library` 要用）；`libraryTraceSchema`、`eventTraceSchema.library`；`routineVersionSchema.provenAt`；`routineSummarySchema` 加 `library`、`publishable`，`versions[].provenAt` |
| `engine.ts` | `snapshot.libraryRoutines`；`SnapshotTool.routineId` |
| `schemas.ts`、`labels.ts` | `toolSourceSchema` 加 `routine`（中文「流程」）；`toolSchema.routineId` |

### 10.3 接口（tRPC `routineLibrary.*`，`trpc/routine-library-router.ts`，已实现，接口文档 `api.md` 第 22 节）

| 接口 | 谁能用 | 输入 → 输出 |
|---|---|---|
| `list` | 登录即可 | → `RoutineLibraryItem[]`：id、短名、工具 id、名字、「什么时候用」（`summary`，集成时加的）、状态、发布的版本、在用几个任务、有没有可发布的新版本（`newerVersion`）、`failStreak` |
| `get` | 登录即可 | `{ routineId }` → `RoutineLibraryDetail`：登记的全部、来源任务、发布的那一版（不带脚本）、`newerVersions`、发布记录 `publishes`、谁在用（任务带最近一次调用；调它的库流程）、最近 50 次成绩（含按任务、最近 5 次停下的） |
| `candidates` | 主管 | → `RoutineLibraryCandidate[]`：有转过正式版本的固化流程，已经在库里的带登记 |
| `preview` | 主管 | `{ routineId, version, slug? }` → `RoutineLibraryPreview`：要的工具、风险、会改东西的步骤、生成的给模型的说明、程序检查的问题、和现在发布的版本比的不兼容改动、受影响的任务（缺什么）和流程 |
| `publish` | 主管 | `{ routineId, version, slug?, title, summary, acceptBreaking? }` → `{ routineId, version }`。第一次发布要 `slug`；有不兼容改动要 `acceptBreaking`；回到以前的版本也用它 |
| `update` | 主管 | `{ routineId, title, summary }` → `{ routineId }`：改名字、说明（重写 `tools` 那一行，下一次运行生效） |
| `setPaused` | 主管 | `{ routineId, paused }` → `{ routineId, status }`；重新启用清零 `fail_streak` |
| `withdraw` | 主管 | `{ routineId }` → `{ routineId, status: "withdrawn" }`：有任务选用或别的流程调它时 `CONFLICT`，写清是哪些 |
| `calls` | 登录即可 | `{ routineId, cursor?, taskId? }` → `{ items, nextCursor }`，新的在前 |

`routine.get`（任务详情的区块）多带 `library: { slug, toolId, title, publishedVersion, status, taskCount } | null` 和 `publishable: number[]`（现在先填 `null`、`[]`，B 包接上 `libraryOfRoutine`）；`versions[]` 和 `routine.version` 带 `provenAt`（已接好）。

审计：`routine.library.publish`、`.update`、`.pause`、`.resume`、`.withdraw`、`.auto_pause`。

### 10.4 代码（约定时建的空壳，三包已实现）

| 在哪 | 做什么 | 谁 |
|---|---|---|
| `routine/library/service.ts` | 读、发布、改、停用、撤下、调用记录；写 `tools` 那一行和发布记录；`libraryOfRoutine`（`routine.get` 用）；约定时的 `libraryNotYet()` 集成时删了 | B |
| `routine/library/analyze.ts` | `analyzeLibraryCode`、`libraryRisk`、`findLibraryCycle`、`libraryDepthOf`、`analyzeForPublish`、`compatWithPublished`、`routineToolDescription`（4.2 的说明） | B |
| `routine/library/tool.ts` | 网关里库流程工具的执行 `executeLibraryTool`：起沙箱、`mode = tool` 的工具桥、交回值、交接的话 | A |
| `routine/library/stats.ts` | `recordRoutineCall`：写 `routine_calls`、`fail_streak`、自动停用、通知 | A |
| `routine/library/snapshot.ts` | `freezeLibraryRoutines`（冻快照）、`libraryModules`（沙箱代码目录里的模块）、`libraryPromptSection`（系统提示一节） | A |
| `trpc/routine-library-router.ts` | 接口，已接到 service.ts | 已写好 |
| `sandbox-sdk/heyagent/index.d.ts` | `ha.routine`、`RoutineResult`、`RoutineFailed`，开头的说明 | 已写好；`index.js`、`launch.js` 由 A 实现 |

## 11. 安全

| 担心的事 | 怎么防 |
|---|---|
| 库流程绕过调用方的规则、白名单 | 每一步走调用方的网关（5.3）；进入也是一次工具调用，整个流程上的规则照样管 |
| 一个人发了坏版本，影响别人的任务 | 只有主管能发布；只收在来源任务上转过正式的；不兼容的改动发布前列出来、要勾确认 |
| 注入：网页里的话让脚本做坏事 | 和固化脚本一样：只能用 SDK、不能上网、每一版都人审过；库流程没有新的能力 |
| 套娃、绕圈、跑太久 | 最多两层，发布时、运行时都查环；次数、时间用固化脚本的上限，还要在调用方剩下的时间里 |
| 用错登录态（调用方的 Chrome 登的是另一个账号） | 用调用方的配置是设计上的选择：谁选用谁负责；遇到登录页照常交给人；详情和发布弹窗写清楚 |

## 12. 测试计划

### 12.1 单元（假模型、不带 bwrap 的 runner）

- **发布**：没转正式的版本不让发；短名重复；有环；层数超了；`requires` 和风险算得对（只读、带提交、带 money 的 HTTP 工具、嵌套的传递）；不兼容改动的几种（加必填、去参数、改类型、交回少了）；回到以前的版本。
- **快照**：跟着发布的版本；运行中途发布新版不影响这次；停用、撤下、缺工具、缺开关、调的流程用不了 → `unavailable`、网关不给工具、系统提示有那一行。
- **agent 调**：
  - 跑完交回值对；`not_achieved` 不算出错；`ha.fail("input")`；
  - 停下交回的话：步骤、提交做没做、现在的页面；
  - 里面一步被调用方的规则拦下；里面一步要审批 → 停在前面、没发起审批；整个流程上的规则要审批 → 普通审批卡；
  - 里面遇到登录页 → 运行挂起；取消；次数上限；
  - `work.report`、`finish`、`checkpoint.mark` 没写到调用方的运行上。
- **脚本调**：
  - 固化脚本里 `ha.routine` 跑通，交回值能用；里面没接住的错抛到外面；
  - 里面一步要审批 → 停下等人 → 批准 → 按日志接着跑，对得上；
  - 试跑停在库流程里的第一个提交；试用期库流程里的提交前截图；
  - `code.run`（tools）脚本循环调 `ha.routine`；
  - 两层能跑、三层报错、运行时的环报错；`ha.tool("routine.x")` 被拒。
- **成绩**：每种结局记对；`fail_streak` 只算那五种；满 3 次自动停用、通知；报了结果清零。
- **固化员**：材料里库流程那一步是一行（不展开里面的步骤，里面发的接口请求归到这一行）；程序检查认 `ha.routine`，任务没选的流程报错、短名不是字面量报错；提示词有这条规矩。
- **会改东西的接口请求**：库流程里 `POST` 的 `browser.fetch` 前面没有 `ha.commit` → 停下（agent 调、脚本调、嵌在 agent 的 `code.run` 里都一样）。
- shared 的纯函数（已写好）：`packages/shared/test/routine-library.test.ts`。

### 12.2 浏览器测试（worker 镜像，真 Chrome + bwrap）

- 本地测试站点：任务 A 固化「查一条记录」、转正式、发布；任务 B（假模型）调这个工具，在 B 的 Chrome 上做完、拿回结果；改掉站点上一个按钮的名字 → 停下交回 → B 的 agent 接着做完。
- 任务 C 的固化脚本里 `ha.routine` 调它，中途遇到登录页 → 人登录 → 接着跑完。

### 12.3 真模型（约 $0.3）

- 基准站点：场景 B 里「查一家」那一段做成库流程（来源任务只查一家），场景 B 整件事的任务选用它。
- 量三件事：
  - agent 会不会用它、参数填得对不对（中文参数名换成了 `p<n>`，说明里写原名，见第 3 节：看模型会不会照说明填）；
  - 用时和 agent 自己做比；
  - 场景 B 的任务办成以后固化，固化员会不会写 `ha.routine` 循环。
- `conventions.md` 第 0 节的业务词检查没有新的命中。

## 13. 分工和工作量

监工的约定已写好（第 10 节、第 16 节）：shared 的类型和纯函数（带测试）、迁移 0036、`routineLibrary` 路由和 service 的空壳、A 包几个新文件的空壳、`EventTrace.library`、SDK 的 `index.d.ts`。三个包照着并行做，各在自己的 worktree 和私有库（迁移跑到 0036）。**约定（shared、迁移、`index.d.ts`）不要改，要改先说**；新加字段、新导出的函数可以，汇报里写清楚。

互相依赖：

- A、B 都不等对方：A 测试里直接往 `routine_library`、`tools`（`source = routine`）里写行造一个「已发布」的库流程；B 不需要运行时就能测发布、读、撤下。
- C 只依赖接口的形状（shared 的 schema 已定），先用 fixture 造数据；接口回 NOT_IMPLEMENTED 时页面照常显示出错。fixture 要 A 的 `recordRoutineCall` 之前就能造调用记录：fixture 直接往 `routine_calls` 写行。
- A 不用 B 的代码（运行时只读登记和快照）。B 也不用 A 的代码；自动停用在 A 的 `routine/library/stats.ts`，「可以发布」「来源流程停用」的通知在 B，文案各写各的。
- 改同一个文件的地方：`routine/runtime/stats.ts` 只有 B 改；`routine/checks.ts` 只有 B 改；`engine/sessions.ts`、`gateway.ts`、`bridge.ts` 只有 A 改；`routine/service.ts` 只有 B 改。
- 合并顺序：A、B 任意，C 最后（要两边的接口才看得到真数据）。三包都会碰 `shared/src/routine-library.ts` 时只许加，不许改已有的。

### 13.1 A 包：运行时（约 1.5 天，最重）

| 文件 | 改什么 |
|---|---|
| `sandbox-sdk/heyagent/index.js` | `ha.routine`：发进入（`op: "tool"`，带 `via`）→ 按回复的 `module` 载入 → 在 `AsyncLocalStorage` 的嵌套上下文里调 `run(input)` → 发 `routine_end`；嵌套上下文里 `ha.input`、`ha.finish`、`ha.work.report` 只收进返回值，`ha.checkpoint.mark` 不发、`ha.fail` 变成 `RoutineFailed`；所有请求带 `via`；导出 `RoutineFailed` |
| `sandbox-sdk/heyagent/launch.js` | 认 `mode = tool`（stdin 里多一个 `{ library: true }` 之类的标记，A 自己定）：顶层也按嵌套的规矩收交回值，跑完报给 `done` |
| `routine/runtime/bridge.ts` | `mode = tool`；进入（`routine.*`，校验、层数、环、`inline`）、`routine_end` 标记、记进日志；trace 的 `library`（按 `via` 和自己数的步）；试跑放行进入那一步；拒 `ha.tool("routine.*")`（「用 ha.routine」）；`mode = tool` 和带 `via` 的请求也守 19.5 的「会改东西的 fetch 要自己的 commit」；`NOT_FOR_AGENT_SCRIPTS`（子 agent 也会加 `subagent.*`，合并时两边都留） |
| `routine/runtime/run.ts`、`sandbox/code-run.ts` | 代码目录里放 `libraryModules(...)` 给的 `routines/<短名>.mjs` |
| `routine/runtime/handoff.ts` | 抽出「按一组过程记录写步骤行」的函数；按 `trace.library.callId` 取一次调用的步骤 |
| `engine/gateway.ts` | `source = routine` 的工具条目（`toolSchemaOf` 的 JSON Schema、`executeLibraryTool`）；`call()` 的 `inline`、`library` 选项；`unavailable` 的不给 |
| `engine/sessions.ts` | 冻 `libraryRoutines`（`freezeLibraryRoutines`）；固化试跑也冻（试跑的脚本可能调库流程） |
| `engine/prompt.ts` | 「固化好的流程」一节（`libraryPromptSection`），用不了的写一行原因 |
| `engine/log-text.ts` | 复核证据里库流程那一段压成一行 |
| 新 `routine/library/tool.ts`、`stats.ts`、`snapshot.ts` | 照空壳的签名实现 |
| 测试 | 12.1 的快照、agent 调、脚本调、成绩；12.2 两条 |

### 13.2 B 包：库服务、固化员（约 1 天）

| 文件 | 改什么 |
|---|---|
| 新 `routine/library/service.ts`、`analyze.ts` | 照空壳的签名实现；`libraryNotYet` 留着给没做的分支用，做完删掉 |
| `routine/checks.ts` | 导出 AST 分析（给 `analyzeLibraryCode` 用）；`SDK_TOP` 认 `routine`：第一个参数要是字面量，`routine.<短名>` 要在任务的工具里（`toolIds`），不在报「任务没选流程『…』」；`ha.tool("routine.…")` 报「用 ha.routine」 |
| `routine/runtime/stats.ts` | 转正式时写 `routine_versions.proven_at`；来源流程转正式、被自动停用时，库里有它的通知发布的主管（第 7 节） |
| `routine/material.ts`、`routine/prompt.ts` | 材料里库流程那一步一行（不展开里面的步骤；里面发的接口请求在「网页调过的接口」一节里归到这一行，写「在流程『…』里发的」）；提示词的规矩「过程里调了库流程的，脚本里用 `ha.routine` 调同一个，不要抄里面的步骤、接口」 |
| `routine/service.ts` | `getTaskRoutine` 接上 `libraryOfRoutine`（现在填的 `null`、`[]`） |
| `trpc/routine-library-router.ts` | 已写好；要改输入输出先说 |
| `data/loaders.ts` | `listTools` 过滤掉 `source = routine` |
| `data/config/tools.ts`、`assistant/tools.ts` | 编辑、删除工具遇到 `source = routine` 报「这是流程库里的流程，在流程页里改」 |
| `data/config/tasks.ts` | 任务保存不拦（6.1）；`toolIds` 里的 `routine.*` 照常存进 `task_tools` |
| 通知 | 可以发布、自动停用（A 的 `stats.ts` 发）、来源流程停用 |
| 测试 | 12.1 的发布、固化员两组 |

### 13.3 C 包：网页（约 1 天）

| 文件 | 改什么 |
|---|---|
| 新 `pages/routines/` | 列表、详情、发布弹窗（`preview` 随填随查）、版本记录（`get.publishes`）、调用记录；侧边栏「技能」后面加「流程」（lucide `WorkflowIcon`） |
| `pages/tasks/task-dialog.tsx` | 「流程」`MultiPick`：选项是 `routineLibrary.list` 里 `listed` 的；选了自动勾 `requires.toolIds`，一行说明（`missingRoutineRequires`、`routineBrowserFlagLabel`）；存进同一个 `toolIds` |
| `pages/tasks/task-detail.tsx` | 配置区「流程」一行；停用、用不了的 `Badge`（`ghost`）+ `Tooltip` |
| `pages/tasks/task-routine.tsx` | 「在流程库里」一行（`routine.get` 的 `library`）；`publishable` 不空时主管「⋯ → 发布到流程库」、负责人一行提示 |
| 运行过程（`run-detail.tsx`、`run-script.ts` 那一带） | 库流程的工具行；`TraceCollapsible` 按 `trace.library.callId` 归步骤，两层套两层；审批卡的文案 |
| 规则页的工具选择 | 列出流程（`toolSourceLabel.routine` = 「流程」） |
| 工具页 | B 过滤以后不用改；在那之前 `source = routine` 的行会出现在列表里，不用管 |
| fixture | `apps/server/src/seed/routine-library-fixture.ts`：一个来源任务、发布过两版、两个任务在用、有调用记录和停下的（直接写表） |
| 检查 | 照 `ui-rules.md` 第 7 节检查一遍；暗色、窄屏看过 |

### 13.4 监工收尾（半天）

合并（迁移撞号就改成 0037）、跑全量和浏览器测试、真模型（12.3）、使用手册 5.15、`api.md` 新一节、本文加「实现记录」。

## 14. 不做 / 以后

- **每个任务钉住版本**：见 2.3。
- **别的任务「整件事先跑库流程」**：整件事都一样，就派活给来源任务，或者选用它让 agent 调一次。要做的话，统计、试用、自动修都要分「谁的」，这一期不做（第 15 节第 4 条）。
- **拿调用方的运行修库流程**：见第 7 节。
- **库流程接着跑**（agent 调的，挂起后从停下的那一步接着跑脚本）：现在交回 agent。要做就给每次调用一份重放日志，等真的有需要再说。
- **对外开放**（外部系统按 API 调库流程）：派活第三期的对外接口做了以后再看。
- **人手改库流程的脚本**：还是只能固化员写、人审。

## 15. 要用户定的事

1. **谁能把流程放进库**：建议只有主管（库里的流程和技能一样是大家共用的配置，「改配置只有主管」是定过的）。来源任务负责人看到「可以请主管发布」的提示。备选：来源任务负责人也能发布、发新版本。
2. **库里的流程更新以后，用它的任务跟不跟着变**：建议跟着变，同技能（下一次运行用新版）。发布前列出不兼容的改动和受影响的任务，要勾确认。备选：每个任务钉住版本，自己点升级。
3. **什么样的版本能进库**：建议只收在来源任务上转过正式（连着 3 次脚本直接办成）的版本。备选：审核启用过就能进，代价是还在试用的版本就给别的任务用了。
4. **别的任务能不能「整件事先跑库里的流程」**（不只是当工具）：建议这一期不做。当工具调、派活给来源任务，已经能覆盖。

## 16. 约定记录（2026-10-28）

### 16.1 写了什么

分支 `worktree-agent-aed6bf0847665eb2a`（基于集成分支 1af8ae5），一个提交：

- shared：新 `routine-library.ts`（第 10.2 节）和测试 `test/routine-library.test.ts`；`routine.ts`（登记状态、`trace.library`、`provenAt`、`routine.get` 的 `library` / `publishable`）；`engine.ts`（`snapshot.libraryRoutines`、`SnapshotTool.routineId`）；`schemas.ts` / `labels.ts`（工具来源 `routine`「流程」、`toolSchema.routineId`）；`live.ts`（三张新表、`task_tools`）。
- 数据库：`db/schema.ts` 三张新表、两个新列、三个新枚举、一个 check；迁移 `0036_routine_library.sql`（生成的 + 手写的回填和推送触发器）。
- 服务器：`trpc/routine-library-router.ts`（接到 `routineLibrary`），空壳 `routine/library/{service,analyze,tool,stats,snapshot}.ts`；现有读写带上新字段：`routine/service.ts`（`provenAt`，`library: null`、`publishable: []`）、`engine/sessions.ts`（`routineId`）、`data/loaders.ts`（`routineId`）、`imports/catalog.ts`（工具来源的类型放宽成 `ToolSource`：导入的 AI 看得到库流程）。
- SDK：`index.d.ts` 的 `ha.routine`、`RoutineResult`、`RoutineFailed`、开头的说明、`ha.input` 的说明。`index.js` 没动（A 包）。

### 16.2 和原稿不一样的地方（按现在的代码改的）

1. **工具参数名**（第 3 节）：原稿要拿真模型验中文参数名、不行再退回 `p1…pn`。HTTP 工具早就按 `^[A-Za-z0-9_]{1,64}$` 把别的名字换成 `p<n>`（`httpParamKeys`），这里照做，不再验。`$note` 原稿写「可选」，改成必填照 `inputSchema`。
2. **浏览器开关的名字**（4.4、6.1）：任务上叫 `allowBrowserFetch` / `allowBrowserVision`，快照里是 `browser.allowFetch` / `browser.allowVision`；`requires.browser` 用 `fetch` / `vision`。
3. **会改东西的接口请求要自己的 `ha.commit`**（19.5，原稿写在它之前）：现在只在 mode `run`、`test` 里判。库流程是固化脚本，`mode = tool` 和嵌在 agent 的 `code.run` 里（请求带 `via`）时也要判；`commits` 不分层（5.2、5.6）。
4. **交接的话取步骤**（5.5）：现在的 `routineStepLines` 只认 `trace.routineStep`，要抽出来按 `trace.library.callId` 取。
5. **固化员的材料**（12.1、13.2）：19.6 加了「网页调过的接口」一节，按 `trace.network` 对上步骤。库流程里的步骤不展开，它们发的请求归到库流程那一行，提示词加「不要抄里面的接口」。
6. **调用记录多两列**（6.5、10.1）：`stop_step`、`stop_reason`。详情页「最近 5 次停下的：停在第几步、原因」和自动停用的原因要用，原稿只有 `stop_kind`。
7. **发布记录**（9.1、10.1）：`routine_library_versions` 用自增 id（回到以前的版本会再发布同一版），多 `task_count`（版本记录写「当时在用几个任务」）；版本记录的数据放在 `routineLibrary.get` 的 `publishes`，不另开接口。
8. **快照**（6.2）：加 `selected`，分清「任务选了的」（网关给工具）和「只因为被调跟着冻进来的」。
9. **`routine.get` 的 `library`** 多 `toolId`、`title`，`usedBy` 改成 `taskCount`（区块里只显示几个任务在用）。
10. **接口细节**（10.3）：`preview` 多 `slug`（弹窗随填随查短名）；`calls` 多 `taskId` 筛；`get` 多 `newerVersions`、`publishes`、`source`。
11. **`tools` 的约束**：`routine_id` 唯一；check 用 `source::text` 比较（同一个迁移事务里不能用枚举的新值）。
12. **`proven_at` 回填**：原稿只按「现在正式的启用版本」补，会漏「转过正式后又停用 / 回到试用」的版本，加了按审计 `routine.promote` 补。
13. **迁移编号**：原稿暂记 0034，现在是 0036（和子 agent 的约定撞号，后合并的改 0037）。
14. **工具页过滤的位置**：工具页的读是 `data/loaders.ts` 的 `listTools`，不是 `data/config/tools.ts`；助手改工具（`assistant/tools.ts`）也要拦。
15. **子 agent**（`sub-agents.md`，同时在写约定）：子运行从父运行快照抄，`libraryRoutines` 一起抄；两边都改 `routine.ts`、`bridge.ts` 的 `NOT_FOR_AGENT_SCRIPTS`，合并时两边都留。

## 17. 实现记录（2026-10-28）

约定 `worktree-agent-aed6bf0847665eb2a`（c48299d）、B `worktree-agent-ad560512c296d2699`（e03c3bf）、A `worktree-agent-a2d84780a8bb23143`（ac9618e）、C `worktree-agent-a975edbfb21de655c`（3a8d1a3）按这个顺序合进集成分支 `worktree-agent-a63a9b71c05b52516`（基于 `worktree-solidify-design` 9ed41ae）。四个分支都基于 9ed41ae，三包改的文件互不相交，合并没有冲突；迁移 0036 直接接在 0035 后面（子 agent 那边还没合，撞号时后合并的改 0037）。

### 17.1 A 包（运行时）和设计不一样的地方

1. **`EventTrace.libraryCall`**（shared `routine.ts` 新加的可选字段，只做加法）：设计 5.7 只有 `library`（里面的步骤），界面靠「B 进入那一步的调用 id」对上。实现里调库流程**本身**的那几条都写 `libraryCall { callId, routineId, version }`：agent 调的工具 `routine.<短名>` 那一行（网关写，`callId` = 模型的工具调用 id）、脚本里 `ha.routine` 进入那一步、出来时记的「流程『…』跑完 / 自己停下了 / 没跑完」那一条。两层嵌套时 B 的进入、B 跑完那一条同时带 A 的 `library` 和 B 的 `libraryCall`。
2. **进入请求**：`{ op: "tool", tool: "routine.<短名>", input, routine: true }`，多一个 `routine: true` 标记（工具桥据此走进入的分支）。
3. **`launch.js`**：agent 调库流程时 stdin 多 `{ "library": { "slug": 短名 } }`，顶层也按嵌套的规矩跑，结局放在 `done.routine`。
4. **工具结果的最后一行**是交回值（`routineReturnSchema`）或停下的 `data`（`routineToolStopDataSchema`）的 JSON，网页按它显示结局（设计只说 `data` 里给）。
5. **复核证据**（5.7）：没压成一行，库流程每次调用只留最近 3 步（`log-text.ts`），工具行标「调库流程」。
6. **库流程里 `ha.tool` 调 `run.finish` / `work.report` / `checkpoint.mark` 一律拒**（设计只写了 `ha.finish` 等 SDK 方法收进交回值，没写绕开 SDK 直接调工具的情况）。
7. **调用记录**：同一个调用 id 再记是覆盖（挂起后接着跑、重放时不重复记）；`trace.library.step` 每一层自己数。
8. **`handoff.ts`**：抽出 `stepLinesOf`，`libraryStepLines` 按 `trace.library.callId` 取（同 16.2 第 4 条）。审批卡写「（流程『…』第 j 步）」在 `loop.ts`。

### 17.2 B 包（库服务、固化员）和设计不一样的地方

1. **要的工具**（4.4）算传递（它调的库流程要的也算上），`alwaysOn` 的内置工具不放。
2. **发布**：有不兼容改动而没带 `acceptBreaking` 回 `CONFLICT`（写清是哪些），`preview` 的问题不空回 `BAD_REQUEST`；撤下的重新发布回到「在库里」。
3. **撤下**：有任务选用、或别的库流程调它（`requires.routines`）都 `CONFLICT`。
4. **通知**：转正式「第 n 版可以发布」、来源流程自动停用，发给发布过这个流程的主管（`notifyLibraryPublishable` 等，在 `service.ts`，由 `routine/runtime/stats.ts` 调）。
5. **程序检查**（`checks.ts` 抽出 `analyzeScript`）：`ha.routine` 的短名要写成字面量；任务要选了 `routine.<短名>`；`ha.tool("routine.…")` 报「用 ha.routine」；也认 `ha.RoutineFailed`。
6. **助手**：`list_tools` 另列库流程（工具页不列，任务里能选）；改、删工具遇到 `source = routine` 拦下。
7. **固化员**：材料里库流程那一次是一行（不展开里面的步骤，写脚本里怎么调、参数名 `p<n>` 对应的原名），里面发的接口请求归到这一行；另加「任务选的库流程」一节；有库流程时提示词多一条规矩（同设计）。

### 17.3 C 包（网页）和设计不一样的地方

1. **流程页**：「⋯ → 版本记录」里的「回到这一版」先 `preview` 列不兼容改动和受影响的，`AlertDialog` 确认后 `publish`；「全部调用记录」单独一个弹窗，按任务筛。
2. **工具名**：`useToolName` 对 `routine.*` 用 `routineLibrary.list` 里的名字（工具页不列库流程，`tools.list` 里没有）。
3. **规则弹窗**「提到的工具」列流程（标「流程」），规则详情里链到流程页。
4. **演示数据** `apps/server/src/seed/routine-library-fixture.ts`（`pnpm --filter @heyagent/server dev:routine-library-fixture`）：直接写表，4 个库流程（在库里有新版本可发布、被调的、自动停用的、撤下的）+ 1 个转过正式还没发布的；调用方的运行有 agent 调两次（一次停下）、`code.run` 脚本循环调、两层嵌套。

### 17.4 集成时改的

1. **列表带「什么时候用」**：`RoutineLibraryItem` 加 `summary`，`listLibrary` 带上。任务弹窗的「流程」（`routine-pick.tsx`）原来对每个流程调一次 `routineLibrary.get` 取说明，改成用列表里的；`get` 只对选了的取（要的工具 `requires` 只在详情里）。
2. **参数顺序**：`routine_versions.input_schema` 是 jsonb，存进去属性按键长短重排，`toolSchemaOf` 给的 p1、p2 就不是作者写的顺序。改成存库前把属性顺序记进 schema 的 `"x-order": [属性名…]`（shared 的 `SCHEMA_ORDER_KEY`、`withPropertyOrder`）：固化员的 `inputSchema` / `outputSchema` 是 JSON 文字，`checks.ts` 的 `parseJsonSchema` 解析时记下（`compile.ts` 存的就是它）。读的地方按 `schemaPropertyNames` 排：`routineObjectSchema` 多返回 `names`，`toolSchemaOf`（因此 `inputOfToolArgs`）、`compareRoutineSchemas`、发布时生成的说明（`analyze.ts`）、固化员材料里「任务选的库流程」一节、网页的输入 / 交回表（`schemaFields`）都按它。没有 `x-order` 的老数据照存的顺序（和以前一样）。zod 的 `fromJSONSchema` 不认识的键直接忽略，校验不受影响。演示数据也写 `x-order`。测试：shared 加三条，`routine-compile.test.ts` 的两处期望带上 `x-order`、加一条中文键顺序的。
3. **过程按调用 id 归组**：`run-script.ts` 的 `nestLibrary` 原来按位置认主人（脚本调的找第一步前面最近的 `routine.*` 工具行，agent 调的找最后一步后面第一行）。改成先按 `trace.libraryCall.callId` = 组的 `library.callId` 找这一层里的 `routine.*` 工具调用；「跑完」那一条也带 `libraryCall` 但不是工具调用，照普通一项放在后面。没有 `libraryCall` 的老数据照原来按位置认，带 `libraryCall` 的行不会被别的组按位置抢走。演示数据的调用行都补上了 `libraryCall`。
4. **清理**：删了 `service.ts` 里没人用的 `libraryNotYet`（和随之没用的 `TRPCError` 引用）；C 包没留下临时代码（它的分支只改了网页、演示数据和 `package.json` 的脚本）。

### 17.5 没做的、留给以后的

- 真模型验收（12.3）：这次的环境没有模型的 key（后来补做了，见第 18 节）。
- 子 agent 从父快照抄 `libraryRoutines`：子 agent 那边的事（`sub-agents.md`），合并时注意。
- 使用手册：新加 5.15「流程库」，5.2 内置工具表后、5.14 末尾各加一句，第 8 节改掉「还不能当工具给别的任务用」；接口文档 `api.md` 第 22 节。

## 18. 真模型验收（2026-10-28）

在集成分支 e7cbab5 上做（12.3）。模型照 `solidify.md` 第 20 节：执行、复核 `deepseek-v4.1-flash-1017`（能看图），固化 `deepseek-v4-pro`。基准是新写的 `apps/server/test-browser/speed/library.bench.ts`，命令 `SPEED_FILE=library scripts/speed-bench.sh x5-lib1 B 3`，结果在 `.dev/speed/x5-lib1.jsonl`（不进仓库），两版脚本、固化员的材料另存在旁边（`x5-lib1-source-compile-v1.js`、`x5-lib1-caller-compile-v1.js`、`…-material.md`）。一遍跑完 20 分钟。

**做法**（全在一个测试里，按顺序）：

1. **来源任务「查一家」**：照场景 B，但只查一家。任务打开「可以被派」：参数「供应商全名」（必填），要交回的结果「电话」「评分」。人派一张（查 s4，不在场景 B 的 6 家里）→ agent 办成 → 固化 → 审核启用 → 再派 3 张（s6、s8、s10）照脚本跑。3 张都直接办成，试用转正式、`proven_at` 是程序自己写的，没有手补。
2. **主管发布**：林舟（主管）`routineLibrary.preview` 看了一遍，`publish` 短名 `supplier_contact`、名字「查供应商电话和评分」、什么时候用「要查某一家供应商的电话和评分时用（按全名查）」。
3. **对照**：场景 B 整件事（查 6 家、交汇总，目标和第 20 节一样）不选库流程，agent 办 2 遍。
4. **选用**：同一个目标的另一个任务，工具多选 `routine.supplier_contact`，agent 办 3 遍。目标里没提流程，看 agent 自己会不会用。
5. **固化整件事**：拿第 4 步第 1 遍（办成、用了库流程）固化，审核启用，照脚本跑 3 遍。

### 18.1 结果

| 步骤 | 用时 | 模型调用 | 做对 | 花费 | 说明 |
|---|---|---|---|---|---|
| 来源任务 agent 查一家 | 28.0 秒 | 8 次 | 1/1 | $0.0025 | 复核办成 |
| 来源任务固化 | 107.9 秒 | — | — | $0.041 | 1 轮过；6 步：搜索页 → 输全名回车 → 等全名的链接 → 点进去 → 等标题是全名 → 读表格 |
| 来源任务照脚本跑 3 张 | 8.8–9.8 秒 | 0 | 3/3 | $0.0002–0.0004 | 都直接办成，第 3 张后转正式 |
| 对照：agent 自己查 6 家 | 97.7、92.0 秒 | 34、32 次 | 6/6、6/6 | $0.021、$0.009 | 输入 46 万、45 万 token |
| **选用库流程：agent 查 6 家** | **108.8、186.9、135.1 秒** | **25、37、30 次** | 6/6 ×3 | $0.0057、$0.0146、$0.0107 | 每遍都调了 6 次库流程；输入 34 万、59 万、42 万 token |
| 整件事固化 | 156.2 秒 | — | — | $0.044 | 2 轮：第 1 轮脚本解析不了（字符串里写了真的换行），第 2 轮过；试跑停在第 50 步「提交汇总」前 |
| **整件事照脚本跑 3 遍** | **45.4–45.8 秒** | **0** | 6/6 ×3 | $0.0003–0.0010（只有复核） | 每遍 53 步：6 次 `ha.routine` + 里面各 6 步 + 自己的核对、提交 |

和第 20 节的场景 B 比（agent 112.6 秒 33 次；脚本 30.6–31.3 秒）：这次对照组 agent 92–98 秒。

**第 1 件：agent 会不会用、参数填得对不对**

- 会用。3 遍都是一上来就在 `plan.set` 里写「用 routine_supplier_contact 依次查 6 家」，6 家各调一次，没有一家是自己去搜的。
- 参数 18 次全对：都是 `{"p1": "<全名>"}`，全名一字不差，没有一次写成中文参数名、没有多余参数，没有「输入不对」。工具说明里写的是「p1（供应商全名）（必填）」，模型照着填了。
- 18 次都办成（`routine_calls` 18 行 `via = tool`、`achieved`、6 步），每次 6.8–8.3 秒（第一次 8.2 秒，含 Chrome 第一次开页面）。
- 一次调用里沙箱、工具桥的额外开销约 0.3 秒（调用的 `ms` 减去里面 6 步的 `ms` 之和：8216 − 7949、6868 − 6544）。

**第 2 件：用时、模型调用和 agent 自己查比**

- **没有变快**：选用库流程的 3 遍 108.8 / 186.9 / 135.1 秒，对照 97.7 / 92.0 秒。模型调用 25 / 37 / 30 次，对照 34 / 32 次，只有第 1 遍少了。
- 6 次库流程调用本身在 63–81 秒内做完（第 2 遍里模型出错重试了两次，多 10 秒）：每次库流程 7 秒左右，加上每次一轮模型调用 2–5 秒（agent 一轮只调一次）。
- 第 6 次库流程做完以后，3 遍还各用了 43.6 / 106.3 / 72.1 秒、18 / 30 / 23 次模型调用，提交汇总本身只要 10 秒左右、5–6 次。多出来的是 **agent 不信库流程交回的结果，自己又一家家打开详情页核对**（3 遍都这样，见 18.3 第 1 条）：第 1 遍 6 次 navigate + 6 次 extract；第 2 遍还按关键词搜了 6 次「名字相近的别家」；第 3 遍 5 次 navigate + extract。
- 库流程每查一家要开 3 个页面（搜索页、搜索结果、详情页），这个站点每个页面有一张慢图，各要 2 秒左右，7 秒里 6 秒是等页面。agent 自己办时用的路子更短（对照组 7 次 navigate、7 次 click 查完 6 家），所以在这个站点上库流程一家的时间并不比 agent 自己查少多少。
- 花费：选用库流程的 3 遍 $0.006–0.015，对照 $0.009–0.021，差不多（同样有缓存命中，差别主要在核对时多出的轮数）。

**第 3 件：整件事固化，固化员会不会写 `ha.routine` 循环**

- 会。脚本是一个 `for (const name of suppliers)` 循环，里面 `await ha.routine("supplier_contact", { 供应商全名: name })`（参数名换回了原名），先看 `r.outcome` 再用 `r.data`，没有把库流程里的步骤、选择器抄出来。6 家的全名写死在脚本里（这个任务没有输入，名字来自目标，对）。
- 固化员也把 agent 多做的核对照抄了：每次 `ha.routine` 后在详情页 `ha.browser.extract({ fields: { 名称: "h1, h2, .name", 表格: "table" } })`，名称不是全名就 `ha.fail("page")`。多 6 步，各 40–100 毫秒，影响不大。
- 材料里库流程那几次各是一行（「流程库里的流程…一次调用跑完，里面 6 步不展开」，带「agent 调时的参数名对应：p1 = 供应商全名」），另有「任务选的库流程」一节，都和 17.2 第 7 条说的一样。
- 照脚本跑 3 遍 45.4–45.8 秒，0 次模型调用，6/6，复核都判办成，`routine_calls` 每遍 6 行 `via = script`、`achieved`。比 agent（92–187 秒）快 2–4 倍；比第 20 节自己写全部步骤的 B 脚本（30.6–31.3 秒）慢 15 秒。第 20 节那版脚本没存档，没法逐步比；这次每家 7 秒里 6 秒在等 3 次开页面（搜索页、搜索结果、详情页），是来源任务固化出来的路子，调用本身的开销只有零点几秒。

### 18.2 过程记录、调用记录和界面

- **`trace.library` / `libraryCall` 对得上**（基准里逐条比的）：
  - agent 调的 3 遍：每遍 6 行 `routine.supplier_contact` 带 `libraryCall`，36 步带 `library`，每个 `callId` 下正好 6 步（`step` 1–6），没有对不上的步骤，也没有没步骤的调用。
  - 脚本调的 3 遍：每遍 12 行带 `libraryCall`（6 次进入 + 6 条「跑完」，同 17.1 第 1 条），36 步带 `library`，同样全对得上；里面的步骤同时带 `routineStep`。
- **调用记录、成绩**：`routine_calls` 一共 36 行（18 行 `tool`、18 行 `script`，`depth` 1，都 `achieved`，`steps` 6）。流程页的成绩「最近 36 次：跑完 36（办成 36）· 停下 0 · 平均 7.2 秒」，「谁在用」是选用的任务、最近一次办成；`fail_streak` 0。来源任务自己的 4 次运行没算进库的成绩（对，6.5）。
- **界面**（开发服务 API 3144、前端 5204 指向跑完的测试库，worker 镜像的 Chrome 截图，看完按 PID 关了）：
  - agent 调的：一行「库流程 流程『查供应商电话和评分』第 1 版 · 8.2 秒」，下面一行「跑完 · 6 步 · 8.2 秒 · 交回 电话=0579-85512301、评分=4.6」，里面 6 步收在「…第 1 版做的 6 步」下面，和 9.3 节说的一样。展开是工具名「查供应商电话和评分（routine.supplier_contact）」、输入 `{"p1": …}`、输出全文。
  - 脚本调的：「流程」「库流程」两个标签 +「流程『查供应商电话和评分』第 1 版 · 1 毫秒」，里面 6 步收在下面（每步带「流程」标签），输入是原名 `{"供应商全名": …}`；「跑完：6 步 · 8.2 秒 · 交回 …」是后面单独一行（见 18.3 第 4 条）。
  - 流程页：列表、详情、做什么、输入 / 交回表、要的工具、风险「只读」、谁在用、成绩都对。

### 18.3 发现的问题（第 1–4 条已修：025fa01；第 1 条 18.6 复测确认）

1. **agent 不信库流程交回的结果，又自己一家家核对，用库流程反而没变快**（3 遍都这样，第 2 件的主要原因）。**已修（025fa01）**：三条建议都做了：办成的工具结果写「做过的步骤」（`wait_any` 带等到的那一种的定位）和「交回的值……直接用，不要再打开页面核对一遍」（5.2）；系统提示加一句（4.2）；固化员规矩第 7 条要求 `evidence` 写出核对了什么。没用真模型重跑，是不是真的不再核对要等下一次验收。**复测（18.6，b90ef5e）：修好了**。3 遍 agent 都没有再打开详情页、没有再搜索（库流程之后 0 次 `/b/s/`、`/b/search`，0 次 `extract`），库流程之后只剩去提交页提交汇总：17.2 / 69.2 / 23.5 秒、7 / 16 / 8 次模型调用（上次 43.6 / 106.3 / 72.1 秒、18 / 30 / 23 次）；整遍模型调用 14 / 23 / 15 次（上次 25 / 37 / 30，对照组 34 / 32）。`plan.set` 里照旧写「核对每家确为全名一致」，但它是看工具结果里的依据、做过的步骤核对的，`run.finish` 的依据也照抄了「详情页标题与全名一致」。第 2 遍库流程之后多的 69 秒是提交汇总时不放心多行文字填没填对，又提交了一遍（18.6「还有的问题」第 3 条），和库流程无关。
   - 现象：6 次库流程都办成、交回的电话评分都对，agent 接着又打开 6 个详情页 `extract` 名称和表格（第 2 遍还按关键词搜了 6 次），每遍多 30–95 秒、12–25 次模型调用。agent 的 `plan.set` 第 2 步就是「核对每次结果，确认全名完全一致、别家不算」。
   - 原因：目标里写了「注意有名字相近的别家，要看准全名」。库流程其实核对过（等的是「标题是全名」的那一项），但办成时工具结果只有 summary、依据（「详情页表格读取到电话…」）和交回，看不出它核对过全名；系统提示（4.2）只说「比你一步步做快得多」，没说交回的结果可以直接用。
   - 建议：① 办成时的工具结果也列出做过的步骤（和停下时一样，一步一行，例如「5. wait_any → heading（标题是『…』）✓」），agent 看得到它是怎么拿到的；② 系统提示「固化好的流程」一节加一句「流程办成交回的结果是它在页面上读到、核对过的，直接用，不用再打开页面核对；要核对只看它的『依据』和步骤」；③ 固化员的规矩里要求 `evidence` 写出核对了什么（例如「详情页标题是『…』」），不只写读到的值。
2. **「什么时候用」的默认值不好用**：`preview` 没给 `summary` 时生成的说明里「什么时候用：打开供应商搜索页 http://…」，是步骤说明的第一行（照 4.2「默认取步骤说明的第一行」），说的是怎么做、不是什么时候用。这次是发布时人填了才没事。建议默认用流程的名字（`routine_versions.name`，这次是「查供应商电话和评分」）或来源任务的标题，发布弹窗里提示要改。**已修（025fa01）**：照建议（shared 的 `defaultLibrarySummary`，`preview` 和发布弹窗都用），弹窗说明提示改成「要……时用」。
3. **给别的任务看的说明里带着来源任务的话**：「做什么」第 2 步「按派活的『供应商全名』…」、第 6 步「通过 work_report 交回电话和评分，并 finish 报办成」，进了库流程的工具说明，给选用它的任务的 agent 看。在别的任务里没有「派活」，`work_report` / `finish` 也只是收进交回值。输入、交回表也都没有说明（「供应商全名 —」），可来源任务声明参数时写了「要查的供应商的全名」，结果写了「供应商详情页上的电话」：固化员写的 `inputSchema` 只有 `type`，没带说明。建议：① 被派任务的 `inputSchema` / `outputSchema` 的 `description` 由程序按声明的参数、结果补上（不靠模型）；② `routineToolDescription` 生成「做什么」时去掉提 `work_report`、`finish` 的那一步，或者固化员的规矩里写「步骤说明只写在页面上做了什么，不写交回、报结果」。**已修（025fa01）**：两条都做了，② 的两种也都做了（4.2 的 `libraryDescriptionSteps`，「派活的『X』」改成「输入的『X』」；固化员规矩第 13 条）。① 固化时补进存的那一版，以前的版本在发布、改名字、详情、冻快照时按来源任务现在的声明补（第 3 节）。
4. **界面：脚本里调的库流程，那一行的用时是「1 毫秒 / 0 毫秒」，看不到结局**：进入那一步是 `inline`，记的是进入本身的用时；整个调用的步数、用时、交回在后面单独一行「流程『…』跑完：6 步 · 8.2 秒 · 交回 …」，中间还可能夹着别的（第一次调用时「打开了 Chrome」夹在里面的步骤和「跑完」之间）。agent 调的那一行则是「8.2 秒」+ 下面一行结局。建议 `nestLibrary` 归组时把同一个 `callId` 的「跑完」那一条并进进入那一行：用时、结局照 agent 调的写法显示，「跑完」那一条不再单独占一行。**已修（025fa01）**：照建议（9.3），用演示数据截图看过 agent 调的、`code.run` 里调的、库流程里再调一层的三种。
5. **小的**：
   - 整件事固化的第 1 轮，固化员在字符串里写了真的换行（`.join("<换行>")`），程序检查报「Unterminated string constant」，第 2 轮好了；这一轮的原因记进了 `test_report.drafts`（edeb8ce 的修法管用）。
   - agent 一轮只调一次库流程，6 家要 6 轮。同一个浏览器上本来就只能一个一个跑，省的只是模型那几秒，不算问题；以后要省可以在系统提示里说「要查好几条时，一次回复里连着调」，先不做。

### 18.4 花费

`scripts/or-usage.sh` 开始 $2.2706，基准跑完 $2.4212（**$0.151**，和各次运行、固化记下的花费加起来对得上：两次固化 $0.085，6 次 agent 运行 $0.064，7 次脚本运行（含复核）$0.003）；收尾时 $2.4465，后面多的 $0.025 是同一把 key 上别处用的（开发服务只读了模型列表）。

### 18.5 基准自己的改动

- 新 `apps/server/test-browser/speed/library.bench.ts`：来源任务（可以被派、参数「供应商全名」）→ 人派一张让 agent 办 → 固化 → 审核 → 再派 3 张照脚本跑、转正式（没转成就直接写 `proven_at`，记一行 `manualProven`；这次没用上）→ 主管 `preview`、`publish` → 对照组 → 选用库流程的任务 → 固化整件事、照脚本跑。每次运行记用时、模型调用、`byTool`、库流程的工具调用（参数、结果第一行、用时）、`trace.library` / `libraryCall` 对不对得上、`routine_calls`；固化存脚本和材料。遍数用 `LIBRARY_BASELINE`（默认 2）、`LIBRARY_CALLER`（默认 3）、`SPEED_REPEAT`（默认 3）换。`vitest.speed.config.ts`、`speed-bench.sh` 不用改（`SPEED_FILE=library`）。
- 业务词检查（`conventions.md` 第 0 节）：产品代码（`apps/*/src`、`packages/*/src`）没有新命中；e7cbab5 新加的命中都在 `seed/routine-library-fixture.ts`（演示数据，检查本来就不算 `/seed/`）。新的基准文件有 12 行命中「供应商」：场景 B 的站点、目标本来就是查供应商（同 `site.ts`、`routine.bench.ts`、`speed.bench.ts`），来源任务、库流程的名字和参数名照它起的，是测试数据。

### 18.6 修复后复测（2026-10-28，b90ef5e）

18.3 第 1–4 条修好（025fa01）以后，在集成分支 b90ef5e 上用同一个基准复测。模型同上（执行、复核 `deepseek-v4.1-flash-1017`，固化 `deepseek-v4-pro`）。命令 `LIBRARY_BASELINE=0 SPEED_FILE=library scripts/speed-bench.sh x8-lib2 B 3`（不跑对照组，上次已有 2 遍），结果在 `.dev/speed/x8-lib2.jsonl`，两版脚本、材料在旁边（不进仓库）。来源任务、固化、审核、试用转正式、发布都重新做了（固化员规矩改了）。一遍跑完 17 分钟。跑的时候 1 分钟负载 2–6（不高）；第 2、3 遍各碰到 1、3 次「Cannot connect to API」重试（第 3 遍多 15 秒左右），用时只作参考。

**结果**

| 步骤 | 用时 | 模型调用 | 做对 | 花费 | 上次（18.1） |
|---|---|---|---|---|---|
| 来源任务 agent 查一家 | 83.8 秒 | 16 次 | 1/1 | $0.0037 | 28.0 秒、8 次。这次 agent 自己多搜了一次地名，确认名字相近的别家不是它（模型的随机，不是改动造成的） |
| 来源任务固化 | 247.1 秒 | — | — | $0.023 | 107.9 秒、1 轮、$0.041。这次 2 轮：第 1 轮 `inputSchema` / `outputSchema` 写成了「见任务声明」，程序检查报不是合法 JSON（下面「还有的问题」第 2 条） |
| 来源任务照脚本跑 3 张 | 8.6 / 11.4 / 9.3 秒 | 0 | 3/3 | $0.0005–0.0012 | 8.8–9.8 秒。都直接办成，第 3 张后程序自己转正式（`directStreak` 3） |
| **选用库流程：agent 查 6 家** | **82.4 / 138.9 / 112.7 秒** | **14 / 23 / 15 次** | 6/6 ×3 | $0.0040 / $0.0100 / $0.0050 | 108.8 / 186.9 / 135.1 秒，25 / 37 / 30 次，$0.006–0.015；对照组 97.7 / 92.0 秒、34 / 32 次 |
| 　其中最后一次库流程之后 | 17.2 / 69.2 / 23.5 秒 | 7 / 16 / 8 次 | — | — | 43.6 / 106.3 / 72.1 秒，18 / 30 / 23 次 |
| 整件事固化 | 72.1 秒 | — | — | $0.027 | 156.2 秒、2 轮、$0.044。这次 1 轮过，试跑同样停在第 50 步「提交汇总」前 |
| **整件事照脚本跑 3 遍** | **47.6 / 48.4 / 45.7 秒** | **0** | 6/6 ×3 | $0.0007–0.0008（只有复核） | 45.4–45.8 秒 |

输入 token：选用库流程的 3 遍 18.4 万 / 31.6 万 / 19.0 万（上次 34 / 59 / 42 万）。

**1. agent 信不信库流程交回的结果：信了**

| 遍 | 库流程之后又开的页面 | 其中详情页、搜索页 | `extract` | 库流程之后的模型调用 | 库流程之后的用时 |
|---|---|---|---|---|---|
| 1 | 提交页 1 次 + 点提交 1 次 | 0 | 0 | 7 | 17.2 秒 |
| 2 | 提交页 2 次 + 点提交 2 次（另点了一次输入框） | 0 | 0 | 16 | 69.2 秒 |
| 3 | 提交页 2 次 + 点提交 1 次 | 0 | 0 | 8 | 23.5 秒 |
| 上次 | 每遍 5–6 个详情页（第 2 遍另搜 6 次） | 5–12 | 5–6 | 18 / 30 / 23 | 43.6 / 106.3 / 72.1 秒 |

- 3 遍库流程之后都直接去提交页，没有一次 `navigate` 到详情页、搜索页（过程记录里库流程之外的浏览器调用逐条看过）。上次「提交汇总本身只要 10 秒左右、5–6 次」，第 1、3 遍基本就是这个数。
- 模型自己的话：这次模型几乎不写文字（只有第 3 遍一句「六家供应商的信息都已查到，现在前往提交页」）。`plan.set` 第 1、3 遍照旧写了「核对每家的结果确为全名一致（排除名字相近的）」——目标里那句「注意有名字相近的别家，要看准全名」还在，但这一步是拿工具结果里的「依据：详情页标题为『…』」和「6. wait_any → loaded（getByRole('heading', { name: '…' })）」核对的：`run.finish` 的依据写「流程从详情页读取、核对」「详情页标题与全名一致」，复核也照这个判办成。
- 第 2 遍多的 69 秒、16 次不在库流程：`fill_form` 往多行文本框填了 6 行、点了提交，之后不放心填进去的多行文字对不对，去看 `network_requests`、`file.list network/`，又重新打开提交页、用剪贴板粘贴、`clipboard_read` 读回核对、再提交一遍（站点收的是最后一次，6/6 对）；中间还有 1 次模型连接出错重试。见下面「还有的问题」第 3 条。
- 库流程那一段（开始到第 6 次库流程做完）65.2 / 69.7 / 89.2 秒，上次 63–81 秒：一样是一家一轮模型调用（3–6 秒）+ 一次库流程（6.9–9.0 秒）。第 3 遍多的主要是 3 次连接重试。
- 所以这次选用库流程的第 1 遍（82.4 秒、14 次）比对照组（92–98 秒、32–34 次）快、模型调用少一半多；第 3 遍去掉重试的 15 秒也在 100 秒内。用时上还是不明显快，原因同 18.1：这个站点库流程一家要开 3 个页面、7 秒，agent 自己查的路子也不长；省下的主要是模型调用（少 50% 以上）和输入 token。

**2. 工具结果**

- agent 调的 18 次都办成，工具结果都有「做过的步骤：」7 行、「交回的值是流程照上面的固定步骤从页面上读到的，流程里核对过，直接用，不要再打开页面核对一遍。」，最后一行是交回值的 JSON（逐条用程序检查过，18/18）。`wait_any` 的两行带上了等到的那一种和定位，例如「6. wait_any「loaded」 → loaded（getByRole('heading', { name: '义乌市晨光日用品有限公司' })） ✓」。
- 依据是固化员按新规矩写的：「详情页标题为『义乌市晨光日用品有限公司』，表格中电话行显示 0579-85512301，评分行显示 4.6」。

**3. 工具说明和发布**

- `preview` 没给 `summary` 时「什么时候用：查供应商电话和评分」，是流程名（上次是步骤说明的第一行）。
- 发布后的工具说明（`tools.description`）「做什么」7 步：打开搜索页、输入「供应商全名」、点搜索、等结果（没有就报办不成）、点全名一致的链接、等详情页标题、读表格。没有「派活的」「交回」「报结果」「work_report」「finish」——固化员存的 `description` 本身就没写交回那一步（规矩第 13 条管用），不是靠 `libraryDescriptionSteps` 删的。
- 输入「p1（供应商全名）：要查的供应商的全名（必填）」，交回「电话：供应商详情页上的电话」「评分：供应商详情页上的评分」，都是来源任务声明的说明；存的那一版 `inputSchema` / `outputSchema` 也带着 `description`（上次只有 `type`）。

**4. 固化员的 evidence**

- 来源任务的脚本：`ha.finish` 的 `evidence` 是「详情页标题为『${name}』，表格中电话行显示 ${电话}，评分行显示 ${评分}」，写出了核对了什么（标题是全名），不是只写「查到了」。脚本也确实核对了：第 4 步 `waitAny` 等全名的链接（另有没结果、报错两种），第 6 步等名字是全名的标题。
- 小问题：读表格是按位置取的（`rows[1].值`、`rows[2].值`），没看那一行的表头是不是「电话」「评分」，evidence 里「电话行」「评分行」说得比脚本核对的多（「还有的问题」第 4 条）。
- 来源任务的路子这次是 7 步（上次 6 步，多了等搜索结果的 `waitAny`），agent 多做的那次地名搜索没抄进脚本。

**5. 整件事固化：还是 `ha.routine` 循环，没有变坏**

- 脚本是 `for (const name of suppliers)` 里 `await ha.routine("supplier_contact", { 供应商全名: name })`，先看 `r.outcome` 再用 `r.data`，6 家全名写死（任务没有输入，对）。上次固化员照抄了 agent 多做的核对（每次 `ha.routine` 后再 `extract` 详情页名称），这次 agent 没核对，脚本里也没有了；提交前有 `ha.commit("提交汇总")`，提交后 `waitAny` 等「汇总已提交」。
- 1 轮就过（上次 2 轮），72.1 秒、$0.027。
- 照脚本跑 3 遍 47.6 / 48.4 / 45.7 秒（上次 45.4–45.8），0 次模型调用，6/6，复核都判办成。每遍 53 步：6 次 `ha.routine`，里面各 7 步（上次里面 6 步 + 外面 6 次核对 `extract`），6 次库流程各 6.9–8.5 秒。多出来的 0–3 秒在一家多一步 `waitAny` 和波动之内。
- 过程记录对得上：agent 调的 3 遍每遍 6 行带 `libraryCall`、42 步带 `library`，脚本调的每遍 12 行（进入 + 跑完）、42 步，`orphanInner`、`callsWithoutInner` 都是 0。`routine_calls` 36 行（18 `tool`、18 `script`）都 `achieved`、7 步；流程库成绩「36 次、办成 36、平均 7.4 秒」，`fail_streak` 0。

**6. 业务词检查**（`conventions.md` 第 0 节）：产品代码（`apps/*/src`、`packages/*/src`，去掉 `/seed/`、`/demo-data/`）只有 `apps/web/src/pages/tasks/data.ts` 两行，是 M0 起就有的界面举例；025fa01 新加的命中只在 `seed/routine-library-fixture.ts`（演示数据）。这次基准的改动没有新命中。

**还有的问题**（第 2–4 条已修：e017163，合 main 前；没用真模型重跑）

1. **18.3 第 1 条：已经好了**，见上面第 1 件。
2. **固化员把 `inputSchema` / `outputSchema` 写成「见任务声明」**（来源任务固化第 1 轮）：被派任务的提示词写「inputSchema = 声明的参数」，模型照字面写了这几个字，程序检查报不是合法 JSON，多一轮（这次固化 247 秒里大约一半）。被派任务的这两个 schema 程序本来就能按声明生成（025fa01 已经按声明补说明）。建议：被派的任务由程序按声明直接生成 `inputSchema` / `outputSchema`（固化员写的只拿来对照，或者不让它写）；至少提示词里写明「写完整的 JSON，不能写『见任务声明』这类话」。**已修（e017163）**：被派的来源任务，`checks.ts` 的 `declaredRoutineSchemas` 照声明直接生成：输入 = 声明的参数（都是 string，带声明的说明，必填的进 `required`，顺序记 `x-order`），交回 = 声明的结果（带说明，必交的进 `required`）；固化员写的只取交回值的类型（string、number、integer、boolean）和 `$attachments` / `$note`（没写、原来那次的输入里有的补上，可选）。写成一句话、空着、写错、漏了都不算没过，存下的以程序生成的为准（`compile.ts` 不再用 `withDeclaredDescriptions` 补）。提示词（`inputSchema` / `outputSchema` 字段说明、规矩第 6 条）和材料里「声明的参数」「要交回的结果」两行写明「由程序照它生成，不用写」。测试：`routine-compile.test.ts`「被派的任务：两个格式由程序照声明生成」（四种写法结果都等于声明、多个参数的顺序、类型照固化员的、补附件）和「固化员把两个格式写成『见任务声明』、空着：不多跑一轮」（第 1 轮就进试跑，模型只调一次）。
3. **agent 不放心 `fill_form` 往多行文本框填的内容，又提交了一遍**（第 2 遍，库流程之后的 69 秒主要在这）：`fill_form` 的结果只有「现在的页面：…」，看不到填进去的是什么，agent 去翻 `network_requests`、`network/` 文件，再用剪贴板重填、读回核对后又提交一次。这次站点收最后一次，没出错；但会改东西的表单重复提交就是问题。和库流程无关，是浏览器工具的通用问题。建议（另派人看）：`fill_form` 填多行文字时结果里回显每个字段实际的值（截短），或者系统提示里说「填完看快照里那个输入框的值就行，提交过的不要再提交」。**已修（e017163）**：两条都做了。`fill_form` 是 Playwright MCP 的工具，我们在 `browser/tools.ts` 调完以后用编排器自己的连接读回来（`browser/form-readback.ts`）：字段的定位用这次录下的代码（一个字段一行），对不上时 `target` 是选择器的照它找；输入框读 value（多行、首尾空格用 JSON 写法看得出）、下拉框读选中的文字、勾选框和单选读勾没勾，和要填的不一样的标「和要填的不一样」，每个值最多 300 字；密码框（`type=password`、`autocomplete` 是密码）、名字像密钥的（密码、口令、密钥、令牌、验证码、token、secret、api key……）、用了 `{{password}}` 占位符的只写「已填（密码类，不显示）」；读不了的写「读不出来」，不报错。浏览器一节的系统提示加两句：`fill_form` 的输出里有实际填进去的值；提交以后先看页面给的结果（成功或出错的提示），没有明确失败的不要再提交一遍，会改数据的表单提交两次可能办两次。测试：`test/form-readback.test.ts`（假页面：定位、各种字段、打码、对不上、截短），`test-browser/script-tools.test.ts`「browser.fill_form 读回实际的值」（真 Chrome：多行文字、被页面改成大写的、下拉、勾选、密码框）。
4. **（小）evidence 比脚本核对的多一点**：来源任务的脚本按位置读表格第 2、3 行，evidence 却写「电话行」「评分行」。这次站点的表格行序固定，结果都对；换了行序会读错，evidence 还会说「电话行显示…」，调用它的 agent 照信。建议固化员规矩第 7 条补一句「evidence 只写脚本真的核对过的」，读表格时按表头取值，或者在脚本里核对那一行的表头。**已修（e017163）**：第 7 条补了两句（evidence 只写脚本真的核对过的，没在脚本里比过的不要写成核对过；读表格按表头文字找对应的列或行，不按第几行第几列：一行一个字段的表把名和值都读出来按名找，多列的表先读表头核对第几列，对不上 `ha.fail("page")`）。例 1 改成先读表头核对「状态」「更新时间」两列、再核对第 1 行的单号，evidence 写「第 1 行的单号是…，『状态』一栏是…」。SDK 说明（`sandbox-sdk/heyagent/index.d.ts` 的 `extract`、提示词里的内置说明）加同样的读表格写法。
5. **用时**：同 18.1，这个站点上库流程一家 7 秒（6 秒在等 3 次开页面），agent 用库流程省的主要是模型调用和 token，不是用时；固化成整件事的脚本（46–48 秒）才是真快。

**花费**：`scripts/or-usage.sh` 开始 $2.5490，结束 $2.6264，**$0.077**（和记下的加起来对得上：两次固化 $0.051，4 次 agent 运行 $0.023，6 次脚本运行（含复核）$0.004）。

**基准的改动**：`library.bench.ts` 每次运行多记 `afterLibrary`（最后一次 agent 调库流程之后的用时、模型调用、各工具次数、又开的页面、`extract` 次数、模型说的话）和 `firstLibraryOutput`（第一次库流程调用的完整工具结果）；发布后多记一行 `tool-row`（选用它的任务看到的工具说明）。`speed-bench.sh` 把 `LIBRARY_BASELINE`、`LIBRARY_CALLER` 传进容器（以前没传，设了也不管用），`LIBRARY_BASELINE=0` 不跑对照组。
