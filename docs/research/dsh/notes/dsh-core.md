# dsh core runtime — facts for the HeyAgent → dsh-fork target architecture

Source: DeepSeek Harness (dsh) commit `8bd07339`, v0.2.2-alpha.3, read-only at
`deepseek-ai/deepseek-harness@8bd07339 的本地克隆`. All paths below are repo-relative.

Markers:
- **[SRC]** verified by reading the TypeScript source.
- **[DOC]** stated in docs/README only (not cross-checked in source).
- **[INF]** my inference from the source/docs. Not a dsh claim.

Severity tags for the HeyAgent server target (multi-user, multi-process, Postgres):
**BLOCKER** = must be rebuilt or replaced before the target works. **RISK** = works but needs a design decision or extra code. **OK** = usable as is.

---

## 0. Executive summary (one screen)

1. dsh is one **Cordis plugin tree per OS process**. The agent loop, session store, tool registry, approvals, jobs, schedule, projections and caches all live in that process's memory. Nothing in the core does clustering, distributed locking (apart from the JSONL file lease), remote workers or work queues. [SRC/DOC]
2. The loop runs **headless**. `packages/bundle/headless` is a 465-line reference driver that calls `ctx.agents.create/resume`, `agent.followup()`, `agent.whenIdle()` and `ctx.sessions.flush()` with no HTTP, Host or Web layer. A HeyAgent worker would be a plugin of the same kind that pulls runs from pg-boss. [SRC]
3. One process can host **many agents** at once: `AgentRegistry` is a `Map<SessionId, AgentEntry>`, with no cap and no idle eviction in core. Each live agent keeps its **whole session log in memory** (`Session.log` array). [SRC]
4. Session durability goes through one abstract seam, `SessionPersistence` (`create/open/stat/list/flush` plus a per-session `SessionHandle` with `read/append/flush/close`). It ships a reusable contract test suite, and a Postgres backend is feasible (sketch in section 3.6). The docs mention an `export` method, but the abstract class has **no `export`**. The fifth member is `flush()`. [SRC]
5. Cross-process single-writer safety today is a kernel `flock` on `session.lock` (JSONL provider only). The seam guarantees exclusion **only within one backend instance**, so a PG backend must add its own (advisory lock or fenced lease). [SRC + README limitation]
6. `packages/storage/*` (generic KV) loads each **whole unit into memory** at open, serializes writes on a per-process chain and has **no cross-process change notification**. storage-json has no cross-process lock. Adding a PG `StorageBackend.kv` is mechanically easy, but multi-process coherency is not provided. **RISK/BLOCKER** for schedule and workspace.
7. Settings are **plugin Config persisted into the profile's `cordis.patch.yml` on disk**. Credentials are a `CredentialProvider` seam whose shipped provider is `$DSH_HOME/.credentials.yaml` + env + `.env`. Both are **process-global with no user dimension** in their signatures. **BLOCKER** for per-user settings and keys (needs new providers and consumer changes).
8. Agent presets (`packages/preset/agent-preset-registry`) give **per-session tool, prompt and skill composition inside one process**: the preset's plugin rows mount into an isolated scope, and the agent binds to it in `setup`. This is the right lever for HeyAgent "roles/task types". **OK**
9. Outbound by default: `session-telemetry-otel` (feedback-only, to `dsh-otel-collector.deepseeksvc.com`), `session-log-deepseek` (**uploads the session log inside every llm-deepseek request, enabled by default**), `plugin-package-inventory-deepseek`, `web-search-deepseek`/`web-deepseek-api`, `deepseek-account-platform`, plugin-manager/market (npm registries, jsDelivr/unpkg/npmmirror), desktop product analytics, the Electron updater, and the anonymous id file. `DSH_TELEMETRY_DISABLED` disables **only** the `session-telemetry-otel` row. Everything else must be removed by patch or fork. Details in section 6.
10. Web auth model = **one owner per process** (process token) plus non-owner "Peers" gated by `remote-access`. There are no user accounts. This is out of my slice but a **BLOCKER** for multi-user Web if the dsh Web is reused.

---

## 1. Cordis basics as used by dsh

### 1.1 Plugin shapes [SRC]
Two forms (rule in `packages/AGENTS.md`; mixing them breaks Loader namespace handling, see `docs/postmortem/0001-...`):

**Function plugin** (named exports, no default export), e.g. `packages/bundle/headless/src/index.ts`:
```ts
export const name = 'headless-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessions']
export interface Config { task?: string; sessionId?: string; json?: boolean; ... }
export const Config: z<Config> = z.object({ task: z.string(), ... })   // @deepseek-ai/schemastery
export function apply(ctx: Context, config: Config): void { ... }
```
**Service plugin** (default-export a `Service` subclass), e.g. `packages/core/agent/src/index.ts`:
```ts
declare module '@deepseek-ai/cordis' { interface Context { agents: AgentRegistry } }
export class AgentRegistry extends Service {
  static inject = ['sessionProjections']
  constructor(ctx: Context) { super(ctx, 'agents') ... }
  protected async [Service.init](): Promise<void> { ... }   // async init hook
}
export default AgentRegistry
```
- `ctx.<key>` is only for declared injections. Optional services are read with `ctx.get('name')`, which goes to the global store (packages/AGENTS.md; the headless runner does `ctx.get('sessionPersistence')`).
- `ctx.inject(['x'], (child) => …)` makes a nested sub-plugin that activates when `x` exists. Agent-loop uses it, for example, to defer config-agent resume until `sessionPersistence` exists. [SRC `packages/core/agent-loop/src/index.ts:358`]
- Config validation uses schemastery `z`. `.volatile()` fields are live-editable through the settings service (e.g. `maxParallelToolCalls: z.number()...volatile()` in AgentLoop). [SRC]

### 1.2 Effects / disposal [SRC]
- Every registration returns a disposer that is bound to the registering fiber. Disposing the fiber unwinds it (HMR-safe). The pattern is `ctx.effect(function* () { yield disposer; ... }, 'label')`, with LIFO unwinding. See `JsonlBackendTracker.install()` in `packages/session/session-persistence-jsonl/src/storage.ts`, which installs `ctx.on('session/event'|'session/flush'|'session/disposed')` plus a close-all-handles effect.
- `ctx.plugin({ name, apply })` mounts a child plugin and returns a `Fiber` (`await fiber.await()` / `fiber.dispose`).

### 1.3 Events / dispatch modes [DOC docs/cordis-primer.md, SRC event decls]
`emit` (sync fire-and-forget), `waterfall` (around-middleware `(…args, next)`), `parallel`, `serial` (awaited, in order), `bail`. Events are declared by module augmentation of `cordis.Events`, with an `@mode` JSDoc tag. Agent-scoped events take `this: Scoped<Agent>`. Listeners registered on `agent.ctx` receive only that agent's events (`@deepseek-ai/dsh-scope`, `docs/subsystems/scope.md`).

### 1.4 Isolation / realms [DOC docs/cordis-api/context.md, SRC presets]
- `ctx.isolate(name, label?)` creates a child context in which service `name` resolves against a new label. Loader YAML exposes this as a `cordis:group` row with `isolate: { serviceName: true }`. Example in `packages/bundle/web-app/presets/standard.patch.yml`: a group with `isolate: { planMode: true }`, and one with `{ compaction: true, toolResultPruner: true }`.
- Rule (architecture.md "Where new behavior goes"): *"Give one session a different capability set → compose an agent preset; a service row there needs an `isolate` realm."* The preset README adds: *"Entry-local isolation does not propagate through the Agent registration scope: ordinary Context lookup outside the group, including `agent.ctx`, still selects the Host realm. `agentPresets.serviceFor()` explicitly inspects the retained composition."* [DOC]

### 1.5 Loader YAML, bundles, profiles, patches [SRC yml + DOC app-boot README]
- A row has `id`, `name` (package spec or `cordis:group`), `config`, `disabled` (may be `!!js` expression), `inject`, `group`, `isolate`. `!!js` is evaluated at mount. Helpers available in expressions include `dshHomePath(...)`, `process.env`, and `ctx.get(...)`.
- Patch ops: `- id: X` + `config:` **replaces the whole config** of row X. `- id: X disabled: true` disables it. `- insert: [rows]` adds rows. The last layer wins per row id. [SRC comments in `packages/bundle/base/cordis.patch.yml`]
- **Bundle** = npm package with `package.json#dsh.bundle.patch` → one or more `cordis.patch.yml`. Shipped: `packages/bundle/{base,web-app,headless,sdk-app,acp-app,sdk-minimal}`.
- **Profile** = `$DSH_HOME/profiles/<name>/` holding a package.json with `dsh.profile` (ordered bundle list), installed out-of-tree packages (pnpm-managed `node_modules`), and the user's `cordis.patch.yml`.
- Layer order: profile bundles (in order) → profile `cordis.patch.yml` → home `$DSH_HOME/cordis.patch.yml` → `--patch <path>` overlays. [DOC architecture.md, app-boot README]
- `--dump-config` prints the composed tree. `--from-default-profile <template>` creates a custom profile from a shipped template. `dsh plugin --profile <name> add <pkg>` installs bundles. [DOC docs/cli-help.md]
- Profiles in the base bundle: `web`, `headless`, `sdk`, `sdk-minimal`, `acp`. `headless`/`sdk`/`acp` disable `hmr`. `headless` also disables `credentials`, `authorization` and `deepseek-account` (it uses launch-env credentials). [SRC yml]
- Several base rows are `disabled: !!js "!ctx.get('profileContext')"` (plugin-manager, hmr, config-editor, settings). They only run when the launcher supplies a profile. [SRC]

### 1.6 Writing and mounting a new plugin package [DOC docs/cookbook/adding-a-package.md, packages/AGENTS.md]
- In-tree: `packages/<group>/<pkg>/{package.json,tsconfig.json,src/index.ts,README.md,locale/*.json}`. It is `private: true`, `type: module`, `main: lib/index.js`, with `@deepseek-ai/cordis` as both peer and dev dependency and schemastery in deps. Register it in `tsconfig.host.json`. Constraint scripts enforce README sections ("Model Experience", "Known Limitations").
- Out-of-tree: publish as npm, install into a profile through `dsh plugin ... add`, and mount by `insert` in a bundle/profile patch. A minimal plugin is the tool example in `docs/cordis-tutorial/07-into-the-harness.md` (`inject = ['tools']`, `ctx.tools.register(defineTool({...}))`).
- **[INF]** For a HeyAgent fork, the simplest path is an in-repo group (e.g. `packages/heyagent/*`) plus one new bundle `packages/bundle/heyagent-worker` layered over `dsh-base`, the same way `headless` is.

### 1.7 Agent presets — per-session tool/prompt/skill set [SRC `packages/preset/agent-preset-registry/src/index.ts`, DOC README]
- `@deepseek-ai/dsh-agent-preset-registry` (`ctx.agentPresets`) has config `{ default: string (required), selectedDefault?: volatile string }`.
- Each preset is an ordinary row `@deepseek-ai/dsh-agent-preset` with `config: { id, order, plugins: [ ...entry list... ] }`. `plugins` is a full Loader entry list: tools, persona, `skill-filesystem`, `cordis:group` with `isolate`, and so on.
- At `register()` each definition gets a registry-owned scope (`createScope`) and an **in-memory Loader tree** (`mountPreset`). Updates create a new *generation*. Old generations stay alive while agents still reference them.
- Binding: in the agent's `setup` callback call `await ctx.agentPresets.mount(agentCtx, presetId?)` (it binds the unpublished agent to the current generation). Children inherit through `composeFrom(childCtx, parentCtx)` (called in `packages/subagent/subagent/src/child-agent.ts:201`). `presetForSession(session)` reads the durable `agent-preset/selected` projection. The `SessionHeader.agentPreset` field records the creation preset.
- On restart, resume uses the **current** definition of the recorded preset id and rejects a missing definition (README). Presets are **not security sandboxes**, because YAML/plugins execute host code. [DOC]
- **[INF] OK for HeyAgent:** map "task type / role config" to presets. But HeyAgent's per-task configs are DB rows edited by users, while presets are Loader rows (YAML in a patch). Two options: generate preset rows dynamically (registry has `register(definition)`, so a plugin can call it at runtime from DB rows), or build the composition in `setup` directly with `agentCtx` registrations (scoped tools/prompt sections). Both stay in one process.

---

## 2. Agent: `core/agent` + `core/agent-loop`

### 2.1 Packages and keys [SRC]
| Package | Key | Role |
|---|---|---|
| `packages/core/agent` | `ctx.agents` (`AgentRegistry`) | Live registry, `create/resume` facade, initiator (AsyncLocalStorage), `agent/*` event decls, inbox & modelSelection projections |
| `packages/core/agent-loop` | `ctx.agentLoop` (`AgentLoop`, implements `AgentFactory`) | `ReactLoopAgent` driver. `static inject = ['agents','sessions','llm','tools','systemPrompt','sessionProjections']` |
| `packages/core/session` | `ctx.sessions` (`SessionStore`) | In-memory `Session` objects, `session/*` events |
| `packages/core/tools` | `ctx.tools` | Scoped registry and execution pipeline |
| `packages/core/system-prompt` | `ctx.systemPrompt` | Prompt sections and tool schema assembly |

### 2.2 Create / resume API [SRC `packages/core/agent/src/index.ts`]
```ts
ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>
ctx.agents.resume(options: ResumeAgentOptions): Promise<AgentHandle>
ctx.agents.get(id: SessionId): Agent | undefined;  ctx.agents.list(): Agent[]
interface CreateAgentOptions {
  sessionId: SessionId                         // caller-supplied identity (agent id == session id)
  meta?: { cwd?; parentSession?; isSeeded?; origin?: 'subagent'; delegationDepth?; agentPreset? }
  inheritedEventCount?: SessionLogOffset; seed?: readonly SessionEvent[]   // fork/replay
  agentOptions?: AgentOptions; signal?: AbortSignal
  setup?: (agentCtx: Context, agent: Agent) => AgentSetupCommit | Promise<AgentSetupCommit|void> | void
}
interface ResumeAgentOptions { resumeSessionId: SessionId; agentOptions?; signal?; setup? }
interface AgentHandle { agent: Agent; dispose(): Promise<void> }   // only the holder can tear down
interface AgentOptions { provider?: string; model?: string; reasoningEffort?: ReasoningEffortId; maxTokens?: number }
```
- `setup` "composes, never drives": it registers scoped tools, prompt sections, listeners and preset binding on `agentCtx` before `agent/created`. A throw rolls everything back. [SRC JSDoc]
- `create` → `SessionStore.prepare` → `sessionPersistence.create(header)` (if mounted) → `initializeAgent`. `resume` → `persistence.open(id,'write')` **first** (claims single-writer) → `handle.read(0)` → `interruptedTurnClosers(events)` appended → `sessions.prepare(id,{seed,meta,eventState})` → initialize. If no persistence is mounted, `resume` throws `'cannot resume: session persistence is not configured'`. [SRC `packages/core/agent-loop/src/index.ts:686-833`]
- AgentLoop config also accepts startup `agents: [...]` (config-created agents). Base sets `agents: []`. [SRC]

### 2.3 Agent handle (live) [SRC `packages/core/agent/src/runtime-types.ts`]
```ts
interface Agent {
  readonly id: SessionId; readonly options: AgentOptions; readonly session: Session
  readonly model: Model            // current(), select(selection) -> durable 'model/selection'
  readonly inbox: Inbox            // nextTurn/nextStep lists; append/prepend/replace/remove/splice/clear (durable 'agent/inbox/spliced')
  readonly status: 'idle' | 'running'; readonly ctx: Context   // agent-scoped context
  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>   // non-turn task from idle (e.g. compaction)
  send(message: UserMessage, target: 'next-turn'|'next-step', wakeup: boolean): void
  followup(message: UserMessage): void   // queue a new turn, wake
  steer(message: UserMessage): void      // inject at next step boundary (or start a turn if idle)
  inject(message: UserMessage): void     // model-facing context for next pre-step, does NOT wake
}
type AgentCancelCause = {kind:'user'} | {kind:'parent'} | {kind:'hook'; reason: string} | {kind:'disposed'}
```
- The inbox is **durable**. Every mutation logs `agent/inbox/spliced`, and the `inbox` projection rebuilds pending input from the log, so queued prompts survive restart. [SRC types.ts]
- Turn end reasons (`TurnEndReasonMap`): `completed`, `aborted{reason}`, `blocked`, `error{error: LlmFailure}`, `max-tokens`, `interrupted` (only synthesized by resume repair), and others. [SRC `packages/core/session/src/types.ts`]
- Typical driver loop (headless): `agent.followup(createUserMessage({content:[{type:'text',text}], source:{kind:'user'}}))` → `await agent.whenIdle()` (loop while `subagents.waitForTreeWork(agent)`) → `await sessions.flush(agent.session)` → read the final `assistant/message` / `turn/end` from `session.eventAt()`. [SRC `packages/bundle/headless/src/index.ts`]

### 2.4 `agent/*` and `tools/*` events [SRC]
| Event | Mode | Purpose |
|---|---|---|
| `agent/created` | serial (awaited) | Per-agent init after setup. Throwing fails creation |
| `agent/disposed` | emit | Left registry |
| `agent/status` | emit | idle ⇄ running |
| `agent/inbox/inserted\|claimed\|discarded` | emit | Live inbox observation |
| `agent/pre-step` | **waterfall** → `PreStepDecision = {kind:'reject'} \| {kind:'enter', messages, startsRequestSeries?}` | Accept, rewrite or reject claimed input before each step |
| `agent/request` | waterfall → `LlmCallConfig` | **@deprecated**. Adjust controls only; use `agent.model.select()` |
| `agent/request-error` | waterfall → `{kind:'retry'} \| undefined` | Own LLM failure recovery (llm-retry plugin) |
| `agent/assistant-stream` | emit | Live stream frames start/chunk/end (process-local, transient) |
| `agent/turn-stopping` | serial | Last chance before the turn closes; `agent.steer()` forces another step |
| `agent/error` | emit | Step/turn failure |
| `tools/pre-execute` | waterfall → `PreToolDecision` | Policy/approval gate |
| `tools/execute` | waterfall → `ToolExecutionResult` | Wrap/replace execution |
| `tools/post-execute` | waterfall → `PostToolDecision` | Post-processing |
| `tools/result` | emit-like (returns undefined) | Observe results |
| `tools/change` | — | Tool set changed |
| `llm/stream` | waterfall | Wrap the model stream (checkpoint policy uses it) |
Signatures in `packages/core/agent/src/runtime-types.ts` and `packages/core/tools/src/events.ts:18-56`.

Turn/step flow: see the `docs/architecture.md` "Turn flow" block (turn/start → claim → `agent/pre-step` → step/start → `agent/request` → prepareCall → user/message, request/header/context → stream → assistant/message → tool/call* → tools pipeline → tool/result* → step/end → … → `agent/turn-stopping` → turn/end). [DOC, consistent with SRC event decls]

### 2.5 Cancellation [SRC]
- `agent.cancel(cause)` clears the inbox unless `keepInbox` is set, then aborts the active turn or maintenance task. The first cause wins. If nothing is active it is a no-op. Waking input sent after cancel is queued to the next turn. A `disposed` cancel leaves it parked.
- Turn signals are passed to every waterfall payload (`signal`). Tool executions and LLM calls observe them.
- `AgentHandle.dispose()` stops the loop, awaits drain, unregisters, removes the session from the store, and unwinds the scope. Factory teardown aborts all live agents (`FactoryOwnership.dispose`).

### 2.6 Human-in-the-loop primitives [SRC `packages/interaction/user-approval/src/index.ts`]
- `ctx.approval` policy is `'ask' | 'never'` per session (durable `approval/policy`). For `'ask'`, the request goes through the waterfall `approval/request` (agent-scoped), with default `'unavailable'` (fail-closed). Outcomes are `allowed-once | rejected | cancelled | unavailable`. Durable `approval/asked` / `approval/decided` events are logged.
- **[INF] RISK:** the approval answer is an in-process promise. A HeyAgent "wait for a human for hours" approval keeps a live agent (and its whole log in memory) pinned in one worker process. A worker crash turns into an `interrupted` turn on resume. There is no "park the agent durably, resume later on any worker" primitive. HeyAgent needs one of two designs: (a) a sticky owner worker that holds the agent while waiting, or (b) end the turn with a tool result like "waiting for human" (`concludesTurn`) and resume later with a `followup` containing the decision.

### 2.7 Headless? Capacity? [SRC]
- **Headless: yes.** `headless` bundle = base + `headless-startup` + `headless-runner`, with no Host, webserver or browser plugins. SDK (`sdk-app`) and ACP (`acp-app`) are also UI-less, using stdio JSON-RPC.
- **Agents per process:** unbounded in core (registry `Map`). The only limits found are per-step parallel tools (`DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10`, `packages/core/agent-loop/src/constants.ts`) and per-owner background jobs (10, jobs-local). No idle eviction was found in `core`, `api/session-controller` or `sdk/server` (grep for evict/idleTimeout found nothing). Memory grows with every live session's full event log plus derived messages plus projection state. **[INF] RISK:** a HeyAgent worker must dispose agents after each run (`handle.dispose()`) and bound its concurrency itself.

---

## 3. Session: events, projections, persistence

### 3.1 Session / SessionStore [SRC `packages/core/session/src/index.ts`, `types.ts`]
- `Session` holds `log: SessionEvent[]` **in memory**. `append<T>(type, data, ...surfaceOpts): SessionEvent<T>` is synchronous. It snapshot-validates JSON (rejects BigInt, Date, Map, undefined, -0, and so on), deep-freezes, assigns `seq = log.length` and `time = Date.now()`, then synchronously notifies `session/event` observers ("the hot path never blocks on I/O — persistence plugins buffer asynchronously").
- Other members: `seq`, `header`, `inheritedEventCount`, `eventAt(seq)` (deprecated), `snapshotEvents(from)`, `ownEvents()`, `deriveMessages(): Message[]` (incremental over `surface.nodes`, applying registered message projections), `deriveEventMessage`, `requestHeader()`, `requestContext()`, `toolHistory()`.
- `SessionStore` (`ctx.sessions`): `create`, `prepare`, `enter`, `announce`, `flush(session): Promise<boolean>` (awaits `session/flush` parallel listeners, i.e. the persistence barrier), `get`, `list`, `fork(source, boundary?, childId?)`, `registerMessageProjection(...)`.
- Events: `session/created`, `session/disposed`, `session/event` (sync emit), `session/flush` (awaited). [SRC lines 56-84]
- `SESSION_FORMAT_VERSION = 4`. `SessionHeader = { version, id, createdAt, cwd?, parentSession?, isSeeded, origin?: 'subagent', delegationDepth?, agentPreset? }`. **No user/tenant field.** [SRC types.ts:90+]

### 3.2 Event envelope and custom durable events [SRC]
```ts
type SessionEvent<T> = { type: T; seq: SessionSeq; time: number; data: SessionEventMap[T]; ignorable?: true; surfaceOp?/sourceEventSeqs? (surface types only) }
```
- Add a durable event with `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'heyagent/run-linked': {...} } }`, then `session.append('heyagent/run-linked', data)`.
- **Gotcha:** the persistence read path is fail-closed. A stored type outside `KNOWN_SESSION_EVENT_TYPES` (`packages/core/session/src/known-event-types.ts`, **generated** by `scripts/gen-persistence-catalog.ts` from every in-repo `SessionEventMap` member) makes the log **unreadable** unless the event has `ignorable: true`. In a fork, adding events in-repo and regenerating the catalog keeps them "known". Out-of-repo events need `ignorable` or the experimental `plugin:<name>` records (`PluginRecordMap`, `appendPluginRecord`, `pluginRecordOf`). Historical migrations v0–v2 refuse unknown types even when marked ignorable. [SRC + DOC persistence.md "Format refusal"]
- "Model-visible means logged": any new model-visible input must be a session event, so a request can be rebuilt from the log. [DOC architecture.md]

### 3.3 Session projections [SRC `packages/session/session-projection/src/index.ts`]
- `ctx.sessionProjections.register(def): Promise<ProjectionHandle<S>>`. `ProjectionHandle<S> = { stateOf(session): S; readerFor(session): () => S; dispose() }`.
- `ProjectionDefinition<K,S> = { key; stateSchema: ZodType<S>; init(header, inheritedEventCount): S; apply(state, event): S /* pure, sync, same ref if untouched */; wire?: { viewSchema; view(state); summary? }; version (cache invalidation) }`. State must be plain JSON, because it is persisted by `session-projection-cache`.
- Registry extras: `snapshot`, `cachedSnapshot`, `checkpoint(session)`, `restore`, `hydrate`, `onChanged`, `onEventChanged`. Typed keys come from augmenting `SessionProjectionMap` (e.g. `inbox`, `modelSelection`).
- `session-projection-cache` writes one checkpoint document per session into the storage-domain `session_projcache` (config `writeEveryEvents: 200`, `writeIntervalMs: 5000`). It is used by session listing to avoid opening cold logs. [SRC base yml]
- **[INF]** A HeyAgent "run status / outcome / cost" read model fits naturally as a projection. For SQL queryability, HeyAgent would still mirror it into its own Postgres tables, either through a `session/event` listener or by deriving from projection `onChanged`.

### 3.4 `SessionPersistence` — exact interface [SRC `packages/session/session-persistence/src/index.ts`, `handle.ts`]
```ts
export abstract class SessionPersistence extends Service {           // ctx.sessionPersistence
  readonly identity: symbol
  abstract create(header: SessionHeader, options?: { signal?; inheritedEventCount?: SessionLogOffset }): Promise<SessionHandle>  // write handle; SessionAlreadyExistsError
  abstract open(id: SessionId, access: 'read'|'write', options?: { signal? }): Promise<SessionHandle> // NotFound / SessionAlreadyOwnedError
  abstract flush(): Promise<void>                 // service-wide barrier over all active write handles; AggregateError
  abstract stat(id, options?): Promise<SessionPersistenceSnapshot | undefined>
  abstract list(options?): Promise<readonly SessionPersistenceSnapshot[]>  // unpaginated, unordered
}
interface SessionPersistenceSnapshot { header; formatStatus?: 'current'|'migration-required'; revision: SessionPersistenceRevision /*opaque*/; eventCount?; sizeBytes?; location?: {kind, path} }
interface SessionHandle extends AsyncDisposable {
  readonly id; readonly header; readonly inheritedEventCount; readonly access: 'read'|'write'
  read(offset?: number, length?: number, options?): Promise<{ eventState: 'detached'|'shared-frozen'; events: readonly SessionEvent[] }>
  append(events: readonly SessionEvent[], options?): Promise<void>   // first seq MUST == stored next seq; best-effort durable
  flush(options?): Promise<void>                                      // THE durability barrier; materializes empty sessions
  close(): Promise<void>                                              // idempotent, uncancellable; write handle drains & releases ownership
}
```
Errors exported: `SessionAlreadyExistsError`, `SessionAlreadyOwnedError`, `SessionFormatUnsupportedError`, `SessionHandleClosedError`, `SessionOwnershipLostError`, `SessionPersistenceCorruptionError`, `SessionPersistenceNotFoundError`, `SessionReadOnlyError`. Helpers exported for backends: `assertContiguous`, `assertStoredId`, `assertVersion`, `materializeAppendBatch`, `materializeCreateHeader`, `validateStoredEvents` (`storage-contract.ts`).

Semantics (JSDoc and README) [SRC/DOC]:
- Events are contiguous from seq 0 and never rewritten. A torn tail is never returned and is truncated before the first new append. Reads validate the current format and refuse unknown vocabulary.
- **Single writer:** one active write handle per id *per backend instance*. Cross-process exclusion is provider-specific (README "Known Limitations": *"The seam guarantees write ownership only within one backend instance"*).
- **Visibility:** a created session is visible in-process at once. Other processes see it only after materialization (first append/flush). A session never materialized before a crash never existed.
- **Freshness:** after `append`/`flush` resolves, any read started later on the same backend instance sees at least that prefix.
- **Revision:** opaque, comparable only within one instance and one id. Equal means unchanged. Ownership churn does not change it. It is used only by derived caches (session-query cold-read cache).
- **No delete / retention API.** `list()` is unpaginated. A backend plugin reload under live sessions fails their writers loudly.
- **Only handle-acquired sessions persist.** `ctx.sessions.create` plus `session/flush` alone stores nothing. Agent-loop is the acquisition point.

### 3.5 How events reach storage (critical for any new backend) [SRC]
The **backend**, not the agent loop, subscribes to the live feed. In `JsonlBackendTracker.install(ctx)` (`packages/session/session-persistence-jsonl/src/storage.ts:520+`):
```ts
ctx.on('session/event',   (session, event) => writers.get(session.id)?.enqueueLive(event, onBgError))
ctx.on('session/flush',   (session) => writer ? (async () => { await writer.drainLive(); await writer.flush() })() : undefined)
ctx.on('session/disposed',(session) => writer?.close())
```
- Write-behind with `LIVE_WRITE_BATCH_MAX_DELAY_MS = 200`. A failed background write keeps its events, pauses the automatic path and logs. The next explicit flush retries and rejects loudly.
- Agent-loop writes the *seed* and repair closers directly through `handle.append` (`appendUnstoredSuffix`). Everything after publication arrives through `session/event`.
- `dsh-session-checkpoint-policy` (base row) inject = `['llm','sessionPersistence','sessions','tools']`. It delays the `llm/stream` until the logged request prefix is durable, and checkpoints top-level tool dispatch and completed steps. So **flush happens before every model request**. [SRC header comment]

JSONL specifics [SRC/DOC]: root `dshHomePath('sessions')` → project dir → per-session dir. Generations are `session.vN.jsonl[.zstd]` (v0 = `session.jsonl`). The numerically highest is selected, and committed generation files are never renamed or deleted. A historical write-open migrates in memory through `session-format-catalog` (adjacent `vN→vN+1` packages `session-format-v*-to-v*`) and exclusively publishes a successor. Each batch is fsynced, frames are checksummed zstd. The cross-process lease is `SessionWriteLease` (`lease.ts`): non-blocking `flock(2)` on `session.lock` through the native addon `@deepseek-ai/node-addon-system/flock`, released by the kernel on process death, **no expiry** ("a live but wedged holder keeps the lock until its process exits").

### 3.6 What a PostgreSQL `SessionPersistence` needs [INF, based on the SRC above]
1. Write the plugin `apply(ctx, config)` creating a `class PgSessionPersistence extends SessionPersistence` (register as `ctx.sessionPersistence`), and install the **same three live listeners** as JSONL (`session/event`, `session/flush`, `session/disposed`) routed to the process's write handles. Without these, nothing after creation persists.
2. Schema (sketch): `dsh_session(id text pk, header jsonb, inherited_event_count int, format_version int, created_at, next_seq int, revision bigint, owner_token uuid null, tenant/user cols added by HeyAgent)` + `dsh_session_event(session_id, seq int, event jsonb, primary key(session_id, seq))`. Append = `INSERT ... ; UPDATE dsh_session SET next_seq = next_seq + n, revision = revision + 1 WHERE id = $1 AND next_seq = $first_seq AND owner_token = $tok` in one transaction (gives contiguity plus fencing). A row count of 0 → `SessionOwnershipLostError`.
3. Cross-process single writer: either a **session-level `pg_advisory_lock(hashtext(id))` on a dedicated connection** held for the handle's life (auto-released when the connection dies, which matches flock semantics but costs one connection per live writer), or a **lease row with a fencing token plus heartbeat/expiry**. Note that dsh deliberately has *no* expiry, so expiry-based stealing changes its safety assumption; the fencing check in step 2 is what keeps it safe.
4. `read`: `SELECT event FROM dsh_session_event WHERE session_id=$1 AND seq >= $off ORDER BY seq LIMIT $len`, then `validateStoredEvents(header, events)` (fail-closed vocabulary), returning `eventState: 'detached'`.
5. `flush`: if append commits synchronously, flush = drain the in-memory live queue plus ensure the header row exists. "Materialization" can be lazy (insert the header row on first append/flush) to keep the "never materialized → never existed" semantics, or eager (harmless).
6. `stat/list`: from `dsh_session`, with `revision` as a string token and `eventCount = next_seq`. HeyAgent will want filtered and paginated listing, which the seam does not offer. Add it as a HeyAgent-side query instead of extending `list()`.
7. Format versions: store `format_version`. For a fresh fork-only deployment, refusing non-current versions (`sessionFormatVersionRefusal`) is acceptable. Otherwise reuse `@deepseek-ai/dsh-session-format-catalog`.
8. Verify with `runPersistenceContract(name, make)` (`packages/session/session-persistence/tests/contract.ts`, supports a `reopen` factory for cross-instance tests and `corruptTail`) and `runLiveWritePathContract` (`tests/live-write-contract.ts`).
9. Volume: every event (including each `assistant/message` with its **embedded compact stream**) is one row. Sessions can be large (base `maxBytes` for session-log upload is 8 MiB per request, which hints at the size). Plan for jsonb TOAST and possibly zstd/bytea.
- **Freshness across processes** is not promised by the seam (only within one instance). HeyAgent API processes reading a session written by a worker get "whatever is committed". Fine for PG. [INF]

### 3.7 Other session-adjacent stores [SRC/DOC]
- `session-query` / `session-query-sqlite` (`ctx.sessionQuery`): full-text search over sessions, `node:sqlite`. Base config `path: ':memory:'`, `openAt: never` (search disabled, exact reads/observe still work through `observeSession(id)`, which uses `persistence.open('read')`). The headless runner needs `sessionQuery` for `--session-id` adoption.
- `attachment-local`: image bytes **outside** the log, content-addressed under `$DSH_HOME/attachments/v1`. **BLOCKER** for multi-process: a PG/S3 attachment backend is needed (seam `packages/attachment/attachment`).
- `spill-local`: oversized tool output under OS `tmpdir()` (`dsh-spill-*`). Process-local. **RISK.**
- `llm-deepseek` upload index: `$DSH_HOME/llm-deepseek/files-v3.json`.

---

## 4. Storage (`packages/storage/*`) [SRC + DOC docs/subsystems/storage.md]

- **Hub** `@deepseek-ai/dsh-storage` (`ctx.storage`): name → `StorageBackend` table, `register(name, backend)`, plus forms `mount(form, facility)`. No IO itself.
- **Backend contract** (`packages/storage/storage/src/backend.ts`):
```ts
interface StorageBackend { readonly kv?: KvFacet; close(): Promise<void> }
interface KvFacet { open(d: KvUnitDescriptor): Promise<KvUnit> }
interface KvUnitDescriptor { name /*^[a-z][a-z0-9_]*$*/; version: number; tables: string[]; hasGlobal: boolean; layout?: 'single'|'per-record'; compatibleVersions?: number[] }
interface KvUnit { loadAll(): Promise<{tables: Record<string, Record<string, unknown>>; global: unknown}>
  putRecord(table, key, value); deleteRecord(table, key); deleteRecords(table, keys); setGlobal(value); close() }
```
  The shared conformance suite is `packages/storage/storage/tests/contract.ts`.
- **Providers:** `storage-json` (one file per unit under `dshHomePath('storages')`, atomic rewrite; README: *"No cross-process write locking — … last-completion wins"*) and `storage-sqlite` (`node:sqlite` `DatabaseSync`, one row per document).
- **Domain form** `@deepseek-ai/dsh-storage-domain` (`ctx.storageDomain` == `ctx.storage.domain`). Config `{ backend: string; routes?: Record<domain, backend> }` (base: `backend: json`). `defineDomain(spec)` uses zod record schemas. An open domain = **authoritative in-memory state** (`loadAll` once). Reads are synchronous from memory. Writes go through one per-domain write chain: durable write first → memory → emit `domain/changed`. Tables expose `get/entries/keys/put/delete/deleteMany/update`. [SRC domain.ts header]
- **Consumers** (grep): `session-projection-cache` (`session_projcache`), `workspace/workspace`, `schedule/schedule`, `api/workspace-controller` (feed), `extensions/tool-cordis`, experimental `cua` permission store, `client-ui-forge`, `claude-code-mods`.
- **Postgres backend: easy to write, not enough for multi-process.** A `pg` `StorageBackend.kv` is ~200 lines (mirror storage-sqlite, `packages/storage/storage-sqlite/src/{index,unit,schema}.ts`), routed per domain through `routes`. But each process holds its own in-memory copy with no invalidation from other processes, so two processes editing `schedule` or `workspace` diverge. **RISK/BLOCKER**. Mitigations [INF]: run domain owners (schedule, workspace) in exactly one "coordinator" process, or add LISTEN/NOTIFY reload to the PG backend (but `DomainImpl` has no external-reload entry point, so that is a fork change).

---

## 5. Settings, credentials, home dir

### 5.1 `$DSH_HOME` / `~/.dsh` assumptions [SRC `packages/util/home-paths/src/index.ts` + grep]
`resolveDshHome()` = `$DSH_HOME` or `~/.dsh`. `DSH_AGENTS_HOME` or `~/.agents`. On-disk items:
| Path | Owner | Server impact |
|---|---|---|
| `profiles/<name>/{package.json,cordis.patch.yml,node_modules}` | app-boot, plugin-manager (pnpm at runtime) | Bake into the image read-only; disable plugin-manager/hmr/config-editor |
| `cordis.patch.yml` (home level) | app-boot | Same |
| `.env` | app-boot env layer (`DSH_*`, `PATH`, `XDG_*` rejected from files) | Use real env |
| `.credentials.yaml` | credentials-local (cross-process file lock `withFileLock`) | **BLOCKER** (global, file) |
| `sessions/` | session-persistence-jsonl | Replace with PG backend |
| `storages/` | storage-json | Replace or route to PG |
| `attachments/v1` | attachment-local | **BLOCKER** for multi-process |
| `skills/` (+ `~/.agents/skills`, project `.dsh/skills`, `.agents/skills`) | skill-filesystem | HeyAgent skills are DB rows → new `ctx.skill` provider or a materialized dir |
| `llm-deepseek/files-v3.json` | llm-deepseek upload index | Minor |
| `.anonymous-user-id` | identity/anonymous-user-id | Remove with telemetry |
| agent instructions (`AGENTS.md` under dshHome/agentsHome) | context/agent-instructions | Disable or point elsewhere |
| shell env snapshot | shell/shell-env (`dshHome` config) | Per-worker |
| spill under OS tmpdir | spill-local | Per-worker |

### 5.2 Settings [DOC docs/subsystems/settings.md, SRC base yml]
- `ctx.settings` (`SettingsForms`) projects the **`.volatile()` Config fields of active profile rows** into forms (`describe/update/replace/mutate` with optimistic `expectedRevision`). `config-editor` **persists edits as Cordis patches into the active profile's `cordis.patch.yml`**. `settingsController` exposes it remotely with secret redaction.
- Rows are disabled without `profileContext`. Values are **process/profile-global** with no per-user or per-session dimension. **BLOCKER** for HeyAgent's per-user and per-task config. [INF] Keep dsh settings for *deployment* knobs only, and carry HeyAgent's per-run configuration into each agent through `setup` (model selection, preset id, scoped tools/sections).

### 5.3 Credentials [SRC `packages/credentials/credentials/src/index.ts`, `credentials-local/src/index.ts`]
```ts
export abstract class CredentialProvider extends Service {   // ctx.credentials
  abstract resolve(ref: CredentialRef): Promise<{ value: string; source: string } | undefined>  // per call, no caching
  abstract describe(ref); abstract set(ref, value); abstract unset(ref)
  abstract readRecord(key: CredentialKey); abstract describeRecord(key); abstract listRecords()
  abstract modifyRecord(key, mutate: (cur) => Promise<CredentialRecord|undefined>)  // serialized RMW (token refresh)
  abstract deleteRecord(key)
}
```
- `credentials-local` precedence: `$DSH_HOME/.credentials.yaml` > process env > `<cwd>/.env` > `$DSH_HOME/.env`. It hot-reloads through chokidar and writes under a cross-process file lock. `CredentialRef` = env-var-like name (e.g. `DEEPSEEK_API_KEY`). `CredentialKey` = `<scope>/<id>` record (OAuth grants).
- Consumers call `ctx.get('credentials').resolve(ref)` per request (e.g. `packages/llm/llm-deepseek/src/credential.ts`, `llm-pi-ai/src/index.ts:222`). **No session/user argument.** [SRC]
- **Replaceable: yes** (abstract seam). Writing a PG/Vault `CredentialProvider` is straightforward. **Per-user keys are the RISK**: the provider has to infer the caller. One option is `ctx.agents.currentInitiator()` (AsyncLocalStorage, "same-process causal attribution only… neither liveness proof nor authorization", `packages/core/agent/src/index.ts`), whether that propagates into adapter calls is **[INF], not verified**. Another is the agent-scoped `agentCtx` if consumers resolve `credentials` from the agent context (not verified). HeyAgent's current model (company-level model-service keys, $20 OpenRouter budget) only needs **deployment-global** keys, which the seam handles. **OK for global keys, RISK for per-user keys.**
- `llm-pi-ai` (multi-provider, OpenAI-compatible including OpenRouter) is mounted dormant in base. Its routes come from the `llm-pi-ai:` settings section, with keys referenced by `apiKeyEnv`. [SRC base yml comment]

---

## 6. Process model

### 6.1 Facts [SRC/DOC]
- **Everything is single-process.** One `dsh --profile X` = one Node process = one Cordis root. Live state that is process-local by design: agent registry and initiators, session store and in-memory logs, live assistant stream, tool registry, approval waits, user-questions, `jobs-local` ("keeps every job … in memory", `packages/jobs/jobs-local/src/index.ts`), goal activation ("process-local", docs/subsystems/goal.md), the subagent tree, storage-domain state, projection state, the session-query cache, spill files, preset Loader trees, and the feedback op queue.
- **Locks across processes:** only (a) JSONL `flock` session lease (`packages/session/session-persistence-jsonl/src/lease.ts`), (b) credentials-local file lock, (c) plugin-manager/config-editor/plugin-market file locks (`withFileLock`). storage-json has none.
- **`jobs` is not a work queue.** `ctx.jobs` = background *tool* jobs (`bash` runs in the background, `job_*` tools read/stop them). Per-owner cap 10, output ring 256 KiB live / 16 KiB settled, durable `job/registered`/`job/settled` events, process-local live state. A job is lost if its process dies. [SRC/DOC docs/subsystems/jobs.md]
- **`schedule`** (`packages/schedule/schedule`, in sdk-app and web) stores tasks in a storage domain and runs timers in-process. Two processes mounting it **double-fire**. [INF from design; DOC docs/subsystems/schedule.md]
- **Out-of-process pieces that exist:** subagent providers `subagent-dsh-sdk` (spawns a child `dsh` runtime over SDK JSON-RPC) and `subagent-acp` (spawns an ACP agent command), plus `ssh/*` (fs/subprocess/sandbox over SSH, which moves *tool execution* to a remote host but not the loop). There are no remote *agent-loop* workers. [DOC READMEs]
- **SDK server** (`packages/sdk/server`, profile `sdk`): newline JSON-RPC over **stdio only** (`process.stdin/stdout`). Requests: `initialize`, `session/prompt`, `session/query`, `session/resume`, `session/wait`, `session/working-directory/get|set`, `shutdown`. Notifications: `session.event` (every session in the runtime), `session.status`, `session.query.completed`, `subagent.started|finished`, `user-question.cancelled`. Client request `approval/request` (one-shot). [SRC `packages/sdk/protocol/src/types.ts`]
- **ACP** (`packages/acp/acp`, profile `acp`): automation-only ACP JSON-RPC over stdio. [DOC]
- **Web** (`webserver` + `api/session-controller` + Typert gateway): a single owner per process (Connection plugin issues a process token; non-owner Peers gated by `remote-access`). The session controller "reuses a live Agent, automatically resumes ordinary cold sessions, deduplicates concurrent resumes" (`docs/api-gateway.md`). [DOC]

### 6.2 Where "N worker processes pulling runs from pg-boss" attaches [INF]
Options, in order of preference:
1. **Custom worker plugin in a custom bundle (recommended).** Create `packages/bundle/heyagent-worker/cordis.patch.yml` = `dsh-base` + overrides: disable `hmr`, `plugin-manager`, `config-editor`, `settings`, `credentials` → own provider, `session-persistence-jsonl` → PG backend, `storage-json` → PG kv, `attachment-local` → shared store, and remove telemetry rows (section 7). Then insert a `heyagent-worker` function plugin (`inject: ['agents','sessions','sessionPersistence','agentDefaultModel', 'agentPresets'?]`). After `await ctx.get('loader')?.await()` it opens pg-boss, and for each job does `ctx.agents.create({sessionId, meta, agentOptions, setup})` or `resume({resumeSessionId})` → `followup` → `whenIdle` (+ `subagents.waitForTreeWork`) → `sessions.flush` → write the outcome to HeyAgent tables → `handle.dispose()`. This is a copy of `packages/bundle/headless/src/index.ts::run()` minus stdio. Launch with `dsh --profile heyagent-worker` (a profile from the custom template) or the lower-level app-boot helpers. Concurrency is the worker's own semaphore.
2. **SDK JSON-RPC child per worker slot.** HeyAgent's existing worker spawns `dsh --profile sdk` subprocesses and speaks stdio JSON-RPC (`packages/sdk/client` is a ready TS client). This gives better isolation (crash or memory per child) and needs no dsh fork changes for the loop, but approvals are limited to the one-shot `approval/request`, and every child still needs the PG persistence/credentials patches.
3. ACP is the same idea as option 2, with less dsh-specific surface. Not recommended.
- **Ownership across processes:** a run must be owned by exactly one process at a time. With a PG persistence backend, `open(id,'write')` must fail in a second worker (`SessionAlreadyOwnedError`), which the PG lock/fencing (section 3.6) must provide. pg-boss job leasing should line up with it (resume on retry → interrupted-turn closers get appended).
- **API process (Web/HTTP)** should not host agents. It reads session state from PG (events + HeyAgent read models) and sends commands (prompt/cancel/approve) to the owning worker through the queue or pub/sub. dsh has no such cross-process command bus. **BLOCKER-level new code** [INF]. `agent.cancel`, `steer` and approval answers can only be applied in the owning process.

---

## 7. Outbound data ("phones home") — inventory and removal

| Component (row id → package) | Mounted in | What leaves the box | Default | How to disable/remove |
|---|---|---|---|---|
| `session-telemetry-otel` → `packages/session/session-telemetry-otel` (+ `otel` → `packages/telemetry/otel`) | base | Session-log prefix as OTLP logs to `https://dsh-otel-collector.deepseeksvc.com/v1/logs` (gzip), with Resource `user.id` = anonymous id | `mode: FEEDBACK_ONLY` (only after explicit user feedback) [SRC enum + base yml] | `DSH_TELEMETRY_DISABLED=<any non-empty>` → launcher patches row `session-telemetry-otel` disabled (`packages/boot/app-boot/src/profile-context.ts:39-52`, `TELEMETRY_ROW_ID = 'session-telemetry-otel'`). `DSH_TELEMETRY_OTLP_URL` / `DSH_TELEMETRY_MODE` env. Best: delete rows `session-telemetry-otel`, `otel` in the fork's bundle. [SRC] |
| `session-log-deepseek` → `packages/session/session-log-deepseek` | base, sdk-minimal | **Full canonical session log (incremental, ≤8 MiB/request) as `dsh_session_log` field in every request sent by the `llm-deepseek` adapter**. Durable `session-log-deepseek/delivery-accepted` watermark events | **`enabled: true`** [SRC Config] | Patch `- id: session-log-deepseek` `disabled: true` (or `config: {enabled: false}`). NOT covered by `DSH_TELEMETRY_DISABLED`. [SRC] I saw no official-endpoint check in `llm-deepseek/src/adapter.ts`: fields attach to whatever endpoint that adapter targets. [SRC partial] |
| `plugin-package-inventory-deepseek` → `packages/llm/plugin-package-inventory-deepseek` | base | Active plugin package list as `dsh_plugin_packages` request field (same adapter path) | Mounted | Disable the row. Also consider dropping `deepseek-llm-api-extensions` entirely. [SRC/DOC] |
| `deepseek-llm-api-extensions` → registry for the above | base | (carrier) | Mounted | Disable if not using DeepSeek-specific fields |
| `web` + `web-search-deepseek` + `web-deepseek-api` | base | `web_search` queries to DeepSeek Search API (with `DEEPSEEK_API_KEY`/account token). `web_fetch` via local `http` fetcher (model-directed) | `searchProvider: deepseek-search-api` | Change `web.config.searchProvider`, or disable `tool-web`/`web-search-deepseek`/`web-deepseek-api` [SRC yml] |
| `deepseek-account` → `packages/credentials/deepseek-account-platform` (+ `llm-deepseek-account`) | base (headless disables) | DeepSeek platform account sign-in/token refresh (`platform.deepseek.com`) | Mounted | Disable rows `deepseek-account`, `llm-deepseek-account`, `authorization` |
| `llm-deepseek` / `agent-default-model` | base | Model calls to `api.deepseek.com` (default `provider: deepseek-official, model: deepseek-flash`) | Mounted | Expected traffic. Point to OpenRouter via `llm-pi-ai` routes and change `agent-default-model` |
| `session-title-llm` | base | Extra LLM call to make titles | Mounted (sdk/acp disable) | Disable if unwanted |
| `plugin-manager` / `tool-plugin-manager` → `packages/boot/plugin-manager` | base (needs profileContext); sdk enables the tool | npm registry traffic (`registry.npmjs.org`, `registry.npmmirror.com` incl. `-/ping`), runtime pnpm installs | Mounted | Disable both rows (and `hmr`, `config-editor`) |
| `plugin-market` → `packages/boot/plugin-market` (+ `util/plugin-detail`) | experimental `plugin-market-bundle` only | Index URLs, git repos, file CDNs (jsDelivr/unpkg/npmmirror) | Not in base | Do not install the bundle |
| `desktop-product-telemetry` (`host/product-telemetry-otel`) + `product-analytics` (`client/product-analytics`) | web-app, only when `profileContext.name === 'desktop'` | Product analytics to the collector (`DSH_PRODUCT_ANALYTICS_OTLP_URL`; default endpoint `dsh-otel-collector.deepseeksvc.com`) | Off outside Desktop | Delete rows if the web-app bundle is reused |
| `identity/anonymous-user-id` | used by telemetry/feedback | Writes `$DSH_HOME/.anonymous-user-id` (random UUID). Sent only through the above | Lazily | Goes away with telemetry/feedback rows |
| `command-feedback` / `message-feedback` (`packages/feedback/*`) | base / web-app | Triggers the feedback-only OTel capture | Mounted | Disable with telemetry |
| Electron updater `apps/desktop/src/update-coordinator.ts` | Desktop app only | Update checks | Desktop only | Not used on a server |
| `llm-pi-ai` provider data | base, dormant | Only to providers configured in settings | Dormant | — |
- **[INF]** The fork's server bundle should be an explicit allow-list (like `sdk-minimal`, which "owns its complete explicit tree and does not apply dsh-base") rather than base-minus-deletes, so new upstream rows cannot appear on rebase.

---

## 8. Blockers and major risks for HeyAgent (multi-user, multi-process, Postgres)

| # | Item | Severity | Why / pointer |
|---|---|---|---|
| B1 | No cross-process command path to a live agent (cancel/steer/approve/answer from API process) | **BLOCKER** (new code) | Live control methods exist only on in-process `Agent` (section 2.3). An owner-routing bus is needed (pg-boss/NOTIFY → owning worker) |
| B2 | Session persistence on PG | **BLOCKER** (new backend, feasible) | Section 3.6. Must reimplement the live-routing listeners and cross-process write exclusion. Contract suites are available |
| B3 | Attachments on local disk | **BLOCKER** | `attachment-local` → `$DSH_HOME/attachments/v1`. Needs a shared backend |
| B4 | Settings are profile YAML, global | **BLOCKER** for per-user config | Section 5.2. Use dsh settings for deployment only |
| B5 | No user/tenant identity anywhere in core (SessionHeader, credentials, settings, list) | **BLOCKER** | HeyAgent must keep a `run/session ↔ user` mapping in its own tables and enforce authorization outside dsh. `persistence.list()` returns everything |
| B6 | Web/API auth is single-owner process token | **BLOCKER** if dsh Web is reused | `docs/subsystems/web-server.md`, `docs/api-gateway.md` |
| R1 | storage-domain is in-memory per process, no cross-process invalidation | RISK/BLOCKER | schedule, workspace, projection cache diverge across workers (section 4) |
| R2 | schedule double-fires with >1 process | RISK | Mount only in a singleton coordinator, or replace with pg-boss cron |
| R3 | Long human waits pin a live agent in memory on one worker | RISK | Section 2.6. Design around `concludesTurn` + later `followup` |
| R4 | Unbounded agents and full in-memory logs per process, no eviction | RISK | Section 2.7. Worker must dispose after each run and cap concurrency |
| R5 | Fail-closed event vocabulary | RISK | Custom events must be in-repo (regen `known-event-types.ts`) or `ignorable`/`plugin:` records. A downgraded worker cannot read newer logs |
| R6 | Per-user model keys | RISK | Credential `resolve(ref)` has no caller arg (section 5.3). Global keys are fine |
| R7 | Default egress: session-log upload to DeepSeek is ON | RISK (data) | Section 7. Must be explicitly removed |
| R8 | Preset definitions are Loader rows; HeyAgent configs are DB rows | RISK | Generate presets at runtime via `agentPresets.register()` or compose in `setup` (section 1.7) |
| R9 | Runtime pnpm/plugin installs, HMR, file watchers (chokidar) by default | RISK (ops) | Disable `plugin-manager`, `hmr`, `config-editor`, `settings`, and the credentials-local watcher in server bundles |
| R10 | `list()` unpaginated; no delete/retention API | RISK | Add HeyAgent-side queries and retention jobs directly on PG tables |
| R11 | Alpha software (v0.2.2-alpha.3), very fast-moving, heavy internal invariants (generated catalogs, README verifiers, contract gates) | RISK (fork maintenance) | Rebase cost. Keep fork changes in new packages plus bundle patches, and touch core packages minimally |

Positive findings (keep):
- The headless loop, presets for per-session composition, capability seams (fs/subprocess/sandbox/shell/llm/credentials/persistence/storage) with abstract services, waterfall interception points (`agent/pre-step`, `tools/pre-execute`, `approval/request`, `llm/stream`), durable inbox, resume with crash repair (`interruptedTurnClosers`), and reusable backend contract test suites.

---

## 9. Doc vs source discrepancies noticed
- `docs/architecture.md` ("Store sessions in a new backend") lists `create/open/stat/list/export`. The source abstract class has `create/open/flush/stat/list`, with **no `export`** (`packages/session/session-persistence/src/index.ts`). Session export lives in `packages/session-query/session-log-export` instead. [SRC]
- `docs/subsystems/persistence.md` says the seam exposes `create/open/stat/list` and omits the service-level `flush()`, which the source declares abstract. [SRC]
