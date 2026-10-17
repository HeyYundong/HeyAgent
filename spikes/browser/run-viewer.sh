#!/usr/bin/env bash
# 远程画面手动试用页（端口 5190，监听 0.0.0.0）。
#   ./run-viewer.sh start    起容器：Xvfb + 有界面 Chrome + 试用页，打开本地测试页
#   ./run-viewer.sh stop     停掉并删除容器
#   ./run-viewer.sh status   看是否在跑
#   ./run-viewer.sh logs     看容器日志
# 只在实测 / 演示期间开着，用完 stop。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
IMAGE=${IMAGE:-localhost/heyagent-browser-base:m0}
NAME=heyagent-browser-viewer
PORT=${VIEWER_PORT:-5190}

ensure_image() {
  if ! podman image exists "$IMAGE"; then
    echo "镜像 $IMAGE 不存在，先构建……"
    podman build -f "$REPO/deploy/browser-base.Containerfile" -t "$IMAGE" "$REPO/deploy"
  fi
  [ -d "$HERE/node_modules/ws" ] || (cd "$HERE" && npm install --no-fund --no-audit)
}

case "${1:-}" in
  start)
    if podman container exists "$NAME"; then echo "已经在跑：$NAME"; exit 0; fi
    ensure_image
    # 容器参数和报告里推荐的一致：--init 回收僵尸进程；no-new-privileges + 只留 SYS_CHROOT 给 Chrome 的 namespace sandbox
    podman run -d --rm --name "$NAME" --init --shm-size=2g \
      --security-opt no-new-privileges --cap-drop=all --cap-add=SYS_CHROOT \
      -p "$PORT:5190" \
      -v "$HERE:/opt/browser/spike:ro" -w /opt/browser/spike \
      "$IMAGE" node viewer/server.mjs >/dev/null
    for _ in $(seq 1 40); do
      if curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then
        echo "远程画面已启动："
        echo "  http://127.0.0.1:$PORT/"
        for ip in $(hostname -I); do case "$ip" in *:*) ;; *) echo "  http://$ip:$PORT/";; esac; done
        echo "用完执行：$0 stop"
        exit 0
      fi
      sleep 0.5
    done
    echo "启动超时，日志：" >&2; podman logs "$NAME" >&2 || true; exit 1
    ;;
  stop)
    if podman container exists "$NAME"; then podman stop -t 10 "$NAME" >/dev/null; echo "已停止：$NAME"; else echo "没有在跑"; fi
    ;;
  status)
    if podman container exists "$NAME"; then podman ps --filter "name=$NAME" --format '{{.Names}} {{.Status}} {{.Ports}}'; else echo "没有在跑"; fi
    ;;
  logs)
    podman logs "$NAME"
    ;;
  *)
    echo "用法：$0 start|stop|status|logs" >&2; exit 2
    ;;
esac
