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
| 桌面虚拟机（可选） | 要让 HeyAgent 自己开 Windows 虚拟机的话：CPU 支持虚拟化（`/dev/kvm`）、一块 SSD、每台 4～6 GB 内存，见第 14 节 |

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
| 桌面虚拟机（开了的话） | `<存放位置>/heyagent-desktops/`，容器 `heyagent-<桌面 id>`，**不在备份里**，见 14.4 |

`podman volume ls` 里还会看到和 secret 同名的几个卷（`heyagent-kek` 等）：那是 Podman 把 secret 展开给容器用的，每次启动按 secret 重写，不用管，也不要备份。

## 14. 桌面（给 agent 用的 Windows 电脑）

「桌面」是 agent 干活的第二种环境（第一种是浏览器）：一台 Windows 电脑，agent 通过它操作装在上面的软件（例如聊天软件、办公软件的桌面版）。开发说明见 `docs/dev/desktop.md`、`docs/dev/desktop-vm.md`，页面怎么用见使用手册 5.13。

一台桌面上跑两个服务，用**同一个密钥**：

| 服务 | 端口（Windows 里） | 干什么 |
|---|---|---|
| Windows-MCP 0.8.8 | 8000 | agent 读界面控件、点击、输入 |
| 桌面服务（`apps/desktop-agent`） | 8001 | 控制台的远程画面、截图、传文件 |

两个服务都跑在**自动登录的那个 Windows 用户的桌面会话**里（登录时由计划任务启动，不出窗口），所以 Windows 要一直开着、那个用户一直登录着，**不要注销、不要锁屏**（安装脚本已经关掉了锁屏、屏保和睡眠）。

桌面有两种来源：

- **系统开的桌面**（14.1～14.6）：HeyAgent 在这台服务器上用 Podman + KVM 自己开 Windows 11 虚拟机。主管先做一个「模板」（系统自动装 Windows 和两个服务，主管在远程画面里装好常用软件），之后运营在「桌面」页点「新建桌面」，十来分钟就有一台，扫码登录软件就能用。
- **登记已有电脑**（14.7）：实体 Windows 电脑或公司虚拟化平台上的 Windows，手动装两个服务后在控制台登记。不配 14.1 的话「桌面」页只有这一种。

**Windows 的授权由公司自己解决**：虚拟机装的是没激活的 Windows 11，能用，但右下角会有「激活 Windows」水印、个性化设置改不了；正式用请按公司的授权方式激活（在模板里激活，从它建的桌面都带着）。

### 14.1 服务器要准备的（只做一次）

| 项 | 要求 |
|---|---|
| CPU | 支持虚拟化，有 `/dev/kvm`（`ls -l /dev/kvm`）。服务器本身是虚拟机的话要开嵌套虚拟化 |
| 内存 | 每台桌面默认 6 GB（做模板时定，新建时可以改），另外留 24 GB 给系统、数据库和浏览器。见 14.5 |
| 盘 | **放 SSD**。机械盘上装一次模板要 3 小时左右，开一次机 10 分钟左右，agent 读一次界面十几到几十秒。见 14.5 |
| 外网 | 第一次做模板时要下载：Windows 11 镜像（微软的服务器，约 8.5 GB）、dockur 镜像（docker.io，约 700 MB）、Python 安装包（python.org），Windows 里 pip 装 Windows-MCP（pypi.org） |

管理员（sudo）做：

```bash
sudo usermod -aG kvm heyagent
# 让 heyagent 的 systemd 用户实例带上 kvm 组（Podman 服务由它起）。会重启 heyagent 的所有服务，也可以直接重启服务器
sudo systemctl restart user@$(id -u heyagent).service
# SSD 挂载好（写进 /etc/fstab），给 HeyAgent 建一个目录
sudo mkdir -p /ssd/heyagent && sudo chown heyagent: /ssd/heyagent
```

然后用 `heyagent` 重新 ssh 登录（新的登录才有 kvm 组），在 `~/.config/heyagent/heyagent.env` 里填存放位置，重跑安装：

```bash
# heyagent.env
HEYAGENT_DESKTOP_STORAGE_ROOTS=/ssd/heyagent              # 多块盘逗号隔开，SSD 放前面；HDD 也能写，页面会标「机械硬盘，Windows 会很慢」
HEYAGENT_DESKTOP_RESERVED_GB=24                           # 留给系统的内存

scripts/server-install.sh
```

安装脚本这时会多做一步「桌面虚拟机」（`scripts/desktop-host.sh setup`，也可以单独跑；只检查用 `scripts/desktop-host.sh check`）：

- 检查 `/dev/kvm`、kvm 组、systemd 用户实例有没有 kvm 组、linger、每个存放位置（存在、剩余空间、SSD 还是 HDD），**经 Podman API 起一个一次性容器，确认里面能用 /dev/kvm**；有不通过的就停下，按提示处理后再跑；
- 开 `podman.socket`（Podman 的 REST API），并加一个配置 `~/.config/systemd/user/podman.socket.d/heyagent.conf` 把 socket 权限改成 0666：pod 里的 api、worker 是容器里的 uid 1000（宿主机上的子 uid），要连得上它。socket 在 `/run/user/<uid>/podman/` 下面，`/run/user/<uid>` 是 0700，宿主机上别的用户进不去；
- 存放位置的属主改成容器里的 uid 1000（`podman unshare chown 1000:1000 <目录>`），worker 要在里面建目录；
- pod 描述多几个挂载：Podman socket 所在的目录（api、worker 的 `/run/heyagent-podman`）、每个存放位置（api、worker，**同路径**）、宿主机的 `/sys`（只读，api 的 `/host/sys`，认 SSD / HDD 用：Podman 默认把容器里的 `/sys/dev/block` 盖掉了）；
- pod 的网络改成 `slirp4netns:allow_host_loopback=true`（`heyagent.kube` 多一行 `Network=`）：虚拟机的端口只绑在宿主机的 127.0.0.1 上（从 42000～42999 里分），pod 里连 `10.0.2.2` 就是宿主机的 127.0.0.1；
- configmap 多几项：`HEYAGENT_PODMAN_SOCKET`、`HEYAGENT_DESKTOP_STORAGE_ROOTS`、`HEYAGENT_DESKTOP_VM_HOST=10.0.2.2`、`HEYAGENT_DESKTOP_KVM_DEVICE=""`（容器里看不到 /dev/kvm，api 不查，上面装的时候查过了）、`HEYAGENT_DESKTOP_SYS_ROOT=/host/sys`、`HEYAGENT_DESKTOP_RESERVED_GB`。

装好后「桌面」页右上角有「新建桌面」，设置页有「桌面存放位置」（能选默认位置、手动标 SSD / HDD）。

`heyagent.env` 里还可以加这些（不加用默认值，改完重跑安装）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HEYAGENT_DESKTOP_PORT_RANGE` | `42000-42999` | 虚拟机端口的范围（每台两个，只绑 127.0.0.1；开机时被占会自动换一个空的） |
| `HEYAGENT_DESKTOP_MIN_FREE_GB` | 40 | 存放位置剩得比这少就不能再建 |
| `HEYAGENT_DESKTOP_PYTHON_URL`、`HEYAGENT_DESKTOP_PYTHON_SHA256` | python.org 的 3.14.8 | 连不上 python.org 时换成内网的地址，两个一起改 |
| `HEYAGENT_DESKTOP_IMAGE` | `docker.io/dockurr/windows@sha256:16fd7c39…`（6.06） | 一般不要改 |
| `HEYAGENT_DESKTOP_VM_START_TIMEOUT_MS`、`HEYAGENT_DESKTOP_VM_INSTALL_TIMEOUT_MS` | 20 分钟、8 小时 | 开机、装 Windows 多久还没好算出错 |
| `HEYAGENT_DESKTOP_VM_STOP_SECONDS` | 120 | 关机时给 Windows 多少秒正常关机 |

不想开虚拟机了：把 `HEYAGENT_DESKTOP_STORAGE_ROOTS` 留空、重跑安装，pod 回到原来的样子（已经开着的虚拟机容器不会自动删，先在页面上删掉）。

### 14.2 第一次：做模板（主管）

「桌面」页 →「做模板」：起名字，选存放位置（SSD），内存、CPU、系统盘大小（默认 6 GB、4 核、64 GB；**系统盘建好后改不了**，从这个模板建的桌面都一样大）。之后全自动，状态是「装 Windows 中」，页面显示已经装了多久：

1. worker 拉 dockur 镜像（第一次）、下载并核对 Python 安装包，准备安装目录（Python、桌面服务、密钥、安装脚本）；
2. 起虚拟机容器，dockur 从微软下载 Windows 11 中文版镜像，无人值守安装，自动登录；
3. 第一次登录时自动装 Python、Windows-MCP 和桌面服务；两个服务都通了，状态变成「等装软件」。

实测（开发机，机械硬盘）：点「做模板」到「等装软件」一共 3 小时 3 分：准备安装目录、开机 20 秒；下载 Windows 镜像（8.5 GB）20 分钟；装 Windows（中间重启几次）2 小时 10 分；装 Python 11 分钟；装 Windows-MCP 和桌面服务（pip 从网上下载）21 分钟。「做成模板」1 分 42 秒。SSD 上会快很多（还没实测）。

「等装软件」时：点「看画面」，在远程画面里把要用的软件装好（**不要登录账号**：账号是每台桌面自己登的），要重启就用页面上的「重启」。都装好了点「做成模板」：Windows 正常关机 → 删掉容器和安装目录（里面有密钥）→ 磁盘改成只读 → 状态「做好了」。模板不会分给 agent 用。

做好的模板不能再改。要换软件：再做一个新模板，新桌面从新模板建；旧模板等用它建的桌面都删了才能删。

### 14.3 新建桌面（运营）

「桌面」页 →「新建桌面」：起名字、写说明（给 agent 看：装了哪些软件、登的哪个账号）、选模板、选存在哪块盘。新桌面的盘是模板盘上的「写时复制」（qcow2），建好只占 几 MB（开起来后几百 MB），开机后状态「开机中」，两个服务都通了变成「开着」。实测机械盘上 从点「新建」到「开着」10 分钟左右（两次实测 10 分 36 秒、9 分 52 秒）；删除 41 秒。

然后点「看画面」，在远程画面里打开软件扫码登录（勾上「记住登录」之类的选项）。登录状态存在这台桌面自己的盘上，之后 agent 直接用。

- **关机 / 开机 / 重启**：页面按钮。关机给 Windows 2 分钟正常关机。关着的桌面不会分给 agent。
- **重置**：盘恢复成模板的样子（软件的登录没了，要重新扫码），用在 Windows 被搞乱了的时候。
- **删除**：关机、删容器、删盘，不能恢复。
- **服务器重启**：原来开着的桌面，HeyAgent 起来后 worker 会自动再开（每 30 秒对一次账）。**升级 HeyAgent（`scripts/deploy.sh`）不会关掉桌面**：虚拟机是单独的容器，不在 pod 里。

### 14.4 东西在哪

| 东西 | 位置 |
|---|---|
| 每台桌面、模板的目录 | `<存放位置>/heyagent-desktops/<桌面 id>/`：`data.qcow2`（系统盘）和 dockur 的几个 `windows.*` 小文件 |
| 下载的 Python 安装包 | `<存放位置>/heyagent-desktops/cache/` |
| 虚拟机的容器 | `heyagent-<桌面 id>`，`podman ps -a --filter label=heyagent.desktop` |
| Podman socket 的权限配置 | `~/.config/systemd/user/podman.socket.d/heyagent.conf` |

**不要手动删、改、挪这些目录**，尤其是模板的 `data.qcow2`：桌面的盘只记着「和模板不一样的部分」，模板盘没了或变了，从它建的桌面全都坏掉。删桌面、删模板都在页面上做。

**桌面的盘不在每天的备份里**（第 7 节只备份数据库和文件）。丢了的话：桌面从模板重建、重新扫码；模板重做。想留一份模板，做成模板之后（盘是只读的）把模板目录整个拷走就行。

### 14.5 能开几台（按 32 核、128 GB 内存算）

- **内存**（系统按这个拦）：开着的桌面内存合计不超过「本机内存 − `HEYAGENT_DESKTOP_RESERVED_GB`」。128 − 24 = 104 GB，每台 6 GB 能开 17 台，4 GB 能开 26 台。超了新建、开机会提示「本机内存不够了」。每台实际还要多一点（QEMU 本身几百 MB），所以别把 RESERVED 调得太小。
- **CPU**（系统不拦）：每台默认 4 核，Windows 闲着时几乎不占，同时有几台在干活才吃 CPU。建议虚拟核合计不超过实际线程数的 2 倍：32 线程 → 16 台 × 4 核。同时干活的多了，agent 每一步都会变慢。
- **盘**：模板装好后占 12 GB（64 GB 的盘，按实际用量占），再装软件会多一些；每台桌面开始只占 几 MB（开起来后几百 MB），用着用着会长（软件缓存、聊天记录、Windows 更新），按每台 10～20 GB 估，重置后变回去。例：1 个模板 30 GB + 15 台 × 20 GB ≈ 330 GB，再加至少 40 GB 的余量（剩得比这少不能新建），用 500 GB 以上的 SSD。装模板的时候目录里还有 Windows 安装镜像（约 8.5 GB），做成模板时删掉。

### 14.6 排查（系统开的桌面）

- **「新建桌面」是灰的，说「本机不能开虚拟机」**：后面写了原因。
  - 「没有配置 Podman / 存放位置」：14.1 没做，或 `heyagent.env` 改了没重跑安装。
  - 「Podman 连不上（…：ENOENT / ECONNREFUSED）」：`systemctl --user status podman.socket`；「…EACCES」：socket 权限不对，`scripts/desktop-host.sh setup`。
- **存放位置后面写「没有写权限」**：属主不对，`scripts/desktop-host.sh setup`。「目录不存在」：盘没挂上。
- **一直「装 Windows 中」**：机械盘上 3 小时左右是正常的（实测 3 小时 3 分），8 小时还没好记「出错了」（机械盘、网又慢的话把 `HEYAGENT_DESKTOP_VM_INSTALL_TIMEOUT_MS` 调大）。看进度：`podman logs -f heyagent-<桌面 id>`（dockur 的日志：下载、安装、「Booting Windows」）；看虚拟机的屏幕（两个服务起来之前看不了远程画面）：

  ```bash
  podman exec heyagent-<桌面 id> python3 -c "import socket,time; s=socket.socket(socket.AF_UNIX); s.connect('/run/shm/monitor.sock'); time.sleep(.3); s.recv(65536); s.send(b'screendump /storage/screen.ppm\n'); time.sleep(2)"
  # 截图在 <存放位置>/heyagent-desktops/<桌面 id>/screen.ppm（PPM 格式，拷到电脑上用看图软件打开），看完删掉
  ```

  装好了 Windows 但两个服务没起来：在 Windows 里看 `C:\OEM\heyagent-install.log`（Python、install.ps1 的输出）。
- **「出错了」**：原因写在状态下面，处理完点任何一个操作（开机、重启……）再试，系统不会自己一直重试。
  - 「虚拟机没开起来（容器退出码 …）」后面跟着 dockur 的日志（英文原文）：里面说 KVM（例如 `KVM acceleration not available`、`/dev/kvm` 打不开）就是 kvm 组的问题，`scripts/desktop-host.sh check`，多半是改了组之后没重启 systemd 用户实例；
  - 「开机 20 分钟了，还连不上」：机械盘上开机 7～12 分钟是正常的，再慢就是盘太忙（同时开太多台）或者 Windows 卡在更新，看上面的截图；
  - 「本机内存不够了」：关掉不用的桌面，或者新建时把内存调小；
  - 「端口都被占了：…」：开机时要用的端口被占着（比如正好有一条对外连接用着它；Podman 报 `slirp_add_hostfwd failed` 或 `address already in use`），系统会自动换一个空的端口再开（审计里记一条 `desktop.vm.ports`，worker 日志里有「换端口：…」），连试 5 次都被占、或者 42000～42999 里没有空着的了才记出错。偶尔一次的话等一会儿再点「开机」；一直这样就是宿主机上别的程序占了这一段的很多端口，查一下（`ss -tanp | grep ':42'`），或者改 `HEYAGENT_DESKTOP_PORT_RANGE`（以后换端口、新建都从新的段里分）；
  - 删除出错会一直留在「删除中」，每 30 秒自己再试一次。
- **开着，但写着「桌面服务连不上」**：Windows 可能在重启装更新、锁屏了或者用户被注销了，点「看画面」看看，或者重启这台。
- 虚拟机容器、目录是 worker 经 Podman API 管的。**不要用 podman 命令直接开关、删除**（页面上的状态会跟着对账改过来，但删了的盘就没了）。只是看看可以：`podman ps -a --filter label=heyagent.desktop`、`podman logs`。

### 14.7 登记已有电脑（实体机、别处的虚拟机）

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

然后在控制台「桌面」页 →「登记已有电脑」（主管）：

- **名字**、**说明**：说明是给 agent 看的，写清楚装了哪些软件、登的哪个账号，agent 按它挑桌面；
- **MCP 地址**：`http://<IP>:8000/mcp`；**桌面服务地址**：`http://<IP>:8001`；
- **密钥**：和安装时的一样。

点「测试连接」，两项都通过才算好。第一次登录软件同 14.3：「看画面」里扫码登录。

更新、排查：

- **更新桌面服务**：把新的 `apps/desktop-agent` 拷到那台电脑上，以管理员身份再跑一次 `install.ps1`（不用再给 `-Key`，沿用原来的密钥）。重复运行是安全的；运行中两个服务会重启，远程画面断开一下再连上。系统开的桌面：再做一个模板（会装上当前版本的桌面服务），新桌面从新模板建。
- **换密钥**：`install.ps1 -Key <新密钥>`，再在控制台「桌面」页编辑、填新密钥。
- **连不上**：在那台电脑上打开 `http://127.0.0.1:8001/health`（提示密钥不对，说明服务在跑）；再看 `C:\HeyAgent\logs\desktop-agent.log`、`windows-mcp.log`。最常见的原因是那个用户被注销了、电脑锁屏了，或者没自动登录。
- **画面是黑的、点不动**：Windows 在锁屏或者正在弹「用户账户控制」的确认框（那个框在安全桌面上，截不到也点不了），到电脑跟前处理。经常要装软件的话，可以在「用户账户控制设置」里调低，不让它切到安全桌面（系统开的桌面已经关掉了用户账户控制）。

### 14.8 安全

- 有密钥就能完全操作这台 Windows（Windows-MCP 本身还能执行 PowerShell，只是 HeyAgent 不开放给 agent），**密钥按服务器密码对待**，只填在控制台里。系统开的桌面的密钥由系统生成、只存密文，一个模板和从它建的桌面共用一个。
- 两个端口是明文 HTTP：实体机**只在内网开放**，不要映射到外网，用 `-AllowFrom` 只放行 HeyAgent 服务器；系统开的桌面只绑宿主机的 127.0.0.1，外面连不到。
- 开了系统开的桌面以后：pod 里的 api、worker 能用 Podman API，等于能以 `heyagent` 用户的身份管容器（建虚拟机本来就要这个）；pod 能连宿主机 127.0.0.1 上的端口（`10.0.2.2`），所以这台服务器上**别在 127.0.0.1 上跑不要密码的服务**。
- 这台 Windows 上登的是公司的账号：当作服务器一样管，别给不相关的人远程登录、看画面。
