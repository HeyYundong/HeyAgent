#!/bin/bash
set -u
R=/opt/sandbox-root
WS=/tmp/ws; mkdir -p $WS
BW=(setpriv --inh-caps=-all --ambient-caps=-all bwrap --unshare-all --die-with-parent --new-session --clearenv
  --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /workspace --setenv LANG C.UTF-8
  --ro-bind $R / --dev /dev --tmpfs /tmp --bind $WS /workspace --chdir /workspace)
echo "== isolation: worker files visible?"; "${BW[@]}" bash -c 'ls /app 2>&1; ls /opt 2>&1; cat /etc/os-release | head -1'
echo "== pandas without /proc"; time "${BW[@]}" python3 -c '
import pandas as pd, os
df=pd.DataFrame({"a":[1,2,3]}); df.to_excel("/workspace/t.xlsx", index=False)
print(pd.read_excel("/workspace/t.xlsx").sum().to_dict(), "cpus", os.cpu_count())'
echo "== node without /proc"; "${BW[@]}" node -e 'const os=require("os");console.log("node", process.version, "cpus", os.cpus().length); require("fs").writeFileSync("/workspace/n.json", "{}")'
echo "== node under ulimit -v 1G"; "${BW[@]}" bash -c 'ulimit -v 1048576; node -e "console.log(\"node ok\")" 2>&1 | tail -2'
echo "== node under ulimit -v 4G"; "${BW[@]}" bash -c 'ulimit -v 4194304; node -e "console.log(\"node ok\")" 2>&1 | tail -2'
echo "== node --max-old-space-size=1024 big alloc"; "${BW[@]}" bash -c 'node --max-old-space-size=512 -e "const a=[];for(;;)a.push(new Array(1e6).fill(1))" 2>&1 | grep -m1 -oE "heap out of memory|Allocation failed"'
echo "== fork bomb ulimit -u"; "${BW[@]}" bash -c 'ulimit -u 64; for i in $(seq 200); do sleep 5 & done 2>&1 | tail -1; echo forked'
echo "== jq"; "${BW[@]}" bash -c 'echo "{\"x\":1}" | jq .x'
ls -la $WS
