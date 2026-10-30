# 任务的结构图和「交付物」（2026-10-30）

> 用户 2026-10-30 定的设计稿 C（`.dev/task-structure-design/project/Wide.dc.html`，详情卡 `Detail.dc.html`）：任务抽屉太挤，照 agent 主循环把任务画成一张图，点哪一块就说明哪一块。同时给任务加一个新字段「交付物」。

## 1. 交付物（`deliverables`）

- 是什么：这个任务每次运行要交出来的东西，一项一个名字加说明，例如「工厂比价表.xlsx：5 家工厂的单价、起订量、交期、链接」「推荐的一家和理由」。可以一项都不写。
- 和派活的「要交回的结果」（`dispatch.results`）不是一回事：那是被派的活用「报结果」（`work.report`）交回派活单的字段；交付物是这次运行本身要交的东西（文件、结论）。两样可以同时有。
- 类型（`packages/shared`）：`taskDeliverableSchema`（`schemas.ts`，`TaskDef.deliverables`，读出来一定是数组）；输入 `taskDeliverableInputSchema`（`config.ts`）：名字去掉首尾空白、1～100 字，说明最多 500 字，最多 20 项；`taskInputSchema.deliverables` 不传 = `[]`。`tasks.update` 是整体替换，前端、助手都要带上原来的值。
- 库：迁移 `0038_task_deliverables.sql`，`tasks.deliverables jsonb NOT NULL DEFAULT '[]'`（加了 `IF NOT EXISTS`），以前的任务都是空数组。
- 运行快照：`snapshot.task.deliverables`（有才写；加这个字段以前开始的运行、子运行没有）。子运行只做自己的子目标，`deriveSubSnapshot` 不带父任务的交付物。
- 执行 agent 的系统提示（`engine/prompt.ts`）：目标后面多一节「## 要交付的东西」（`deliverableLines` 一项一行），要求最后的总结逐项写明每一样在哪、交不出来的写清哪一项和原因；「怎么工作」里加一句结束前对照着逐项检查，缺一项就是没办成。
- 复核（`engine/review.ts`）：输入里目标后面加「## 要交付的东西（……逐项核对：缺一项就判 not_achieved）」；复核员的说明加一条：逐项在文件、交回的结果、报告里找证据，缺一项、或者只在报告里说了证据里找不到，判 not_achieved。
- 三方验收（`engine/verify.ts`）：输入里同样列出交付物，缺一项总结论不能是 pass。
- 编辑：任务弹窗「目标」下面一组「交付物（可以不写）」，每项名字 + 说明 + 删除，「加一项交付物」（最多 20 项）。
- 助手：`create_task` / `update_task` 认 `deliverables`（提示词里写了用法），确认卡上显示「交付物」改前改后；`get_task` 照样返回。导入建的任务没有交付物（`[]`）。

## 2. 结构图（任务抽屉）

- 抽屉头部一个「结构图 / 列表」切换（`ToggleGroup`），默认结构图；选了什么记在浏览器的 `localStorage`（键 `heyagent.taskView`，读写包了 try/catch，存不了就只在这次打开里记着）。只在看任务详情时显示；看某次运行、某张派活单时还是原来的样子和宽度。
- 「列表」就是原来的分区卡，只多了一张「交付物」卡（另有「交回」一行，被派的任务才有）。
- 「结构图」（`apps/web/src/pages/tasks/task-structure.tsx`）：
  - 十二块：什么时候跑（开工）、目标（起点）、agent 循环里的模型和步骤、交付物（终点）、验收和复核；循环上面「带进提示词」的记忆、技能、规则、附件，下面「能伸出去的手」的工具、固化流程。每块一句摘要（数量、名字），没选的写灰字「没选」「没有」，所有块一直在，图的样子不变。
  - 点一块，详情栏写：名字和角色、「它是什么」（照现在系统真的怎么做写的，见代码里的 `INFO`）、「这个任务里」（直接用列表视图的那批区块：`task-config.tsx` 的小块、`TaskScheduleSection`、`DispatchInSection`、`TaskMemorySection`、`TaskRoutineSection`、`TaskAttachments`、`DispatchOutSection`），列表里有的这里都看得到；最后是改的入口（负责人和主管：打开编辑任务）和去对应页面的链接。
  - 宽屏（`lg` 起）抽屉加宽到 `lg:max-w-6xl`、`xl:max-w-7xl`，图横着画，详情栏在右边；窄一些（900 px 左右）竖着排（开工 → 目标 → 循环三栏 → 交付物 + 复核），详情在图下面；手机宽度点一块从底部弹出详情（`Sheet side="bottom"`）。
  - 块是 `Item`（`outline`）渲染成 `<button>`，`aria-pressed` 标选中，选中的 `border-primary bg-primary/10`；连线是 `w-px` 的竖线（实线 `bg-border`、虚线 `border-dashed`）和 lucide 的箭头。登记在 `docs/ui-rules.md` 第 8 节。
- 列表、结构图共用的小块搬到了 `task-config.tsx`（步骤、交付物、模型、验收和复核、记忆、技能、工具、流程、规则、浏览器、桌面、派出去的活），`task-detail.tsx` 只剩抽屉底部的操作和列表视图。

## 3. 测试

- `apps/server/test/task-deliverables.test.ts`：schema 默认空、校验；`tasks.create` / `update` / `get` 来回一致、旧任务是空数组；系统提示有没有「要交付的东西」；子快照不带；真跑一次（假模型）：快照冻进、执行 agent 和复核模型的输入都逐项列出。
- 界面：私有库 + 私有端口起 API 和 Vite，用 worker 镜像里的 Chrome 截图看过宽屏深色 / 浅色、详情栏、列表、900 px 竖排、手机底部弹出。
