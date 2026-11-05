# dsh (DeepSeek Harness): agent capabilities, fact sheet for the HeyAgent full fork

Source: `deepseek-ai/deepseek-harness@8bd07339 的本地克隆` (read only, nothing executed).
Paths below are relative to the repo root. Tags:
- **[src]**: I opened the TypeScript source and confirmed it.
- **[doc]**: taken from repo docs or package READMEs only. The generated "Cordis API" blocks in docs are extracted from source by `scripts/gen-cordis-catalog.ts`, so they are high-confidence, but I did not open every implementation behind them.
- **GAP**: missing compared with what HeyAgent needs.

Framework basics needed to read the rest:
- Everything is a Cordis plugin: `apply(ctx, config)`, with `ctx.on(event, listener)` and services on `ctx.<name>`.
- Each live `Agent` has `agent.ctx`, an agent-scoped context. Registrations made through it (tools, prompt sections, skills, MCP clients, listeners) are visible only to that agent and are removed when the agent is disposed. [src] `packages/core/agent/src/runtime-types.ts:203`.
- `createScope(ctx, agent)` from `@deepseek-ai/dsh-scope` mints a disposable sub-scope for one agent. [src] used in `packages/experimental/browser-use-runtime/src/mcp.ts`.
- Per-agent initialization hook: `'agent/created'(payload: { agent, source: 'startup'|'resume'|'clear'|'compact', signal? })`. It runs in serial mode, and the agent holds queued input until every listener has finished. [src] `packages/core/agent/src/runtime-types.ts:290`.

---

## 1. Tools

### 1.1 Registry `ctx.tools` (`ToolsService`). [src] `packages/core/tools/src/index.ts`
```ts
register(definition: ToolDefinition, options?: { when?: (c: ToolActivationContext) => boolean|Promise<boolean> }): () => void
restrict(filter: { allow?: string[]; deny?: string[] }): () => void   // scoped ctx only
get(name, scope?, toolSet?) / executable(name, scope?, toolSet?)
resolve(ctx: ToolActivationContext): Promise<ResolvedToolSet>         // once per step, by agent-loop
definitions(scope?, toolSet?) / schemas(scope?, toolSet?)
setExecutor(executor: ToolExecutor)        // native or PTC executor, per scope
execute(input: ToolBatchInput): Promise<ToolBatchResult>   // raw batch; agent and log are optional
guard(guard: (exec) => string|undefined)   // monotonic deny-only
```
- **Layers.** A global layer plus one layer per scope. A call through `agent.ctx.tools.register` lands in that agent's layer and shadows a global tool with the same name. Duplicates within one layer throw. The name `run_code` is reserved. [src]
- **`restrict()`** [src, index.ts:162]:
  - Throws without a scoped ctx. Error text: "requires a scoped context (agent.ctx)".
  - Throws on an empty filter.
  - Unknown names, scope-local names and `run_code` also fail. [doc in JSDoc; first two checks verified in src]
  - Restrictions intersect with each other. The scope's own registrations are exempt.
  - Consequence for per-task tool selection: an `allow` list may name only tools that are registered globally.
- **Conditional tools.** `when` is evaluated once per model step with `{agent, modelSelection, signal}`. A tool that is excluded is absent from both the declarations sent to the model and dispatch. [doc] tools.md; `resolve()` signature [src].
- **Registry validation.** The registry checks `output` (required) and its schema. It does **not** validate `parameters`: a raw `ToolDefinition` validates its own args. `defineTool()` validates them for you. [src] index.ts:128-141.
- **`timeoutMs`** must be a positive finite number. [src]

### 1.2 Tool definition shape. [doc] `docs/subsystems/tools.md`, matches `packages/core/tools/src/contracts.ts`
```ts
interface ToolSchema { name; description; parameters: Record<string,unknown>; deferLoading?: true }   // llm/llm/src/types.ts:517 [src]
interface ToolDefinition extends ToolSchema {
  output: { schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta?(args, value): JsonValue }  // REQUIRED
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>   // returns a canonical JSON value
  projectContent?(exec, result): ContentBlock[]|undefined          // e.g. images, before post-execute
  finalizeContent?(exec, result): ContentBlock[]|undefined         // last content-only transform
  timeoutMs?: number                                               // enforced by guard/timeout-policy
  isConcurrencySafe?(args): boolean                                // only `true` opts into parallel
  presentCall?(args): ToolCallView; presentResult?(args, result): ToolResultView   // UI cards
}
interface ToolRunContext extends ToolExecution {
  deferContext(msg: UserMessage): void   // inject context after the tool/result
  concludeTurn(): void                   // successful result ends the agent turn
}
interface ToolExecution { callId; rootCallId; name; arguments /*deep-frozen*/; agent?; toolSet?; parent?; schema?; signal; token }
```
- **`defineTool({name, description, parameters, output, execute})`** builds a definition from a typed DSL (`ValueSchemaSpec`). It infers TypeScript types and validates both args and output. [doc]
- **Raw JSON Schema is limited to an enforced subset.** Supported keywords: `type`, `oneOf`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, and annotations. `assertSupportedJsonSchema()` **rejects unsupported keywords**; the docs name none of `anyOf`, `allOf`, `$ref`, `format`, `pattern`, `minimum`, `minLength`. [doc] tools.md "enforced raw JSON Schema subset".
  - This applies to **output** schemas, which the registry checks.
  - MCP input schemas are passed through unvalidated as `parameters`. [src] `mcp/mcp-client/src/tools.ts:255-262`
  - MCP output schemas fall back to `{}` when unsupported. [src] `supportedOutputSchema`
- **Results.** `ToolExecutionSuccess {isError:false, value, content, meta?, additionalContexts?, concludesTurn?}` or `ToolExecutionFailure {isError:true, error:{message, info?:{name,code,reason?}}, content}`. Only `content`, `error` and `meta` are persisted. The canonical `value` is execution-local. [doc+src]

### 1.3 Execution pipeline. [src] `packages/core/tools/src/pipeline.ts`; [doc] `docs/tool-execution-pipeline.md`
Order of a call:
1. `tool/call` event is logged.
2. `tools/pre-execute` waterfall.
3. If a listener returned `ask`: `ctx.approval.request()`.
4. Monotonic guards.
5. `tools/execute` waterfall, wrapped around the body.
6. The body runs.
7. `projectContent`.
8. `tools/post-execute` waterfall.
9. `finalizeContent`.
10. `tools/result` emit (observe only).
11. `tool/result` event is logged.
12. The batch's `additionalContexts` are injected as user messages after the results.

```ts
'tools/pre-execute'(exec, next): Promise<PreToolDecision>
type PreToolDecision = {kind:'allow'} | {kind:'deny'; reason; info?} | {kind:'cancel'} | {kind:'ask'; reason?; displayReason?}
'tools/execute'(exec: ToolDispatchExecution /*may swap signal only*/, next): Promise<ToolExecutionResult>
'tools/post-execute'(exec, result, next): Promise<PostToolDecision>
type PostToolDecision =
  | {kind:'accept'; content?; additionalContexts?} | {kind:'accept'; value; additionalContexts?}
  | {kind:'block'; feedback: ContentBlock[]; additionalContexts?}     // becomes isError with feedback
'tools/result'(exec, result): void   // frozen, failures contained
```
All four are scope-filtered: a listener on `agent.ctx` sees only that agent's calls. [doc, events.ts]

What a plugin can do at each stage:
- **Block before the call.** Yes, with `deny`, which carries a model-facing reason and an optional `ToolErrorInfo`. Also with `guard()`, which only denies, so no later listener can re-allow the call. [src]
- **Ask for approval.** Yes, with `ask`. [src pipeline.ts:431-472]
  - The pipeline calls `ctx.approval.request({agent, toolName, callId, reason, displayReason, signal})`.
  - Only `allowed-once` proceeds. `rejected`, `cancelled` and `unavailable` each deny with a distinct reason.
  - With no approval service, or no agent on the call, it denies.
- **Rewrite arguments.** **NO.** This is deliberate: "Arguments cannot be rewritten because history, audit, UI, and execution must agree." [doc] A rewrite therefore has to be a deny plus corrective feedback, followed by the model retrying.
- **Rewrite or block the result.** Yes, in post-execute: replace content (the value is kept), replace the value (it is revalidated and the content re-rendered), or `block` (turns the call into an error with feedback). Context can be attached for the next step.
- **Retry, timeout or metrics around the body.** Yes, with a `tools/execute` wrapper. It may replace `exec.signal`, and the caller signal is re-fused. It cannot change call identity.
- **End the turn.** Only the **tool body** can, via `exec.concludeTurn()`.
  - The pipeline turns that into `concludesTurn:true` on the success result [src pipeline.ts:143,559-565]. The batch then reports `concluded` and the agent loop completes the turn [src agent-loop/src/agent.ts:597].
  - `PostToolDecision` has **no** conclude field, so post/pre waterfalls cannot end the turn directly.
  - Outside the pipeline, `agent.cancel(cause)` aborts a turn.
  - The experimental hook bridge has `TODO(hook-continue-false): needs a run-level halt mechanism` [src] `experimental/hooks-claude-code/src/index.ts:194`.
- **Unknown or throwing tools** become structured errors, for example `UNKNOWN_TOOL`. The turn does not end. [doc]
- **Implication for HeyAgent rule gates (before/after tool calls).** They map cleanly to agent-scoped `tools/pre-execute` (deny/ask) and `tools/post-execute` (block/annotate) listeners. Gates that need to edit args must instead deny with guidance.

### 1.4 Concurrency
- `agentLoop.config.maxParallelToolCalls`, default **10** [src] `core/agent-loop/src/constants.ts:6`, `agent-loop/src/index.ts:295`.
- Only calls whose `isConcurrencySafe(args) === true` join a parallel group. Every other call is an exclusive barrier: `ToolExecutionMode {kind:'parallel'|'exclusive'}`. [doc+src]
- The native executor's own default is also 10. [src] `tool-executor-native/src/index.ts:11`.

### 1.5 Guards. [src] `packages/guard/*`
- **`timeout-policy`** (`@deepseek-ai/dsh-tool-call-timeout-policy`).
  - It is a `tools/execute` wrapper. It reads `ctx.tools.get(name, agent).timeoutMs`; when that is absent there is no deadline at all.
  - It arms a deadline signal. On expiry it returns `isError` with code `TOOL_TIMEOUT`. It is cooperative: it never abandons the tool promise, so the tool must honour `exec.signal`. The whole plugin is 81 lines.
- **`repeat-tool-reminder`** is advisory and never vetoes.
  - It counts identical consecutive calls per agent, comparing canonical key-sorted args.
  - At the thresholds (default `[3,5,8]`) it adds a reminder through post-execute `additionalContexts`: a gentle one first, then a detailed one naming the tool and args.
  - Config: `thresholds`, `include`, `exclude`, `argumentsPreviewChars`.

### 1.6 Per-session / per-task tool sets (our HTTP tools, per-task tool selection)
There are three supported patterns, all verified to exist in source.

**(a) Register at agent creation.** A HeyAgent plugin does:
```ts
ctx.on('agent/created', async ({ agent, source, signal }) => {
  const specs = await db.toolsForSession(agent.session.id)        // our DB
  for (const s of specs) agent.ctx.tools.register({
    name: s.name, description: s.description, parameters: s.jsonSchema,   // raw schema OK; validate in execute()
    output: { schema: {}, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    timeoutMs: s.timeoutMs, isConcurrencySafe: () => s.readOnly,
    async execute(args, exec) { /* validate args, do HTTP with exec.signal */ },
  })
  if (taskAllowList) agent.ctx.tools.restrict({ allow: taskAllowList })   // names must be known globals
})
```
- It runs again on `resume`, so DB-sourced specs are reloaded after a restart.
- A tool-list change mid-session is handled through `tool-addition` / `tool-removal` content blocks (`ToolUpdate` / `toolHistory`). Expect a KV-cache cost.

**(b) Presets as compositions.** A preset is YAML or a programmatic list of plugin rows mounted into each agent's scope.
- Register one programmatically: `ctx.agentPresets.register({ id, name?, description?, order?, plugins: EntryOptions[] })` [src] `preset/agent-preset-registry/src/index.ts:97`, `definition.ts:5`.
- Select one: `ctx.agentPresets.select(agent, id)`. It throws `agent-preset/locked` once the session has started a turn. [src index.ts:365-371]
- The shipped presets are `bundle/web-app/presets/{standard,minimal,ptc,cordis}.patch.yml`. Tools come in by mounting tool plugins; there is no per-preset tool allow list beyond `tools.restrict`.

**(c) Conditional registration.** `when` per step, for example only for certain models or task phases.

`createMcpToolDefinition(ctx, opts)` [src] `mcp/mcp-client/src/tools.ts:251` is an exported example of adapting an external schema into a `ToolDefinition`. Use it as the template for HTTP tools.

---

## 2. MCP. [doc] `docs/subsystems/mcp.md`, `packages/mcp/mcp-client/README.md`; [src] selected files
- **`mcp-client`** is one plugin instance per server. It does *not* publish a `ctx.mcp` service.
  - Config: `serverName` (`[A-Za-z0-9_-]{1,32}`), `transport: 'stdio'|'streamable-http'`, `command/args/env/cwd`, `url/headers`, `toolCallTimeoutMs` (60 s), `startupTimeoutMs`, `closeTimeoutMs`, `expandTemplates` (`${credential:REF}`), `maxInstructionBytes` (32 KiB), `failOnStartupError`, `reconnect{enabled, initialDelayMs 500, maxDelayMs 30 s, maxAttempts 10}`.
  - Tool names are `mcp__<server>__<tool>`.
  - Server instructions become a scoped system-prompt section.
  - Images go through attachments. Prompts, elicitation, tasks and resource subscriptions are **unsupported**.
  - stdio env starts from a scrubbed parent env that drops `/KEY|PASSWORD|SECRET|TOKEN/i` and `DSH_*`.
- **Scope.**
  - The `serverName` reservation is per registration scope [src] `mcp-client/src/index.ts:55,213` (`scopeOf(ctx) ?? ctx.root`).
  - Mount it globally: a host-wide server visible to all agents.
  - Mount it into an agent scope: a **per-session server**. The two can reuse the same name.
- **Per-session MCP example, verified in source:** `experimental/browser-use-runtime/src/mcp.ts:131-157`.
  ```ts
  const scope = createScope(ctx, agent)
  await scope.ctx.plugin(McpClient, McpClient.Config({ transport:'stdio', serverName, command, args, cwd, failOnStartupError:true, reconnect:{enabled:false} }))
  // plus scope.ctx.on('tools/execute', ...) to refuse cross-session use; scope.dispose() to tear down
  ```
  The same approach works with `transport:'streamable-http'`.
- **`mcp-manager`** (`ctx.mcpManager`) is the **host-global** manager for servers configured in Settings or registered by plugins.
  - API: `list()`, `register(name, entry)`, `watch()`, `restart(name)`, `probe(name)`.
  - It is not per-session.
- **`mcp-resources`** (`ctx.mcpResources.register(server, provider)`) provides shared list/read resource tools for any scope that has at least one provider.
- **GAP / notes.**
  - Each stdio per-session server is a process per session.
  - There are no MCP OAuth flows in the client config beyond headers and credential templates. [doc]

---

## 3. Skills. [doc] `docs/subsystems/skills.md`; [src] `packages/skill/skill/src/index.ts:390,439`
```ts
ctx.skills.registerProvider(create: (control: { signal; invalidate(): void }) => SkillProvider): () => void
interface SkillProvider { name; list(opts:{cwd?,signal?}): Promise<SkillCandidate[] | {candidates, complete}>;
                          get(candidate, opts): Promise<SkillDefinition|undefined> }
interface SkillCandidate extends SkillSummary { rank: number; locator: unknown; metadata? }
interface SkillSummary { name /*kebab*/; description; whenToUse?; invocation:{modelInvocable,userInvocable}; source; provider; path?; resourceBase? }
interface SkillDefinition extends SkillSummary { content: string /*markdown*/; metadata? }
ctx.skills.register(skill: SkillRegistration): () => void   // one runtime skill, no provider
ctx.skills.list/snapshot/get(name, { scope, cwd, signal })
```
- **A DB-backed source works.**
  - Implement `list()` (DB query) and `get()` (load body by `locator`). Call `control.invalidate()` when a DB change notification arrives.
  - Virtual skills need no `path`. `resourceBase` may be `{kind:'opaque', description}` or `{kind:'url', url}`.
- **Scope.** Registration goes into the calling ctx's layer: register on `agent.ctx` for per-session skills, or globally. The nearest layer wins on a name clash; within one layer, `rank` decides.
- **How skills reach the model.** Through `tool-skill`, not the system prompt.
  - It injects a durable user-role `<system-reminder>` catalog (name and description only) at the first `agent/pre-step`, and replacements later [src] `tool-skill/src/index.ts:181,217,263`.
  - The `skill({name})` tool returns the body as `<skill_content>`, `<skill_resources>` and `<skill_instructions>`.
  - Bodies are re-read on every load and never cached.
- **Constraints.**
  - Names must be kebab-case.
  - The filesystem provider does not discover nested `**/SKILL.md`.
  - Catalog description bound: 500 chars by default.

---

## 4. LLM

### 4.1 Adapter interface. [src] `packages/llm/llm/src/index.ts:208-300`; [doc] llm-streaming.md
```ts
abstract class LlmAdapter {
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>        // the only required method
  providerInfo(p); providerRetryPolicy(p); imageRequestPricing(p,m); imageRequestTarget(p,m,img)
  listModels(p): Promise<LlmModelInfo[]>; resolveModel(p, m, signal): Promise<LlmResolvedModelInfo>
  prepareCall(p, m, signal): Promise<PreparedAdapterCall>
}
ctx.llm.registerAdapter(providers: string[], adapter): AdapterRegistrationHandle  // handle.replace(providers)
ctx.llm.registerConfigurableProviders([...]); ctx.llm.registerModelDiscovery(...)
ctx.llm.stream(GenerateOptions)   // direct one-shot; passes through 'llm/stream' waterfall (can short-circuit/route)
interface GenerateOptions { provider; model; reasoningEffort?; messages: RequestMessage[]; system?; tools?: ToolSchema[];
  toolHistory?; temperature?; maxTokens?; stop?; signal?; sessionId?; purpose? }
```
- **`StreamChunk` protocol.** `block-start` / `delta` / `block-end` indexed blocks, then `usage`, then `finish`. The rules: usage comes before finish; tool-call args stay raw JSON strings; an empty completion is `EMPTY_RESPONSE`; context overflow is `CONTEXT_WINDOW_EXCEEDED`; one call is one provider attempt (library retries disabled); a stream idle watchdog is required (default 5 min). [doc]
- **Content blocks:** `text`, `reasoning`, `image`, `file`, `tool-call`, `tool-addition`, `tool-removal`. [src] `llm/llm/src/types.ts:145-151`
  - Images are supported: `ImageAttachmentRef`, with per-route pixel and byte budgets and image offload.
- **Structured output / JSON schema.** **GenerateOptions has NO `response_format` / json_schema field.** [src] grep finds no `response_format` or `json_schema` in llm, core, subagent or workflow.
  - Structured output is done through a **tool**. Subagent `outputSchema` registers a scoped `structured_output` tool plus an instruction, and captures the validated args [src] `subagent/subagent/src/structured.ts:1-60`.
  - This sidesteps our custom-provider json_schema problem. A one-shot JSON call, such as our AI outcome review, would need either the tool trick or a custom adapter field.
- **Tool calling** goes through `tools` and `toolHistory`. The adapter declares `toolUpdate` / `systemPromptUpdate:'in-history'` capability, which allows cache-friendly appends instead of rewriting message 0. [doc]
- **Usage.** `TokenUsage { inputTokens /*uncached*/, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`. The counts are disjoint. [doc]
  - It is persisted on the `assistant/message` session event `usage?` [src] `core/session/src/types.ts:349-357`. pi-ai maps cacheRead and cacheWrite [src] `llm-pi-ai/src/stream.ts:29-30`.
  - **GAP: no monetary cost.** pi-ai's cost metadata is explicitly zeroed: "never reads pi-ai's cost metadata" [src] `llm-pi-ai/src/catalog.ts:35`, `replay.ts:64`. HeyAgent budget and cost tracking must stay ours.
- **`token-meter`** (`ctx.tokenMeter`) measures context *pressure* in tokens for compaction, from usage anchors or a heuristic. It does not do billing. [doc]
- **`llm-retry`** retries a failed step at the agent level through `agent/request-error`, using each provider's `retryPolicy`: `normal` (5 retries by default, retryable codes, backoff and jitter) or `always`. Direct `ctx.llm.stream()` calls are single-attempt. [doc]

### 4.2 Adapters shipped
- **`llm-pi-ai`** wraps `@earendil-works/pi-ai` ^1.3.0 [src package.json].
  - Config is `providers: { <route>: { apiKeyEnv, displayName, api, baseURL, models[], modelOverrides, compat, defaultContextWindow, defaultMaxTokens, image budgets, retryPolicy, headers } }`. [doc README]
  - Hand-declared wire protocols: **`openai-completions`, `openai-responses`, `anthropic-messages`** [src] `llm-pi-ai/src/provider.ts:47-51`. That covers any **OpenAI-compatible** gateway: set `api: openai-completions`, `baseURL`, and `models`.
  - **OpenRouter** is a pi-ai catalog provider (`env: OPENROUTER_API_KEY`, `https://openrouter.ai/api/v1`) [src] `provider-data.generated.ts:37`.
  - Endpoint model discovery uses `GET {baseURL}/models`.
  - `GenerateOptions.stop` is rejected with `UNSUPPORTED_OPTION`.
  - Plugins can add per-request headers through the `llm-pi-ai/request-headers` waterfall.
  - Credentials resolve through `ctx.credentials`. OAuth login is supported for catalog providers.
- **`llm-deepseek`** plus `llm-deepseek-api-key` / `llm-deepseek-account`: a direct DeepSeek Messages transport with a Files API and request extensions (`ctx.deepseekLlmApiExtensions`).

### 4.3 Configuration and per-session model
- **Provider routes are Cordis plugin config** (patch YAML / Settings). pi-ai validates and swaps them atomically at runtime through `handle.replace()`. [doc]
- **Per-session model.** `agent.model.select({provider, model, reasoningEffort?})` appends a durable selection to the session log, and the next step uses it [src] `core/agent/src/runtime-types.ts:54-72`.
  - Defaults can also come from `AgentOptions` at creation. A webhook `WebhookSessionRequest.model` is another source.
  - Subagents take an `agentOptions` override.
  - The `agent/request` hook is deprecated and must not change provider or model; changing them throws [src] agent-loop/src/agent.ts:635-640.

### 4.4 Adding an adapter (for example one wrapping the Vercel AI SDK)
1. Subclass `LlmAdapter` and implement `stream()`, translating to `StreamChunk`s.
2. Override `listModels` / `resolveModel`, which supply context window, `defaultMaxTokens`, reasoning efforts, `systemPromptUpdate` and `toolUpdate`.
3. Override `providerRetryPolicy`.
4. Send `attributionHeaders()`.
5. Call `ctx.llm.registerAdapter(['route-a', ...], adapter)` in `apply`.
Contract tests for the adapter rules are expected. A route name already owned by another adapter fails atomically. [doc+src]

---

## 5. Compaction and system-prompt assembly

### 5.1 System prompt. [doc] `docs/subsystems/system-prompt.md`; [src] `core/system-prompt/src/index.ts`
```ts
ctx.systemPrompt.section({ name, order, text: string | ((c: AssembleContext) => string), interpolate?, complete? })  // scoped
ctx.systemPrompt.context({ name, order, text, interpolate?, required? })   // cache-safe dynamic context -> durable user-role snapshot
ctx.systemPrompt.tools(provider); ctx.systemPrompt.suppressRuntimeContext()
'system-prompt/assemble'(assembly: PromptPresentation, context, next)       // waterfall over sections/contexts/variables
```
- Sections sort by order, then name. A `complete` section becomes the whole prompt.
- The rendered prompt is committed as a `system/message` surface node 0. Later changes either replace it in place or are appended after history, for routes that declare `in-history`.
- `{{variables}}` are interpolated. The persona slots are `deployment:persona-prefix` / `deployment:persona-suffix`.
- **Injecting HeyAgent rules, memories and task instructions.** In `agent/created`, use the following.
  - `agent.ctx.systemPrompt.section({name:'heyagent:rules', order, text: () => rulesFromDb})` for stable text.
  - `agent.ctx.systemPrompt.context({...})` for frequently changing facts. These are logged as a user-role snapshot only when they change, which keeps the prompt cache.
  - `agent.inject(userMessage)` / `agent.followup()` / `agent.steer()` for messages.
  - A `dsh-persona` preset row to override identity or the whole prompt.
- **`agent-instructions`** loads AGENTS.md chains (64 KiB budget in the standard preset). `time-context` is another context plugin.

### 5.2 Compaction. [doc] `docs/subsystems/compaction.md`, config-catalog
- **Seam:** `ctx.compaction` (`compactIfNeeded(agent, trigger, signal)`, `compactNow`, `compactRegion`). The backend is `compaction-basic`, with manual `/compact` from `command-compact`.
- **Events:**
  - `compaction/start` / `summary` / `end` are log-only lock brackets. An orphaned start means a crash.
  - The summary rides on a `user/message` with `surfaceOp: replace`.
- **Triggers:**
  - pressure at `agent/pre-step` and `agent/request`;
  - context overflow through `agent/request-error`, which retries the step.
- **`compaction-basic` config:**
  - `thresholdRatio` 0.8, `headroomTokens` 65536, `retainRatio` 0.16 or `retainTokens`;
  - `summarizationProvider/Model` (a separate cheaper model is possible), `maxTokens`, `compactionRetries` 1, `maxOverflowRetries` 1;
  - `modelPolicies[]` per provider/model, and `auto`.
- **`compaction-tool-result-pruner`** trims old tool results before summarizing. Standard preset: `thresholdChars` 8192, head 4096, tail 1024.
- **`compaction-image-offload`** drops old images.
- **Survival:** the system prompt sits outside the compacted surface. The skill catalog is re-established after compaction hides it [doc skills.md].

---

## 6. Interaction, approvals, goal, deliverables

### 6.1 Approval. [doc] `docs/subsystems/approval.md`; [src] pipeline.ts
- **`ctx.approval.request({agent, toolName, callId?, reason?, displayReason?, signal?}) → 'allowed-once'|'rejected'|'cancelled'|'unavailable'`**
  - It **requires an open turn**: an idle ask rejects.
  - It logs `approval/asked` and `approval/decided`, which are log-only.
- **Answerers:**
  - `'approval/request'` waterfall, agent-scoped. The UI is one answerer and ACP another.
  - With no answerer, the result is `unavailable`, which fails closed.
- **Policy:** per session `'ask'|'never'`, set with `setPolicy(agent, p)` or `setApprovalPolicy(session, p)`. It is replayed from the log.
- **Producers of `ask`** [src grep]:
  - sandbox escalation (bash/fs `sandbox_permissions`, `sandbox/src/escalation.ts`);
  - `hooks-claude-code`;
  - `auto-review`.
  - Any HeyAgent rule plugin can return `{kind:'ask'}` too.
- **Permission presets** (`ctx.permissionPresets`) bundle `sandbox/mode` with `approval/policy`.
  - Defaults: `workspace-write` (`workspace-write` + `ask`) and `danger-full-access` (`danger-full-access` + `never`).
  - `auto` is reserved for auto-review.
  - The service requires a confining `ctx.shell`. [doc]
- **GAP: one-shot only.** `allowed-once` is the only grant; there is no "always allow" persistence in the approval seam. The `approval` *question intent* has an optional `always` label, but the caller must persist that grant itself. [doc user-questions.md]

### 6.2 User questions / `ask_user_question`. [doc] `docs/subsystems/user-questions.md`, `interaction/user-questions/README.md`
- **`ctx.userQuestions.ask(req)` / `askTimed(req)`.** Questions have `id`, `question`, `detail`, `header`, `options[{label,description}]`, `multiSelect`, `intent: plan-review|approval`. The answer is `answers[{id, selected[], custom?}]`.
- **Tool `dsh-tool-ask-user`** config: `mode: 'legacy'|'timed'` (default **legacy = blocking**) and `timeout` (default 120 s).
- **Blocking (legacy) mode.** The tool call, the turn and the agent stay `running` in process until answered.
  - On a **process crash or restart**, session repair appends a synthetic `TOOL_OUTCOME_UNKNOWN` result and the question becomes `continued` [src] `core/session/src/repair.ts:18,31-37`.
- **Timed mode.** When the foreground window expires, the tool returns `{pending:true, callId}` and the turn can finish. The question stays answerable **indefinitely**.
  - Answering through the `answer` Remote method enqueues a `user-question-reply` user message and wakes the agent.
  - It "resumes its root agent first" for a closed Session, and "After a Host restart, the Remote layer resumes the root agent when the Session reopens. A late reply then enters a new turn."
  - `REPLY_QUEUED` dedup holds across restart. The question state is a projection over the session log; no separate store exists.
- **Delegated (runtime-owned) subagents cannot ask the user**: `DELEGATED_CALLER`. [doc tool-ask-user README:157]
- **Can an agent pause for days, survive restart and resume on another process?**
  - **Questions: yes, in timed mode.** The wait is durable as log projection plus a new turn on reply.
  - **Approvals: NO.** An approval ask is an in-memory promise inside an open turn. A restart loses it: the call becomes `TOOL_OUTCOME_UNKNOWN`, and the model must retry, which triggers a fresh ask.
  - **Another process.** Session JSONL persistence enforces **one live writer per session**: an `flock` on `session.lock` [doc] `session/session-persistence-jsonl/README.md:168`. A second process can open the session after the first exits or crashes, because the lock dies with the process. It is unreliable on NFSv3. There is no cluster-level handoff or lease logic.
- **GAP for HeyAgent's "等人处理 for days".**
  - Model the wait as a timed question, or as our own durable "needs human" state that finishes the turn and later resumes it with `agent.followup()`.
  - Do not hold approvals for days.
  - Interrupted turns are **not** auto-continued after a crash: repair closes them and the agent goes idle. We need our own "resume run" driver.
- **`session-checkpoint-policy`** makes the log durable before every model request and every top-level tool body, failing closed. Interrupted tools recover as outcome-unknown, never auto-retried. [doc]

### 6.3 Goal. [doc] `docs/subsystems/goal.md`, package READMEs
- **`dsh-goal`** stores one durable objective per session, event-sourced with compare-and-set on `{id, revision}`.
  - Phases: `active|paused|blocked|complete`. `blockedReason{code,message}`. `maxGoalRounds` defaults to 256.
- **`goal-round-driver`** auto-continues an active goal while the agent is idle.
- **`tool-goal`** provides `get_goal` / `create_goal` / `update_goal`.
- **Continuation permission ("activation") is process-local and NOT durable.** After a restart the goal is active but disarmed until resumed.
- **Fit:** this is roughly HeyAgent's "run until done" loop. Our "没完成 / not done + checkpoint backstop" semantics would map onto `blocked` / `complete` plus our own policy.

### 6.4 Deliverables. [doc] `docs/subsystems/deliverables.md`
- **`tool-present`:** the model calls `present` with file paths and descriptions. A log-only event records `PresentedFile{path, description?}`. **No copy is made**: contents stay at the source path.
- **`workspace-changes`:** a per-turn git or snapshot diff summary held on the Host while the session lives.
- **GAP:** no artifact store is involved. HeyAgent's "交付物" (deliverables field plus files in our space) still needs our storage. `ctx.attachments` exists for binary blobs (not deep-dived).

---

## 7. Sub-agents and teams. [doc] `docs/subsystems/subagent.md`, package READMEs; [src] `subagent/subagent/src/{manager,structured,descriptor}.ts`
- **`ctx.subagents.startActivation(spec) → { childId, messageId?, result: Promise<SubagentResult>, dispose() }`**
  - `spec = { provider, label, prompt: ContentBlock[], parent: Agent, signal, delivery: 'parent'|'caller', cwd?, agentPreset?, agentOptions?{provider,model,reasoningEffort,maxTokens}, outputSchema?: ObjectJsonSchema, maxDepth?, childId? }`.
  - `SubagentResult { output: ContentBlock[]; structured?; diagnostic?; stopReason: 'completed'|'aborted'|'error'|'max-tokens'|'refusal' }`.
- **Providers:**
  - **`spawn`** (in process, fresh history): the child shares the process, the LLM and tool services, and the parent's model unless overridden. It is the only provider that supports an independent `agentPreset`.
  - **`fork`** (in process, seeded with the parent's completed turns).
  - External one-shot providers, which accept no follow-ups:
    - **`acp`** (a fresh subprocess speaking ACP);
    - **`dsh-sdk`** (a fresh dsh subprocess with its own profile);
    - **`codex`** and **`claude-code`** (native CLIs, unattended);
    - experimental **`subagent-oar`**, which embeds the OAR library for Codex and Claude Code.
- **Local children:** each has a durable Session of its own and at most one live activation. They accept `send_message`, can be cold-resumed later, and the catalog projection `subagentCatalog` lists them.
- **Limits** (`dsh-subagent` config):
  - `maxActiveSubagents` (default **8**) per tree. Admission **does not queue**: it rejects with `ACTIVATION_LIMIT_REACHED`.
  - `maxDepth` (default **1**).
  - `tool-subagent` takes `maxDepth: number | 'provider-managed'`.
  - Slots are process-local.
- **How the parent waits:**
  - The model-facing `subagent` tool **returns a child id immediately**, without blocking. On completion, a user-role `subagent-settled` notice is delivered to the direct parent, waking it if idle.
  - The parent can call `wait_agent` (tool-subagent-control) to wait on its own inbox. `list_agents`, `send_message` and `interrupt_agent` are also available.
  - With `delivery:'caller'` (workflows and code), the caller awaits `result`.
- **Structured result:** `outputSchema` works through the `structured_output` tool (§4.1).
- **GAPS:**
  - "Parent delivery … **does not restore an offline parent**" [doc subagent README:170]. If the parent session is unloaded or restarted when the child finishes, the notice is not delivered. HeyAgent must persist and deliver the result itself.
  - Runtime-owned children cannot ask humans.
  - External providers are single-shot.
- **Teams** (`team/agent-team`, `tool-agent-team`): a shared task board over the subagent tree, with `TeamId` equal to the root SessionId and `task-<n>` ids. Members use ordinary subagent messages. Task changes neither wake agents nor deliver messages. [doc]

---

## 8. Background jobs, schedule, webhook

### 8.1 Jobs. [doc] `docs/subsystems/jobs.md`, `jobs/*/README.md`
- **`ctx.jobs`** registers producers through a `JobSpec` with `run(handle)`. Ids look like `<kind>-<16 hex>`.
  - Status: `running|stopping|completed|killed|failed`.
  - An output ring holds results. Log-only `job/registered` and `job/settled` events are written to the owner Session.
- **`tool-jobs`** provides `job_output` (wait with timeout), `job_list` and `job_kill`.
  - A completion notice is pushed in-session and wakes an idle agent. There is an optional wakeup cap.
  - Bash `run_in_background` and `workflow run_in_background` produce jobs.
- **Persistence: none for execution.** "Jobs managed by the shipped in-process registry die with the harness process; durable execution across restarts needs a different backend". The contract is in-process and needs reshaping to go cross-process. [doc jobs/README:57,128] Pending notices do not survive owner disposal.

### 8.2 Schedule. [doc] `docs/subsystems/schedule.md`, `schedule/AGENTS.md`
- **Durable host tasks** in the storage domain `schedule`: JSON at `<DSH_HOME>/storages/schedule.json` or SQLite, with whole-unit rows holding JSON text.
  - Timing kinds: `after|at|every(≥60s)|daily|weekly|cron(5-field + tz)|rrule`.
  - Targets: an existing `session`, `new_once` (one reserved session, then reused), or `new` (a session per delivery).
  - Management API: `create/list/catalog/view/history/edit/deleteInactive/run/deliveryLimits`. `tool-schedule` gives the model tool access.
- **Delivery:**
  - A single Host timer and one FIFO. Each delivery enqueues a user message with source `schedule` into the session inbox, then writes a receipt. The two writes are not atomic, so **a crash can duplicate a delivery**.
  - There is a per-task minimum interval of 60 s. While the timer is down, missed occurrences coalesce into one (latest-only catch-up).
  - There is no generic retry loop. "The Host must be running."
  - All tasks are loaded into memory when the Host opens.
- **Multi-process:** there is no distributed lock or lease. Two Hosts sharing the store would both fire. **GAP** for a multi-instance HeyAgent: we need to run one scheduler instance or add a lease.

### 8.3 Webhook (experimental). [doc] `docs/subsystems/webhook.md`
- **`ctx.webhookRuntime.register(rule: { id, kind, run(delivery, signal) → null | WebhookSessionRequest })` and `dispatch(delivery)`.**
  - `WebhookSessionRequest` = `{ workspacePath, title, prompt, agentPreset, permissionPreset, model? }`.
  - It creates a root Session and sends a `webhook`-source follow-up.
- **Fire-and-forget**: "no queue, retry, deduplication, execution status, crash replay … or completion result". Repeated deliveries can create repeated sessions.
- **Adapter:** `webhook-github` (HMAC verification, returns 202).

---

## 9. Sandbox, code execution, PTC, workflows, routines

### 9.1 Sandbox. [doc] `docs/subsystems/sandbox.md`; [src] `sandbox/sandbox-local/src/profiles.ts`
- **`SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`.** It governs **file effects only**: "Network and process visibility are outside this vocabulary".
- **Policy per call:** `{ mode, workspaceRoot, additionalWritableRoots?, sessionId? }` through `ctx.sandboxPolicy.resolve({session, mode?})`. The provider reports enforcement as `full` or `partial`.
- **Linux bwrap profile** [src profiles.ts:17-20]: `--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent`, then `--tmpfs /tmp` and `--bind <root> <root>` for each writable root.
  - **There is no `--unshare-net`**, so the whole host FS is readable. Landlock and macOS Seatbelt are the alternatives.
- **Escalation:** the bash and fs tools take `sandbox_permissions`, which triggers an approval ask (`sandbox/src/escalation.ts`, `WIDER_MODES`).
- **GAP (critical for routines and code.run):**
  - no network or egress control;
  - no read confinement (`/` is read-only bound, but still readable);
  - no secrets isolation beyond env scrubbing.
  - HeyAgent's bwrap plus egress proxy (with `--unshare-net`) must be retained or added as a new sandbox backend.

### 9.2 Shell, subprocess, terminal. [doc]
- **`ctx.shell`** (bash and pwsh providers; `bash-sandbox` wraps commands through `ctx.sandbox`). `tool-bash` supports `run_in_background` via jobs.
- **`ctx.subprocess`:** a managed process range, with `scrubbedParentEnv()` and `DSH_*` env.
- **`ctx.terminals`:** persistent PTY sessions owned by the exact Agent (experimental `tool-terminal`).

### 9.3 PTC (programmatic tool calling). [doc] `docs/subsystems/ptc-runtime.md`, `ptc-runtime-node/README.md`, `tool-executor-ptc/README.md`; [src] `ptc-runtime/ptc-runtime/src/index.ts:105-169`
- **What it is.** With the PTC executor selected, as in the `ptc` preset, the model sees **only `run_code`**.
  - It writes TypeScript that calls a generated typed SDK: `tools.<name>(args)`.
  - Every sub-call goes through the **same tool pipeline**: visibility, pre/post-execute, approvals and guards. It carries the parent token, is logged as a `tool/ptc-dispatch` event, and denials come back as typed rejections.
  - A direct model call to a native tool name is refused with `UNKNOWN_TOOL`.
- **Runtime seam:**
  ```ts
  abstract class PtcRuntime { language; isolation; programFormat; retainsState; sandboxMode; timeout;
    resolve(req: PtcRunRequest): PtcRunSpec; run(spec): Promise<PtcRunResult>; release(owner) }
  interface PtcRunRequest { program; bindings: PtcBindingNamespace[] /*{global, functions, errorClass?}*/; cwd?; timeoutMs?: number|null; sandboxPolicy?; stateOwner?; signal? }
  interface PtcRunResult { value?: JsonValue; logs: string[]; error?: PtcRunFailure /*exception|timeout|abort|protocol|sandbox-unavailable|worker-exit*/; sandbox? }
  ```
- **`ptc-runtime-node` modes:**
  - `per-call`: a fresh Node process per run; async function body.
  - `vm-script`: top-level await; optional retained context.
  - `persistent-in-memory`: a REPL per Agent.
  - Limits: `timeoutMs` 120 s default, `maxTimeoutMs` 600 s, `null` means none for service callers; V8 old-gen 512 MB (not a process-tree memory limit); output caps.
  - Programs run under the file sandbox policy. Unavailable confinement fails the run.
  - **"Direct filesystem, network and subprocess operations remain Node operations, subject to the selected OS sandbox"**, so a program has full network access.
  - There is an experimental Python runtime (`experimental/ptc-runtime-python`).
- **Can it host HeyAgent "routines" (deterministic replay without the model)?** **Yes, mechanically.**
  - Host code can call `ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program: routineScript, bindings: [{ global: 'tools', functions: {...} }], sandboxPolicy, timeoutMs, signal }))` with no model step.
  - The bindings are arbitrary host async functions. Route them through `ctx.tools.execute({ calls, agent, signal })`, which works without `log` for programmatic calls, so rule gates still apply.
  - **Caveats:**
    1. `approval.request` needs an open turn, so `ask` gates fail closed outside a turn.
    2. There is no egress control (§9.1).
    3. Retained state is never durable.
    4. Without `log`, root call/result events are not written. We must log routine steps ourselves or run them inside a turn.

### 9.4 Workflows. [doc] `docs/subsystems/workflow.md`
- **`ctx.workflowEngine`** (one engine; `workflow-ptc` runs on the Node PTC runtime). The model-facing `workflow` tool takes `{script, meta{name,description,whenToUse?,phases?}, args}`.
  - Script hooks: `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`. They **orchestrate subagents only**; there is no direct tool binding.
  - It returns a JSON `value` with `stopReason: completed|cancelled|error`.
  - There is no overall deadline. It can run in the background as a job.
  - Experimental `tool-ralph` is a loop built on it.
- **Fit:** it suits LLM fan-out. It does **not** suit deterministic tool routines; use PTC (§9.3).

---

## 10. auto-review (experimental). [src] `packages/experimental/auto-review/src/index.ts` (803 lines); [doc] README
- **What it does exactly.** It is a **pre-tool-call LLM safety reviewer**, not a post-run outcome review.
  - A `tools/pre-execute` listener (`prepend:true`, index.ts:741) runs only when the session's permission preset is `auto`, which means `danger-full-access` plus `ask`.
  - For every native call and every PTC inner call (it skips the outer `run_code`), it asks the **current agent's provider and model**, through `ctx.llm.stream({ system: REVIEW_POLICY, messages: snapshot, temperature: 0, purpose: 'auto-review' })` (index.ts:680-692). This request is **never logged to the Session**.
  - The reviewer's reply must be reasoning blocks plus exactly one JSON text block (`readDecision`, index.ts:643).
  - Its policy: project-local work is allowed. Irreversible deletion, production operations, external writes and security changes need explicit user or direct-parent authorization. Exfiltration is always denied. Ambiguity is denied.
- **Outcomes:**
  - allow: proceed;
  - deny with session policy `never`: final deny `AUTO_REVIEW_DENIED`;
  - deny otherwise: `{kind:'ask'}`, which escalates to a human approval;
  - reviewer failure: deny `AUTO_REVIEW_FAILED`.
  - It costs extra tokens per tool call.
- **GAP / relevance:**
  - It does **not** replace HeyAgent's "AI outcome review (运行结果复核)". That would be a new plugin, for example on `agent/turn-stopping` or a run-finish hook, making a one-shot `ctx.llm.stream` call with structured output through a tool or JSON parsing.
  - It is a good **template** for an LLM-judged rule gate on tool calls.

---

## Gap summary vs HeyAgent needs
| Need | dsh status | Work needed |
|---|---|---|
| Rule gates before/after tool calls | pre-execute deny/ask, guards, post-execute block/replace, all agent-scopable [src] | Port rules into a plugin. No arg rewrite. Ending a turn only from the tool body. |
| DB-sourced HTTP tools, per-task tool sets | `agent.ctx.tools.register` in `agent/created` (reruns on resume), `restrict`, presets, `when` [src] | Write an HTTP-tool adapter; `restrict` allow lists must name known globals |
| Per-session MCP | mount `mcp-client` in an agent scope (pattern in browser-use-runtime) [src] | Small plugin |
| Skills, memories, rules from DB | `skills.registerProvider` with `list`/`get`/`invalidate`; `systemPrompt.section/context` [src+doc] | Providers. Skills reach the model as a catalog reminder plus a `skill` tool, not inline. |
| OpenRouter, OpenAI-compatible, per-session model | pi-ai routes; `agent.model.select` [src] | Config. **No response_format/json_schema**; structured output goes through a tool. **No $ cost.** |
| Pause for days waiting on humans, survive restart | timed questions: durable and resumable [doc]. Approvals: in-memory only. Interrupted turns repaired as `TOOL_OUTCOME_UNKNOWN`, not auto-resumed [src] | Our own durable needs-human state and a resume driver |
| Multi-process / multi-instance | JSONL one-writer `flock` per session; jobs process-local; schedule has a single timer and no lease; subagent notices lost if the parent is offline [doc] | A lease or ownership layer; a single scheduler; durable job and child-result delivery |
| Checkpoints | `session-checkpoint-policy` makes the log durable before requests and tool bodies [doc] | Our "checkpoint" semantics (progress gates) remain ours |
| AI outcome review | absent; auto-review is a per-call safety gate [src] | New plugin |
| Routines (scripts without the model, bwrap + egress proxy) | `ctx.ptcRuntime.run` with custom bindings works [src]; sandbox has **no network control**, reads all of `/` [src] | Keep our egress-proxy sandbox (new sandbox backend or a wrapper); log routine steps ourselves |
| Scheduled task runs | durable schedule with cron/rrule, `new`/`new_once` session targets [doc] | Can fit; crash may duplicate a delivery; single host |
| Deliverables | `present` records paths only [doc] | Keep our deliverables storage |
