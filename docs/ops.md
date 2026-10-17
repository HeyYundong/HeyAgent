# HeyAgent 运维说明

给管理员看的：怎么装、怎么升级、怎么备份恢复、出了问题看哪里。

## 目录

1. 服务器要求
2. 第一次安装
3. 管理员初始密码
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

## 3. 管理员初始密码

账号 `admin@heyagent.local`。初始密码是第一次启动时随机生成的，放在容器里，不会打在日志里：

```bash
podman exec heyagent-api cat /data/state/admin-password
```

登录后点左下角的用户菜单 →「修改密码」。改完删掉那个文件：

```bash
podman exec heyagent-api rm /data/state/admin-password
```

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
3. 用**原来的**账号密码登录。新装时生成的管理员初始密码作废了。

`restore.sh` 会先核对：备份文件没坏、主密钥能解开这次备份、目标环境是空的（只有安装时自动建的管理员、没有任务）。任何一样不对就停下，什么都不改。确实要覆盖一个有数据的环境（例如升级失败回退），加 `HEYAGENT_RESTORE_FORCE=1`。恢复完它会逐行试解密，并打印用户、任务、文件的数量。

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
| 数据 | Podman 卷：`heyagent-pod-pgdata`（数据库）、`heyagent-pod-files`（文件）、`heyagent-pod-state`（管理员初始密码）。`podman volume ls` |
| 镜像 | `localhost/heyagent-{api,worker,web}:current`，上一版是 `:previous` |
| 备份 | `~/heyagent-backups/` |

`podman volume ls` 里还会看到和 secret 同名的几个卷（`heyagent-kek` 等）：那是 Podman 把 secret 展开给容器用的，每次启动按 secret 重写，不用管，也不要备份。
