# 记忆按内容自动挑选（开发说明，2026-10-28）

> **状态：设计稿，等监工审核。** 约定代码（类型、表结构、空壳）已经在这个分支上，功能还没写。
> 要做的：运行开始时，按这次要办的事从记忆库里自动挑出相关的几条，和手选的一起给 agent；人看得到这次自动挑了哪几条、相似度多少。
> v1 计划 1.3 写的「记忆多到选不过来时再加向量检索」、使用手册第 8 节的「记忆不会按内容自动挑选」，做完以后都要改。
> 文中写「现在」的，都是读 worktree-solidify-design（0d7652d）的代码确认过的。拿不准的地方写了推荐默认值，全文照默认值往下写，要定的事汇总在第 11 节。

## 0. 一页纸

| # | 做什么 | 一句话 |
|---|---|---|
| 1 | **记忆的向量** | 生效的记忆用图库那个 embedding 模型算成 1024 维向量，存 `memory_embeddings`（按模型分开，带内容的 md5）；后台补算，改了内容自动重算 |
| 2 | **挑** | 用「任务标题 + 目标 + 步骤 + 这次的说明 + 派活参数」当查询，在生效、不是手选、不是「来自网页」的记忆里按相似度挑，≥ 门槛的前 N 条 |
| 3 | **任务设置** | 「自动挑选记忆」开关（新任务默认开，已有任务迁移后是关的）+ 最多几条（默认 5） |
| 4 | **什么时候挑** | worker 进这次运行、建系统提示之前挑一次，写回快照；开始运行的事务里不调模型 |
| 5 | **给 agent** | 手选的照旧在「记忆（必须遵守）」；自动挑的另起一段「可能相关的记忆」，和这次的事无关就忽略 |
| 6 | **给人看** | 运行详情加「记忆」区块：手选 / 自动挑（相似度）/ 挑选情况；记忆页详情显示向量算没算好；任务弹窗加开关 |
| 7 | **没模型、出错** | 不挑，过程里写一句原因，运行照常，不报错 |

## 1. 现在的样子

- 记忆表 `memories`（`db/schema.ts`）：`content`（≤ 1000 字）、`applies_to`（「分类 · 对象」）、`status`（active / pending / rejected / archived）、来源、`web_unverified`、`last_used_at`。增删改在 `data/config/memories.ts`，助手（`assistant/tools.ts`）、导入（`imports/commit.ts` 用 `insertMemory`）、agent 提议（`memory.propose`）也会写。
- 任务选记忆：`task_memories` 关联表（`memoryIds`，带顺序）。
- 开始运行：`engine/sessions.ts` 的 `startSessionInTx` 在**调用方的事务**里调 `buildSnapshot`，把选上的、`active` 的记忆冻进 `snapshot.memories`，并给它们写 `lastUsedAt`。`startSessionInTx` 被手动运行、定时、待办、事件、派活（一个事务里开好几次）调用。
- 系统提示：`engine/prompt.ts` 的 `buildSystemPrompt` 每次进 `runSession`（`engine/loop.ts`）都按快照重建，记忆写成一段「## 记忆（人审核过的，必须遵守）」。
- 图库的 embedding（`docs/dev/gallery.md`）：`gallery/embed.ts` 的 `embed(db, modelId, inputs)` 走 OpenRouter `/embeddings`，`dimensions = 1024`，文字、图片都能算；测试用 `runtime.embedFactory` 给假向量。模型是 `model_defaults` 里 role = `embed` 的那个（模型页「图库的 embedding 模型」，要求能处理图片）。向量表 `gallery_embeddings` 主键 `(image_id, model_id)`，换模型新旧并存、全部算完才删旧的；后台循环在 API 进程（`gallery/background.ts`）。

## 2. 记忆的向量

### 2.1 用哪个模型

- **和图库共用一个**：`model_defaults` 的 `embed`。不加新的模型角色：记忆只有文字，能处理图片的 embedding 模型也能算文字；少一项配置。
- 模型页的标题改成「embedding 模型（图库、记忆共用）」，说明里加一句「记忆的自动挑选也用它」。
- 维数照图库，统一 1024（`MEMORY_EMBED_DIMENSIONS`，列类型 `vector(1024)` 写死，所以不单独存维数）。返回的维数不对，`embed()` 已经会报错。

### 2.2 存哪里

新表 `memory_embeddings`（迁移 0033）：

| 列 | 说明 |
|---|---|
| `memory_id` | 外键，删记忆时级联删 |
| `model_id` | 用哪个模型算的 |
| `content_hash` | `md5(适用于 + 换行 + 内容)`，算的时候记忆是什么样 |
| `embedding` | `vector(1024)` |
| `created_at` | |

- 主键 `(memory_id, model_id)`，`model_id` 上一个普通索引。
- **不建 HNSW**：记忆最多几千条，精确算一遍只要几毫秒；近似索引带着「生效、不是手选」这些条件时还可能漏结果。超过 5 万条再加。
- 不推实时（行里有向量，NOTIFY 太大，同图库）。`memories` 加两列 `embed_error`、`embed_tried_at`（算失败的原因和时间），改这两列会推 `memories`，记忆页跟着刷新。

拿去算的文字是 shared 的 `memoryEmbedText`：`${appliesTo}\n${content}`。「适用于」一起算，查询里提到某个对象时更容易挑中它。

### 2.3 什么时候算

**「要算」由 SQL 判断，不靠各处写记忆的代码通知**：当前模型下没有这一行，或者行里的 `content_hash` 不等于 `md5(applies_to || E'\n' || content)`（内容、适用于改过）。所以记忆页、助手、导入、审核通过，谁改了记忆都不用另外调用什么，后台自己会发现。JS 里算 md5 用 `createHash("md5").update(memoryEmbedText(m), "utf8")`，和 SQL 的结果一致（库是 UTF-8），测试里对一遍。

- **后台循环**（API 进程，`memory/embed.ts`，`index.ts` 里和图库的并列启动）：只算 `status = active` 的；一批 32 条一次调用；算完一批马上接下一批，没活干时每分钟看一次。失败的写 `embed_error`、`embed_tried_at`，隔 10 分钟再试。多个 API 进程用事务级 advisory lock（`hashtext('heyagent.memory_embed')`）。
- **叫醒**（`kickMemoryEmbeddings()`，只是让它早点算）：记忆新建、修改、审核通过以后；默认 embedding 模型换了以后（`data/config/models.ts` 两处，和 `kickGalleryEmbeddings` 并列）。不叫醒也就晚一分钟。
- **运行开始时顺手补算**：挑的时候发现有生效的记忆还没算好，最多 64 条（`AUTO_MEMORY_INLINE_EMBED_MAX`）和查询文字放在同一次调用里算掉、存下。多出来的这次不参与，过程里写「还有 N 条没算好，这次没参与」。
- 写向量用 upsert（主键冲突就更新 hash 和向量），后台和运行开始时同时算同一条也没事。
- 归档、拒绝、待审核的不算；它们已有的向量留着不管（挑的时候按状态筛掉），删记忆时级联删。

### 2.4 换了 embedding 模型

照图库：

- 新模型的向量慢慢补算，旧模型的行留着；当前模型把**所有生效的记忆**都算完了，才删别的模型的行。
- **挑的时候只用当前模型的向量**（查询是用当前模型算的，不同模型的向量不能比）。还没算到的记忆这次没参与；不超过 64 条的会在运行开始时顺手算掉，所以几百条记忆以内，换完模型下一次运行就全能用。
- 一千条记忆全部重算大约 $0.5（第 3.6 节），比图库便宜。

### 2.5 没设 embedding 模型

- 后台什么都不算。挑的时候直接跳过：快照里 `autoMemory.status = skipped`，原因「还没设 embedding 模型（模型页 → 默认设置）」，过程里一条 `plan`。运行照常，**不报错、不挡运行**。
- 为什么不退回按关键词挑：中文不分词，关键词匹配又粗又难解释，两种挑法人看不懂为什么挑了它。没模型就是不挑，界面上说清楚。
- 任务弹窗里开关照样能开，下面一行字提醒「还没设 embedding 模型，开着也不会挑」；记忆页详情写「没设 embedding 模型，不会被自动挑」。

## 3. 挑

### 3.1 查询文字

`autoMemoryQueryText(snapshot)`，一项一行，按顺序拼，截到 2000 字（`AUTO_MEMORY_QUERY_MAX_CHARS`）：

1. 任务标题
2. 目标
3. 步骤（每步一行，只要文字，不要检查点）
4. 这次的说明 `snapshot.note`（人加的待办的标题、立即运行时的备注）
5. 派活：单子标题、说明、参数（`参数名：值`，一个一行）

不放：任务记忆、技能、工具、附件名（和「这次要办什么事」关系不大，放进去反而把相似度拉平）。同一个任务不带说明、不是派活的运行，每次挑的结果一样，这是对的：要变的是记忆库，不是查询。

### 3.2 哪些记忆能被挑

- `status = active`；
- 不是这个任务手选的（手选的本来就在）；
- **不是 `web_unverified`（「来自网页，可能不实」）**：这种记忆原来要人一条条手选才进得了提示；自动挑会把它带进跟它无关的任务，网页里藏的指令就传得更远。要用它就手选。
- 当前模型下向量按现在的内容算好了（含运行开始时顺手补算的）。

范围是**整个记忆库**，不按「适用于」限制：「适用于」是随手写的标签，按它筛容易漏；相似度门槛已经把不相关的挡掉。按分类限定范围放到以后（第 8 节）。

### 3.3 挑几条、门槛

- 余弦相似度从高到低，取 **≥ 门槛**的**前 N 条**，N = 任务的「最多几条」（默认 5，1～20）。
- 门槛按模型给（`autoMemoryMinScore(modelId)`，写法同图库的 `gallerySameThreshold`），没标定过的模型用 0.6。**0.6 是占位值**：gemini 的分数整体偏高（图库里完全不同的图也有 0.6～0.7），文字的分布没测过。上线前按 9.3 节用真模型标定一次再改，改的只是 shared 里那张表。
- 一条都不够门槛：`status = done`，挑到 0 条，过程里写「没有够像的记忆（门槛 0.60，最像的一条 0.52）」。人看到最高分，就知道门槛是不是太严。
- 页面和过程里相似度写成 `0.78`，不写百分比（理由同图库：不能按「78% 像」理解，只看排序）。

### 3.4 和手选的怎么合并

- 手选的**一定在**，顺序照旧，在前面；自动挑的去掉手选过的，排在后面，相似度从高到低。
- 「最多几条」只管自动挑的，不算手选的。
- 任务记忆（只属于一个任务的经验）不变，照旧全部给。

### 3.5 什么时候挑、出错怎么办

- worker 进这次运行、建系统提示之前（`runSession` 里 `buildSystemPrompt` 前面），快照里 `autoMemory.status = pending` 才挑。挑完写回快照（`pending` 变成别的），以后挂起再继续、进程重启接着跑，都不再挑。
- 为什么不在开始运行时挑：`startSessionInTx` 在调用方的事务里（派活一个事务开好几次运行），里面不能调外部模型。
- 整个挑选最多等 20 秒（`AUTO_MEMORY_TIMEOUT_MS`）。`embed()` 出错、超时：`status = failed`，原因写进去，过程里一条 `plan`「自动挑记忆没做成：……，这次只用手选的记忆」。**运行照常**。不用 `error` 类过程：运行详情的「出错」提示取最后一条 `error`，不能让它冒出来。
- 先跑固化流程的运行也照样先挑（建系统提示在跑脚本之前；脚本跑不通交给 agent 时就用得上）。固化试跑不挑（快照里没有 `autoMemory`）。

### 3.6 花多少钱

按图库实测的单价估（gemini-embedding-2，约 $0.5 / 百万 token，文字应该更便宜）：

| | 多少 | 花费 |
|---|---|---|
| 每次运行算查询 | ≤ 2000 字，约 ≤ 2000 token | ≤ $0.001 |
| 一条记忆 | ≤ 1100 字 | ≤ $0.0006 |
| 一千条记忆全部重算（换模型） | | 约 $0.5 |

不记进运行的花费：`embed()` 现在不返回用量，金额也小到可以忽略（图库同样不记）。

## 4. 任务设置

| 字段 | 库 | 默认 | 说明 |
|---|---|---|---|
| `autoMemory` | `tasks.auto_memory` boolean | **新任务开**（`taskInputSchema` 默认 true）；库里列默认 false，**已有的任务迁移后是关的**，行为不变 | 「自动挑选记忆」 |
| `autoMemoryLimit` | `tasks.auto_memory_limit` integer | 5 | 「最多几条」，1～20；页面给 3 / 5 / 10 / 20 |

- 新任务默认开：记忆少的时候门槛挡得住，挑到的也就一两条；记忆多了正是要它的时候。已有任务不自动打开，免得人没改任务、提示却变了。
- 改任务是整份替换：**改任务的地方必须把原来的值带上**，不然变回默认的「开」。约定代码已经改了网页任务弹窗的默认值和助手的 `taskInputOf`。
- 助手建、改任务能设这两项（`TASK_LABELS` 已加）；导入建的任务按默认开。
- 固化试跑、三方验收、复核、运行总结都不受影响。

## 5. 快照和提示词

### 5.1 快照

`sessionSnapshotSchema`（shared `engine.ts`）：

- `memories[]` 每条多一个可选的 `auto: { score }`：有 = 自动挑的，没有 = 手选的。旧快照全是手选的。
- 新增可选的 `autoMemory`（`autoMemorySnapshotSchema`，shared `memory-retrieval.ts`）：

| 字段 | 说明 |
|---|---|
| `status` | `pending` 还没挑 / `done` 挑过了（可能 0 条）/ `skipped` 没挑 / `failed` 出错 |
| `limit` | 最多几条（开始运行时任务上的设置） |
| `at` `modelId` `minScore` | 挑的时间、模型、门槛 |
| `candidates` | 参与挑选的有几条 |
| `notReady` | 生效但还没算好、这次没参与的有几条 |
| `query` | 拿来挑的文字 |
| `reason` | skipped / failed 的原因 |

- `buildSnapshot`：任务开着、不是固化试跑时写 `autoMemory = { status: "pending", limit }`。手选的照旧写 `lastUsedAt`。
- `resolveAutoMemory`（worker）：一个事务里 `update sessions set snapshot = … where id = ? and snapshot->'autoMemory'->>'status' = 'pending'`（更新 0 行 = 别处已经挑过，重新读快照），追加一条过程，给挑中的记忆写 `lastUsedAt` / `lastUsedSessionId`。

### 5.2 系统提示

`buildSystemPrompt`：

```text
## 记忆（人审核过的，必须遵守）
- [适用于] 内容                ← 手选的，和现在一样；没有就不写这段

## 可能相关的记忆（系统按这次要办的事从记忆库里自动挑的，人审核过；和这次的事有关就照做，无关的忽略）
- [适用于] 内容                ← 自动挑的，相似度从高到低；没有就不写这段
```

- 分两段：手选的是人明确要它遵守的；自动挑的只是「可能相关」，挑错了要让 agent 能忽略。
- **提示里不写相似度**：数字对模型没用（不同模型刻度不一样），顺序已经表达了；相似度只给人看（快照、过程、运行详情）。

### 5.3 过程

一条 `plan`，紧跟在「运行开始」后面：

| 情况 | 标题 | 详情 |
|---|---|---|
| 挑到了 | 自动挑了 3 条记忆 | 每条一行：`m-012 [适用于] 内容前 40 字 · 相似度 0.78`；最后一行「参与挑选 42 条，门槛 0.60」，有没算好的加「还有 N 条没算好，这次没参与」 |
| 一条都没够 | 没有够像的记忆 | 「门槛 0.60，最像的是 m-007（0.52）」 |
| 跳过 | 没自动挑记忆 | 原因（没设 embedding 模型 / 记忆库里没有能挑的） |
| 出错 | 自动挑记忆没做成 | 原因；「这次只用手选的记忆」 |

## 6. 界面

只用 registry 组件，不新增自定义组件；说明放「?」提示。

### 6.1 任务弹窗（`pages/tasks/task-dialog.tsx`）

- 「用哪些 → 记忆」下面一行：`Switch`「自动挑选记忆」+ `FieldLabel` 旁的「?」（`HelpTip`）：「运行开始时按任务标题、目标、步骤和这次的说明，从记忆库里再挑几条相关的给 agent。手选的一定会给。来自网页、没核实的记忆不会被自动挑。」
- 开着时右边一个 `Select`（`sm`）「最多 5 条」，选项 3 / 5 / 10 / 20。
- 没设 embedding 模型（`models.overview` 的 `defaults.embed` 为空）：下面一行 `FieldDescription`「还没设 embedding 模型，开着也不会挑（模型页 → 默认设置）」。

### 6.2 运行详情（新文件 `pages/tasks/run-memory.tsx`，在 `run-detail.tsx` 的「检查点」下面）

- `DetailSection`，标题「记忆 · 手选 2 · 自动挑 3」（只有手选的就是「记忆 · 2 条」），「?」说明手选和自动挑的区别。数据来自 `sessions.get` 的 `memoryUse`，取到前不显示（摘要里没有）。
- 一条一个 `Item`（`outline` / `sm`）：标题是内容（两行截断），描述是「m-012 · 适用于」，右边 `Badge`：手选的 `outline`「手选」，自动挑的 `secondary`「自动 · 0.78」。整条是去记忆页的链接（`#/memory?id=…`）。
- 最下面一行 `text-muted-foreground` 写挑选情况：挑中时「参与挑选 42 条，门槛 0.60」；`pending`「挑选中」+ `Spinner`；0 条、跳过、出错照第 5.3 节的标题和原因。
- 任务记忆只写一行「另有任务记忆 N 条，全部给了 agent」（`taskMemoryCount`），不逐条列（任务详情里有）。
- 没有任何记忆、也没开自动挑选的，不显示这个区块。

### 6.3 记忆页（`pages/memory/index.tsx`）

- 详情加一个 `DetailSection`「自动挑选」（只对「生效」的记忆），一行字：
  - `ready`：「能被自动挑（向量算好了）」；
  - `pending`：「向量还在算」+ `Spinner`；
  - `failed`：「向量算失败：原因。10 分钟后自动重试」（`text-destructive`）；
  - 来自网页的：「来自网页、没核实，不会被自动挑，要用请在任务里手选」；
  - 没有 `embed`（没设模型）：「没设 embedding 模型，不会被自动挑」。
- 「?」：「开着『自动挑选记忆』的任务，运行开始时会按内容挑相关的记忆。」
- 列表不加东西（页面保持简单）。「最近一次被读到」照旧，自动挑的也算。
- 删记忆时提示「被 N 个任务选用」的规则不变（自动挑不算选用）。

### 6.4 模型页（`pages/models/index.tsx`）

- 「图库的 embedding 模型」改成「embedding 模型（图库、记忆共用）」，说明加「开着『自动挑选记忆』的任务也用它挑记忆」，空着时的占位「不用（图库不能以图搜图，记忆不会被自动挑）」。

## 7. 接口和约定代码

约定代码已经在这个分支上（只有类型、表、空壳，功能没写）：

| 位置 | 内容 |
|---|---|
| `packages/shared/src/memory-retrieval.ts`（新） | 常量（维数、默认值、上限、门槛表 `autoMemoryMinScore`、查询长度、补算上限、超时）、`memoryEmbedText`、`memoryEmbedStateSchema` / `memoryEmbedInfoSchema`、`autoMemorySnapshotSchema`、`snapshotMemoryAutoSchema`、`runMemoryUseSchema` |
| `packages/shared/src/schemas.ts` | `MemoryRef.embed?`；`TaskDef.autoMemory` `autoMemoryLimit`；`SessionRun.memoryUse?`（只在 `sessions.get`，列表的摘要里没有） |
| `packages/shared/src/engine.ts` | 快照 `memories[].auto?`、`autoMemory?` |
| `packages/shared/src/config.ts` | `taskInputSchema` 加 `autoMemory`（默认 true）、`autoMemoryLimit`（1～20，默认 5） |
| `apps/server/src/db/schema.ts` + `drizzle/0033_memory_retrieval.sql` | `memory_embeddings`；`memories.embed_error` `embed_tried_at`；`tasks.auto_memory`（默认 false）`auto_memory_limit`（默认 5） |
| `apps/server/src/memory/embed.ts`（新，空壳） | `kickMemoryEmbeddings` `embedPendingMemoriesOnce` `startMemoryEmbeddings` `memoryEmbedInfos` |
| `apps/server/src/memory/retrieval.ts`（新，空壳） | `autoMemoryQueryText` `pickMemories` `resolveAutoMemory` `runMemoryUseOf` |
| 已带上新字段 | `data/loaders.ts`（`listTasks`）、`data/config/tasks.ts`（写列）、`assistant/tools.ts`（`taskInputOf`、标签、格式）、网页 `task-dialog.tsx`（表单默认值） |

接口变化（`docs/dev/api.md` 由后端开发者补）：

- `tasks.list`：`TaskDef` 多 `autoMemory` `autoMemoryLimit`。`tasks.create` / `tasks.update`：输入多这两项，不传 = 开 / 5。
- `memories.list`：`MemoryRef.embed?: { state: "ready" | "pending" | "failed", error? }`，没设模型、不是生效的没有。
- `sessions.get`：`SessionRun.memoryUse?: { items[]{ id appliesTo content auto?{score} }, auto?: AutoMemorySnapshot, taskMemoryCount }`。
- 实时推送：不加表。`memories` 的 `embed_error` / `embed_tried_at` 变了照旧推 `memories.list`；挑选写回快照会推 `sessions`（已有）。
- 没有新的 tRPC 过程、HTTP 接口、权限、审计 action。

## 8. 这次不做

- 按「适用于」分类限定挑选范围、某条记忆「不许自动挑」的开关：先看实际挑得准不准再说。
- 「试一下会挑哪些」的预览按钮（任务弹窗里）：要多一个接口、每点一次花一次钱；先靠运行详情看。
- 运行中途按新情况再挑（agent 主动「查记忆」的工具）：这次只在开始时挑一次。
- 任务记忆的自动挑选：一个任务最多 100 条，照旧全部给。
- 把 embedding 的花费记到运行上。
- 自定义（OpenAI 兼容）服务的 embedding：`embed()` 现在只支持 OpenRouter，照旧。

## 9. 测试计划

### 9.1 单元（不连库）

- `autoMemoryQueryText`：各项顺序、空项跳过、派活参数、截断到 2000 字。
- `memoryEmbedText` 的 md5 和 SQL `md5(applies_to || E'\n' || content)` 一致（含中文、emoji；这条要连库，放 9.2）。
- `buildSystemPrompt`：只有手选 / 只有自动 / 两种都有 / 都没有；自动段不带分数。
- `autoMemoryMinScore`：带服务前缀的模型 id 能认出来。

### 9.2 集成（连测试库，`runtime.embedFactory` 给假向量，不调真模型）

假向量：把文字按字切开、每个字 hash 到 1024 维里的一格再归一化，字重合多的相似度高，结果可预期。

- 向量：新建记忆 → 后台跑一批 → 有行、hash 对；改内容 → 变成要算 → 重算；归档、待审核的不算；`embed` 抛错 → `embed_error`，10 分钟内不重试、过了再试；换模型 → 新旧并存，全算完才删旧的；`memories.list` 的 `embed` 三种状态和没模型时没有。
- 挑：手选的一定在、不重复；`web_unverified`、归档、待审核的不挑；门槛、条数；0 条时过程写最高分；没算好的 ≤ 64 条顺手补算、超过的计入 `notReady`；没设模型 → `skipped`、运行照常跑完；`embed` 抛错、超时 → `failed`、运行照常；挂起再继续不再挑（`embedFactory` 只被调一次）；固化试跑没有 `autoMemory`；派活参数进了查询；挑中的写了 `lastUsedAt`。
- 任务：新建不传 → 开、5；改任务不传 → 变回默认（确认这是整份替换的预期）；网页和助手改任务保留原值（助手 `update_task` 只改标题，`autoMemory` 不变）。
- `sessions.get` 的 `memoryUse`：旧快照（没有 `auto`、没有 `autoMemory`）能读。
- 已有测试里断言整个快照或整段系统提示的，按新字段更新。

### 9.3 真模型标定门槛（要监工批，花费 < $0.01）

- 脚本放 `spikes/memory-retrieval/<日期>/`，用 .env 的 OpenRouter key，模型 gemini-embedding-2（再测一个便宜的文字模型做对比可选）。
- 30 条示例记忆（6 类，各 5 条，只是测试数据，不进产品代码）+ 10 个查询（任务标题 + 目标 + 步骤的写法），人工标出每个查询该挑哪几条。
- 记下「该挑的」和「不该挑的」相似度分布（最低 / 平均 / 最高），门槛定在能留住九成该挑的、又挡掉绝大多数不该挑的地方；结果写进本文第 3.3 节，改 shared 的门槛表。

### 9.4 网页

- `npx tsc -b`、`npm run lint`、`npm run build`；ui-rules 第 7 节的 grep 检查。
- 用 worker 镜像里的 Chrome 截图看（浅色 / 暗色、窄屏）：任务弹窗的开关和「最多几条」、没设模型的提示；运行详情的「记忆」区块（手选 + 自动、0 条、跳过、出错、挑选中）；记忆页详情的五种情况。

## 10. 分工

两个人可以同时开工：接口和类型已经定好，网页先用 `memoryUse` / `embed` 的假数据做。

### 10.1 后端

| 文件 | 改什么 |
|---|---|
| `apps/server/src/memory/embed.ts` | 实现：要算的判断（SQL md5）、后台循环、upsert、旧模型清理、`memoryEmbedInfos` |
| `apps/server/src/memory/retrieval.ts` | 实现：查询文字、挑选（精确余弦，`<=>`）、顺手补算、超时、写回快照 + 过程 + `lastUsedAt`、`runMemoryUseOf` |
| `apps/server/src/index.ts` | 启动 / 停止记忆的后台循环 |
| `apps/server/src/engine/sessions.ts` | `buildSnapshot` 写 `autoMemory: pending` |
| `apps/server/src/engine/loop.ts` | `runSession` 里建系统提示前调 `resolveAutoMemory`，后面用它返回的快照 |
| `apps/server/src/engine/prompt.ts` | 两段记忆 |
| `apps/server/src/data/loaders.ts` | `listMemories` 带 `embed`；`loadSession` 带 `memoryUse`（要另外读 `sessions.snapshot`） |
| `apps/server/src/data/config/memories.ts`、`data/config/models.ts` | 叫醒后台（新建、修改、审核通过；换 embedding 模型两处） |
| `apps/server/src/assistant/prompt.ts`、`assistant/tools.ts` | 助手说明：全局记忆除了手选，任务开着自动挑选时也会按内容挑；建任务卡片上默认值不显示 |
| `apps/server/test/memory-retrieval.test.ts`（新）+ 受影响的旧测试 | 第 9.1、9.2 节 |
| `spikes/memory-retrieval/…` | 第 9.3 节（批了再做） |
| 文档 | `docs/dev/api.md`（第 7 节的接口变化）、`docs/guide.md`（5.5 记忆的「注意」那段、任务字段表、运行详情的区块列表、第 8 节已知限制删掉「不会自动挑」）、`docs/v1-plan.md` 1.3 那一行 |

### 10.2 网页

| 文件 | 改什么 |
|---|---|
| `apps/web/src/pages/tasks/task-dialog.tsx` | 开关 + 最多几条 + 没设模型的提示（6.1） |
| `apps/web/src/pages/tasks/run-memory.tsx`（新）、`run-detail.tsx` | 运行详情的「记忆」区块（6.2） |
| `apps/web/src/pages/memory/index.tsx` | 详情的「自动挑选」（6.3） |
| `apps/web/src/pages/models/index.tsx` | embedding 模型的标题和说明（6.4） |

全是 registry 组件的组合，不用登记 `docs/ui-rules.md` 第 8 节。

## 11. 要定的事（都有推荐默认值，全文照默认值写）

| # | 问题 | 推荐 |
|---|---|---|
| 1 | 新任务「自动挑选记忆」默认开还是关；已有任务要不要打开 | 新任务开，已有任务不动（关） |
| 2 | 「来自网页、可能不实」的记忆能不能被自动挑 | 不能，只能手选 |
| 3 | 相似度门槛 | 先用 0.6 占位，开发时用真模型标定一次（< $0.01，要批）再定 |
