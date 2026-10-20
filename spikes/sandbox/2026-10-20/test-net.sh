#!/bin/bash
set -u
R=/opt/sandbox-root
WS=/tmp/ws; mkdir -p $WS /tmp/px
# outer listener simulating postgres on pod localhost
python3 -c "
import socket
s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',5999));s.listen()
while True:
  c,_=s.accept();c.send(b'HTTP/1.0 200 OK\r\n\r\nOUTER-LOCALHOST');c.close()
" &
node /spike/proxy.mjs /tmp/px/proxy.sock &
sleep 0.7
echo "== outer has internet?"; curl -sS -o /dev/null -w "%{http_code}\n" --max-time 10 https://example.com
BW=(setpriv --inh-caps=-all --ambient-caps=-all bwrap --unshare-all --die-with-parent --new-session --clearenv
  --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /workspace --setenv LANG C.UTF-8
  --setenv HTTP_PROXY http://127.0.0.1:3128 --setenv HTTPS_PROXY http://127.0.0.1:3128
  --setenv http_proxy http://127.0.0.1:3128 --setenv https_proxy http://127.0.0.1:3128
  --setenv NO_PROXY "" --setenv NODE_USE_ENV_PROXY 1
  --ro-bind $R / --dev /dev --tmpfs /tmp --bind $WS /workspace --ro-bind /tmp/px /tmp/px --chdir /workspace)
PRE='socat TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/tmp/px/proxy.sock & for i in 1 2 3 4 5 6 7 8 9 10; do (echo > /dev/tcp/127.0.0.1/3128) 2>/dev/null && break; sleep 0.05; done;'
echo "== curl https via proxy"; time "${BW[@]}" bash -c "$PRE curl -sS -o /dev/null -w '%{http_code}\n' --max-time 15 https://example.com"
echo "== python requests-less urllib https"; "${BW[@]}" bash -c "$PRE python3 -c 'import urllib.request;print(urllib.request.urlopen(\"https://pypi.org/simple/\",timeout=15).status)'"
echo "== node fetch"; "${BW[@]}" bash -c "$PRE node -e 'fetch(\"https://example.com\").then(r=>console.log(\"node\",r.status)).catch(e=>console.log(\"node err\",e.cause?.message||e.message))'"
echo "== pip install"; "${BW[@]}" bash -c "$PRE pip install -q --user --no-cache-dir --disable-pip-version-check six 2>&1 | tail -2; python3 -c 'import six;print(\"six\",six.__version__)'"
echo "== SSRF: outer localhost via proxy"; "${BW[@]}" bash -c "$PRE curl -sS --max-time 5 http://127.0.0.1:5999/ ; echo; curl -sS --max-time 5 http://localhost:5999/; echo"
echo "== SSRF: private ip"; "${BW[@]}" bash -c "$PRE curl -sS --max-time 5 http://169.254.169.254/; echo; curl -sS --max-time 5 https://10.0.0.1/ 2>&1|tail -1"
echo "== direct (no proxy) internet"; "${BW[@]}" bash -c "$PRE curl -sS --noproxy '*' --max-time 5 https://1.1.1.1 2>&1 | tail -1"
