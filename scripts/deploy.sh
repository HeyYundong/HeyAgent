#!/usr/bin/env bash
# HeyAgent 升级（正式服务器上，已经用 scripts/server-install.sh 装过）。
#   scripts/deploy.sh            拉代码 → 先备份一次 → 构建镜像（上一版留成 :previous）→ 更新单元文件 → 重启服务（api 启动时自动迁移）→ 健康检查
#   scripts/deploy.sh rollback   退回上一版镜像和单元文件，重启。数据库不会自动退回（见下）
# 可选的环境变量：HEYAGENT_SKIP_PULL=1（不 git pull，用当前工作区的代码）、HEYAGENT_SKIP_BACKUP=1（不先备份，不建议）
#
# 关于数据库：新版本的迁移在 api 启动时就执行了，退回旧镜像不会把表结构改回去。迁移一般只加不删，旧版本多半还能跑；
# 跑不了就用升级前那次备份恢复（脚本最后会打印它的路径），见 docs/ops.md「升级失败怎么办」。
set -euo pipefail

# shellcheck source=scripts/server-install.sh
. "$(dirname "$0")/server-install.sh"

RELEASE_DIR=$CONFIG_DIR/release
UNIT_FILES=("$QUADLET_DIR/heyagent.kube" "$QUADLET_DIR/heyagent.yaml" "$QUADLET_DIR/heyagent-config.yaml")

current_commit() { git -C "$ROOT" rev-parse --short HEAD; }

# 升级前把正在用的单元文件存一份，rollback 时换回去（新版本可能改了 pod 描述）
save_units() {
  mkdir -p "$RELEASE_DIR/previous"
  local file
  for file in "${UNIT_FILES[@]}"; do [ -f "$file" ] && cp -f "$file" "$RELEASE_DIR/previous/"; done
  [ -f "$RELEASE_DIR/commit" ] && cp -f "$RELEASE_DIR/commit" "$RELEASE_DIR/previous/commit"
  return 0
}

check_up() {
  wait_healthy 300 && wait_worker
}

deploy() {
  [ -f "$QUADLET_DIR/heyagent.kube" ] || die "还没装过：先跑 scripts/server-install.sh"
  load_config
  local before after backup_dir=""
  before=$(current_commit)
  if [ "${HEYAGENT_SKIP_PULL:-0}" != "1" ]; then
    log "拉代码"
    if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
      die "$ROOT 里有没提交的改动，先处理掉（或 HEYAGENT_SKIP_PULL=1 直接用工作区的代码）"
    fi
    git -C "$ROOT" pull --ff-only
  fi
  after=$(current_commit)
  echo "代码：$before → $after"
  git -C "$ROOT" log --oneline "$before..$after" 2>/dev/null | head -20 || true

  if [ "${HEYAGENT_SKIP_BACKUP:-0}" != "1" ]; then
    log "升级前先备份"
    "$ROOT/scripts/backup.sh" || [ $? = 3 ] || die "备份失败，没有升级。确实要跳过备份：HEYAGENT_SKIP_BACKUP=1"
    backup_dir=$(find "${HEYAGENT_BACKUP_DIR:-$HOME/heyagent-backups}" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]{8}-[0-9]{6}' | sort | tail -1)
  fi

  log "构建镜像"
  HEYAGENT_SKIP_BUILD=0 build_images
  save_units
  log "更新单元文件"
  install_units
  restart_service
  if check_up; then
    echo "$after" > "$RELEASE_DIR/commit"
    echo
    echo "升级完成：$after，$PUBLIC_URL"
    return 0
  fi
  cat >&2 <<EOF

✗ 升级后没有正常起来。看日志：
    podman logs $POD-api；podman logs $POD-worker；journalctl --user -u $SERVICE -n 100
  退回上一版：
    scripts/deploy.sh rollback
    git -C $ROOT checkout $before     # 代码也退回去，下次升级前再 git checkout 回分支
  如果旧版本也起不来（新版本的数据库迁移旧代码不认），用升级前的备份恢复：
    scripts/restore.sh ${backup_dir:-<升级前的备份目录>}     # 恢复要求目标是空环境，这时要加 HEYAGENT_RESTORE_FORCE=1
EOF
  exit 1
}

rollback() {
  load_config
  local name missing=0
  for name in "${IMAGES[@]}"; do podman image exists "localhost/heyagent-$name:previous" || missing=1; done
  [ "$missing" = 0 ] || die "没有上一版的镜像（:previous），没法退回"
  log "镜像退回 :previous（现在的留成 :failed）"
  for name in "${IMAGES[@]}"; do
    local image=localhost/heyagent-$name
    podman tag "$image:current" "$image:failed"
    podman tag "$image:previous" "$image:current"
  done
  if [ -d "$RELEASE_DIR/previous" ]; then
    log "单元文件退回上一版"
    local file
    for file in "${UNIT_FILES[@]}"; do
      [ -f "$RELEASE_DIR/previous/$(basename "$file")" ] && cp -f "$RELEASE_DIR/previous/$(basename "$file")" "$file"
    done
    systemctl --user daemon-reload
  fi
  restart_service
  check_up || die "退回后也没起来：看日志，或者用升级前的备份恢复（docs/ops.md「升级失败怎么办」）"
  [ -f "$RELEASE_DIR/previous/commit" ] && cp -f "$RELEASE_DIR/previous/commit" "$RELEASE_DIR/commit"
  echo "已退回上一版（代码版本 $(cat "$RELEASE_DIR/commit" 2>/dev/null || echo 未记录)）。代码目录别忘了也 git checkout 回去"
}

case "${1:-}" in
  "") deploy ;;
  rollback) rollback ;;
  *) echo "用法：$0 [rollback]" >&2; exit 2 ;;
esac
