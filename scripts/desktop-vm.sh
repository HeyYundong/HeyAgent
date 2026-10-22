#!/usr/bin/env bash
# 桌面虚拟机：在这台 Linux 上用 rootless Podman + KVM 起一台 Windows 11（docker.io/dockurr/windows，固定版本），
# 第一次开机时自动装 Python 3.14、Windows-MCP 0.8.8 和本仓库的桌面服务（OEM 脚本调 apps/desktop-agent/install.ps1）。
# 说明见 docs/ops.md「桌面」一节、docs/dev/desktop.md 第 8 节。
#
# 用法：scripts/desktop-vm.sh up | down | status | prepare [选项]
#   up      建好并启动（已经建过就只启动）；第一次要下载 Windows 镜像、装系统，SSD 上大约 20～40 分钟，机械盘 2 小时
#   down    关机（给 Windows 2 分钟正常关机）
#   status  看容器状态、两个服务通不通
#   prepare 只准备密钥和安装文件（<storage>/oem），不起虚拟机（检查用）
# 选项（都有默认值）：
#   --name NAME           容器名，默认 heyagent-desktop-1
#   --storage DIR         虚拟机盘和安装文件放哪，默认 ~/heyagent-desktops/<NAME>（要放 SSD）
#   --ram 8G              内存
#   --cpus 4              CPU 核数
#   --disk 64G            系统盘大小（建好后改不了）
#   --bind 127.0.0.1      端口绑在哪个地址；HeyAgent 服务器在别的机器上时填本机内网 IP
#   --mcp-port 8000       Windows-MCP 映射到本机的端口
#   --agent-port 8001     桌面服务映射到本机的端口
#   --web-port 8006       网页版屏幕（看装系统的进度，dockur 自带，没有密码，所以只绑 127.0.0.1）；0 = 不映射
#   --key-file FILE       密钥文件；不给就用 <storage>/key，没有就生成一个
#   --language Chinese    Windows 语言（dockur 的 LANGUAGE），--region zh-CN、--keyboard zh-CN 同理
#   --dry-run             只打印要执行的 podman 命令，不做任何改动
# 前提：当前用户在 kvm 组（sudo usermod -aG kvm $USER，重新登录；没重新登录时脚本会自动用 sg kvm 再跑一遍）。
set -euo pipefail

# dockur/windows 6.06（2026-10-05）。用摘要锁死：标签可能被重新指向
IMAGE=docker.io/dockurr/windows@sha256:16fd7c39a3e48bb946d29c59dc6015942e5b900a1fa5d7e5552053bfc48ee2ea
PYTHON_VERSION=3.14.8
PYTHON_SHA256=759be887b96e736a3ca886daf8d575f18fcae1a09efab6902f42d59e8999f8ef
PYTHON_URL="https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-amd64.exe"
VM_USER=heyagent

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
AGENT_DIR="$ROOT/apps/desktop-agent"

NAME=heyagent-desktop-1
STORAGE=""
RAM=8G
CPUS=4
DISK=64G
BIND=127.0.0.1
MCP_PORT=8000
AGENT_PORT=8001
WEB_PORT=8006
KEY_FILE=""
LANGUAGE=Chinese
REGION=zh-CN
KEYBOARD=zh-CN
DRY_RUN=0

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() { echo "错误：$*" >&2; exit 1; }

[ $# -ge 1 ] || { usage; exit 1; }
COMMAND=$1
shift
ORIGINAL_ARGS=("$@")
while [ $# -gt 0 ]; do
  case $1 in
    --name) NAME=$2; shift 2 ;;
    --storage) STORAGE=$2; shift 2 ;;
    --ram) RAM=$2; shift 2 ;;
    --cpus) CPUS=$2; shift 2 ;;
    --disk) DISK=$2; shift 2 ;;
    --bind) BIND=$2; shift 2 ;;
    --mcp-port) MCP_PORT=$2; shift 2 ;;
    --agent-port) AGENT_PORT=$2; shift 2 ;;
    --web-port) WEB_PORT=$2; shift 2 ;;
    --key-file) KEY_FILE=$2; shift 2 ;;
    --language) LANGUAGE=$2; shift 2 ;;
    --region) REGION=$2; shift 2 ;;
    --keyboard) KEYBOARD=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "不认识的参数 $1（--help 看用法）" ;;
  esac
done
[[ $NAME =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || die "--name 只能有字母、数字、点、下划线、横线"
STORAGE=${STORAGE:-$HOME/heyagent-desktops/$NAME}
KEY_FILE=${KEY_FILE:-$STORAGE/key}
for port in "$MCP_PORT" "$AGENT_PORT" "$WEB_PORT"; do
  [[ $port =~ ^[0-9]+$ ]] && [ "$port" -le 65535 ] || die "端口不对：$port"
done

# 打印并执行；--dry-run 时只打印
run() {
  printf '+'; printf ' %q' "$@"; printf '\n'
  [ "$DRY_RUN" = 1 ] || "$@"
}

exists() { podman container exists "$NAME" 2>/dev/null; }
running() { [ "$(podman inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; }

# /dev/kvm 属于 kvm 组：加进组后没重新登录时，用 sg kvm 带上这个组再跑一遍本脚本
ensure_kvm() {
  [ -e /dev/kvm ] || die "没有 /dev/kvm：这台机器不支持（或没开）硬件虚拟化"
  [ -r /dev/kvm ] && [ -w /dev/kvm ] && return 0
  if [ "$DRY_RUN" = 1 ]; then
    echo "（当前登录打不开 /dev/kvm：真正执行时会用 sg kvm 重新执行本脚本）"
    return 0
  fi
  if getent group kvm | cut -d: -f4 | tr ',' '\n' | grep -qx "$(id -un)"; then
    [ -z "${HEYAGENT_DESKTOP_VM_SG:-}" ] || die "sg kvm 之后还是打不开 /dev/kvm"
    echo "当前登录还没带上 kvm 组，用 sg kvm 重新执行"
    local command
    command=$(printf ' %q' "$0" "$COMMAND" "${ORIGINAL_ARGS[@]}")
    exec env HEYAGENT_DESKTOP_VM_SG=1 sg kvm -c "$command"
  fi
  die "当前用户不在 kvm 组：sudo usermod -aG kvm $(id -un)，然后重新登录"
}

ensure_key() {
  if [ -f "$KEY_FILE" ]; then
    local key
    key=$(tr -d '[:space:]' <"$KEY_FILE")
    [ ${#key} -ge 16 ] || die "密钥文件 $KEY_FILE 里的密钥太短（至少 16 位）"
    return 0
  fi
  echo "生成密钥：$KEY_FILE"
  [ "$DRY_RUN" = 1 ] && return 0
  mkdir -p "$(dirname "$KEY_FILE")"
  (umask 077 && head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$KEY_FILE")
}

# Windows 的用户名和密码：虚拟机自动登录，平时用不到，存在 <storage>/vm.env 里以防要手动登录。
# 用 --env-file 传给容器，免得密码出现在命令行和终端输出里
ensure_vm_env() {
  local file="$STORAGE/vm.env"
  [ -f "$file" ] && return 0
  [ "$DRY_RUN" = 1 ] && return 0
  mkdir -p "$STORAGE"
  (umask 077 && printf 'USERNAME=%s\nPASSWORD=Ha-%s\n' "$VM_USER" "$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')" >"$file")
}

# OEM 目录：dockur 装好系统后第一次登录时，以管理员身份跑里面的 install.bat
prepare_oem() {
  local oem="$STORAGE/oem" installer="$STORAGE/oem/python-${PYTHON_VERSION}-amd64.exe"
  echo "准备安装文件：$oem"
  [ "$DRY_RUN" = 1 ] && return 0
  # shared：虚拟机里桌面上的「Shared」文件夹（dockur 的共享目录），更新桌面服务时往里拷新代码
  mkdir -p "$oem" "$STORAGE/disk" "$STORAGE/shared"
  chmod 700 "$STORAGE" "$oem"
  if [ ! -f "$installer" ] || ! echo "$PYTHON_SHA256  $installer" | sha256sum -c --quiet - 2>/dev/null; then
    echo "下载 Python $PYTHON_VERSION 安装包"
    curl -fL --progress-bar --retry 3 -o "$installer.part" "$PYTHON_URL"
    echo "$PYTHON_SHA256  $installer.part" | sha256sum -c --quiet - || die "Python 安装包的 sha256 不对"
    mv "$installer.part" "$installer"
  fi
  rm -rf "$oem/desktop-agent"
  mkdir -p "$oem/desktop-agent"
  (cd "$AGENT_DIR" && tar --exclude=__pycache__ --exclude=tests --exclude='*.egg-info' --exclude=.gitignore -cf - .) | tar -xf - -C "$oem/desktop-agent"
  tr -d '[:space:]' <"$KEY_FILE" >"$oem/key"
  chmod 600 "$oem/key"
  # cmd 要 CRLF；只用 ASCII，免得代码页不对
  printf '%s\r\n' \
    '@echo off' \
    'rem HeyAgent desktop: run once by dockur at the first logon (auto-logon user, elevated).' \
    'set LOG=C:\OEM\heyagent-install.log' \
    'echo [%date% %time%] install Python >> %LOG%' \
    "start \"\" /wait C:\\OEM\\python-${PYTHON_VERSION}-amd64.exe /quiet InstallAllUsers=1 PrependPath=1 Include_test=0 >> %LOG% 2>&1" \
    'echo [%date% %time%] run install.ps1 >> %LOG%' \
    'powershell -NoProfile -ExecutionPolicy Bypass -File C:\OEM\desktop-agent\install.ps1 -KeyFile C:\OEM\key -Python "C:\Program Files\Python314\python.exe" >> %LOG% 2>&1' \
    'echo [%date% %time%] install.ps1 exit %errorlevel% >> %LOG%' \
    'del /f /q C:\OEM\key' \
    >"$oem/install.bat"
}

cmd_up() {
  command -v podman >/dev/null || die "没有 podman"
  if exists; then
    if running; then echo "$NAME 已经在运行"; else run podman start "$NAME"; fi
    print_next
    return 0
  fi
  ensure_kvm
  ensure_key
  ensure_vm_env
  prepare_oem
  local ports=(-p "$BIND:$MCP_PORT:8000" -p "$BIND:$AGENT_PORT:8001")
  # 网页版屏幕没有密码：只给本机看（别的机器上看就 ssh -L 转发）
  [ "$WEB_PORT" != 0 ] && ports+=(-p "127.0.0.1:$WEB_PORT:8006")
  # slirp4netns:port_handler=slirp4netns：rootless Podman 3.4 默认的 rootlessport 在 sg kvm 下起不来
  # keep-groups：容器里的 QEMU 要用宿主机的 kvm 组打开 /dev/kvm
  # USER_PORTS：dockur 把容器的这两个端口转进 Windows（install.ps1 默认的 8000 / 8001）
  run podman run -d --name "$NAME" \
    --network slirp4netns:port_handler=slirp4netns --group-add keep-groups \
    --device /dev/kvm --device /dev/net/tun --cap-add NET_ADMIN --stop-timeout 120 \
    -e VERSION=11 -e LANGUAGE="$LANGUAGE" -e REGION="$REGION" -e KEYBOARD="$KEYBOARD" \
    -e RAM_SIZE="$RAM" -e CPU_CORES="$CPUS" -e DISK_SIZE="$DISK" \
    --env-file "$STORAGE/vm.env" -e USER_PORTS=8000,8001 \
    "${ports[@]}" \
    -v "$STORAGE/disk:/storage:Z" -v "$STORAGE/oem:/oem:Z" -v "$STORAGE/shared:/shared:Z" \
    "$IMAGE"
  print_next
}

print_next() {
  cat <<EOF

虚拟机第一次启动要下载 Windows、装系统，再自动装 Python 和两个服务（安装日志在虚拟机里的 C:\\OEM\\heyagent-install.log）。
$([ "$WEB_PORT" != 0 ] && echo "看进度：在这台机器上用浏览器打开 http://127.0.0.1:$WEB_PORT（别的电脑：ssh -L $WEB_PORT:127.0.0.1:$WEB_PORT 这台机器）")
装好后：scripts/desktop-vm.sh status --name $NAME --storage $STORAGE
在控制台「桌面」页登记（HeyAgent 服务器连得到的地址）：
  MCP 地址：      http://<本机地址>:$MCP_PORT/mcp
  桌面服务地址：  http://<本机地址>:$AGENT_PORT
  密钥：          $KEY_FILE 里的内容
EOF
}

cmd_down() {
  exists || die "没有容器 $NAME"
  run podman stop -t 120 "$NAME"
}

cmd_status() {
  if ! exists; then echo "没有容器 $NAME"; return 1; fi
  podman ps -a --filter "name=^${NAME}\$" --format '{{.Names}}  {{.Status}}  {{.Ports}}'
  running || return 0
  local key code
  key=$( [ -f "$KEY_FILE" ] && tr -d '[:space:]' <"$KEY_FILE" || true)
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://$BIND:$MCP_PORT/mcp" || true)
  # 不带密钥应该是 401：说明 Windows-MCP 在跑而且要密钥
  echo "Windows-MCP  http://$BIND:$MCP_PORT/mcp  $([ "$code" = 401 ] && echo 在运行 || echo "没响应（HTTP $code），可能还在装")"
  if [ -n "$key" ]; then
    echo "桌面服务     http://$BIND:$AGENT_PORT  $(curl -s -m 10 -H "Authorization: Bearer $key" "http://$BIND:$AGENT_PORT/health" || echo 没响应，可能还在装)"
  fi
}

case $COMMAND in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  prepare) ensure_key && ensure_vm_env && prepare_oem ;;
  -h|--help|help) usage ;;
  *) usage; exit 1 ;;
esac
