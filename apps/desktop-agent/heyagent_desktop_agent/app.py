"""HTTP / WebSocket 接口（docs/dev/desktop.md 第 6 节）。

所有请求都要 Authorization: Bearer <密钥>：HTTP 不对返回 401；WebSocket 先接受再用 4401 关掉
（握手阶段直接拒绝的话，客户端只能看到 403，分不清是密钥不对）。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import hmac
import json
import logging
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Iterable

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

from . import __version__
from .files import MAX_FILE_BYTES, header_file_name, numbered_names, resolve_download, sanitize_name
from .hub import ViewHub
from .inputplan import InputPlanner, plan_text, utf16_units
from .messages import parse_client_message, parse_type_request

log = logging.getLogger(__name__)

WS_CLOSE_UNAUTHORIZED = 4401


class BearerAuth:
    """纯 ASGI 中间件：HTTP 和 WebSocket 都查密钥"""

    def __init__(self, app: Any, key: str) -> None:
        self.app = app
        self.expected = f"Bearer {key}".encode()

    def _ok(self, scope: dict) -> bool:
        for name, value in scope.get("headers", []):
            if name == b"authorization":
                return hmac.compare_digest(value.strip(), self.expected)
        return False

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] not in ("http", "websocket") or self._ok(scope):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "http":
            response = JSONResponse({"error": "密钥不对"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
            await response(scope, receive, send)
            return
        message = await receive()
        if message["type"] == "websocket.connect":
            await send({"type": "websocket.accept"})
            await send({"type": "websocket.close", "code": WS_CLOSE_UNAUTHORIZED, "reason": "unauthorized"})


def _error(message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def _int_param(request: Request, name: str, default: int, low: int, high: int) -> int:
    raw = request.query_params.get(name)
    if raw is None or raw == "":
        return default
    value = int(raw)  # 不是整数抛 ValueError，调用处返回 400
    if not low <= value <= high:
        raise ValueError(name)
    return value


def create_app(
    key: str,
    backend: Any,
    encode: Callable[[Any, int, int], bytes],
    files_dir: str,
    download_roots: Callable[[], Iterable[str]],
) -> Any:
    hub = ViewHub(backend, encode)
    # 键鼠按到达顺序一个一个执行；长文字也不卡住事件循环
    input_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="input")

    async def health(request: Request) -> Response:
        width, height = await asyncio.to_thread(backend.screen_size)
        return JSONResponse({"ok": True, "version": __version__, "screen": {"width": width, "height": height}})

    async def screenshot(request: Request) -> Response:
        try:
            max_width = _int_param(request, "maxWidth", 1280, 0, 16384)
            quality = _int_param(request, "quality", 70, 1, 95)
        except ValueError:
            return _error("maxWidth 是 0～16384 的整数（0 = 不缩），quality 是 1～95 的整数", 400)

        def capture() -> tuple[bytes, int, int]:
            image = backend.grab()
            return encode(image, max_width, quality), image.width, image.height

        try:
            data, width, height = await asyncio.to_thread(capture)
        except Exception as error:
            log.warning("截图失败：%s", error)
            return _error(f"截图失败（锁屏或安全桌面时截不到）：{error}", 503)
        return Response(
            data,
            media_type="image/jpeg",
            headers={"X-Screen-Width": str(width), "X-Screen-Height": str(height), "Cache-Control": "no-store"},
        )

    async def upload(request: Request) -> Response:
        name = sanitize_name(request.query_params.get("name", ""))
        length = request.headers.get("content-length")
        if length is not None and length.isdigit() and int(length) > MAX_FILE_BYTES:
            return _error("文件超过 200 MB", 413)
        folder = os.path.join(files_dir, dt.date.today().isoformat())
        os.makedirs(folder, exist_ok=True)
        temp = os.path.join(folder, f".upload-{uuid.uuid4().hex}.part")
        size = 0
        try:
            with open(temp, "wb") as out:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_FILE_BYTES:
                        raise OverflowError
                    out.write(chunk)
            # 先用 O_EXCL 占住名字再换进去：两个同名文件同时上传也不会互相覆盖
            for candidate in numbered_names(name):
                target = os.path.join(folder, candidate)
                try:
                    os.close(os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                except FileExistsError:
                    continue
                os.replace(temp, target)
                break
        except OverflowError:
            return _error("文件超过 200 MB", 413)
        finally:
            if os.path.exists(temp):
                os.remove(temp)
        log.info("收到文件 %s（%d 字节）", target, size)
        return JSONResponse({"path": target, "size": size})

    async def download(request: Request) -> Response:
        path = request.query_params.get("path", "")
        real = resolve_download(path, download_roots())
        if real is None:
            return _error("只能取用户目录和 C:\\HeyAgent\\files 下面的文件", 403)
        if not os.path.isfile(real):
            return _error("文件不存在", 404)
        size = os.path.getsize(real)
        if size > MAX_FILE_BYTES:
            return _error("文件超过 200 MB", 413)
        name = os.path.basename(real)
        return FileResponse(
            real,
            media_type="application/octet-stream",
            filename=name,
            headers={"X-File-Name": header_file_name(name)},
        )

    async def type_text(request: Request) -> Response:
        """agent 打字：Windows-MCP 的 Type 打不出中文，服务端把非 ASCII 的转到这里。焦点由调用方先点好"""
        length = request.headers.get("content-length")
        if length is not None and length.isdigit() and int(length) > 1 << 20:
            return _error("请求体太大", 400)
        try:
            text = parse_type_request(await request.json())
        except ValueError:
            text = None
        if text is None:
            return _error("请求体要是 {\"text\": \"…\"}，text 是 1～10000 个字", 400)
        width, height = hub.current_size()
        actions = plan_text(text, restore_clipboard=True)
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(input_executor, backend.type_text, actions, width, height)
        except Exception as error:
            log.exception("打字失败")
            return _error(f"打字失败：{error}", 500)
        return JSONResponse({"ok": True, "chars": len(utf16_units(text))})

    async def files(request: Request) -> Response:
        if request.method == "POST":
            return await upload(request)
        return await download(request)

    async def send_loop(ws: WebSocket, viewer: Any) -> None:
        try:
            while True:
                await viewer.wake.wait()
                items, frame = viewer.take()
                for item in items:
                    await ws.send_text(json.dumps(item, separators=(",", ":")))
                if frame is not None:
                    await ws.send_bytes(frame)
        except (WebSocketDisconnect, RuntimeError, OSError):
            # 对方已经断开：接收那边会收到 disconnect，在那里收尾
            pass

    async def view(ws: WebSocket) -> None:
        await ws.accept()
        loop = asyncio.get_running_loop()
        viewer = await hub.join()
        planner = InputPlanner()
        sender = asyncio.create_task(send_loop(ws, viewer))
        log.info("有人开始看画面（%d 人在看）", len(hub.viewers))
        try:
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                text = message.get("text")
                if text is None:
                    continue
                try:
                    parsed = parse_client_message(json.loads(text))
                except ValueError:
                    continue
                if parsed is None:
                    continue
                width, height = hub.current_size()
                actions = planner.plan(parsed, width, height)
                if actions:
                    try:
                        await loop.run_in_executor(input_executor, backend.send, actions, width, height)
                    except Exception:
                        # 例如剪贴板被别的程序占着：这一条丢掉，连接不断
                        log.exception("输入失败")
        except WebSocketDisconnect:
            pass
        finally:
            sender.cancel()
            hub.leave(viewer)
            leftover = planner.release_all()
            if leftover:
                width, height = hub.current_size()
                await loop.run_in_executor(input_executor, backend.send, leftover, width, height)
            log.info("有人不看了（%d 人在看）", len(hub.viewers))

    app = Starlette(
        routes=[
            Route("/health", health),
            Route("/screenshot", screenshot),
            Route("/files", files, methods=["GET", "POST"]),
            Route("/type", type_text, methods=["POST"]),
            WebSocketRoute("/view", view),
        ]
    )
    return BearerAuth(app, key)
