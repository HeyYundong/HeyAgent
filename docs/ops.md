# HeyAgent 运维说明

给管理员看的：怎么装、怎么升级、怎么备份恢复、出了问题看哪里。

## 目录

1. 服务器要求
2. 第一次安装
3. 设置管理员
4. 建同事的账号
5. 配 OpenRouter、换 key
6. 升级
7. 备份
8. 恢复
9. 主密钥轮换
10. 看日志
11. 常见问题
12. 安全提醒
13. 东西都在哪
14. 桌面（给 agent 用的 Windows 电脑）

---

## 1. 服务器要求

| 项 | 要求 |
|---|---|
| 系统 | Ubuntu 24.04（自带 Podman 4.9）。别的 Linux 也行，Podman 要 4.4 以上 |
| 配置 | 建议 4 核、8 GB 内存、50 GB 磁盘以上（还没在正式负载下量过）。浏览器开得多就要更多内存 |
| 软件 | `sudo apt install podman uidmap slirp4netns git curl`。不用装 Docker、Node、PostgreSQL、Chrome，全在容器里 |
| 用户 | 建一个普通用户专门跑它（下面都叫 `heyagent`），**不要用 root** |
| 网络 | 能访问外网（OpenRouter、要打开的网站、第一次构建时下载依赖）。只在内网开放端口，见第 12 节 |

管理员要先做的（需要 sudo，只做一次）：

```bash
sudo adduser heyagent
sudo loginctl enable-linger heyagent   # 没人登录时服务也在跑，开机自启
```

之后都用 `heyagent` 这个用户**直接登录**（ssh）来操作。不要 `sudo su heyagent`：那样连不上 systemd 的用户实例，`systemctl --user` 会报错。

## 2. 第一次安装

```bash
git clone <仓库地址> ~/heyagent
cd ~/heyagent
scripts/server-install.sh
```

脚本依次做：检查 Podman 版本 → 构建镜像（第一次要下载 Chrome、Node 和全部依赖，时间比较长）→ 创建密钥 → 建数据卷 → 装好服务和备份定时器 → 启动 → 等健康检查通过。

中途会问两件事：

1. **OpenRouter 的 key**：粘贴后回车，不回显。可以留空，以后在控制台里加。也可以先把 key 写进一个文件，用 `HEYAGENT_OPENROUTER_KEY_FILE=<文件> scripts/server-install.sh`，装完删掉这个文件。
2. **主密钥**：脚本自动生成，另存一份在 `~/.config/heyagent/kek-BACKUP-THEN-DELETE`。**马上拷到两处离线的地方**（例如两个 U 盘，你和另一位管理员各保管一份），然后删掉服务器上这份：
   ```bash
   shred -u ~/.config/heyagent/kek-BACKUP-THEN-DELETE
   ```
   主密钥能解开库里所有的密钥和浏览器登录态。丢了就只能全部重新录入；备份里**不含**主密钥。

装好后：

- 地址是 `http://<服务器内网 IP>:8080`，开机自启，挂了自动重启，每天凌晨 3 点自动备份。
- 端口、对外地址、备份目录在 `~/.config/heyagent/heyagent.env`，改完再跑一次 `scripts/server-install.sh` 生效。脚本可以重复跑，已有的密钥、数据都不动。

**用 80 端口**：普通用户不能占 1024 以下的端口。要用 80，管理员执行一次：

```bash
echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/90-heyagent.conf
sudo sysctl --system
```

再把 `heyagent.env` 里的 `HEYAGENT_PORT` 改成 80，`HEYAGENT_PUBLIC_URL` 去掉端口（或留空让脚本自己算），重跑安装脚本。

## 3. 设置管理员

管理员不预先建，也没有默认账号和密码。装好后第一次打开控制台，看到的是「设置管理员」页：

1. 填管理员的名字、邮箱（登录用，建好后不能改）和密码（至少 8 位，输两次）。
2. 点「建好并登录」，直接进控制台。之后再打开就是登录页，这一页不会再出现。

还没设置时，谁先打开控制台谁就能当管理员，所以**装好后马上设置**。要从备份恢复的，直接按第 8 节跑 `restore.sh`，不用先设置。

忘了密码：让另一位主管在「用户」页给你「重置密码」。所有主管都忘了，见第 11 节。

## 4. 建同事的账号

控制台不开放注册，账号只能由主管建：

1. 左边「用户」→「新建用户」，填邮箱、名字、职位、角色和初始密码。
2. 角色：**主管**能改所有配置、管理用户；**员工**能看全部，能管自己负责的任务、处理分给自己的事。
3. 把地址、邮箱、初始密码告诉同事，让他登录后自己「修改密码」。

同事离职：在「用户」页「停用」，他已登录的会话立刻失效。账号不删，历史记录还在。

## 5. 配 OpenRouter、换 key

- **第一次**：安装时填了 key，第一次启动会自动接入 OpenRouter、设好默认模型。没填的话，登录后到「模型」→「添加模型服务」，类型选 OpenRouter，填 key。
- **换 key**：「模型」→ 点 OpenRouter → 编辑，填新 key，保存。保存前会先用新 key 连一次，连不上不会保存。key 加密存在库里，页面上只显示掩码。
- 安装时那份 key 存在 Podman secret `heyagent-openrouter` 里，**只在第一次启动、还没配过 OpenRouter 时用**，之后不会再读它。页面上换了 key 以后，想把服务器上这份旧的也去掉：
  ```bash
  podman secret rm heyagent-openrouter
  HEYAGENT_SKIP_BUILD=1 scripts/server-install.sh   # 问 key 时直接回车，建一个空的
  ```
- 在 OpenRouter 网站上给 key **设花费上限**（例如每月 100 美元）。

## 6. 升级

```bash
cd ~/heyagent
scripts/deploy.sh
```

做的事：`git pull` → **先备份一次** → 构建新镜像（上一版留成 `:previous`）→ 更新服务文件 → 重启（api 启动时自动迁移数据库）→ 健康检查。重启期间大约一两分钟访问不了，挑没人用的时候做。

**升级失败怎么办**（脚本会把下面的命令打出来）：

```bash
scripts/deploy.sh rollback            # 镜像和服务文件退回上一版
git checkout <升级前的提交>            # 代码也退回去
```

数据库的迁移不会跟着退回。迁移一般只加不删，旧版本多半能跑；跑不了就用升级前那次备份恢复（第 8 节，要加 `HEYAGENT_RESTORE_FORCE=1`）。

镜像多了占地方：`podman image prune` 清掉没有标签的旧层（会清掉构建缓存，下次升级慢一些）。

从有「管理员初始密码」的旧版本升级上来的：卷 `heyagent-pod-state` 已经不用了，升级成功后可以 `podman volume rm heyagent-pod-state` 删掉。

## 7. 备份

- **自动**：每天凌晨 3 点（上海时间），关机错过了开机后补一次。
- **手动**：`scripts/backup.sh`。
- **放在哪**：默认 `~/heyagent-backups/<年月日-时分秒>/`，保留 14 天。改 `heyagent.env` 里的 `HEYAGENT_BACKUP_DIR`、`HEYAGENT_BACKUP_KEEP_DAYS`。**建议指到另一块盘或 NAS 的挂载点**，服务器坏了备份还在。
- **里面有**：`db.dump`（数据库）、`files.tar.gz`（截图、产物、附件）、`kek-status.json`（用到了哪几个版本的主密钥和它们的指纹，没有密钥本身）、`manifest.txt`、`SHA256SUMS`。
- **没有主密钥**：主密钥离线保管。备份和主密钥放在一起，备份一泄露，里面的密钥和登录态就全能解开。

看备份有没有成功：

```bash
systemctl --user list-timers heyagent-backup.timer      # 下次什么时候跑
journalctl --user -u heyagent-backup -n 30              # 上次的结果
ls -l ~/heyagent-backups
```

备份脚本退出码 3 表示「数据库和文件备份好了，但主密钥检查没通过」，看那次备份目录里的 `kek-status.err`。

## 8. 恢复

恢复到一套**新装的空环境**（新服务器，或者原服务器重装），需要**同一把主密钥**。

1. 新服务器按第 2 节装好，但安装时导入原来的主密钥，不要生成新的：
   ```bash
   HEYAGENT_KEK_IMPORT=<离线备份的主密钥文件> scripts/server-install.sh
   ```
2. 把备份目录拷到服务器上，恢复：
   ```bash
   scripts/restore.sh ~/heyagent-backups/20261017-030000
   ```
3. 用**原来的**账号密码登录。恢复前在新环境里设置的管理员会被备份覆盖掉。

`restore.sh` 会先核对：备份文件没坏、主密钥能解开这次备份、目标环境是空的（还没设置管理员，或者只有刚设置的那一个；没有任务）。任何一样不对就停下，什么都不改。确实要覆盖一个有数据的环境（例如升级失败回退），加 `HEYAGENT_RESTORE_FORCE=1`。恢复完它会逐行试解密，并打印用户、任务、文件的数量。

**定期演练**：每季度在一台别的机器上恢复一次最新的备份，确认备份和离线主密钥都是好的。

## 9. 主密钥轮换

什么时候换：怀疑主密钥泄露，或者保管它的人离职。轮换只重新包装每条数据的密钥，数据本身不重新加密，几秒钟就完。

```bash
cd ~/heyagent
# 1. 看现状：主密钥有哪几个版本、库里的数据各用哪个版本
podman exec heyagent-api node dist/scripts/kek-rotate.js status

# 2. 生成新的主密钥文件：原来的几把 + 新的一把
(umask 077; podman exec heyagent-api node dist/scripts/kek-rotate.js add-key --stdout > ~/kek-new)

# 3. 把 ~/kek-new 拷到两处离线的地方，替换掉原来的离线备份（新文件里旧的几把都在）

# 4. 换上新的主密钥并重启（会先核对新文件能解开库里所有数据）
HEYAGENT_KEK_IMPORT=~/kek-new HEYAGENT_SKIP_BUILD=1 scripts/server-install.sh

# 5. 把库里的数据都改用新版本
podman exec heyagent-api node dist/scripts/kek-rotate.js rewrap
#    最后一行是「✓ 全部用的是最新的 vN」才算完

# 6. 删掉服务器上的文件
shred -u ~/kek-new
```

**旧的几把什么时候删**：等最近 14 天的备份都是轮换以后做的（也就是轮换后过了 14 天），再删。删之前的备份要靠离线保存的旧密钥才能恢复。删的步骤：

```bash
(umask 077; podman exec heyagent-api node dist/scripts/kek-rotate.js prune --stdout > ~/kek-pruned)
#    库里还有任何数据用着旧版本，它会拒绝
HEYAGENT_KEK_IMPORT=~/kek-pruned HEYAGENT_SKIP_BUILD=1 scripts/server-install.sh
# 离线备份换成 ~/kek-pruned（旧的那份另外留着，用来恢复轮换以前的备份），然后
shred -u ~/kek-pruned
```

如果是怀疑泄露：轮换完还要把库里的各种密钥本身（OpenRouter key、接口的密钥、代理密码）在对应的服务上作废、换新的，并让人重新登录浏览器账号。主密钥轮换只能防「以后」，防不了已经被解开的。

## 10. 看日志

```bash
systemctl --user status heyagent                 # 服务状态
podman ps --pod                                   # 四个容器：heyagent-postgres / -api / -worker / -web
podman logs -f heyagent-api                       # 后端（登录、页面数据、启动时的迁移）
podman logs -f heyagent-worker                    # agent 运行、浏览器
podman logs -f heyagent-postgres                  # 数据库
journalctl --user -u heyagent -n 100              # 服务起停的记录
curl http://127.0.0.1:8080/api/health             # {"ok":true,"db":"ok"} 才正常
```

重启整套：`systemctl --user restart heyagent`。只重启一个容器：`podman restart heyagent-worker`。

## 11. 常见问题

**`systemctl --user` 报 `Failed to connect to bus`**
没有用 `heyagent` 用户直接登录。用 ssh 登录，或者 `sudo machinectl shell heyagent@`。

**重启服务器后服务没起来**
多半是没开 linger：`loginctl show-user heyagent -p Linger` 要是 `yes`。不是的话，管理员执行 `sudo loginctl enable-linger heyagent`。

**页面能打开，但登录提示来源不对（403）**
用的地址不在允许的来源里。把这个地址写进 `heyagent.env` 的 `HEYAGENT_PUBLIC_URL`（同事都用它访问），或者加进 `HEYAGENT_TRUSTED_ORIGINS`（逗号隔开），重跑安装脚本。

**任务里的浏览器打不开，worker 日志里有 sandbox、namespace 的错**
Ubuntu 24.04 默认限制普通程序创建 user namespace，Chrome 的沙箱要用它。管理员执行：

```bash
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/91-heyagent-userns.conf
sudo sysctl --system
systemctl --user restart heyagent
```

**模型调用全部失败**
看「模型」页 OpenRouter 的状态，点「测试连接」。常见原因：key 被停用、余额不足、花费到了上限、服务器连不上外网。

**api 起不来，日志里有「KEK」「解不开」**
主密钥不对（例如恢复时导入错了文件）。用正确的文件重新导入：`HEYAGENT_KEK_IMPORT=<文件> HEYAGENT_SKIP_BUILD=1 scripts/server-install.sh`。

**所有主管都忘了密码**
在服务器上把一位主管的密码重置成新的随机密码：先停服务、备份，然后找开发处理（v1 没有命令行重置工具）。平时至少留两位主管。

**磁盘满了**
看是谁：`du -sh ~/heyagent-backups`、`podman system df`。备份目录指到别的盘；清掉旧镜像层 `podman image prune`。

## 12. 安全提醒

- **装好后马上设置管理员**（第 3 节）：还没设置时，谁先打开控制台谁就是管理员。
- **只在内网开放**。v1 用 HTTP（2026-10-17 定的），账号密码和页面内容在网络上是明文。不要做端口映射到外网，不要放到公网服务器上。推广到更多人或要从外网访问之前，先改成 HTTPS（改 Caddy 配置，代码不用动）。
- **开发时用过的 OpenRouter key 在聊天记录里出现过**。正式用之前，在 OpenRouter 上建一个新 key、设花费上限，在「模型」页换上，旧 key 删掉。
- **主密钥**离线两份、两个人保管，不放在服务器的普通文件里，不放进备份目录，不发聊天工具。
- **备份**也有敏感内容（任务、运行记录、截图），备份目录和 NAS 只给管理员访问。
- 至少两位主管；离职的人当天「停用」。

## 13. 东西都在哪

| 东西 | 位置 |
|---|---|
| 代码 | `~/heyagent`（`git clone` 的地方） |
| 配置（端口、地址、备份目录） | `~/.config/heyagent/heyagent.env` |
| 服务文件（Quadlet） | `~/.config/containers/systemd/heyagent.kube`、`heyagent.yaml`、`heyagent-config.yaml`，由安装脚本生成，不要手改 |
| 备份定时器 | `~/.config/systemd/user/heyagent-backup.service`、`.timer` |
| 密钥 | Podman secret：`heyagent-kek`（主密钥）、`heyagent-db`（数据库密码）、`heyagent-auth`（登录签名密钥）、`heyagent-openrouter`。`podman secret ls` 能看到名字，看不到内容 |
| 数据 | Podman 卷：`heyagent-pod-pgdata`（数据库）、`heyagent-pod-files`（文件）。`podman volume ls` |
| 镜像 | `localhost/heyagent-{api,worker,web}:current`，上一版是 `:previous` |
| 备份 | `~/heyagent-backups/` |

`podman volume ls` 里还会看到和 secret 同名的几个卷（`heyagent-kek` 等）：那是 Podman 把 secret 展开给容器用的，每次启动按 secret 重写，不用管，也不要备份。

## 14. 桌面（给 agent 用的 Windows 电脑）

「桌面」是 agent 干活的第二种环境（第一种是浏览器）：一台 Windows 电脑，agent 通过它操作装在上面的软件（例如聊天软件、办公软件的桌面版）。开发说明见 `docs/dev/desktop.md`。

一台桌面上跑两个服务，用**同一个密钥**：

| 服务 | 端口 | 干什么 |
|---|---|---|
| Windows-MCP 0.8.8 | 8000 | agent 读界面控件、点击、输入 |
| 桌面服务（`apps/desktop-agent`） | 8001 | 控制台的远程画面、截图、传文件 |

两个服务都跑在**自动登录的那个 Windows 用户的桌面会话**里（登录时由计划任务启动，不出窗口）。所以这台电脑要一直开着、那个用户一直登录着，**不要注销、不要锁屏**（安装脚本已经关掉了锁屏、屏保和睡眠）。重启后会自动登录、自动启动两个服务。

可以用服务器上的虚拟机（14.1），也可以用一台实体 Windows 电脑或公司已有虚拟化平台上的 Windows（14.2）。**Windows 的授权由公司自己解决**：虚拟机装的是没激活的 Windows 11，能用，但桌面右下角会有「激活 Windows」水印、个性化设置改不了；正式用请按公司的授权方式激活。

### 14.1 在服务器上起虚拟机

要求：

- CPU 支持虚拟化（有 `/dev/kvm`），当前用户在 `kvm` 组：`sudo usermod -aG kvm heyagent`，然后重新登录；
- 每台虚拟机默认 8 GB 内存、4 核、64 GB 盘，**盘要放 SSD**：机械盘上装 Windows 要 2 小时，平时 agent 读一次界面要十几到几十秒；
- 第一次启动要从微软下载 Windows 11 镜像（约 6 GB），要能上外网。

```bash
# 例：虚拟机盘放在 SSD 的 /ssd/heyagent-desktops 下，端口绑在服务器的内网 IP 上
scripts/desktop-vm.sh up --name heyagent-desktop-1 --storage /ssd/heyagent-desktops/1 --bind 10.0.0.5
scripts/desktop-vm.sh up --help                    # 全部参数：内存、CPU、盘、端口、语言……
scripts/desktop-vm.sh up ... --dry-run             # 只看要执行的 podman 命令
```

脚本做的事：生成密钥（`<storage>/key`）和 Windows 登录密码（`<storage>/vm.env`，平时用不到）→ 下载 Python 3.14 安装包（核对 sha256）→ 准备第一次登录时运行的安装脚本 → 用 Podman 起 `dockurr/windows`（固定版本）。之后虚拟机自己装 Windows、自动登录，再自动装 Python、Windows-MCP 和桌面服务，全程不用管。

- 看安装进度：在服务器上用浏览器打开 `http://127.0.0.1:8006`（dockur 自带的网页屏幕，没有密码，只绑本机；从别的电脑看用 `ssh -L 8006:127.0.0.1:8006 服务器`）。
- 装好了没有：`scripts/desktop-vm.sh status --name heyagent-desktop-1 --storage /ssd/heyagent-desktops/1`，两行都正常就好了。没好看虚拟机里的 `C:\OEM\heyagent-install.log`。
- 关机 / 开机：`scripts/desktop-vm.sh down|up --name …`（关机会给 Windows 2 分钟正常关机）。虚拟机盘一直保留在 `<storage>/disk`，软件、登录状态都在里面，**不要删、不要回滚快照**。
- 服务器重启后自动开机：`podman generate systemd --name heyagent-desktop-1 --files`，把生成的 `.service` 放进 `~/.config/systemd/user/` 后 `systemctl --user enable --now container-heyagent-desktop-1`。
- 一台服务器起几台：换 `--name`、`--storage` 和端口（`--mcp-port 8010 --agent-port 8011 --web-port 8016`）。

**地址要让 HeyAgent 的容器连得到**：容器里的 `127.0.0.1` 是容器自己，所以和 HeyAgent 在同一台服务器上时，`--bind` 填服务器的内网 IP，登记时也填这个 IP。

### 14.2 在实体机（或已有的 Windows 虚拟机）上装

1. 准备一个专用的 Windows 用户，设成**自动登录**（`netplwiz` 取消「要使用本计算机，用户必须输入用户名和密码」，或者用微软的 Sysinternals Autologon）。电脑上别的人别用它，别注销。
2. 装 Python 3.14（python.org 的 Windows 安装包，勾选「Add python.exe to PATH」，选「为所有用户安装」）。
3. 生成密钥（在服务器上 `openssl rand -hex 24`），把仓库里的 `apps/desktop-agent` 整个目录拷到这台电脑上。
4. 用那个用户登录，「以管理员身份运行」PowerShell：

   ```powershell
   cd <拷过来的 desktop-agent 目录>
   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Key <密钥> -AllowFrom <HeyAgent 服务器的 IP>
   ```

   最后显示「装好了」和两个地址就成功了。`-AllowFrom` 让 Windows 防火墙只放行 HeyAgent 服务器；不填就是谁都能连（还是要密钥）。

装好后的东西都在 `C:\HeyAgent`：`key`（密钥，只有这个用户和管理员能读）、`logs\`（两个服务的日志）、`files\`（agent 传过去的文件）。任务计划程序里是 `\HeyAgent\WindowsMCP`、`\HeyAgent\DesktopAgent` 两个任务。

### 14.3 在控制台登记

「桌面」页 → 新建：

- **名字**、**说明**：说明是给 agent 看的，写清楚装了哪些软件、登的哪个账号，agent 按它挑桌面；
- **MCP 地址**：`http://<IP>:8000/mcp`；**桌面服务地址**：`http://<IP>:8001`（虚拟机填 14.1 里映射出来的地址和端口）；
- **密钥**：和安装时的一样。

点「测试连接」，两项都通过才算好。然后在任务里选「桌面」工具、勾上能用哪些桌面。

### 14.4 第一次登录软件

在「桌面」页点「看画面」，在远程画面里打开软件、扫码或输入账号登录（勾上「记住登录」之类的选项）。登录状态存在 Windows 的盘上，之后 agent 直接用；掉线了 agent 会转人工，按提示在远程画面里重新扫码就行。

### 14.5 更新、排查

- **更新桌面服务**：把新的 `apps/desktop-agent` 拷到那台电脑上，以管理员身份再跑一次 `install.ps1`（不用再给 `-Key`，沿用原来的密钥）。重复运行是安全的；运行中两个服务会重启，远程画面断开一下再连上。服务器上的虚拟机：把目录拷到 `<storage>/shared/`，在远程画面里打开桌面上的「Shared」文件夹，把 `desktop-agent` 拷到 `C:\HeyAgent\src\`，再在 PowerShell 里运行（dockur 装的 Windows 关掉了「用户账户控制」，PowerShell 本来就是管理员）：
  `powershell -ExecutionPolicy Bypass -File C:\HeyAgent\src\desktop-agent\install.ps1`
- **换密钥**：`install.ps1 -Key <新密钥>`，再在控制台「桌面」页编辑、填新密钥。
- **连不上**：先 `status`（虚拟机）或在那台电脑上打开 `http://127.0.0.1:8001/health`（会提示密钥不对，说明服务在跑）；再看 `C:\HeyAgent\logs\desktop-agent.log`、`windows-mcp.log`。最常见的原因是那个用户被注销了、电脑锁屏了，或者没自动登录。
- **画面是黑的、点不动**：Windows 在锁屏或者正在弹「用户账户控制」的确认框（那个框在安全桌面上，截不到也点不了）。虚拟机用 14.1 的网页屏幕处理，实体机到电脑跟前处理。实体机上如果经常要装软件，可以在「用户账户控制设置」里调低，不让它切到安全桌面。

### 14.6 安全

- 有密钥就能完全操作这台 Windows（Windows-MCP 本身还能执行 PowerShell，只是 HeyAgent 不开放给 agent），**密钥按服务器密码对待**，只填在控制台里。
- 两个端口是明文 HTTP：**只在内网开放**，不要映射到外网；能限制来源的就只放行 HeyAgent 服务器（实体机用 `-AllowFrom`，虚拟机用 `--bind` 绑内网地址，再配合服务器防火墙）。
- 这台 Windows 上登的是公司的账号：当作服务器一样管，别给不相关的人远程登录。

