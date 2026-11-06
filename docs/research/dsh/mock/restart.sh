#!/usr/bin/env bash
# Restart the dsh mock container and write the fresh token URL to url.txt.
set -euo pipefail
D=/home/yundong.zhang/.claude/jobs/a7607238/tmp/dshmock
podman restart dshmock-web >/dev/null
for _ in $(seq 1 45); do
  if podman logs --since 20s dshmock-web 2>&1 | grep -q 'token='; then break; fi
  sleep 2
done
podman logs dshmock-web 2>&1 | grep -o 'http://[^ ]*token=[^ ]*' | tail -1 > "$D/url.txt"
podman logs --since 60s dshmock-web 2>&1 | grep -v '\[heyagent-mock\] request' | tail -8
cat "$D/url.txt"
