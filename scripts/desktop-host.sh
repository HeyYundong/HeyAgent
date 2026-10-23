#!/usr/bin/env bash
# 系统开的桌面（docs/dev/desktop-vm.md、docs/ops.md 第 14 节）：宿主机的准备和检查，以及给 pod 描述加挂载、给 configmap 加配置。
#   scripts/desktop-host.sh check   只检查，逐项打印（KVM、kvm 组、Podman API socket、linger、存放位置），有不通过的退出码 1
#   scripts/desktop-host.sh setup   不用 sudo 能做的先做掉（podman.socket 的权限和开机自启、存放位置目录的属主），再 check；要 sudo 的打印命令
# 配置从环境变量读（server-install.sh 从 ~/.config/heyagent/heyagent.env 读进来）：
#   HEYAGENT_DESKTOP_STORAGE_ROOTS   存放位置，逗号隔开的绝对路径（空 = 不开虚拟机，「桌面」页只能登记已有电脑）
#   HEYAGENT_HOST_PODMAN_SOCKET      宿主机上 Podman API 的 socket，默认 $XDG_RUNTIME_DIR/podman/podman.sock（systemd 的 podman.socket）
# scripts/pod.sh 和 scripts/server-install.sh 会 source 这个文件，用下面的 desktop_* 函数（被 source 时不执行检查）。
#
# 为什么这样（2026-10-23 在开发机 Podman 3.4.4 上实测）：
# - pod 里的 api、worker 要连宿主机的 Podman API 建虚拟机的容器。容器里的 uid 1000 在宿主机上是子 uid（不是你），
#   所以 socket 要「其他人可读写」（0666）。socket 所在目录 $XDG_RUNTIME_DIR 是 0700，宿主机上别的用户还是进不去，
#   只有挂了这个目录的容器能用（能用它 = 能以你的身份管容器，和 worker 本来要干的事一样）。挂目录而不是挂 socket 文件：
#   podman.socket 重启后 socket 是新文件，挂文件的话容器里还是旧的、连不上。
# - 虚拟机的端口只绑宿主机的 127.0.0.1。pod 用 slirp4netns 的 allow_host_loopback=true，容器里连 10.0.2.2 就是宿主机的 127.0.0.1。
# - Podman 默认把容器里的 /sys/dev/block 盖成空目录，认不出 SSD / HDD：把宿主机的 /sys 只读挂到 api 的 /host/sys。
# - 容器里看不到宿主机的 /dev/kvm：HEYAGENT_DESKTOP_KVM_DEVICE 设成空串（api 不查），KVM 在这里装的时候查；
#   真没有 KVM 时虚拟机开不起来，状态是「出错」，原因里有 dockur 的日志。
# - 存放位置要归容器里的 uid 1000（worker 在里面建目录）：podman unshare chown 1000:1000 <目录>。
set -euo pipefail

DESKTOP_SOCKET_MOUNT=/run/heyagent-podman
DESKTOP_SYS_MOUNT=/host/sys
DESKTOP_VM_HOST=10.0.2.2
DESKTOP_NETWORK=slirp4netns:allow_host_loopback=true
DESKTOP_MIN_FREE_GB=${HEYAGENT_DESKTOP_MIN_FREE_GB:-40}

desktop_socket() { echo "${HEYAGENT_HOST_PODMAN_SOCKET:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock}"; }

# 存放位置一行一个（去掉空格和末尾的 /）
desktop_roots() {
  local root
  tr ',' '\n' <<< "${HEYAGENT_DESKTOP_STORAGE_ROOTS:-}" | while IFS= read -r root; do
    root=$(echo "$root" | xargs)
    [ -n "$root" ] || continue
    [ "$root" = "/" ] || root=${root%/}
    echo "$root"
  done
}

desktop_enabled() { [ -n "$(desktop_roots)" ]; }

# ---------- pod 描述和配置（pod.sh、server-install.sh 用）----------

# configmap 的 data 里加的几行（两个空格缩进）。不开虚拟机时什么也不加：api、worker 没有 HEYAGENT_PODMAN_SOCKET 就不开虚拟机
desktop_config_lines() {
  desktop_enabled || return 0
  local roots
  roots=$(desktop_roots | paste -sd, -)
  cat <<EOF
  HEYAGENT_PODMAN_SOCKET: "$DESKTOP_SOCKET_MOUNT/$(basename "$(desktop_socket)")"
  HEYAGENT_DESKTOP_STORAGE_ROOTS: "$roots"
  HEYAGENT_DESKTOP_VM_HOST: "$DESKTOP_VM_HOST"
  HEYAGENT_DESKTOP_KVM_DEVICE: ""
  HEYAGENT_DESKTOP_SYS_ROOT: "$DESKTOP_SYS_MOUNT"
  HEYAGENT_DESKTOP_RESERVED_GB: "${HEYAGENT_DESKTOP_RESERVED_GB:-24}"
EOF
  # 其他可调的（apps/server/src/desktop/vm/config.ts）：配了才传，不配用代码里的默认值
  local name
  for name in HEYAGENT_DESKTOP_PORT_RANGE HEYAGENT_DESKTOP_MIN_FREE_GB HEYAGENT_DESKTOP_PYTHON_URL HEYAGENT_DESKTOP_PYTHON_SHA256 \
    HEYAGENT_DESKTOP_IMAGE HEYAGENT_DESKTOP_VM_START_TIMEOUT_MS HEYAGENT_DESKTOP_VM_INSTALL_TIMEOUT_MS HEYAGENT_DESKTOP_VM_STOP_SECONDS; do
    if [ -n "${!name:-}" ]; then echo "  $name: \"${!name}\""; fi
  done
  return 0
}

# 把 pod 描述里的三个占位注释（# @desktop-vm:api-mounts / worker-mounts / volumes）换成挂载；不开虚拟机时原样复制
desktop_render_yaml() {
  local in=$1 out=$2
  if ! desktop_enabled; then
    cp -f "$in" "$out"
    return 0
  fi
  local api="" worker="" volumes="" i=0 root
  api+="        - name: desktop-podman"$'\n'"          mountPath: $DESKTOP_SOCKET_MOUNT"$'\n'
  api+="        - name: desktop-sys"$'\n'"          mountPath: $DESKTOP_SYS_MOUNT"$'\n'"          readOnly: true"$'\n'
  worker+="        - name: desktop-podman"$'\n'"          mountPath: $DESKTOP_SOCKET_MOUNT"$'\n'
  volumes+="    - name: desktop-podman"$'\n'"      hostPath:"$'\n'"        path: $(dirname "$(desktop_socket)")"$'\n'"        type: Directory"$'\n'
  volumes+="    - name: desktop-sys"$'\n'"      hostPath:"$'\n'"        path: /sys"$'\n'"        type: Directory"$'\n'
  while IFS= read -r root; do
    # 同路径挂进去：虚拟机容器是宿主机上的 Podman 建的，worker 给它的路径必须是宿主机上的路径
    api+="        - name: desktop-storage-$i"$'\n'"          mountPath: $root"$'\n'
    worker+="        - name: desktop-storage-$i"$'\n'"          mountPath: $root"$'\n'
    volumes+="    - name: desktop-storage-$i"$'\n'"      hostPath:"$'\n'"        path: $root"$'\n'"        type: Directory"$'\n'
    i=$((i + 1))
  done < <(desktop_roots)
  local count
  count=$(grep -cE '^\s*# @desktop-vm:(api-mounts|worker-mounts|volumes)$' "$in" || true)
  [ "$count" = 3 ] || { echo "✗ $in 里的占位注释（# @desktop-vm:…）不是 3 个，没法加桌面的挂载" >&2; return 1; }
  API="$api" WORKER="$worker" VOLUMES="$volumes" awk '
    /^\s*# @desktop-vm:api-mounts$/ { printf "%s", ENVIRON["API"]; next }
    /^\s*# @desktop-vm:worker-mounts$/ { printf "%s", ENVIRON["WORKER"]; next }
    /^\s*# @desktop-vm:volumes$/ { printf "%s", ENVIRON["VOLUMES"]; next }
    { print }
  ' "$in" > "$out"
}

# ---------- 检查和准备 ----------

DESKTOP_FAILED=0
desktop_ok() { echo "  ✓ $*"; }
desktop_bad() { echo "  ✗ $*"; DESKTOP_FAILED=1; }
desktop_warn() { echo "  ! $*"; }

desktop_kvm_gid() { getent group kvm | cut -d: -f3; }

# systemd 用户实例（podman.socket 由它起）有没有 kvm 组：加进 kvm 组之前就起了的实例没有，要重启它
desktop_manager_has_kvm() {
  local pid gid
  gid=$(desktop_kvm_gid)
  pid=$(systemctl show -p MainPID --value "user@$(id -u).service" 2>/dev/null || true)
  [ -n "$gid" ] && [ -n "$pid" ] && [ "$pid" != 0 ] && [ -r "/proc/$pid/status" ] || return 1
  awk -v gid="$gid" '/^Groups:/ { for (i = 2; i <= NF; i++) if ($i == gid) found = 1 } END { exit found ? 0 : 1 }' "/proc/$pid/status"
}

# 经 socket 起一个一次性的容器，看里面能不能读写 /dev/kvm（和 worker 建虚拟机容器的写法一样：keep_original_groups）
desktop_kvm_through_socket() {
  local socket=$1 image=$2
  podman --remote --url "unix://$socket" run --rm --network none --device /dev/kvm \
    --annotation run.oci.keep_original_groups=1 --entrypoint sh "$image" -c 'test -r /dev/kvm && test -w /dev/kvm' >/dev/null 2>&1
}

# 用来做上面那个测试的镜像：本机已有的就行，不为它下载
desktop_probe_image() {
  local image
  for image in "${HEYAGENT_DESKTOP_PROBE_IMAGE:-}" localhost/heyagent-api:current localhost/heyagent-api:m1 docker.io/pgvector/pgvector:0.8.7-pg18-trixie; do
    [ -n "$image" ] && podman image exists "$image" 2>/dev/null && { echo "$image"; return 0; }
  done
  return 1
}

desktop_check_kvm() {
  echo "KVM"
  if [ -c /dev/kvm ]; then desktop_ok "/dev/kvm 存在"; else desktop_bad "没有 /dev/kvm：CPU 不支持虚拟化或 BIOS 里没开（Intel VT-x / AMD-V），或者是不支持嵌套虚拟化的虚拟机"; fi
  if [[ " $(id -nG "$(id -un)") " == *" kvm "* ]]; then
    desktop_ok "$(id -un) 在 kvm 组"
  else
    desktop_bad "$(id -un) 不在 kvm 组：sudo usermod -aG kvm $(id -un)，然后 sudo systemctl restart user@$(id -u).service（或重启服务器），重新登录"
  fi
}

desktop_check_socket() {
  local socket dir mode
  socket=$(desktop_socket)
  dir=$(dirname "$socket")
  echo "Podman API（$socket）"
  if [ -z "${HEYAGENT_HOST_PODMAN_SOCKET:-}" ]; then
    if systemctl --user is-enabled podman.socket >/dev/null 2>&1; then desktop_ok "podman.socket 开机自启"; else desktop_bad "podman.socket 没有开机自启：scripts/desktop-host.sh setup"; fi
    if desktop_manager_has_kvm; then
      desktop_ok "systemd 用户实例有 kvm 组"
    else
      desktop_bad "systemd 用户实例没有 kvm 组（它是加进 kvm 组之前起的）：sudo systemctl restart user@$(id -u).service 或重启服务器，再重新登录"
    fi
  fi
  if [ ! -S "$socket" ]; then
    desktop_bad "socket 不存在：systemctl --user enable --now podman.socket（或 scripts/desktop-host.sh setup）"
    return 0
  fi
  mode=$(stat -c %a "$socket")
  if [ "${mode: -1}" -ge 6 ]; then desktop_ok "socket 权限 $mode（pod 里的 uid 1000 连得上）"; else desktop_bad "socket 权限是 $mode，pod 里的 uid 1000 连不上，要 0666：scripts/desktop-host.sh setup"; fi
  mode=$(stat -c %a "$dir")
  if [ $((${mode: -1} & 1)) = 1 ]; then desktop_ok "目录 $dir 权限 $mode"; else desktop_bad "目录 $dir 权限是 $mode，要别人能进（o+x，例如 0755）"; fi
  if [ "$(find "$dir" -mindepth 1 -maxdepth 1 | wc -l)" -gt 1 ]; then desktop_warn "$dir 里除了 socket 还有别的东西，整个目录会挂进 pod：最好给 socket 单独一个目录"; fi
  if podman --remote --url "unix://$socket" version >/dev/null 2>&1; then desktop_ok "连得上"; else desktop_bad "连不上：systemctl --user status podman.socket podman.service"; fi
  local image
  if image=$(desktop_probe_image); then
    if desktop_kvm_through_socket "$socket" "$image"; then desktop_ok "经这个 socket 起的容器能用 /dev/kvm"; else desktop_bad "经这个 socket 起的容器打不开 /dev/kvm（Podman 服务没有 kvm 组，见上面；或运行时不是 crun）"; fi
  else
    desktop_warn "本机还没有能用来测试的镜像，跳过「容器里能不能用 /dev/kvm」（装好后再跑一次 scripts/desktop-host.sh check）"
  fi
}

desktop_check_linger() {
  echo "开机自启"
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ]; then desktop_ok "linger 开着（服务器重启后虚拟机会自动开回来）"; else desktop_bad "linger 没开：sudo loginctl enable-linger $(id -un)"; fi
}

desktop_check_storage() {
  echo "存放位置（HEYAGENT_DESKTOP_STORAGE_ROOTS）"
  local root owner free rota source
  while IFS= read -r root; do
    case "$root" in /*) ;; *) desktop_bad "$root 不是绝对路径"; continue ;; esac
    if [ ! -d "$root" ]; then desktop_bad "$root 不存在：sudo mkdir -p $root && sudo chown $(id -un): $root，再 scripts/desktop-host.sh setup"; continue; fi
    owner=$(podman unshare stat -c %u "$root" 2>/dev/null || echo "?")
    if [ "$owner" = 1000 ]; then desktop_ok "$root 归容器里的 uid 1000"; else desktop_bad "$root 不归容器里的 uid 1000（现在是 $owner），worker 建不了目录：scripts/desktop-host.sh setup"; fi
    free=$(df --output=avail -BG "$root" | tail -1 | tr -dc 0-9)
    if [ "${free:-0}" -ge "$DESKTOP_MIN_FREE_GB" ]; then desktop_ok "$root 剩 ${free} GB"; else desktop_bad "$root 只剩 ${free:-0} GB，至少要 $DESKTOP_MIN_FREE_GB GB"; fi
    source=$(findmnt -no SOURCE --target "$root" 2>/dev/null || true)
    rota=$( [ -b "$source" ] && lsblk -dno ROTA "$source" 2>/dev/null | xargs || true)
    case "$rota" in
      0) desktop_ok "$root 在 SSD 上（$source）" ;;
      1) desktop_warn "$root 在机械硬盘上（$source）：Windows 会很慢，装一次模板要 2 小时以上，页面上会标出来" ;;
      *) desktop_warn "$root 认不出是 SSD 还是 HDD（$source），可以在控制台「设置」里手动标" ;;
    esac
  done < <(desktop_roots)
}

desktop_check() {
  DESKTOP_FAILED=0
  if ! desktop_enabled; then
    echo "没有配置 HEYAGENT_DESKTOP_STORAGE_ROOTS：不开虚拟机，「桌面」页只能登记已有电脑。"
    return 0
  fi
  desktop_check_kvm
  desktop_check_socket
  desktop_check_linger
  desktop_check_storage
  if [ "$DESKTOP_FAILED" = 0 ]; then echo "桌面虚拟机的准备都好了"; else echo "有没通过的项（✗），按提示处理后再跑一次" >&2; fi
  return "$DESKTOP_FAILED"
}

# 不用 sudo 能做的：podman.socket 的权限（0666，目录 0755）和开机自启；存放位置的属主
desktop_setup() {
  desktop_enabled || { echo "没有配置 HEYAGENT_DESKTOP_STORAGE_ROOTS，不用准备"; return 0; }
  if [ -z "${HEYAGENT_HOST_PODMAN_SOCKET:-}" ]; then
    local dropin=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/podman.socket.d/heyagent.conf
    local want
    want=$(printf '%s\n' "# scripts/desktop-host.sh：pod 里的 api、worker（容器里的 uid 1000 = 宿主机的子 uid）要连这个 socket" "[Socket]" "SocketMode=0666" "DirectoryMode=0755")
    if [ "$(cat "$dropin" 2>/dev/null)" != "$want" ]; then
      mkdir -p "$(dirname "$dropin")"
      printf '%s\n' "$want" > "$dropin"
      systemctl --user daemon-reload
      # 已经开着的 socket 要重开才换权限（podman.service 是按需起的，跟着重起）
      systemctl --user restart podman.socket 2>/dev/null || true
      echo "已写 $dropin"
    fi
    systemctl --user enable --now podman.socket >/dev/null
  fi
  local root owner
  while IFS= read -r root; do
    [ -d "$root" ] || continue
    owner=$(podman unshare stat -c %u "$root" 2>/dev/null || echo "?")
    if [ "$owner" != 1000 ]; then
      if podman unshare chown 1000:1000 "$root" 2>/dev/null; then
        echo "已把 $root 的属主改成容器里的 uid 1000"
      else
        echo "改不了 $root 的属主（它不归 $(id -un)）：sudo chown $(id -un): $root，再跑一次" >&2
      fi
    fi
  done < <(desktop_roots)
  desktop_check
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  # 直接运行时：环境变量里没给就读正式服务器的配置（scripts/server-install.sh 的 heyagent.env）
  config_env=${XDG_CONFIG_HOME:-$HOME/.config}/heyagent/heyagent.env
  if [ -z "${HEYAGENT_DESKTOP_STORAGE_ROOTS+x}" ] && [ -f "$config_env" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$config_env"
    set +a
  fi
  case "${1:-}" in
    check) desktop_check ;;
    setup) desktop_setup ;;
    *) echo "用法：$0 check | setup（配置见文件开头）" >&2; exit 2 ;;
  esac
fi
