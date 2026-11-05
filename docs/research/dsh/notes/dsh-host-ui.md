# dsh slice: host, web server, RPC, auth, browser client/UI

Source: DeepSeek Harness (dsh) @ 8bd07339, `deepseek-ai/deepseek-harness@8bd07339 的本地克隆` (read only; nothing executed).
All paths are repo-relative. Tags: **[src]** = verified in TypeScript source; **[docs]** = docs/README only; **[infer]** = my inference, not verified.

---

## 0. Executive summary

- **One process, one owner.** The Web host is a single Node process (`node:http`/`node:https`) that the DSH CLI starts with `dsh --profile web`. Every authenticated browser request becomes **the same `browserPeer` with principal `{ kind: 'owner' }`**. There are no user accounts, no login page, and no logout. Authentication is a per-process launch token (`?token=` in the printed URL), which is swapped for an HMAC-signed cookie. **[src]**
- **Non-owner principals exist, but only as a narrow mechanism.** `PrincipalMap` is merge-extensible, and `remote-access` gives RBAC (roles, bindings, policies) per resource kind (`global`, `session`, `workspace`). LiveShare is the only production non-owner (`share-viewer`). For non-owners there are hard owner-only cut-outs: exact Fetch routes return 403 (this includes `/api/file` image reads, file uploads and session export); only the owner can answer forwarded waterfalls; only the owner gets HTTP index renders. **[src]**
- **No pluggable authenticator.** `HostConnectionService.admit()` is concrete code, and it maps every valid browser cookie to `browserPeer`. To get real multi-user accounts we must fork `packages/client/connection` (`rpc-host.ts`, `browser-auth.ts`). There is a liveshare-style workaround that needs no fork: our own route plus `connection.createPeer()` plus `createSharedFetchHandler('/api').fetch(req, peer)` plus `typertGateway.wireStream.open(...)`. **[src]**
- **RPC is simple to call from any same-origin SPA.** A unary call is `POST /api/<ns>/<method>` with the JSON envelope `{type:'client-request', rpcId, method, payload:{args}}`. A stream goes over the WebSocket `/api/remote.mux` with JSON frames `open/item/end/cancel`. There is no public or versioned API guarantee: only an internal "additive names" review rule. **[src]**
- **The client UI is React 18.3** (not 19), plus Cordis in the browser, typed Slots, CSS Modules, `--dsw-*` tokens and their own `ui-primitives`. The rules ban Tailwind and component libraries (docs only; no script enforces it). There is **no URL routing at all**: panels are in-memory `main` keyed slots. **[src]**
- **Cleanest host for about 20 shadcn admin pages: our own React 19 + shadcn SPA on the same origin**, calling dsh Remote over `/api`. The dsh shell stays for the chat/run view, or we re-render runs from `session/follow`/`page` plus projections. Putting shadcn pages inside the dsh shell is possible (as `main` panels) but runs into React 18 vs shadcn's React 19 `ref`-as-prop components, a Tailwind build step and preflight conflicts, the i18n lint, and no deep links.

---

## 1. Host & web server

### 1.1 Layering **[docs+src]**
`remotes → gateway → connection → webserver` (from `docs/api-gateway.md` §Boundaries).

| Package | Role |
|---|---|
| `packages/host/webserver` (`ctx.webServer`, class `WebServer` in `src/index.ts`, 743 lines) | Bare HTTP carrier. Holds the named-route registry (exact table, then longest prefix, then one fallback seat), the upgrade registry, gzip, and index injection. It owns **no auth and no Origin policy**. |
| `packages/client/connection` (Host face `src/index.ts`, `src/rpc-host.ts`; `ctx.connection`) | Mounts the `/api` prefix route and `/connect`. Runs the Host/Origin fence (`src/api-request-trust.ts`) and browser auth (`src/browser-auth.ts`). Holds the exact Fetch-route registry and the shared RPC interceptor. |
| `packages/api/gateway` (`ctx.typertGateway`) | Claims the `/api/<ns>/<method>` endpoints. Registers the `/api/remote.mux` WebSocket via `webServer.registerUpgrade`, at `src/index.ts:309`. |
| `packages/host/frontend-static` | Claims the webserver **fallback seat** with the SPA dist resource. Index requests go through `ctx.connection.authorizeIndex`; other assets are public. |
| `packages/bundle/web-app` (`ctx.webApp`; `cordis.patch.yml`; `src/startup.ts`) | Composition glue. Resolves the dist of `@deepseek-ai/dsh-web-frontend` (`apps/web`), mounts `frontend-static`, prints the token URL, and parses the CLI flags. |
| `apps/web` | Vite build of the shell (`src/main.ts` → `AppWebEntry` from `@deepseek-ai/dsh-client-web`). The output is `dist/index.html`, and plugin bundles load at runtime from `/plugins/??...`. |
| `packages/client/modules` (`ctx.clientModules`) | Scans Loader rows that declare `dsh.client`. Serves the `/plugins` prefix (combo JS and assets) and injects `window.__DSH_BOOT__`. |
| `packages/client/hmr` | Exact SSE route for live graph updates (`client/hmr/src/index.ts:181`). |

### 1.2 WebServer API (`packages/host/webserver/src/index.ts`) **[src]**

```ts
type WebRouteKind = 'exact' | 'prefix'
interface WebRoute { kind; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }
type WebResource = (request: Request, peer?: PeerScope) => Promise<Response>      // GET/HEAD + in-process readResource
interface WebResourceRoute { kind; path; resource: WebResource }
interface WebUpgradeRoute { path: string; handler: (req, socket: Duplex, head: Buffer) => void | Promise<void> }
class WebServer {
  getOrigin(): string
  register(route: WebRoute | WebResourceRoute): () => void         // duplicate (kind,path) throws
  registerUpgrade(route: WebUpgradeRoute): () => void              // exact path only
  registerFallback(fallback): () => void                           // one owner only
  readResource(request: Request, peer: PeerScope): Promise<Response>
  tapIndex(transform: (html: string) => string): () => void
  collectIndexInjections(peer): IndexInjection[]                   // emits 'webserver/index-inject'(table, peer)
  renderIndex(html, peer): string
  readonly host; readonly port; readonly protocol: 'http:' | 'https:'
}
```

- **How a host plugin adds an HTTP route** **[src]**: `ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/hooks/x', handler }))`. Example: `packages/experimental/webhook-github/src/index.ts:47-60`. Raw `webServer` routes get **no auth**. The plugin must call `ctx.connection.requestRejection(req)` or `ctx.connection.admit(req)` itself.
- **An authenticated non-RPC route under `/api`** **[src]**: `ctx.connection.fetch.register(route)`.

  ```ts
  interface ConnectionFetchRoute {
    readonly path: string                                    // absolute, below /api
    readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
    readonly requestBody: 'buffered' | 'streaming'
    readonly fetch: (request: Request) => Promise<Response>  // NOTE: no Peer parameter
  }
  ```

  Users include `client/file-upload/src/index.ts:80`, `api/session-controller/src/media-references.ts:77` (`/api/file`), `session-query/session-log-export`, `ui-deliverables/src/present-open.ts`, plugin-manager and plugin-market. In `rpc-host.ts:219-221`, exact routes return **403 to every non-owner Peer**, and the handler never sees the Peer.
- A WebSocket is added with `ctx.webServer.registerUpgrade({ path, handler })`. The gateway's own `/api/remote.mux` is the example: it calls `ctx.connection.admitConnection(req)` first.
- **Index HTML injection**: listen on `'webserver/index-inject'(table, peer)` and push `{ kind: 'global', name, value }` rows. Connection pushes `__DSH_CONNECTION_RECOVERY__`; remote-access pushes `__DSH_REMOTE_ACCESS__`; client-modules pushes the boot graph.
- **Fallback rules (frontend-static)** **[src]**: only `/` and the configured `index.html` render the index. **A missing path is 404, so there is no SPA history fallback.** Non-GET/HEAD is 405, traversal is 403, and non-index files get weak ETags.
- Error handling: a throwing handler is answered 400 and does not exit the process. Disposal force-closes SSE and upgraded or TLS sockets. **[docs]**

### 1.3 Binding / host restrictions **[src]**
- In `WebServer.Config.host` (`webserver/src/index.ts:358-365`), the value must be an **IP literal** (`parseIpLiteral`; a hostname such as `localhost` is not accepted). The unspecified or wildcard address is **rejected at load**: `0.0.0.0`, `::`, and mapped forms. The error says binding every interface "would expose remote code execution to the network". So `--host 0.0.0.0` is unsupported, and this is enforced in the webserver config schema. The README says the same: `packages/client/connection/README.md`, "`dsh web --host 0.0.0.0` is unsupported".
- Defaults: loopback, port 3080. `--host` takes one concrete local address, for example a Pod IP from `hostname -i`. A non-loopback plain-HTTP bind prints a warning: `bundle/web-app/src/index.ts`, "listening on … over plain HTTP; restrict this port to a trusted proxy".
- CLI flags (`bundle/web-app/src/startup.ts`): `--host`, `--port`, `--tls-cert`, `--tls-key` (both or neither), `--public-url`, `--trusted-host <authority...>`, `--no-open`.
- **TLS** (`Config.tls {certFile, keyFile}`): read once before listen. A bad pair fails startup. There is no ACME client, no reload, and no redirect listener. **[src+docs]**
- **`publicUrl`** (`web-app` config) is *advertisement only*: the printed URL, `DSH_WEB_URL`, and the agent runtime context. It grants no trust, sets no routing, and sets no cookie scope. **[src]**
- **`trustedHosts`** (Connection config, `client/connection/src/index.ts`): `trustedHosts?: string[]` accepts bare `host` or `host:port`, canonical form, and is validated at load by `assertTrustedAuthority`. **[src]**

### 1.4 Host/Origin fence (`client/connection/src/api-request-trust.ts`) **[src]**
- `Host` must be one of: loopback; the listener's bind IP literal (any port); or a `trustedHosts` entry (exact `host:port`, or a port-less entry matching any port). Port normalization uses the **listener's** scheme.
- If an `Origin` header is present, it must name the same authority. Host is parsed under the Origin's scheme, which is what makes "an HTTPS proxy over an HTTP upstream" work. `sec-fetch-site: cross-site` is refused.
- A fence failure gives 403. A trusted but unauthenticated request gives 401.

### 1.5 Behind Caddy (our deployment) — what must be true **[docs: `docs/user/guide/public-deployments.md` + src]**
1. Caddy must preserve the browser `Host`; `reverse_proxy` does this by default **[infer]**. We pass `--trusted-host heyagent.example`.
2. Bind loopback if Caddy shares the Pod network namespace (Podman pod). Otherwise use `--host <pod-ip>`. A wildcard is never allowed.
3. Forward WebSocket upgrades (`/api/remote.mux`).
4. Cookie: `Secure` is set only when the dsh *listener itself* serves TLS (`rpc-host.ts:132`, `protocol === 'https:'`). Forwarded headers are never consulted. With TLS ending at Caddy and plain HTTP upstream, the cookie lacks `Secure`. Caddy must add it (`header_down`), or we use listener TLS.
5. With a path mount, Caddy strips the prefix and rewrites cookie `Path`. Only the bare mount `/x/` performs the token exchange.
6. **Restrict the port.** The fence does not protect the socket; anything that can reach it with a trusted Host header can try the cookie.
7. **Blocker-ish:** the launch token changes on every restart. Existing cookies survive, because the secret persists in `$DSH_HOME/.credentials.yaml` under the record `client-connection/browser-session`. A new browser needs the freshly printed URL from the logs. That is unusable for company users, so multi-user auth (§3) is mandatory.

---

## 2. RPC: Typert, API Gateway, Connection

### 2.1 Programming model (Host) **[src+docs `docs/api-gateway.md`]**

```ts
import { TypertRemoteService, Remote, RemoteScope } from '@deepseek-ai/dsh-typert-protocol'
export class GoalService extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'goals') }               // service key + default namespace
  @Remote('create') createForClient(agent: Agent, request: CreateGoalRequest, signal: AbortSignal): CreateGoalResult
  @RemoteScope('agent', 'current') currentForClient(): CreateGoalResult
  @Remote({ mode: 'stream' }) follow(signal: AbortSignal): AsyncIterable<Frame>   // or RemoteStream<Out, In> with uplink
}
```

- Options: `@Remote(name | { name?, mode?: 'stream', resources? })`. The `resources` readers return the resource ids for access control. The `signal: AbortSignal` final parameter is reserved.
- Complex parameters, such as `agent: Agent`, become wire ids (`agentId`) through `TypertLookupMap` plus `ctx.typert.lookups`. The Session Controller resolves `agent` and `session`, including cold resume.
- Inside a call, `this.ctx.invocation` returns a `RemoteInvocation`: `{ request, service, peer: PeerScope, signal, uplinkWindow?, uplink<In>() }`. `principalOf(invocation)` (`typert/protocol/src/principal.ts:14`) returns `undefined` for the owner. **[src]**
- Strict restrictions: the method must be public, non-static, non-generic, and use simple required named parameters. Types must be JSON-representable, or carry a unique lookup declaration.

### 2.2 Codegen **[docs+src]**
- `scripts/generate-typert.ts` uses `packages/typert/generator` (`WorkspaceTypertGenerator`). Its **only `ts.Program` seed is the Host aggregate**. It writes per-package `lib/typert.host.{js,d.ts}`, `lib/typert.remote-client.{js,d.ts,d.ts.map}`. Packages export `./typert` (Host Loader) and `./remote` (the client contribution).
- `pnpm run build:lib` is required after any signature change. In dev (`pnpm run dev:web`) the Host runs from source with the **SRC fallback**: weaker descriptors, Host-side only. **The Client refuses to mount SRC descriptors**, so the client always needs a generated `/remote`. **[docs]**
- The generator also exposes `writePackageArtifacts()` (package mode) besides workspace mode (`typert/generator/README.md`). Out-of-tree packages are therefore conceivable; **[docs]**, not exercised by me.
- **Client assembly**: `packages/api/remotes/src/client/index.ts` explicitly imports about 30 `*/remote` contributions and calls `ctx.remote.$mount(contribution)` on each. A feature plugin can instead mount its own: `experimental/liveshare/src/client/index.ts` imports `@deepseek-ai/dsh-experimental-liveshare/remote` and mounts it. **[src]**
- Client calls are `ctx.remote.<ns>.<method>(...args, signal?)` and the scoped form `agentCtx.remote.<ns>.<method>(...)`. These are concrete functions, not a Proxy, and each namespace is a Cordis child service `remote.<ns>`. **[docs]**

### 2.3 Wire protocol (callable by any same-origin client) **[src]**
**Unary** (`client/connection/src/rpc-schema.ts`, `rpc-host.ts:304-349`, `client/rpc.ts`):

```http
POST /api/<namespace>/<method>     Content-Type: application/json   Cookie: dsh-auth-<sha256(authority)>=...
{"type":"client-request","rpcId":"<uuid>","method":"<namespace>/<method>","payload":{"args":{ ...named wire args... }}}
→ {"type":"server-response","rpcId":"<uuid>","result":{"ok":true,"value":...}}
   | {"type":"server-response","rpcId":"...","result":{"ok":false,"error":{"code":"remote-access/denied","message":"...","details":{...}}}}
```

- Status codes: 415 if not JSON, 400 for a bad body, 404 for an unclaimed endpoint, 500 for a handler crash.
- The body cap is `maxRequestBodyBytes`, default 300 MiB, fully buffered.
- **Binary**: only *unary results* may contain `Uint8Array`. They come back as a **multipart** response (a JSON `metadata` part, with `null` placeholders and an attachment table, plus byte parts). Binary *parameters*, events, and streamed binary are unsupported. Uploads use the exact streaming route from `client/file-upload`. **[src README+docs]**

**Streams** (`api/gateway/src/stream-protocol.ts`): one WebSocket at `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`, carrying JSON text frames.

```ts
// client → host
{ type:'open', streamId, endpoint:'<ns>/<method>', payload:{args} } | { type:'item', streamId, value } | { type:'end', streamId } | { type:'cancel', streamId }
// host → client
{ type:'item', streamId, value } | { type:'error', streamId, error:{code,message,details} } | { type:'end', streamId }
```

- The internal stream `$events` (payload `{args:{}}`) opens with `{type:'ready', clientId, host:{home}}`. It then carries `{type:'emit', event, args}`, `{type:'waterfall', event, eventId, agentId, request}` and `{type:'cancel', eventId}`. Waterfall results go back via the unary `$events/result`.
- Reconnect has jittered backoff of 0.5s up to 10s, a 3s warning and a 15s handshake timeout. Each stream reopens from a fresh baseline. **[docs]**

### 2.4 Main Remote namespaces relevant to us **[src: `api/session-controller/src/index.ts`, namespace `session`]**
- Unary: `list, search, create, selectModel, initializeDefaultModel, modelCatalog, canOpenWorkspacePath, openWorkspacePath, workspacePathApplications, rename, fork, prompt, attachment, updateQueue, cancel, page, events, state, projections`.
- Streams: `observeEvent, observeProjections, observeState, follow` (opening snapshot plus gap-free durable events), `control` (live baseline plus projection frames, filtered by `remoteAccess.allows`).
- Others: `workspace/*` (create, rename, delete, archive/pin…, a follow stream), `job/*`, `terminal/*`, `workspaceFiles/*`, `settings/*`, `remoteAccess/follow`, `schedule/*` and more. These are all listed in the `api/remotes/src/client/index.ts` mount list.

### 2.5 Can a separate SPA (our React app) call these? **[src + infer]**
- **Yes, from the same origin.** The browser sends the cookie automatically, and the Origin check passes for same origin. `cross-site` is refused, so the SPA cannot live on another origin without a proxy.
- There are two options:
  - **(a)** A thin hand-written client: fetch with the JSON envelope, plus a small WebSocket mux client. Typing comes from importing the generated `typert.remote-client.d.ts` merges type-only, if the SPA builds inside the monorepo workspace **[infer]**.
  - **(b)** Embed the dsh Client stack (`@deepseek-ai/dsh-client-connection/client` → `installConnection(ctx, options)`, `@deepseek-ai/dsh-api-gateway/client`, `api-remotes`) inside a Cordis tree in our SPA. The README says the Client entry supports "a non-page Cordis tree" and custom carriers (`ClientTransportHooks.createWebSocket`, `streamBaseUrl`). It is heavier: Cordis, React 18-free model objects.
- **Stability: there is no public or versioned API.** `docs/defensive-patterns/remote-and-api.md` gives the internal rule "existing names are additive" (renames need owner sign-off). There is no semver, OpenAPI, or deprecation policy. As a fork we own the stability.
- The only "public" protocol is the **SDK** (`packages/sdk/{protocol,client,server}`): newline-delimited JSON-RPC **over stdio**, which spawns a `dsh` runtime with a profile. It suits backend-to-runtime use (open sessions, prompts, events), not browser use. **[docs]**

---

## 3. Auth & identity

### 3.1 Current model **[src]**
- `BrowserAuth` (`client/connection/src/browser-auth.ts`):
  - A per-process launch token (32 random bytes) is held in a WeakMap keyed by the root context.
  - The signing secret is the credential record `client-connection/browser-session` in `ctx.credentials`.
  - `authorizeIndex(req,res,secure)` works on `GET /?token=` only. It mints cookie v1 `{version:1, authority, issuedAt, expiresAt}` with HMAC-SHA256, sets `HttpOnly; SameSite=Strict; Path=/`, adds `Secure` only on a TLS listener, then redirects 303 to `./`.
  - The cookie name is `dsh-auth-` plus base64url(sha256(authority)). Lifetime is `cookieMaxAgeDays`, default 30.
  - **The cookie carries no user identity.**
- `/connect?token=&interactions=answer|none` serves API (CLI/MCP) callers. It mints cookie v2 carrying a PeerId; there is one owner-principal Peer per API socket, and a duplicate socket gets 409.
- `HostConnectionService.admit()` (`rpc-host.ts:129-138`):
  ```ts
  admit(request): PeerAdmission {
    if (!this.isTrusted(request)) return { rejection: 403 }
    if (this.disposed) return { rejection: 401 }
    const secure = this.owner.get('webServer')?.protocol === 'https:'
    if (this.browserAuth.isAuthenticated(request, secure)) return { peer: this.browserPeer }   // ONE shared owner Peer
    const id = this.browserAuth.authenticateApi(request, secure)
    ...
  }
  ```
  `browserPeer = new Peer(ctx, { principal: { kind: 'owner' } })` (`rpc-host.ts:94`). The doc note says "Multiple browser Peers (such as one per tab): every browser connection shares `browserPeer`" (`.agents/notes/implemented/architecture/2026-10-12-peer-principal-and-remote-access.md` §Out of scope).
- **No logout.** Clearing the cookie ends one browser; deleting the credential record and restarting revokes everyone (connection README §Known Limitations).
- `packages/api/account-controller` is the **DeepSeek platform (LLM provider) login**, not user accounts. `packages/identity/anonymous-user-id` is a per-`$DSH_HOME` telemetry UUID. **[docs]**

### 3.2 Peer / principal types (`typert/protocol/src/types.ts:443-485`) **[src]**

```ts
export interface PrincipalMap { owner: { readonly kind: 'owner' } }   // merge-extensible
export type Principal = PrincipalMap[keyof PrincipalMap]
export interface PeerScope {
  readonly id: PeerId; readonly ctx: Context; readonly principal: Principal
  readonly signal: AbortSignal; readonly interactions: 'answer' | 'none'; dispose(): Promise<void>
}
// Connection host handle (client/connection/src/rpc.ts):
createPeer(options: { principal: Principal; interactions?: 'answer' | 'none' }): PeerScope
admit(request): PeerAdmission; admitConnection(request): ConnectionAdmission
requestRejection(request); authorizeIndex(req, res): boolean; authenticatedUrl(baseUrl): string
createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler   // .fetch(request, peer)
```

Extension example: `experimental/liveshare/src/host/viewer-principal.ts`:

```ts
declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { 'share-viewer': ShareViewerPrincipal } }
```

The doc comment says each entry must be JSON, carry no credential, and be safe to persist in the Session log. User messages record `source.principal` (Agent Note §Recording the message source). **[docs]**

### 3.3 remote-access (`packages/api/remote-access`) **[src types + docs README]**

```ts
interface RemoteAccessRole<K> { name: string; resource: K; actions: readonly RemoteAccessAction[] }   // action = 'ns/method' | 'event:<name>'
type RemoteAccessBinding = { role; resource: { kind, id }; condition?: (req) => RemoteAccessDecision }
interface RemoteAccessPolicy<P> { bindings(principal: P): readonly RemoteAccessBinding[]; explain?(req): string | undefined }
class RemoteAccessService {                                   // ctx.remoteAccess; the Gateway injects it (mandatory)
  registerPolicy<K extends Exclude<keyof PrincipalMap,'owner'>>(kind: K, policy): () => void   // one per kind
  invalidate(principal?): void
  decide(req: { principal, action, resources, args? }): { kind:'allow' } | { kind:'deny', reason }
  allows(resource): boolean                                   // used inside list/stream methods to filter
  snapshotFor(principal); @Remote stream follow(signal)       // per-Peer access snapshot (client hides UI)
}
```

- Resource kinds come from `TypertResourceMap`. Today they are `session` (`core/session/src/types.ts:560`), `workspace` (`workspace/workspace/src/types.ts:19`), and the built-in `global`.
- A call that names no resource is decided on `global`.
- The Gateway checks non-owners **before** lookup resolution (`api/gateway/src/index.ts:803-825`). The owner is never checked. **[src]**
- On the client:
  - `useRemoteAccess(action)` and `ctx.remoteAccess.whenAccess(...)`;
  - `useSessionAccess` and `useWorkspaceAccess`;
  - the baseline is injected as `__DSH_REMOTE_ACCESS__` for the Peer that the index render speaks for.

### 3.4 How liveshare uses non-owner principals (the template for custom auth) **[src]**
1. A viewer request arrives through the Relay tunnel; the Relay asserts the identity.
2. `viewer-lifecycle.ts:288-296` creates one Peer per share and reader: `connection.createPeer({ principal: shareViewerPrincipal(shareId, actor) })`.
3. Unary calls dispatch through `connection.createSharedFetchHandler('/api').fetch(request, peer)` (`viewer-read.ts`, `ViewerReadConnection`).
4. Streams dispatch through `ctx.typertGateway.wireStream.open(endpoint, payload, uplink, peer, signal)` (`api/gateway/src/types.ts:92-110`).
5. The policy comes from `share-host.ts:290`: `scope.remoteAccess.registerPolicy('share-viewer', createViewerAccessPolicy(accessFacts))`.
6. Viewer pages are rendered with `webServer.renderIndex(html, viewerPeer)`, the in-process read.
7. Session/workspace controllers filter lists and streams with `remoteAccess.allows()`.

### 3.5 Owner-only cut-outs (blockers for "regular user = non-owner") **[src]**

| Cut-out | Where | Effect for a non-owner user |
|---|---|---|
| Exact Fetch routes return 403 | `client/connection/src/rpc-host.ts:219-221` | No `/api/file` (images in chat: `api/session-controller/src/media-references.ts:78`), no file upload (`client/file-upload`), no session-log export, no present-open, no plugin-manager or plugin-market downloads. The agent note calls this "temporary": each route should declare its own rule. |
| Forwarded waterfalls (interactive approvals, questions, other scoped Client events) | `api/gateway/src/index.ts:500-503, 583-584` (`answers: peer.principal.kind === 'owner'`) | A non-owner `$events` stream receives only allowed broadcasts and can never answer. Waterfalls go to **all owner streams**, and the first result settles (`deliverRemoteEvent`/`receiveRemoteEventResult`, `index.ts:702-727`). |
| HTTP index render | `frontend-static` → `authorizeIndex`; the index renders for `browserPeer` | A non-owner page needs an in-process render with its Peer (`renderIndex(html, peer)`), as liveshare does. |
| `session/attachment` | remote-access README | Granting it on one session exposes the whole attachment (image) store. |
| `$events` ready frame | remote-access README | Exposes the owner `home` path. |
| Settings, models, plugins, MCP, credentials | all global, owner-scoped config documents (`ui-settings`, `settings-controller`) | No per-user config. |

Mitigation for approvals **[src+docs]**: approvals are a host waterfall, `approval/request`, with composable answerers (`interaction/user-approval/src/index.ts:242-261`, `docs/subsystems/approval.md`). A HeyAgent host plugin can answer approvals per user through our own Remote methods instead of relying on the owner-only browser waterfall.

### 3.6 What real multi-user accounts would take (our model: better-auth email+password, admin/user roles, per-user data)
**There is no authenticator hook. `admit()` cannot be swapped by configuration.** The `connection/request` waterfall runs *after* admission with a fixed Peer, so it can refuse a request but cannot re-identify it (`client/connection/src/index.ts:143-158`). **[src]**

Option A, fork Connection (cleanest for the shipped dsh UI) **[infer from src]**:
1. Replace `BrowserAuth`:
   - add login and logout exact routes on `webServer` (`/auth/login`, `/auth/logout`, `/auth/session`) or keep better-auth as a separate service;
   - mint cookie v3 `{userId, sessionId, authority, iat, exp}`, or check a server-side session table in Postgres.
   - `isAuthenticated` is **synchronous** today (secret held in memory). A database-backed session check needs an in-memory cache, or `admit()` must become async; the `/api` route handler already awaits, so only the signature changes.
2. `admit()`: map userId to a cached `Peer` per user (`createPeer({ principal: { kind: 'heyagent-user', userId, role } })`), or `owner` for admin if admins should keep the full dsh surface.
3. `PrincipalMap` merge: `'heyagent-user': { kind: 'heyagent-user'; userId: string; role: 'admin' | 'user' }`.
4. `registerPolicy('heyagent-user', { bindings: p => [...global role (create session, model catalog...), ...session/workspace bindings from our ownership table] })`. Call `invalidate(p)` on change.
5. Ownership records are needed: dsh stores **no creator on sessions or workspaces** (no userId field in core types; I grepped, and only the `source.principal` on user messages exists). Wrap `session/create` and `workspace/create` in our own `@Remote` that records the owner, or listen to session creation inside the invocation.
6. Fix the cut-outs from §3.5:
   - pass the Peer into exact routes and give each a per-route rule (fork `rpc-host.ts` and the route owners);
   - answer approvals per user via the `approval/request` answerer;
   - render the index per Peer in `frontend-static`.
7. `frontend-static`: `authorizeIndex` must redirect to the login page instead of returning 401.

Option B, no Connection fork (liveshare pattern) **[src-backed pattern]**:
- Our own prefix route, for example `/u/api`, does our own auth. It forwards unary calls with `connection.createSharedFetchHandler('/api').fetch(req, userPeer)`.
- Our own upgrade route bridges streams with `typertGateway.wireStream.open(...)`.
- This works for **our own SPA**. The shipped dsh shell would still talk to `/api` with the owner cookie.

---

## 4. Client UI system

### 4.1 Stack facts **[src]**
- **React 18.3.1** (lockfile `react@18.3.1`; packages declare `react: ^18.2.0`; `apps/web` devDeps `react ^18.2.0`, `vite ^6.4.3`, `@vitejs/plugin-react ^4.7.0`). This is **not React 19**.
- **Cordis runs in the browser.** Each client package is a Cordis plugin, with the browser half at `exports['./client']` → `lib/client.js` and a manifest `"dsh": { "client": { "inject": [...package names], "immediately"? } }` (example: `client/ui-schedule/package.json`). Build: `tsdown.config.ts` → `clientBundle(import.meta.dirname, ['lib/types/index.js'])` (`packages/client/tsdown.client.ts`).
- **Module table:** `client/web/src/platform.ts` `PLATFORM_MODULES` lists the shared modules: `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `dsh-client-store`, `dsh-client-ui-slots`, `dsh-client-ui-primitives`, `dsh-client-ui-dockkit`. Other third-party npm deps are **bundled privately** into each plugin's `client.js` [docs comment in `tsdown.client.ts`]. So `@base-ui/react`, `lucide-react` and `cva` would be inlined per plugin.
- **Styling:**
  - CSS Modules (`x.module.css`) are processed by **lightningcss** inside the bundle and injected as `<style data-plugin-css=...>` at factory execution; `x.css?inline` is also supported (`tsdown.client.ts:1-20, 55-75`).
  - There is **no PostCSS or Tailwind pipeline.**
  - Tokens are `--dsw-*` and `--dsh-*`, in `client/ui-theme/src/styles/*.css`.
  - Dark mode uses `body[data-ds-dark-theme]` plus `html { color-scheme }`, set by `ui-layout/src/client/theme-presenter.ts`. It is not a `.dark` class.
- **State:** `client/store` (`defineStore`, `createSnapshotStore`) and React-free model objects. `ui-renderer` is the only package that binds observables via `useSyncExternalStore`.
- **Rules** (`docs/web-styling.md`, `packages/client/AGENTS.md` §118):
  - "Use CSS Modules and `clsx`; **do not add a component library or Tailwind**"; feature CSS uses `--dsw-alias-*` only.
  - Rounded superellipse radii (`docs/ui-radius.md`, 4–28px scale).
  - Elevation shadows replace borders, and borders are 0.5px hairlines.
  - Enforcement: `scripts/verify-client-ui-i18n.ts` rejects JSX copy outside locale dictionaries (a typed `t` seat). I found no script that bans Tailwind; the ban is docs only. Theme specs reject wrong elevation and menu-material patterns. [src grep]
- **Primitives** (`client/ui-primitives`, a shared module-table row): Button, Switch, SegmentedControl, Checkbox, Input, InlineEditor, Menu/MenuItemButton, MenuGroup, Pill, SegmentedTabs, Tag, PathLabel, StateDot, ConnectionIndicator, DisclosureRow, AnimatedRows, TextShimmer, Modal, RiskConfirmation, Tooltip, HoverCard, DraggableImage, ZoomControls, CodeCard, DiffBlock, JsonTree, ImageLightbox and more. This is their own design system. There is no table, data grid, form library, select or combobox at shadcn breadth. **[src listing]**

### 4.2 Boot & mount **[src+docs]**
- The Host writes `window.__DSH_BOOT__` (`WebBootGraph {rev, release?, entries: WebBootEntry[], batches}`) and preloads combo scripts from `/plugins/??a/client.js,b/client.js&rev=`.
- The boot kernel (`client/web/src/boot.ts`, `boot-client.ts`) creates the Cordis Loader and materializes the entries. Required entries (`boot-client.ts:25-33`) are: `client-modules`, `api-session-controller`, `ui-renderer`, `ui-layout`, `ui-session`, `ui-chat`, `ui-sidebar`. If any is inactive, startup is rejected.
- `ui-renderer` uses `createRoot`/`hydrateRoot` (`ui-renderer/src/client/index.ts:8,75,80`) and renders `ctx.slots.renderSlot('root')`.
- **The browser roster is defined by Host Loader rows** in profile patches (`bundle/web-app/cordis.patch.yml`). A package with `dsh.client` becomes part of the page when its row is loaded. Disabling rows removes UI. HMR re-reads the profile.

### 4.3 Slots **[src+docs `docs/subsystems/slots.md`]**
- `ctx.slots.register({ name, id?|key?, order?, priority?, children?, store?, inject?, locale?, label? }, Component)`.
- To contribute into another package's slot: `ctx.slots.inject(key, () => ctx.slots.register(...))`.
- Reusable assemblies: `ctx.slots.registerFactory()`, used with `renderFactorySlot(name, props, { slots })`.
- Cardinality is `single | list | keyed | chain`. Scope is `root | session-maybe | session`.
- Components receive only derived props: `PropsRuntime<K>`, `PropsRenderSlots<S>` (including `SessionProvider`), `PropsRenderFactories`, `PropsStore<H>`, the inject face (data, callbacks, and a `hooks` compartment of bare observables → `use<Name>`), and `t`. **Components never get `ctx`** (an AGENTS.md rule, structurally enforced by props).
- Standard hooks: `useSessions`, `useWorkspaces`, `useRemoteAccess`, `usePanelInfo`, `useSession`, `useProjection`, `useConversation`, `useChat`, `useTrajectory`, and others.
- Shell hierarchy (`ui-layout/src/client/index.ts:60-120`, `AppFrame.tsx`): `root [AppFrame]`, made of:
  - `sidebar` (single, occupied by `ui-sidebar`; it declares `sidebar.panellist` for icon entries, workspace seats, and `sidebar.settings`);
  - `main` (**keyed, root scope**; key `conversation` is reserved; any other key is a full-width "global panel");
  - `rightbar`, `shell.bottom`, `shell.overlay` (list) and `shell.leading`.
- **Page navigation:** `ctx.layout.selectPanel(id | null)`. **There is no URL router.** `pushState`, `popstate` and hash routing appear nowhere in `packages/client` (grep), and reload resets the panel. **[src]**
- Full-page pattern, verified in `client/ui-schedule/src/client/index.ts:219-246` (the same pattern is in `ui-plugin-manager`):
  ```ts
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale, store, inject: () => ({ ...callbacks over ctx.remote }) }, TaskManagerPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel') }, TaskManagerIcon))
  ```
- Settings pages use the `settings.section` slot, plus `settings.section.icon` and `settings.plugins.tab` (`ui-settings/README.md` §Filling the settings slots). Settings are one host-global document, mirrored via `settings.describe`.

### 4.4 Can we host our shadcn pages inside the dsh shell?
Mechanically yes. One client plugin per feature (or one big one) registers `main` panels plus `sidebar.panellist` icons. Each page component is an arbitrary React subtree; callbacks come from `inject` and close over `ctx.remote.<ns>`. **[src-backed]**

Risks and blockers **[infer unless noted]**:
1. **React 18 vs shadcn/Base UI.** Our preset `buKEvLs` (base-lyra, Vite template) targets React 19. Current shadcn components are plain function components that pass `ref` through props, which only works in React 19. On React 18, refs to these components are dropped, and Base UI's `render`-prop composition (for example `<DialogTrigger render={<Button/>}>`) and anchor positioning depend on refs. We would need forwardRef rewrites of `components/ui/*`, which breaks our "never hand-edit ui/*" rule. Upgrading the dsh shell to React 19 is a fork-wide change across about 70 client packages. The shell's own React version is **[src]**; the rest is inference.
2. **Tailwind v4 build.** The dsh bundle pipeline has no Tailwind. We would need a pre-step (`@tailwindcss/cli` scanning the plugin sources) that emits a CSS file the plugin imports; that becomes a global `<style>`. Preflight would reset margins and borders, and set `button` backgrounds and heading sizes, for the **whole page**. Tailwind v4 places preflight in `@layer base`, and unlayered dsh CSS Modules beat it, but dsh markup that relies on UA defaults would shift. Options: omit preflight, or scope it under a container with `@scope` or prefixing. Separately, dsh global CSS leaks into our pages:
   - `*{corner-shape: superellipse}` (`ui-theme/src/styles/corner-shape.css`), which is harmless for the square lyra look;
   - the global `:focus-visible` outline color and width (`focus.css`), which conflicts with shadcn ring classes;
   - scrollbar styles;
   - the `body` font, color and background.
3. **Token and theme mismatch.** shadcn tokens (`--background`, `--primary`…) do not collide by name with `--dsw-*`, but there are **two visual systems on one screen**: red, square lyra next to rounded, hairline, elevation-style dsh. Dark mode would need `@custom-variant dark (&:where([data-ds-dark-theme] *))` and token mapping.
4. **Lint and policy.** `verify-client-ui-i18n` rejects literal JSX copy in client packages. We would either adopt their `t` dictionaries or exclude our packages from the check. The no-Tailwind and no-component-library rules are docs only; we can drop them in the fork.
5. **No deep links or URL routing.** About 20 admin pages would need our own hash or state router inside one `main` panel. Browser back and forward, and shareable URLs, do not exist in the dsh shell.
6. Admin pages need our multi-user data (Postgres-backed). They would call our own host plugins' `@Remote` namespaces. That requires Typert codegen and adding our `/remote` contributions to `api-remotes`, or self-mounting them in our plugin as liveshare does.

**Replacing the whole client shell** **[src]**: `root` is rendered only through `ui-renderer`, and `ui-layout` occupies it. `ui-layout`, `ui-sidebar` and `ui-chat` are in the hard-coded required list (`client/web/src/boot-client.ts:25-33`). A replacement shell is a fork edit of `client/web` (the required list) plus a new `root` occupant, or removing the `ui-layout` row. The chat and trajectory packages assume `ui-layout`/`ui-sidebar` seats (`main` key `conversation`, `rightbar`, `sidebar.panellist`). That is high effort.

### 4.5 Recommended cleanest way to host about 20 shadcn admin pages **[infer]**
- **A separate HeyAgent SPA** (React 19 + Tailwind v4 + shadcn base-lyra, unchanged), served on the **same origin**. Caddy routes `/` (or `/app/*`) to our static build with a history fallback, and routes `/api/*` and `/api/remote.mux` to dsh. Alternatively a dsh host plugin registers a prefix route that serves our dist; mind that dsh's fallback seat is already claimed by frontend-static, so we would need our own `prefix` route.
- The SPA talks to dsh with the §2.3 wire protocol (a thin typed client). It talks to our own HeyAgent host plugins (users, tasks, browsers, desktops, dispatch…) as `@Remote` namespaces in the same dsh process.
- Auth: our login (better-auth or equivalent) issues the identity, and the forked Connection maps it to per-user Peers (§3.6 Option A). Or, without the fork, the SPA uses an `/u/api` carrier (Option B), where dsh `/api` stays owner-only and admin-only.
- For the chat UI, either:
  - **(i)** link or iframe the dsh shell for a session; this needs a small deep-link client plugin, because there is no `?session=` support today; or
  - **(ii)** build our own run-detail view from `session/follow` + `session/page` + `session/projections` (§5).

---

## 5. Session view (chat / trajectory)

### 5.1 How it renders **[docs `docs/subsystems/conversation.md`, `web-client.md`; src for slot names]**
- The data path is: Host Session log → Remote `session/follow` (opening snapshot: header, tail page, cursor and full projection baseline, then gap-free durable events and cursorless assistant-stream frames) and `session/page` (older history) → Client `SessionManager`/`Session` window of `SessionEventLikeEntry` (`{type:'event', event}` | `{type:'transient', event: AssistantLiveChunkEvent}`) → `ui-conversation` `ConversationNodeAssembler` → per-target snapshots (`chat`, `trajectory`) → Slot views.
- Business packages extend it with `ConversationNodeDefinition` (`@deepseek-ai/dsh-client-ui-conversation/client`). It matches events by `(kind,id)`, folds State, and materializes a target node. A typed renderer goes to the keyed `conversation.chat.node` (`ChatNodeViewProps`). Tool rows go to `tool.call.toolview` (keyed by tool name). Groups go through `ctx.uiConversation.groups.register`.
- New durable event types are declared by merging into `SessionEventMap` (`@deepseek-ai/dsh-session/types`) on the host side.
- Hierarchy: `main[key=conversation]` → `main.conversation` → Factory **`conversation.content`** (`scope: 'session-maybe'`). Its children are `conversation.session` → `conversation.view` (`id=chat` ChatView | `id=trajectory` TrajectoryTable), composer, input dock, hero and more (`ui-conversation/src/client/contract/slots.ts:356-380`).

### 5.2 Can our "run detail" page reuse it?
- **Inside the dsh shell: yes, verified pattern** **[src]**. `client/ui-subagent/src/client/sidebar-chat/index.tsx:126-160` declares a `session`-scoped child slot, wraps it in `<SessionProvider session={reference}>`, and calls:
  ```tsx
  renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, { slots: { views: FixedChatConversationView } })
  // FixedChatConversationView = props => props.renderSlot('conversation.session', { view: 'chat' })   // or 'trajectory'
  ```
  A HeyAgent `main` panel ("run detail") can therefore embed the full chat or trajectory of any session, composer included. Our extra panels (outcome, review, browser view…) sit next to it in shadcn, subject to the §4.4 React 18 and CSS caveats.
- **From a separate SPA: no component reuse.** The UI is Cordis-plus-Slots bound and React 18, and it cannot be imported into a React 19 app. We would either:
  - **(a)** read via RPC and render ourselves: `session/follow` (stream), `session/page`, `session/state`/`observeState`, `session/projections`/`observeProjections`, `session/control`. This re-implements Conversation assembly (live chunks plus compact streams in settlements). Projections are "finished values" folded host-side (`docs/subsystems/session-projection.md`), which helps for summary data such as stats and turn outline.
  - **(b)** embed the dsh shell in an iframe pointed at a session. That needs a small client plugin for selection by URL parameter (none exists), plus the same-origin cookie.

---

## 6. Blockers & risks (for our target: multi-user server behind Caddy + shadcn-only UI)

| # | Item | Severity | Evidence |
|---|---|---|---|
| B1 | Single owner identity; no login, users or logout; a launch token that changes per process | **Blocker**: must fork `client/connection` or add an Option-B carrier | `rpc-host.ts:94,129-138`; `browser-auth.ts` |
| B2 | No authenticator hook (`admit` is concrete; the `connection/request` waterfall cannot change the Peer) | **Blocker** without a fork | `client/connection/src/index.ts:143-158` |
| B3 | Non-owner cut-outs: exact routes return 403 (chat images `/api/file`, uploads, exports); approvals and questions are owner-only waterfalls broadcast to all owner tabs; index render is for `browserPeer` | **Blocker** for "regular users are non-owner"; needs gateway and connection forks plus a per-user approval answerer | `rpc-host.ts:219-221`; `gateway/src/index.ts:500-503,583-584,702-727` |
| B4 | No per-user data model: sessions and workspaces have no creator/user field; settings, models, plugins and credentials are host-global | High; needs our ownership table plus a `RemoteAccessPolicy` plus wrapped create calls | grep of core types; `remote-access` README |
| B5 | React 18.3 shell vs our React 19 + shadcn (ref-as-prop) | High if pages live inside the shell; none for a separate SPA | lockfile; `client/web/src/platform.ts` |
| B6 | No Tailwind or PostCSS pipeline; Tailwind is banned by docs; global dsh CSS (focus, corner-shape, body) clashes with preflight | Medium (in-shell only) | `tsdown.client.ts`; `docs/web-styling.md`; `ui-theme/src/styles/*` |
| B7 | No URL routing or deep links in the dsh shell | Medium | grep of `packages/client` |
| B8 | No public or versioned API; internal additive-names rule only; Typert codegen needs the monorepo Host aggregate build (`pnpm run build:lib`); the client refuses SRC descriptors | Medium (we own the fork) | `docs/api-gateway.md`; `defensive-patterns/remote-and-api.md:47-55` |
| B9 | Behind Caddy: bind must be an IP literal (no wildcard, no hostname); `--trusted-host` required; cookie lacks `Secure` unless listener TLS or Caddy rewrite; restrict the port | Low (configuration) | `webserver/src/index.ts:358-365`; `public-deployments.md` |
| B10 | 300 MiB buffered request bodies held in memory; unused API Peers live until shutdown | Low | connection README §Known Limitations |
| B11 | `session/attachment` grants the whole image store; the `$events` ready frame leaks the owner `home` | Low or medium for multi-user | remote-access README |
| B12 | Two visual systems (dsh rounded and hairline vs lyra square and red) if we keep the dsh chat shell next to shadcn pages; violates "all pages shadcn-only" unless the chat view is re-rendered by us | Policy decision | `docs/ui-radius.md`; our `docs/ui-rules.md` |

---

## 7. Key file index
- Web server: `packages/host/webserver/src/index.ts` (Config at 350-375, routes, `registerUpgrade` at 460, `createServer` at 566), `packages/host/webserver/src/injections.ts`.
- Static SPA: `packages/host/frontend-static/src/index.ts`.
- Web composition: `packages/bundle/web-app/src/{index.ts,startup.ts,public-url.ts}`, `packages/bundle/web-app/cordis.patch.yml`, `packages/bundle/web-app/README.md#public-deployments`.
- Deploy guide: `docs/user/guide/public-deployments.md`.
- Connection: `packages/client/connection/src/{index.ts,rpc-host.ts,rpc.ts,browser-auth.ts,api-request-trust.ts,peer.ts,http-bridge.ts,rpc-schema.ts}`, `client/{rpc.ts,socket.ts,connection.ts}`, `README.md`.
- Gateway: `packages/api/gateway/src/{index.ts,types.ts,stream-protocol.ts,stream-server.ts,access.ts}`, `src/client/*`.
- Remote assembly: `packages/api/remotes/src/client/index.ts`.
- Access control: `packages/api/remote-access/src/{index.ts,types.ts}`, `README.md`.
- Typert: `packages/typert/protocol/src/{types.ts,principal.ts}`, `packages/typert/generator`, `scripts/generate-typert.ts`, `docs/subsystems/typert.md`, `docs/api-gateway.md`.
- Design notes: `.agents/notes/implemented/architecture/{2026-10-12-peer-principal-and-remote-access.md, 2026-08-24-browser-token-authentication.md, 2026-07-28-api-browser-trust-boundary.md}`.
- LiveShare: `packages/experimental/liveshare/src/host/{viewer-principal.ts,viewer-lifecycle.ts,viewer-read.ts,share-host.ts,viewer-access-policy.ts}`, `docs/subsystems/liveshare.md`.
- Session API: `packages/api/session-controller/src/index.ts` (namespace `session`, lines 278-640).
- Client shell: `packages/client/web/src/{boot-client.ts,platform.ts,base.css}`, `apps/web/{package.json,src/main.ts,vite.config.ts}`.
- Layout and slots: `packages/client/ui-layout/src/client/{index.ts,AppFrame.tsx,theme-presenter.ts}`, `packages/client/ui-slots`, `packages/client/ui-renderer/src/client/index.ts`, `docs/subsystems/{slots.md,web-client.md,client-modules.md,conversation.md}`.
- Full-page example: `packages/client/ui-schedule/src/client/index.ts:219-246`.
- Embedded conversation example: `packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:120-160`, `packages/client/ui-conversation/src/client/contract/slots.ts:356-380`.
- Styling: `docs/web-styling.md`, `docs/ui-radius.md`, `packages/client/ui-theme/src/styles/*`, `packages/client/AGENTS.md`, `packages/client/tsdown.client.ts`, `scripts/verify-client-ui-i18n.ts`.
- Approvals: `packages/interaction/user-approval/src/index.ts`, `docs/subsystems/approval.md`.
- SDK (stdio JSON-RPC): `packages/sdk/{protocol,client,server}`.
