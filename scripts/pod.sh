#!/usr/bin/env bash
# 整套 pod（postgres + api + worker + web，入口 8080）：构建镜像、准备主密钥 / OpenRouter key / 配置、起停。描述在 deploy/pod.yaml。
# 用法：scripts/pod.sh up | down | reset | logs [postgres|api|worker|web] | status
#   reset                                    停掉 pod、删掉全部数据卷，回到空白环境（不会自动再起，接着 up）
#   HEYAGENT_SEED_DEMO=1 scripts/pod.sh up   起来后灌演示数据（只给开发用，默认不灌）
#   HEYAGENT_SKIP_BUILD=1 scripts/pod.sh up  不重新构建镜像（镜像已经有了时省时间）
#   HEYAGENT_PNPM_STORE=/mnt/toshiba/.pnpm-store scripts/pod.sh up
#                                            构建时用本机现成的 pnpm store（`pnpm store path` 去掉末尾的 /v11）：挂到构建容器的 /pnpm-store，
#                                            本机有的包不再下载，缺的照旧从官方源下（网慢时用）；不设时和以前一样
#   HEYAGENT_PUBLIC_URL                      控制台对外的地址，默认 http://localhost:8080（better-auth 的 baseURL）
#   HEYAGENT_DESKTOP_STORAGE_ROOTS=/a,/b     开「系统开的桌面」：虚拟机存在这些目录（同路径挂进 api、worker），先 scripts/desktop-host.sh setup；
#                                            HEYAGENT_HOST_PODMAN_SOCKET 换 Podman API 的 socket（默认 systemd 的 podman.socket），见 docs/ops.md 第 14 节
# OpenRouter 的 key 从仓库根目录 .env 的 OPENROUTER_API_KEY 读，写进卷里 0400 的文件（不进 configmap、不打印）；
# 管理员不预先建：空白环境第一次打开控制台时，在「设置管理员」页自己定账号和密码。
# 兼容 Podman 3.4（podman play kube）和 4.x 以上（podman kube play）。数据卷 down 时保留；要清空用 reset。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
POD=heyagent
YAML=$ROOT/deploy/pod.yaml
STATE=$ROOT/.dev/pod
# 实际 play 的 pod 描述：deploy/pod.yaml 加上桌面虚拟机的挂载（没开就是原样的一份）
RENDERED=$STATE/pod.yaml
CONFIG=$STATE/config.yaml
SECRETS=$STATE/secrets.env
KEK=${HEYAGENT_KEK_FILE:-$ROOT/.dev/kek}
API_IMAGE=localhost/heyagent-api:m1
WEB_IMAGE=localhost/heyagent-web:m1
WORKER_IMAGE=localhost/heyagent-worker:m1
BROWSER_BASE_IMAGE=localhost/heyagent-browser-base:m0
VOLUMES=(heyagent-pod-pgdata heyagent-pod-files heyagent-pod-secrets)
# M0 时主密钥放在 heyagent-pod-kek，M1 起和 OpenRouter key 一起放在 heyagent-pod-secrets；
# heyagent-pod-state 以前放管理员初始密码，改成首次设置后不用了。reset 时旧卷一起删
OLD_VOLUMES=(heyagent-pod-kek heyagent-pod-state)
PORT=8080
PUBLIC_URL=${HEYAGENT_PUBLIC_URL:-http://localhost:$PORT}
# 允许登录的来源：本机和内网另一台电脑（192.168.31.100 是开发机的内网地址）
TRUSTED_ORIGINS=${HEYAGENT_TRUSTED_ORIGINS:-http://localhost:8080,http://127.0.0.1:8080,http://192.168.31.100:8080,http://192.168.31.100:5180}

# Podman 4 起叫 podman kube play，3.4 叫 podman play kube；两边都支持 --down 和 --configmap。
# 按版本号判断：3.4 上 `podman kube play --help` 也会返回 0（打印的是别的帮助），不能拿它判断
PODMAN_MAJOR=$(podman version --format '{{.Client.Version}}' | cut -d. -f1)
if [ "$PODMAN_MAJOR" -ge 4 ]; then PLAY=(podman kube play); else PLAY=(podman play kube); fi

# shellcheck source=scripts/desktop-host.sh
. "$ROOT/scripts/desktop-host.sh"

pod_exists() { podman pod exists "$POD"; }

build() {
  if [ "${HEYAGENT_SKIP_BUILD:-0}" = "1" ]; then
    podman image exists "$API_IMAGE" && podman image exists "$WEB_IMAGE" && podman image exists "$WORKER_IMAGE" && return 0
    echo "镜像不全，还是要构建" >&2
  fi
  # 可选：本机的 pnpm store 挂进构建容器（Podman 3.4 的 buildah 不支持 RUN --mount=type=cache，所以用 podman build -v）
  local store=()
  if [ -n "${HEYAGENT_PNPM_STORE:-}" ]; then
    [ -d "$HEYAGENT_PNPM_STORE" ] || { echo "HEYAGENT_PNPM_STORE 不是目录：$HEYAGENT_PNPM_STORE" >&2; exit 1; }
    store=(-v "$HEYAGENT_PNPM_STORE:/pnpm-store" --build-arg PNPM_STORE=/pnpm-store)
    echo "== 构建用本机的 pnpm store：$HEYAGENT_PNPM_STORE"
  fi
  echo "== 构建 $API_IMAGE"
  podman build "${store[@]}" -f "$ROOT/deploy/api.Containerfile" -t "$API_IMAGE" "$ROOT"
  echo "== 构建 $WEB_IMAGE"
  podman build "${store[@]}" -f "$ROOT/deploy/web.Containerfile" -t "$WEB_IMAGE" "$ROOT"
  # worker 以浏览器基础镜像为底（M2 要用里面的 Chrome）；基础镜像下载 Chrome 等要很久，已经有了就不重建
  if ! podman image exists "$BROWSER_BASE_IMAGE"; then
    echo "== 构建 $BROWSER_BASE_IMAGE（第一次要下载 Chrome、Node、gost）"
    podman build -f "$ROOT/deploy/browser-base.Containerfile" -t "$BROWSER_BASE_IMAGE" "$ROOT/deploy"
  fi
  echo "== 构建 $WORKER_IMAGE"
  podman build "${store[@]}" -f "$ROOT/deploy/worker.Containerfile" -t "$WORKER_IMAGE" "$ROOT"
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
$(desktop_config_lines)
YAML
  desktop_render_yaml "$YAML" "$RENDERED"
}

# 卷：没有就建。主密钥和 OpenRouter key 每次 up 都重新拷进 heyagent-pod-secrets（属主 uid 1000，权限 0400）：
# api 容器的 node 用户、worker 容器的 browser 用户都是 uid 1000。文件卷、状态卷的属主也改成 uid 1000，api 和 worker 才写得进去。
# 拷的时候用容器里的 root（rootless 下就是宿主机上的你），所以读得到 600 的 .dev/kek。
# OpenRouter key 经标准输入传进容器，不出现在命令行参数和日志里；.env 里没有 key 就删掉卷里的旧文件（api 启动时跳过接入）
ensure_volumes() {
  [ -f "$KEK" ] || HEYAGENT_KEK_FILE="$KEK" "$ROOT/scripts/dev-kek.sh"
  for volume in "${VOLUMES[@]}"; do
    podman volume exists "$volume" || podman volume create "$volume" >/dev/null
  done
  podman run --rm --user 0 --entrypoint sh \
    -v heyagent-pod-secrets:/secrets -v heyagent-pod-files:/files -v "$KEK":/src/kek:ro \
    "$API_IMAGE" -c 'install -o 1000 -g 1000 -m 0400 /src/kek /secrets/kek && chown 1000:1000 /files'
  local key
  key=$(grep -E '^OPENROUTER_API_KEY=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)
  if [ -n "$key" ]; then
    printf '%s' "$key" | podman run --rm -i --user 0 --entrypoint sh -v heyagent-pod-secrets:/secrets "$API_IMAGE" \
      -c 'umask 077; cat > /secrets/openrouter-key.tmp && chown 1000:1000 /secrets/openrouter-key.tmp && chmod 0400 /secrets/openrouter-key.tmp && mv -f /secrets/openrouter-key.tmp /secrets/openrouter-key'
    echo "OpenRouter key 已写进卷 heyagent-pod-secrets（0400，没有打印）"
  else
    podman run --rm --user 0 --entrypoint sh -v heyagent-pod-secrets:/secrets "$API_IMAGE" -c 'rm -f /secrets/openrouter-key'
    echo ".env 里没有 OPENROUTER_API_KEY：不自动接入 OpenRouter，登录后在「模型」页手动加"
  fi
  unset key
}

# 空白环境（一个账号都没有）：提示去控制台设置管理员
show_setup_hint() {
  if curl -fsS "http://127.0.0.1:$PORT/api/setup" 2>/dev/null | grep -q '"needed":true'; then
    echo "还没有任何账号：打开控制台，在「设置管理员」页填管理员的名字、邮箱和密码"
  fi
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
  ensure_volumes
  if pod_exists; then
    echo "== pod $POD 已经在了，先停掉重建（数据卷保留）"
    stop_pod
  fi
  local network=()
  if desktop_enabled; then
    echo "== 系统开的桌面：存放位置 $(desktop_roots | paste -sd, -)"
    desktop_check || { echo "桌面虚拟机的准备没通过（上面 ✗ 的项），先处理，或者去掉 HEYAGENT_DESKTOP_STORAGE_ROOTS" >&2; exit 1; }
    network=(--network "$DESKTOP_NETWORK")
  fi
  echo "== ${PLAY[*]} ${network[*]} .dev/pod/pod.yaml"
  "${PLAY[@]}" "${network[@]}" --configmap "$CONFIG" "$RENDERED"
  wait_healthy
  if [ "${HEYAGENT_SEED_DEMO:-0}" = "1" ]; then
    echo "== 灌演示数据"
    podman exec -e HEYAGENT_SEED_DEMO=1 "$POD-api" node dist/seed/cli.js
  fi
  show_setup_hint
  wait_worker
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo "整套已启动：http://localhost:$PORT${ip:+ ，内网 http://$ip:$PORT}"
}

# worker 等 api 健康后才起；看它的日志确认已经开始干活。
# 不用 grep -q：它匹配到就关管道，日志长时 podman logs 收到 SIGPIPE（141），在 pipefail 下整条管道算失败，永远判不成功
wait_worker() {
  echo -n "等 worker 启动 "
  for _ in $(seq 1 60); do
    if podman logs "$POD-worker" 2>&1 | grep "HeyAgent worker 已启动" >/dev/null; then
      echo " 就绪"
      return 0
    fi
    echo -n "."
    sleep 1
  done
  echo
  echo "60 秒内 worker 没有启动，看日志：scripts/pod.sh logs worker" >&2
  exit 1
}

# 停 pod 并删掉（数据卷保留）。要一个个停，不能直接 podman pod stop：
# pod 共享 PID 命名空间（pod.yaml 的 shareProcessNamespace，给 worker 回收僵尸进程用），PID 1 是 infra（pause）。
# pod stop 会把 infra 和其他容器同时停，pause 一退出，内核就把命名空间里剩下的进程全部强杀，
# 正在写关机检查点的 postgres 也在里面，下次启动要做崩溃恢复（2026-10-28、10-29 重建时都遇到，-t 再大也没用）。
# 所以：先停 web、worker、api（数据库没了连接），再单独停 postgres，给 60 秒写完关机检查点
# （开发机的盘慢，实测要十几秒，默认 10 秒会被强杀），infra 这时还活着；最后才 pod stop、play kube --down 删除。
# 容器不存在（第一次部署、上次没起全）就跳过
stop_pod() {
  local name clients=()
  for name in web worker api; do
    if podman container exists "$POD-$name"; then clients+=("$POD-$name"); fi
  done
  if [ "${#clients[@]}" -gt 0 ]; then
    podman stop -t 30 "${clients[@]}" >/dev/null
  fi
  if podman container exists "$POD-postgres"; then
    podman stop -t 60 "$POD-postgres" >/dev/null
  fi
  if pod_exists; then
    podman pod stop -t 60 "$POD" >/dev/null
    "${PLAY[@]}" --down "$YAML" >/dev/null
  fi
}

down() {
  if pod_exists; then
    stop_pod
    echo "已停止并删除 pod $POD（数据卷 ${VOLUMES[*]} 保留）"
  else
    echo "pod $POD 不存在"
  fi
}

# 回到空白环境：停 pod、删全部数据卷（数据库、文件、主密钥副本）。.dev/kek 和 .dev/pod/secrets.env 保留
reset() {
  down
  local volume
  for volume in "${VOLUMES[@]}" "${OLD_VOLUMES[@]}"; do
    if podman volume exists "$volume"; then
      podman volume rm "$volume" >/dev/null
      echo "已删除卷 $volume"
    fi
  done
}

logs() {
  if [ -n "${1:-}" ]; then
    exec podman logs -f "$POD-$1"
  fi
  for name in postgres api worker web; do
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
  reset) reset ;;
  logs) logs "${2:-}" ;;
  status) status ;;
  *) echo "用法：$0 up | down | reset | logs [postgres|api|worker|web] | status" >&2; exit 2 ;;
esac
