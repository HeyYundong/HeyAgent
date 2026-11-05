# HeyAgent 前端（apps/web）清单与后端耦合盘点

范围：`/mnt/toshiba/Projects/HeyAgent/.claude/worktrees/dsh-fork-assessment`（只读）。下文路径均相对 `apps/web/` 除非写明 `packages/shared`、`apps/server`。
行数口径：`src/` 下 `.ts/.tsx/.css`，不含 `components/ui/`（生成的 shadcn，46 个文件 / 5397 行）。

---

## 0. 结论速览

- 前端是纯 SPA（Vite + React 19），**hash 路由**（自己写的 98 行，没路由库），**tRPC v11 + TanStack Query v5** 取数，**登录是裸 fetch 调 better-auth HTTP 端点**（前端没装 better-auth client 包）。
- 前端 ≈ **34,400 行**业务代码（pages 26,917，components 6,252，lib 974，hooks 94，App+main 176；不含 ui 与 index.css）。
- 与后端的耦合有四层，按替换难度从高到低：
  1. **类型耦合**：`import type { AppRouter } from "@heyagent/server/trpc"`（`src/lib/trpc.ts:3`，`apps/server/package.json` 的 `exports["./trpc"].types` 指向 `src/trpc/router.ts`）。前端 tsc 直接检查 server 源码。新后端要么也导出一个同形状的 `AppRouter` 类型，要么前端改成手写/生成的客户端类型。
  2. **tRPC 契约**：前端用到 **189 个不同的 procedure**（server 共定义约 200 个，分 22 个子 router），输入输出全部是 `@heyagent/shared` 的 zod schema 推导类型。
  3. **非 tRPC 端点**：登录/首次设置 4 个、文件上传下载 4 个、图库 2 个、导入 2 个、助手 SSE 2 个、远程画面 WebSocket 2 个（见 §2.2）。
  4. **实时推送**：一个 tRPC 订阅 `live.onChange`（SSE），推 `{table, id}`，前端按表名 → 查询路径的对照表失效重拉；表名就是 **Postgres 表名**，由 PG `LISTEN/NOTIFY` 触发器产生。
- **`@heyagent/shared`（8139 行 zod schema + 业务函数）是前端的“第二个后端”**：136 处 import，除类型外还有大量运行时函数（`can`、`outcomeOf`、`runNow`、`liveTargets`、`nextRunText`、`recognizeCheckpoints` 等）。新后端若保留前端，最省事的做法是**原样保留 shared 包**并让新后端的输出符合其 schema。
- 业务模型深度耦合 HeyAgent 自己的领域：任务(T-)/运行 session(R-)/检查点/验收/派活单(W-)/要人办的事/技能/记忆/规则/固化流程(routine)/流程库/浏览器 Chrome profile 与账号租约/桌面(含 Windows 虚拟机)/图库向量/比物/导入 zip/助手。DeepSeek Harness 如果没有对应概念，兼容层要“造”这些对象，而不是做字段映射。

---

## 1. 技术栈与部署

### 1.1 依赖（`package.json`，全部精确版本）
- 构建：Vite 8.3.4 + `@vitejs/plugin-react` 6.1.2 + `@tailwindcss/vite` 4.3.3；TypeScript 6.0.3；`build` = `tsc -b && vite build`。
- 框架：React / react-dom 19.3.1；Tailwind CSS 4.3.3；`tw-animate-css`；字体 `@fontsource-variable/inter`。
- UI：shadcn 预设 `buKEvLs`（base-lyra；底层 **Base UI** `@base-ui/react` 1.9.0，不是 Radix）、`@shadcn/react` 0.3.1（message-scroller）、`lucide-react` 1.57.0、`class-variance-authority`、`cn` 0.4.0、`shiki` 4.5.0（code-block 高亮，`src/lib/highlighter.tsx`）。
- 数据：`@trpc/client` 11.19.0 + `@trpc/tanstack-react-query` 11.19.0（`createTRPCOptionsProxy`，即“queryOptions 风格”，不是旧的 `@trpc/react-query`）+ `@tanstack/react-query` 5.104.3；`@trpc/server` 11.19.0 在 devDependencies（仅为类型）。
- 表单：`react-hook-form` 7.90.0 + `@hookform/resolvers` 5.9.1（zod resolver，schema 来自 shared）。
- 其他：`react-markdown` 10.1.0 + `remark-gfm`（`components/markdown`）、`diff` 8.0.4（确认卡差异，`lib/text-diff.ts`）。
- workspace 依赖：`@heyagent/shared`（源码直引，条件名 `@heyagent/source`，见 `vite.config.ts` 的 `resolve.conditions` 和 `tsconfig.app.json` 的 `customConditions`）、`@heyagent/server`（仅类型）。
- 没有路由库、没有 better-auth client、没有 WebSocket/SSE 库、没有 zustand/redux（只有 react-query + 少量 `useSyncExternalStore` 小 store：`lib/router.ts`、`components/remote-view/store.ts`、`components/assistant/use-assistant.ts`）。
- 另外 `shadcn` 4.21.5 在 dependencies（CLI + `shadcn/tailwind.css`）。

### 1.2 入口与外壳
- `src/main.tsx`（29 行）：`QueryClientProvider(queryClient)` → `ThemeProvider defaultTheme="dark"`（`components/theme-provider.tsx`，类名 `.dark` 加在 `<html>`，localStorage 键 `theme`，按 `d` 切换，支持 `?theme=dark|light`）→ `App`。启动时 `installClipboardFallback()`（内网 http 无 `navigator.clipboard`）。
- `src/App.tsx`（147 行）：`TooltipProvider` → `Toaster`（Base UI toast）→ `AuthGate`：
  - `useQuery(["auth","session"], getSession)`（`fetch /api/auth/get-session`）→ 没登录再查 `GET /api/setup`（`{needed:boolean}`）决定显示 `SetupForm` 还是 `LoginForm`；登录后查 tRPC `me.get`，成功才渲染外壳。
  - 外壳 = `SessionProvider(me)` + `LiveSync`（订阅 `live.onChange`）+ `Shell`（`SidebarProvider` + `AppSidebar` + `SiteHeader` + 懒加载页面）+ `AssistantWidget`（右下角助手）+ `RemoteViewHost`（远程画面弹窗/小窗宿主）。
  - 所有 16 个页面 `React.lazy` 按页拆包。
- 权限判断在前端也做一份：`useMe()` 来自 `me.get`，`can(user, action, resource)` 是 shared 里的函数（`packages/shared/src/permissions.ts`，admin 全放行，员工按 ownerId/assigneeId）；侧边栏的“管理”组（用户/设置/导入）按 `can(user,"user.manage")` 显示。**后端授权判断仍必须独立实现**，前端只是隐藏按钮。

### 1.3 路由（`src/lib/router.ts`，98 行）
- 自写 hash 路由：`#/<page>?k=v`。`PageId` 共 16 个：`tasks sessions gallery compare memory skills routines rules tools browsers desktops models users settings imports learn`。
- 兼容跳转：`overview→learn`、`templates→tasks`、`hooks→rules`、`todos|inbox→sessions?status=human`、`work→（派活页已并入任务/会话，见 fromWork）`。
- 详情/抽屉状态全在 query 参数：`?id=`（选中项）、`?run=`（任务抽屉里的运行）、`?work=W-…`、`?dispatch=1`、`?status= &mine= &page= &sort= &dir= &q= &source= &task= &outcome=`（会话页）、`?similar=`（图库）。
- 没有“路径参数”路由，新宿主只要能托管一个 `index.html` + 静态资源即可，不需要 SPA 回退配置（hash 不走服务器）。

### 1.4 tRPC / react-query 客户端（`src/lib/trpc.ts`，49 行）
```
URL = "/api/trpc"（同源，cookie 鉴权，无 header/token 注入）
splitLink: subscription -> httpSubscriptionLink（SSE）; 其余 -> httpBatchLink（默认批量，无 transformer）
queryClient: staleTime 30s; retry: 非 401/404 且 <2 次; QueryCache.onError 遇 401 -> 失效 ["auth","session"] 回到登录页
trpc = createTRPCOptionsProxy<AppRouter>({client, queryClient})  // 页面里 useQuery(trpc.x.y.queryOptions(input))
```
- 无 superjson transformer：时间全是 ISO 字符串（`isoTime`），ID 全是字符串（除少数 int：`taskMemory` 条目 id、`engine.notifications` id、`routineLibrary.calls` cursor）。
- 错误约定：`TRPCClientError.data.code` 用 `UNAUTHORIZED` / `NOT_FOUND`；`errorMessage()`（`lib/mutations.ts`）会把 zod 校验失败时 message 里的 JSON issue 列表拆成中文、`INTERNAL_SERVER_ERROR` 固定提示。**后端错误 message 直接展示给用户（中文）**，如“正被 2 个任务选用：……”。
- 所有写操作走 `useAction`（`lib/mutations.ts`，71 行）：成功后 `queryClient.invalidateQueries()`（**全部失效**）+ toast；失败 toast。表单用 `submit()`。

### 1.5 登录（`src/lib/auth.ts`，64 行；无 better-auth 包，直接 fetch）
| 调用 | 用途 | 契约 |
|---|---|---|
| `GET /api/auth/get-session` | 外壳判断是否登录 | 200 + `{session:{userId}}`，未登录 200 + `null`（刻意不返回 401） |
| `POST /api/auth/sign-in/email` | 登录 | JSON `{email,password}`；401 密码错、403 不在白名单、429 限流 |
| `POST /api/auth/sign-out` | 退出 | `{}`；需带 Origin |
| `GET /api/setup` / `POST /api/setup` | 全新环境创建首个管理员 | `SetupStatus {needed}` / `SetupAdminInput`；409 = 已有人设置过 |
- 会话 = better-auth cookie（HttpOnly，同源）。tRPC / 文件 / WebSocket / SSE 全靠这个 cookie，没有 Bearer token。
- 当前用户：tRPC `me.get` → `Me`（`staffSchema` + `email` + `needsMeCount`）。

### 1.6 构建产物与生产服务
- 产物：`apps/web/dist`（单页：`index.html` + `/assets/*` 带 hash；页面懒加载拆 chunk）。
- 镜像 `deploy/web.Containerfile`：node:24 + pnpm 11.23 构建（需要连 `packages/shared` 和 `apps/server` 的源码，因为 tsc 要检查 server 路由类型）→ `caddy:2.11.7-alpine`，`dist` 拷到 `/srv`。
- `deploy/Caddyfile`（pod 入口 `:8080`，http，无自动 HTTPS）：
  - `handle /api/*` → `reverse_proxy 127.0.0.1:3100`，`flush_interval -1`（SSE 不缓冲；WebSocket 升级 Caddy 自动透传）。
  - 其余 → 静态 `/srv`，`/assets/*` 缓存 1 年 immutable，`/index.html` no-cache，`try_files {path} /index.html`。
- 开发：`vite` 5180（`WEB_PORT`），`/api` 代理到 3100（`API_PORT`），`ws:true`（`vite.config.ts`）。
- 结论：新后端只要在**同源 `/api/*`** 下提供所有端点（含 WebSocket 升级），前端零改动；若新后端换端口/路径，只需改 Caddyfile / Vite proxy 和 `lib/trpc.ts` 的 `TRPC_URL`，但上面散落的 `fetch("/api/...")` 字符串共约 15 处（见 §2.2）。

---

## 2. 路由 / 页面清单

### 2.1 页面（16 个；行数含该文件夹全部文件）

通用：所有页面需要 `useMe()`；绝大多数页面用 `lib/data.ts` 的公共查询（见 §5.0）；列表-详情布局由 `components/shell/simple-page.tsx`（379 行）的 `MasterDetail/PickGroup/DetailPanel/DetailSection` 提供；写操作全是 `useAction`（成功全量失效）。

| 路径 | 行数 | 用途 | tRPC（q=query, m=mutation） | 非 tRPC |
|---|---|---|---|---|
| `#/tasks` `pages/tasks/` | 8562（33 文件） | 任务卡片墙；右侧抽屉看任务详情/结构图、某次运行的 session 详情（`?id=&run=`）、派给它的单（`?work=`）；新建/编辑任务、待办、固化流程、任务记忆、派活设置 | q: `tasks.list` `sessions.list` `sessions.get` `sessions.subagents` `todos.board` `work.queueStats` `work.taskStats` `work.list`(infinite) `work.get` `work.lookup` `routine.get` `routine.version` `routineLibrary.list` `taskMemory.list` `engine.sessionFiles` `engine.taskAttachments` `browser.sessionBrowser` `desktop.sessionDesktop`；m: `tasks.create/update/delete/setEnabled/saveStepsFromSession` `todos.create/update/delete` `taskMemory.add/update/delete/summarize/review` `engine.runNow/runTodoNow/cancel/resumeNow/resolveHumanItem/fireEvent/attachToTask/detachFromTask` `sessions.setOutcome` `work.dispatch/updateParams/redo/startNow/cancel` `routine.compile/restore/setMode/setPaused` | `POST /api/files`（带附件运行，`pages/tasks/run-actions.tsx`、`components/files`）；`GET /api/files/:id`（截图/产物，`routine-parts.tsx`）；`RemoteViewDialog`（`run-browser.tsx`、`run-desktop.tsx` → WebSocket） |
| `#/sessions` `pages/sessions/` | 1475（9） | 会话列表（排队中/执行中/等人处理/等待中/验收中/已结束），服务端分页；详情抽屉=运行详情（复用 tasks 的 `RunDetail`）或“要人办的事”处理面板（审批/验收争议/登录/记忆审核/技能修改/固化审核） | q: `sessions.page` `work.list` `work.get` `todos.board` `tasks.list` `routine.version`；m: `engine.resolveHumanItem` `engine.resolveVerifyDispute` `memories.approve/reject` `skills.acceptSuggestion/rejectSuggestion` `routine.review` `sessions.setOutcome` | `GET /api/files/:id`（`human-browser.tsx`/`human-desktop.tsx` 求助截图） |
| `#/gallery` `pages/gallery/` | 937（4） | 图片墙（游标分页、无限滚动）、以图搜图、标签/JSON 文本筛选、上传/拖拽/粘贴、找相似 | q: `gallery.list`(infinite) `gallery.get` `gallery.stats`(待重算时 5s 轮询) `gallery.tags` `gallery.embedding`；m: `gallery.update/delete/deleteMany` | `POST /api/gallery/images`（multipart：`image`,`text`,`tags`）；`POST /api/gallery/search`（multipart：以图搜图）；图片/缩略图 URL 来自 `GalleryImage` 字段（`GET /api/gallery/...`） |
| `#/compare` `pages/compare/` | 1275（4） | 比物：两张图交给视觉模型按标准逐项打分；记录列表（游标分页）+ 详情；比对标准管理 | q: `compare.list`(infinite) `compare.get` `compare.models` `compare.standards` `gallery.list` `apiKeys.list`；m: `compare.create/again/delete/createStandard/updateStandard/deleteStandard/setDefaultStandard` | `POST /api/files`（放图）；图片地址来自 `GalleryImageRef`/`UploadedFile.url` |
| `#/memory` `pages/memory/` | 459（2） | 记忆库（按适用分类）；新建/编辑/归档/删除/批准 | q: `memories.list`；m: `memories.create/update/approve/reject/archive/delete` | 无 |
| `#/skills` `pages/skills/` | 492（3） | 技能（岗位分组、版本、修改建议） | q: `skills.list` `tools.list`；m: `skills.create/update/setStatus/acceptSuggestion/rejectSuggestion` | 无 |
| `#/routines` `pages/routines/` | 1158（4） | 流程库：已转正式的固化流程发布成库、版本、成绩、谁在用 | q: `routineLibrary.list/get/candidates/preview/calls`(infinite) `routine.version`；m: `routineLibrary.publish/update/setPaused/withdraw` | 无 |
| `#/rules` `pages/rules/` | 636（3） | 规则（一句话触发 + 命中后动作 + 工具）；保存后“系统理解为”编译确认 | q: `rules.list` `tools.list`；m: `rules.create/update/delete/restore/compile/confirm` | 无 |
| `#/tools` `pages/tools/` | 1135（6） | 工具：MCP 服务器、HTTP 接口（可从 cURL 导入）、内置、密钥 | q: `tools.list`（含 secrets）`engine.listMcpServerTools`(mutation 型探测)；m: `tools.createHttp/updateHttp/deleteHttp/restoreHttp/createSecret/updateSecret/deleteSecret/createMcpServer/updateMcpServer/deleteMcpServer` | 无（页面里写死提示 `POST /api/events`、cURL 模板） |
| `#/browsers` `pages/browsers/` | 1152（7） | 浏览器 Chrome profile / 账号 / 平台；打开登录窗口、立刻登录、关闭、历史、占用状态；远程画面 | q: `browsers.list` `platforms.list` `browser.live` `browser.accountStatus` `browser.history`；m: `browsers.create/update/delete/createAccount/updateAccount/deleteAccount` `platforms.create/update` `browser.openForLogin/autoLogin/close` | WebSocket `GET /api/browser/view/:browserId`（`RemoteViewDialog`） |
| `#/desktops` `pages/desktops/` | 1089（5） | 桌面（手动登记 / 系统开的 Windows 虚拟机 / 模板），开关机、重置、测试连接、释放 | q: `desktops.list` `desktops.host`；m: `desktops.create/update/delete/test/createVm/createTemplate/vmAction` `desktop.release` | WebSocket `GET /api/desktop/view/:desktopId` |
| `#/models` `pages/models/` | 782（4） | 模型服务（ollama/openrouter/anthropic/openai/deepseek/custom）、模型清单、默认模型（执行/规划/验收） | q: `models.overview` `tasks.list`；m: `models.createProvider/updateProvider/deleteProvider/testProvider/refreshProvider/addModel/updateModel/deleteModel/setDefaults` | 无 |
| `#/users` `pages/users/` | 503（2） | 用户管理（主管） | q: `users.list`；m: `users.create/update/setDisabled/resetPassword` | 无 |
| `#/settings` `pages/settings/` | 1508（12） | 设置（主管）：运行上限、agent、派活、子 agent、助手、浏览器、桌面存放位置、通知渠道、外部事件令牌、API 密钥 | q: `settings.get` `apiKeys.list` `desktops.host` `compare.models`；m: `settings.updateLimits/updateBrowser/updateAgent/updateDispatch/updateSubagent/updateAssistant/regenerateEventToken/clearEventToken/saveChannel/deleteChannel` `apiKeys.create/delete` `desktops.setStorageSettings` | 无（页面文档展示 `POST /api/events`、`/api/work-items`、`/api/gallery/*`、`/api/gallery/mcp` 的 curl 示例，是**对外接口**，非前端调用） |
| `#/imports` `pages/imports/` | 3241（6） | 导入：上传别的 agent 的 zip，AI 读包，七步向导确认后一次导入成任务/技能/记忆/规则/工具；可撤销 | q: `imports.list/get`；m: `imports.savePlan`(经 `trpcClient` 直调) `setSecret` `compileRule` `commit` `undo` `abandon` `stop` `reread` `attachMcpTools`、`engine.runNow` | `POST /api/imports`（XHR，multipart：`file`,`note`,`modelId`，带上传进度）；`GET /api/imports/:id/file`（下载原包） |
| `#/learn` `pages/learn/` | 2513（15） | “看懂架构”讲解页，全部静态假数据（`demo-data/prototype.ts`） | **无** | 无 |

### 2.2 全部非 tRPC 端点（前端实际调用）
| 端点 | 方法 | 调用处 | 内容 |
|---|---|---|---|
| `/api/auth/get-session` `/api/auth/sign-in/email` `/api/auth/sign-out` | GET/POST | `lib/auth.ts` | better-auth（见 §1.5） |
| `/api/setup` | GET/POST | `lib/auth.ts` | 首次创建管理员 |
| `/api/trpc/*` | GET/POST/SSE | `lib/trpc.ts` | tRPC（含订阅） |
| `/api/files` | POST multipart(`file`) | `lib/files.ts`（`uploadFile`），用于 assistant 输入框、compare 放图、任务/运行附件、`components/files` | 返回 `UploadedFile {id,name,mime,size,url}`，失败 `{error}` |
| `/api/files/:id` | GET | `SessionFile.url`/`UploadedFile.url`（`components/files` 的 `fetch(file.url)` 读文本、`<img src>`、`<a download>`） | 要求登录，二进制/文本 |
| `/api/files/:id/sheet?rows=N` | GET | `components/files/index.tsx:421` | `SheetPreview`（xlsx/csv 每表前 N 行，服务端解析） |
| `/api/gallery/images` | POST multipart(`image`,`text`JSON,`tags`JSON) | `lib/gallery.ts` | `GalleryUploadResult {image,duplicate}` |
| `/api/gallery/search` | POST multipart(`image`,`tags`,`text`,`keyword`,`limit`,`minScore`) | `lib/gallery.ts` | `GalleryPage` |
| `/api/imports` | POST multipart XHR | `lib/imports.ts` | `ImportRecord` |
| `/api/imports/:id/file` | GET（`window.location.assign`） | `pages/imports/index.tsx:214` | 下载 zip |
| `/api/assistant/chat` | POST JSON → `text/event-stream` | `components/assistant/stream.ts`、`use-assistant.ts` | 见 §4.2 |
| `/api/assistant/apply` | POST JSON → `text/event-stream` | 同上 | 确认/拒绝改动卡 |
| `/api/browser/view/:browserId[?viewOnly=1]` | WebSocket | `components/remote-view/use-remote-view.ts:40` | 见 §4.3 |
| `/api/desktop/view/:desktopId[?viewOnly=1]` | WebSocket | 同上 | 见 §4.3 |

仅出现在文案/示例、前端不调用的对外接口：`POST /api/events`、`/api/work-items`（GET/POST）、`/api/gallery/mcp`、`/api/compare/*`（HTTP+MCP，给外部系统/agent 用）。
注意：`lib/files.ts`、`lib/gallery.ts`、`lib/imports.ts` 对失败都读 body 的 `{error: string}` 来做提示，新后端的非 tRPC 端点需沿用这个错误形状。

---

## 3. 依赖后端数据形状的共享组件

下面是“数据形状敏感”的组件（改后端要先看这些）。`@heyagent/shared` 下列简称 `S/`。

### 3.1 运行记录 / 过程渲染（最关键，`pages/tasks/`）
| 文件 | 行 | 作用 | 依赖的 shared 类型/函数 |
|---|---|---|---|
| `run-detail.tsx` | 725 | 运行详情主体：标题卡、结果、检查点、验收、记忆、总结、步骤、**过程时间线**（`RunEvent` 逐条，按 kind 画图标，工具调用折叠输入/输出） | `SessionSummary` `RunEvent` `RunEventKind` `Verification` `outcomeOf` `outcomeReasonOf` `isRunEnded` `isReviewing` `eventTimeText` `isRoutineToolId` `SUB_SOURCE_LABEL` `WORK_DISPATCH_TOOL_ID` |
| `run-script.ts` | 365 | 把事件序列解析成层级：浏览器固化脚本分组 `groupScriptEvents`、库流程嵌套 `nestLibrary`(按 `trace.library.callId`)、`code.run` 输出解析、`fetchCallOf`、`TOOLS_MARK` 工具摘要解析 | `RunEvent.trace` `eventTraceSchema` 内部结构、`routineToolStopDataSchema`、`BROWSER_FETCH_TOOL`、工具 id 约定 `routine.<短名>` |
| `parts.tsx` | 218 | `RunStatusBadge`（7 种 `RunStatus`）、`CheckpointList`、`StepList`、`WaitingAlert`、`Elapsed`（1s 定时器） | `RunStatus` `RunCheckpoint` `Trigger`(等待触发) `recognizeCheckpoints` |
| `verification.tsx` | 83 | 验收报告（逐条 pass/fail/unsure） | `Verification` `VerifyVerdict` |
| `run-outcome.tsx` | 187 | 结果区块 + 改结果弹窗 | `RunOutcome` `RunReview` `runOutcomeByLabel` `setOutcomeInputSchema` → `sessions.setOutcome` |
| `run-subagents.tsx` | 199 | 子 agent 区块/子目标；子运行 id = `<父>.<n>` | `SubagentRow` `SubagentGoalView` `isSubagent*Event` `subagentStateLabel`；id 规则 `parseSubSessionId` |
| `run-memory.tsx` `run-digest.tsx` `run-space.tsx` `run-routine.tsx` `run-actions.tsx` `run-browser.tsx` `run-desktop.tsx` | 78/179/199/88/166/88/82 | 本次用到的记忆(`RunMemoryUse`)、总结+记忆候选(`SessionDigest`)、空间文件弹窗(`SessionFile`+`engine.sessionFiles`)、固化(`SessionRoutineState`)、取消/继续/触发事件、看浏览器/桌面画面 | 见各自 import |
| `components/shell/outcome-badge.tsx` | 46 | 结果徽章（办成/没办成/复核中）；会话列表、派活、看板共用 | `RunOutcome` `runOutcomeLabel` `SessionSummary` 的 `outcome/review/status` |
| `pages/sessions/human-item.tsx` `human-routine.tsx` `human-browser.tsx` `human-desktop.tsx` | 289/151/79/56 | “要人办的事”处理面板：审批/验收争议/登录/记忆审核/技能建议/固化审核 | `HumanItem`(kind: approval verify login memory skill routine) `HumanItemKind` `humanItemKindLabel` `isNeedsMe` + 对应 mutation |
| `pages/tasks/work-detail.tsx` `work-parts.tsx` `work-dialogs.tsx` `work-section.tsx` `dispatch-*.tsx` | 680/321/514/182/335+348 | 派活单(W-)：详情、日志、参数表、徽章、优先级、重做、事件绑定 | `WorkItem` `WorkItemDetail` `WorkRun` `WorkLogEntry` `WorkQueueStats` `WorkListInput/View` `workDedupeKey` `workItemOutcome` `isWorkSlotEvent` |
| `task-structure.tsx` `task-config.tsx` `agent-loop-strip.tsx` | 577/245/101 | 任务“结构图”（agent 循环图 + 点块看说明），用 `components/zoom-canvas` 缩放 | `TaskDef` `loopStages` `LoopStage` |
| `task-dialog.tsx` `todo-dialog.tsx` `task-schedule.tsx` `task-routine.tsx` `routine-parts.tsx` | 811/183/144/368/435 | 任务表单、待办、定时(cron)、固化流程(版本/试跑/停止原因) | `TaskInput` `taskInputSchema` `TodoForm` `parseCronFields` `nextRunText` `RoutineSummary/Version/Stop/TestRound` ... |

### 3.2 会话列表
`pages/sessions/list.tsx`(314)、`queue.tsx`(133)、`index.tsx`(362)：消费 `sessions.page` → `SessionPage {items:SessionSummary[], total, page, pageSize, counts, spentToday, endedOutcome}`；状态分组靠 shared 的 `groupOf/sessionGroups/statusesOfGroup`；“排队中”标签是 `work.list`（页码 offset）。

### 3.3 远程画面 `components/remote-view/`（1174 行，6 文件）
- `use-remote-view.ts`(184)：WebSocket 客户端；`index.tsx`(489)：canvas 画面 + 鼠标/键盘/输入法/粘贴/标签页/地址栏/网页弹框；`input.ts`(88)：坐标换算；`agent-cursor.tsx`(157)：agent 虚拟光标；`remote-view-dialog.tsx`(177) + `store.ts`(79)：弹窗/小窗宿主。
- shared 类型：`ViewerServerMessage` `ViewerClientMessage`(`S/browser-runtime.ts`)、`DesktopViewerServerMessage` `DesktopViewerClientMessage` `DesktopCombo`(`S/desktop.ts`)。
- 入口点：`pages/browsers/{index,login-browser}.tsx`、`pages/desktops/index.tsx`、`pages/tasks/{run-browser,run-desktop}.tsx`；弹窗只在 `App.tsx` 挂一个 `RemoteViewHost`。

### 3.4 文件 `components/files/index.tsx`（531 行）
`FileList`/`FileViewer`/`CodeView`/`SheetView`：缩略图（图片）、文本/Markdown/JSON/网络日志（`networkLogLineSchema`）/表格预览，左右切换图片。类型：`SessionFile`(`id,name,mime,size,kind,scope,path,createdAt,updatedAt,url`)、`UploadedFile`、`SheetPreview`、`NetworkLogLine`。**直接 `fetch(file.url)`**，故 `url` 必须是同源可带 cookie 的地址。

### 3.5 助手 `components/assistant/`（2011 行，9 文件）
- `use-assistant.ts`(316)：状态机（流式追加 `entry/delta/update`，乐观插入本地 user 记录 `LOCAL_USER_ID`，出错/断线以服务器存下的为准重拉 `assistant.get`）；`stream.ts`(111)：fetch-SSE 解析；`index.tsx`(353)、`transcript.tsx`(287)、`proposal-card.tsx`(182)、`field-diff.tsx`(333)、`composer-images.tsx`(178)、`history.tsx`(118)、`settings.tsx`(133)。
- shared（`S/assistant.ts` 290 行）：`AssistantChat/ChatSummary/ChatSettings` `AssistantEntry`（user/assistant/tool/proposal/notice）`AssistantProposal` `AssistantChange`（改动确认卡，含改前改后）`AssistantImage/File` `AssistantPageContext`（每次请求带当前页面路由上下文）`AssistantStreamEvent`、上传限制常量 `ASSISTANT_MAX_IMAGES/FILES/MESSAGE`。
- tRPC：`assistant.chats/get/delete/updateSettings/defaults`。HTTP：`/api/assistant/chat|apply`。

### 3.6 其他壳组件
- `components/shell/live-sync.tsx`(88)：实时同步（§4.1）。
- `components/shell/notifications.tsx`(89)：`engine.notifications.list({limit:30}) → {items:AppNotification[], unread}` / `markRead({ids})`；新通知靠 `notifications` 表推送。
- `components/shell/app-sidebar.tsx`(177)：导航 + `needsMeCount` 角标（来自 `me.get`）；`site-header.tsx`、`change-password-dialog.tsx`（`me.changePassword`）。
- `components/shell/model-combobox.tsx`、`pages/sessions/task-filter.tsx` 等：可搜索下拉，数据来自 `models.overview` / `tasks.list`，**模型 id 约定 `<providerId>/<modelName>`**（`modelId()`）。
- `components/markdown`(561，含 typeset.css)、`zoom-canvas`(315)：纯前端，无后端耦合。
- `lib/data.ts`(77)：公共查询 hooks，见 §5.0。

---

## 4. 实时机制

### 4.1 运行/数据更新：一条 tRPC SSE 订阅 + 前端“按表失效”，无轮询（唯一例外 gallery.stats）
- 订阅：`trpc.live.onChange.subscriptionOptions(undefined, {onData})`，`httpSubscriptionLink` 即 SSE（`GET /api/trpc/live.onChange?input=...`，EventSource，自动重连带 `Last-Event-ID`）。
- 服务端（`apps/server/src/trpc/router.ts` `live.onChange` + `live/hub.ts` `ChangeHub`）：每个 `yield tracked(id, change)`，`id = "<bootId>:<n>"`，内存环形缓冲 1000 条用于断线续传；补不齐时发 `{table:"*", id:null}` 让前端全量重拉。输入 `{lastEventId?: string|null}`。
- **载荷形状极小**：`ChangeEvent = { table: string; id: string | null }`（`changeEventSchema`，`S/live.ts`）。**没有任何行数据**，只是“某表某行变了”。数据源：Postgres 触发器 `NOTIFY heyagent_changes '{"table","id"}'`（`drizzle/0001_triggers.sql`），hub 用专用 `LISTEN` 连接。
- 前端映射（`S/live.ts`）：
  - `liveQueriesByTable: Record<table, string[]>`：表名 → 要失效的 tRPC 查询路径（如 `sessions → [sessions.list, sessions.page, sessions.get, sessions.subagents, work.list, work.get, work.taskStats, work.queueStats]`，`session_events/checkpoints/session_waits → sessions.*`，`human_items → todos.board, me.get, ...`，`notifications → engine.notifications.list`，`files → engine.sessionFiles ...`，`gallery_images → gallery.*`，`comparisons → compare.*`，`imports → imports.*`，`work_items → work.*`，`browser_instances → browser.live`，`desktop_vms → desktops.*`，`settings → settings.get, desktops.host` 等，约 55 张表）。
  - `liveQueriesById`：`sessions/session_events/checkpoints/session_waits` 推来的 `id` 就是 `sessions.get` 的 `input.id`，只失效那一个运行详情；子运行 id（`R-12-3.2`）会同时失效父运行。
  - `liveThrottledTables`：`sessions, session_events, checkpoints, checkpoint_records, session_waits, browser_actions` 勤变的表，前端两次失效至少间隔 1s；其余 250ms 批合并（`components/shell/live-sync.tsx`）。
- 因此“运行过程怎么到 UI”：agent 写 `session_events` 行 → 触发器 NOTIFY → hub → SSE `{table:"session_events", id:"R-1024-1"}` → 前端失效 `sessions.get({id})`（带全部事件的完整 `SessionRun`，1 秒节流）和 `sessions.list/page`（摘要）→ react-query 重新 HTTP 拉全量。**过程不是增量推送，每次是整份 `events[]` 重拉**（大运行上千条事件，摘要/详情拆开就是为此：`sessions.list` 不带事件，`sessions.get` 带）。
- 轮询仅一处：`pages/gallery/index.tsx:87` `gallery.stats` 在 `pending` 时 `refetchInterval:5000`（向量表不推）。另有两个纯展示用的 `setInterval`（运行经过时间 1s、VM 时长 30s）。
- 兼容层建议：新后端不必有 PG；只需提供 `live.onChange` 订阅，推 `{table,id}`（可粗到只推 `{table:"*"}` 让前端全量失效，代价是刷新频繁），并保持表名与 `liveQueriesByTable` 一致，或另外修改这张表（它在 shared，前后端共用）。

### 4.2 助手流式：`POST /api/assistant/chat|apply`，`text/event-stream`，`data: <JSON>\n\n`，无 event/id 字段
前端用 fetch + ReadableStream 解析（不能用 EventSource），事件用 `assistantStreamEventSchema` 校验，不认识的丢弃：
```
{type:"chat",   chatId, title}                     // 第一条，新对话在此拿到 id
{type:"entry",  entry: AssistantEntry}              // 新记录 (user/assistant/tool/proposal/notice)
{type:"delta",  id, text}                           // assistant 记录的文本增量
{type:"update", entry: AssistantEntry}              // 整条替换（tool 跑完、proposal 应用后）
{type:"done",   costUsd, pendingProposalId|null}    // 结束
{type:"error",  message}                            // 请求级错误
```
请求体：`AssistantChatInput {chatId?, message, images:id[], files:id[], context:AssistantPageContext, settings?}` / `AssistantApplyInput {proposalId, accept, note?, context}`。前端期望 401 → “登录过期”；非流式响应体可为 `{message|error}`；流断时提示“重新打开对话能看到已存下的部分”，所以**服务端必须持久化对话**，`assistant.get({id})` 要返回完整 `AssistantChat`。
助手的“改配置”是 HeyAgent 特有：模型出 `proposal`（改动确认卡，含 `AssistantChange` 前后值）→ 用户在 UI 确认 → `/apply` 才真正改。

### 4.3 远程画面：WebSocket `ws(s)://<host>/api/{browser|desktop}/view/:id[?viewOnly=1]`（同源 cookie）
- 服务端→前端：**二进制帧 = 一张 JPEG**（浏览器画面缩到 960 宽，坐标按 meta 的 CSS 视口尺寸换算；桌面是屏幕物理像素）；JSON 文本：
  - 浏览器（`ViewerServerMessage`）：`meta {width,height,tabs:[{id,title,url,active}],url,canControl}`、`dialog {kind,message,defaultValue?}`、`dialogClosed`、`closed {reason}`、`cursor {x,y,kind:"move"|"press"}`、`cursorHidden`、`agentAction {label}`
  - 桌面（`DesktopViewerServerMessage`）：`meta {width,height,canControl}`、`closed`、`cursor`、`agentAction`
- 前端→服务端 JSON：浏览器 `viewerClientMessageSchema`：`mouse {type: mousePressed|mouseReleased|mouseMoved|mouseWheel, x,y,button,buttons,clickCount,modifiers,deltaX,deltaY}`、`key {type: keyDown|keyUp|rawKeyDown|char, key,code,keyCode,text,modifiers}`、`text {text}`（输入法/粘贴）、`nav {action: back|forward|reload|goto, url?}`、`tab {id}`、`closeTab {id}`、`dialog {accept,promptText?}`；桌面另有组合键 `DesktopCombo`。
- 断线自动重连，连续 5 次未连上则提示“可能已关闭”；服务端 `closed` 不重连。
- 这是 CDP（Chrome DevTools Protocol）Input 事件语义的直接映射（`mousePressed` 等），服务端在 `apps/server/src/{browser,desktop}/view-relay.ts` 做中继，真正的画面来自 worker 里的 Chrome（`control` 端口 `/browsers/:id/view`）。若 DeepSeek Harness 无此远程画面通道，这块功能需整体降级（只留弹窗外壳）或重做。

### 4.4 其他“实时感”来源
- `Elapsed`（`pages/tasks/parts.tsx:44`）每秒本地刷新；通知靠 `notifications` 表推送；浏览器占用靠 `browser_instances/account_leases/session_waits`。
- 没有 WebSocket 之外的双向通道；所有写操作是 tRPC mutation（成功后全量失效）。

---

## 5. 耦合汇总（后端契约）

### 5.0 前端启动必需的“公共查询”（`lib/data.ts`），几乎每页都用
`staff.list` `tasks.list` `sessions.list`（全部运行摘要，不带事件）`sessions.get` `todos.board` `memories.list` `skills.list` `rules.list` `tools.list` `browsers.list` `desktops.list` `desktops.host` `platforms.list` `models.overview` `routineLibrary.list`、`me.get`。页面外框（`PageFrame`）等这些查询都成功才渲染。**`sessions.list` 无分页、返回全部运行摘要**（有 `taskId`/`outcome` 筛选），`tasks.list` 同样全量；这是为小团队内部使用设计的，数据量大时是性能问题。

### 5.1 按 router 分组的 tRPC 契约（输入输出 schema 均在 `packages/shared/src`，括号内为 server 定义位置）
> 全部是 `protectedProcedure`（需登录 cookie）；管理类操作在服务端再用 `can()` 校验。`q`=query，`m`=mutation，`s`=subscription。

- **me**（`trpc/router.ts`）：`get` q→`Me`；`changePassword` m。
- **users**：`list` q；`create/update/setDisabled/resetPassword` m。**staff**：`list` q→`Staff[]`（人名显示用）。
- **platforms**：`list` q；`create/update` m（`delete` 前端没用）。
- **tasks**：`list` q→`TaskDef[]`（全量）；`create/update/setEnabled/delete/saveStepsFromSession` m（`get` 前端未用）。**taskMemory**：`list` q；`add/update/delete/summarize/review` m（条目 id 为 **int**）。
- **sessions**：`list` q（`{taskId?, outcome?}`→`SessionSummary[]`）；`page` q（§5.3）；`get` q→`SessionRun`（摘要+`events[]`+`memoryUse`+`subGoal`）；`subagents` q；`setOutcome` m。
- **todos**：`board` q→`{humanItems, humanTodos}`；`create/update/delete` m。
- **memories**：`list` q；`create/update/approve/reject/archive/delete` m。**skills**：`list` q；`create/update/setStatus/acceptSuggestion/rejectSuggestion` m。**rules**：`list` q；`create/update/delete/restore/compile/confirm` m。
- **tools**：`list` q（含 secrets / mcp servers / http 工具 / 内置）；HTTP 工具、密钥、MCP 服务器各 create/update/delete(+restoreHttp) m。
- **browsers**：`list` q；`create/update/delete`、`createAccount/updateAccount/deleteAccount` m。
- **models**：`overview` q→`{providers, defaults}`；`createProvider/updateProvider/deleteProvider/testProvider/refreshProvider/addModel/updateModel/deleteModel/setDefaults` m。
- **settings**：`get` q→`SettingsView`；`updateLimits/Browser/Agent/Dispatch/Subagent/Assistant`、`regenerateEventToken/clearEventToken`、`saveChannel/deleteChannel` m。
- **engine**（`engine-router.ts`，412 行）：`runNow` `runTodoNow` `cancel` `resumeNow` `resolveHumanItem` `resolveVerifyDispute` `fireEvent` `attachToTask` `detachFromTask` m；`taskAttachments` `sessionFiles` q；`listMcpServerTools` m；`notifications.list` q / `notifications.markRead` m。（**这是启动/控制运行的核心入口。**）
- **browser**（`browser-router.ts`）：`live` `sessionBrowser` `accountStatus` `history` q；`openForLogin` `autoLogin` `close` m。**desktops**：`list` `host` q；`create/update/delete/test/createVm/createTemplate/vmAction/setStorageSettings` m。**desktop**：`sessionDesktop` q；`release` m。
- **gallery**：`list`（游标）`get` `embedding` `stats` `tags` q；`update/delete/deleteMany` m。**apiKeys**：`list/create/delete`。
- **compare**：`list`（游标）`get` `models` `standards` q；`create/again/delete/createStandard/updateStandard/deleteStandard/setDefaultStandard` m。
- **work**（`work-router.ts`）：`list`（cursor/offset）`get` `taskStats` `queueStats` `lookup` q；`dispatch/updateParams/redo/startNow/cancel` m。
- **imports**：`list/get` q；`savePlan/setSecret/compileRule/commit/undo/abandon/stop/reread/attachMcpTools` m。
- **assistant**：`chats/get/defaults` q；`delete/updateSettings` m。
- **routine**（固化流程）：`get/version` q；`compile/review/setMode/setPaused/restore` m。**routineLibrary**：`list/get/candidates/preview/calls`(infinite) q；`publish/update/setPaused/withdraw` m。
- **live**：`onChange` s（§4.1）。

### 5.2 shared 里的运行时函数（前端直接 import 执行，新后端若不带 shared 则需重写）
`can`（权限）、`outcomeOf/outcomeReasonOf/isRunEnded/isReviewing/isNeedsMe`（运行状态判定）、`runNow/staffName/toolName/modelName/allModels/findById`（展示）、`liveTargets/liveThrottledTables`（实时）、`nextRunText/parseCronFields/recognizeCheckpoints`、`fmtDate/fmtShort/fmtDateTime/relativeDayText/sameShanghaiDay`（**写死 Asia/Shanghai**）、`normalizeDomain/normalizeTags/templatePlaceholders/httpParamsOf`、各种 `xxxLabel`（中文文案）、`XxxSchema`（表单校验，react-hook-form + zodResolver 直接复用服务端 schema）。

### 5.3 分页形状（不统一，新后端要逐个兼容）
| 过程 | 方式 | 形状 |
|---|---|---|
| `sessions.page` | 页码 | 入参 `{group,mine,source,taskId,outcome,q,sort,dir,page,pageSize≤200}` → `{items,total,page,pageSize,counts{running,human,waiting,verifying,ended},spentToday,endedOutcome{achieved,notAchieved}}`；服务端筛选、数各标签个数 |
| `work.list` | 游标+offset 混用 | 入参 `{q,status,outcome,view,taskId,fromTaskId,fromSessionId,days,cursor,offset,key,limit≤200}` → `{items,nextCursor:string|null,counts}`；`cursor`=上一页最后一张单的 id；会话页“排队中”用 `offset`；任务抽屉用 `infiniteQueryOptions` |
| `gallery.list` | 游标（不透明字符串） | `{…filter,similarTo?,query?,minScore?,limit,cursor?}` → `{items,nextCursor?:string,model?}`；相似度检索时无游标 |
| `compare.list` | 游标 | `{query,status,sessionId,limit≤100,cursor}` → `{items,nextCursor:string|null}`；cursor=上一页最后一条 id |
| `routineLibrary.calls` | 游标 | `cursor` 为 **正整数**（数据库 bigserial id），从新到旧 |
| `engine.notifications.list` | limit | `{items,unread}` |
| 其余 `*.list`（tasks/sessions.list/memories/skills/rules/tools/browsers/…） | **全量，无分页** | 数组 |

### 5.4 ID 与数据库假设
- **全部是可读文本 id，前端会显示、解析和拼 URL**（`packages/shared/src/ids.ts`）：任务 `T-1042`；运行 `R-<任务号>-<第几次>`（手动）/ `R-<任务号>-<MMDD>[-k]`（cron）；**子运行 `<父运行>.<n>`（前端用 `parseSubSessionId` 正则解析父子关系，live.ts 也依赖）**；派活单 `W-…`；记忆 `m-011`；技能 `sk-…`；规则 `rl-…`；MCP `mcp-…`；Chrome `br-…`；账号 `acc-<chrome>-<平台>`；要人办的事 `ap-/vf-/lg-/mr-/ss-/ro-NN`；待办 `td-NN`；模型服务 `<kind>-<n>`；模型 `<providerId>/<modelName>`；固化版本 `routineVersionId`。文件、图库、比对 id 是字符串（服务端 id 格式不限，但 URL 拼接用 `/api/files/:id`）。
- 少数 int id：`TaskMemoryEntry.id`、`AppNotification.id`、`routineLibrary.calls` cursor。
- **实时表名 = PG 表名**（`liveQueriesByTable` 的 key），触发器 `heyagent_changes` 通道。
- 时间：全部 ISO 8601 字符串；前端展示固定 `Asia/Shanghai`；`isoTime` zod 校验。
- 事件顺序：`RunEvent.seq`（会话内 1 起递增，PG 复合主键 `(session_id, seq)`），`events[]` 须按 seq 升序。
- 金额：`costUsd`、`tokensIn/Out` 在运行/总结/助手上显示；`models.overview` 里价格是每百万 token 的美元。
- 相似度：图库 `minScore` 范围 -1～1（向量余弦），`gallery.embedding` 返回 `GalleryEmbedding`。
- 文件下载 URL 由服务端在对象里直接给（`SessionFile.url`、`UploadedFile.url`），前端不拼（例外：`/api/files/${screenshotFileId}`、`/api/imports/:id/file`）。

### 5.5 前端对后端“概念”的硬依赖（兼容层要“造”出来的东西）
1. **Task（任务定义）**：目标、步骤、检查点(`recognizeCheckpoints`)、定时 cron、负责人、选用的 记忆/技能/规则/工具/浏览器/桌面、网址白名单、验收模型、派活设置、固化开关。
2. **Session（运行）**：status ∈ `running needs_human waiting verifying done incomplete failed`；outcome ∈ `achieved not_achieved`(+`outcomeBy` ∈ agent rule review verify human)；检查点、验收轮次、等待触发(`Trigger`)、轻量复核(`RunReview`)、总结(`SessionDigest`)、子 agent、挂起时长 `pausedMs`、浏览器使用 `browserIds`。
3. **RunEvent.kind** ∈ `plan think tool checkpoint rule wait resume human verify done error`（进度时间线按它渲染，工具调用带 `toolId/input/output/ms/tokens/trace`）。
4. **HumanItem（要人办的事）**：approval(审批) / verify(验收争议) / login(登录) / memory / skill / routine；人处理的一整套工作流。
5. **派活 WorkItem**：外部系统/任务派单、优先级、去重键、重试、名额(`work.slot`)、排队。
6. **记忆/技能/规则/工具库**：带“被谁选用”“审核”“版本”概念；规则要编译成结构并确认。
7. **浏览器账号租约、Chrome profile、桌面/虚拟机**：占用、登录状态探测、远程画面。
8. **图库（向量）/比物（视觉模型）/导入（zip→AI→向导）/助手（改配置的确认卡）**：均为 HeyAgent 特有的产品模块，且各有自己的 HTTP/SSE 端点。
9. **用户/角色**：仅 admin(主管)/员工两级；`Me.isAdmin`；邮箱白名单登录；`needsMeCount`。

### 5.6 对替换策略的启示
- **完全保留前端**：新后端需实现 §5.1 的 ~189 个 tRPC procedure（输入输出过 shared 的 zod）、§2.2 的 ~12 个 HTTP/WS 端点和 §4.1 订阅。对 DeepSeek Harness 缺失的概念（HumanItem/检查点/验收/派活/固化/图库/比物/导入/助手/浏览器租约/桌面）工作量最大。
- **只保留外壳 + 重写部分页面**：最小可用子集 = 登录 + `me.get` + 公共查询(§5.0) + `tasks.*` + `sessions.list/page/get` + `engine.runNow/cancel` + `live.onChange`（可降级为推 `{table:"*"}`）+ `models.*` + `settings.get`；其余页面可在路由表里（`App.tsx` 的 `PAGES`、`lib/router.ts` 的 `PAGES`、`app-sidebar.tsx` 的 `NAV_*`）按页摘除，页面之间互相引用较多（`tasks` 的 `RunDetail` 被 `sessions` 页复用，`pages/tasks/task-dialog.tsx` 的 `StepEditor/BrowserFields/MultiPick` 被 `imports` 复用），摘除时要处理。
- **前端类型源**：`AppRouter` 类型（`@heyagent/server/trpc`）是编译期耦合，新后端若非 TS/tRPC，要生成一份 `AppRouter` 兼容类型包（或用 trpc-openapi / 手写 shim 导出同名类型），否则前端 `tsc -b` 过不了。
- 认证：新后端若不是 better-auth，需提供同形状的 3 个端点（`get-session` 返回 `{session:{userId}}|null`、`sign-in/email`、`sign-out`）+ `/api/setup`，或改 `lib/auth.ts` 一个文件（64 行）。

---

## 6. 代码规模

总计（不含 `components/ui` 与 `index.css`）：**≈ 34,400 行 / 约 170 个 ts+tsx 文件**；`components/ui`（shadcn 生成）46 个文件 5397 行；`index.css` 159 行；`packages/shared` 8139 行（28 个文件，最大 `schemas.ts` 812、`config.ts` 790、`routine-library.ts` 759、`engine.ts` 664）；`apps/server` ≈ 59,957 行（参考，被替换的对象）。

### pages（合计 26,917）
| 目录 | 行 | 文件数 | 备注 |
|---|---|---|---|
| `pages/tasks` | 8562 | 33 | 最大；`task-dialog.tsx` 811、`run-detail.tsx` 725、`work-detail.tsx` 680、`task-structure.tsx` 577、`work-dialogs.tsx` 514 |
| `pages/imports` | 3241 | 6 | `wizard.tsx` 1403、`edit-dialogs.tsx` 789 |
| `pages/learn` | 2513 | 15 | 纯静态讲解，无后端耦合，可直接删 |
| `pages/sessions` | 1475 | 9 | |
| `pages/settings` | 1508 | 12 | |
| `pages/compare` | 1275 | 4 | |
| `pages/routines` | 1158 | 4 | |
| `pages/browsers` | 1152 | 7 | |
| `pages/tools` | 1135 | 6 | |
| `pages/desktops` | 1089 | 5 | |
| `pages/gallery` | 937 | 4 | |
| `pages/models` | 782 | 4 | |
| `pages/rules` | 636 | 3 | |
| `pages/users` | 503 | 2 | |
| `pages/skills` | 492 | 3 | |
| `pages/memory` | 459 | 2 | |

### components / lib / 其他
| 目录 | 行 | 文件数 |
|---|---|---|
| `components/assistant` | 2011 | 9 |
| `components/shell` | 1222 | 11 |
| `components/remote-view` | 1174 | 6 |
| `components/markdown`（含 typeset.css） | 561 | 2 |
| `components/files` | 531 | 1 |
| `components/(根)` login-form / setup-form / theme-provider | 438 | 3 |
| `components/zoom-canvas` | 315 | 1 |
| `lib` | 974 | 14（`text-diff.ts` 303、`router.ts` 98、`highlighter.tsx` 124、`data.ts` 77、`mutations.ts` 71、`auth.ts` 64） |
| `hooks` | 94 | 2 |
| `App.tsx` + `main.tsx` | 147 + 29 | 2 |

### 纯前端、与后端无关、可原样复用
`components/ui/*`（shadcn）、`components/{markdown,zoom-canvas}`、`lib/{text-diff,highlighter,clipboard,utils}`、`hooks/*`、`theme-provider.tsx`、`pages/learn`、`components/shell/{simple-page,creatable-combobox,tags-combobox,site-header}` 中的布局部分。其余几乎都直接消费 shared schema。

### UI 规则对重写的约束（`docs/ui-rules.md`、`CLAUDE.md`）
所有页面只能用 shadcn 预设 `buKEvLs`（base-lyra，Base UI）组件；registry 没有的组件需“例外流程”（先告知用户）。已登记的自定义组件清单（ui-rules §8）有约 25 项，例如 RemoteView、AgentCursor、ZoomCanvas、FieldDiff（新增 `--diff-added/--diff-removed` token + `diff` 依赖）、AssistantWidget（`@shadcn/react`）、MarkdownView、Toast `z-100` 补丁（唯一一处改了 `components/ui/toast.tsx`）。如果迁移时新增页面/组件，仍须遵守这套规则：只用主题 token、无任意值、无 `rounded-*`、图标仅 lucide、表单用 `Field` + react-hook-form。
