"""入口：pythonw -m heyagent_desktop_agent --host 0.0.0.0 --port 8001 --key-file C:\\HeyAgent\\key"""

from __future__ import annotations

import argparse
import logging
import os
import sys

from . import __version__
from .logs import redirect_output

DEFAULT_FILES_DIR = r"C:\HeyAgent\files"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="heyagent_desktop_agent", description="桌面服务：推画面、回传键鼠、截图、传文件")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--key-file", required=True, help="密钥文件（和 Windows-MCP 用同一个密钥）")
    parser.add_argument("--files-dir", default=DEFAULT_FILES_DIR, help="传上来的文件放哪（按日期分子目录）")
    parser.add_argument("--log-file", help="日志写到这个文件（pythonw 没有控制台时要给）")
    parser.add_argument("--version", action="version", version=__version__)
    return parser.parse_args(argv)


def read_key(path: str) -> str:
    with open(path, encoding="utf-8-sig") as file:
        key = file.read().strip()
    if len(key) < 16:
        raise SystemExit(f"密钥文件 {path} 里的密钥太短（至少 16 位）")
    return key


def main(argv: list[str] | None = None) -> None:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    redirect_output(args.log_file)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stderr)
    log = logging.getLogger("heyagent_desktop_agent")

    # 要在截屏、建窗口之前设 DPI 感知
    from . import win32

    awareness = win32.set_dpi_awareness()
    key = read_key(args.key_file)

    import uvicorn

    from .app import create_app
    from .screen import encode_jpeg

    def download_roots() -> list[str]:
        return [os.environ.get("USERPROFILE", ""), args.files_dir]

    app = create_app(key, win32.WindowsBackend(), encode_jpeg, args.files_dir, download_roots)
    width, height = win32.screen_size()
    log.info("桌面服务 %s 启动：%s:%d，屏幕 %dx%d，DPI 感知 %s", __version__, args.host, args.port, width, height, awareness)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", ws="websockets-sansio", ws_max_size=1 << 20)


if __name__ == "__main__":
    main()
