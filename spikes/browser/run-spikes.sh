#!/usr/bin/env bash
# 在 browser-base 容器里跑实测，原始输出写到 out/<时间>/。
#   ./run-spikes.sh                 全部
#   ./run-spikes.sh sandbox input   只跑指定的几项
# 项目：sandbox fingerprint visibility input screencast mcp gost resources
# 访问范围：本地测试页、example.com、wikipedia.org。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
IMAGE=${IMAGE:-localhost/heyagent-browser-base:m0}
OUT=${OUT:-$HERE/out/$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"
podman image exists "$IMAGE" || podman build -f "$REPO/deploy/browser-base.Containerfile" -t "$IMAGE" "$REPO/deploy"
[ -d "$HERE/node_modules/ws" ] || (cd "$HERE" && npm install --no-fund --no-audit)

# 推荐的容器参数（全部实测项都在这组参数下跑）：
#   --init                              PID 1 用 catatonit 回收 Chrome 的僵尸进程
#   --shm-size=2g                       保险（实测 Chrome 155 不用 /dev/shm，见报告）
#   --security-opt no-new-privileges    加固；Chrome 用的是 user namespace sandbox，不需要 setuid
#   --cap-drop=all --cap-add=SYS_CHROOT 加固；Chrome 的 namespace sandbox 只需要 SYS_CHROOT
#   默认 seccomp，不加 --no-sandbox
# --userns=keep-id 只是为了让容器里的 uid 1000 能写 out/ 目录（截图），生产不需要。
HARDEN=(--security-opt no-new-privileges --cap-drop=all --cap-add=SYS_CHROOT)
BASE=(--rm --init --shm-size=2g "${HARDEN[@]}" -v "$HERE:/opt/browser/spike:ro" -w /opt/browser/spike)
PLAIN=(--rm --init --shm-size=2g -v "$HERE:/opt/browser/spike:ro" -w /opt/browser/spike)
KEEP=(--userns=keep-id -v "$OUT:/out" -e OUT_DIR=/out)

run() { # run <名字> <podman 参数...> -- <命令...>
  local name=$1; shift
  local args=(); while [ "$1" != "--" ]; do args+=("$1"); shift; done; shift
  echo "== $name"
  echo "podman run ${args[*]} $IMAGE $*" > "$OUT/$name.cmd"
  podman run "${args[@]}" "$IMAGE" "$@" > "$OUT/$name.json" 2>"$OUT/$name.stderr" || echo "   失败，见 $OUT/$name.stderr"
}

want() { [ $# -eq 0 ] && return 0; for t in "${SEL[@]}"; do [ "$t" = "$1" ] && return 0; done; return 1; }
SEL=("$@")
all() { [ ${#SEL[@]} -eq 0 ] || want "$1"; }

if all sandbox; then
  run sandbox-recommended    "${BASE[@]}" -- node t-sandbox.mjs
  run sandbox-podman-default "${PLAIN[@]}" -- node t-sandbox.mjs
  run sandbox-keepid         "${BASE[@]}" "${KEEP[@]}" -- node t-sandbox.mjs
  run sandbox-shm64m         --rm --init "${HARDEN[@]}" -v "$HERE:/opt/browser/spike:ro" -w /opt/browser/spike -- node t-sandbox.mjs
  run sandbox-no-init        --rm --shm-size=2g "${HARDEN[@]}" -v "$HERE:/opt/browser/spike:ro" -w /opt/browser/spike -- node t-sandbox.mjs
  run sandbox-capdrop-all    "${PLAIN[@]}" --security-opt no-new-privileges --cap-drop=all -- node t-sandbox.mjs
  run sandbox-unconfined     "${PLAIN[@]}" --security-opt seccomp=unconfined -- node t-sandbox.mjs
  run sandbox-off            "${BASE[@]}" -- node t-sandbox.mjs --no-sandbox
fi
all fingerprint && run fingerprint "${BASE[@]}" "${KEEP[@]}" -- node t-fingerprint.mjs
all visibility  && run visibility  "${BASE[@]}" -- node t-visibility.mjs
all input       && run input       "${BASE[@]}" -- node t-input.mjs
all screencast  && run screencast  "${BASE[@]}" -- node t-screencast.mjs
all mcp         && run mcp         "${BASE[@]}" -- node t-mcp.mjs
if all gost; then
  # 真实 DNS：取默认容器里的 resolv.conf 第一个 nameserver；本容器的 resolv.conf 指向 127.0.0.1 上的 DNS 记录器
  UPSTREAM_DNS=$(podman run --rm "$IMAGE" sh -c "awk '/^nameserver/{print \$2; exit}' /etc/resolv.conf")
  run gost "${BASE[@]}" --dns=127.0.0.1 --sysctl net.ipv4.ip_unprivileged_port_start=0 -e UPSTREAM_DNS="$UPSTREAM_DNS" -- node t-gost.mjs
fi
all resources   && run resources   "${BASE[@]}" -- node t-resources.mjs 1,3,5
# 不给 --shm-size（默认 64MB）再跑 5 个，看 Chrome 是否依赖 /dev/shm
all resources   && run resources-shm64m --rm --init "${HARDEN[@]}" -v "$HERE:/opt/browser/spike:ro" -w /opt/browser/spike -- node t-resources.mjs 5
echo "输出在 $OUT"
