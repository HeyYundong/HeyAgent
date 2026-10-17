#!/usr/bin/env bash
# 查 OpenRouter key 的用量（不打印 key）。测试预算：20 美元（用户 2026-10-17 定的），key 本身在 OpenRouter 上限 50 美元。
# 用法：scripts/or-usage.sh            看用量
#       scripts/or-usage.sh check 18   用量超过 18 美元时返回非 0（跑真模型测试前用）
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE=${ENV_FILE:-$ROOT/.env}
KEY=$(grep -E '^OPENROUTER_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)
[ -n "$KEY" ] || { echo "没在 $ENV_FILE 里找到 OPENROUTER_API_KEY" >&2; exit 2; }
JSON=$(curl -fsS --max-time 20 https://openrouter.ai/api/v1/key -H "Authorization: Bearer $KEY")
USAGE=$(printf '%s' "$JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['usage'])")
LIMIT=$(printf '%s' "$JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['data'].get('limit'))")
echo "OpenRouter 用量：\$${USAGE}（key 上限 \$${LIMIT}，测试预算 \$20）"
if [ "${1:-}" = "check" ]; then
  python3 -c "import sys; sys.exit(0 if float('$USAGE') < float('${2:-18}') else 1)" || { echo "用量已到 \$${2:-18}，停止跑真模型测试" >&2; exit 1; }
fi
