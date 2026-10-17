#!/usr/bin/env bash
# 开发数据库：rootless Podman 起 PostgreSQL 18（带 pgvector 扩展，图库的向量检索要用），只绑 127.0.0.1:5432，数据放在命名卷 heyagent-pgdata。
# 镜像换过时（例如 2026-10-17 从 postgres:18 换成 pgvector 的镜像），up 会删掉旧容器、用新镜像重建，数据卷保留。
# 用法：scripts/dev-db.sh up | down | reset [-y] | psql [库名] | status
# 建两个库：heyagent（开发）和 heyagent_test（测试）。账号密码只用于本机开发，和 .env.example 一致。
set -euo pipefail

NAME=heyagent-pg
VOLUME=heyagent-pgdata
IMAGE=docker.io/pgvector/pgvector:0.8.7-pg18-trixie
PG_USER=${POSTGRES_USER:-heyagent}
PG_PASSWORD=${POSTGRES_PASSWORD:-heyagent}
PORT=${HEYAGENT_PG_PORT:-5432}

exists() { podman container exists "$NAME"; }
running() { [ "$(podman inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; }
in_pg() { podman exec "$NAME" "$@"; }

wait_ready() {
  for _ in $(seq 1 60); do
    # 镜像第一次初始化时会先起一个只监听 socket 的临时实例，所以要按 TCP 检查
    if in_pg pg_isready -q -h 127.0.0.1 -U "$PG_USER" -d postgres; then return 0; fi
    sleep 1
  done
  echo "PostgreSQL 60 秒内没有就绪，看日志：podman logs $NAME" >&2
  exit 1
}

ensure_db() {
  local db=$1
  if [ "$(in_pg psql -U "$PG_USER" -d postgres -tAc "select 1 from pg_database where datname = '$db'")" != "1" ]; then
    in_pg psql -q -U "$PG_USER" -d postgres -c "create database $db"
    echo "已建库 $db"
  fi
}

up() {
  if exists && [ "$(podman inspect -f '{{.ImageName}}' "$NAME")" != "$IMAGE" ]; then
    echo "容器 $NAME 用的是旧镜像，换成 $IMAGE 重建（数据卷 $VOLUME 保留）"
    podman stop "$NAME" >/dev/null
    podman rm "$NAME" >/dev/null
  fi
  if exists; then
    running || podman start "$NAME" >/dev/null
  else
    # PostgreSQL 18 的镜像把数据目录放在 /var/lib/postgresql/18/docker，卷要挂在 /var/lib/postgresql
    podman run -d --name "$NAME" \
      -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=heyagent \
      -e TZ=Asia/Shanghai \
      -v "$VOLUME":/var/lib/postgresql \
      -p 127.0.0.1:"$PORT":5432 \
      "$IMAGE" >/dev/null
  fi
  wait_ready
  ensure_db heyagent
  ensure_db heyagent_test
  echo "开发数据库已就绪：postgres://$PG_USER:***@127.0.0.1:$PORT/heyagent（测试库 heyagent_test）"
}

down() {
  if exists; then
    podman stop "$NAME" >/dev/null
    podman rm "$NAME" >/dev/null
    echo "已停止并删除容器 $NAME（数据卷 $VOLUME 保留）"
  else
    echo "容器 $NAME 不存在"
  fi
}

reset() {
  if [ "${1:-}" != "-y" ]; then
    read -r -p "会删除数据卷 $VOLUME 里的全部数据，输入 yes 继续：" answer
    [ "$answer" = "yes" ] || { echo "已取消"; exit 1; }
  fi
  down
  podman volume exists "$VOLUME" && podman volume rm "$VOLUME" >/dev/null && echo "已删除数据卷 $VOLUME"
  up
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  reset) reset "${2:-}" ;;
  psql) exec podman exec -it "$NAME" psql -U "$PG_USER" -d "${2:-heyagent}" ;;
  status) exists && podman ps -a --filter "name=^$NAME\$" || echo "容器 $NAME 不存在" ;;
  *) echo "用法：$0 up | down | reset [-y] | psql [库名] | status" >&2; exit 2 ;;
esac
