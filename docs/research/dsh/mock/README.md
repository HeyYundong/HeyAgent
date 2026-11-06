# HeyAgent mock inside the real DeepSeek Harness (dsh) web UI

The **published** dsh `@deepseek-ai/dsh@0.2.2-alpha.3`, the same version as the source clone at `8bd07339`, runs unmodified in a rootless Podman container. HeyAgent is added only through dsh's public plugin mechanisms:

- one **host plugin**, with mock tools, an approval gate and a scripted model server;
- one **client plugin**, with branding, four panels, a right-sidebar tab, a run-header badge and business tool rows;
- one **config overlay**, `home/cordis.patch.yml`.

Nothing in dsh is patched or rebuilt.

## Open it

- URL: `http://192.168.31.100:3480/?token=<token>`
- The current URL with its token is always in `url.txt`, next to this file. You can also get it with `podman logs dshmock-web | grep token=`.
- The token is one-shot per process. On `GET /` it sets a signed cookie and redirects to `/`. Each restart mints a new token. The cookie signing secret persists in `home/.credentials.yaml`, so an already-authenticated browser normally keeps working. If you get a 401, open the new token URL.
- dsh only accepts requests whose Host is the bind IP. Use `192.168.31.100`, not a hostname.
- The first visit shows dsh's own "预览版说明" notice. Click 继续.
- To see the scripted run, type a message that contains **比价** in the composer, for example `跑一次每日比价：不锈钢保温杯 500ml`. Any other message gets a one-paragraph "I'm a mock" reply. The run takes about 8 s.

## Start / stop

| What | Command |
|---|---|
| Container | `dshmock-web` (image `docker.io/library/node:24-bookworm-slim`, Node 24.22, `--network host`, `--userns=keep-id`) |
| Ports | dsh `192.168.31.100:3480`; scripted model server `127.0.0.1:3481`, inside the same process |
| (Re)create from scratch | `bash start.sh` (rewrites `url.txt`). `HEYAGENT_MOCK_DUMP=1 bash start.sh` also logs each model request's messages. |
| Restart (keeps container, picks up plugin/patch edits) | `bash restart.sh` |
| Stop | `podman stop dshmock-web` |
| Remove | `podman rm -f dshmock-web` |
| Logs | `podman logs -f dshmock-web` |
| Reset conversations | stop the container, delete `home/sessions/*/session-*` and `home/storages/session_projcache`, then start it again |

Layout: `/dshmock` in the container is this directory.

- `app/`: `npm i @deepseek-ai/dsh@0.2.2-alpha.3`. 654 packages, about 920 MB. The npm download took 19 minutes.
- `home/`: `DSH_HOME` and `HOME`. Sessions, settings and `cordis.patch.yml` live here.
- `plugins/`: plugin sources.
- `tools/`: esbuild, used to build the client bundle on the host.
- `shots/`: screenshots.
- `shot.mjs`: the Playwright screenshot driver. Run it as `podman run --rm --network host --userns=keep-id --entrypoint node -v $PWD:/work localhost/heyagent-worker:before-1028 /work/shot.mjs home:light panels:dark run:light open-run:light:2000 remote:light guide:light settings:light`.

Environment: `DSH_TELEMETRY_DISABLED=1` and `HEYAGENT_MOCK_KEY=mock`, a dummy key for the mock provider. No DeepSeek key, accounts or HeyAgent secrets are used. The HeyAgent pod on :8080 was not touched.

## What is mocked

### 1. Config overlay: `home/cordis.patch.yml`

`$DSH_HOME/cordis.patch.yml` is the home-level layer and applies to every profile. It does four things:

- `insert` adds the two plugin rows. Each row uses an absolute path to the entry **file**. A directory path fails with `ERR_UNSUPPORTED_DIR_IMPORT`.
- `llm-pi-ai.providers.heyagent-mock` adds a custom provider: `api: openai-completions`, `baseURL: http://127.0.0.1:3481/v1`, model `heyagent-planner`, and the compat switches `supportsDeveloperRole: false` and `maxTokensField: max_tokens`.
- `agent-default-model` makes new sessions start on the mock model.
- `workspace-controller.documentsDirectory` points at `/dshmock/home/Documents`. Without it, dsh shows "无法创建默认工作区": the container has no `xdg-user-dir`.

### 2. Host plugin: `plugins/heyagent-host/index.js`

This is plain ESM with no dsh imports, loaded straight from the patch row.

- **Mock HeyAgent tools** on `ctx.tools`, as raw `ToolDefinition`s (`name`, `description`, JSON-Schema `parameters`, `output: {schema, render}`, `execute`):
  - `browser_open`, `browser_snapshot`, `browser_click`, `checkpoint_mark`, `ask_human`, `sheet_write`, `run_finish`
  - Each returns a canned Chinese result after 600 ms.
  - Each takes a `description` argument. dsh's generic tool row shows it as the row summary.
- **Approval gate**: `ctx.on('tools/pre-execute')` returns `{kind:'deny', reason:'需要审批：…已在「要人办」建了一件事（A-1043…）'}` for `browser_click`. dsh renders this as a red error row, and the model then sees the denial and continues.
  - `{kind:'ask'}` would instead pop dsh's real 允许/拒绝 approval card. It is not used, so the scripted run never blocks.
- **Scripted model server**: an `http.createServer` on `127.0.0.1:3481`, started in `ctx.effect` so it closes on unload. It speaks OpenAI Chat Completions SSE: `reasoning_content` deltas become dsh 思考 rows, `content` deltas become text, and `tool_calls` deltas become tool calls.
  - It picks the step by counting assistant tool-call messages since the last human message that contains 比价.
  - The script runs: think → `browser_open` → `browser_snapshot` → `checkpoint_mark` 1/3 → `browser_click` (denied: approval pending) → `ask_human` (login handed to a person) → `checkpoint_mark` 2/3 → `sheet_write` → `run_finish` → a Markdown 运行报告 with a table, deliverable, items still waiting and a memory candidate.
  - Requests without tools, such as session title generation, get a short title.

### 3. Client plugin: `plugins/heyagent-ui`

This is a real dsh client plugin package:

- `package.json` has `dsh.client: {platform:'web', inject:[…]}` and `exports['./client'] = ./lib/client.js`.
- `index.js` is the empty host face.
- `src/*.jsx` is built by `node build.mjs`.

| Surface | dsh extension point | Content |
|---|---|---|
| Branding | `sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark` (single slots, `priority:-10`) | Goat logo (inlined data URL) and the name "HeyAgent" |
| 要人办 | `sidebar.panellist` (id `heyagent-inbox`) + `main[heyagent-inbox]` | Filter chips 待处理 / 已处理 / 通知; a list of approval, login, captcha, question and verify-pending items; a detail pane with fields, actions and a placeholder browser shot. "打开运行" calls `ctx.layout.selectPanel(null)`. "接手浏览器" opens the run's remote-view tab. |
| 任务 | `sidebar.panellist` + `main[heyagent-tasks]` | Task list. Detail tabs (dsh `SegmentedTabs`): 结构图 (goal, an agent-loop box with steps, checkpoints, tools and rules, plus deliverables and skills/memory), 运行, 什么时候跑, 任务记忆. "新运行" calls `ctx.uiWorkspace.startSession(…, {prompt})`. |
| 浏览器 | `sidebar.panellist` + `main[heyagent-browsers]` | Chrome profiles with state tags; detail with a placeholder screen, accounts and login state, proxy, and 看画面 |
| 桌面 | `sidebar.panellist` + `main[heyagent-desktops]` | 桌面 / 模板 groups, state tags, and a "这台虚拟机" card with power buttons |
| Right-sidebar tab 浏览器画面 | `ctx.sidebarRightTabs.register({id, kind:'heyagentRemoteView', guide:[…]})` + `sidebar.right.pane.tab[key]` | A 等人处理 banner with 已处理好了, a 只看 / 我来操作 switch, and a placeholder 1688 login page with an "agent 在做" cursor label. It also appears as a card on dsh's 开始 guide page. |
| Run header | `conversation.session.header.utilities` (id, order −20) | A 等人处理 · 待批准 tag, 检查点 2/3, and a 浏览器画面 button that calls `ctx.sidebarRight.openTab(kind)` |
| Business tool rows | `tool.call.toolview` keyed by wire tool name (`ask_human`, `checkpoint_mark`, `run_finish`) | `checkpoint_mark` is a green check row with a 达成 tag. `ask_human` is a 要人办 card (question, answer, L-88 meta, 等人处理 / 已处理 tag). `run_finish` is a 收尾 card. Other tools keep dsh's generic row. |

Styling uses only dsh's `ui-primitives` (`Button`, `Tag`, `SegmentedTabs`, `StateDot`, `Icon*`) and `--dsw-alias-*` tokens, in one plugin-owned `<style>` tag that is removed on unload. Light and dark themes both work with no extra code.

## Screenshots (`shots/`)

| File | Shows |
|---|---|
| `home-light.png`, `home-dark.png` | Home/hero with the goat brand, the 4 HeyAgent panel rows above dsh's own 插件 / 自动化任务, and the composer on HeyAgent 规划模型（模拟） |
| `panel-inbox-light.png`, `panel-inbox-dark.png` | 要人办 with the approval A-1043 detail |
| `panel-inbox-login-light.png` | 要人办 login item, with the placeholder remote screen |
| `panel-tasks-light.png`, `panel-tasks-dark.png` | 任务 → 每日比价 → 结构图 |
| `panel-tasks-runs-light.png` | 任务 → 运行 tab |
| `panel-browsers-light.png`, `panel-browsers-dark.png` | 浏览器 → 采购-1 |
| `panel-desktops-light.png`, `panel-desktops-dark.png` | 桌面 list and VM card |
| `run-0-typed-light.png` | Task typed into dsh's real composer |
| `run-1-progress-light.png` | Run mid-stream: 思考 rows, generic tool rows, the 检查点 row, the denied `browser_click` in red, and 深度求索中 |
| `run-2-done-light.png` | Finished run with the 运行报告 table |
| `run-open-light-tall.png` | **Best overview.** The whole run expanded, with every row type including the 要人办 and 收尾 cards. 1440×2000. |
| `run-open-light.png`, `run-open-dark.png` | The run reopened from the sidebar, process expanded |
| `run-remote-view-light.png`, `run-remote-view-dark.png` | The right-sidebar 浏览器画面 tab next to the run |
| `run-rightbar-guide-light.png` | dsh's 开始 guide page with the HeyAgent 浏览器画面 card next to 工作区文件 / 新建终端 |
| `settings-menu-light.png`, `settings-light.png`, `settings-models-light.png` | dsh's account menu, then the settings dialog → 模型, with "HeyAgent 模拟模型 [自定义]" (green) next to DeepSeek |

## What is NOT done, and why

- **Hero headline and "新会话 / 会话 / 工作区" wording are unchanged.** These are dsh locale strings owned by other packages. Renaming them to 运行 needs a locale override or a replacement package, not a slot. The hero mark is replaced.
- **The left session list is still dsh's 工作区 → 会话.** UX doc §1.3 wants it grouped by task, with run status at the row end. That needs either a replacement of `ui-workspace`'s browser or the `sidebar.session.row.*` decoration slots plus Host data. Not attempted.
- **dsh's own 插件 / 自动化任务 rows and the DeepSeek provider card still show.** Hiding them means disabling those rows in a patch (`disabled: true` on `ui-plugin-manager` / `ui-schedule`, and similar). This is easy but was left alone to keep the overlay minimal.
- **No HeyAgent settings section.** `settings.section` exists, but it was not built.
- **Panels are static.** There is no Host service or Remote API behind them: buttons do nothing except navigation and opening tabs. A real plugin would expose Typert Remote methods from a Host package and read them through `ctx.remote.<ns>`.
- **The header badge is static** and shows on every session, including non-HeyAgent ones.
- **The remote view is a drawn placeholder**, not a screencast.
- **Not tested from another LAN machine.** It was verified from this box against `192.168.31.100:3480` (HTTP 401 without a cookie, 303 with the token, and full UI in headless Chrome).
- **npm skipped five install scripts** because npm 11 needs `allowScripts`: `dsh-subprocess-local`'s spawn helper, `node-pty`, `koffi`, `protobufjs` and `@google/genai`. The web UI and this mock don't need them, but dsh's bash and terminal tools might not work. Fix: `npm install-scripts approve …` or `npm rebuild` in `app/`.

## Problems hit (and fixes)

1. **Directory plugin path** fails with `ERR_UNSUPPORTED_DIR_IMPORT`. Point the row at `index.js`. The client-modules scan still finds the package through the nearest `package.json`.
2. **The published web shell's `ui-primitives` is older than master.** `IconLayersOutlineRegular` exists in the clone but not in 0.2.2-alpha.3's `dsh-web-frontend` bundle. Rendering `undefined` crashed one `sidebar.panellist` entry with React error #130, isolated by dsh as "slot entry crashed". **Lesson:** check imports against the shipped `dsh-web-frontend/dist/assets/index-*.js`, not the repo.
3. **dsh injects extra `role:user` messages** after the human one ("Current runtime context…", "Time sampled while preparing turn…"). The mock model filters them when deciding where the run starts.
4. **No default workspace in the container** (no `xdg-user-dir`). Fixed by setting `workspace-controller.documentsDirectory`.
5. **Podman commands with `$PWD` or `sh -c` were refused by the session sandbox**, so absolute paths and the small `start.sh` / `restart.sh` scripts are used instead.
