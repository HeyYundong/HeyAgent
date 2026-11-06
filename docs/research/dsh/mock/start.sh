#!/usr/bin/env bash
# (Re)create the dsh mock container from scratch and print the token URL.
# Published dsh 0.2.2-alpha.3 lives in ./app/node_modules (installed with npm
# inside the same node:24 image). DSH_HOME = ./home (holds cordis.patch.yml,
# sessions, settings). Host networking: dsh binds 192.168.31.100:3480, the
# scripted model server binds 127.0.0.1:3481.
set -euo pipefail
D=/home/yundong.zhang/.claude/jobs/a7607238/tmp/dshmock
podman rm -f dshmock-web >/dev/null 2>&1 || true
podman run -d --name dshmock-web --network host --userns=keep-id \
  -v "$D":/dshmock -w /dshmock/app \
  -e DSH_HOME=/dshmock/home -e HOME=/dshmock/home \
  -e DSH_TELEMETRY_DISABLED=1 -e HEYAGENT_MOCK_KEY=mock -e HEYAGENT_MOCK_DUMP="${HEYAGENT_MOCK_DUMP:-}" \
  docker.io/library/node:24-bookworm-slim \
  node /dshmock/app/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open \
    --host 192.168.31.100 --port 3480 --trusted-host 192.168.31.100 >/dev/null
for _ in $(seq 1 45); do
  if podman logs dshmock-web 2>&1 | grep -q 'token='; then break; fi
  sleep 2
done
podman logs dshmock-web 2>&1 | grep -o 'http://[^ ]*token=[^ ]*' | tail -1 > "$D/url.txt"
podman logs dshmock-web 2>&1 | grep -v '\[heyagent-mock\] request' | tail -8
cat "$D/url.txt"
