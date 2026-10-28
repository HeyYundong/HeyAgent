#!/bin/sh
# api 容器启动：先等数据库能用，再执行迁移；HEYAGENT_SEED_DEMO=1 时灌演示数据（正式环境默认不灌）；再起 API。
set -e

# 等数据库真正能查询：端口能连上时 PostgreSQL 可能还在崩溃恢复，连接会被拒（57P03 the database system is not yet accepting connections），
# 这时直接迁移会失败、只能靠容器重启再来（2026-10-28 重建时遇到）。每秒试一次 select 1，最多 HEYAGENT_DB_WAIT_SECONDS 秒（默认 60），超时报错退出
wait_for_db() {
  limit=${HEYAGENT_DB_WAIT_SECONDS:-60}
  deadline=$(($(date +%s) + limit))
  until node -e "
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
    c.connect().then(() => c.query('select 1')).then(() => c.end()).then(() => process.exit(0), () => process.exit(1));
  " 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "${limit} 秒内数据库还不能用（DATABASE_URL 指的库连不上或还没准备好），退出" >&2
      exit 1
    fi
    echo "等数据库可用…"
    sleep 1
  done
}

wait_for_db
node dist/db/migrate-cli.js
if [ "${HEYAGENT_SEED_DEMO:-0}" = "1" ]; then
  node dist/seed/cli.js
fi
exec node dist/index.js
