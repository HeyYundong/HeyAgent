# HeyAgent

公司内部用的通用 agent 平台。你在 Web 控制台里配置任务：写一句话要做什么、做到什么算完成，选好它能用的工具、浏览器、技能、记忆和规则；agent 用大模型去调接口、操作网页，把繁琐的内部工作做完。要等的时候挂起，等到了接着做同一次运行；要人拍板的事放进待办看板；做完由另一家的模型逐条验收。

平台本身不含任何业务。每个岗位要做的事，都是在控制台里配出来的。

## 快速使用

### 1. 启动

只需要 rootless Podman（**不用 Docker**）。Node 和 pnpm 只有改代码时才要。

```bash
cp .env.example .env     # 只要填上 OPENROUTER_API_KEY
scripts/pod.sh up        # 第一次要构建镜像、下载 Chrome，比较慢
```

- 起好后打开 `http://<这台机器的 IP>:8080`。
- 主密钥 `.dev/kek` 没有会自动生成。它能解开所有密钥和登录态，请离线备份一份。
- 数据库密码、登录签名密钥也是自动生成的，记在 `.dev/pod/secrets.env`。
- 正式服务器用 `scripts/server-install.sh` 安装，见 [docs/ops.md](docs/ops.md)。

### 2. 登录

- 账号 `admin@heyagent.local`，初始密码在 `.dev/admin-password`。
- 登录后在左下角用户菜单里点「修改密码」。
- 同事的账号在「用户」页里点「新建用户」，选主管或员工。员工能看全部内容，只能操作自己负责的。

### 3. 看一眼模型

`.env` 里填了 key，第一次启动就自动接好了 OpenRouter。「模型」页里有三个默认模型：

| 用途 | 默认模型 |
|---|---|
| 执行 | Claude Sonnet 5.5 |
| 规划（翻译规则、压缩长对话时写摘要） | Claude Opus 5.5 |
| 三方验收 | Gemini 3.8 Flash |

验收模型不能和执行模型是同一家。想先省钱试跑，可以在任务里把执行模型选成 Claude Haiku 5.5。

### 4. 跑通第一个任务（1 分钟）

1. 「任务」页 →「新建任务」，填：
   - **任务**：写一份三行的 CSV，表头是 name,age，用「存文件」保存为 people.csv
   - **目标**：保存了 people.csv，有表头和三行数据
   - **用哪些 → 工具**：选「存文件」
2. 点「创建并启动」，打开这次运行，过程会一条条实时出现。
3. 跑完在「附件和产物」里下载 people.csv。

这一步只是确认平台能跑通，确认完把这个任务删掉就行。

### 5. 让它用浏览器

1. 「浏览器」页 →「新建 Chrome」。打开公开网站可以先不配代理。
2. 新建任务，**用哪些 → 工具**选「浏览器」和「存文件」，任务写：打开 https://example.com，读出页面标题，用存文件保存为 title.txt。
3. 运行中点「看浏览器」，能看到 agent 正在操作的页面。遇到验证码或登录页时，运行会停下来等你，在待办里点「去浏览器里处理」。

需要登录的网站：在「浏览器」页给这个 Chrome 加平台和账号，点「打开 Chrome 登录」，登录一次后「保存登录状态」，以后 agent 都带着这个登录态。

### 6. 搭真正的任务

照 [使用手册](docs/guide.md) 第 4 节的顺序来：
1. 先配要调用的接口（HTTP 工具，粘贴 cURL 导入，密钥写成 `{{名字}}`）或 MCP 服务器；
2. 写技能（操作手册）和记忆；
3. 用一句话写规则，例如「调用某个工具前要我批准」「说做完了交给三方验收」，翻译后确认才生效；
4. 最后建任务：写步骤和检查点，选好这些东西，需要的话加定时。

要人处理的事都在「待办」页的「等人处理」一栏，侧边栏的数字就是等你处理的数量。

## 现在能做什么

- **任务和运行**：一句话任务、目标、可选的步骤、检查点；立即运行、带附件运行、定时（cron）运行；挂起几天后在同一次运行里继续，服务重启不丢进度。
- **工具**：HTTP 接口（粘贴 cURL 导入，密钥只存在加密的密钥库里）、MCP 服务器、系统内置工具（勾检查点、挂起等待、问人、读技能、存文件、读附件、通知等）。
- **浏览器**：服务器上有界面的 Chrome，带代理和加密保存的登录状态；人在控制台的远程画面里登录、过验证码；按账号限制并发；网址白名单。
- **规则**：用一句话写，系统翻译成程序能执行的条件，人确认后生效，agent 绕不过。能做审批、拦截、截图、通知、自动记录检查点、交给验收。
- **三方验收**：执行和验收用不同厂商的模型，逐条核对检查点；有疑问先反问 agent，还说不清交给负责人。
- **记忆和技能**：人写的直接生效；agent 提议的要人审核。
- **待办看板**：每次运行一张卡；审批、登录、验收争议、记忆和技能审核；人加的待办（定时、cron、等外部事件）。
- **账号**：主管和员工两种角色，员工能看全部、只能操作自己负责的。站内通知，可推到飞书、企业微信群机器人或 webhook。

## 还不能做的

- 桌面软件自动化（推迟到有具体要操作的软件时）。
- 一个任务拆给多个 agent 并行。
- Ollama 等内网模型：还没接，现在只用 OpenRouter。
- HTTPS：v1 只用 HTTP，只能在内网用。
- 其他限制见 [使用手册第 8 节](docs/guide.md#8-现在还做不到的)。

## 文档

| 文档 | 给谁看 | 内容 |
|---|---|---|
| [docs/guide.md](docs/guide.md) | 配置任务的人 | 使用手册：从零搭一个任务，每样配置是什么、在哪配、注意什么 |
| [docs/ops.md](docs/ops.md) | 管理员 | 运维说明：安装、升级、备份、恢复、主密钥 |
| [docs/v1-plan.md](docs/v1-plan.md) | 所有人 | v1 方案：做什么、架构、技术选型、里程碑和完成情况 |
| [docs/dev/](docs/dev/) | 开发者 | 开发约定（`conventions.md`）、接口说明（`api.md`）、各里程碑的开发说明 |
| [docs/ui-rules.md](docs/ui-rules.md) | 写前端的人 | UI 规则：页面只用 shadcn 预设 `buKEvLs` 的组件 |

## 在开发机上跑起来

需要：Node 22.12 以上、pnpm 11、rootless Podman。**只用 Podman，不用 Docker。**

### 分开起（改代码时用）

```bash
cp .env.example .env              # 按里面的注释改，至少填 BETTER_AUTH_SECRET；OPENROUTER_API_KEY 可以先不填
scripts/dev-db.sh up              # 开发数据库：PostgreSQL 18 容器，只绑 127.0.0.1:5432
scripts/dev-kek.sh                # 生成开发用主密钥 .dev/kek（已经有就不动）
pnpm install
pnpm db:migrate                   # 建表

pnpm dev                                    # API，端口 3100
pnpm --filter @heyagent/server dev:worker   # worker（真正跑 agent 的进程），另开一个终端
pnpm --filter @heyagent/web dev             # 控制台，http://localhost:5180
```

- API 第一次启动时会建管理员 `admin@heyagent.local`，初始密码写在 `.dev/admin-password`。
- `.env` 里填了 `OPENROUTER_API_KEY` 的话，第一次启动会自动接入 OpenRouter、设好默认模型；没填就登录后在「模型」页加。
- 开发机上直接跑的 worker 没有 Chrome，浏览器相关的功能要用下面的整套 pod。
- `pnpm db:seed` 灌演示数据，只给开发用。
- 检查：`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test`（测试用 `.env` 里 `TEST_DATABASE_URL` 指的库，会被清空）。

### 起整套（和正式环境一样的 4 个容器）

```bash
scripts/pod.sh up        # 构建镜像并起 postgres、api、worker（带 Chrome）、web，入口 http://<本机 IP>:8080
scripts/pod.sh status
scripts/pod.sh logs api  # 看某个容器的日志：postgres | api | worker | web
scripts/pod.sh down      # 停掉，数据卷保留
scripts/pod.sh reset     # 停掉并删掉全部数据，回到空白环境（接着再 up）
```

- 第一次构建要下载 Chrome 等，时间比较长。镜像已经有了可以加 `HEYAGENT_SKIP_BUILD=1` 跳过构建。
- 管理员初始密码会复制到 `.dev/admin-password`。OpenRouter 的 key 从 `.env` 读。
- 正式服务器的安装和升级见 [docs/ops.md](docs/ops.md)。

## 技术栈

TypeScript 全栈：前端 Vite + React + shadcn（预设 `buKEvLs`），后端 Hono + tRPC，PostgreSQL 18 + Drizzle + pg-boss，模型层 Vercel AI SDK + OpenRouter，浏览器用有界面的 Chrome + Playwright MCP。全部跑在 rootless Podman 里。

## 仓库结构

```text
apps/web/        控制台前端
apps/server/     后端：api 和 worker 两个入口
packages/shared/ 前后端共享的类型和纯函数
deploy/          镜像、pod 描述、Caddy、Quadlet、systemd
scripts/         开发和运维脚本
docs/            方案、使用手册、运维说明、开发说明
spikes/          技术实测（不进 workspace）
```
