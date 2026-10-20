# Session 空间：中转站 + 临时代码（开发说明，2026-10-20）

> **状态：用户 2026-10-20 已确认，开工。** 沙箱用 B（bubblewrap）；**这次就要能上公网**（第 5.1 节，走出网代理）；第 8 节其余问题全部按建议。验证脚本在 `spikes/sandbox/2026-10-20/`。
> 用户 2026-10-20 的要求：「空间文件」给 agent 当中转站，保存任务的中间状态，还能写临时代码。已经对齐的：
> - **一个 session 一个空间**（一个任务有多个 session，不做任务级共享空间）；
> - 临时代码要能**执行**，在**独立沙箱**里跑；
> - 语言：**Python、Node.js、Shell**。
> 文中写「现在」的，都是读 origin/main（8739591）的代码确认过的。

## 0. 一页纸

| # | 做什么 | 一句话 |
|---|---|---|
| 1 | **文件按路径存、能覆盖** | agent 存文件时给路径（例如 `state/progress.json`、`scripts/clean.py`），同一个 session 里同一路径再存就是覆盖，文件 id 不变 |
| 2 | **能列、能改、能删** | 新内置工具 `file.list`（列出这个 session 空间里所有文件）、`file.edit`（按原文替换一段，改代码不用整份重发）、`file.delete`（删 agent 自己写的文件） |
| 3 | **能存代码** | `file.save` 放开文本类型：`.py` `.js` `.mjs` `.ts` `.sh` `.sql` 等都能存，界面和 `file.read` 都按文本看 |
| 4 | **能执行代码** | 新内置工具 `code.run`：在独立沙箱里跑 Python / Node.js / Shell，空间里的文件挂在 `/workspace`，跑完新增、改动的文件自动回到空间 |
| 5 | **界面** | 「空间文件」按路径显示，来源多一项「agent 写的」；运行详情里 `code.run` 的步骤显示代码、退出码、输出 |

## 1. 现在的样子（origin/main）

- 文件：内容存在文件卷（`files/storage.ts`，不可变的 blob），`files` 表一行一个文件；`session_id` 有值 = 只属于那次运行（`files/service.ts`）。
- `file.save`（`engine/tools/builtin.ts`）：每存一次都是**新文件**，同名不覆盖；只能存 `TEXT_SAVE_EXTENSIONS`（csv、md、json、txt、html、xml、yaml、log）和 Excel。
- `file.read`：按 id 读这次运行的文件和任务附件；文本 / 图片 / 表格。
- agent **没有列文件的工具**，只能用系统告诉它的 id（附件清单、下载说明、长输出说明、自己存时返回的 id）。
- 平台里**没有任何执行代码的能力**。worker 容器里有数据库连接（`DATABASE_URL`）和 KEK，代码不能在 worker 里直接跑。

## 2. 空间里的文件

### 2.1 路径

`files` 加一列 `path`（可空，迁移 `00xx`）：

- agent 写的文件（`file.save`、`file.edit`、`code.run` 产生的）：`path` = agent 给的相对路径，规范化后（去掉开头的 `/`、`./`，不许 `..`、不许空段，每段 ≤ 100 字，整条 ≤ 300 字，最多 8 层）。`name` = 路径最后一段。
- 同一个 session 里 agent 写的文件 `path` 唯一（部分唯一索引：`session_id, path where kind = 'artifact'`）。
- 别的来源不变，`path` 为空；在列表和沙箱里放在固定目录下（见 2.3）。

### 2.2 覆盖

同一路径再写：存新 blob、更新那一行的 `storage_path` `size` `sha256` `mime`，加一列 `updated_at`；旧 blob 删掉。文件 id 不变，agent 和界面之前拿到的链接继续有效，看到的是最新内容。不留历史版本（问题 3）。

### 2.3 列表 / 沙箱里的目录

| 来源 | 在空间里的位置 | 沙箱里能不能改 |
|---|---|---|
| agent 写的（`artifact`） | 它自己给的路径，例如 `state/progress.json` | 能改，改了写回 |
| 任务附件、这次运行带的附件 | `attachments/<名字>` | 只读 |
| 浏览器下载 | `downloads/<名字>` | 只读 |
| 截图 | `screenshots/<名字>` | 只读 |
| 工具输出全文 | `tool-outputs/<名字>` | 只读 |

同名的加 `-2` `-3`。agent 写文件时不能用这几个保留目录开头（报错并说明）。

## 3. 内置工具

| 工具 | 风险 | 怎么带上 | 说明 |
|---|---|---|---|
| `file.save`（存文件，改） | write | 照旧，任务选 | 参数 `name` 改名为 `path`（不再认 `name`：工具参数每次调用时才校验，旧的运行记录不受影响）。同一路径覆盖，返回 id 和「新建 / 覆盖」。文本类型放开（3.1） |
| `file.read`（读文件，改） | read | 照旧（带附件、选浏览器时自动带上） | 多认一个参数 `path`（和 `fileId` 二选一） |
| `file.list`（新） | read | 选了 `file.read` / `file.save` / `code.run` 任意一个就自动带上 | 列出空间：路径、id、来源、大小、更新时间；可按目录前缀筛 |
| `file.edit`（新） | write | 选了 `file.save` 或 `code.run` 自动带上 | `path` + `edits: [{ old, new }]`：每段 `old` 必须在文件里正好出现一次，按顺序替换，全部成功才保存 |
| `file.delete`（新） | write | 同 `file.edit` | 只能删 agent 写的文件 |
| `code.run`（新，「运行代码」） | external（能上公网） | 任务选 | 见第 4 节 |

`file.list` `file.read` 算「安静工具」（`rules.ts` 的 `QUIET_TOOLS`），不触发「任意工具之后」的规则。

### 3.1 能存的文本类型

现在的 12 种，再加下面这些（前后端按同一张表）。`.env` 不加，避免养成存密钥的习惯。

| 扩展名 | MIME | 界面高亮语言 |
|---|---|---|
| `.py` | `text/x-python` | python |
| `.js` `.mjs` `.cjs` | `text/javascript` | javascript |
| `.ts` | `text/x-typescript` | typescript |
| `.sh` `.bash` | `text/x-shellscript` | bash |
| `.sql` | `text/x-sql` | sql |
| `.toml` | `text/x-toml` | toml |
| `.ini` `.cfg` | `text/plain` | ini |
| `.jsonl` | `text/plain` | json |

全部是 `text/*`，所以 `isTextMime` 不用改。

### 3.2 `code.run` 返回的文本（界面按这个格式显示）

```
退出码 0 · 用时 1.2 秒
写回空间：新建 out/result.csv；覆盖 state/progress.json；删掉 tmp/a.txt
访问了：pypi.org、files.pythonhosted.org；拒绝：127.0.0.1
--- stdout ---
……
--- stderr ---
……
```

- 第一行固定。超时写 `超时（60 秒），整组进程已被杀掉 · 退出码 137 · 用时 60.0 秒`；起不了沙箱写 `沙箱没起来：<原因>`（这时 `isError`）。退出码不为 0 不算工具出错，照常返回，由 agent 自己看。
- 「写回空间」「访问了」两行没有内容就不写。
- stdout、stderr 各给最后 10000 字，被截掉时在那一段开头写 `…（前面还有 N 字，全文见 tool-outputs/<名字>）`，全文存成 `tool_output` 文件。没有输出的那段不写。

## 4. 运行代码 `code.run`

### 4.1 参数

```ts
"code.run": z.object({
  language: z.enum(["python", "node", "bash"]),
  /** 二选一：空间里的脚本路径，或直接给代码（不会存成文件） */
  file: z.string().optional(),
  code: z.string().max(200_000).optional(),
  args: z.array(z.string().max(1000)).max(50).optional(),
  stdin: z.string().max(1_000_000).optional(),
  /** 秒，默认 60，最多 600 */
  timeout: z.number().int().min(1).max(600).optional(),
})
```

### 4.2 一次执行

1. 准备目录：把这个 session 空间里的文件按第 2.3 节的位置放进一个临时目录（只读来源放进只读的子目录）。
2. 在沙箱里执行（第 5 节），工作目录 `/workspace`。
3. 收回：对比执行前后，`/workspace` 下（保留目录以外）新增、改动的文件写回空间（`kind = artifact`，按路径覆盖）；删掉的文件，问题 4。
4. 返回给 agent：退出码、用时、是否超时、stdout / stderr（各给末尾 1 万字，超出的全文存成 `tool-outputs/` 文件，沿用现在长输出的做法）、写回了哪些文件。

### 4.3 限制（默认值，可在设置里调）

| 项 | 默认 |
|---|---|
| 单次超时 | 60 秒（最多 600） |
| 内存 | 1 GB |
| CPU | 1 核 |
| 进程数 | 256 |
| 一次写回的文件 | 最多 200 个，单个 ≤ 50 MB，合计 ≤ 200 MB |
| 一个 session 空间总量 | 1 GB |
| 联网 | 只能经出网代理访问公网 HTTP / HTTPS，内网和 pod 里的 127.0.0.1 一律拒绝（第 5.1 节） |

### 4.4 沙箱的根文件系统

不另起镜像跑容器，而是在 worker 镜像构建时多一个阶段：从 `python:3.12-slim-bookworm` 装好常用包，加上 Node 24 的可执行文件、bash、coreutils、jq，整个复制到 worker 镜像的 `/opt/sandbox-root`，沙箱只读挂载它当根目录（第 5 节）。常用包先装好（问题 2）；能联网，所以 agent 也可以自己 `pip install` / `npm install`，装在这个 session 的 home 目录里（5.2）。根文件系统里还要有 `socat`（5.1）和 `curl`。

## 5. 沙箱怎么起

2026-10-20 在开发机上实测（rootless Podman 3.4.4、cgroup v2），两条路：

| | A. 宿主 Podman 起兄弟容器 | B. worker 里用 bubblewrap 起沙箱（**建议**） |
|---|---|---|
| 怎么做 | 把宿主的 Podman socket 挂进 pod，worker 每次调 API 起一个容器 | worker 镜像里装 `bubblewrap`，带一份**独立的根文件系统**（从 `python:3.12-slim` 复制到 `/opt/sandbox-root`），每次 `bwrap` 起一个新的命名空间沙箱 |
| 安全 | 拿到 socket 就等于拿到宿主用户的全部权限（能起任意容器、挂任意宿主目录）。worker 一旦被攻破，宿主就沦陷了 | 不给 worker 加任何权限，pod.yaml 的 securityContext 不用改 |
| 限制 | 开发机只下放了 memory、pids 控制器，**限不了 CPU** | 内存（`ulimit -v`）、CPU 时间（`ulimit -t`）、进程数（`ulimit -u`）、墙钟超时（杀整个进程组） |
| 每次开销 | 秒级（建容器） | 约 25 ms |
| 部署 | 要挂 hostPath 的 socket，Quadlet 也要配 | 只改 worker 镜像 |

B 的实测结果（在和 pod 里 worker 一样的容器里跑：`--cap-drop=all --cap-add=SYS_CHROOT`、no-new-privileges、默认 seccomp）：

- **看不到 worker 的东西**：环境变量（`DATABASE_URL` 等）全清；密钥目录、文件卷、`/app` 代码都不存在；根目录是独立的 Debian（只读）。
- **不能联网**：独立网络命名空间。pod 里的 127.0.0.1（Postgres、API）连不上，公网也连不上。
- **看不到别的进程**：独立 PID 命名空间（pod 开了 `shareProcessNamespace`，这一条必须有）。
- **文件**：`/workspace` 可写，写出来的文件属主是 worker 的 uid 1000，worker 能读能删；只读挂载的输入改不了。
- **语言**：Python 3.12（pandas 读写 xlsx 正常，一次约 0.6 秒）、Node 24、bash、jq 都能跑。
- **限制**：Python 申请 2 GB 内存直接 `MemoryError`；死循环到 CPU 时间就被杀（退出码 137）；fork 炸弹被挡住。

要注意的三点：

1. bwrap 不能在带权限的进程里跑：worker 为 Chrome 留了 `SYS_CHROOT`，所以先用 `setpriv --inh-caps=-all --ambient-caps=-all` 清掉继承的权限，再调 bwrap。
2. Podman 给容器的 `/proc` 加了遮罩，沙箱里挂不了新的 `/proc`，所以沙箱里**没有 `/proc`**。实测 Python、pandas、Node 都正常，只是 Node 的 `os.cpus()` 返回空、`ps` 用不了。以后要的话，pod.yaml 给 worker 加 `procMount: Unmasked` 就能挂（实测 `--security-opt unmask=ALL` 后可以，里面只看得到沙箱自己的进程）。
3. V8 一启动就要占很大的虚拟地址，`ulimit -v 1G` 时 Node 起不来。所以 Node 的虚拟内存上限放到 4 GB，堆用 `--max-old-space-size` 限；Python 和 bash 按设置的内存上限。`ulimit -u` 是按 uid 计数的，和 worker、Chrome 共用，上限给 1024，只用来防 fork 炸弹。真正的总内存兜底，靠给 pod 里的 worker 容器设 memory limit。

### 5.1 上公网：出网代理

用户要求这次就能上公网，同时不能让代码碰到 pod 里的 127.0.0.1（Postgres、API）和内网。做法（2026-10-20 实测通过，`spikes/sandbox/2026-10-20/test-net.sh`）：

- 沙箱照样独立网络命名空间（只有自己的 lo），**没有直连**的网络。
- worker 里跑一个出网代理（Node，`proxy.mjs` 是验证版），听一个 unix socket，支持 HTTP 转发和 HTTPS `CONNECT`。它**自己解析域名**，解析结果是回环、私有、链路本地、CGNAT、组播、IPv6 唯一本地 / 链路本地 / IPv4 映射地址的一律 403，连接时直接连解析出的 IP（防 DNS 重绑定）。
- socket 所在目录只读挂进沙箱；沙箱启动时先起 `socat TCP-LISTEN:3128,bind=127.0.0.1,fork UNIX-CONNECT:<socket>`，再跑用户代码；环境变量 `HTTP_PROXY` `HTTPS_PROXY`（大小写各一份）= `http://127.0.0.1:3128`，`NODE_USE_ENV_PROXY=1`。
- 实测：curl、Python urllib、Node `fetch`、`pip install` 都通；`127.0.0.1`、`localhost`、`169.254.169.254`、`10.x` 都被拒；`--noproxy` 直连失败。
- 只支持 HTTP / HTTPS，原始 TCP、UDP（例如直连数据库、SMTP）不通，系统提示里写明。
- 代理记一行日志（session、主机、端口、允许 / 拒绝、字节数），运行详情里 `code.run` 的结果附上「访问了哪些主机」。

### 5.2 每个 session 的目录

worker 本地（不是文件卷）给每个 session 一个目录：`workspace/`（空间文件的镜像，增量同步：按 sha 比对，只拉变了的）和 `home/`（`HOME`，`pip install --user`、npm 缓存放这里，**不同步回空间**，这次运行里一直有效）。session 结束后删掉；worker 重启就重建（home 里装的包要重装，可以接受）。

### 5.3 选型说明

用户选的是「独立沙箱容器」。B 不是另起一个 Podman 容器，但隔离的东西是一样的：独立的文件系统、网络、进程、用户命名空间，没有密钥，只能经出网代理上公网，而且不用把宿主权限交给 worker。用户 2026-10-20 确认用 B（问题 5）。

## 6. 界面

- 「空间文件」弹窗（`pages/tasks/run-space.tsx`）：名字一列换成路径；来源标签多「agent 写的」；覆盖过的文件显示更新时间。
- 运行详情的步骤里，`code.run` 显示：语言、代码（`CodeBlock`）、退出码 `Badge`、输出（`CodeBlock`，终端样式）、写回的文件（点开用 `FileViewer`）。全部用现有 registry 组件，不新增自定义组件。
- 任务的工具选择里多一个内置工具「运行代码」。

## 7. 分包

1. 监工（我）：shared 的工具参数、迁移、这份说明、沙箱的最小实现（验证过的那条路）。
2. 子 agent：后端（文件路径、覆盖、新工具、`code.run` 接沙箱、测试）。
3. 子 agent 或监工：界面（第 6 节，改动小）。
4. 监工：审代码、真模型联调（让 agent 用 Python 处理一张表、把进度写进 `state/` 再读回）。

改动提交在分支 `worktree-session-space`，**用户确认后再合到 main**；不重建正在运行的 pod。

## 8. 要你拍板的问题

| # | 问题 | 建议 |
|---|---|---|
| 1 | 沙箱里的代码能不能联网？ | ~~先不联网~~ → **用户定：这次就要能上公网**。走出网代理（5.1），没用 pasta / slirp4netns（要 `/dev/net/tun`，pod 要加设备，3.4 的 play kube 不好配） |
| 2 | 预装哪些包？ | Python：pandas、numpy、openpyxl、xlrd、python-dateutil、requests、beautifulsoup4、lxml；Node 24 不加包；bash、coreutils、jq、curl、socat。别的 agent 自己装 |
| 3 | 覆盖时要不要留历史版本？ | **不留**，空间是中转站，只保留最新的。真正要交付的文件，agent 存的时候换一个路径就行 |
| 4 | 代码里删掉了 `/workspace` 下 agent 写的文件，空间里要不要跟着删？ | **跟着删**（只删 agent 写的，附件、下载这些本来就是只读的） |
| 5 | 沙箱用哪种方式（第 5 节）？ | **B：worker 里用 bubblewrap，加独立的根文件系统**。A 要把宿主 Podman 的权限交给 worker，开发机上也限不了 CPU |
| 6 | 「运行代码」要不要每次都让人批准？ | **不用**。看不到密钥、碰不到内网；能上公网，所以风险等级记 **external**（和浏览器一样，走现有规则）；任务要先手动选上「运行代码」才有 |
| 7 | agent 存的中间文件和最终交付的文件要不要分开？ | **不分**，都是「agent 写的」。最终交付哪些，agent 在总结里写明路径（系统提示里会这样要求）。以后要分，再加一个「交付」标记 |

## 9. 实现记录（后端，2026-10-20）

### 9.1 做了什么、在哪

| 部分 | 文件 |
|---|---|
| 迁移 **0023**：`files.path`、`files.updated_at`（已有行 = `created_at`）、部分唯一索引 `files_session_path_idx (session_id, path) where kind = 'artifact' and path is not null` | `apps/server/drizzle/0023_session_space.sql`、`src/db/schema.ts` |
| 路径规范化、MIME 表（3.1，`MIME_BY_EXT` 和 `TEXT_SAVE_EXTENSIONS` 都加了）、覆盖（`writeSpaceFile`）、删（`deleteSpaceFile`）、空间列表（`listSpace` / `assignSpacePaths`，2.3 的目录和 -2 -3 去重，结果确定）、`toSessionFile` / `listSessionFiles` 带 `path` `updatedAt` | `src/files/service.ts` |
| 工具：`file.save`（path、覆盖）、`file.read`（fileId / path 二选一）、`file.list`、`file.edit`、`file.delete`、`code.run` | `src/engine/tools/builtin.ts`、`builtin-defs.ts` |
| 自动带上（3 节）；`file.list` 进安静工具；系统提示的「空间文件」「运行代码」两节、「怎么工作」里交付写明路径 | `src/engine/sessions.ts`、`rules.ts`、`prompt.ts` |
| 沙箱：bwrap 参数和执行、输出收集、能不能用的检查 | `src/sandbox/runner.ts` |
| 每个 session 的目录、增量同步、跑完对比 | `src/sandbox/workspace.ts` |
| 出网代理 | `src/sandbox/proxy.ts` |
| `code.run` 本身、3.2 的输出格式、清理 | `src/sandbox/code-run.ts` |
| 运行结束删目录、worker 启动和每小时清理 | `src/engine/worker-runtime.ts` |
| 设置（环境变量，api.md 17.3） | `src/engine/runtime.ts` 的 `sandbox` |
| 网关：`ToolOutcome.keepFull` 时不再按 8000 字截断；长输出的提示里加上 `tool-outputs/` 路径 | `src/engine/gateway.ts` |
| 验收的证据：产物按更新时间取最新 6 个，写路径 | `src/engine/verify.ts` |
| 镜像：沙箱根文件系统构建阶段 + bubblewrap | `deploy/worker.Containerfile` |
| 接口文档 | `docs/dev/api.md` 5.6、第 17 节 |

shared 的契约（`builtinToolInputs`、`sessionFileSchema`）**没有改**。

### 9.2 怎么跑一次 `code.run`

1. 检查沙箱能不能用（setpriv、bwrap、根文件系统、真起一个空沙箱；能用的结果一直缓存，不能用的 1 分钟后再查）。不能用 → `沙箱没起来：<原因>`（`isError`），别的工具照常。
2. 同一个 session 的 `code.run` 排队（进程内的锁）。
3. 准备目录（5.2）：`<HEYAGENT_SANDBOX_DIR>/<session>/` 下 `workspace/`（agent 写的文件）、`ro/<目录>/`（附件、下载、截图、工具输出全文）、`home/`、`code/`（直接给的代码 → `main.py|js|sh`）、`p/`（代理 socket）、`manifest.json`（每个文件的 id、sha256、stat 指纹）。按 id + sha256 + stat（size、mtime、ctime、inode）判断，只写缺的和变了的；空间里没有的删掉；`node_modules`、`__pycache__` 留着、不同步。
4. 起出网代理（每次一个，跑完关掉，所以「访问了」就是这次的），然后 `setpriv --inh-caps=-all --ambient-caps=-all bwrap --unshare-all --unshare-user --die-with-parent --new-session --cap-drop ALL --clearenv …`：只读的根文件系统挂成 `/`，`--dev /dev`，`/tmp` 是 512 MB 的 tmpfs，`/workspace` 可写，`ro/<目录>` 只读挂到 `/workspace/<目录>`，`home/` 挂到 `/home/sandbox`，代码目录只读挂到 `/tmp/.code`，代理目录只读挂到 `/tmp/.proxy`，没有 `/proc`。沙箱里先起 `socat`（只在有代理 socket 时），再 `ulimit -v/-t/-u/-f`，再 `exec` 用户程序。
5. 墙钟超时：子进程自己一个进程组（`detached`），到点 `kill -<pgid> SIGKILL`，bwrap 带 `--die-with-parent`，沙箱的 PID 命名空间跟着没（实测后台的 `sleep 100` 也没了，3 秒超时 3.0 秒返回）。
6. 对比：stat 指纹变了的才算 sha256，内容没变（只是 touch、删了重建）不算改；符号链接、特殊文件、路径不合规矩的、读不了的不写回，写进「没写回」。写回按 4.3 的上限（个数、单个、合计、空间总量）。删掉的 agent 文件空间里也删（问题 4）。
7. 输出按 3.2；stdout / stderr 各留末尾 1 万字，被截掉时全文存成 `tool_output` 文件。
8. 运行结束（已完成 / 没完成 / 失败）后 worker 删掉这个 session 的目录；worker 启动时、之后每小时最多一次，删掉已经结束或库里没有的 session 的目录（挂起、在等的留着，home 里装的包还在）。

环境变量（沙箱里）：`PATH`（含 `~/.local/bin`、`~/.npm-global/bin`）、`HOME=/home/sandbox`、`USER=sandbox`、`LANG=C.UTF-8`、`PYTHONUNBUFFERED`、`PYTHONDONTWRITEBYTECODE`、`PIP_DISABLE_PIP_VERSION_CHECK`、`NPM_CONFIG_PREFIX=~/.npm-global`（`npm install -g` 装进 home）、`NODE_PATH`、代理四个（大小写）、`NO_PROXY=localhost,127.0.0.1,::1`（沙箱自己的回环，不出沙箱）、`NODE_USE_ENV_PROXY=1`、数值库线程数 `OPENBLAS_NUM_THREADS` `OMP_NUM_THREADS` `MKL_NUM_THREADS` `NUMEXPR_NUM_THREADS` = 1，Node 另有 `NODE_OPTIONS=--max-old-space-size=<内存 MB>`。

### 9.3 和说明不一样的地方

1. **`code.run` 的输出多一行「没写回：路径（原因）；…」**（在「写回空间」后面）：符号链接、特殊文件、超过上限、路径不合规矩、读不了的文件。界面那边按「第一行和 `--- stdout ---` 之间都是说明行」解析，能直接显示。非默认端口的主机写成 `主机:端口`（`localhost:8080`）。每类最多列 20 个。
2. **出网代理不拦 `198.18.0.0/15`**：开发机的 DNS 是 fake-ip（例如 Clash），所有公网域名都解析到这个网段，拦了就完全上不了网（第一次在镜像里实测就是这样）。说明 5.1 的清单里本来也没有它。要注意：fake-ip 环境里内网域名也会解析成 198.18.x.x，由宿主的代理软件去连——这时代理挡不住「内网域名」（内网 IP 照样挡得住）。服务器上不要用 fake-ip DNS，或者在那边的代理软件里把内网域名设成直连拒绝。
3. **代理限制目标端口**：默认只许 80、443、8080、8443（`HEYAGENT_SANDBOX_PROXY_PORTS`，`*` = 不限），否则 CONNECT 能当成任意 TCP 隧道（发邮件、连公网数据库），和「只支持 HTTP / HTTPS」对不上。
4. **数值库只开一个线程**：OpenBLAS 默认按核数开几十个线程，都算进 `ulimit -u`。和「CPU 1 核」一致。
5. **`--disable-userns`、`--hostname` 没加**：Podman 里 `/proc/sys` 只读、设不了主机名，加了 bwrap 起不来（实测）。所以沙箱里还能再建用户命名空间（拿不到额外权限，只是多一层）；主机名是 worker 的。
6. **路径每段另有 ≤ 255 字节的限制**（文件系统的上限；100 个汉字就超了），只读来源的文件名截到 200 字节（保留扩展名）。
7. **`file.save` 不能存成已有目录的名字、也不能把已有文件当目录**（`a` 是文件就不能再存 `a/b`）：沙箱里的磁盘上放不下这种空间。
8. **一个空间的总量只算这次运行自己的文件**（任务附件不算）。
9. 加路径之前存的老产物（`path` 为空）：列表里放在根目录、按名字（和有路径的同名时加 -2），能读、能改、能删；改或覆盖它时补上路径。
10. `ulimit -f` 用的是空间总量（默认 1 GB），单个文件 50 MB 的限制在写回时检查（超了不写回、写进「没写回」）。

### 9.4 测试

- 单元（不连库）`apps/server/test/space-unit.test.ts`：路径规范化、读路径、文件名、MIME；2.3 的路径和去重（顺序无关）；`file.edit` 的替换（重叠也算不唯一）；代理拦哪些地址；真起代理连本机假服务器（拦本机 / 内网 / 解析到内网的域名 / 不允许的端口；放行时 HTTP 转发和 CONNECT 隧道都通、记主机和字节数）；3.2 的输出格式和截断；bwrap 参数；workspace 的准备、增量、对比（touch 不算改、符号链接和太深的路径跳过、node_modules 不动、读不了的跳过）。15 个。
- 引擎（真库 + 假模型 + 替身沙箱）`apps/server/test/space.test.ts`：`file.save` 新建 / 覆盖 id 不变 / 旧 blob 删掉 / 各种报错，`file.list`（含 prefix）、按路径读、`file.edit`（全有或全无）、`file.delete`（只能删 agent 写的），自动带上的工具，`sessionFiles` 带 `path` `updatedAt`；`code.run` 写回（新建、覆盖、删掉、超过 1 MB、符号链接、`__pycache__`）、stdout 截断和全文文件、网关不再截、超时 / 退出码非 0 的格式、参数校验、沙箱起不来的报错、系统提示、运行结束删目录、清理。5 个。
- 改了已有测试里 `file.save` 的参数（`name` → `path`）和输出文字（`engine` `m3` `sheets`），内置工具清单多 `code.run`。
- 整套：`pnpm --filter @heyagent/server test` → 25 个文件通过、1 个跳过（真沙箱），371 个用例通过（改 runner 参数和代理网段之前跑的；之后重跑了 space-unit、space：20 个通过）。`pnpm --filter @heyagent/shared build`、`@heyagent/server build`、lint 通过；`@heyagent/web build` 也通过（另一位同事的改动在里面）。

**真沙箱**（`apps/server/test/sandbox-it.test.ts`，`HEYAGENT_SANDBOX_IT=1` 才跑）：在新镜像 `localhost/heyagent-worker:space-dev` 里，带 pod 里 worker 一样的限制跑，用挂进去的工作树里的 vitest、单独的测试库（`*_test`，不和整套测试抢库）：

```bash
podman build -f deploy/worker.Containerfile -t localhost/heyagent-worker:space-dev .
podman run --rm --network host --cap-drop=all --cap-add=SYS_CHROOT --security-opt no-new-privileges \
  -v $PWD:$PWD -v <放 run-it.mjs 的目录>:/be:ro \
  -e TEST_DATABASE_URL=postgres://heyagent:heyagent@127.0.0.1:5432/heyagent_space_it_test \
  --entrypoint node localhost/heyagent-worker:space-dev /be/run-it.mjs
# run-it.mjs：cd apps/server，HEYAGENT_SANDBOX_IT=1 node node_modules/vitest/vitest.mjs run --configLoader runner test/sandbox-it.test.ts
```

不要用 `--userns=keep-id`：那样容器里的 uid 就是宿主用户，`ulimit -u` 会把宿主上这个用户的全部进程都算进去，一开线程就失败。`--configLoader runner` 是因为容器里的用户不能往工作树里写 vite 的临时文件。

2026-10-20 结果（1 个用例，11 次 `code.run`，全部通过，约 30 秒）：

| 验证 | 结果 |
|---|---|
| Python + pandas 读 `attachments/报价.csv`、写 `out/报表.xlsx`、改 `state/progress.json` | 退出码 0，0.5 秒；「写回空间：新建 out/报表.xlsx；覆盖 state/progress.json」；xlsx 用平台的表格读取能读出 `苹果 3 2.5 7.5` |
| Node（空间里的脚本 + 参数） | `node v24.22.0 a b c`，写回 `out/n.json` |
| bash：环境变量、密钥、worker 的目录 | 只有上面列的变量；测试进程里的密钥、`DATABASE_URL` 都没有；`/app` `/data` `/run/heyagent-secrets` `/proc/1` 都不存在；Debian 12 |
| 超时 | `sleep 100 & sleep 100` 和死循环都在 3.0 秒被杀：「超时（3 秒），整组进程已被杀掉 · 退出码 137」 |
| 内存 | Python 申请 2 GB → `MemoryError`；Node 无限分配 → `JavaScript heap out of memory`，退出码 134 |
| 出网 | `https://example.com` 200（curl、requests）；`127.0.0.1`、`localhost:8080`、`169.254.169.254` 被代理拒（内网地址）；`example.com:5432` 被拒（端口）；沙箱自己的 127.0.0.1:5432 连不上（没有 pod 的 Postgres）；`--noproxy` 直连、Python 原始 socket 都不通；结果行「访问了：example.com；拒绝：127.0.0.1、169.254.169.254、localhost:8080、example.com:5432」 |
| pip | `pip install tabulate` 经代理装进 home（「访问了：files.pythonhosted.org、pypi.org」），下一次 `code.run` 还能 import |
| 其余 | `/tmp` 每次是新的；`rm old.txt` → 空间里删掉；符号链接不写回（「没写回：out/link（是符号链接，不跟随）」）；`/workspace/attachments/` 只读；fork 炸弹被 `ulimit -u` 挡住（`fork: retry: Resource temporarily unavailable`），到点整组杀掉；stdin、参数照传；运行结束后沙箱目录删掉了 |

### 9.5 还没做的、要注意的

- **建议给 pod 里的 worker 容器设 memory limit**（例如 4～6 GB，看并发数）：`ulimit -v` 只限单个进程的虚拟内存，几个沙箱同时跑、加上 Chrome，总量要靠容器的上限兜底。pod.yaml 这次没改。
- **磁盘**：`ulimit -f` 只限单个文件，`/workspace` 里写很多文件的总量没有硬上限（写回时有上限，但磁盘上的 workspace 目录不受限）；`/tmp` 是 512 MB 的 tmpfs（占内存）。
- **服务器如果是 Ubuntu 24.04 以上的宿主**，要确认 `kernel.apparmor_restrict_unprivileged_userns` 没有挡住容器里的非特权用户命名空间（开发机 22.04 没有这个限制）。挡住了 `code.run` 会报「沙箱没起来：bwrap …」，别的不受影响。
- 沙箱里没有 `/proc`（`ps` 不能用、Node 的 `os.cpus()` 是空的），说明第 5 节第 2 点的 `procMount: Unmasked` 没做。
- bash 语言按 1 GB 的 `ulimit -v`，在 bash 里调 `node` 会起不来（V8 要的虚拟地址大），要跑 Node 用 `language: node`。
- `ulimit -u` 在容器里按 worker 的 uid 计数（和 Chrome 共用）；数值库已经限成 1 个线程，正常用不会碰到。
- 只在 worker 进程内对同一个 session 的 `code.run` 排队；同一个 session 同一时间只在一个 worker 上跑，所以够用。
- `localhost/heyagent-worker:space-dev` 镜像留着（约 2 GB），没有动 `:m1` / `:m1-p1` 和正在跑的 pod；测试库另建了 `heyagent_space_it_test`。

### 9.6 真模型端到端（2026-10-20）

走真实的产品路径：宿主上从工作树起 API（端口 3120，私有库 `heyagent_space`，跑了迁移、新建管理员，文件目录用临时目录），worker 用新镜像 `space-dev`（`--network host`，pod 里 worker 的 securityContext 参数，同一个库、主密钥、文件目录；API 进程本来就不跑任务）。模型 `openrouter/anthropic/claude-haiku-5.5`。任务只选了「运行代码」，带一个 7 行的 CSV，步骤：建 `state/progress.json` → 用 Python 汇总成 `out/summary.xlsx`、更新进度 → 读回进度 → 代码里请求 `https://example.com`、把状态码写进进度 → 总结并写明路径。

两次运行，都是 **done**：

| | R-1-1 | R-2-1（修了下面第 1 个问题、换新镜像之后） |
|---|---|---|
| 花费 / 模型调用 | $0.0027 / 6 步 | $0.0023 / 5 步 |
| 工具调用 | plan.set 1、file.list 1、file.read 2、file.save 2、file.edit 2、code.run 2 | plan.set 1、file.list 1、file.read 2、file.save 3、code.run 2 |
| xlsx 怎么来的 | agent 用 code.run 算、再用 file.save（sheets）存 | 步骤里写明「在代码里用 pandas 写」：`写回空间：新建 out/summary.xlsx` |
| example.com | 200，但 code.run 输出里**没有**「访问了」（问题 1） | 200，输出里「访问了：example.com」 |

两次都核对过：`code.run` 的输出符合 3.2（`退出码 0 · 用时 0.6 秒` / `写回空间：…` / `访问了：…` / `--- stdout ---`）；`sessionFiles` 返回 `attachments/orders.csv`、`state/progress.json`、`out/summary.xlsx`，进度文件 id 不变、被覆盖过（R-2-1：创建 04:29:28、更新 04:29:38，内容是最后一版，含 `"http_status_example_com": 200`）；`out/summary.xlsx` 用预览接口读得出（华东 19 / 132、华北 13 / 104、华南 10 / 84.5）；worker 日志 `[sandbox] 出网 R-2-1 example.com 允许 6041 字节`；运行结束后 worker 里的 `/tmp/heyagent-sandbox` 是空的；总结里写了两个交付路径。界面（Vite 5182 → API 3120，暗色）的截图：运行详情里展开的两个「运行代码」步骤（语言、代码、退出码徽章、写回 / 访问说明、stdout）和「空间文件」弹窗（路径、来源「agent 写的」、「覆盖过」）。

联调发现并修了：

1. **「访问了」漏记**：Python requests 的 HTTPS 隧道是 keep-alive，沙箱退出、隧道关掉时才记主机，而 `code.run` 在那之前就取了代理的报告。改成放行时就记下主机（字节数关闭时再加），并且先关代理再取报告（`proxy.ts`、`code-run.ts`；单元测试加了「隧道还开着时报告里已经有主机」）。
2. **同样大小的改动可能被当成没改**（单元测试偶发失败暴露的）：内核的文件时间戳是粗粒度的，我们刚写进 workspace 的文件如果在同一个刻度里被改成同样大小，stat 指纹不变。现在写进去后把修改时间设成这个文件在空间里的更新时间（`ls -l` 也看得懂），之后任何改动修改时间都会变（`workspace.ts`）。正常用不会碰到（沙箱启动就要几十毫秒），属于加固。
3. 测试里的时序：运行状态在 `runSession` 里就变成 done，删目录在任务收尾时做，两个测试改成等目录被删（`space.test.ts`、`sandbox-it.test.ts`）。

修完后：space-unit 15 个、space 5 个通过；真沙箱集成测试在新镜像里重跑通过；server build、lint 通过。

联调时的环境说明：worker 容器用了 `--userns=keep-id`（宿主上的 API 要能读 worker 写的文件，文件权限是 0600），这时 `ulimit -u` 按宿主用户计数（开发机上这个用户有约 1400 个线程，超过默认的 1024），所以这次给 worker 设了 `HEYAGENT_SANDBOX_MAX_PROCESSES=8192`。pod 里 worker 是自己的 uid，不受影响。
