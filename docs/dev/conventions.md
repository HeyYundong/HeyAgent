# HeyAgent 开发约定

适用于所有正式代码。产品方案见 `docs/v1-plan.md`，UI 硬规则见 `docs/ui-rules.md`（页面只能用 shadcn 预设 `buKEvLs` 的组件，例外要先问）。

## 0. 第一条：平台通用，代码里不写业务

HeyAgent 是通用的 agent 平台，搜品只是用它配出来的第一个业务（方案 2.0，用户 2026-10-17 明确要求）。

- 产品代码（`apps/`、`packages/`）里不出现岗位、平台名、业务对象（客户、供应商、比价表……），也不为某个网站写专用代码或专用页面。
- 业务全部是配置：任务、技能、记忆、规则、工具配置（HTTP / MCP）、浏览器配置。业务示例只放在种子数据里。
- 缺能力时只补通用能力，也就是任何岗位都能用的，并在汇报里列出来。
- 界面上的举例文字可以用业务例子，但逻辑不能依赖它们。
- 每个里程碑验收时都会跑下面这条检查。种子数据和界面举例之外的命中，要逐条解释：
  ```bash
  grep -rniE '1688|amazon|亚马逊|temu|tiktok|shopify|whatsapp|比价|搜品|供应商' apps packages --include=*.ts --include=*.tsx | grep -v -e /seed/ -e /demo-data/
  ```

## 1. 仓库结构

```text
apps/
  web/          控制台前端，由 design/prototype 改造（Vite + React + shadcn 预设 buKEvLs）
  server/       后端，同一份代码两个入口：api（Hono + tRPC）和 worker（agent 引擎，M1 起）
packages/
  shared/       前后端共享：领域类型（zod schema + 推导出的 TS 类型）、纯函数
deploy/         Containerfile、Podman 整套描述（kube YAML）、Caddyfile
scripts/        开发脚本（开发数据库、主密钥、起整套 pod）
spikes/         技术实测（不进 pnpm workspace，结论写进报告）
docs/           方案、调研、开发说明
design/         定稿原型，只读参考。不改、不提交（已在 .gitignore 里）
```

## 2. 工具和版本

- **包管理**：pnpm 11 workspace（`apps/*`、`packages/*`）。不用 npm / yarn 装 workspace 里的包。
- **Node**：开发机是 Node 22.23，容器里用 Node 24 LTS。`engines.node` 写 `>=22.12`（pg-boss 12 的要求）。
- **TypeScript**：~6.0，strict，ESM。跨包引用走 workspace 包名（`@heyagent/shared`），运行时不依赖路径别名。前端沿用原型的 `@/` 别名。
- **版本锁定**：方案第 3 节列出的运行时依赖写精确版本（不带 `^`），lockfile 提交。只装当前里程碑用得到的包。
  - hono 4.13.13、@hono/node-server 2.1.5、@trpc/server 和 @trpc/client 11.19.0、drizzle-orm 0.45.4、drizzle-kit 0.31.11、better-auth 1.7.10、zod 4.6.7、pg-boss 12.38.0、ai 7.0.142（7.0.143 发布不满 1 天）、@openrouter/ai-sdk-provider 3.1.0、@ai-sdk/anthropic 4.0.81、@ai-sdk/openai 4.0.95、@ai-sdk/deepseek 3.0.66（三个都和 ai 7.0.142 用同一版 @ai-sdk/provider、provider-utils）、@ai-sdk/openai-compatible 3.0.70（自定义模型服务，2026-10-20；同样是 provider 4.0.28、provider-utils 5.0.61）、@ai-sdk/mcp 2.0.77、cron-parser 5.10.2、react-hook-form 7.90.0、@hookform/resolvers 5.9.1、react-markdown 10.1.0、remark-gfm 4.0.1、@playwright/mcp 0.0.83、playwright-core 1.64.1、sharp 0.35.5、@modelcontextprotocol/server 2.3.1（图库，2026-10-17）。
  - **xlsx = SheetJS 社区版 0.20.3**（2026-10-19，读写 Excel，只装在 `apps/server`，前端不引入）：从官方的 `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` 装（`package.json` 里写的就是这个网址，lockfile 记了 integrity，容器构建照样 `pnpm install --frozen-lockfile`，要能连 cdn.sheetjs.com）。**不要**装 npm 上的 `xlsx`：那边停在 0.18.5，有已知漏洞（原型污染、ReDoS），SheetJS 之后只在自己的 CDN 发版。社区版不能写样式（加粗、颜色）和冻结窗格，只设列宽；不要为此再加别的 Excel 库。代码在 `apps/server/src/files/sheets.ts`。
- **测试**：vitest。和数据库有关的测试连真实的 PostgreSQL 18（开发数据库里的 `heyagent_test` 库），不用 mock 数据库。
- **代码风格**：照原型的写法。标识符用英文；注释和界面文案用中文，注释写「为什么」，不写废话。prettier 配置沿用原型。

## 3. 容器：只用 Podman

- **不用 Docker**，也不要建议安装 Docker（用户定的）。镜像用 `Containerfile`，构建用 `podman build`。
- 开发机是 Ubuntu 22.04 自带的 **rootless Podman 3.4.4**：
  - 没有 `podman compose`，没有 Quadlet；
  - 起整套用 `podman play kube <yaml>`（Podman 4 起叫 `podman kube play`，脚本要兼容两种写法）；
  - 镜像名写全：数据库是 `docker.io/pgvector/pgvector:0.8.7-pg18-trixie`（Postgres 18 + pgvector，2026-10-17 起，图库的向量检索要用；和原来的 `postgres:18` 同版本、数据卷通用）。
- 网慢、`scripts/pod.sh up` 构建时 `pnpm install` 下载超时：用 `HEYAGENT_PNPM_STORE=/mnt/toshiba/.pnpm-store scripts/pod.sh up`，构建时把本机的 pnpm store（`pnpm store path` 去掉末尾的 `/v11`）挂进去，本机有的包不再下载，缺的照旧从官方源下。Podman 3.4 不支持 `RUN --mount=type=cache`，所以是 `podman build -v` 加 build arg `PNPM_STORE`。
- 停整套 pod 用 `scripts/pod.sh down`（`up` 重建前也走同一个 `stop_pod`），不要直接 `podman pod stop` 或 `podman play kube --down`：pod 共享 PID 命名空间，pod stop 会和 infra 一起停，pause 一退出 postgres 就被强杀、下次启动要崩溃恢复。脚本先停 web、worker、api，再单独给 postgres 60 秒正常关机，最后才删 pod。
- 服务器上会是 Podman 4.4 以上，用 Quadlet 交给 systemd 管理（部署阶段再做）。
- 调研报告里 Docker 的参数要换成 Podman 的对应写法：`--shm-size`、`--init`、`--security-opt seccomp=...` 在 Podman 里都有。
- 开发机**没有免密 sudo**：不要装系统包。需要的工具放进容器，或者用户目录下的二进制。

## 4. 开发端口

| 端口 | 用途 |
|---|---|
| 5173 | 原型（`design/prototype` 的 dev server，一直开着给用户看，**不要停**） |
| 5180 | `apps/web` 的 Vite dev server，监听 0.0.0.0，`/api` 代理到 3100 |
| 3100 | API 服务 |
| 5432 | 开发数据库（Podman 容器，只绑 127.0.0.1） |
| 8080 | 整套 pod（Caddy 入口），内网演示用 |
| 5190 | 远程画面实测页（只在实测期间开） |

## 5. 数据和安全

- 密钥、登录态只存加密后的值。主密钥（KEK）开发时放在 `.dev/kek`（脚本生成，已 gitignore），服务器上用 Podman secret。
- 仓库里不放任何真实的密钥、密码、cookie。配置写 `.env.example`，真实值放 `.env`（gitignore）。
- 接口返回给前端的数据里，密钥只给掩码（例如 `sk-or-••••3f2a`），登录态只给状态，不给内容。
- 种子数据（原型的假数据）只用于开发和演示，由环境变量显式打开，正式环境默认不灌。

## 6. 子 agent 的工作规则

- 只改分配给你的目录。`design/` 只读；不要停 5173 上的原型。
- **不 commit、不 push、不切分支**，由监工和用户决定。
- 不要为了让检查通过去改 `apps/web/src/components/ui/*`（归 shadcn CLI 管）。遇到组件库自带的报错，先用 `npx shadcn@latest add <组件> --diff` 看上游有没有修，再报告。
- 自己起的 dev server、临时容器，做完要关掉；开发数据库容器可以留着。
- 结束时汇报：做了什么、怎么验证的（命令和关键输出）、和说明不一致的地方、没解决的问题。没验证过的不要说成已完成。
