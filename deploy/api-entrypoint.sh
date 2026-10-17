#!/bin/sh
# api 容器启动：先执行迁移；HEYAGENT_SEED_DEMO=1 时灌演示数据（正式环境默认不灌）；再起 API。
set -e
node dist/db/migrate-cli.js
if [ "${HEYAGENT_SEED_DEMO:-0}" = "1" ]; then
  node dist/seed/cli.js
fi
exec node dist/index.js
