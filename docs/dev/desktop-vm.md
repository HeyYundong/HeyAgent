# 系统开的桌面：HeyAgent 自己开 Windows 虚拟机（开发说明）

2026-10-23 用户确认（方案一）：运营不会装 Windows，HeyAgent 要能自己开桌面。运营只做两件事：「新建桌面」、在远程画面里扫码登录软件。
新建时**让人选存在哪块盘，标出 SSD / HDD**（机械盘上 Windows 很慢）。正式机器 32 核 128G，盘是 HDD，会另分一块 SSD。
建立在已经上线的「桌面」（`docs/dev/desktop.md`）之上：agent 一侧（desktop.* 工具、占用、转人工、远程画面）**不改**，只是桌面多了一种来源。

## 0. 三种桌面（`desktops.kind`）

| kind | 是什么 | 谁建 | 地址和密钥 |
|---|---|---|---|
| `manual` | 原来那种：手动登记的电脑（实体机、别处的虚拟机） | 管理员 | 人填 |
| `template` | 模板：系统自动装 Windows + 两个服务，管理员在画面里装好常用软件，点「做成模板」后关机、只读 | 管理员 | 系统管 |
| `vm` | 系统开的桌面：从做好的模板复制（qcow2 写时复制） | 所有人（`desktop.create`），建的人能开关、重置、删除（`desktop.manage`），管理员都能 | 系统管 |

- 模板也是一行 `desktops`（kind `template`），这样装软件时的远程画面、测试连接直接复用。**模板不出现在任务的「能用哪些桌面」里，agent 也分不到它**（分配、快照、`desktop.use` 都要排除 `template`；`vm` 只有 `running` 时才分得到，关着的分配时跳过，指定的那台关着就报错「桌面关着」）。
- 代码里不出现任何具体软件名；装什么软件是管理员在模板里自己装的。

## 1. 底层：Podman API + dockurr/windows

- 每台虚拟机（模板或桌面）是一个 Podman 容器，镜像 `docker.io/dockurr/windows`（**锁 digest**，见 `apps/server/src/desktop/vm/config.ts` 的 `DOCKUR_IMAGE`：`sha256:16fd7c39…`，tag 6.06），里面是 QEMU。
- 服务器用 **Podman 的 REST API**（libpod v3，unix socket，`HEYAGENT_PODMAN_SOCKET`）建、开、关、删容器，不调 podman 命令行（pod 里没有）。开发机实测（Podman 3.4.4）：
  - 建容器要带 `devices: [{path: "/dev/kvm"}]`、`devices` 加 `/dev/net/tun`、`cap_add: ["NET_ADMIN"]`，并且 **`annotations: {"run.oci.keep_original_groups": "1"}`**（API 上 `groupadd: ["keep-groups"]` 不生效，实测容器里打不开 /dev/kvm；加这个注解就行）；
  - 网络 `netns: {nsmode: "slirp4netns"}` + `network_options: {slirp4netns: ["port_handler=slirp4netns"]}`（rootlessport 在 sg kvm 下起不来）；
  - 端口：容器的 8000（Windows-MCP）、8001（桌面服务）映射到本机 `HEYAGENT_DESKTOP_BIND`（默认 127.0.0.1）上从 `HEYAGENT_DESKTOP_PORT_RANGE`（默认 42000-42999）分配的两个端口，记在库里；dockur 的 `USER_PORTS=8000,8001`；
    - **被占会自动换**（2026-10-29，`apps/server/src/desktop/vm/ports.ts`）：默认段落在 Linux 给对外连接临时分配的端口段（32768–60999）里，开机时可能正好有一条对外连接占着要用的端口。worker 开机前先在 `HEYAGENT_DESKTOP_BIND` 上试着 listen 这台的两个端口，`EADDRINUSE` 的换成端口段里空着的（避开别的虚拟机分到的、这次已经知道被占的）；Podman 开机时报端口被占（开发机 Podman 3.4.4 实测 slirp4netns 端口转发报 `error from slirp4netns while setting up port redirection: map[desc:bad request: add_hostfwd: slirp_add_hostfwd failed]`，rootlessport 报 `address already in use`）两个都换。端口是建容器时定的，换了要删掉容器按新端口重建（盘、状态文件都在目录里）。库里的 `mcp_port` / `agent_port` 和 `desktops.mcp_url` / `agent_url` 一起改，远程画面、agent、测试连接都跟着用新的；记审计 `desktop.vm.ports`（没有操作人，`from` / `to` / `reason`）和 worker 日志「换端口：…」。最多开 5 次，都不行记出错「端口都被占了：…」；端口段里没有空着的也记出错。worker 在 pod 里时 pod 有自己的网络，开机前试不出宿主机上的占用，就靠 Podman 报错再换。同时修了 `reconcileVm` 里 `ensureRunning` / `ensureStopped` 没有 await 的问题：原来开机、关机这一步抛的错进不了 catch，不记出错，任务失败后 pg-boss 隔 10 秒重试；
  - 开发机：`sg kvm -c "podman system service --time=0 unix:///run/user/1000/heyagent-podman.sock"`（kvm 组是后加的，systemd 起的 socket 没有这个组）；正式机器上用户重新登录后直接 `systemctl --user enable --now podman.socket`。
- 服务器连虚拟机的地址：`HEYAGENT_DESKTOP_VM_HOST`（默认 127.0.0.1）。pod 里跑时 worker / api 在 pod 的网络里，要连宿主机的端口：rootless pod 用 slirp4netns 的 `allow_host_loopback=true` 后宿主机是 `10.0.2.2`（部署时确认并写进 pod.yaml / ops.md）。
- **磁盘**：每台一个目录 `<存放位置>/heyagent-desktops/<desktopId>/`，挂进容器的 `/storage`，dockur 用 `DISK_FMT=qcow2`。
  - 模板：dockur 全自动装（`VERSION=11`、`LANGUAGE=Chinese`、`REGION=zh-CN`、`KEYBOARD=zh-CN`、`DISK_SIZE`、`RAM_SIZE`、`CPU_CORES`、`USERNAME` / `PASSWORD` 系统生成存密文），OEM 目录挂到 `/oem`，里面是 Python 3.14 安装包（固定版本 + sha256，worker 下载并校验，缓存在 `<存放位置>/heyagent-desktops/cache/`）、本仓库的 `apps/desktop-agent`（含 install.ps1）、`install.bat`（调 install.ps1 -KeyFile，密钥文件是这次生成的模板密钥）。
  - 做成模板（seal）：正常关机（`podman stop -t 120`，dockur 会让 Windows 关机）→ 删容器 → 磁盘文件改只读（chmod 444）→ state `ready`。
  - 新桌面：在新目录里用 `qemu-img create -f qcow2 -b <模板磁盘绝对路径> -F qcow2 data.qcow2`（用 dockur 镜像里的 qemu-img：起一个一次性容器，`entrypoint: ["qemu-img"]`，挂两个目录，**容器里的路径和宿主机路径一样**，这样 backing file 的绝对路径在桌面的容器里也对），再把 dockur 识别「已经装好」需要的文件（`windows.base` / `windows.ver` / `windows.vars` / `windows.rom` 等，以 dockur 6.06 的 `/run/*.sh` 为准）从模板目录复制过来；MAC 地址每台不同（`windows.mac` 不复制，或者生成新的）。模板目录要同时挂进桌面的容器（只读，同路径）。
  - 重置（reset）：关机 → 删 overlay → 重新 `qemu-img create` → 开机。软件的登录会没掉，页面要二次确认说清楚。
- **密钥**：模板生成一个随机密钥（只存密文），装进模板；从这个模板建的桌面共用它（端口只开在本机）。`desktops.key_secret_id` 指向它，`mcp_url` / `agent_url` 由系统按端口填（`http://<VM_HOST>:<port>/mcp`、`http://<VM_HOST>:<port>`）。
- **开机就绪**：容器跑起来后每 5 秒查桌面服务 `/health`，通了就 `running`（模板第一次通了是 `setup`）；模板装 Windows 期间是 `installing`，页面显示已经装了多久（SSD 估计 1 小时左右，HDD 实测约 3 小时）。超时（模板 8 小时、桌面 20 分钟）记 `error`。
- **对账**（worker，每 30 秒，`HEYAGENT_DESKTOP_VM_SWEEP_MS`）：按 Podman 实际状态更正库里的状态（容器没了、退出了）；`desired = running` 但没在跑的（比如宿主机重启过）自动开机；开着的检查 `/health`。

## 2. 存放位置

- 只能从 `HEYAGENT_DESKTOP_STORAGE_ROOTS`（逗号分隔的绝对路径，部署时配置，worker / api 容器里**同路径**挂进去）里选，不接受页面传任意路径。
- 每个位置：`statfs` 算剩余 / 总空间；SSD / HDD：`stat(path).dev` → major:minor → `/sys/dev/block/<maj>:<min>/queue/rotational`（分区没有 queue 就看上一级），`0` = SSD、`1` = HDD，读不到 = `unknown`。管理员可以在设置里手动标（`desktop.storage` 设置：`desktopStorageSettingsSchema`，`kindOverrides`）。
- 剩余空间小于 `DESKTOP_MIN_FREE_GB`（40）的不能选（`problem`）；目录不存在、不能写也写进 `problem`。
- 默认位置：设置里选；没选 = 第一个 SSD，没有 SSD 就第一个能用的。
- 页面：每个位置一行「路径 · SSD / HDD / 看不出来 · 剩 N GB」，SSD 标「推荐」，HDD 标「机械硬盘，Windows 会很慢」。

## 3. 资源检查

- 本机内存、CPU 从 `/proc/meminfo`、`os.cpus()` 读（pod 里读到的是宿主机的）。开机（新建、模板、start、restart）前检查：开着的虚拟机内存合计 + 这台 ≤ 本机内存 − `HEYAGENT_DESKTOP_RESERVED_GB`（默认 24）。不够就报错「本机内存不够了：开着 N 台共 X GB，再开要 Y GB，先关掉不用的桌面」。
- `desktopHostSchema`：给页面显示和判断「能不能开虚拟机」（Podman socket 连不上 / 没有 KVM → `available: false`，页面只给「登记已有电脑」）。

## 4. 数据（迁移 0030）

- `desktops` 加 `kind`（text，默认 `manual`，check）、`created_by_id`（引用 users，set null）。
- 新表 `desktop_vms`（一台桌面 / 模板一行，`desktop_id` 主键，删桌面级联）：`template_id`（引用 desktops，restrict：模板有桌面在用就删不了）、`storage_path`、`dir`、`container`、`state`、`desired`（running / stopped）、`message`、`state_since`、`memory_gb`、`cpus`、`disk_gb`、`mcp_port`、`agent_port`（两个端口唯一）、`vm_password_secret_id`、`created_at`、`updated_at`。触发器 `heyagent_notify_change('desktop_id')`，`live.ts` 映射到 `desktops.list`、`desktops.host`。
- 设置 `desktop.storage`（`desktopStorageSettingsSchema`）。

## 5. 接口（tRPC，加在 `desktops` 下）

- `desktops.host()` → `DesktopHost`（所有人能看）。
- `desktops.createTemplate(desktopTemplateCreateSchema)` → `{ id }`（config.manage）。
- `desktops.createVm(desktopVmCreateSchema)` → `{ id }`（desktop.create；模板必须是 ready）。
- `desktops.vmAction(desktopVmActionSchema)` → void：start / stop / restart / reset（vm）；seal（template，setup 状态才行）。权限：vm 用 `desktop.manage`（建的人）或管理员，template 用 config.manage。被运行占着时不带 `force` 报 CONFLICT「正被运行用着」；带 `force` 先放开占用（`forceReleaseDesktop`）再做。
- `desktops.delete` 扩展：vm / template 要关机、删容器、删目录；模板有桌面在用不让删；vm 建的人也能删。
- `desktops.setStorageSettings(desktopStorageSettingsSchema)`（config.manage）。
- `desktops.update` 对 vm / template 只能改名字和说明（地址、密钥不让改）。
- 操作写审计。所有虚拟机操作是异步的：接口改 `desired` / 状态后立即返回，worker 去做（pg-boss 任务或 worker 定时器都行，保证同一台同时只有一个操作在做），页面看实时推送的状态。

## 6. 页面

- 「桌面」页右上角主按钮「新建桌面」（`desktop.create`）：名字、说明（给 agent 看）、模板（只列 ready 的；没有模板时说「还没有模板，请主管先做一个」）、存在哪里（列 storages，带 SSD / HDD 和剩余空间，默认选中默认位置，HDD 有提示，不能用的置灰写原因）、「更多」里内存、CPU（默认用模板的）。没有可用模板或本机不能开虚拟机时按钮置灰并说原因。次要入口「登记已有电脑」（原来的弹窗，管理员）。
- 列表分组：桌面（vm + manual）、模板（template，管理员才看到「做模板」按钮）。每行带状态徽章（开着 / 关着 / 开机中 / 装 Windows 中 / 出错…）。
- 详情：vm / template 显示「这台虚拟机」区块（状态、存在哪里 + SSD/HDD、内存、CPU、磁盘占用、从哪个模板建的），按钮：开机、关机、重启、重置（AlertDialog destructive：「软件的登录会没掉，要重新扫码」）、删除（AlertDialog destructive）。「看画面」只在开着时能点。连接区块对 vm / template 不显示地址和密钥（系统管）。
- 模板详情：installing 时显示「正在自动安装 Windows，已经 N 分钟（SSD 约 1 小时）」；setup 时显示步骤「打开画面，把要用的软件装好（不要登录账号）→ 点『做成模板』」；ready 时显示「有 N 台桌面用它」。
- 设置页加「桌面存放位置」：列 storages，可以选默认、手动标 SSD / HDD；显示本机内存、开着的虚拟机。
- 使用手册 `docs/guide.md` 5.13 改写：运营怎么新建桌面、扫码登录；主管怎么做模板、选存放位置。ui-rules §8 登记新组合。

## 7. 部署（`docs/ops.md` 第 14 节改写；实际做法见第 12 节）

- 宿主机：KVM、用户在 kvm 组、`podman.socket` 开着；SSD 挂载并写进 `HEYAGENT_DESKTOP_STORAGE_ROOTS`（HDD 也可以写进去，页面会标出来）。
- pod：worker（和 api，api 要读 host 信息就也挂）挂 Podman socket 和各存放位置（同路径），`HEYAGENT_DESKTOP_VM_HOST` 指向宿主机；worker 镜像带上 `apps/desktop-agent`（做模板时放进 OEM 目录）。
- 第一次：主管在「桌面」页做模板，等装好，装软件，做成模板。之后运营自己新建桌面。

## 8. 分包

| 包 | 内容 |
|---|---|
| V 后端 | 第 1～5 节：迁移 0030、Podman 客户端、存放位置识别、资源检查、模板 / 桌面的生命周期和对账、OEM 目录、tRPC、权限、分配排除模板和关着的、测试（假的 Podman API + 假的桌面服务）；开发机上用真 Podman 实测（见第 9 节） |
| W 前端 | 第 6 节 |
| O 部署 | 第 7 节：pod.yaml、worker 镜像、ops.md、guide；在开发机上真装一次模板（HDD 上约 2 小时，后台跑） |

## 9. 开发机实测（V）

- 开发机只有 HDD（`/mnt/toshiba`），装一次 Windows 要 2 小时。为了测「从模板建桌面」，可以把验证用虚拟机的磁盘（`/mnt/toshiba/heyagent-spike/storage/data.img`，已装好 Windows + 两个服务，密钥在 `/mnt/toshiba/heyagent-spike/mcp_key`）转成 qcow2 当一个现成的模板（写一个开发用的导入脚本，**不进产品**；转换用 dockur 镜像里的 qemu-img；原文件不要动）。
- 存放位置用 `/mnt/toshiba/heyagent-desktops-dev`（HDD，页面应该标 HDD）。
- 端口别和验证用虚拟机（18000/18001/12222/18006）冲突；验证用虚拟机现在关着，不要开它。

## 10. 实现时和上面不一样的地方（包 V，2026-10-23）

- **代码位置**：`apps/server/src/desktop/vm/`：`config.ts`（环境变量）、`podman.ts`（libpod REST 客户端，unix socket）、`storage.ts`（存放位置、SSD / HDD）、`host.ts`（内存、能不能开虚拟机）、`oem.ts`（OEM 目录）、`lifecycle.ts`（worker：一步步往目标走、健康检查、对账）、`service.ts`（接口一侧）。worker 里 pg-boss 队列 `desktop.vm`（stately，`singletonKey` = 桌面 id）保证同一台同时只有一个操作；对账每 30 秒把要动的排进这个队列，开机中 / 装 Windows 中的每 5 秒查一次 `/health`。
- **`desktop_vms` 多两列**：`op`（等着做的一次性操作：`restart` / `reset` / `seal` / `delete`，做完清掉；开机、关机只改 `desired`）、`installed_at`（模板第一次连上桌面服务的时间：之后再开机是「开机中」不是「装 Windows 中」，没有它不能做成模板）。
- **模板在做好之前也能开机、关机、重启**（主管）：装软件常要重启。`seal` 除了 `setup`，装好后关着的（`stopped` 且有 `installed_at`）也行。做好的（`ready`）只接受 `stop`（什么也不做）。
- **出错（`error`）的不自动重来**，等人点任何一个操作（开机会先把状态当成 `stopped`，worker 按 Podman 实际状态重新来）。刚开的机又退出了（容器开起来后马上退出，例如 KVM 打不开）记 `error`，`message` 带容器的退出码和最后几行日志（dockur 的日志是英文原文）；不自动重开，免得一直重开。开着（`running` 时）的容器退出了（宿主机重启过）照常自动开。开着但 `/health` 不通只写 `message`「桌面服务连不上：…」，不改状态。
- **删除**：关机只等 30 秒（盘马上要删，不用等 Windows 正常关机）然后强制删容器、删目录、删行（模板连同 `key` / `vmPassword` 两个密钥）。删不成功留在 `deleting`，下一轮对账再试。
- **从模板建的桌面**：`desktops.key_secret_id`、`desktop_vms.vm_password_secret_id` 都指向模板的密钥（模板有桌面在用删不了，所以不会悬空）。
- **OEM 目录**放在模板目录下 `oem/`，只读挂到 `/oem`；做成模板时整个删掉（里面有密钥文件）。Python 安装包缓存在 `<存放位置>/heyagent-desktops/cache/`。
- **容器名** `heyagent-<桌面 id>`，带标签 `heyagent.desktop` / `heyagent.kind`。一次性的 qemu-img 容器是 `heyagent-<桌面 id>-qemu-img`，`netns: none`，跑完就删。dockur 镜像本机没有时 worker 先拉（锁 digest）。
- **状态文件**：复制模板目录里 `windows.*` 的小文件（不超过 64 MB），不复制 `windows.mac` 和 `*.iso`。重置时 `windows.mac` 留着（同一台 MAC 不变）。dockur 6.06 认「已经装好」靠 `windows.base`（要和 `VERSION=11`、`LANGUAGE=Chinese` 算出来的 `win11x64_zh.iso` 一样）+ `windows.boot` + 盘里有数据；所以所有虚拟机的 `VERSION` / `LANGUAGE` 都写死成这两个。
- **开机就绪要两个服务都起来**：第 1 节只说查桌面服务 `/health`；开发机（机械盘）实测桌面服务通了以后 Windows-MCP 还要 4～6 分钟才起来，这期间分给运行的话 agent 只会碰到「Windows-MCP 连不上」。所以 starting / installing 时 `/health` 通了还要 Windows-MCP 的地址回 HTTP（不带密钥 GET，正常是 401）才算 running / setup。开着以后的对账只查 `/health`。
- **开机超时改成 20 分钟**（第 1 节写 10 分钟）：开发机机械盘上实测从开机到两个服务都起来 7～12 分钟（见第 11 节），10 分钟会误报出错。模板装 Windows 2026-10-23 实测机械盘 3 小时，改成 8 小时。
- **`desktops.test`**：系统开的桌面建的人也能测（地址是系统填的）。**远程画面**：系统开的桌面建的人能看能操作（新建后要扫码登录软件），模板只有主管（同手动登记的）。
- **多出来的环境变量**（都有默认值）：`HEYAGENT_DESKTOP_VM_HEALTH_MS`（5000）、`HEYAGENT_DESKTOP_VM_START_TIMEOUT_MS`（20 分钟）、`HEYAGENT_DESKTOP_VM_INSTALL_TIMEOUT_MS`（8 小时）、`HEYAGENT_DESKTOP_VM_STOP_SECONDS`（120）、`HEYAGENT_DESKTOP_MIN_FREE_GB`（40）、`HEYAGENT_DESKTOP_KVM_DEVICE`（`/dev/kvm`，**设成空串 = 不检查**：pod 里的 API 看不到宿主机的 /dev，要么把 /dev/kvm 挂进去，要么设空串，包 O 定）、`HEYAGENT_DESKTOP_SYS_ROOT` / `HEYAGENT_DESKTOP_PROC_ROOT`（测试用）、`HEYAGENT_DESKTOP_AGENT_DIR`（默认仓库里的 `apps/desktop-agent`，worker 镜像要带上）、`HEYAGENT_DESKTOP_PYTHON_URL` / `HEYAGENT_DESKTOP_PYTHON_SHA256`（换内网镜像时两个一起改）、`HEYAGENT_DESKTOP_IMAGE`。
- **空间单位**：`freeGb` / `totalGb` / `diskUsedGb` 按 GiB（1024³）算。
- **开发用导入脚本**（不是产品功能）：`apps/server/src/scripts/dev-import-desktop-template.ts`，把一块装好的磁盘（raw / qcow2，只读挂进去）用 qemu-img 转成 qcow2，登记成一个 `ready` 的模板。

## 11. 开发机实测（包 V，2026-10-23）

开发机：28 核、31 GB 内存、Podman 3.4.4（API 用已经开着的 `sg kvm -c "podman system service …"`），存放位置 `/mnt/toshiba/heyagent-desktops-dev`（机械盘）。API（3124）和 worker 是本分支的代码，通过 tRPC 操作（`HEYAGENT_DESKTOP_RESERVED_GB=12`）。

- `desktops.host`：`available: true`、内存 31.2 GB、28 核；存放位置自动认成 `hdd`、剩 2966 GB、是默认位置。
- 导入脚本把验证用虚拟机的 `data.img`（raw 64 GB，用了约 21 GB）转成 qcow2 模板：827 秒；原文件没动。
- 从模板建两台（各 4 GB / 4 核）：建好容器、开机 2 秒内；dockur 直接「Booting Windows」（没有重装），MAC 和模板不同；两台都在开机后约 6 分 45 秒桌面服务通了，Windows-MCP 又过了约 6 分钟才起来（之后加了「两个服务都起来才算 running」）。`desktops.test` 两台都通（MCP 21 个工具，桌面服务 1280×800）。两台的盘各 125 / 130 MB（模板 21 GB）。
- 关机：约 100 秒（Windows 正常关机，容器退出码 143）。开机：685 秒到 running（两个服务都起来）。重置：关机约 98 秒 → 重建盘（MAC 不变）→ 511 秒到 running，测试连接通。删除：33 秒（容器、目录都没了）。最后删了模板（连同两个密钥、目录）。

## 12. 部署（包 O，2026-10-23）

运维步骤见 `docs/ops.md` 第 14 节。决定和原因（在开发机 Podman 3.4.4 上用一次性的 pod 和容器实测过）：

- **开关**：只看 `HEYAGENT_DESKTOP_STORAGE_ROOTS`。空 = pod 和以前完全一样（`deploy/pod.yaml`、`deploy/quadlet/heyagent.yaml` 里只多三行占位注释），`HEYAGENT_PODMAN_SOCKET` 没配，「桌面」页只能登记已有电脑。不空时 `scripts/pod.sh`（环境变量）/ `scripts/server-install.sh`（`heyagent.env`）用 `scripts/desktop-host.sh` 的函数把占位注释换成挂载、给 configmap 加配置、换 pod 的网络；正式服务器装的时候先跑 `desktop_setup`（检查不过就停）。
- **Podman API socket**：挂 socket 所在的**目录**（宿主机 `$XDG_RUNTIME_DIR/podman` → 容器 `/run/heyagent-podman`，api 和 worker 都挂：api 的 `desktops.host` 要 ping）。挂文件的话 podman.socket 重启后容器里还是旧文件。pod 里的 uid 1000 是宿主机的子 uid，0600 / 0660 的 socket 连不上（实测 EACCES），所以 podman.socket 加 drop-in `SocketMode=0666`；`/run/user/<uid>` 是 0700，宿主机上别的用户进不去。
- **连虚拟机**：pod 用 `slirp4netns:allow_host_loopback=true`（3.4.4 的 `podman play kube --network` 认这个写法，hostPort 8080 照样能用；Quadlet 是 `[Kube] Network=`），`HEYAGENT_DESKTOP_VM_HOST=10.0.2.2`，虚拟机端口照旧只绑宿主机 127.0.0.1。实测 pod 里 `http://10.0.2.2:<端口>` 连到宿主机上用 slirp4netns 端口转发绑在 127.0.0.1 的容器。
- **KVM 检查**：容器里没有 `/dev/kvm`，`HEYAGENT_DESKTOP_KVM_DEVICE=""`（api 不查）。改成装的时候查：`desktop-host.sh check` 经那个 socket 起一个一次性容器（`--device /dev/kvm` + `run.oci.keep_original_groups=1`，和 worker 建虚拟机的写法一样），看里面能不能读写 /dev/kvm；还查 systemd 用户实例（podman.socket 由它起）有没有 kvm 组。两种情况都实测过（`sg kvm` 起的服务能用，不带 kvm 组的服务报错）。
- **认 SSD / HDD**：Podman 默认把容器里的 `/sys/dev/block` 盖成空的 tmpfs（实测），认不出来；宿主机 `/sys` 只读挂到 api 的 `/host/sys`，`HEYAGENT_DESKTOP_SYS_ROOT=/host/sys`（实测能读到 `queue/rotational`）。`/proc/meminfo` 在容器里就是宿主机的。
- **存放位置**：同路径挂进 api 和 worker，属主要是容器里的 uid 1000（`podman unshare chown 1000:1000`），worker 才能建目录。
- **worker 没有权限改 dockur 建的文件**（实测）：worker 在 pod 里是 uid 1000、`drop: ALL`，dockur / qemu-img 容器里的 root（宿主机上是运行 Podman 的用户）建的文件它 `chmod` 不了（EPERM），dockur 建的子目录（`tmp/`）里的东西删不掉（EACCES）。所以 `lifecycle.ts` 的 `makeReadOnly`（做成模板时盘改只读）、`removeDir`（删桌面、删模板）遇到这两种错时交给一次性容器（dockur 镜像，`netns none`，同路径挂这台的目录）做 `chmod 0444` / `find <目录> -mindepth 1 -delete`。直接跑在宿主机上（开发机）时用不到。
- **安装镜像**：dockur 装完把 `win11x64_zh.iso`（8.5 GB）留在模板目录里，做成模板时删掉（模板不再开机，桌面不复制 .iso）。
- **worker 镜像**带 `apps/desktop-agent`（`/opt/heyagent/desktop-agent`，`HEYAGENT_DESKTOP_AGENT_DIR`），放在最后一层，不到 200 KB。
- **`scripts/desktop-vm.sh` 删掉了**：它手动起一台虚拟机（自己的 OEM 目录、锁的镜像和 Python 版本），现在做模板时 worker 做同样的事，留着就有两份要一起改的东西；实体机照旧手动跑 `install.ps1`。
- 开发机上要试整套 pod 里的虚拟机：`sg kvm -c "podman system service --time=0 unix:///run/user/1000/heyagent-podman/podman.sock"`（单独一个目录，0755），`chmod 666` 那个 socket，再 `HEYAGENT_HOST_PODMAN_SOCKET=/run/user/1000/heyagent-podman/podman.sock HEYAGENT_DESKTOP_STORAGE_ROOTS=<目录> scripts/pod.sh up`。

## 13. 开发机实测：从头做模板（包 O，2026-10-23）

开发机同第 11 节（机械盘 `/mnt/toshiba/heyagent-desktops-dev`）。独立的 API（3126）+ worker、独立的库 `heyagent_dvm_e2e`，全部经 tRPC 操作，没有手工干预 Windows（中间只用 QEMU monitor 截过屏、读过安装日志）。

| 步骤 | 用时 |
|---|---|
| `createTemplate`（6 GB、4 核、64 GB）→ 容器开机（下载 Python 安装包、准备 OEM 目录） | 20 秒 |
| dockur 从微软下载 Windows 11 中文版（8.5 GB） | 20 分钟 |
| 装 Windows（两次重启）到第一次自动登录 | 2 小时 10 分 |
| install.bat：装 Python 3.14.8 | 11 分 24 秒 |
| install.ps1：pip 装 Windows-MCP 0.8.8 和桌面服务、计划任务、等两个服务起来 | 20 分 51 秒 |
| **合计：点「做模板」→ `setup`** | **3 小时 2 分 38 秒** |
| `seal` → `ready`（Windows 正常关机、删容器、盘改只读、删 OEM 和安装镜像） | 1 分 42 秒 |
| `createVm`（4 GB、4 核）→ `running`（两个服务都起来），宿主机上跑的 worker | 10 分 36 秒 |
| 同上，api + worker 在 pod 里（本分支的镜像，第 12 节的挂载和网络） | 9 分 52 秒 |
| 删除桌面（两次） | 41 秒 |

- `setup` 时 `desktops.test`：MCP 21 个工具，桌面服务 1280×800。两台桌面 `running` 后 `desktops.test` 都通，经 API 的 `/api/desktop/view/<id>` 收到了画面帧（1280×800 JPEG，第一帧 1.7～3.7 秒）。
- 盘：模板 `data.qcow2` 实际占 12 GB（文件 14.6 GB）；dockur 装完把 8.5 GB 的安装镜像留在目录里，做成模板时删掉了（新加的）；`windows.boot` 是关机时 dockur 才写的。新桌面开机前 7 MB、`running` 时 255～340 MB。新桌面没有重装，直接「Booting Windows」，MAC 和模板不同。
- pod 里那次：`desktops.host` 的 `available: true`、经 `/host/sys` 认出 HDD；`/mnt/toshiba/heyagent-desktops-dev`（归宿主机用户）显示「没有写权限」，归容器 uid 1000 的第二个位置能用；地址自动换成 `10.0.2.2:<端口>`。在 pod 的 worker 里直接调 `makeReadOnly` / `removeDir`：普通 `chmod` EPERM、`rm` EACCES，走一次性容器后改成了 0444、目录删掉了。
- 新桌面里 Windows 的时钟刚开机时是 UTC（比模板里慢 8 小时），要等 Windows 自己对时。没细查（dockur 的 RTC 设置）。
- 模板 `dk-template`（「实测模板」，ready）留着给用户试：目录 `/mnt/toshiba/heyagent-desktops-dev/heyagent-desktops/dk-template/`，记录在库 `heyagent_dvm_e2e` 里（管理员 admin@heyagent.local，密码在 worktree 的 `.dev/dvm-e2e/admin-password`）。
