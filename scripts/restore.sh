#!/usr/bin/env bash
# HeyAgent 恢复：把 scripts/backup.sh 的某一次备份恢复到一套新装好的空环境（新服务器，或者重置过的环境）。
#
# 用法：scripts/restore.sh <备份目录>，例如 scripts/restore.sh ~/heyagent-backups/20261017-030000
#
# 前提：
#   1. 目标环境已经装好、在运行（服务器上先跑 scripts/server-install.sh），而且是空的：还没设置管理员（或者只有刚设置的那一个），没有任务；
#      不是空的会拒绝（确实要覆盖，设 HEYAGENT_RESTORE_FORCE=1）。
#   2. 目标环境用的是同一把主密钥：新服务器安装时用 HEYAGENT_KEK_IMPORT=<离线备份的主密钥文件> 导入（见 docs/ops.md）。
#      脚本会先拿备份里的 kek-status.json 核对，对不上就停下，什么都不改。
#
# 做的事：校验备份文件 → 核对主密钥 → 停 api 和 worker → 删掉目标库重建、pg_restore → 清空文件卷、解包 → 起 api 和 worker
#   （api 启动时自动迁移到当前代码的版本）→ 健康检查 → 逐行试解密 → 打印用户、任务、文件的数量。
# 恢复之后用备份里原来的账号密码登录；恢复前在新环境里设置的管理员会被备份覆盖掉。
#
# 配置（环境变量）：HEYAGENT_POD（默认 heyagent）、HEYAGENT_FILES_VOLUME（默认 <pod>-pod-files）、
#   HEYAGENT_PORT（健康检查的端口，默认读 ~/.config/heyagent/heyagent.env，再没有就是 8080）。
set -euo pipefail

BACKUP=${1:-}
[ -n "$BACKUP" ] || { echo "用法：$0 <备份目录>" >&2; exit 2; }
BACKUP=$(cd "$BACKUP" && pwd)

CONFIG_ENV=${XDG_CONFIG_HOME:-$HOME/.config}/heyagent/heyagent.env
if [ -z "${HEYAGENT_PORT:-}" ] && [ -f "$CONFIG_ENV" ]; then
  HEYAGENT_PORT=$(grep -E '^HEYAGENT_PORT=' "$CONFIG_ENV" | tail -1 | cut -d= -f2- || true)
fi
POD=${HEYAGENT_POD:-heyagent}
PORT=${HEYAGENT_PORT:-8080}
FILES_VOLUME=${HEYAGENT_FILES_VOLUME:-$POD-pod-files}
HELPER_IMAGE=docker.io/library/postgres:18

log() { echo "[restore] $*"; }
die() { echo "[restore] ✗ $*" >&2; exit 1; }
psql_admin() { podman exec "$POD-postgres" psql -v ON_ERROR_STOP=1 -U heyagent -d postgres -Atq "$@"; }
psql_app() { podman exec "$POD-postgres" psql -v ON_ERROR_STOP=1 -U heyagent -d heyagent -Atq "$@"; }
running() { [ "$(podman container inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }

wait_healthy() {
  local _
  for _ in $(seq 1 180); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# ---------- 1. 备份本身 ----------
for file in db.dump files.tar.gz SHA256SUMS; do
  [ -s "$BACKUP/$file" ] || die "$BACKUP 里没有 $file，不是一次完整的备份"
done
log "校验备份文件"
(cd "$BACKUP" && sha256sum --quiet -c SHA256SUMS) || die "校验和对不上，备份文件坏了"

# ---------- 2. 目标环境 ----------
for name in postgres api worker; do
  podman container exists "$POD-$name" || die "找不到容器 $POD-$name：先把目标环境装好并启动（scripts/server-install.sh）"
done
if ! running "$POD-postgres" || ! running "$POD-api"; then die "$POD-postgres 或 $POD-api 没在运行"; fi
wait_healthy || die "http://127.0.0.1:$PORT/api/health 不通：目标环境要先正常跑起来"

# ---------- 3. 主密钥 ----------
if [ -s "$BACKUP/kek-status.json" ]; then
  log "核对主密钥"
  podman exec -i "$POD-api" node dist/scripts/kek-rotate.js verify-backup - < "$BACKUP/kek-status.json" ||
    die "目标环境的主密钥解不开这次备份。先用备份时的那把主密钥重新安装（HEYAGENT_KEK_IMPORT，见 docs/ops.md），再来恢复"
else
  log "⚠ 备份里没有 kek-status.json（备份时 api 没在跑），没法提前核对主密钥；恢复完会逐行试解密"
fi

# ---------- 4. 目标必须是空的 ----------
users=$(psql_app -c 'select count(*) from users')
tasks=$(psql_app -c 'select count(*) from tasks')
if [ "$users" -gt 1 ] || [ "$tasks" -gt 0 ]; then
  if [ "${HEYAGENT_RESTORE_FORCE:-0}" != "1" ]; then
    die "目标环境不是空的（$users 个用户、$tasks 个任务）。恢复会整个覆盖掉它；确实要这样做，设 HEYAGENT_RESTORE_FORCE=1 再跑"
  fi
  log "⚠ HEYAGENT_RESTORE_FORCE=1：覆盖现有的 $users 个用户、$tasks 个任务"
fi

# ---------- 5. 停 api 和 worker（postgres、web 照常跑）----------
# 手动 stop 的容器不会被 pod 的 restartPolicy 拉起来
log "停 api 和 worker"
podman stop -t 30 "$POD-worker" "$POD-api" >/dev/null
restarted=0
# 中途失败也要把 api 和 worker 起回来，免得环境一直停着；数据库可能是半恢复的状态，日志里会提示
restart_services() {
  [ "$restarted" = 1 ] && return 0
  restarted=1
  podman start "$POD-api" "$POD-worker" >/dev/null || true
}
on_exit() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "[restore] ✗ 恢复没完成（退出码 $code），数据库和文件可能只恢复了一部分。修好问题后用 HEYAGENT_RESTORE_FORCE=1 重跑" >&2
    restart_services
  fi
}
trap on_exit EXIT

# ---------- 6. 数据库 ----------
log "重建数据库并 pg_restore（$(du -h "$BACKUP/db.dump" | cut -f1)）"
# 大文件不经 podman 的标准输入输出转（Podman 3.4 上会卡住，见 backup.sh）：先 podman cp 进容器再 pg_restore
tmp_dump=/tmp/heyagent-restore.dump
podman cp "$BACKUP/db.dump" "$POD-postgres:$tmp_dump"
psql_admin -c 'drop database if exists heyagent with (force)' -c 'create database heyagent owner heyagent'
podman exec "$POD-postgres" pg_restore -U heyagent -d heyagent --no-owner --exit-on-error "$tmp_dump"
podman exec "$POD-postgres" rm -f "$tmp_dump"

# ---------- 7. 文件卷 ----------
log "恢复文件卷 $FILES_VOLUME（$(du -h "$BACKUP/files.tar.gz" | cut -f1)）"
# 解包用 api 的镜像（Debian 12）：postgres:18 是 Debian 13，它的 tar 改权限时用 fchmodat2，
# 旧的 crun（开发机 Podman 3.4 配的 0.17）的 seccomp 对这个调用回 EPERM，解包会失败
api_image=$(podman container inspect -f '{{.ImageName}}' "$POD-api")
podman run --rm --user 0 --network none --entrypoint sh -v "$FILES_VOLUME":/files -v "$BACKUP":/backup:ro "$api_image" \
  -c 'find /files -mindepth 1 -delete && tar -C /files -xzf /backup/files.tar.gz && chown -R 1000:1000 /files'

# ---------- 8. 起 api 和 worker ----------
log "起 api 和 worker（api 启动时会把数据库迁移到当前代码的版本）"
restart_services
wait_healthy || die "api 3 分钟内没有就绪，看日志：podman logs $POD-api"

# ---------- 9. 核对 ----------
log "逐行试解密"
podman exec "$POD-api" node dist/scripts/kek-rotate.js status || die "有解不开的密文，见上面的列表"
counts=$(psql_app -F ' ' -c "select (select count(*) from users), (select count(*) from tasks), (select count(*) from files), (select count(*) from sessions)")
read -r n_users n_tasks n_files n_sessions <<< "$counts"
n_disk=$(podman run --rm --user 0 --network none --entrypoint sh -v "$FILES_VOLUME":/files:ro "$HELPER_IMAGE" -c 'find /files -type f | wc -l')
trap - EXIT
log "完成：$n_users 个用户、$n_tasks 个任务、$n_sessions 次运行、$n_files 条文件记录（文件卷里 $n_disk 个文件）"
log "用备份里原来的账号密码登录；恢复前在新环境里设置的管理员已被覆盖"
