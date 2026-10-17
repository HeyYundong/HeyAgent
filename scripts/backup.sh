#!/usr/bin/env bash
# HeyAgent 备份：数据库（pg_dump custom 格式）+ 文件卷（tar.gz），放进备份目录下以时间命名的子目录，保留 14 天。
# 服务器上由 systemd 定时器每天凌晨 3 点跑（deploy/systemd/heyagent-backup.*），也可以手动跑。开发机的 scripts/pod.sh 起的 pod 一样能用。
#
# 用法：scripts/backup.sh
# 配置（环境变量，服务器上写在 ~/.config/heyagent/heyagent.env）：
#   HEYAGENT_BACKUP_DIR        备份目录，默认 ~/heyagent-backups（可以是另一块盘或 NAS 的挂载点）
#   HEYAGENT_BACKUP_KEEP_DAYS  保留几天，默认 14
#   HEYAGENT_POD               pod 名，默认 heyagent（容器名是 <pod>-postgres、<pod>-api）
#   HEYAGENT_FILES_VOLUME      文件卷，默认 <pod>-pod-files
#
# 每次备份的内容（目录 <备份目录>/<年月日-时分秒>/）：
#   db.dump           pg_dump -Fc，用 scripts/restore.sh 恢复
#   files.tar.gz      文件卷（截图、产物、上传的附件）
#   kek-status.json   这份数据用到了哪些版本的主密钥、各自的指纹（没有密钥本身），恢复前用来核对拿的是不是同一把
#   manifest.txt      时间、代码版本、镜像
#   SHA256SUMS        上面几个文件的校验和
# 主密钥不进备份目录：它要离线保管。备份和主密钥放在一起，备份一泄露密文就全能解开。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
POD=${HEYAGENT_POD:-heyagent}
BACKUP_DIR=${HEYAGENT_BACKUP_DIR:-$HOME/heyagent-backups}
KEEP_DAYS=${HEYAGENT_BACKUP_KEEP_DAYS:-14}
FILES_VOLUME=${HEYAGENT_FILES_VOLUME:-$POD-pod-files}
# 打包文件卷用的临时容器：postgres 镜像一定在（pod 本身就用它），里面有 tar 和 gzip
HELPER_IMAGE=docker.io/pgvector/pgvector:0.8.7-pg18-trixie

log() { echo "[backup] $*"; }
die() { echo "[backup] ✗ $*" >&2; exit 1; }

case "$KEEP_DAYS" in '' | *[!0-9]*) die "HEYAGENT_BACKUP_KEEP_DAYS 要是正整数，现在是「$KEEP_DAYS」" ;; esac
[ "$KEEP_DAYS" -ge 1 ] || die "HEYAGENT_BACKUP_KEEP_DAYS 至少 1"

podman container exists "$POD-postgres" || die "找不到容器 $POD-postgres：服务没在跑？（服务器上 systemctl --user status heyagent）"
[ "$(podman container inspect -f '{{.State.Running}}' "$POD-postgres")" = "true" ] || die "$POD-postgres 没在运行"
podman volume exists "$FILES_VOLUME" || die "找不到文件卷 $FILES_VOLUME"

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
stamp=$(date +%Y%m%d-%H%M%S)
final=$BACKUP_DIR/$stamp
work=$BACKUP_DIR/.$stamp.partial
[ ! -e "$final" ] || die "$final 已经存在（一秒内跑了两次？）"
mkdir "$work"
# 中途失败就删掉半成品，不留下看起来完整的备份
trap 'rm -rf "$work"' EXIT

# 大文件都不经 podman 的标准输出转（Podman 3.4 上 podman run 往标准输出写二进制会卡住，实测 120 KB 就停了）：
# 数据库先 dump 到容器里再 podman cp 出来；文件卷直接打包到挂进去的备份目录
log "数据库 → $final/db.dump"
tmp_dump=/tmp/heyagent-backup-$stamp.dump
podman exec "$POD-postgres" pg_dump -U heyagent -d heyagent -Fc -f "$tmp_dump"
podman cp "$POD-postgres:$tmp_dump" "$work/db.dump"
podman exec "$POD-postgres" rm -f "$tmp_dump"
[ -s "$work/db.dump" ] || die "pg_dump 输出是空的"

log "文件卷 $FILES_VOLUME → $final/files.tar.gz"
podman run --rm --user 0 --network none --entrypoint tar -v "$FILES_VOLUME":/files:ro -v "$work":/backup "$HELPER_IMAGE" \
  -C /files -czf /backup/files.tar.gz .

# 主密钥的版本和指纹：由 api 容器里的 kek-rotate 读（它也会逐行试解密，顺便发现「已经有解不开的数据」这种问题）
if podman exec "$POD-api" node dist/scripts/kek-rotate.js status --json > "$work/kek-status.json" 2> "$work/kek-status.err"; then
  rm -f "$work/kek-status.err"
else
  log "⚠ 主密钥检查没通过（详情在 $final/kek-status.err）。数据库和文件照常备份了，但请尽快看一下"
  kek_warning=1
fi

{
  echo "HeyAgent 备份 $stamp"
  echo "时间：$(date -Iseconds)"
  echo "主机：$(hostname)"
  echo "pod：$POD"
  if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    echo "代码：$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)$(git -C "$ROOT" diff --quiet 2>/dev/null || echo '（有没提交的改动）')"
  fi
  for name in postgres api worker web; do
    if podman container exists "$POD-$name"; then
      echo "镜像 $name：$(podman container inspect -f '{{.ImageName}} {{.Image}}' "$POD-$name")"
    fi
  done
  echo "pg_dump：$(podman exec "$POD-postgres" pg_dump --version)"
  echo "恢复：scripts/restore.sh $final（需要同一把主密钥，见 docs/ops.md）"
} > "$work/manifest.txt"

# podman cp 和容器里写出来的文件不受上面 umask 管
chmod 600 "$work"/*
(cd "$work" && sha256sum -- * > SHA256SUMS)
mv "$work" "$final"
trap - EXIT
log "完成：$final（$(du -sh "$final" | cut -f1)）"

# 保留天数：只删这个脚本建的「年月日-时分秒」目录，而且是在这次备份成功之后才删
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
  -regex '.*/[0-9]{8}-[0-9]{6}' -mmin +$((KEEP_DAYS * 24 * 60)) -print0 |
  while IFS= read -r -d '' old; do
    rm -rf -- "$old"
    log "已删除超过 $KEEP_DAYS 天的备份 $(basename "$old")"
  done
# 以前失败留下的半成品（正常情况下 trap 已经删了；被 kill -9 时会留下）
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '.*.partial' -mmin +1440 -exec rm -rf -- {} +

[ -z "${kek_warning:-}" ] || exit 3
