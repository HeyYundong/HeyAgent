# dsh fork assessment — slice: browser use + computer use (desktop)

Scope: what DeepSeek Harness (dsh) gives us for browser automation and desktop computer use, how our HeyAgent
browser/desktop layer works today, and how ours maps onto dsh provider plugins.

- dsh repo (read only): `deepseek-ai/deepseek-harness@8bd07339 的本地克隆` (paths below are repo-relative, prefixed `dsh:`)
- HeyAgent (read only): `/mnt/toshiba/Projects/HeyAgent/.claude/worktrees/dsh-fork-assessment` (prefixed `ha:`)
- Labels: **[src]** = verified by reading source; **[docs]** = README / subsystem doc / decision note only;
  **[inferred]** = my conclusion from the source, not stated anywhere.

---

## 0. TL;DR

1. **dsh's "browser use" and "computer use" services are name-only registries.** Each is ~48 lines and holds one
   provider name. They add no tools, no browser or desktop objects, no lease API and no live view. All the real
   behaviour lives in experimental provider packages. [src]
2. **Each composition allows one browser-use provider and one computer-use provider.** A second `register()`
   throws, even when it uses the same name. One browser provider and one computer provider can coexist. [src]
3. **Browser ownership is per live `Agent` object**, held in `SessionResources<T>`
   (`dsh:packages/experimental/browser-use-runtime/src/index.ts`). Calls run one at a time per Agent. When the Agent
   is disposed, its resource closes. Resume, reload or fork always start a fresh browser. dsh never restores
   browser state from the Session log. [src]
4. **Attaching to an existing Chrome over CDP is supported** (`mode: 'attach'`, `endpoint`). But the endpoint is
   fixed in profile config for the whole provider activation, and it is exclusive to one live Session at a time.
   That exclusivity is in-memory and per process; other dsh processes are not coordinated. dsh has **no pool, no
   dynamic endpoint per session, and no DB leases**. [src]
5. **dsh has no live view of the agent's browser or desktop.** `ui-sidebar-browser` is a separate browser for the
   *user* (an iframe on Web, an Electron `<webview>` on Desktop). It is not connected to the agent's Chrome. No
   screencast, VNC or frame streaming exists anywhere in dsh. [src: grep found nothing]
6. **Computer use is local-host only.** The Cua Driver MCP and native providers, and `dsh-cua` + `cua-macos`, drive
   the desktop of the machine running dsh. The macOS backend is the only native backend. A "Windows provider with a
   C# helper" is *planned*, not shipped. [src for code; [docs] for the Windows plan]
7. **dsh-cua is a strong design** that we can partly reuse: one `cua` tool taking `{method, params}`, per-Agent
   JSONL native connections, consent per application through `userQuestions`, snapshot and screenshot validity
   codes, and coordinate mapping. Its `NativeChannelFactory` abstraction would let us point it at a *remote*
   Windows helper. But its protocol is macOS AX-shaped, and its consent flow needs a live human answerer and fails
   in subagents (`DELEGATED_CALLER`). [src]
8. **For our needs, both providers have to be custom plugins.** They can reuse `SessionResources` and
   `createMcpToolDefinition`. Pool, profiles, vault, leases, captcha, auto-login, clipboard, downloads, network log,
   page brief, form readback, site API, CDP tap, live view, VM lifecycle and the Python agent are all ours to port.
   dsh supplies roughly 0–10% of this slice.

---

## 1. dsh browser use

### 1.1 Registry contract — `dsh:packages/browser-use/browser-use/src/index.ts` (48 lines) [src]

```ts
declare module '@deepseek-ai/cordis' { interface Context { browserUse: BrowserUseRegistry } }
export class BrowserUseRegistry extends Service {          // service key 'browserUse'
  get providerName(): BrowserUseProviderName | undefined     // still set while the provider is closing
  register(name: BrowserUseProviderName): () => Promise<void> // throws `browser use provider "<x>" is already registered`
}
// dsh:packages/browser-use/browser-use/src/brand.ts
export type BrowserUseProviderName = Branded<'BrowserUseProviderName'>
export function BrowserUseProviderName(name: string): BrowserUseProviderName
```

- `register()` wraps `ctx.effect(...)`: unloading the provider plugin releases the slot. An old disposer cannot
  remove a newer registration (tested in `tests/registry.spec.ts`). [src]
- Contract for providers [docs: README / subsystem doc]: stop accepting tool calls, close resources and wait for
  owned work **before** releasing the registration.
- Decision note `dsh:.agents/notes/implemented/architecture/2026-09-12-browser-use-provider-registration.md` [docs]
  rejects a unified browser action API, rejects one browser shared across Sessions, rejects browser profiles
  restored with Sessions, and rejects delegating to a separate browser agent. dsh keeps the task loop.
- Composition is YAML (Cordis loader):
  `- name: '@deepseek-ai/dsh-browser-use'` plus one provider entry with `config:`. [docs]

### 1.2 Shared runtime — `dsh:packages/experimental/browser-use-runtime/src/index.ts` (197 lines) [src]

This is the only reusable lifecycle code in dsh. It is generic over `T`, so it does not depend on Playwright.

```ts
export interface OwnedSessionResource<T> { value: T; close: () => Promise<void> }
export interface SessionResourceOptions<T> {
  label: string
  exclusive: boolean                       // true => at most ONE Agent may hold a resource (entries.size === 0 check)
  open: (agent: Agent, signal: AbortSignal) => Promise<OwnedSessionResource<T>>  // must roll back partial acquisition
}
export class SessionResources<T> {
  constructor(ctx: Context, options: SessionResourceOptions<T>)
  available(agent: Agent): boolean          // not disposing && agent is the live registry instance && (has entry || !exclusive || empty)
  get(agent: Agent, signal?: AbortSignal): Promise<T>   // lazy acquire once per Agent
  run<R>(agent: Agent, signal: AbortSignal, op: (resource: T, signal: AbortSignal) => Promise<R>): Promise<R> // serial per Agent
  dispose(): Promise<void>                  // close all; failed close keeps entry (keeps exclusivity) and rejects
}
```

Semantics, verified in the code:
- The key is the **exact live `Agent` object** (`Map<Agent, Entry>`), not the session id. The code checks
  `ctx.get('agents')?.get(agent.id) === agent`.
- Each Agent gets one `agent.ctx.effect` cleanup, so disposing the Agent closes its resource.
- `run()` chains operations on `entry.tail`, so calls for one Agent run one at a time and other Agents run in
  parallel. The operation receives `AbortSignal.any([callerSignal, entryController.signal])`.
- When a call is aborted with `reason.kind === 'disposed'`, the resource closes early, because a browser call may
  only settle after its connection is closed.
- Cancelling an acquisition *wait* does not cancel the acquisition, which stays owned by the Session. A failed
  `open()` removes the entry.
- There is no lease TTL, no heartbeat, no queue and no wait-for-free-resource. If `exclusive` is true and the
  resource is taken, `get` **throws immediately** ("attached browser is already reserved by another Session").

### 1.3 MCP mounting — `dsh:packages/experimental/browser-use-runtime/src/mcp.ts` (220 lines) [src]

```ts
export type BrowserMcpConfig =
  | { mode: 'launch'; headless: boolean; executablePath?: string; toolCallTimeoutMs?: number }
  | { mode: 'attach'; endpoint: string /* http(s) DevTools URL or ws(s) browser endpoint */; toolCallTimeoutMs?: number }
export interface SessionMcpOptions {
  name: string; exclusive: boolean; command: string; args: string[]; env?: Record<string,string>; toolCallTimeoutMs?: number
}
export function mountSessionMcp(ctx: Context, options: SessionMcpOptions): void
```

- **Eager start.** On `ctx.on('agent/created', ..., { prepend: true })` it awaits `resources.get(agent)`. That
  spawns one **stdio** MCP server per live Agent, inside a per-Agent `createScope(ctx, agent)`, via
  `scope.ctx.plugin(McpClient, { transport:'stdio', failOnStartupError:true, reconnect:{enabled:false}, cwd: workingDirectory.ensure(agent) })`.
  If startup fails, **creating or resuming the Agent fails**.
- **Busy attachment.** That Agent is marked `blocked`. Its `mcp__<name>__*` tools are hidden with
  `scope.ctx.tools.restrict({deny})`, and its `mcp:<name>` system-prompt section is filtered out. It **never
  retries** during that activation.
- **Ownership guard.** A `tools/execute` hook rejects `mcp__<name>__*` calls from a different Agent
  ("browser tool belongs to another Session"). It routes allowed calls through `resources.run` (serial) and swaps
  `exec.signal` for the combined signal. MCP resource tools (`read_mcp_resource` etc.) addressed to the server get
  the same guard.
- The command and args are **fixed when the provider is applied**. There is no hook to choose an endpoint per
  Agent. [inferred] A pool cannot be built on `mountSessionMcp`: you would need one provider per endpoint, and the
  one-provider rule forbids that.

### 1.4 Providers [src]

| Package | Lines | What it does |
|---|---|---|
| `dsh:packages/experimental/browser-use-playwright-mcp/src/index.ts` | 51 | Pins `@playwright/mcp` **0.0.80**. Args: `cli.js --browser chromium` plus either `--cdp-endpoint <endpoint>` (attach) or `--isolated [--headless] [--executable-path]` (launch). Clears every inherited `PLAYWRIGHT_MCP_*` env var. `exclusive = mode==='attach'`. Tools are named `mcp__playwright-mcp__<tool>`. |
| `dsh:packages/experimental/browser-use-chrome-devtools-mcp/src/index.ts` | 43 | Pins `chrome-devtools-mcp`. `--no-usage-statistics`, plus either `--ws-endpoint`/`--browser-url` (attach) or `--isolated --headless=<b>`. |
| `dsh:packages/experimental/browser-use-stagehand-native/src/{index,native,launch,worker*}.ts` | ~550 | Registers **its own tools** (`stagehand_navigate`, `stagehand_tabs`, `stagehand_screenshot`, `stagehand_act`, `stagehand_observe`, `stagehand_extract`) with `createMcpToolDefinition`. **Lazy**: the browser starts on the first tool call (`resources.get(ctx.agents.requireInitiator())`). Launch mode owns Chromium through `@puppeteer/browsers` (temporary profile, `--remote-debugging-port=0`, scrubbed env) and kills it on close. The SDK runs in an isolated Worker that only speaks CDP. Uses a **separately configured native model** (OpenAI/Anthropic/Google/Groq/Cerebras catalog; "DeepSeek endpoints and baseURL overrides are unsupported" [docs]). |

Stagehand's tool schemas (`dsh:.../browser-use-stagehand-native/src/native.ts`) [src]:
```ts
navigate: { pageId?, url }            tabs: {action:'list'} | {action:'new', url?} | {action:'select'|'close', pageId}
screenshot: { pageId?, fullPage=false }  act|observe: { pageId?, instruction }  extract: { pageId?, instruction, schema? }
```
**Stagehand is the template for a custom provider with lazy start and its own tools.** Its pattern is
`ctx.effect(function*(){ yield ctx.browserUse.register(...); resources = new SessionResources(...); yield () => resources.dispose(); child = ctx.plugin({ apply: mountTools }) ; yield child.dispose })`,
together with a `tools/execute` hook that calls `resources.run(agent, exec.signal, ...)` and
`ctx.agents.withInitiator(agent, next)`.

### 1.5 Ownership, claims, cleanup, cancel — summary [src unless marked]

| Concern | dsh behaviour |
|---|---|
| Binding a browser to a session | The live `Agent` object, inside one provider instance. Lost on reload, resume or fork. |
| Claim / lease | Only `exclusive` attach: one Agent per provider instance, in memory. No TTL or heartbeat. Busy means an immediate throw (native) or tools masked for the activation (MCP). |
| Queue or wait for a free browser | None. |
| Cleanup | Agent disposal or provider unload → `close()` → MCP scope dispose / Chromium kill + profile `rm -rf`. Attach mode only disconnects. |
| Cancel | Abort signal reaches the operation. Delivered actions are not undone [docs]. Stagehand drains SDK work before the Worker is terminated; a failed drain blocks reuse. |
| Shutdown | Stop accepting calls → close resources → await work → release registration. |
| Persistence | None. Cookies and pages are not in the Session log; restoring them is explicitly rejected [docs: decision note]. |
| Multiple processes | Not coordinated ("Separate DSH processes and other clients remain outside this reservation" [docs]). |
| Screenshots | Need an attachment store and an image-capable model route; otherwise the MCP image diagnostic is returned [docs: provider README]. |

### 1.6 Attaching to an externally managed Chrome via CDP

Supported by all three providers [src]. Limits:
- The endpoint comes from profile config, one per provider activation. `cdpEndpoint` for Stagehand,
  `endpoint` for MCP.
- `exclusive: true` serves one Session per provider instance.
- Stagehand attach additionally needs `--remote-allow-origins=*` and `--enable-unsafe-extension-debugging` on the
  target Chrome [docs].
- **Gap for us:** we start Chrome per session on a worker and give MCP a *tapped* CDP URL
  (`ha:apps/server/src/browser/cdp-tap.ts`). This only works with a custom provider whose `open(agent)` picks a
  profile, starts or claims a Chrome, and builds the endpoint dynamically. [inferred]

### 1.7 Live view for the user — none for the agent's browser [src]

- `dsh:packages/client/ui-sidebar-browser` registers a right-sidebar tab type `browser`
  (`ctx.sidebarRightTabs.register`, slot `sidebar.right.pane.tab`) for **user browsing**. Web uses an `<iframe>`
  with a sandbox. Desktop uses an Electron `<webview>` via `DesktopBrowserBridge.acquire(workspace) → {lease, partition}`
  (`dsh:packages/client/ui-sidebar-browser/src/types.ts`). Its README states: "Model Experience: None … register no
  tool, prompt section, or Session event". The "lease" there is an Electron guest reservation, not a browser lease.
- No screencast, VNC or frame relay exists anywhere in `packages/`, `apps/` or `docs/`.
  `grep -iw 'vnc|novnc|screencast'` returned nothing.
- **Useful precedent for porting RemoteView:** a client plugin can register a new sidebar-right tab type per
  session (`ctx.sidebarRight.openTab('<type>', { params })`) and keep it mounted (`keepMounted`). [src]
  Moving JPEG frames and input from host to client would need a Typert Remote stream (`dsh:packages/api/gateway`
  "multiplexed Remote streams … Client-to-Host uplink" [docs]). Whether binary payloads are efficient there is
  **unverified** and belongs to the server/gateway slice.

---

## 2. dsh computer use

### 2.1 Registry — `dsh:packages/computer-use/computer-use/src/index.ts` (48 lines) [src]

Identical shape to §1.1: `ctx.computerUse`, `register(name: ComputerUseProviderName): () => Promise<void>`, and
`providerName`. Decision note `2026-09-12-computer-use-provider-registration.md` [docs]: there is **no Session
ownership broker**. "Concurrent Sessions remain caller-coordinated because a provider registration does not own an
observe, act, and verify workflow."

### 2.2 Cua Driver providers (upstream `@trycua/cua-driver`) [src]

- `dsh:packages/experimental/computer-use-cua-driver-mcp/src/index.ts` (71 lines). Config:
  `{ command='cua-driver', args=['mcp'], toolCallTimeoutMs?, reconnect }`. It mounts **one global stdio McpClient
  per provider**. That is process-wide, not per session. It exposes the upstream catalog unchanged.
- `dsh:packages/experimental/computer-use-cua-driver-native/src/index.ts` (138 lines). It runs
  `CuaDriver.create()` **in process**, so a native crash can kill the host [docs]. It reads
  `listToolsJson()` and registers each tool as `cua_driver_native__<name>` (must match `/^[A-Za-z0-9_-]{1,64}$/`)
  via `createMcpToolDefinition`. A `tools/execute` hook tracks pending calls and combines the abort signal with the
  provider lifetime. Its guidance says: "Discover the exact app and window, then get a fresh window snapshot before
  acting. Use element_token … A new snapshot of that window invalidates its earlier element tokens … Other sessions
  and applications may change the same desktop."
- Both drive **the desktop of the dsh host**. Neither has a remote target or a per-session desktop.

### 2.3 dsh-cua shared executor — `dsh:packages/experimental/cua/src/` (~2,200 TS lines) + `cua-macos` (Swift helper) [src]

```ts
// dsh:packages/experimental/cua/src/index.ts
export interface CuaBackend {
  helperPath: string
  createChannel: NativeChannelFactory      // platform-owned transport
  guidance: string; description: string
  permissionParameters: (method: 'requestPermission'|'openPermissionSettings', permission: CuaSystemPermission, locale: string) => Record<string, JsonValue>
}
export function installCua(ctx: Context, config: CuaConfig, backend: CuaBackend): void   // registers 'dsh-cua'
// dsh:packages/experimental/cua/src/native-client.ts
export interface NativeChannel { readonly stdin: Writable; readonly stdout: Readable; readonly done: Promise<void>; close(): void; waitForClose(): Promise<void> }
export type NativeChannelFactory = (owner: { subprocess: Pick<SubprocessRuntime,'spawn'> }, config: NativeClientConfig) => NativeChannel
export class NativeClient { request(method: string, params: Record<string, JsonValue>, signal: AbortSignal, callId?): Promise<JsonValue> }
```

- **Wire format.** JSONL. A request is `{id, method, params}\n`; a reply is `{id, result}` or
  `{id, error:{code,message}}`; cancellation is `{type:'cancel', id}`. Only **one request is in flight per
  connection** (`NATIVE_BUSY` otherwise). Per-request timeouts apply (`timeoutMs`, and `screenshotTimeoutMs` for
  captures). If cancellation is not acknowledged within `graceMs`, the connection is failed. Request and response
  frames are capped at `maxRequestBytes` and `maxResponseBytes`. [src]
- **One `NativeClient` per Agent** (`clients: Map<Agent, NativeClient>`), each with its own `CuaCoordinates`.
  Disposing the Agent closes its client. On macOS all Agents connect to one shared per-user helper over a Unix
  socket (`dsh:packages/experimental/cua-macos/src/shared-native.ts`). [src]
- **Tool exposure.** By default only Agents on the `ptc` preset get the tool (`agentPreset: 'ptc'`, through the
  `agentPresets` service, `agent/created` and `agent-preset/selected` events). `agentPreset: false` registers it
  globally. [src]
- **Persistent PTC object API.** The model runs JavaScript in a PTC REPL:
  `var { connectCua } = await import(...bridge.js); var cua = connectCua(() => tools.cua, ...)`, then
  `app = await cua.getApp('X'); await app.click(12)`. Raw `{method, params}` calls work too. [src: prompt section in `index.ts`]

### 2.4 Tool schema — one tool `cua`, a discriminated union on `method` (`dsh:packages/experimental/cua/src/protocol.ts`) [src]

| method | params (model-visible) |
|---|---|
| `getCapabilities`, `listApps` | `{}` |
| `findApps` | `{ query }` |
| `getApp` | `{ selector }` (name, bundle id, path or pid string) → `{appHandle, pid, name, bundleId?}` after consent |
| `activate` / `show` / `listWindows` | `{ appHandle [, windowId] }` |
| `getState` | `{ appHandle, windowId?, includeMenus?, details? }` → `{appHandle,pid,windowId,snapshotId,tree:string,windows,truncated}` |
| `click` / `hover` | `{appHandle, snapshotId, elementIndex}` **or** `{appHandle, windowId, snapshotId?, x, y, relative?}`, plus `mouseButton`, `clickCount 1/2`, `holdMs`, `modifiers: command/control/option/shift/fn` |
| `setValue` / `selectText` / `performSecondaryAction` | `{appHandle, snapshotId, elementIndex, ...}` |
| `typeText` / `paste` / `pressKey` | `{appHandle, text}` / `{appHandle, text, format text/html}` / `{appHandle, key (xdotool chord), modifiers?}` |
| `scroll` / `drag` | coordinates (absolute pixels, or `relative` 0–999 thousandths) + `deltaLinesX/Y ∈ [-10,10]` / `from*`, `to*` |
| `screenshot` | `{appHandle, windowId}` → PNG and window-point bounds. The Host admits it as an attachment and returns `coordinateSpace:'screenshot-pixels'` |

Host-only fields are never accepted from the model: `NativeResourceParameters` (maxElements, maxDepth, drag
duration/steps, clipboard limits) and `NativeOnlyOperations` (`launchApp`, `permissionStatus`, `applicationIcons`,
`requestPermission`, `openPermissionSettings`). Actions return `{dispatched:true, verified:false}`.
`CapabilitiesResult.browser` is `z.literal(false)` and `getState` returns `browsers: []`, so **CUA deliberately
excludes browsers**.

### 2.5 Approval / permission model [src]

- **Application consent** (`dsh:packages/experimental/cua/src/application-access.ts`). `getApp` → the native
  helper returns an `authorization` identity (sha256 id, name, executablePath?, persistable). Unless a saved grant
  or a session "allow" exists, it calls `ctx.userQuestions.ask({agent, questions:[{ intent:{kind:'approval', approve:'Allow for this session', reject:'Deny', always?:'Always allow'} }]})`.
  - Decisions are stored per conversation (`sessions[agent.id]`) and per application. "Always" is persisted in a
    profile-scoped JSON store with a file lock: `$DSH_HOME/storages/cua_permissions_<sha256>.json` [docs]. Every
    native call re-checks it (`access.run`). Revoking it cancels in-flight operations.
  - If `userQuestions` is missing, the call fails with `APP_APPROVAL_UNAVAILABLE`. **Subagents cannot ask**:
    `DELEGATED_CALLER` becomes "Application approval is unavailable in delegated tasks; ask the main task to perform
    this operation".
- **System permissions.** `ctx.cuaAccess` Remote (`dsh:packages/experimental/cua/src/access.ts`): `systemStatus()`,
  `requestPermission()`, `openSettings()`, `applications()`, `revoke(id)`, `retryApproval(id)`, `ptcConfiguration()`,
  `enablePersistentPtc()`, shown on a client `PermissionPanel`. These are macOS Accessibility and Screen Recording.
- **Generic tool approval** is a separate system (`dsh:docs/subsystems/approval.md`, `ctx.approval`, per-session
  `ask|never` policy, outcomes `allowed-once|rejected|cancelled|unavailable`, fail-closed) [docs]. CUA consent is
  explicitly "independent of the session tool-approval policy" [docs: cua README].

### 2.6 Snapshot and coordinate validity [src]

- `CuaCoordinates` (`dsh:packages/experimental/cua/src/coordinates.ts`) is per Agent. It maps screenshot pixels or
  relative thousandths to native window points.
  - `STALE_SNAPSHOT` means there is no observed frame for that window.
  - `SCREENSHOT_REQUIRED` means absolute pixels were used without a screenshot.
  - `INVALID_ARGUMENT` means a coordinate falls outside the image.
  - Resizing a window invalidates its mapping; moving it does not.
- Native codes documented in the guidance: `STALE_APP` (call getApp again), `STALE_SNAPSHOT` (call getState
  again), `WINDOW_CHANGED`, `FOREGROUND_REQUIRED`, `SESSION_LOCKED`, `PASTE_NOT_CONSUMED`, `AMBIGUOUS_TEXT`,
  `TEXT_NOT_FOUND`, `SELECTION_CHANGED`.
- Each `getState` replaces that surface's element indices. Other windows keep their snapshots.

### 2.7 What a Windows provider needs (dsh's own plan + gaps)

- [docs] `cua/README.md` "Known limitations": "Windows support is planned as a separate provider package with a C#
  helper, retaining the shared app/window API, authorization, snapshot validity, and action-result semantics." The
  `cua-bundle` README says "Windows support is in development". The bundle is gated with
  `disabled: !!js process.platform !== 'darwin'` (`dsh:packages/experimental/cua-bundle/cordis.patch.yml`).
- [inferred] A Windows backend would have to implement:
  - `CuaBackend` (helperPath, `createChannel`, guidance, description, permissionParameters).
  - A helper speaking the same JSONL methods over the `NativeChannel` streams, with a UIA tree in place of AX:
    `getState` text tree plus `snapshotId`; `screenshot` returning window bounds; `launchApp`; and an
    `authorization` identity, e.g. a sha256 of the exe path and signer.
  - Mappings for macOS-specific enums: modifiers `command/option/fn` to Win/Alt, and `bundleId`.
  - **A remote transport for us.** `NativeChannelFactory` returns `stdin`/`stdout` streams, so it can wrap a
    WebSocket or TCP stream to a helper inside the VM. Nothing in `installCua` assumes the helper is local except
    `helperPath` (unused if the factory ignores it) and the clipboard file lock in `tmpdir()`, which is host-local.
- dsh has no code for VMs, remote desktops, RDP or VNC, and nothing for Windows UIA.

---

## 3. HeyAgent today — browser layer (`ha:apps/server/src/browser/`, ~8,900 lines TS) [src]

### 3.1 Topology
- API process (`ha:apps/server/src/index.ts`) plus N **worker** processes (`ha:apps/server/src/engine/worker-runtime.ts`).
  Each worker owns one `BrowserManager` (`setBrowserManager`) and an internal control HTTP/WS server on
  `127.0.0.1:3190` (`ha:.../browser/control.ts`) authenticated with an HMAC-derived header (`token.ts`,
  `x-heyagent-internal`).
  - Control routes: `POST /browsers/login`, `POST /browsers/autologin`, `POST /browsers/:id/close`, `GET /health`,
    `WS /browsers/:id/view?userId&canControl`.
- Workers register in `browser_workers`; instances live in `browser_instances`. The API finds a worker with
  `pickWorker()` (the online worker with the fewest Chromes) and calls it with `callWorker()` (`ha:.../browser/access.ts`).

### 3.2 Pool and instances
- `BrowserManager` (`ha:.../browser/manager.ts`):
  - At most `browser.maxPerWorker` Chromes per worker (setting, default 4); extra requests queue FIFO
    (`waitSlot`, with a timeout).
  - Session Chromes start lazily and are written back and closed when the session ends or suspends. A Chrome is kept
    in state `held` for `browser.humanHoldMinutes` while a human handles a captcha or login.
  - "Open Chrome" (login) instances close after 30 minutes idle.
  - Heartbeats renew the worker and its account leases; a sweep cleans expired leases and dead workers.
- `BrowserInstance` (`ha:.../browser/instance.ts`) = its own **Xvfb** + a **headed Chrome** (`chrome.ts`, 1366×768,
  `--remote-debugging-port=0`, `--disable-blink-features=AutomationControlled`, locale/timezone, WebRTC leak guard,
  background networking off, optional proxy with `--host-resolver-rules`) + **the orchestrator's own Playwright CDP
  connection** + the session's Playwright MCP.
  - Kinds: `session | login`. States: `queued | starting | running | held | closing`.
  - The orchestrator connection installs and exports login state, blocks main-document navigations outside the
    allowlist, takes account leases per platform domain, watches dialogs, detects captchas, takes screenshots and
    serves the view.
- Proxy: `gost.ts` runs an authenticated-SOCKS5 forwarder per profile (password in a 0600 config file, never on a
  command line). Chrome never falls back to a direct connection.

### 3.3 Playwright MCP integration (`ha:.../browser/mcp.ts`, `tools.ts`)
- `@playwright/mcp` **0.0.83** (dsh pins 0.0.80), one stdio process per session Chrome, connected with
  `--cdp-endpoint <tap url>`, plus `--output-dir`, `--image-responses omit`, `--snapshot-mode none`,
  `--codegen typescript`, and vision caps when enabled.
  - The process gets a minimal env: `HOME=workDir`, `TMPDIR`, `TZ`.
  - The tool list is fetched once with a dummy endpoint and cached, so the gateway can expose tools before Chrome
    exists.
- Gating:
  - `browser_run_code_unsafe` is always blocked.
  - `browser_evaluate` needs the task setting "allow scripts".
  - Coordinate tools (`browser_mouse_*_xy`, `browser_mouse_down/up/wheel`) and `browser.look` need "allow vision".
- Naming: `browser_xxx` ↔ `browser.xxx` (dots become underscores for the model).
- `BrowserTools` (`ha:.../browser/tools.ts`, 1,575 lines) is the gateway around MCP. Per call:
  1. Check the navigation (allowlist, account lease).
  2. Call MCP. If a harmless overlay blocks the action, dismiss it and retry.
  3. Sweep pages and drain blocked navigations.
  4. Archive a screenshot after navigation.
  5. Detect captcha or login.
  6. Append the page brief.
  It also records `### Ran Playwright code` together with the URL before and after into `ToolOutcome.code/trace`
  (for solidify/routines) and keeps timings (`timing.ts`).
- Our own tools on the orchestrator's connection: `browser.use({profileId})`, `browser.batch` (≤20 steps, each
  expanded through the gateway), `browser.extract`, `browser.wait_any` (`extract.ts`), `browser.fetch` (`site-api.ts`),
  `browser.look`, `browser.copy_image`, `browser.clipboard_read`, `browser.clipboard_paste` (`clipboard.ts`), and
  `login_fill_captcha` (the login sub-agent's tool).

### 3.4 Leases and assignment (`ha:.../browser/leases.ts`)
- **Profile exclusivity:** one session Chrome per profile at a time. The system picks a free profile from those the
  task allows. If all are busy, the session **suspends** with `wait` on event `browser.profile:any` or
  `browser.profile:<id>`, and is woken FIFO when a profile frees up.
- **Platform × account lease:** at most N sessions per account (default 1), TTL `LEASE_TTL_MS` (120 s), renewed
  every 30 s by the worker. A full account blocks the navigation and suspends on `leaseEventName(accountId)`.
- A run uses one profile for its whole life (`sessions.browser_profile_id`).
- Waiting sessions **occupy dispatch slots** (`waits.ts`, `work/service.ts occupiesSlotSql`) [per `ha:docs/dev/desktop.md` §11].

### 3.5 Login vault + auto-login
- `vault.ts`: one encrypted `storageState` per profile (cookies + localStorage, optional IndexedDB), versioned.
  - Loaded at session start. Written back with a **three-way merge** (base / mine / theirs) plus version CAS.
  - AAD is bound to `browser_vaults:<profile>:<version>`.
  - A human's login in the remote view is merged on close.
- `auto-login.ts`: a small login-only agent (≤15 steps, model `loginModelId`).
  - The model sees `{{username}}` / `{{password}}` placeholders, which are substituted only inside the tool call.
    The password is masked as `[已隐藏]` in outputs.
  - Passwords are filled only on the account's domains.
  - It can call `login_fill_captcha` and `login_need_human`.

### 3.6 Captcha / login detection (`detect.ts`, `captcha.ts`)
- After each tool call, `judgePage(PageFacts)` checks frame URLs (reCAPTCHA, hCaptcha, Turnstile, GeeTest, Arkose),
  keywords and password inputs. An "uncertain" verdict goes to an optional vision model check (`browser.visionCheck`).
- `solveCaptcha`: numbers elements across all frames, sends a page screenshot plus zoomed crops to a vision model,
  and gets a JSON plan back (fill text into a box / click a checkbox / give up), up to `CAPTCHA_MAX_TRIES = 3`.
  Third-party providers are never attempted.
- Failure → `humanOutcome`: save a screenshot file, create a "登录" to-do item for the task owner, and
  `suspend {kind:'human'}`. Chrome is kept in `held` for `humanHoldMinutes`. The `page_needs_human` signal feeds the
  rule engine.

### 3.7 Clipboard, downloads, network log, page brief, form readback, site API, CDP tap
- `clipboard.ts`: clipboard read/write in the CDP isolated world, after `bringToFront` and an origin permission
  grant.
  - Images are fetched with `Network.loadNetworkResource`, i.e. **through Chrome's own network stack** (proxy and
    cookies), never via Node.
  - Element refs from MCP are resolved through MCP `browser_evaluate`, which sets a one-shot attribute.
  - Tables use TSV (`tsv.ts`). Each Chrome has its own Xvfb, so clipboards are isolated per run.
- `downloads.ts`: browser-level `Browser.setDownloadBehavior allowAndName` plus `downloadWillBegin/Progress`. Every
  download (including those a human makes in the remote view) becomes a run file of kind `download` and is
  announced in the next tool output.
- `network-log.ts`: when "allow site API" is on, records the page's own XHR/fetch traffic to
  `network/requests.jsonl`.
  - Masks secrets; caps at 500 entries / 2 MB / 3 per method+URL.
  - `seq` numbers link entries to the step that issued them (`trace.network`).
- `site-api.ts`: `browser.fetch`, run in the page's isolated world with the page's origin and cookies. Enforces
  `fetchTargetAllowed` (same origin or allowlist) and masks output with `maskJson/maskUrl`.
- `page-brief.ts`: after an action, a ≤1 s read of title, URL, visible overlays and buttons, and the MCP
  `### Modal state` (translated into guidance). Auto-clicks harmless close buttons (`HARMLESS_CLOSE_TEXTS`).
- `form-readback.ts`: after `fill_form` / `type`, reads the actual field values back using the recorded Playwright
  code, masking secrets.
- `cdp-tap.ts`: a localhost CDP proxy between MCP and Chrome.
  - Parses `Input.*`, `Page.bringToFront` and `Page.navigate*` to learn the agent's cursor and active tab. Adds a
    `PRESS_DELAY_MS = 200` before a press when someone is watching.
  - The page sees nothing; nothing is injected.

### 3.8 Remote view relay + human takeover
- `viewer.ts` (`ViewerHub`, one per Chrome):
  - `Page.startScreencast` only while there are viewers, scaled to 960 wide; frames are acked immediately and
    dropped when a viewer's buffer is over 1 MB.
  - Follows new tabs and the agent's tab switches.
  - Input is forwarded without awaiting (dialogs block the renderer). Pushes the agent cursor, the focused-input
    position and the current tool label.
- `view-relay.ts`: API `GET /api/browser/view/:browserId` (WebSocket upgrade, logged in, Origin check) →
  worker control WS.
  - Anyone logged in can view. Only the session owner, the assignee of an open to-do item or an admin can control.
    `?viewOnly=1` forces view only.
  - The auth/origin/drop logic is shared with desktop in `ha:apps/server/src/lib/ws-relay.ts`.
- Web: `ha:apps/web/src/components/remote-view/` — canvas JPEG renderer (`index.tsx`), WS hook with reconnect
  (`use-remote-view.ts`), input mapping (`input.ts`, CDP modifier bits), agent virtual cursor (`agent-cursor.tsx`),
  and a dialog that collapses to a draggable mini window, rendered at the root via `store.ts` (`kind:id` keys).
- Human takeover = a durable `suspend {kind:'human'}` with a to-do item → the human acts in the remote view →
  "已处理好了" resumes the run. The Chrome stays `held` **in that worker's memory** (`manager.claim`) — "浏览器的
  Chrome 做不到" cross-worker resume (`ha:docs/dev/desktop.md` §0).

---

## 4. HeyAgent today — desktop layer [src]

### 4.1 Manual desktops (`ha:apps/server/src/desktop/`, ~1,500 lines; doc `ha:docs/dev/desktop.md`)
- A desktop = a Windows machine running two services in the logged-in user session (scheduled task, `pythonw`):
  - **Windows-MCP 0.8.8** on `:8000` (streamable-http, `--auth-key`).
  - **Our desktop agent** (`ha:apps/desktop-agent/`, Python 3.14) on `:8001`.
  - Both share a Bearer key, stored encrypted (`secrets.scope = desktop`).
- `client.ts`:
  - `loadDesktopTarget` decrypts the key.
  - `connectDesktopMcp(target)` opens a `@ai-sdk/mcp` http transport with an `Authorization` header.
  - `agentHealth`, `agentScreenshot`, `agentUpload`, `agentDownload`, `agentType` call the desktop agent;
    `testDesktop` checks both services.
- Tools (`tools.ts` 590 lines, `mcp-tools.ts`):
  - `desktop.use`, plus 12 whitelisted Windows-MCP tools (`DESKTOP_MCP_TOOLS` in `ha:packages/shared/src/desktop.ts`:
    snapshot, click, type, scroll, move, shortcut, app, wait, …) with **hard-coded zod schemas**, so the tool group
    can be built offline.
  - `desktop.look` (only with "allow vision"; ≤1920 wide), `desktop.send_file`, `desktop.fetch_file`,
    `desktop.ask_human`.
  - Dangerous tools are off: PowerShell, FileSystem, Registry, Process, and `launch_executable`.
  - `desktop.snapshot` gets `use_vision:false` unless vision is allowed.
  - Non-ASCII `desktop.type` is routed to the agent's `POST /type`, because Windows-MCP `Type` drops CJK.
- Control handoff (`control.ts`): Windows-MCP returns `USER_CONTROL`, `TAKEOVER_PENDING`, `PHYSICAL_INPUT_HELD`,
  `CONTROL_UNAVAILABLE` or `CONTROL_PREEMPTED` while a human is using the mouse or keyboard. The tool waits
  `wait_seconds + 0.3` and retries for up to about 15 s.
- Leases (`leases.ts`): DB table `desktop_leases`, at most one row per desktop, `session_id` unique.
  - `state running` uses `expires_at = now + 2 min`, renewed every 30 s. `held` uses `hold_until = now + humanHoldMinutes`.
  - `acquireDesktop → "new"|"mine"|"busy"`. Busy suspends with `wait` on `desktop:<id>` or `desktop:any`.
  - Waiters are woken FIFO. A sweep runs every 30 s. Admins can force-release.
  - **Leases are DB-only, so any worker can resume** (unlike browser).
- Human handoff: `desktop.ask_human({reason})` → screenshot + `suspend {kind:'human', item: login-type to-do}`, and
  the lease becomes `held`.
- View relay (`view-relay.ts`): `/api/desktop/view/:desktopId[?viewOnly=1]`, API → agent `ws(s)://…/view` with
  Bearer. It rewrites `meta.canControl` and validates upstream input with `desktopViewerClientMessageSchema`. The
  worker is **not** on this path, so `agentAction` is not pushed.

### 4.2 Python desktop agent (`ha:apps/desktop-agent/heyagent_desktop_agent/`, ~1,600 lines) [src]
- Starlette routes (`app.py`): `GET /health`, `GET /screenshot?maxWidth&quality` (JPEG + `X-Screen-Width/Height`),
  `GET|POST /files` (≤200 MB; GET restricted to `%USERPROFILE%` and `C:\HeyAgent\files`), `POST /type`,
  `WS /view`.
- `/view`:
  - Sends `{t:'meta',width,height,canControl}`, then binary JPEG frames, only while someone is watching (≤5 fps,
    unchanged frames skipped, ≤1280 wide, q60; `hub.py`, `frames.py`).
  - Sends cursor events `{t:'cursor',x,y,kind:'move'|'press'}`.
  - Accepts `{t:'mouse'|'key'|'text'|'combo', …}` (`messages.py`), which become `SendInput` with absolute physical
    pixels, `KEYEVENTF_UNICODE` for text, and clipboard + Ctrl+V for long text (`inputplan.py`, `keymap.py`,
    `win32.py`). The process is DPI-aware.
- Installer: `ha:apps/desktop-agent/install.ps1`.
  - Installs `windows-mcp==0.8.8` and the agent, disables telemetry, writes the key file and scheduled tasks,
    opens the firewall, and disables lock screen and sleep.

### 4.3 HeyAgent-run Windows VMs (`ha:apps/server/src/desktop/vm/`, ~1,500 lines; doc `ha:docs/dev/desktop-vm.md`) [src]
- `desktops.kind`: `manual | template | vm`. Table `desktop_vms` holds template_id, storage_path, dir, container,
  state, desired, ports, password secret, etc.
- Uses the **Podman REST API** (libpod over a unix socket, `HEYAGENT_PODMAN_SOCKET`; `podman.ts`) with
  `docker.io/dockurr/windows` **pinned by digest** (`config.ts DOCKUR_IMAGE`).
  - Required: `/dev/kvm`, `/dev/net/tun`, `NET_ADMIN`, the annotation `run.oci.keep_original_groups=1`, and
    `slirp4netns port_handler=slirp4netns`.
  - Ports 8000/8001 map to a host port range (`ports.ts`, re-picked when a port is busy).
- `lifecycle.ts` — one pg-boss job `desktop.vm` per desktop (singletonKey):
  - **Template:** OEM dir (Python installer with pinned sha256, our desktop agent, `install.bat`; `oem.ts`) →
    unattended Windows install (`installing`) → first health check (`setup`) → the admin installs apps in the
    remote view → **seal**: graceful stop, remove the container, `chmod 444` the disk → `ready`.
  - **VM:** `qemu-img create -f qcow2 -b <template>` (copy-on-write) in a one-shot container, with host paths
    mirrored inside it → copy dockur's "installed" marker files → start → poll `/health` every 5 s → `running`.
  - Reset = recreate the overlay. Timeouts are 8 h for a template and 20 min for a VM.
  - Reconciliation sweep every 30 s, including auto-start when `desired = running`.
- `storage.ts`: choices are limited to `HEYAGENT_DESKTOP_STORAGE_ROOTS`. Free space via `statfs`. SSD vs HDD via
  `/sys/dev/block/<maj>:<min>/queue/rotational` (falls back to the parent device). Admins can override per root.
  Minimum free space is 40 GB.
- `host.ts`: before boot, check that RAM in use + this VM ≤ host RAM − `HEYAGENT_DESKTOP_RESERVED_GB` (24 GB).
- `service.ts`: tRPC-side create/start/stop/restart/reset/seal and storage settings. It only changes DB
  `desired`/`op` and writes an audit entry; the worker does the work.
- The agent-facing side (tools, leases, view) is unchanged for VMs. Templates are never assignable, and a VM is only
  assignable while `running`.

---

## 5. Mapping onto dsh plugins

### 5.1 Browser: a custom provider plugin `heyagent-browser` (registers `ctx.browserUse`)

Base it on **Stagehand's pattern** (own tools, lazy start), not on `mountSessionMcp`, which starts eagerly, uses a
fixed endpoint and is stdio-only. [inferred from §1.3–1.4]

```ts
// sketch (not dsh code)
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', /* + our db/settings/files services */]
export function apply(ctx: Context, config: Config) {
  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName('heyagent-browser'))
    const resources = new SessionResources<RunBrowser>(ctx, {
      label: 'heyagent-browser', exclusive: false,          // pool exclusivity enforced by OUR DB leases, not by dsh
      async open(agent, signal) { /* pick profile (DB), lease, start Xvfb+Chrome or claim held, vault load, cdp-tap, MCP client */ },
    })
    yield () => resources.dispose()
    const child = ctx.plugin({ name: 'heyagent-browser-tools', inject: ['tools','systemPrompt'], apply: inner => mountTools(inner, resources) })
    yield child.dispose
  })
}
```

| Our capability | Target | Notes |
|---|---|---|
| Registry slot | dsh `ctx.browserUse.register` | Reuse as is. |
| Per-run ownership, serial calls, abort, cleanup | dsh `SessionResources<T>` (reuse; it lives in an *experimental* package, so vendor it or depend on it) | Key = live Agent. See blocker B1 for subagents and the durable run. |
| Pool / `BrowserManager` / `maxPerWorker` / FIFO slots | **Provider code** (port `manager.ts`) | dsh has no pool. |
| `browser_workers` / `browser_instances`, control HTTP/WS on 127.0.0.1 | **Provider code, or removed** | If dsh runs as one host process per box, the API↔worker hop disappears; if we keep multiple processes it stays. See B4. |
| Xvfb + headed Chrome launch (`chrome.ts`), gost SOCKS5 (`gost.ts`) | **Provider code** (port as is) | dsh launch mode is headless `--isolated` and has no proxy support. |
| Profile pick + profile exclusivity + account leases (`leases.ts`) | **Provider code + our DB** (keep tables) | dsh has nothing comparable. |
| "Wait for a browser" suspend (`suspend {kind:'wait', event}`) | **New in dsh** (engine slice) | dsh tools cannot durably suspend a Session; see B2. |
| Playwright MCP (0.0.83, tapped CDP, codegen, `--image-responses omit`) | **Provider code**: per-Agent `McpClient` stdio in a `createScope(ctx, agent)`, as `mountSessionMcp` does, but with our args and a dynamic endpoint | Copy roughly 60 lines of the `mountSessionMcp` scope/guard pattern. dsh pins 0.0.80; we use 0.0.83. |
| Tool gating (block run_code_unsafe, evaluate behind "allow scripts", vision tools behind "allow vision") | **Provider code**: `scope.ctx.tools.restrict({deny})` per Agent (verified in `mcp.ts`), driven by the task snapshot | |
| Our wrappers (`browser.batch`, `extract`, `wait_any`, `fetch`, `look`, clipboard ×3) | **Provider code**: `ctx.tools.register(createMcpToolDefinition(...))` or plain `ToolDefinition` | Names must match `^[A-Za-z0-9_-]{1,64}$`, so keep the underscore form. |
| Per-call pipeline (nav check, overlay retry, sweep, archive screenshot, detect, brief, codegen trace, timings) | **Provider `tools/execute` hook**, wrapping `next()` the way Stagehand does | Trace/`ToolOutcome.code` must map to dsh tool result metadata or a Session event; see B6. |
| Vault (3-way merge, CAS, AAD) | **Provider code + our DB/keyring** | Loaded in `open()`, written back in `close()`. dsh's rule against restoring browser state *from the Session log* does not apply because ours is per profile. |
| Auto-login mini agent | **Provider code** calling dsh LLM (`ctx.llm`), or a dsh **subagent** | Secrets: `{{password}}` substitution inside our tool wrapper. Check whether dsh has a secret-redaction hook (credentials slice). |
| Captcha detect/solve (vision model) | **Provider code** using dsh `ctx.llm` + attachments | |
| Human takeover (to-do item, held Chrome, "已处理好了") | **New**: dsh `userQuestions.ask/askTimed` is the nearest primitive, but it is in-process, fails in subagents, and is not a to-do inbox | See B2/B3. |
| Downloads, network log, site API, page brief, form readback, CDP tap | **Provider code** (port as is; they use the orchestrator's own Playwright/CDP connection) | |
| Remote view (`viewer.ts` screencast hub) | **Provider code** (host side) | |
| View relay WS (`view-relay.ts`, `lib/ws-relay.ts`) + auth (owner / assignee / admin) | **New dsh host route or Typert Remote stream** | Gateway binary streaming unverified (§1.7). |
| RemoteView UI (canvas, cursor, mini window) | **New dsh client plugin**, e.g. register a sidebar-right tab type like `ui-sidebar-browser` does | Rebuild with dsh's client UI kit, not shadcn; see the frontend slice. |
| Login Chrome ("Open Chrome" for a human, no session) | **New** (host route + provider API) | dsh has no notion of a browser without a session. |

### 5.2 Desktop: a custom provider plugin `heyagent-desktop` (registers `ctx.computerUse`)

Two options:

**Option A (recommended first): wrap Windows-MCP per session, using the stagehand/cua-driver-native style.**
- `SessionResources<DesktopConn>` with `exclusive: false`, plus **our DB `desktop_leases`** for exclusivity.
- `open(agent)` picks or acquires a desktop (DB), then `scope.ctx.plugin(McpClient, { transport:'streamable-http', url, headers:{Authorization} })`.
  The dsh MCP client supports `streamable-http` with headers (`dsh:packages/mcp/mcp-client/src/index.ts:110-181`) [src].
- Alternatively keep our hard-coded 12 tool schemas and call through a client, which keeps "offline tool list"
  behaviour.
- Port `control.ts` (USER_CONTROL retry), the CJK `/type` reroute, `look`, `send_file`, `fetch_file` and
  `ask_human`.

**Option B (later): implement a `CuaBackend` for Windows.**
- `createChannel` = a WebSocket/TCP JSONL stream to a new endpoint in our Python agent, speaking dsh-cua's protocol
  (§2.4) with a UIA tree. This gets dsh-cua's object API, snapshot validity and coordinate mapping.
- Costs: a large new helper surface (getApp/getState/UIA text tree/snapshotId/window screenshots/authorization ids)
  and macOS-specific enums.
- Its consent model (`userQuestions` per app, fails in subagents, `agentPreset:'ptc'`) does not fit unattended
  runs; we would need to pre-grant or bypass it. `installCua` also always registers `'dsh-cua'` as the
  computer-use provider name, so A and B are mutually exclusive in one composition [src].

| Our capability | Target | Notes |
|---|---|---|
| Registry slot | dsh `ctx.computerUse.register` | One provider per composition, so manual and VM desktops must sit behind **one** provider (they already share one tool group). |
| Windows-MCP 0.8.8 per run (http + Bearer) | **Provider code** (dsh McpClient streamable-http in a per-Agent scope) | dsh cua-driver-mcp is one global stdio client, so it does not fit. |
| Hard-coded tool schemas / whitelist / `use_vision` forcing | **Provider code** (`ctx.tools.register` + `restrict`) | |
| Desktop leases (DB, TTL, held, sweep, wake) | **Provider code + our DB** | dsh has no desktop reservation at all [docs: decision note]. |
| "Wait for a desktop" suspend | **New in dsh** (same as browser) | |
| `desktop.ask_human` + held lease + remote view handoff | **New** (same as browser, B2/B3) | |
| Python desktop agent (`/health`, `/screenshot`, `/files`, `/type`, `/view`) | **Stays as is** (runs on Windows; not a dsh concern) | For option B, add a JSONL/UIA endpoint. |
| View relay `/api/desktop/view/:id` + RemoteView desktop mode | **New dsh host route + client plugin** (shared with the browser view) | |
| VM lifecycle (Podman REST, dockurr, qcow2 overlays, templates/seal, ports, health, reconcile) | **New dsh host service plugin** (not a computer-use provider; e.g. `heyagent-desktop-vm` exposing a Typert Remote for the UI) | Needs a durable job runner (we use pg-boss); check the dsh jobs/schedule slice. |
| Storage roots, SSD/HDD detection, RAM reservation check | Same VM service plugin | Pure Node, ports as is. |
| Desktop CRUD, secrets (Bearer key encrypted) | dsh settings/credentials slice + our DB | |

### 5.3 Pieces that are not providers
- All the UI (browser page, desktops page, template/VM dialogs, storage settings, RemoteView) becomes dsh client
  plugins. The pattern is visible in `ui-sidebar-browser`: `ctx.sidebarRightTabs.register`, `ctx.slots.register`,
  locale namespaces [src].
- Rules/checkpoints keyed on `browser.*` / `desktop.*` tool names (`rules.ts`, `rule-compile.ts`,
  `checkpoint-sync.ts`, `waits.ts`) map to dsh `tools/execute` / `tools/post-execute` middleware. That belongs to
  the engine slice.

---

## 6. Mismatches and blockers

| # | Severity | Mismatch | Evidence | Mitigation |
|---|---|---|---|---|
| B1 | **High** | Resources are keyed by the **live `Agent` object**. Our unit is the *run* (root session, durable across suspend/resume, possibly spanning sub-agents). A dsh subagent is a different Agent, so it would get a different `SessionResources` entry, meaning a second Chrome or desktop, unless we key by root. | `index.ts` `Map<Agent, Entry>`; `ctx.agents.get(agent.id) === agent` | Don't use `SessionResources` as-is. Fork it to key by root session id (DB), or resolve the root Agent in the `tools/execute` hook. |
| B2 | **High** | **No durable suspend/wait** for a tool in dsh core. dsh resources die with the Agent ("reload or fork starts fresh"). We park runs for hours or days waiting on events (`browser.profile:*`, `browser.lease:*`, `desktop:*`, human). | `docs/subsystems/browser-use.md` "Session ownership"; no suspend primitive found in `packages/core` | Engine slice must provide or port the suspend/resume machinery. The provider then releases the resource on suspend, which matches our current release-on-suspend. |
| B3 | **High** | Human takeover: dsh human interaction is `userQuestions.ask` (in-process wait; it does survive restart in the projection [docs]). It throws `DELEGATED_CALLER` for subagents and has no assignee, to-do inbox or "held" resource. CUA app consent hard-depends on it. | `user-questions/src/index.ts:146-148`; `application-access.ts:152-176` | Keep our to-do items ("要人办的事") + held leases as a HeyAgent plugin; don't adopt CUA consent for unattended runs. |
| B4 | **High** | One provider per **composition** (Cordis service instance), and attach exclusivity is **in memory per provider instance**. We run an API plus N worker processes with a DB-coordinated pool and per-worker control servers. | registry `register()`; decision note "do not coordinate separate DSH processes" | Keep all coordination in our DB (leases, `browser_workers`). Decide in the server slice whether dsh runs one process or many. The held Chrome is per process (already true for us today). |
| B5 | Medium | `mountSessionMcp`: fixed command/args, eager start at `agent/created` (failure **rejects Session creation**), stdio only, no retry when busy. We need lazy start, a dynamic CDP endpoint and suspend-when-busy. | `mcp.ts` 102-220 (`agent/created` hook at 181) | Write our own provider; copy only the scope + ownership-guard idea. |
| B6 | Medium | Tool result shape: our `ToolOutcome` carries `suspend`, `signals`, `facts`, `images`, `secrets`, `code`, `trace`, `timings`, `data`. dsh tools return a canonical JSON value plus `output.render`, `projectContent` and `finalizeContent`. | `ha:apps/server/src/engine/tools/builtin.ts:90-123`; `dsh:packages/core/tools/src/contracts.ts:26-61` | Engine slice: map these to dsh Session events or metadata. Images use dsh attachments, which need an image-capable route. |
| B7 | Medium | No live view in dsh, so our whole screencast → relay → canvas stack is new code on dsh's host and client. | §1.7 | Port `viewer.ts` + relay. Verify binary throughput over the Typert gateway, or add a raw WS route. |
| B8 | Medium | Computer use in dsh = **the local host desktop**, macOS only. Windows is planned (C# helper). There is no remote target concept. | `cua/README.md` limitations; `cua-bundle/cordis.patch.yml` darwin gate | Option A (§5.2). |
| B9 | Medium | `SessionResources` `exclusive:true` throws immediately when busy; it has no FIFO wait. | `index.ts` `entry()` | Use `exclusive:false` plus our DB leases and waits. |
| B10 | Low | Version drift: dsh pins `@playwright/mcp` 0.0.80, we use 0.0.83 (with codegen and snapshot-mode flags). | provider `package.json`; `ha:.../browser/mcp.ts` | Pin our own in our provider. |
| B11 | Low | Tool names: dsh uses `^[A-Za-z0-9_-]{1,64}$` (cua-driver-native) and `mcp__<server>__<tool>`; ours are dotted `browser.*` / `desktop.*` in rules/snapshots/UI. | `computer-use-cua-driver-native/src/index.ts` `TOOL_NAME` | Keep the underscore form on the wire; migrate rule matchers. |
| B12 | Low | dsh-cua tools default to `agentPreset:'ptc'` and expect a persistent PTC REPL object API. | `cua/src/index.ts` CuaConfig | Only relevant for option B; set `agentPreset:false`. |
| B13 | Low | Stagehand requires a non-DeepSeek native model catalog. We use our own model routing (OpenRouter/custom). | stagehand README | Not needed; we keep Playwright MCP. |
| B14 | Info | Clipboard in dsh-cua uses a host-local file lock (`tmpdir()/dsh-cua-system-clipboard`). Our clipboard is per-Chrome Xvfb (browser) or per-VM (desktop). | `cua/src/index.ts` callNative paste | Nothing to reuse. |

---

## 7. Size of reuse

| dsh piece | Lines | Reuse for us |
|---|---|---|
| `browser-use/browser-use` registry | 48 + 15 | Yes (trivial). |
| `computer-use/computer-use` registry | 48 + 15 | Yes (trivial). |
| `browser-use-runtime/src/index.ts` `SessionResources` | 197 | Pattern yes; as-is only if B1 is solved (key by root). |
| `browser-use-runtime/src/mcp.ts` `mountSessionMcp` | 220 | Ideas only (scope per Agent, ownership guard, tool masking, prompt filtering). |
| `browser-use-playwright-mcp`, `chrome-devtools-mcp` | 51, 43 | No (fixed args/endpoint). |
| `browser-use-stagehand-native` | ~550 | Template for provider structure; no functional reuse. |
| `mcp-client` `createMcpToolDefinition`, streamable-http transport | — | Yes (image/result projection, http + headers). |
| `computer-use-cua-driver-mcp/native` | 71, 138 | No (local host, global client). |
| `cua` (+ `cua-macos`) | ~2,200 TS + Swift | Option B only: `installCua`, `NativeClient`, `CuaCoordinates`, `protocol.ts` are reusable if we write a Windows helper. |
| `client/ui-sidebar-browser` | ~3,100 TS incl. tests | No functional reuse (user iframe browser). Its tab-registration pattern is a template for a RemoteView client plugin. |

Ours to port (approximate TS/Python lines): browser 8,900 · desktop 1,500 · VM 1,500 · desktop agent (Python) 1,600 ·
remote-view web 1,170 · shared contracts in `ha:packages/shared/src/{desktop,browser…}.ts`.

---

## 8. Open questions for other slices
1. Engine slice: does dsh have (or will we port) durable session suspend with event or time triggers, plus wake?
   This is required for B2.
2. Server slice: one dsh host process or several? How do we expose a raw WebSocket route (for the view relay) or
   stream binary frames through the Typert gateway?
3. Subagent slice: is a dsh subagent a separate `Agent` in `ctx.agents`? If so, how does a provider find the root
   run to share one browser or desktop (B1)?
4. Credentials slice: is there a secret-redaction hook for tool outputs (our `ToolOutcome.secrets`, password
   placeholders)?
5. Jobs slice: is there a durable singleton job runner for the VM lifecycle (we use pg-boss `desktop.vm` with
   singletonKey)?
