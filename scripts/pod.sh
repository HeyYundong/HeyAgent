#!/usr/bin/env bash
# 整套 pod（postgres + api + web，入口 8080）：构建镜像、准备主密钥和配置、起停。描述在 deploy/pod.yaml。
# 用法：scripts/pod.sh up | down | logs [postgres|api|web] | status
#   HEYAGENT_SEED_DEMO=1 scripts/pod.sh up   起来后灌演示数据（会先清掉库里的演示数据再灌）
#   HEYAGENT_SKIP_BUILD=1 scripts/pod.sh up  不重新构建镜像（镜像已经有了时省时间）
#   HEYAGENT_PUBLIC_URL                      控制台对外的地址，默认 http://localhost:8080（better-auth 的 baseURL）
# 兼容 Podman 3.4（podman play kube）和 4.x 以上（podman kube play）。数据卷 down 时保留；要清空：
#   scripts/pod.sh down && podman volume rm heyagent-pod-pgdata heyagent-pod-files heyagent-pod-kek
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
POD=heyagent
YAML=$ROOT/deploy/pod.yaml
STATE=$ROOT/.dev/pod
CONFIG=$STATE/config.yaml
SECRETS=$STATE/secrets.env
KEK=${HEYAGENT_KEK_FILE:-$ROOT/.dev/kek}
API_IMAGE=localhost/heyagent-api:m0
WEB_IMAGE=localhost/heyagent-web:m0
VOLUMES=(heyagent-pod-pgdata heyagent-pod-files heyagent-pod-kek)
PORT=8080
PUBLIC_URL=${HEYAGENT_PUBLIC_URL:-http://localhost:$PORT}
# 允许登录的来源：本机和内网另一台电脑（192.168.31.100 是开发机的内网地址）
TRUSTED_ORIGINS=${HEYAGENT_TRUSTED_ORIGINS:-http://localhost:8080,http://127.0.0.1:8080,http://192.168.31.100:8080,http://192.168.31.100:5180}

# Podman 4 起叫 podman kube play，3.4 叫 podman play kube；两边都支持 --down 和 --configmap。
# 按版本号判断：3.4 上 `podman kube play --help` 也会返回 0（打印的是别的帮助），不能拿它判断
PODMAN_MAJOR=$(podman version --format '{{.Client.Version}}' | cut -d. -f1)
if [ "$PODMAN_MAJOR" -ge 4 ]; then PLAY=(podman kube play); else PLAY=(podman play kube); fi

pod_exists() { podman pod exists "$POD"; }

build() {
  if [ "${HEYAGENT_SKIP_BUILD:-0}" = "1" ]; then
    podman image exists "$API_IMAGE" && podman image exists "$WEB_IMAGE" && return 0
    echo "镜像不全，还是要构建" >&2
  fi
  echo "== 构建 $API_IMAGE"
  podman build -f "$ROOT/deploy/api.Containerfile" -t "$API_IMAGE" "$ROOT"
  echo "== 构建 $WEB_IMAGE"
  podman build -f "$ROOT/deploy/web.Containerfile" -t "$WEB_IMAGE" "$ROOT"
}

random_secret() { head -c 32 /dev/urandom | base64 | tr -d '\n/+=' ; }

# 数据库密码、better-auth 的签名密钥：第一次生成后记在 .dev/pod/secrets.env，以后沿用（换了 BETTER_AUTH_SECRET 大家要重新登录，换了数据库密码连不上已有的库）
ensure_config() {
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  if [ ! -f "$SECRETS" ]; then
    umask 077
    {
      echo "POSTGRES_PASSWORD=$(random_secret)"
      echo "BETTER_AUTH_SECRET=$(random_secret)"
    } > "$SECRETS"
    echo "已生成数据库密码和 BETTER_AUTH_SECRET：$SECRETS"
  fi
  # shellcheck disable=SC1090
  source "$SECRETS"
  local seed_password
  seed_password=$(grep -E '^SEED_PASSWORD=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)
  umask 077
  cat > "$CONFIG" <<YAML
# scripts/pod.sh 生成，不要手改、不要提交。密码类的值来自 $SECRETS
apiVersion: v1
kind: ConfigMap
metadata:
  name: heyagent-config
data:
  POSTGRES_PASSWORD: "$POSTGRES_PASSWORD"
  DATABASE_URL: "postgres://heyagent:$POSTGRES_PASSWORD@127.0.0.1:5432/heyagent"
  BETTER_AUTH_SECRET: "$BETTER_AUTH_SECRET"
  BETTER_AUTH_URL: "$PUBLIC_URL"
  TRUSTED_ORIGINS: "$TRUSTED_ORIGINS"
  SEED_PASSWORD: "${seed_password:-heyagent-dev}"
  TZ: "Asia/Shanghai"
YAML
}

# 主密钥：没有就用 dev-kek.sh 生成；每次 up 都拷进卷，属主是 api 容器里的 node 用户（uid 1000），权限 0400。
# 拷的时候用容器里的 root（rootless 下就是宿主机上的你），所以读得到 600 的 .dev/kek
ensure_kek() {
  [ -f "$KEK" ] || HEYAGENT_KEK_FILE="$KEK" "$ROOT/scripts/dev-kek.sh"
  for volume in "${VOLUMES[@]}"; do
    podman volume exists "$volume" || podman volume create "$volume" >/dev/null
  done
  podman run --rm --user 0 --entrypoint sh \
    -v heyagent-pod-kek:/dst -v "$KEK":/src/kek:ro \
    "$API_IMAGE" -c 'install -o node -g node -m 0400 /src/kek /dst/kek'
}

wait_healthy() {
  echo -n "等 http://127.0.0.1:$PORT/api/health "
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      echo " 就绪"
      return 0
    fi
    echo -n "."
    sleep 1
  done
  echo
  echo "90 秒内没有就绪，看日志：scripts/pod.sh logs api" >&2
  exit 1
}

up() {
  build
  ensure_config
  ensure_kek
  if pod_exists; then
    echo "== pod $POD 已经在了，先停掉重建（数据卷保留）"
    "${PLAY[@]}" --down "$YAML" >/dev/null
  fi
  echo "== ${PLAY[*]} deploy/pod.yaml"
  "${PLAY[@]}" --configmap "$CONFIG" "$YAML"
  wait_healthy
  if [ "${HEYAGENT_SEED_DEMO:-0}" = "1" ]; then
    echo "== 灌演示数据"
    podman exec -e HEYAGENT_SEED_DEMO=1 "$POD-api" node dist/seed/cli.js
  fi
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo "整套已启动：http://localhost:$PORT${ip:+ ，内网 http://$ip:$PORT}"
}

down() {
  if pod_exists; then
    "${PLAY[@]}" --down "$YAML" >/dev/null
    echo "已停止并删除 pod $POD（数据卷 ${VOLUMES[*]} 保留）"
  else
    echo "pod $POD 不存在"
  fi
}

logs() {
  if [ -n "${1:-}" ]; then
    exec podman logs -f "$POD-$1"
  fi
  for name in postgres api web; do
    echo "== $POD-$name"
    podman logs --tail 30 "$POD-$name" 2>&1 || true
  done
}

status() {
  if ! pod_exists; then
    echo "pod $POD 不存在"
    return 0
  fi
  podman pod ps --filter "name=^$POD\$"
  podman ps -a --pod --filter "pod=$POD" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
  echo -n "健康检查：" && (curl -fsS "http://127.0.0.1:$PORT/api/health" || echo "不通") && echo
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  logs) logs "${2:-}" ;;
  status) status ;;
  *) echo "用法：$0 up | down | logs [postgres|api|web] | status" >&2; exit 2 ;;
esac
