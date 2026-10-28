#!/usr/bin/env bash
# 浏览器提速的真模型基准（花钱）：在 worker 镜像的容器里用真的 DeepSeek 跑 apps/server/test-browser/speed 的场景。
# 用法：scripts/speed-bench.sh <标签> [场景，默认 A,B,C] [每个场景跑几遍，默认 1]
# 固化的基准（docs/dev/solidify.md 第 13 节）：SPEED_FILE=routine scripts/speed-bench.sh <标签> [场景] [脚本跑几遍]；写脚本的模型用 ROUTINE_SOLIDIFY_MODEL 换
# 任务的工具用 SPEED_TOOLS 换（逗号分隔，默认 browser,run.finish）；加上 code.run 看 agent 会不会自己写循环脚本
# 结果追加到 .dev/speed/<标签>.jsonl（一行一次运行）。数据库用 .env 的 TEST_DATABASE_URL（会被清空，必须是 *_test 库）。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LABEL=${1:?标签，例如 baseline}
SCENARIOS=${2:-A,B,C}
REPEAT=${3:-1}
"$ROOT/scripts/or-usage.sh" check 18
mkdir -p "$ROOT/.dev/speed"
OPENROUTER_API_KEY=$(grep -E '^OPENROUTER_API_KEY=' "$ROOT/.env" | head -1 | cut -d= -f2-)
TEST_DATABASE_URL=$(grep -E '^TEST_DATABASE_URL=' "$ROOT/.env" | head -1 | cut -d= -f2-)
export OPENROUTER_API_KEY TEST_DATABASE_URL
IMAGE=${HEYAGENT_BROWSER_TEST_IMAGE:-localhost/heyagent-worker:m1}
exec podman run --rm --init --shm-size=2g \
  --security-opt no-new-privileges --cap-drop=all --cap-add=SYS_CHROOT \
  --network host --userns=keep-id \
  -v "$ROOT:$ROOT" -w "$ROOT/apps/server" \
  -e TZ=Asia/Shanghai -e NODE_ENV=test -e OPENROUTER_API_KEY -e TEST_DATABASE_URL \
  -e SPEED_FILE="${SPEED_FILE:-speed}" -e ROUTINE_SOLIDIFY_MODEL -e SPEED_TOOLS -e SPEED_LABEL="$LABEL" -e SPEED_SCENARIOS="$SCENARIOS" -e SPEED_REPEAT="$REPEAT" -e SPEED_OUT="$ROOT/.dev/speed/$LABEL.jsonl" \
  "$IMAGE" node node_modules/vitest/vitest.mjs run --config vitest.speed.config.ts
