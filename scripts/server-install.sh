#!/usr/bin/env bash
# HeyAgent 正式服务器的安装（Ubuntu 24.04 + Podman 4.4 以上，普通用户 rootless 运行，Quadlet 交给 systemd 管理）。
# 可以重复执行：已经有的 secret、卷、配置都不动，只补缺的；镜像和单元文件每次按当前代码更新，最后重启服务。
# 步骤：检查环境 → 构建镜像 → 创建 Podman secret → 建数据卷 → 装 Quadlet 和备份定时器 → 启动 → 等健康检查 → 提示打开控制台设置管理员。
#
# 用法：在仓库目录里（建议放在 ~/heyagent）运行 scripts/server-install.sh
# 可选的环境变量：
#   HEYAGENT_OPENROUTER_KEY_FILE=<文件>  从这个文件读 OpenRouter 的 key（读完提示删掉）。不给时：第一次安装在终端里问（不回显，可以留空）
#   HEYAGENT_KEK_IMPORT=<文件>           用这个文件当主密钥（恢复到新服务器、主密钥轮换时用，见 docs/ops.md）。
#                                        服务在跑时会先核对它能解开库里所有密文，解不开就拒绝
#   HEYAGENT_SKIP_BUILD=1                镜像已经有了就不重新构建（只换 secret、改配置时省时间）
# 配置（端口、对外地址、备份目录）在 ~/.config/heyagent/heyagent.env，第一次运行时生成，改完再跑一次本脚本生效。
#
# 不会打印、也不会写进命令行参数的：主密钥、OpenRouter key、数据库密码、登录签名密钥。
# scripts/deploy.sh 会 source 这个文件来复用里面的函数（只定义函数，不执行安装）。
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
XDG_CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}
CONFIG_DIR=$XDG_CONFIG/heyagent
CONFIG_ENV=$CONFIG_DIR/heyagent.env
QUADLET_DIR=$XDG_CONFIG/containers/systemd
SYSTEMD_USER_DIR=$XDG_CONFIG/systemd/user
SERVICE=heyagent.service
POD=heyagent
IMAGES=(api web worker)
BROWSER_BASE_IMAGE=localhost/heyagent-browser-base:m0
HELPER_IMAGE=docker.io/pgvector/pgvector:0.8.7-pg18-trixie
VOLUMES=(heyagent-pod-pgdata heyagent-pod-files)
MIN_PODMAN=4.4.0

log() { echo "== $*"; }
warn() { echo "⚠ $*" >&2; }
die() { echo "✗ $*" >&2; exit 1; }
is_tty() { [ -t 0 ] && [ -t 1 ]; }

# ---------- 配置 ----------

# heyagent.env：没有就按默认值生成。systemd 的 EnvironmentFile 也读它（备份定时器），所以只写「键=值」，不用 shell 语法
load_config() {
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  if [ ! -f "$CONFIG_ENV" ]; then
    cat > "$CONFIG_ENV" <<EOF
# HeyAgent 服务器配置（scripts/server-install.sh 生成）。改完重新跑 scripts/server-install.sh 生效。这里没有任何密码。
# 对外端口。普通用户不能用 1024 以下的端口，要用 80 先看 docs/ops.md「用 80 端口」
HEYAGENT_PORT=8080
# 控制台对外的地址（同事在浏览器里输入的那个），留空 = http://<本机第一个内网 IP>:<端口>
HEYAGENT_PUBLIC_URL=
# 允许登录的来源，逗号隔开，留空 = 对外地址 + http://localhost:<端口> + http://127.0.0.1:<端口>
HEYAGENT_TRUSTED_ORIGINS=
# 备份目录（可以是另一块盘或 NAS 的挂载点）和保留天数
HEYAGENT_BACKUP_DIR=$HOME/heyagent-backups
HEYAGENT_BACKUP_KEEP_DAYS=14
EOF
    chmod 600 "$CONFIG_ENV"
    echo "已生成配置 $CONFIG_ENV（默认值，可以改完再跑一次）"
  fi
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG_ENV"
  set +a
  PORT=${HEYAGENT_PORT:-8080}
  case "$PORT" in '' | *[!0-9]*) die "HEYAGENT_PORT 要是数字，现在是「$PORT」" ;; esac
  if [ -z "${HEYAGENT_PUBLIC_URL:-}" ]; then
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    HEYAGENT_PUBLIC_URL=http://${ip:-localhost}:$PORT
  fi
  PUBLIC_URL=${HEYAGENT_PUBLIC_URL%/}
  TRUSTED_ORIGINS=${HEYAGENT_TRUSTED_ORIGINS:-$PUBLIC_URL,http://localhost:$PORT,http://127.0.0.1:$PORT}
}

# ---------- 1. 检查环境 ----------

check_env() {
  [ "$(id -u)" != "0" ] || die "不要用 root 跑：HeyAgent 用普通用户 rootless 运行（建一个专门的用户，见 docs/ops.md）"
  command -v podman >/dev/null || die "没有 podman：sudo apt install podman"
  local version
  version=$(podman version --format '{{.Client.Version}}')
  if [ "$(printf '%s\n' "$MIN_PODMAN" "$version" | sort -V | head -1)" != "$MIN_PODMAN" ]; then
    die "Podman 是 $version，要 $MIN_PODMAN 以上（Quadlet 和 kube play 的 secret 卷）。Ubuntu 24.04 自带的是 4.9"
  fi
  echo "Podman $version"
  command -v curl >/dev/null || die "没有 curl：sudo apt install curl"
  grep -q "^$(id -un):" /etc/subuid 2>/dev/null || die "/etc/subuid 里没有 $(id -un)：rootless Podman 要它（sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $(id -un)）"
  systemctl --user show-environment >/dev/null 2>&1 ||
    die "连不上 systemd 用户实例：要直接用这个用户登录（ssh），不要 sudo su 过来；或者用 machinectl shell $(id -un)@"
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != "yes" ]; then
    if loginctl enable-linger "$(id -un)" 2>/dev/null; then
      echo "已开启 linger：没人登录时服务也会跑、开机自启"
    else
      warn "没开 linger：退出登录后服务会停，开机也不会自启。请管理员执行：sudo loginctl enable-linger $(id -un)"
    fi
  fi
  if [ "$PORT" -lt 1024 ]; then
    local start
    start=$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo 1024)
    [ "$PORT" -ge "$start" ] || die "普通用户不能用 $PORT 端口（net.ipv4.ip_unprivileged_port_start=$start）。见 docs/ops.md「用 80 端口」"
  fi
  # Ubuntu 24.04 默认限制非特权的 user namespace（AppArmor），可能让 worker 里 Chrome 的沙箱起不来。只提醒，不拦
  if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
    warn "kernel.apparmor_restrict_unprivileged_userns=1：如果任务里的浏览器打不开（日志里有 sandbox / namespace 的错），见 docs/ops.md 常见问题"
  fi
}

# ---------- 2. 镜像 ----------

image_id() { podman image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }

# 先全部构建成 :build，都成功了才换上 :current，原来的 :current 留成 :previous（scripts/deploy.sh rollback 用）
build_images() {
  if [ "${HEYAGENT_SKIP_BUILD:-0}" = "1" ]; then
    local name missing=0
    for name in "${IMAGES[@]}"; do podman image exists "localhost/heyagent-$name:current" || missing=1; done
    if [ "$missing" = 0 ]; then
      echo "HEYAGENT_SKIP_BUILD=1：沿用现有镜像"
      return 0
    fi
    warn "镜像不全，还是要构建"
  fi
  podman image exists "$HELPER_IMAGE" || podman pull "$HELPER_IMAGE"
  if ! podman image exists "$BROWSER_BASE_IMAGE"; then
    log "构建 $BROWSER_BASE_IMAGE（第一次要下载 Chrome、Node、gost，比较久）"
    podman build -f "$ROOT/deploy/browser-base.Containerfile" -t "$BROWSER_BASE_IMAGE" "$ROOT/deploy"
  fi
  local name
  for name in "${IMAGES[@]}"; do
    log "构建 localhost/heyagent-$name"
    podman build -f "$ROOT/deploy/$name.Containerfile" -t "localhost/heyagent-$name:build" "$ROOT"
  done
  for name in "${IMAGES[@]}"; do
    local image=localhost/heyagent-$name
    if [ "$(image_id "$image:build")" != "$(image_id "$image:current")" ]; then
      if podman image exists "$image:current"; then podman tag "$image:current" "$image:previous"; fi
      podman tag "$image:build" "$image:current"
    fi
    podman untag "$image:build" "$image:build" 2>/dev/null || podman rmi "$image:build" >/dev/null 2>&1 || true
  done
  # 不自动 podman image prune：没有标签的中间层就是构建缓存，删了下次升级要从头装依赖。占地方了按 docs/ops.md 手动清
}

# ---------- 3. Podman secret ----------

secret_exists() { podman secret inspect "$1" >/dev/null 2>&1; }
random_secret() { head -c 48 /dev/urandom | base64 -w0 | tr -d '/+=' | cut -c1-40; }

# 把文件内容存成 Podman secret。内容是一份 Kubernetes Secret（kube play 的 secret 卷要这个格式），键名就是容器里的文件名。
# 值只在 shell 变量和管道里过，不进命令行参数（printf 是 bash 内建命令）
put_secret_file() {
  local name=$1 key=$2 file=$3 b64
  b64=$(base64 -w0 < "$file")
  put_secret_b64 "$name" "$key" "$b64"
}
put_secret_b64() {
  local name=$1 key=$2 b64=$3
  if secret_exists "$name"; then podman secret rm "$name" >/dev/null; fi
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\ntype: Opaque\ndata:\n  %s: "%s"\n' "$name" "$key" "$b64" |
    podman secret create "$name" - >/dev/null
}

# KEK 文件的格式：每行「版本号:base64(32 字节)」，# 开头是注释（apps/server/src/lib/crypto.ts）
check_kek_file() {
  local file=$1 line n=0 len
  [ -r "$file" ] || die "读不了 $file"
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in '' | '#'*) continue ;; esac
    [[ "$line" =~ ^[0-9]+:[A-Za-z0-9+/=]+$ ]] || die "$file 格式不对：每行应该是「版本号:base64」"
    len=$(printf '%s' "${line#*:}" | base64 -d 2>/dev/null | wc -c)
    [ "$len" = 32 ] || die "$file 里 v${line%%:*} 不是 32 字节"
    n=$((n + 1))
  done < "$file"
  [ "$n" -gt 0 ] || die "$file 里没有密钥"
}

ensure_secrets() {
  umask 077
  if ! secret_exists heyagent-db; then
    put_secret_b64 heyagent-db postgres-password "$(random_secret | base64 -w0)"
    echo "已生成数据库密码（Podman secret heyagent-db）"
  fi
  if ! secret_exists heyagent-auth; then
    put_secret_b64 heyagent-auth better-auth-secret "$(random_secret | base64 -w0)"
    echo "已生成登录签名密钥（Podman secret heyagent-auth）"
  fi
  ensure_kek
  ensure_openrouter
}

ensure_kek() {
  if [ -n "${HEYAGENT_KEK_IMPORT:-}" ]; then
    check_kek_file "$HEYAGENT_KEK_IMPORT"
    # 服务在跑：新文件必须能解开库里现有的全部密文（防止拿错文件、或者轮换时漏了旧版本）
    if podman container exists "$POD-api" && [ "$(podman container inspect -f '{{.State.Running}}' "$POD-api")" = "true" ]; then
      echo "核对新的主密钥能不能解开库里的密文…"
      podman exec -i "$POD-api" node dist/scripts/kek-rotate.js status --keyfile - < "$HEYAGENT_KEK_IMPORT" ||
        die "用 $HEYAGENT_KEK_IMPORT 解不开库里的密文，没有替换主密钥"
    fi
    put_secret_file heyagent-kek kek "$HEYAGENT_KEK_IMPORT"
    echo "已用 $HEYAGENT_KEK_IMPORT 设置主密钥（Podman secret heyagent-kek）"
    echo "  确认离线备份里有这份文件后，删掉服务器上的这份：shred -u $HEYAGENT_KEK_IMPORT"
    return 0
  fi
  secret_exists heyagent-kek && return 0
  local out=$CONFIG_DIR/kek-BACKUP-THEN-DELETE
  [ ! -e "$out" ] || die "$out 已经存在，但 Podman secret heyagent-kek 没有：确认它就是主密钥后，用 HEYAGENT_KEK_IMPORT=$out 再跑"
  {
    echo "# HeyAgent 主密钥（KEK），$(date +%F) 在 $(hostname) 生成。丢了就解不开库里的密钥和登录态，离线保管两份"
    echo "1:$(head -c 32 /dev/urandom | base64 -w0)"
  } > "$out"
  chmod 600 "$out"
  put_secret_file heyagent-kek kek "$out"
  cat <<EOF

★★★ 已生成主密钥（Podman secret heyagent-kek），另存了一份在：
    $out
  现在就把它拷到两处离线的地方（例如两个 U 盘，由两个人分别保管），然后删掉服务器上的这份：
    shred -u $out
  丢了主密钥，库里所有的密钥和浏览器登录态都解不开，只能全部重新录入。备份里不含主密钥。

EOF
  if is_tty; then read -r -p "离线备份好了按回车继续…" _; fi
}

ensure_openrouter() {
  if [ -n "${HEYAGENT_OPENROUTER_KEY_FILE:-}" ]; then
    [ -s "$HEYAGENT_OPENROUTER_KEY_FILE" ] || die "$HEYAGENT_OPENROUTER_KEY_FILE 是空的或不存在"
    local b64
    b64=$(tr -d '\r\n' < "$HEYAGENT_OPENROUTER_KEY_FILE" | base64 -w0)
    put_secret_b64 heyagent-openrouter openrouter-key "$b64"
    echo "已设置 OpenRouter key（Podman secret heyagent-openrouter）。现在删掉这个文件：shred -u $HEYAGENT_OPENROUTER_KEY_FILE"
    return 0
  fi
  secret_exists heyagent-openrouter && return 0
  local key=""
  if is_tty; then
    echo "OpenRouter 的 key（以 sk-or- 开头）：第一次启动时自动接入并设好默认模型。也可以留空，以后在控制台「模型」页加。"
    read -r -s -p "粘贴后回车（不回显）：" key
    echo
  fi
  # 空的也建一个：pod 描述里引用了它。api 读到空文件会在日志里提示一句，不影响启动
  put_secret_b64 heyagent-openrouter openrouter-key "$(printf '%s' "$key" | base64 -w0)"
  if [ -n "$key" ]; then echo "已设置 OpenRouter key（Podman secret heyagent-openrouter）"; else echo "没填 OpenRouter key：以后在控制台「模型」页加"; fi
  unset key
}

# ---------- 4. 数据卷 ----------

# api（node）和 worker（browser）都是 uid 1000，文件卷要归它；数据库卷由 postgres 镜像自己处理
ensure_volumes() {
  local volume
  for volume in "${VOLUMES[@]}"; do
    podman volume exists "$volume" || { podman volume create "$volume" >/dev/null && echo "已建卷 $volume"; }
  done
  podman run --rm --user 0 --network none --entrypoint chown \
    -v heyagent-pod-files:/files "$HELPER_IMAGE" 1000:1000 /files
}

# ---------- 5. Quadlet 和备份定时器 ----------

install_units() {
  mkdir -p "$QUADLET_DIR" "$SYSTEMD_USER_DIR"
  local yaml=$QUADLET_DIR/heyagent.yaml
  # 端口：只改 web 容器那一行 hostPort
  sed "s/^\(\s*hostPort:\) 8080$/\1 $PORT/" "$ROOT/deploy/quadlet/heyagent.yaml" > "$yaml.tmp"
  [ "$(grep -c "hostPort: $PORT\$" "$yaml.tmp")" = 1 ] || die "改写 heyagent.yaml 的端口失败"
  mv -f "$yaml.tmp" "$yaml"
  cp -f "$ROOT/deploy/quadlet/heyagent.kube" "$QUADLET_DIR/heyagent.kube"
  cat > "$QUADLET_DIR/heyagent-config.yaml" <<EOF
# scripts/server-install.sh 按 $CONFIG_ENV 生成，不要手改（改那个文件再跑一次安装）。这里没有密码。
apiVersion: v1
kind: ConfigMap
metadata:
  name: heyagent-config
data:
  BETTER_AUTH_URL: "$PUBLIC_URL"
  TRUSTED_ORIGINS: "$TRUSTED_ORIGINS"
  TZ: "Asia/Shanghai"
EOF
  # 备份单元里写的是默认位置 %h/heyagent，仓库放在别处时换成实际路径
  local unit
  for unit in heyagent-backup.service heyagent-backup.timer; do
    sed "s#%h/heyagent/scripts/#$ROOT/scripts/#" "$ROOT/deploy/systemd/$unit" > "$SYSTEMD_USER_DIR/$unit"
  done
  local quadlet
  for quadlet in /usr/libexec/podman/quadlet /usr/lib/podman/quadlet; do
    if [ -x "$quadlet" ]; then
      QUADLET_UNIT_DIRS=$QUADLET_DIR "$quadlet" -dryrun -user >/dev/null || die "Quadlet 解析 $QUADLET_DIR/heyagent.kube 出错（上面是原因）"
      break
    fi
  done
  systemctl --user daemon-reload
  systemctl --user cat "$SERVICE" >/dev/null 2>&1 || die "daemon-reload 后没有 $SERVICE：Quadlet 没认出 heyagent.kube（journalctl --user -b | grep -i quadlet）"
  systemctl --user enable --now heyagent-backup.timer >/dev/null 2>&1 || die "启用备份定时器失败：systemctl --user status heyagent-backup.timer"
}

# ---------- 6. 启动和健康检查 ----------

wait_healthy() {
  local seconds=${1:-300} i
  echo -n "等 http://127.0.0.1:$PORT/api/health "
  for i in $(seq 1 "$seconds"); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      echo " 就绪"
      return 0
    fi
    [ $((i % 5)) = 0 ] && echo -n "."
    sleep 1
  done
  echo
  return 1
}

wait_worker() {
  local i
  echo -n "等 worker 启动 "
  for i in $(seq 1 90); do
    if podman logs --since 10m "$POD-worker" 2>&1 | grep -q "HeyAgent worker 已启动"; then
      echo " 就绪"
      return 0
    fi
    [ $((i % 5)) = 0 ] && echo -n "."
    sleep 1
  done
  echo
  return 1
}

restart_service() {
  log "启动 $SERVICE"
  systemctl --user restart "$SERVICE" || die "启动失败：systemctl --user status $SERVICE；journalctl --user -u $SERVICE -n 100"
}

# 空白环境（一个账号都没有）：管理员不预先建，提示去控制台设置
show_setup_hint() {
  if curl -fsS "http://127.0.0.1:$PORT/api/setup" 2>/dev/null | grep -q '"needed":true'; then
    cat <<EOF

还没有任何账号：在浏览器打开 $PUBLIC_URL，在「设置管理员」页填管理员的名字、邮箱和密码。
要从备份恢复的话，直接跑 scripts/restore.sh，不用先设置管理员。
EOF
  fi
}

main() {
  load_config
  log "检查环境"
  check_env
  log "构建镜像"
  build_images
  log "Podman secret"
  ensure_secrets
  log "数据卷"
  ensure_volumes
  log "装 Quadlet（$QUADLET_DIR）和备份定时器（$SYSTEMD_USER_DIR）"
  install_units
  restart_service
  wait_healthy 300 || die "5 分钟内没有就绪，看日志：podman logs $POD-api；journalctl --user -u $SERVICE -n 100"
  wait_worker || warn "90 秒内没看到 worker 启动，看日志：podman logs $POD-worker"
  echo
  echo "HeyAgent 已启动：$PUBLIC_URL"
  echo "开机自启、挂了自动重启；每天 03:00 备份到 ${HEYAGENT_BACKUP_DIR:-$HOME/heyagent-backups}"
  show_setup_hint
}

# 被 source 时（scripts/deploy.sh）只定义函数
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
