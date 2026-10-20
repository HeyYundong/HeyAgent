#!/bin/bash
# Runs inside a worker-like container. Tests bwrap isolation.
set -u
export DATABASE_URL="postgres://secret@127.0.0.1:5432/x"
mkdir -p /tmp/secrets && echo KEK-SECRET > /tmp/secrets/kek
# listener on outer localhost
python3 -c "
import socket,threading
s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',5999));s.listen()
while True:
  c,_=s.accept();c.send(b'OUTER-LOCALHOST');c.close()
" &
sleep 0.5
WS=/tmp/ws; mkdir -p $WS/in; echo hello > $WS/in/a.txt
BW=(setpriv --inh-caps=-all --ambient-caps=-all bwrap --unshare-all --die-with-parent --new-session --clearenv
  --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /workspace --setenv LANG C.UTF-8
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/sbin /sbin
  --ro-bind /etc/alternatives /etc/alternatives --ro-bind-try /etc/ssl /etc/ssl --ro-bind-try /etc/ca-certificates /etc/ca-certificates
  --proc /proc --dev /dev --tmpfs /tmp
  --bind $WS /workspace --ro-bind $WS/in /workspace/in --chdir /workspace)
echo "== basic"; time "${BW[@]}" python3 -c 'print("py ok")'
"${BW[@]}" node -e 'console.log("node ok", process.version)'
"${BW[@]}" bash -c 'echo bash ok; id'
echo "== env"; "${BW[@]}" bash -c 'env | grep -c DATABASE_URL; true'
echo "== secret file"; "${BW[@]}" bash -c 'cat /tmp/secrets/kek 2>&1; ls /run/heyagent-secrets 2>&1; ls /data 2>&1'
echo "== outer localhost"; "${BW[@]}" python3 -c '
import socket
try:
  s=socket.create_connection(("127.0.0.1",5999),2);print("CONNECTED",s.recv(100))
except Exception as e: print("blocked:",e)'
echo "== internet"; "${BW[@]}" python3 -c '
import socket
try:
  socket.create_connection(("1.1.1.1",80),3);print("INTERNET OK")
except Exception as e: print("blocked:",e)'
echo "== processes"; "${BW[@]}" bash -c 'ls /proc | grep -E "^[0-9]+$" | wc -l'
echo "== write ws / ro input"; "${BW[@]}" bash -c 'echo out > /workspace/out.txt; echo x > /workspace/in/a.txt 2>&1 || echo "ro ok"'; ls -la $WS
echo "== limits"; "${BW[@]}" bash -c 'ulimit -v 1048576; ulimit -u 256; ulimit -t 5; python3 -c "x=bytearray(2*1024**3)" 2>&1 | tail -1'
"${BW[@]}" bash -c 'ulimit -t 2; timeout 10 python3 -c "while True: pass"; echo "exit=$?"'
