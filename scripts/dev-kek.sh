#!/usr/bin/env bash
# 开发用主密钥（KEK）：生成 .dev/kek。格式是每行「版本号:base64(32 字节)」，版本号最大的那把加密新数据。
# 用法：scripts/dev-kek.sh          没有就生成 v1，有就不动
#       scripts/dev-kek.sh rotate   追加一把新版本（旧的留着，用来解旧数据）
# 服务器上不用这个脚本：主密钥是 Podman secret，由专人保管（方案 6.2 第 11 条）。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
FILE=${HEYAGENT_KEK_FILE:-$ROOT/.dev/kek}
mkdir -p "$(dirname "$FILE")"

new_key() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }

if [ "${1:-}" = "rotate" ]; then
  [ -f "$FILE" ] || { echo "$FILE 不存在，先不带参数运行一次" >&2; exit 1; }
  last=$(grep -E '^[0-9]+:' "$FILE" | cut -d: -f1 | sort -n | tail -1)
  next=$((last + 1))
  echo "$next:$(new_key)" >> "$FILE"
  echo "已追加 KEK v$next：$FILE（旧数据要用 rewrap 重新包一遍 DEK）"
  exit 0
fi

if [ -f "$FILE" ]; then
  echo "已有主密钥：$FILE（不覆盖）"
  exit 0
fi

umask 077
{
  echo "# HeyAgent 开发用主密钥（KEK）。丢了就解不开库里的密钥和登录态，不要提交。"
  echo "1:$(new_key)"
} > "$FILE"
chmod 600 "$FILE"
echo "已生成主密钥：$FILE"
