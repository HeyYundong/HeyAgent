# 右下角助手（开发说明，2026-10-19）

> **状态：已完成（2026-10-19）。** 实现和联调记录在文末。 用户 2026-10-19 回复「全部按建议」：第 7 节 7 个问题全部按建议。开发细节见第 9 节。
> 和第 2 节不同的一处：不另出 `design/` 原型等确认，面板只用 registry 组件、改动小，直接写正式代码，做完用截图给用户看。
> 用户原话（2026-10-19）：「我希望可以在右下角添加一个机器人，帮我修改任务，待办，记忆，技能等等。而不是让我人工去修改。」
> 文中写「现在」的，都是读 main（99a5bd5）的代码确认过的。

## 0. 一页纸

控制台每一页的右下角放一个「助手」按钮，点开是一个对话框。用中文说要**新建、修改或删除**什么，助手查清楚、列出要做的改动，你点「应用」后它去做，再告诉你做了哪些。

例子（新建）：
- 「新建一个任务：每天早上 9 点检查昨天的新订单，有异常就通知我，用 Chrome『公司后台』」——助手照任务弹窗的字段填好标题、步骤、定时、工具，列成确认卡
- 「新建一个技能，教 agent 怎么导出订单表，内容照这段写：……」
- 「把下面这几条经验记成记忆：……」（一次建好几条）
- 「建一条规则：发邮件前必须先让我确认」（照规则的「翻译 → 确认」走）
- 「建一个任务，用刚才那个技能」（先建技能、再建任务挂上它，一轮做完）

例子（修改）：
- 「把『每日巡检』的定时改成每天早上 9 点，模型换成便宜一点的」
- 「给这个任务加一条记忆：报价单里的价格都是含税的」（在任务详情页里说「这个任务」，助手知道是哪个）
- 「把待办里『核对发票』那张改到明天早上 9 点」
- 「哪些任务还在用旧的模型？都换成默认的」

**最要你拍板的 3 件事**（第 7 节）：
1. 改之前要不要**先给你看、你点了才改**（问题 1）；
2. 第一期**能改哪些东西**（问题 2）；
3. 对话**要不要保存**、换页 / 刷新后还在不在（问题 4）。

---

## 1. 现在有什么、缺什么

- **改数据的函数现成**：每种配置的增删改都在 `apps/server/src/data/config/*.ts`（任务、任务记忆、待办、记忆、技能、规则……），里面已经做了权限检查（`assertCan`）、事务和审计（`audit`）。助手的工具直接调这些函数，**以当前登录的人的身份**，所以员工通过助手也只能改自己本来就能改的东西。
- **改完页面自己会刷新**：数据库触发器 + `LiveSync`，助手改了任务，开着的任务页马上更新，不用另外处理。
- **调模型现成**：`engine/model.ts` 的 `resolveModel`，支持 OpenRouter、Claude、OpenAI、DeepSeek 直连。
- **缺的**：
  - 现在没有任何工具能让模型直接改任务、待办、记忆、技能（agent 只能「建议」记忆和技能，人审核）。助手的工具是新写的，见第 3 节。
  - 现在调模型都不是流式的。助手要边想边显示，后端新加一个流式接口（AI SDK 的 `streamText`），见第 4 节。
  - 前端没有聊天滚动容器 `message-scroller`，要用 `npx shadcn@latest add message-scroller` 加进来（registry 里有，不算例外）。

## 2. 界面

- **按钮**：每一页右下角一个圆形的 `Button`（`icon-lg`，lucide `BotIcon`），登录后才有。挂在 `App.tsx` 里 `<LiveSync/>` 旁边。
- **对话框**：点开后在右下角弹出一个约 `w-96`、`h-160` 的面板，不挡整页，可以一边看页面一边说。面板是 `Card`（标题栏：「助手」+ 新对话 + 收起），里面：
  - 对话：`MessageScroller` + `Message` + `Bubble`，助手的回答用已登记的 `MarkdownView` 显示；
  - 查了什么、改了什么：`Trace`（每次工具调用一行，可以展开看细节）；
  - **改动确认卡**（问题 1）：`Item` 列出这一轮要改的每一项（「任务『每日巡检』：定时 每小时 → 每天 09:00」），底下「应用」「不要」两个按钮；有删除的，「应用」是 `destructive` 并写明「会删除 N 项」；
  - 输入框：`InputGroup` + `InputGroupTextarea` + 发送按钮，回车发送、Shift+回车换行。
- 面板固定在右下角这件事，registry 里没有现成的「浮动面板」，用 `Card` 加 `fixed bottom-4 right-4` 定位。只是定位，不改组件外观，按第 6 节「先做后报」登记。
- 窄屏（手机）：面板改成全屏的 `Sheet`。
- 正式写之前，先在 `design/` 出一版原型给你看（照惯例）。

## 3. 助手能用的工具

全部以当前登录的人的身份调用 `data/config/*.ts` / `data/loaders.ts` 里现有的函数，不绕过权限。

| 类别 | 查（直接查） | 改（问题 1：先确认） |
|---|---|---|
| 任务 | 列任务、看一个任务的详情 | **新建**（标题、说明、步骤、定时、模型、工具、技能、Chrome 一次填好）、修改（标题、说明、步骤、定时、模型、工具、技能……）、启用 / 停用、删除 |
| 任务记忆 | 看一个任务的记忆 | 加、改、删 |
| 待办 | 看待办看板 | 新建、修改（标题、说明、日期、指派、状态）、删除 |
| 记忆（全局） | 列记忆 | 新建、修改、归档、删除；待审核的通过 / 驳回 |
| 技能 | 列技能、读 SKILL.md | 新建、修改内容、启用 / 停用；agent 建议的采纳 / 拒绝 |
| 规则 | 列规则 | 新建、修改、删除。规则本来就要「翻译 → 你确认」两步，助手照这个走：先翻译，把「系统理解为」放进确认卡 |
| 工具 | 列工具 | 新建、修改 HTTP / MCP 工具配置，不碰密钥（问题 2） |
| 其他（只读） | 模型列表、浏览器列表、最近的运行 | 第一期不改 |

- 助手知道你**现在在哪一页、选中了哪一项**（前端每次发消息时带上当前路由和选中的 id），所以可以说「这个任务」「这条记忆」。
- 一次请求最多 20 步工具调用、最多花 $0.20（问题 5），到了就停下来告诉你。
- 系统提示里只讲平台的概念和每个字段的意思，**不写任何业务**（开发约定第 0 节）。

## 4. 后端

- **接口**：`POST /api/assistant/chat`（Hono 路由，登录校验同 `/api/trpc/*`），返回 SSE 流：文字片段、工具调用开始 / 结束、改动确认卡、结束（用了多少钱）。
- **一轮怎么跑**：`resolveModel` + `streamText`。查的工具直接执行；改的工具**不执行**，记成「待确认的改动」，这一轮停下，把确认卡发给前端。你点「应用」→ `POST /api/assistant/apply`，按顺序执行，结果（包括新建出来的编号）交回给模型，模型接着往下做（比如先建技能、再把技能挂到任务上），再总结。点「不要」→ 告诉模型你没同意，它会问你要怎么改。
- 确认卡上的改动在服务器上存着，前端只传卡的编号，不能被改了内容再提交。
- **模型**：用模型页的「plan」默认模型（和导入一样），面板标题栏可以临时换（问题 3）。
- **审计**：每次改动照常写审计，`detail` 里加 `via: "assistant"`，审计里看得出是助手改的。
- **对话保存**（问题 4）：新表 `assistant_chats`（人、标题、时间）和 `assistant_messages`（按 AI SDK 的消息格式存），迁移 `0020`。

## 5. 不做的

- 不让助手跑任务、取消运行、处理「要人办的事」（这些按钮本来就一下就点完；以后要再加）。
- 不让助手看或改密钥、账号密码、用户、系统设置。
- 不做语音。

## 6. 分包和工作量

监工先写骨架（shared 里的消息 / 改动卡的 schema、迁移、接口桩、原型），然后后端、前端各交给一个子 agent（Opus 5.5 high），监工审代码、真模型联调（用 OpenRouter 便宜模型，预计 < $1）。整体约 2 个工作日。

## 7. 需要你拍板的问题

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | 助手改东西之前要不要**先给你看、点「应用」才改** | **要**。查直接查，改先列成确认卡，一轮的改动一次确认。删除写明「会删除 N 项」、按钮是红色的。以后用顺了可以加一个「小改动不用问」的开关 |
| 2 | 第一期能新建 / 改 / 删哪些 | 第 3 节表里的：**任务、任务记忆、待办、记忆、技能、规则**，每种都能新建（用户 2026-10-19 补充「还能新加任务，技能等等」）。工具（HTTP / MCP 配置）要不要也能让助手新建？建议**第一期也做**，但不碰密钥：要密钥的，助手建好工具后提醒你去工具页填。模型、浏览器只读 |
| 3 | 用哪个模型 | 模型页的 **plan 默认模型**，面板上可以临时换。不新加「助手」这个默认角色 |
| 4 | 对话保存吗 | **保存**，每个人只看到自己的。换页、刷新还在；「新对话」开一段新的，以前的在面板里的历史里能翻到，保留最近 50 段 |
| 5 | 一次请求的上限 | **20 步、$0.20**，到了停下说明。设置页能改 |
| 6 | 员工（不是主管）能不能用 | **能**，但只能做自己本来就能做的：改自己的任务、给自己的任务建待办、改自己建的待办。**新建任务、记忆、技能、规则现在只有主管能做**（`permissions.ts`），助手不改这条，员工让它新建时会直接说「这个要主管来建」 |
| 7 | 按钮叫什么、什么图标 | 「助手」，lucide `BotIcon`。要用山羊 logo 也可以 |

---

## 9. 开发（2026-10-19 开工）

### 9.1 已定

第 7 节全部按建议：先确认再改；能新建 / 改 / 删任务、任务记忆、待办、记忆、技能、规则，外加 HTTP / MCP 工具配置（不碰密钥）；plan 默认模型、面板上可临时换；对话保存，每人最近 50 段；一次请求 20 步、$0.20，设置页能改；员工能用但只能做本来就能做的；叫「助手」、`BotIcon`。

### 9.2 骨架（监工已经写好，两个包都照它）

- `packages/shared/src/assistant.ts`：请求（`assistantChatInputSchema`、`assistantApplyInputSchema`、`assistantPageContextSchema`）、改动确认卡（`assistantProposalSchema` / `assistantChangeSchema`）、面板记录（`assistantEntrySchema`）、对话（`assistantChatSchema` / `assistantChatSummarySchema`）、流式事件（`assistantStreamEventSchema`）、设置（`settingsAssistantInputSchema`）。
- `packages/shared/src/config.ts`：`SETTING_KEYS.assistantMaxSteps` / `assistantMaxCostUsd`，默认 20 / 0.2；`settingsViewSchema.assistant`（可选）。
- `apps/server/src/db/schema.ts` 末尾：`assistant_chats`、`assistant_messages`、`assistant_proposals`；迁移 `drizzle/0020_assistant.sql`。这三张表**不加** NOTIFY 触发器：面板靠自己的流更新，只有本人看。

### 9.3 包 A（后端，`apps/server/src/assistant/`）

**接口**（`routes.ts`，`registerAssistantRoutes(app, { db, auth })` 挂进 `app.ts`）：
- `POST /api/assistant/chat`，body = `assistantChatInput`。登录校验照 `engine/http.ts` 的写法，没登录 401。返回 `text/event-stream`，每条 `data: <AssistantStreamEvent JSON>\n\n`，顺序：`chat` → `entry`(user) → 若干 `entry` / `delta` / `update` → `done`。出错发 `error` 后结束。
- `POST /api/assistant/apply`，body = `assistantApplyInput`。卡不是本人的、不是 pending：发 `error`。应用：按 `calls` 顺序一项项执行（**每项单独成败**，一项失败不回滚别的），每项结果写回 `changes[i].result`，发 `update`(proposal)；再把每项结果作为 tool-result 消息存进历史，接着跑模型。不要：所有调用回 `{ rejected: true, note }` 的 tool-result，接着跑模型（它会问人要怎么改）。
- 发新消息时，对话里还有 pending 的卡：卡记 `expired`，它的调用回 `{ expired: true }` 的 tool-result，再接上新消息（AI SDK 要求每个 tool-call 都有 result）。
- 断线（请求被浏览器中止）时停掉模型调用，已经存下的照常保留。

**tRPC**（`assistant` 路由，挂进 `trpc/router.ts`）：`chats`（本人最近 50 段的摘要）、`get({ id })` → `AssistantChat`（由消息历史 + 卡拼出 entries）、`delete({ id })`。`settings.updateAssistant` + `settings.get` 带上 `assistant`（照 `updateDispatch` 的写法，只有主管能改）。

**一轮怎么跑**（`run.ts`）：
- 模型：输入里的 `modelId` → 对话上次的 → `model_defaults` 的 plan（要 `kind = chat`，照 `imports/service.ts` 的 `pickReadModel`）。都没有：发 notice「还没有配模型，先到模型页设 plan 默认模型」。
- `resolveModel` + AI SDK `streamText`（`providerOptionsFor` 照用），`stopWhen` 用步数上限；每步算钱（`costOf`），累计超过上限就停下，发 notice「这次已经花了 $x，到上限停下了，要继续就再说一句」。步数到上限同样。模型调用照 `imports/reader.ts` 的 `callWithRetry` 重试可重试的错误。
- 查的工具带 `execute`，直接执行。写的工具**不带 execute**：这一步有写工具调用时，流结束后把这一步的写调用存成一张卡（`calls` + `changes`），发 `entry`(proposal) 和 `done`(`pendingProposalId`)，停。同一步里的查调用照常执行、照常有结果。
- 每条 ModelMessage 存进 `assistant_messages`（seq 递增）；对话 `cost_usd` 累加，`updated_at` 更新；新对话的标题是第一条消息的前 30 个字；新建对话后每人只留最近 50 段。
- **系统提示**（`prompt.ts`）：讲平台的概念（任务、步骤 / 检查点、定时、任务记忆、全局记忆、技能、规则、工具、待办、运行）和每个写工具的字段，人现在所在的页面和选中项（`context`，把 `page` / `params` 翻成「人正在看任务 T-12」这样一句），今天的日期和时区（`TIME_ZONE`）。规则：先查清楚再改，不猜 id；一次要改的放在同一步里调（一张卡确认完）；需要上一步结果的（例如先建技能、再挂到任务上）分两步，人会确认两次；没权限、字段不对的报错原样告诉人；不会做的（跑任务、改密钥、用户、设置）直接说。**不写任何业务**（开发约定第 0 节）。用中文回答，简短。

**工具**（`tools.ts`）：模型看到的名字用 snake_case，每个都有中文 `label`（Trace 上显示）。全部以 `WriteCtx { db, actor: 当前用户, keyring }` 调现有函数，不绕过权限。

| 查（有 execute） | 调的函数 |
|---|---|
| `list_tasks`、`get_task`（含步骤、定时、模型、挂的记忆 / 技能 / 工具 / 规则、Chrome） | `data/loaders.ts` 的 `listTasks` 等 |
| `list_task_memory({ taskId })` | `listTaskMemory` |
| `list_todos` | `todos.board` 用的 loader |
| `list_memories`、`list_skills`、`get_skill`（含 SKILL.md 全文）、`list_rules`、`list_tools` | 对应 loader |
| `list_models`、`list_browsers`、`list_sessions`（最近 20 次运行，可按任务筛） | 对应 loader |

| 写（没有 execute，进确认卡） | 应用时调的函数 |
|---|---|
| `create_task`、`update_task`（**只传要改的字段**，应用时读出现在的任务合并成完整 `TaskInput` 再调 `updateTask`）、`set_task_enabled`、`delete_task` | `data/config/tasks.ts` |
| `add_task_memory`、`update_task_memory`、`delete_task_memory` | `task-memory.ts` |
| `create_todo`、`update_todo`（同样只传要改的）、`delete_todo` | `todos.ts` |
| `create_memory`、`update_memory`、`approve_memory`、`reject_memory`、`archive_memory`、`delete_memory` | `memories.ts` |
| `create_skill`、`update_skill`、`set_skill_status`、`accept_skill_suggestion`、`reject_skill_suggestion` | `skills.ts` |
| `create_rule`、`update_rule`、`delete_rule` | `rules.ts`。**出卡时**先调 `compileRule` 翻译（花的钱算进这次请求），把「系统理解为」写进卡的 fields；应用时建好规则并带上翻译结果、直接 `confirm`（人点「应用」就是确认）。翻译失败：这项不进卡，错误作为 tool-result 交回模型 |
| `create_http_tool`、`update_http_tool`、`create_mcp_server`、`update_mcp_server` | `tools.ts`。输入里没有密钥值，只能引用密钥名字；引用的密钥不存在时照 `allowMissingSecrets` 建，结果里写「到工具页填密钥『xx』」 |

- 写工具的输入 schema 尽量复用 `config.ts` 里的（`taskInputSchema` 等）；`update_*` 用 `.partial()` 加 id。模型给的输入先用 zod 校验，**校验不过的不进卡**，错误直接作为 tool-result 交回模型（让它改了重调）。
- **出卡时**每项用 `can()` 预先查权限（能查的就查，例如员工新建任务），没权限的不进卡，「你没有权限：……」交回模型。一张卡一项都不剩就不出卡，模型接着跑。
- 卡上每项的 `title` / `fields`（`describe.ts`）：新建列主要字段（标题、定时用 `cron-text` 翻成中文、模型名、挂的技能名……）；修改只列变了的字段，改前读库里现在的值；删除写明删什么、被谁用着（`tasksUsingRef`）。`destructive`：delete / archive / reject。`result.link`：建好或改好后能跳过去的页面（例如 `{ page: "tasks", params: { id } }`）。
- **审计看得出是助手改的**：`common.ts` 的 `audit()` 用 `AsyncLocalStorage` 读「正在由助手执行」的上下文，有就在 `detail` 里加 `via: "assistant", chatId`。助手应用改动时包在这个上下文里跑。其余调用方不用改。

**测试**（`apps/server/test/assistant.test.ts`，用 `runtime.modelFactory` 的假模型）：发消息 → 查工具执行 → 写工具出卡、不改库 → 应用 → 库变了、审计有 `via`、模型拿到结果接着说；不要 → 库没变；新消息让旧卡 expired；员工新建任务不进卡；update_task 只改给的字段；规则出卡时翻译、应用后已确认；超步数 / 超钱停下有 notice；`assistant.get` 拼出的 entries 和流里发的一致；只看得到自己的对话。

### 9.4 包 B（前端，`apps/web/src/components/assistant/`）

- `npx shadcn@latest add message-scroller`（registry 有，不改它）。
- 挂载：`App.tsx` 的 `<LiveSync />` 旁边放 `<AssistantWidget />`。
- **按钮**：右下角 `fixed bottom-4 right-4 z-50`，`Button` `size="icon-lg"`、`BotIcon`、`rounded-full`（圆形元素）。面板开着时按钮藏起来。
- **面板**：`Card`，`fixed bottom-4 right-4 z-50 w-96 h-160`（窄屏改用 `Sheet side="bottom"` 全屏，`useIsMobile`）。标题栏（`CardHeader` + `CardAction`）：「助手」、模型（`ModelCombobox`，默认显示对话的模型 / plan 默认）、历史（`DropdownMenu` 列最近的对话，点了打开；每项可删）、新对话、收起。开关状态和当前对话 id 记在 `localStorage`（try/catch），刷新后还在。
- **记录**：`MessageScroller` 里按 entries 显示：
  - user / assistant：`Message` + `Bubble`（人的靠右），assistant 文字用 `MarkdownView`；流式时文字一段段接上；
  - tool：`Trace` 一行（`TraceLine status`，running 有 shimmer），`TraceCollapsible` 展开看 detail（`CodeBlock` 或纯文字）；连续几个 tool 合在一个 Trace 里；
  - proposal：`Item` 列表，每项标题 + fields（`改前 → 改后`，before 用 `text-muted-foreground line-through`），底部「应用」「不要」。有 destructive 的：「应用」是 `variant="destructive"`，按钮文字「应用（会删除 N 项）」，不再弹 AlertDialog（卡本身就是确认）。点「不要」后可以在输入框补一句为什么（`note`）。应用后每项显示 ✓ / ✗ 和 message，有 link 的显示「去看看」链接；
  - notice：`Marker`（error 用 `Alert` destructive）。
- **输入**：`InputGroup` + `InputGroupTextarea` + 发送 `InputGroupButton`；回车发送、Shift+回车换行、输入法组字时回车不发送；请求进行中发送按钮变「停止」（`AbortController`）。有 pending 卡时输入框照常能用（发新消息 = 旧卡过期）。
- **空对话**：`Empty`，下面三四个示例句（`Button variant="outline" size="sm"`），点了填进输入框。
- **流**：`fetch` POST，读 `response.body`，按 `\n\n` 切开、`data:` 后 JSON，`assistantStreamEventSchema.safeParse`。`done` 后 `invalidateQueries(trpc.assistant.chats)`。业务页面不用管：改了库，`LiveSync` 会刷新。
- 发消息时带 `context: { page, params }`（`useRoute()`，params 转成普通对象）。
- **设置页**：加「助手」一组：一次最多几步、最多花多少美元（照「派活」一组的写法，`settings.updateAssistant`）。
- 只用主题 token、不写任意值、不手改 `ui/*`；暗色、亮色、窄屏都要看。登记进 `docs/ui-rules.md` 第 8 节（浮动面板的定位）。

### 9.5 环境

- 两个包在同一个 worktree（`worktree-copilot-brief`）里并行，A 只改 `apps/server`，B 只改 `apps/web`（子 agent 只能写监工所在的 worktree，原计划的各自 worktree 用不了）。`.env`：测试库 `heyagent_assist_a_test`（A），开发库 `heyagent_assist_b`（B）。端口：A 用 API 3121；B 用 API 3122 + Vite 5192。
- 真模型联调由监工做：OpenRouter 便宜模型，预算 < $1。

---

## 实现记录（2026-10-19）

**后端**（`apps/server/src/assistant/`）：`routes.ts`（两个 SSE 接口）、`run.ts`（一轮怎么跑、出卡、应用 / 不要 / 过期）、`tools.ts`（14 个查、27 个写）、`describe.ts`（卡上的文字、编号换名字）、`prompt.ts`、`store.ts`（对话、消息、卡；拼面板记录）。`trpc/assistant-router.ts`，`audit()` 用 `runAsAssistant` 带上 `via: "assistant"`。和第 9.3 节不同的地方：
1. 自己一步一步循环（每步一次 `streamText`，工具都不带 execute），不用 `stopWhen`：每步查花费、出卡就停、可重试、每步存库都在自己手里。
2. 工具输入自己用 zod 校验（`parseToolInput`）：SDK 校验会补 zod 默认值，`update_task` 没给的数组会被清空。
3. 提示（notice）也存进 `assistant_messages`（`role = notice`，不发给模型），刷新后还在。
4. 卡的 `calls` 多一个可选的 `prepared`（规则出卡时的翻译结果，应用时照用）。
5. `updateHttpTool` 多一个 `{ allowMissingSecrets }`，返回里多 `missing`（tRPC `tools.updateHttp` 也多一个 `missing: []`）。
6. 多一个查工具 `list_staff`（指派负责人、审核人要用）；助手不改任务的派活设置。
7. 待办只有数据模型里有的字段（任务、标题、什么时候），没有说明、指派、状态。
8. 应用的流也先发一条 `chat`。

**前端**（`apps/web/src/components/assistant/`）：`index.tsx`（按钮、面板 / 窄屏 Sheet、输入框）、`transcript.tsx`（`MessageScroller`，按需加载）、`proposal-card.tsx`、`history.tsx`、`use-assistant.ts`、`stream.ts`；设置页「助手」一组；`npx shadcn@latest add message-scroller`（新依赖 `@shadcn/react` 0.3.1）。和第 9.4 节不同：「以前的对话」用 `Popover`（每行要「打开」「删除」两个按钮，菜单项里放不了按钮）；「不要」在卡里展开一个小输入框写原因。

**监工联调时改的**：
- **模型编的编号**：真模型建技能时挂了一个不存在的工具编号 `mcp-playwright`，卡照出、点了「应用」才报「找不到」，模型再出一张。改成出卡时就查（`describe.ts` 的 `collectMissing`）：引用了库里没有的编号，这项不进卡，「找不到：工具 xx」交回模型。补了测试。
- **详情抽屉挡住面板**：任务、待办、图库等的详情是模态 `Sheet`，开着时点不了右下角；关上后 `?id` 没了，说「这个任务」不知道是哪个。不改页面，改成面板记着这一页上次带参数的地址（`use-assistant.ts`），关上抽屉再说「这个任务」就是刚才看的那个。
- **提示词**：回答里出现了字段名 `memoryIds` → 加「用界面上的叫法，不说字段名、工具名」；连跑两次建出两条一样的记忆 → 加「新建前先查有没有一样的，有就问要不要改那一条」。
- 空对话的示例句「把待办里明天到期的都指派给我」去掉（待办没有指派）。

**联调**（Claude Haiku 5.5 via OpenRouter，`test/assistant-real-e2e.ts`，全程约 $0.03）：新建技能 → 应用 → 库里有；同一段对话说「把刚才那个技能停用」→ 不要并说原因 → 没变、模型复述了原因；在任务页（`context = tasks?id=T-1036`）说「把这个任务改成每天早上 9 点」→ 卡上「不定时 → 每天 09:00」→ 应用；新建任务挂上刚建的技能、选便宜模型 → 建好、挂上了；三处改动的审计都带 `via = assistant`。界面上（worker 镜像的 Chrome）说「加两条全局记忆」→ 卡 → 应用 → 每项 ✓ 和「去看看」，记忆页自己刷新了，暗色、亮色都看过。再说一次同样的记忆 → 不出卡，指出已有两条一样的、问要不要归档一条。

**检查**：`pnpm typecheck`、`pnpm lint`、`pnpm --filter @heyagent/web build` 通过；服务端测试 22 个文件 332 个通过，`assistant.test.ts` 17 个通过；`docs/ui-rules.md` 第 7 节的检查和业务词检查没有新命中。

**没做 / 以后**：长对话不裁剪历史（越聊越长，花费跟着涨）；同一段对话一次只跑一个请求的锁在内存里（只有一个 API 进程时够用）；OpenAI 严格 JSON schema 模式下的可选字段没用真模型试过。
