#!/usr/bin/env bash
# 浏览器相关的测试（要有界面的 Chrome、Xvfb、gost）：在 worker 镜像的容器里跑（开发机上没有 Chrome）。
# 用法：scripts/browser-test.sh [vitest 参数，例如 test-browser/vault.test.ts]
# - 仓库挂到容器里同一个路径，用宿主机装好的 node_modules（纯 JS，Node 24 能直接用）；
# - --network host：测试连宿主机 127.0.0.1 上的开发数据库，测试站点、测试 SOCKS5 上游也在本机回环上；
# - --userns=keep-id：容器里的 browser 用户（uid 1000）就是你，挂进来的仓库能读写；
# - 其余容器参数和 docs/research/m0-browser-spike.md 推荐的一样（Chrome 的 sandbox 照开）。
# 数据库用 TEST_DATABASE_URL（不设就用 .env 里的；必须指向 *_test 库，测试会清空它）。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${HEYAGENT_BROWSER_TEST_IMAGE:-localhost/heyagent-worker:m1}
podman image exists "$IMAGE" || IMAGE=localhost/heyagent-browser-base:m0
ENV_ARGS=()
for name in TEST_DATABASE_URL HEYAGENT_LEASE_TTL_MS HEYAGENT_BROWSER_SWEEP_MS; do
  if [ -n "${!name:-}" ]; then ENV_ARGS+=(-e "$name=${!name}"); fi
done
exec podman run --rm --init --shm-size=2g \
  --security-opt no-new-privileges --cap-drop=all --cap-add=SYS_CHROOT \
  --network host --userns=keep-id \
  -v "$ROOT:$ROOT" -w "$ROOT/apps/server" \
  -e TZ=Asia/Shanghai -e NODE_ENV=test "${ENV_ARGS[@]}" \
  "$IMAGE" node node_modules/vitest/vitest.mjs run --config vitest.browser.config.ts "$@"
