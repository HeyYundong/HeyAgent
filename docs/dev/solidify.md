# 固化：办成过一次的事，下次照脚本做（技术架构，2026-10-27）

> **状态：草案，等用户看。** 第 14 节是要用户定的几件事，每件都写了建议。
> 来由：2026-10-27 用户看了 Pomerado（github.com/Pomerado/pomerado，「把网站变成 MCP 工具」），说现在用 DeepSeek，很多地方觉得可以自动持久化，但现在还不行，要一个在 HeyAgent 里怎么实现的技术架构。这也是 `browser-speed.md`「不做」里留下的第二阶段（让脚本做重复的事）。
> 文中写「现在」的，都读 origin/main（8a68ba3）的代码确认过。

## 0. 一页纸

现在每次运行都由模型从头想一遍：同一个任务跑第 100 次，DeepSeek 还是走一步想一步（R-1-2 量过，每想一次约 3.7 秒）。固化就是把一次办成的运行写成脚本，以后照脚本做，只有脚本跑不通时才叫模型。

| # | 部分 | 一句话 |
|---|---|---|
| 1 | 录 | 过程记录里每个浏览器动作多存一段 Playwright 定位代码（MCP 本来就能给，现在关着），下次能点到同一个元素 |
| 2 | 工具桥 | 脚本在沙箱里跑，只能通过 `heyagent` SDK 调工具；每次调用都走同一个工具网关，规则、白名单、审批、验证码 / 登录页检测、过程记录和 agent 自己调一样 |
| 3 | 固化 | 办成的运行 → 固化员（新的模型角色「固化」）读过程，写出脚本、输入输出格式和给人看的步骤说明 → 试跑（走到第一次「提交」前停）→ 人审核 |
| 4 | 跑 | 任务有启用的固化流程时，运行先跑脚本，不调执行模型。跑通了照常收尾（硬规则 + 复核）；跑不通就停在第 k 步，agent 用同一个 Chrome 从那一页接着做 |
| 5 | 修 | 网站改了、脚本跑不通、agent 接手办成以后，固化员对照新的过程提议修好的新版本，人审核；连续 3 次跑不通自动停用 |

预期效果在 P1 验收时实测：

- 快：省掉模型思考的时间。基准 B 优化后 112 秒里，浏览器动作只占 32 秒，其余基本是模型在想。
- 稳：每次走同样的步骤，不再时对时错。
- 省：执行模型的花费接近 0，只剩复核那一次调用。固化一次要调几次模型，估计和 agent 跑一遍是同一个量级（几美分）。

不直接用 Pomerado（第 12 节）：它建脚本只能用 OpenAI 的模型，跑脚本时也绕开了我们的规则。但它有几个做法值得照搬：先真办一次再写脚本、标出「提交」那一步、写完读回来核对、等待时列出所有可能的结果。

本文覆盖网页操作固化成脚本，以及网站接口直连（第 10 节）。经验和记忆自动记下不在这里：「总结」可以改成运行结束自动跑、候选照样等人审核，是单独的小改动。

## 1. 现在有什么

| 已有的 | 在哪 | 对固化有什么用 |
|---|---|---|
| 工具网关：模型的每次调用都经过这里（规则前后钩子、参数校验、执行、截断、落库） | `engine/gateway.ts` | 脚本也走它，就不用另做一套管控。`browser.batch` 已经是「一串动作逐个走 `call()`」 |
| 过程记录：每次工具调用的工具、参数（密钥已隐藏）、输出 | `session_events`（只追加） | 固化员的原料 |
| Playwright MCP 能给出每个动作对应的 Playwright 代码（输出里的 `### Ran Playwright code` 段）。用快照 ref 点的，会换成稳定的定位，例如 `getByRole('button', { name: '查询' })`；动作的 `target` 参数又接受这种写法 | `playwright-core` 里 MCP 的 `targetLocators`；我们启动 MCP 时传了 `--codegen none`（`browser/mcp.ts`） | 录下来的定位，下次直接当 `target` 用 |
| 沙箱：bubblewrap，独立的网络命名空间，上网只能走挂进去的 unix socket（出网代理） | `sandbox/runner.ts`、`sandbox/code-run.ts` | 用同样的办法再挂一个 socket，就是脚本调工具的通道 |
| 派活的参数和结果声明（参数名、说明、必填；要交回的结果） | `tasks.dispatch`、`packages/shared/src/dispatch.ts` | 现成的输入输出格式。被派的运行「一天可能几十上百次」，最值得固化 |
| 收尾：`run.finish` → 硬规则 → 复核 | `engine/loop.ts` 的 `finishRun` | 脚本报结果走同一条路 |
| 「存成任务步骤」（`plan.set` → 任务步骤）、「总结」→ 任务记忆候选 | `data/config/tasks.ts` 的 `saveStepsFromSession`、`engine/digest.ts` | 已经是两种「固化」，但下次还是模型来做，省不了时间 |
| 要人审核的事（记忆、技能修改，带 diff） | `human_items`、`skill_suggestions` | 固化流程的审核照这个做 |

## 2. 总体流程

```text
一次普通运行（agent + DeepSeek）
  模型 → 工具网关 → 浏览器 / HTTP / MCP / 内置工具
             └→ 过程记录：工具、参数、结果 + 录下的定位代码（第 3 节）
      │ 办成（复核过）
      ▼
固化（第 5 节）
  固化员读过程 → 脚本 + 输入输出格式 + 步骤说明 → 程序检查
  → 试跑：沙箱里跑脚本，走到第一次「提交」前停 → 不通就改，最多 3 轮
  → 人审核「审核固化流程」→ 启用（试用 → 正式）
      │
      ▼
以后的运行（第 6 节）
  沙箱里的脚本 → 工具桥 → 同一个工具网关（规则、白名单、审批、验证码检测、过程记录）
  ├─ 跑通：ha.finish → 收尾（硬规则 + 复核），不调执行模型
  └─ 停在第 k 步 → agent 接着做（同一个 Chrome、同一页）
       └─ agent 办成 → 固化员提议修好的版本 → 人审核（第 7 节）
```

## 3. 录：让过程记录能照着重放

### 3.1 打开 MCP 的代码输出

- `browser/mcp.ts` 的 `--codegen none` 改成 `--codegen typescript`。
- `BrowserTools.runMcp` 把输出里的 `### Ran Playwright code` 段拿出来，从给模型的输出里去掉（模型看到的和现在一样，不多花 token），放进 `ToolOutcome.code`。
- 网关落过程记录时一起存（3.2 的 `trace`）。存之前先过和参数一样的密钥隐藏（`redactSecrets`、`maskSecretFields`）。
- `browser.batch` 里每一步本来就各有一条过程记录，各自带代码。
- 没有好名字的元素，Playwright 会退回 CSS 路径，这种最容易随改版失效。固化员优先用按角色、文字、标签的定位，换不了的写进 `assumptions`（5.4）。

### 3.2 每个浏览器动作再记几件事

`session_events` 加一列 jsonb `trace`：

```ts
{
  code?: string        // 录下的 Playwright 代码
  urlBefore?: string   // 做之前的网址
  urlAfter?: string    // 做之后的网址
  title?: string       // 做之后的标题
  routineStep?: number // 脚本做的：工具桥的第几次调用（第 4 节）
}
```

网址和标题从 `instance.currentPage()` 读，和页面概况一样限时，读不到就不记。

### 3.3 输入对照

固化前，系统先在过程记录里找这次运行的输入出现在哪几步的参数里，标出来交给固化员。输入包括派活参数的值和附件 id。这样不让模型自己猜哪些是输入、哪些是页面上固定的字。

### 3.4 不录

- 屏幕录像、整页 DOM：太大，固化用不上。
- 网站接口的请求：在 P3 记（第 10 节）。

## 4. 工具桥：脚本只能通过工具做事

### 4.1 怎么连

```text
沙箱（bwrap，不能上网）                         worker
  import ha from "heyagent"
  await ha.browser.click(...)  ── JSON 行 ──>  /tmp/.tools/tools.sock ──> ToolBridge ──> gateway.call()
                               <── 结果 ───                                      （规则、白名单、审批、
                                                                                  验证码检测、过程记录）
```

- `ToolBridge` 是新加的（`engine/routine/bridge.ts`）。一次运行一个，绑这次运行的 `ToolGateway`。请求是 `{ id, tool, input }`，回复是 `{ id, ok, text, data?, error?, stop? }`。
- 一次只处理一个调用，和引擎处理模型的调用一样按顺序。每次调用前看一眼运行是不是被取消了（同 `callBatch` 的 `stillRunning`），取消了就杀掉沙箱。
- 调用 id 记成 `<运行号>-r<序号>`，过程记录里和 agent 的调用分得开。
- 上限：一次运行最多 1000 次工具调用、默认 10 分钟，防死循环。10 分钟要小于 `runtime.maxRunMs`。

### 4.2 为什么不让脚本直接写 Playwright（Pomerado 的做法）

- 一段 Playwright 代码一次做很多动作，规则只能管到「执行代码」这一下，管不到里面的每一步。
- 我们一律屏蔽了 `browser_run_code_unsafe`（m2.md 第 1 条：等于远程执行，能拿到包括 HttpOnly 在内的全部 cookie）。
- 脚本是模型读了网页以后写的，网页里的话可能夹带指令（注入）。只给它工具，最坏也只能做 agent 本来就能做的事，而且每一步都有记录、都过规则。

### 4.3 沙箱

- 用 `code.run` 的同一套（`sandbox/runner.ts`），语言是 Node 24。
- **不挂出网代理**：脚本不能上网，和外面打交道只能经过工具桥。
- SDK 放在沙箱的根文件系统里，构建 worker 镜像时放进 `/opt/sandbox-root`。工具桥的 socket 目录只读挂到 `/tmp/.tools`。
- 内存 512 MB。空间文件照 `code.run` 挂在 `/workspace`，但只读；读附件、写结果还是走 `file.*` 工具，过程记录里看得见。

### 4.4 SDK 一览

| 函数 | 对应的工具 | 说明 |
|---|---|---|
| `ha.input` | — | 这次的输入，按 `inputSchema` 校验过：派活参数、这次运行带的附件 id |
| `ha.browser.navigate({ url })` | `browser.navigate` | |
| `ha.browser.click({ element, target })` | `browser.click` | `target` 写定位（`getByRole('button', { name: '查询' })`、`text=查询`），不能写快照 ref；`element` 是给人看的名字 |
| `ha.browser.type` `fillForm` `select` `press` `hover` `check` `upload` `tabs` | 同名的 `browser.*` | 参数和 agent 调用时一样 |
| `ha.browser.waitAny({ 名字: 定位, … }, { timeout })` | 新工具 `browser.wait_any`（只读） | 等页面出现其中一个，返回是哪个。照 Pomerado 的 `waitForOutcome`：结果页、「暂无数据」、报错提示都列出来，不要只等成功的那个 |
| `ha.browser.extract({ list, fields })` | 新工具 `browser.extract`（只读） | 按定位读页面上的字：`list` 是每一行的定位，`fields` 是行内每个字段的定位。返回 JSON 行和总行数 |
| `ha.file.read(…)` `ha.file.save(…)` | `file.read`、`file.save` | 表格附件读成行 |
| `ha.checkpoint.mark(…)` | `checkpoint.mark` | |
| `ha.work.report({ data })` | `work.report` | |
| `ha.tool(id, input)` | 任务里的任何别的工具（HTTP、MCP、比物、图库……） | 返回 `{ text, data }` |
| `await ha.commit("保存第 3 个商品")` | 标记，不是工具 | 下一步会真的改东西（提交、保存、发送）。试跑停在这里；试用期在这里截图存证（6.5）；过了这里再出错，交给 agent 时写明「可能已经生效」 |
| `await ha.verified("页面提示保存成功")` | 标记，不是工具 | 写完读回来核对过了 |
| `ha.finish({ outcome, summary, evidence, reason })` | `run.finish` | 结束。结果照常按硬规则核、复核 |
| `ha.fail("input" \| "page", 原因)` | 不是工具 | 主动停。`input` = 输入本身有问题，记没办成、不交 agent；`page` = 页面和预期不一样，交给 agent |
| `ha.log(文字)` `ha.now()` | 不是工具 | 记一条过程给人看；现在的时间（上海时间，P2 起记进日志，6.7） |

`ToolOutcome` 加一个 `data`（结构化结果）：`browser.extract` 返回行，HTTP 工具返回解析过的 JSON，`file.read` 读表格返回行。SDK 优先给 `data`，没有就给文字。模型那边还是看 `output`，不受影响。

一个固化流程大概是这样（被派的任务，参数「单号」，要交回「状态」）：

```js
import ha from "heyagent"

export default async function run(input) {
  await ha.browser.navigate({ url: "https://erp.example.com/orders" })
  await ha.browser.type({ element: "单号输入框", target: "getByRole('textbox', { name: '单号' })", text: input.单号 })
  await ha.browser.click({ element: "查询", target: "getByRole('button', { name: '查询' })" })
  const seen = await ha.browser.waitAny({
    found: "getByRole('row').nth(1)",
    empty: "getByText('暂无数据')",
  })
  if (seen === "empty")
    return ha.finish({ outcome: "not_achieved", summary: `查不到单号 ${input.单号}`, evidence: "列表显示「暂无数据」", reason: "系统里没有这张单" })
  const { rows } = await ha.browser.extract({
    list: "getByRole('row').nth(1)",
    fields: { 状态: "getByRole('cell').nth(3)", 更新时间: "getByRole('cell').nth(4)" },
  })
  await ha.work.report({ data: { 状态: rows[0].状态 } })
  return ha.finish({ outcome: "achieved", summary: `${input.单号}：${rows[0].状态}（${rows[0].更新时间}）`, evidence: `订单列表第 1 行：${rows[0].状态}` })
}
```

会改东西的步骤前后加标记：

```js
for (const [i, item] of rows.entries()) {
  await ha.browser.fillForm({ fields: [
    { name: "名称", type: "textbox", target: "getByLabel('名称')", value: item.名称 },
    { name: "价格", type: "textbox", target: "getByLabel('价格')", value: String(item.价格) },
  ] })
  await ha.commit(`保存第 ${i + 1} 个`)
  await ha.browser.click({ element: "保存", target: "getByRole('button', { name: '保存' })" })
  const saved = await ha.browser.waitAny({ ok: "getByText('保存成功')", error: "getByRole('alert')" })
  if (saved === "error") await ha.fail("page", `第 ${i + 1} 个保存时页面报错`)
  await ha.verified(`第 ${i + 1} 个：页面提示保存成功`)
}
```

### 4.5 两个新的浏览器工具也给 agent

`browser.extract` 和 `browser.wait_any` 用编排器自己的 Playwright 连接做（和页面概况 `page-brief.ts` 一样），只读，放进「浏览器」工具组。

- agent 读表格、列表时用 `extract`，一次拿到 JSON，比读快照省事。
- `wait_any` 替代「做完再快照看看」。

### 4.6 网关的各种结果，到了脚本里

| 网关返回 | 脚本里 | 这次运行 |
|---|---|---|
| 成功 | 返回结果 | 接着跑 |
| 工具出错（定位找不到、超时……） | 抛 `StepError`。脚本可以自己接住，比如可有可无的弹窗 | 没接住就交给 agent（6.4） |
| 被规则拦下 | 抛 `Denied` | 交给 agent，agent 看到原因 |
| 要人审批 | 停在这一步之前，不发起审批（同 `browser.batch`） | 交给 agent。agent 单独调用这一步，照常交给人审批 |
| 要挂起（验证码、登录页、等浏览器） | 脚本停下 | 照常挂起。P1 继续后由 agent 接着做；P2 起脚本接着跑（6.7） |

### 4.7 agent 也能写脚本（P2）

`code.run` 加参数 `tools: true`：agent 运行中遇到重复的活（比如 30 行要录），自己写一段用 SDK 的循环脚本，走同一个工具桥。这就是 `browser-speed.md` 留下的第二阶段。agent 写过、跑通过的脚本，也是固化最好的原料。

## 5. 固化：把一次办成的运行写成脚本

### 5.1 什么时候固化

- **手动**：运行详情「⋯」→「固化成流程」。只有已结束、结果是办成的运行能点；负责人和主管能点（同「存成任务步骤」）。
- **自动**（P2，问题 1）：任务设置「办成后自动固化」。运行办成，并且任务还没有启用的固化流程（或者这次脚本跑不通、agent 接手办成了），就自动排一次固化。

### 5.2 谁来写：新的模型角色「固化」

- 模型页的默认模型多一个「固化」（`model_role` 加 `solidify`），没设就用「规划」的默认模型。任务不单独选。
- 一次固化调几次模型：写一次，试跑不通再改，最多 3 轮。次数少，可以选比执行模型强的模型（问题 3）。

### 5.3 给固化员的材料

- 任务：目标、步骤、检查点；派活的参数和结果声明。
- 这次运行：
  - 输入：派活参数、附件清单；
  - 每次工具调用：工具、参数、录下的定位代码、前后网址、成功还是出错、输出开头 300 字；
  - 3.3 标出的输入位置；
  - `run.finish` 的总结和依据、`work.report` 交的结果、存下的文件、勾过的检查点。
- SDK 的类型说明（`heyagent.d.ts`）和 4 个例子：
  - 搜索后读列表；
  - 填表提交后读回核对；
  - 按附件里的表格一行行做；
  - 查不到时报没办成。
- 修的时候再给：旧版本的脚本、停在哪一步和原因、agent 接手后的过程。
- 模型的思考过程不给：只看做了什么。
- 网页、文件、工具输出里写给 AI 的话一律当数据（和 `digest.ts` 一样）。

### 5.4 固化员交出来的（结构化输出）

| 字段 | 说明 |
|---|---|
| `suitable`、`reason` | 适不适合固化。要看内容做判断的（「挑最像的一家」）不适合整段固化，写清是哪一步；能写成明确规则的（「取第一条」）可以固化，写进 `assumptions` |
| `name`、`description` | 名字；给人看的步骤说明，一步一行 |
| `inputSchema`、`outputSchema` | JSON Schema。被派的任务：输入 = 声明的参数，输出 = 声明的结果 |
| `code` | 脚本（ES module，`export default async function run(input)`） |
| `commits` | 哪几步会真的改东西 |
| `assumptions` | 脚本做的假设（「默认取第一条」「每页 20 条」「元素只能用 CSS 路径定位」） |

### 5.5 程序检查

- 能解析成 ES module。只许 `import ha from "heyagent"`；不许 `eval`、`Function`、`require`、动态 `import`、`process`。
- 用到的每个工具都在这个任务里。
- 输入输出格式是合法的 JSON Schema。
- 不过就把原因交回固化员改，算一轮。

### 5.6 试跑

- 起一次「固化试跑」：一个 `kind = routine_test` 的运行，用任务现在的配置和原来那次运行的输入。和普通运行一样要分 Chrome、过规则，遇到登录页交给人。
- 只跑脚本，不叫 agent。**走到第一个 `ha.commit` 就停**，不做那一步。`work.report`、`run.finish`、`checkpoint.mark` 只记下来，不生效。
- 和原来那次运行比：读到的数据、要交的结果是不是一样。停下时截一张图。
- 不通过：把出错的那一步、错误、页面概况和快照交回固化员改，再试跑。最多 3 轮，还不通过就告诉负责人固化没成功，原因写清楚。
- 只有提交前的部分是真跑过的。提交之后的部分（读回核对）只能靠审核和试用期（6.5）。
- 固化是一个小的状态机，记在 `routine_versions.status`：写脚本 → 试跑 →（改 → 试跑）× n → 待审核 / 没成功。
  - 试跑可能要等 Chrome、等人登录，所以队列任务 `routine.compile` 不等它。
  - 试跑的运行结束时再排一次 `routine.compile`，接着走下一步。

### 5.7 交给人审核

- 给任务负责人生成一件要人办的事「审核固化流程」（`human_item_kind` 加 `routine`），在「会话 → 等人处理」和通知里看得到。
- 内容：
  - 步骤说明、输入输出、假设；
  - 试跑结果：每步 ✓、读到的数据和原来那次对比、停下时的截图；
  - 脚本，折叠起来；
  - 修的版本再给步骤说明和脚本的 diff。
- 按钮：「启用」（进试用期，6.5）、「不用」（要写理由，固化员下次看得到）。

## 6. 跑：以后的运行先跑脚本

### 6.1 任务上的开关「固化流程」

- **不用**。
- **先跑流程**：审核启用以后默认这一项。
- **给 agent 当工具**（P2）：脚本成了 agent 的一个工具 `routine.<名字>`，agent 决定什么时候调。适合整件事要判断、但中间有几段固定动作的任务，例如「在某个网站按关键词搜、读前 20 条」。

### 6.2 快照

开始运行时把启用的那一版冻进快照（`snapshot.routine`：id、版本、脚本、输入输出格式），和技能一样。运行中途批准了新版本，不影响这次运行。

### 6.3 引擎

改 `engine/loop.ts` 的 `runSession`：

```text
建工具网关 → 开始钩子（只跑一次：脚本跑完 stepCount 还是 0，要看 sessions.routine 判断）
→ 快照里有固化流程，这次还没跑过（sessions.routine 为空）：
    按 inputSchema 校验输入（派活参数、附件）
      不合格 → 交给 agent，说明哪个参数不对
    起沙箱 + 工具桥，跑脚本
→ 跑通：ha.finish → finishRun（硬规则 + 复核，结果的来源记 routine）
→ 跑不通：记下停在哪，追加一条交接的话，进 agent 循环（同一个网关、同一个 Chrome）
→ 挂起：交接的话和挂起在同一个事务里落库；继续后进 agent 循环
```

步数只算模型调用，脚本跑通时是 0。

### 6.4 交给 agent 的那段话（例）

```text
（系统）这次运行先按固化流程「查订单状态」v3 跑了，做到第 5 步停下：
1. navigate https://erp.example.com/orders ✓
2. type「单号输入框」✓
3. click「查询」✓
4. wait_any → found ✓
5. ✗ extract：在 getByRole('row').nth(1) 里找不到 getByRole('cell').nth(3)（页面可能改版了）
会改东西的步骤：一步都还没做。
现在的页面：「订单列表」 https://erp.example.com/orders?no=…
请从现在的页面接着把任务办完，前面做过的不要重复。
```

做过提交、没核对的写：「第 7 步「保存第 3 个」已经点了保存，可能已经生效：先看页面核对，不要重复保存。」

### 6.5 试用期和正式

- 新版本启用后先是「试用」。前 3 次运行每次都通知负责人结果（办成也发）；每个 `ha.commit` 之前自动截一张图存证。
- 连着 3 次脚本直接办成（没交给 agent、复核通过），自动转「正式」。
- 正式以后，只在没办成、交给 agent 时通知（和现在一样）。

### 6.6 跑不通的次数

- 连续 3 次交给 agent，就自动停用这一版（状态「停用：连续 3 次跑不通」），通知负责人。之后的运行只用 agent，直到修好的新版本被启用。
- 任务详情显示最近 20 次：脚本直接办成几次、交给 agent 几次、平均用时。

### 6.7 挂起以后接着跑脚本（P2：重放日志）

- P1：脚本一停就交给 agent。验证码、登录页、要审批的步骤都会让后半段变成 agent 做，但结果是对的。
- P2：工具桥把每次调用记成日志：序号、工具、参数的 hash、结果、用的是哪个 Chrome。
  - 继续时从头重跑脚本：日志里有的调用直接返回记下的结果、不真做；到停下的那一步再真做，然后接着跑。
  - 脚本因此必须每次走同样的路：取时间用 `ha.now()`，它也记进日志。
  - 对不上（参数 hash 不一样），或者 Chrome 已经换了（验证码、登录页挂起时 Chrome 本来就保留着），就交给 agent。
  - 这和引擎「每一步先落库、随时能接着跑」是同一个思路。

### 6.8 不变的

名额、派活自动重试、取消、花费上限、步数上限、规则、复核都和现在一样。脚本的用时算在这次运行里（`runtime.maxRunMs`）。

## 7. 修：网站改了怎么办

- 脚本停在第 k 步、agent 接手办成以后，P1 由人点「重新固化」，P2 自动排。
- 固化员拿旧脚本、停下的原因、agent 接手后的过程，改成新版本 → 试跑 → 人审核（看 diff）。
- 版本都留着（`routine_versions`），可以回到以前的任意一版，同技能的版本。
- 修好的版本不自动启用：每一版都要人点启用。

## 8. 数据和接口

| 改动 | 内容 |
|---|---|
| 新表 `routines` | id（`RT-<n>`）、task_id、status（试用 / 正式 / 停用）、active_version、连续跑不通次数、统计、created_at |
| 新表 `routine_versions` | routine_id、version、name、description、code、input_schema、output_schema、commits、assumptions、source_session_id、test_session_id、test_report（jsonb）、model_id、status（写脚本 / 试跑 / 待审核 / 没成功 / 启用过 / 不用）、reject_reason、approved_by_id、approved_at |
| `tasks` | `routine_mode`（off / first / tool）；`auto_solidify`（P2） |
| `sessions` | `kind`（run / routine_test）；`routine`（jsonb：id、版本、状态 running / finished / fell_back、做了几步、用时、停在哪一步和原因、提交过哪几步、核对过没有） |
| `session_events` | `trace`（jsonb，3.2） |
| 枚举 | `human_item_kind` 加 `routine`；`model_role` 加 `solidify` |
| `ToolOutcome` | 加 `data`（结构化结果）、`code`（录下的定位代码） |
| 队列 | `routine.compile`：固化和修都走它。试跑的运行照常走 `session.run` |
| 接口（tRPC `routine.*`） | `compile({ sessionId })`、`get({ taskId })`、`versions({ routineId })`、`review({ versionId, approve, reason? })`、`setMode({ taskId, mode })`、`pause` / `resume`、`restore({ version })` |
| 代码 | `engine/routine/`：`bridge.ts` 工具桥、`run.ts` 跑脚本和交接、`compile.ts` 固化员、`checks.ts` 程序检查、`test-run.ts` 试跑。`browser/extract.ts`：`extract`、`wait_any`。`sandbox/sdk/`：`heyagent.mjs` 和 `heyagent.d.ts`，构建时放进沙箱根文件系统 |

试跑的运行（`kind = routine_test`）：

- 不复核、不算结果；
- 不进会话页默认的标签、不算成功率；
- 不占派活名额，不触发「定时到点时上一次还没跑完就跳过」。

## 9. 界面

全部用 registry 组件，不用新的自定义组件。

- **任务详情**：新区块「固化流程」，只在有固化流程时显示。
  - 状态用 `Badge`：试用 / 正式 / 停用。
  - 版本，最近 20 次的成绩（脚本直接办成 / 交给 agent / 平均用时）。
  - 「先跑流程」用 `Switch`。
  - 「⋯」里：看脚本（`Dialog` + `CodeBlock`）、版本记录、停用、删除。
- **运行详情**：
  - 头部写「按固化流程 v3 跑：14 步 · 9 秒 · 没调执行模型」，或者「固化流程停在第 5 步（找不到「查询」按钮），agent 接着做完」。
  - 过程里脚本做的步骤和 agent 的一样显示，多一个 `Badge`「流程」。
  - 「⋯」里加「固化成流程」，只有办成的运行有。
- **等人处理**：新卡片「审核固化流程」（5.7）。脚本和 diff 用 `CodeBlock`，试跑的每一步用 `Trace`。
- **模型页**：默认模型多一个「固化」。
- **会话列表**：试跑的运行标「固化试跑」。

## 10. P3：直接调网站的接口

- **记接口**：编排器那条 CDP 连接听页面发出的 XHR / fetch，只记同源、在白名单里、返回 JSON 的。
  - 记方法、路径、参数名、状态码、返回的字段结构和开头 20 KB（隐藏密钥）。
  - 存成这次运行的文件 `network/requests.jsonl`，固化员读它。
- **新工具 `browser.fetch`**：在当前页面里发 `fetch`，带这个网站的登录态。
  - 只能发给当前页面的同一个网站，而且要在白名单里。白名单现在只拦主文档，页面里的请求要由这个工具自己查。
  - GET 算只读；别的方法算会改东西（风险 write），规则照管。
  - 任务设置里要打开「允许直接调网站接口」，默认关，和「允许执行脚本」一样。
- 有了它，脚本读 30 页列表可以改成发 30 个请求，从几分钟变成几秒。
- 不需要浏览器登录态的接口（用 token 认证的），固化员可以建议改成一个普通的 HTTP 工具，密钥照规矩写成 `{{名字}}`，由主管来建。

## 11. 安全

| 担心的事 | 怎么防 |
|---|---|
| 脚本绕过规则、白名单 | 每一步都是一次工具调用，走同一个网关（4.1）。主文档的白名单本来就在编排器的 CDP 连接上拦（`browser/instance.ts`），谁打开都拦 |
| 网页里的话把固化员带偏（注入） | 网页内容当数据（5.3）；程序检查只许用 SDK（5.5）；沙箱不能上网，碰不到 cookie、数据库、主密钥；每一版都要人启用 |
| 写错了还提交了 | 试跑停在提交前（5.6）；试用期每次通知、提交前截图（6.5）；过了提交再出错，交给 agent 时写明「可能已经生效」（6.4） |
| 网站改了 | 跑不通就交给 agent，这次照样办完；连续 3 次自动停用（6.6）；提议修（第 7 节） |
| 死循环、跑太久 | 一次最多 1000 次工具调用、10 分钟（4.1） |
| 密码 | 脚本里不出现。登录照旧由浏览器的自动登录和人工登录处理，脚本假定已经登录 |

## 12. 和 Pomerado 比

| | Pomerado | HeyAgent 固化 |
|---|---|---|
| 建脚本的模型 | 只能用 OpenAI（`gpt-6.1-sol` 写，`gpt-6-luna` 审），还用了 OpenAI 专有的缓存、压缩参数 | 模型页配的「固化」模型，DeepSeek 等都行 |
| 原料 | 现场把网站探索一遍 | 已经办成的运行的过程记录，不用再探索 |
| 跑的时候 | 原生 Playwright 代码，在它自己的浏览器里，每次是全新的 cookie | 每一步走工具网关；用我们的 Chrome 配置、登录态、账号租约 |
| 管控 | Guardian 模型审每个动作和最后的代码，跑的时候不再审 | 规则每一步都管；人审每一版；以后需要可以加一个审代码的模型 |
| 网站改了 | 云版自动修 | 当次交给 agent 办完，再提议修好的版本 |

照搬的做法：

- 先真办一次再写脚本：会改东西的动作，不为了写脚本再做一次。
- 标出提交那一步，以及「可能已经生效」的说法。
- 写完读回来核对。
- 等待时列出所有可能的结果。
- 在页面里调网站自己的接口。
- 分清「输入有问题」和「页面变了」。

## 13. 分三期

### P1：闭环（手动固化）

- 第 3 节：录（代码输出、`trace` 列、输入对照）。
- 第 4 节：工具桥、SDK、沙箱，`browser.extract`、`browser.wait_any`，`ToolOutcome.data`。
- 第 5 节：手动固化、程序检查、试跑、审核。
- 第 6 节：先跑流程、交给 agent、试用 → 正式、连续 3 次停用。
- 第 9 节：任务详情的「固化流程」、运行详情的头部和标签、审核卡片、模型页的「固化」。
- 部署：8080 现在的 worker 已经有沙箱根文件系统（`/opt/sandbox-root`）。SDK 要放进去，所以 P1 上线要重建 worker 镜像，照规矩等你点头。

P1 验收：

- **真模型**：基准 A、B、C（`scripts/speed-bench.sh`）各取一次优化后办成的运行来固化，再跑 3 遍。要求都做对，记总时间、模型调用次数、花费，和 agent 的中位数（124 / 112 / 126 秒）比。
- **本地测试站点（假模型）**：
  - 改掉一个按钮的名字 → 脚本停下 → agent 接着办成；
  - 规则拦下脚本的某一步；
  - 脚本走到验证码页 → 交给人 → 继续后 agent 接着做；
  - 试跑停在提交前，没有提交。
- `conventions.md` 第 0 节的业务词检查没有新的命中。

### P2：自动、接着跑、agent 写脚本

- 办成后自动固化，跑不通后自动提议修（问题 1）。
- 重放日志：挂起、审批、交接以后脚本接着跑（6.7）。
- `code.run` 带工具：agent 运行中自己写循环脚本（4.7）。
- 给 agent 当工具（6.1）。
- 脚本里的判断题：`ha.judge({ prompt, schema })` 用执行模型做一次结构化判断（挑哪一条、归哪一类），其余照脚本做。这样「中间要看一眼内容」的任务也能固化大半。

### P3：接口

- 记接口、`browser.fetch`、HTTP 工具建议（第 10 节）。
- 多个任务共用的流程库：像技能一样在配置页管理、建任务时选。

## 14. 要你定的

1. **自动固化**：P1 只做手动；P2 加任务开关「办成后自动固化」，被派的任务和定时任务默认开，别的默认关。建议：照这样。
2. **试用期的提交要不要人批准**：建议不要。P1 里一要审批脚本就得停、交给 agent，试用期就等于没试。改成提交前截图，加上每次通知负责人。
3. **固化用什么模型**：建议新加「固化」角色，没设时用「规划」的默认模型。固化次数少，可以选比执行模型强的。
4. **试跑会做提交前的步骤**：会真的填表、选东西，只是不点提交，有的网站会自动存草稿。建议照做；任务上加一个「固化时不试跑」的开关，给这种网站用。
5. **脚本跑通的运行还复核吗**：建议复核。你定过每次运行都复核；复核只调一次模型，几乎不花钱，能发现「脚本跑完了但结果不对」。
6. **先用在哪**：建议先挑 1～2 个被派的任务（有参数、有结果、跑得多），再加速度基准的三个场景。
