# Agent 运行时 + 模型接入 选型调研（v1）

> 调研日期 2026-10-17。版本号来自当天 `npm view` 和 GitHub API；API 名称来自官方文档，部分还在下载的包里用 `.d.ts` 核对过（§7 R40）。方括号 [Rn] 指向文末的参考链接。标「未核实」的内容在官方原文里没有找到。内网 Ollama（192.168.31.100）在本机连不上，**所有 Ollama 结论都没有实测**。

## 结论和推荐

**推荐 A：自己写 session 引擎（agent 循环 + Postgres 落库 + 规则闸门），模型层用 Vercel AI SDK 7（`ai@7.0.143`）。** 云端用 `@openrouter/ai-sdk-provider@3.1.0`，内网用 `ai-sdk-ollama@4.5.0`（走 Ollama 原生 `/api/chat`），MCP 用 `@ai-sdk/mcp@2.0.78`。

理由：
1. **10 条要求里最难的三条（挂起几天后接着跑、每步落库并实时显示、规则由代码在固定阶段执行）没有一个框架能直接满足，最后都要自己写。** 其中挂起和继续在我们的规模下并不难：一次运行 = 一个 session，每个模型调用、每个工具调用都先落库；挂起就是「写一行等待记录，然后退出循环」，继续就是「从库里读出消息，接着循环」。不需要 Temporal 或 Workflow 这类工作流引擎。
2. AI SDK 正好补上自己写最费事的部分：多家模型统一的 tool calling 和流式输出，统一的 usage（含 `cacheReadTokens` / `cacheWriteTokens`），MCP client（stdio 和 HTTP 都支持），`prepareStep` + `pruneMessages` 做上下文压缩 [R2][R4]。工具定义里不写 `execute`，循环就会停在工具调用处 [R2]。这样工具由我们的「工具网关」执行，调工具前、调工具后的规则模型绕不过去。
3. OpenRouter 和 Ollama 都有现成的 AI SDK 7 provider（peerDependency 都是 `ai@^7`）[R5][R6][R40]。

不选其他方案的理由（详见 §2）：
- **B（直接调 OpenAI 兼容接口）**：可以做，但流式 tool call 拼装、Ollama 的兼容层 bug、usage 归一化、MCP client 都得自己写。建议把 B 留作降级通道：引擎内部定义一个很薄的 `ModelPort` 接口，个别模型出问题时可以绕过 AI SDK。
- **C（Claude Agent SDK）**：hooks 设计最贴近我们的规则闸门，但它**只支持 Claude 模型**（Anthropic 明确不支持经网关接非 Claude 模型 [R22]），而我们的执行模型可以选 Ollama。另外它的 session 是 Claude Code 子进程写的 JSONL，只能「镜像」到我们的库 [R18]；技能只能从磁盘加载 [R20]。适合以后作为「Claude 专用执行器」接进来，不适合当底座。
- **D（OpenAI Agents JS / Mastra / LangGraph.js）**：挂起和继续都做得不错，但都会把我们的 session、事件、规则模型套进它们自己的抽象，而且规则、检查点、三方验收仍然要自己写。Mastra 是最接近的备选（§2.4）。
- **E（Hermes Agent）**：Python 写的单用户个人 agent，状态存在本机 SQLite，不适合 fork；它的技能、记忆、压缩设计值得借鉴。
- **F（Managed Agents）**：只跑 Claude；agent 循环跑在 Anthropic，工具输入输出都要回传过去；不能用 OpenRouter 结算；验收也不满足「不同家族」。不适合，但它的 session/事件模型、outcome 评分、vault 设计值得照抄（§2.6）。

## 1. 对比总表（10 条要求）

✅ 现成可用　⚠️ 部分支持或需要绕路　❌ 不支持或冲突　🔧 要自己写（框架不挡路）

| 要求 | A 自写循环 + AI SDK 7 | B 自写循环 + OpenAI 兼容 | C Claude Agent SDK | OpenAI Agents JS | Mastra | LangGraph.js | E Hermes | F Managed Agents |
|---|---|---|---|---|---|---|---|---|
| 版本（2026-10）/ 许可 | ai 7.0.143 / Apache-2.0 | openai 7.36.0 / Apache-2.0 | 0.3.302 / 商业条款 | 0.20.0 / MIT | core 1.78.0 / Apache-2.0 | 1.5.1 / MIT | v0.22.2 / MIT（Python） | beta `managed-agents-2026-04-01` |
| 1 挂起几天后继续，不占资源 | 🔧 自己写（简单） | 🔧 | ⚠️ `resume` + `defer`，每轮只能有一个工具调用 | ✅ `RunState.toString()` | ✅ 快照存库 + `listSuspendedRuns` | ✅ `interrupt` + checkpointer | ⚠️ 单机 SQLite | ✅ 托管 |
| 2 每步落库 + 实时显示 | 🔧 回调数据齐全 | 🔧 | ⚠️ 只能从消息流和 SessionStore 镜像 | ⚠️ tracing 默认发往 OpenAI | ⚠️ 存在它自己的表结构 | ⚠️ checkpoint 是状态快照，不是事件流 | ❌ | ✅ SSE 事件流，但存在 Anthropic |
| 3 固定阶段的代码规则 | 🔧 工具网关 | 🔧 | ✅ PreToolUse / PostToolUse / Stop 等 hooks | ⚠️ 只有 `needsApproval` 和 guardrails | ⚠️ 只有 approval 和 processor | 🔧 加节点 | ⚠️ 只有命令审批 | ❌ |
| 4 检查点 + 自动同步 | 🔧 | 🔧 | ⚠️ 用 PostToolUse hook 同步 | 🔧 | 🔧 | 🔧 | ❌ | ⚠️ 只有 outcome rubric |
| 5 跨家族三方验收 | ✅ 任选模型 | ✅ | ❌ 只有 Claude | ⚠️ 要走 adapter（beta） | ✅ | ✅ | ❌ | ❌ grader 由平台提供 |
| 6 MCP（stdio/HTTP）+ HTTP 工具 + 内置工具 | ✅ `@ai-sdk/mcp`；HTTP 工具自己写 | ⚠️ 直接用 MCP 官方 SDK | ✅ 外加进程内 `createSdkMcpServer` | ✅ | ✅ | ⚠️ 走 LangChain 适配 | ✅ | ⚠️ 内网 MCP 要走 tunnel 或 worker |
| 7 记忆（人审后生效） | 🔧 | 🔧 | ⚠️ 基于文件的 memory | 🔧 | ⚠️ 自带 memory，语义不同 | 🔧 | ⚠️ 自己整理记忆，无人审 | ⚠️ memory store |
| 8 技能（目录 + `skill.load`） | 🔧 很简单 | 🔧 | ⚠️ 只能从磁盘加载，没有编程 API | 🔧 | 🔧 | 🔧 | ✅ agentskills.io 标准 | ✅ skills |
| 9 OpenRouter + Ollama，按角色选模型 | ✅ 两边都有 provider | ✅ | ❌ 能接 OpenRouter，但只能用 Claude | ⚠️ 默认走 Responses API | ✅ OpenRouter；Ollama 走自定义 URL | ✅ | ⚠️ 支持 OpenRouter 和自定义端点 | ❌ |
| 10 以后并行子 agent | ✅ 子 session | ✅ | ✅ subagents | ✅ handoffs / agent-as-tool | ✅ | ✅ 最强 | ✅ | ✅ |

## 2. 逐项说明

### 2.1 A：自写循环 + Vercel AI SDK 7（推荐）
- **版本**：AI SDK 7 于 2026-06-25 发布 [R1]，当前 `ai@7.0.143`。v7 只支持 ESM，要求 Node 22 以上 [R5]。相关包：`@ai-sdk/mcp@2.0.78`、`@ai-sdk/openai-compatible@3.0.71`、`@ai-sdk/workflow@2.0.75` [R40]。
- **能直接用的**：
  - `ToolLoopAgent`、`streamText` / `generateText`。
  - `stopWhen` 支持 `isStepCount`、`hasToolCall`、`isLoopFinished`。`ToolLoopAgent` 默认 `isStepCount(20)` [R2]。
  - `prepareStep` 可以按步骤换模型、限制 `activeTools`、改写 messages 或做压缩 [R2]。
  - `toolApproval` 的取值有 `'user-approval'`、`'approved'`、`'denied'`、`'not-applicable'`。待审批时内容里出现 `tool-approval-request`。但文档写明「服务端不保存会话状态」，要自己存 messages [R3]。
  - `@ai-sdk/mcp` 的 `createMCPClient` 支持 HTTP、SSE 和 stdio；官方说 stdio 只用于本地 [R4]。
  - v7 还加入了 `registerTelemetry` 和生命周期回调 [R1]。
- **Provider 现状**：
  - OpenRouter 官方 provider 3.1.0 只支持 `ai@^7`。prompt caching 写成 `providerOptions.openrouter.cacheControl`，花费从 `providerMetadata.openrouter.usage.cost` 读 [R5]。
  - Ollama 有两个社区 provider：`ollama-ai-provider-v2@4.0.1`（直接发 HTTP）和 `ai-sdk-ollama@4.5.0`（基于官方 `ollama` JS 客户端，后者调用原生 `/api/chat`，见包源码）。官方页面推荐需要稳定 tool calling 时用 `ai-sdk-ollama` [R6]。
  - 也可以用 `@ai-sdk/openai-compatible` 指向 Ollama 的 `/v1`，但有 §3.2 列出的坑。
- **WorkflowAgent**：v7 新增的 `WorkflowAgent` 号称「进程重启、部署、延迟审批都能活下来」[R1]。它依赖 Workflow SDK（`workflow@5.2.2`）；用 Postgres World 可以自托管，不用 Vercel [R7]。但工作流代码要满足确定性重放（随机数、token 都要可重放），心智负担大，而且 Workflow SDK 还在快速迭代。**v1 不用，记作以后的升级选项。**
- **最大的坑**：大版本升级会带来破坏性改名（v7 把 `system` 改成 `instructions`、`experimental_prepareStep` 改成 `prepareStep`，提供 codemod）[R1]。另外社区 Ollama provider 的质量要自己验证。对策是把 AI SDK 包在 `ModelPort` 后面，锁定版本。
- **适合**：是。

### 2.2 B：自写循环 + OpenAI 兼容接口
- `openai@7.36.0` [R40]。OpenRouter 的 `/chat/completions` 能透传 `cache_control`，并且默认返回 `usage.cost` [R8][R9]。
- Ollama `/v1/chat/completions` 支持 tools，但**不支持 `tool_choice`**；图片只能传 base64，不能传 URL [R11]。流式 tool call 有过多次兼容问题：多个 tool call 的 index 全是 0，已在 2026-04 修复 [R12]；有第三方反馈 `/v1` 流式时会丢掉 tool call [R13]。这些都要自己兜底。
- **最大的坑**：要重新造 AI SDK 已经造好的轮子，而且每家的差异都要自己维护。**适合程度**：只作为降级通道。

### 2.3 C：Claude Agent SDK（TypeScript）
- **版本**：`@anthropic-ai/claude-agent-sdk@0.3.302`，按平台附带原生二进制。它本质上是「把 Claude Code 当库用」，在子进程里跑 Claude Code [R16][R40]。适用 Anthropic 商业条款；第三方产品不得提供 claude.ai 登录 [R16]。
- **Hooks**：
  - TypeScript 支持 30 多种事件，包括 `PreToolUse`、`PostToolUse`、`PostToolBatch`、`Stop`、`SubagentStart`/`SubagentStop`、`PreCompact`/`PostCompact`、`SessionStart`/`SessionEnd`、`PreModelSwitch` 等。matcher 写 `mcp__<server>__<tool>` 就能匹配 MCP 工具 [R19]。
  - `PreToolUse` 可以返回 `allow` / `deny` / `ask` / `defer`，可以带 `updatedInput`。`PostToolUse` 可以用 `updatedToolOutput` 替换工具输出 [R19]。
  - `Stop` hook 返回 `decision:"block"` 可以不让它结束，适合拦截「说做完了」[R19]。
- **MCP**：支持 stdio、HTTP 和进程内的 `createSdkMcpServer`（包里的 `.d.ts` 已核对）。
- **Skills**：只能从磁盘加载（`.claude/skills/<name>/SKILL.md`，受 `settingSources` 控制）。`skills` 选项只能限定允许哪些，**没有编程注册 API** [R20]。我们的技能存在库里，只能每次运行前写到临时目录。
- **Subagents**：`agents` 选项里的 `AgentDefinition` 可以设置 model、tools、mcpServers、maxTurns、background 等字段；默认后台并行；有深度、并发、`maxBudgetUsd` 三种上限 [R21]。
- **Session 存在哪**：默认在 `~/.claude/projects/<编码后的cwd>/<id>.jsonl`，按 `cleanupPeriodDays` 默认 30 天清理 [R17][R19]。可以接 `SessionStore` 适配器（必须实现 `append` / `load`），官方有 Postgres、Redis、S3 参考实现。但它是**「先写本地，再尽力镜像」**：失败重试 3 次后丢弃这批数据，只发出一条 `mirror_error`。条目格式归 SDK 所有，`data` 字段要求原样保存 [R18]。
- **几天后继续**：用 `resume: sessionId`。`PreToolUse` 返回 `defer` 可以让进程以 `stop_reason:"tool_deferred"` 退出，之后 resume 时同一个工具调用会再触发一次 hook，没有超时。但**只在模型这一轮只调了一个工具时才生效**，并行调用多个工具时 defer 会被忽略 [R19]。
- **OpenRouter / 非 Claude 模型**：设置 `ANTHROPIC_BASE_URL=https://openrouter.ai/api`、`ANTHROPIC_AUTH_TOKEN=<OpenRouter key>`、`ANTHROPIC_API_KEY=""` 就能走 OpenRouter 的 Anthropic 兼容端点 [R23]，这是 OpenRouter 写给 Claude Code 的文档，SDK 走同一套环境变量属于推断，**未实测**。Anthropic 明确「不支持经任何网关把 Claude Code 路由到非 Claude 模型」[R22]。花费是 SDK 按 Claude 价格估算的（`total_cost_usd`），和 OpenRouter 的实际账单不一定一致 [R21]。
- **和我们的要求怎么对接**：我们的库只能作为「事件副本」，从消息流和 hook 里抽取后写入；真正用来 resume 的是 SDK 自己的 transcript。内置的 Bash、Read、Write 等工具要逐个禁掉。每次运行要拉起一个 CLI 子进程。
- **最大的坑**：只能跑 Claude，执行模型选不了 Ollama；session 的真实状态不在我们手里。**适合程度**：不适合当底座，可以做将来的可选执行器。

### 2.4 D：OpenAI Agents JS、Mastra、LangGraph.js
- **OpenAI Agents JS（`@openai/agents@0.20.0`）**：
  - 挂起和继续是三者里最清楚的：工具上设 `needsApproval`，运行停下后返回 `result.interruptions`，用 `state.approve()` / `state.reject()` 处理，`result.state.toString()` 序列化后存起来，之后用 `RunState.fromString(agent, s)` 恢复，可以跨进程重启。官方提醒恢复前要校验快照来源，并防止同一个快照被恢复两次 [R24]。
  - 默认走 Responses API，tracing 在服务端默认开启 [R25]。
  - 接非 OpenAI 模型可以用 `OpenAIProvider({ baseURL, useResponses:false })`，或者 `aisdk()` 适配器（还是 beta，有若干限制）[R25][R26]。
  - 坑：以 OpenAI 为中心，接 Claude 和 Ollama 时多套了一层。
- **Mastra（`@mastra/core@1.78.0`，Apache-2.0）**：
  - workflow 有 `suspend()` / `run.resume()`，快照存在 storage 里，重启后还在；还有 `.sleep()` / `.sleepUntil()` [R27]。
  - agent 有 `requireToolApproval`、`approveToolCall` / `declineToolCall`，工具内部可以调 `suspend()`，之后用 `resumeStream()` 恢复；重启后用 `listSuspendedRuns()` 找回挂起的运行。必须配置持久化 storage，快照在运行结束后删除 [R28]。
  - 模型路由支持 `openrouter/<厂商>/<模型>`；Ollama 本地版没有一等支持，要用 `{ id, url }` 指向 OpenAI 兼容地址 [R29]。
  - 坑：框架很重（memory、thread、resource 都有自己的语义），小版本发布频繁；规则闸门、检查点、验收照样要自己写。**是最接近的备选**，如果团队不想自己写挂起逻辑，可以选它。
- **LangGraph.js（`@langchain/langgraph@1.5.1`，`checkpoint-postgres@1.1.0`）**：
  - 用 `interrupt()` 挂起，`new Command({ resume })` 继续，需要 checkpointer，以 `thread_id` 作为游标 [R31]。
  - **继续时整个节点会从头重跑**，`interrupt` 之前的副作用会执行多次 [R31]。我们的工具调用（发 WhatsApp、下单）对这一点非常敏感。
  - 多模型走 LangChain 的模型封装。压缩可以用 `summarizationMiddleware` 和 `trimMessages` [R32]。
  - 坑：图抽象 + LangChain 生态的学习成本高。v2 以后要做复杂的并行编排时可以再评估。

### 2.5 E：Hermes Agent（Nous Research）
- **状态**：`NousResearch/hermes-agent`，MIT，Python，GitHub API 显示约 25.4 万星，最新版 v0.22.2（2026-10-15），仍在活跃更新 [R33]。
- **能力**：技能是「程序性记忆」，兼容 agentskills.io 标准，做完复杂任务后会自动创建并改进技能；自己整理记忆（MEMORY.md / USER.md）；cron；子 agent；MCP；接 OpenRouter 和自定义端点；`/compress` 压缩；消息网关接 Telegram、Slack、WhatsApp 等 [R33]。session 存在 `~/.hermes/state.db`（SQLite + FTS5，WAL 模式，单写者），压缩后会按 `parent_session_id` 拆出新 session [R34]。
- **适不适合 fork**：不适合。语言是 Python，我们是 TypeScript；定位是单用户个人 agent，状态存在单机 SQLite，没有多用户和 Web 控制台；记忆和技能由 agent 自己写入，没有人审。
- **值得借鉴**：技能用 SKILL.md 和 agentskills.io 标准；agent 提议技能（我们加上人审）；压缩后的 session 用 `parent_session_id` 串起来；用全文检索查历史 session；命令审批。

### 2.6 F：Anthropic Managed Agents
- **状态**：beta，请求要带 `managed-agents-2026-04-01` 头。核心概念是 Agent、Environment、Session、Events，session 历史存在 Anthropic 服务端，通过 SSE 推送 [R35]。cron 定时部署和 vault（沙箱里只放占位符，到网络边界才换成真实密钥）在 2026-06-09 公测 [R38]。不符合零数据保留（ZDR）条件 [R35]。
- **能不能访问内网**：可以用自托管沙箱。我们自己跑一个 worker，只需要出站 HTTPS，工具在我们的机器上执行，所以能访问内网的 Ollama、ERP 和本地 Chrome。但「工具输入输出仍然流向 Anthropic 控制面」，模型只能是 Managed Agents 提供的 Claude 模型 [R36]。内网 MCP 要走 MCP tunnel（受限预览）或者包装成 worker 上的自定义工具 [R35][R36]。
- **验收（outcome）**：`user.define_outcome` 带 rubric，`max_iterations` 默认 3、最多 20；grader 使用独立的上下文；结果有 `satisfied`、`needs_revision`、`max_iterations_reached`、`failed`、`interrupted` 五种 [R37]。文档没说能否指定 grader 用哪个模型（未核实），但平台只跑 Claude，**做不到让 qwen3 来验收**。
- **结论**：不适合，原因是只有 Claude、不能用 OpenRouter 结算、数据要出境、验收不满足跨家族要求。**值得照抄的设计**：(1) session = 只追加的事件流，前端订阅；(2) outcome 结果的五种取值和迭代上限，直接用在我们的验收里；(3) vault 占位符、在边界注入密钥，对应我们 HTTP 工具里的 `{{名字}}`；(4)「大脑和手分离」，用 worker 队列执行工具，以后浏览器机器多了可以用；(5) 定时部署。

## 3. 模型接入细节

### 3.1 OpenRouter 上的 Claude：prompt caching 和 usage
- **能透传**。chat/completions 的 content part 上可以写 `"cache_control": {"type":"ephemeral"}`，最多 4 个显式断点；也可以在请求顶层写一个 `cache_control` 开启自动缓存，断点会随对话往后移。TTL 默认 5 分钟，可以写 `"ttl":"1h"`。Claude 5.5 系列最少 512 个 token 才缓存 [R8]。
- **价格**：文档写的是写入 5 分钟缓存 1.25 倍、写入 1 小时缓存 2 倍、读取 0.1 倍 [R8]。但 models API 实际返回的读取价格：Opus 5.5 是 $0.20/M（输入 $4/M），Sonnet 5.5 是 $0.10/M（输入 $2/M），也就是 0.05 倍；Haiku 5.5 是 0.1 倍 [R10]。**计费以 models API 为准**，启动时拉一次存表。
- **usage 默认返回**，`usage:{include:true}` 已经废弃。字段如下：
  ```json
  "usage": { "prompt_tokens": …, "completion_tokens": …, "total_tokens": …, "cost": 0.95,
    "cost_details": { "upstream_inference_cost": … },
    "prompt_tokens_details": { "cached_tokens": 10318, "cache_write_tokens": 0, "audio_tokens": 0 },
    "completion_tokens_details": { "reasoning_tokens": … } }
  ```
  流式输出时 usage 在最后一条 SSE 消息里 [R9]。
- **模型 ID**：`anthropic/claude-opus-5.5`、`anthropic/claude-sonnet-5.5`、`anthropic/claude-haiku-5.5`，上下文都是 1M。这三个模型的 `supported_parameters` 里**没有 `temperature`** [R10]，代码里不要传。
- **注意**：session 挂起几小时后，5 分钟缓存早就过期了，继续时要重新付写入费。长对话的稳定前缀（system、工具定义、技能目录）可以考虑用 1h TTL。

### 3.2 Ollama 对 qwen3 的 tool calling
- Ollama 最新版是 v0.40.5（2026-10-14）[R14]。从官方模型库看：qwen3 有 tools 和 thinking 能力；**qwen2.5-vl 只有 vision，没有 tools；qwen3 没有 vision**；llama3.3 有 tools [R15]。**因此 qwen3:32b 验收时看不了截图**，截图类检查点要先用 qwen2.5-vl 转成文字描述，或者交给人。
- `/v1/chat/completions` 不支持 `tool_choice` [R11]。已修复的问题：流式多工具调用的 index 全为 0（#15457，2026-04 修复）[R12]。第三方报告：`/v1` 流式时会丢掉 tool call，建议改用原生 `/api/chat` [R13]。仍然开着的 issue：设置 `format=json` 后模型无法调用工具（#18944），qwen3 经 `/api/chat` 时工具定义格式异常（#14601），原生 `/api/chat` 渲染出空的工具定义（#19040，2026-10-15）[R14]。
- **建议**：执行和验收都走原生 `/api/chat`（`ai-sdk-ollama`）。验收输出结构化结果时，不要同时开 tools 和 json format，分成两次调用。上线前用 20～50 个固定用例在内网实测 qwen3:32b 的 tool calling 成功率。`num_ctx` 要显式设置（Ollama 默认值偏小，具体值未核实）。

## 4. 长 session 的上下文压缩

| 方案 | 现成办法 |
|---|---|
| AI SDK | `prepareStep` 每步改写 messages，配合 `pruneMessages` 删掉旧的 reasoning 和工具调用 [R2]。摘要要自己写 |
| Claude Agent SDK | 自动压缩，带 `compact_boundary` 事件、`PreCompact` / `PostCompact` hook，支持 `/compact`；子 agent 可以设 `autoCompactWindow` [R19][R20][R21] |
| Anthropic API | 服务端清理工具结果 `clear_tool_uses_20250919` 和 compaction [R39]。OpenRouter 2026-04-03 的 changelog 写了支持 Anthropic compaction；是否透传 `context_management` **未核实** [R39] |
| LangGraph / LangChain | `summarizationMiddleware`（按 token 数触发，保留最近 N 条）、`trimMessages` [R32] |
| Mastra | memory processors，有 `TokenLimiter` 等 [R30] |
| Hermes | `/compress`，压缩后拆成用 `parent_session_id` 串起来的新 session [R33][R34] |

**我们的做法**：
1. **大工具输出在工具网关处截断**。完整内容存入产物表，给模型的只有开头、结尾、长度和 `artifact_id`，需要时用 `artifact.read(id, range)` 分页读。
2. **截图只保留最近 N 张原图**（比如 2 张）。更早的截图换成文字占位，内容是 qwen2.5-vl 在本地生成的一句描述加截图 ID，不花云端的钱。
3. **任务定义、已选规则、记忆、检查点清单、技能目录不放进对话历史**，每一轮从库里重新生成 system 段，压缩时不会丢。
4. **超过阈值（比如上下文的 50%）时**，用 Haiku 5.5 或 qwen3 把较早的轮次压成摘要，原始事件仍在库里，前端照常显示全量。压缩会打断缓存前缀，所以要少压、一次压多一些。

## 5. 推荐的 v1 结构（给实现参考）

- **表**：
  - `sessions`：status 取值 running / waiting / verifying / done / failed，另有 parent_session_id。
  - `session_events`：只追加，用 seq 排序；类型有 model_call（token 和花费）、tool_call（输入、输出、耗时）、checkpoint、rule_hit、wait、resume、verify。
  - `waits`：kind 取值 timer / event / human，另有 wake_at 和 deadline（默认 7 天）。
  - `messages`：给模型的上下文，可以重新生成。
  - 前端通过 SSE 订阅，后端用 Postgres `LISTEN/NOTIFY` 推送。
- **循环**：每一轮调一次 `streamText`（工具不带 `execute`）→ 落库 → 工具网关依次执行「调工具前规则 → 执行 → 调工具后规则 → 同步检查点」→ 落库 → 下一轮。`session.wait` 和 `ask.human` 会写一条 wait 记录，然后退出循环。唤醒器用轮询，或者 `pg-boss@12.38.0` [R40]，到点、来事件、人处理完都由它触发继续，7 天到期就通知负责人。
- **进程重启**：把 status=running 的 session 重新排队。如果某个工具调用「已开始但没有结果」，标记为未知，交给规则或人判断，不自动重放。
- **规则**：确定性条件（工具名、花费超过 $20）编译成代码判断。自然语言条件只在预筛命中后，交给独立的小模型判断，执行 agent 看不到这一步。「说做完了」也是一个阶段，先过规则，再进入验收。
- **验收**：模型表里登记 `family` 字段，代码层面禁止执行和验收同家族。验收 agent 可以调 `ask_executor` 反问执行 agent；说不清的项生成 ask.human。结果取值照抄 Managed Agents 的五种。
- **并行子 agent（v2）**：子 session 带 `parent_session_id`，父 session 等待「所有子 session 完成」这个事件。现在的结构已经留好了位置。

## 6. 风险和待确认

1. **内网 Ollama 没有实测**（本机连不上 192.168.31.100）。需要在内网测：qwen3:32b 经 `/api/chat` 的 tool calling 成功率；thinking 对工具调用和延迟的影响；32b 和 70b 能否同时加载、`OLLAMA_NUM_PARALLEL` 和显存（硬件情况未知）。
2. **验收模型看不了图**（qwen3 没有 vision）。截图类检查点需要 qwen2.5-vl 做中转，或者交给人。要和业务确认这样是否可以接受。
3. **公司内网到 OpenRouter 的出境链路**（代理、稳定性），以及数据出境合规；Claude 的请求内容会经过 OpenRouter 和 Anthropic。
4. **AI SDK 大版本会有破坏性改名**，社区 Ollama provider 是个人维护，要锁版本，并用 `ModelPort` 隔离。
5. **自然语言规则的判定本身靠模型**，「模型绕不过」只对执行 agent 成立。高风险规则（发消息、付款、花费）一律用确定性条件 + 人审。
6. **OpenRouter 文档写的缓存读取价格（0.1 倍）和 models API 返回的价格（Opus/Sonnet 5.5 是 0.05 倍）不一致**，以 API 为准，月底和账单对一次。
7. **未核实**：Managed Agents 能否指定 grader 模型；OpenRouter 是否透传 Anthropic 的 `context_management`；Claude Agent SDK 设置 OpenRouter base URL 后各项功能是否完整；Ollama 默认 `num_ctx` 的具体值。

## 7. 参考链接（访问日期均为 2026-10-17）

- R1 AI SDK 7 发布博客：https://vercel.com/blog/ai-sdk-7
- R2 AI SDK Loop Control：https://ai-sdk.dev/docs/agents/loop-control
- R3 AI SDK Tool Approvals：https://ai-sdk.dev/docs/agents/tool-approvals
- R4 AI SDK MCP Tools：https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
- R5 OpenRouter AI SDK Provider：https://github.com/OpenRouterTeam/ai-sdk-provider
- R6 AI SDK Ollama 社区 provider：https://ai-sdk.dev/providers/community-providers/ollama
- R7 Workflow SDK Postgres World：https://useworkflow.dev/worlds/postgres ；Hooks：https://workflow-sdk.dev/docs/foundations/hooks
- R8 OpenRouter Prompt Caching：https://openrouter.ai/docs/guides/best-practices/prompt-caching
- R9 OpenRouter Usage Accounting：https://openrouter.ai/docs/use-cases/usage-accounting
- R10 OpenRouter Models API（实时数据）：https://openrouter.ai/api/v1/models
- R11 Ollama OpenAI 兼容：https://docs.ollama.com/api/openai-compatibility
- R12 Ollama #15457：https://github.com/ollama/ollama/issues/15457
- R13 OpenClaw #11828（`/v1` 流式丢 tool call）：https://github.com/openclaw/openclaw/issues/11828
- R14 Ollama Releases：https://github.com/ollama/ollama/releases ；#18944 https://github.com/ollama/ollama/issues/18944 ；#14601 https://github.com/ollama/ollama/issues/14601 ；#19040 https://github.com/ollama/ollama/issues/19040
- R15 Ollama 模型库：https://ollama.com/library/qwen3 ；https://ollama.com/library/qwen2.5vl ；https://ollama.com/library/llama3.3
- R16 Claude Agent SDK 概览：https://code.claude.com/docs/en/agent-sdk/overview
- R17 Agent SDK Sessions：https://code.claude.com/docs/en/agent-sdk/sessions
- R18 Agent SDK Session Storage：https://code.claude.com/docs/en/agent-sdk/session-storage
- R19 Agent SDK Hooks：https://code.claude.com/docs/en/agent-sdk/hooks ；Hooks 参考（defer）：https://code.claude.com/docs/en/hooks
- R20 Agent SDK Skills：https://code.claude.com/docs/en/agent-sdk/skills
- R21 Agent SDK Subagents：https://code.claude.com/docs/en/agent-sdk/subagents
- R22 Claude Code LLM 网关：https://code.claude.com/docs/en/llm-gateway
- R23 OpenRouter × Claude Code：https://openrouter.ai/docs/guides/coding-agents/claude-code-integration
- R24 OpenAI Agents JS Human-in-the-loop：https://openai.github.io/openai-agents-js/guides/human-in-the-loop/
- R25 OpenAI Agents JS Models：https://openai.github.io/openai-agents-js/guides/models/
- R26 OpenAI Agents JS AI SDK 适配：https://openai.github.io/openai-agents-js/extensions/ai-sdk/
- R27 Mastra Suspend & Resume：https://mastra.ai/docs/workflows/suspend-and-resume
- R28 Mastra Agent Approval：https://mastra.ai/docs/agents/agent-approval
- R29 Mastra Models：https://mastra.ai/models
- R30 Mastra Memory Processors：https://mastra.ai/docs/memory/memory-processors
- R31 LangGraph.js Interrupts：https://docs.langchain.com/oss/javascript/langgraph/interrupts
- R32 LangChain.js Short-term Memory：https://docs.langchain.com/oss/javascript/langchain/short-term-memory
- R33 Hermes Agent：https://github.com/NousResearch/hermes-agent
- R34 Hermes Session Storage：https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage
- R35 Managed Agents 概览：https://platform.claude.com/docs/en/managed-agents/overview
- R36 Managed Agents 自托管沙箱：https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
- R37 Managed Agents Outcomes：https://platform.claude.com/docs/en/managed-agents/define-outcomes
- R38 Managed Agents 定时部署与 Vault：https://claude.com/blog/whats-new-in-claude-managed-agents
- R39 Anthropic Context Editing：https://platform.claude.com/docs/en/build-with-claude/context-editing ；OpenRouter Changelog 2026-04-03：https://openrouter.ai/docs/changelog/2026/4/3
- R40 npm registry（`npm view` / `npm pack` 后核对 `.d.ts`）：ai、@ai-sdk/*、@openrouter/ai-sdk-provider、ai-sdk-ollama、ollama、@anthropic-ai/claude-agent-sdk、@openai/agents、@mastra/core、@langchain/langgraph、workflow、pg-boss
