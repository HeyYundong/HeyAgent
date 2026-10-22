"""远程画面的推送中心：有人看时才截屏，所有看的人共用同一份帧。

- 截屏最多 fps 帧 / 秒；画面没变（原始像素的校验和一样）就不发，但至少每 keyframe_seconds 秒重发一次最新的帧
  （API 转发时客户端积压太多会丢帧，丢了的那一帧要是画面一直不变就再也补不上）；
- 新来的人马上拿到最新的一帧；还没有（刚开始截）就在下一轮截屏时强制编码一帧，不管画面变没变；缩到最宽 max_width，JPEG 质量 quality。
- 鼠标位置每秒查 cursor_hz 次，变了发 {t:"cursor", kind:"move"}；鼠标键按下（低级钩子）发 kind:"press"。
- 分辨率变了先重发 meta，再发新尺寸的帧。
- 每个看的人一个 Viewer：只留最新的一帧（网慢的人自动丢帧），JSON 消息排队。

backend 和 encode 由外面传进来（Windows 上是 win32.WindowsBackend 和 screen.encode_jpeg），测试里换成假的。
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from typing import Any, Callable, Optional

from .frames import ChangeDetector

log = logging.getLogger(__name__)


def meta_message(width: int, height: int) -> dict:
    return {"t": "meta", "width": width, "height": height, "canControl": True}


class Viewer:
    def __init__(self) -> None:
        self.meta: Optional[dict] = None
        self.messages: deque = deque(maxlen=200)
        self.frame: Optional[bytes] = None
        self.wake = asyncio.Event()

    def push_meta(self, message: dict) -> None:
        self.meta = message
        # 尺寸变了：旧尺寸的帧不要了
        self.frame = None
        self.wake.set()

    def push_json(self, message: dict) -> None:
        self.messages.append(message)
        self.wake.set()

    def push_frame(self, data: bytes) -> None:
        self.frame = data
        self.wake.set()

    def take(self) -> tuple[list[dict], Optional[bytes]]:
        """取出要发的东西：meta 最先，然后排队的 JSON，最后最新的一帧"""
        self.wake.clear()
        items: list[dict] = []
        if self.meta is not None:
            items.append(self.meta)
            self.meta = None
        while self.messages:
            items.append(self.messages.popleft())
        frame, self.frame = self.frame, None
        return items, frame


class ViewHub:
    def __init__(
        self,
        backend: Any,
        encode: Callable[[Any, int, int], bytes],
        fps: float = 5,
        max_width: int = 1280,
        quality: int = 60,
        cursor_hz: float = 10,
        keyframe_seconds: float = 3,
    ) -> None:
        self.backend = backend
        self.encode = encode
        self.interval = 1 / fps
        self.max_width = max_width
        self.quality = quality
        self.cursor_interval = 1 / cursor_hz
        self.keyframe_seconds = keyframe_seconds
        # 下一轮截屏不管画面变没变都要编码、发出一帧（有人新加入但手上还没有帧）
        self._force_frame = False
        self._last_sent = 0.0
        self.viewers: set[Viewer] = set()
        self.size: Optional[tuple[int, int]] = None
        self.last_frame: Optional[bytes] = None
        self._detector = ChangeDetector()
        self._tasks: list[asyncio.Task] = []
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._cursor: Optional[tuple[int, int]] = None
        self._grab_failed = False

    def current_size(self) -> tuple[int, int]:
        return self.size or tuple(self.backend.screen_size())

    async def join(self) -> Viewer:
        viewer = Viewer()
        if self.size is None:
            self.size = tuple(await asyncio.to_thread(self.backend.screen_size))
        viewer.push_meta(meta_message(*self.size))
        if self.last_frame is not None:
            viewer.push_frame(self.last_frame)
        else:
            self._force_frame = True
        self.viewers.add(viewer)
        if not self._tasks:
            self._start()
        return viewer

    def leave(self, viewer: Viewer) -> None:
        self.viewers.discard(viewer)
        if not self.viewers:
            self._stop()

    def _start(self) -> None:
        self._loop = asyncio.get_running_loop()
        # 每次开始用新的比较器：上一轮被取消的截屏线程可能还在跑，会往旧的比较器里记一笔，
        # 让新一轮的第一帧被当成「没变」而不发（真实控制台里出现过：第一个连接马上断开、第二个连上后一直没有画面）
        self._detector = ChangeDetector()
        self._force_frame = True
        self._tasks = [asyncio.create_task(self._capture_loop()), asyncio.create_task(self._cursor_loop())]
        try:
            self.backend.start_hook(self._on_press_threadsafe)
        except Exception:
            log.exception("装鼠标钩子失败")

    def _stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        self._tasks = []
        try:
            self.backend.stop_hook()
        except Exception:
            log.exception("卸鼠标钩子失败")
        # 没人看时不跟踪画面，下一个人来时从新截的一帧开始
        self.last_frame = None
        self._cursor = None

    def _broadcast(self, message: dict) -> None:
        for viewer in self.viewers:
            viewer.push_json(message)

    def _capture_step(self, detector: ChangeDetector, force: bool) -> tuple[tuple[int, int], Optional[bytes]]:
        """在线程里跑：截屏 → 比较 → 变了（或 force）才缩放编码"""
        image = self.backend.grab()
        width, height = image.size
        changed = detector.changed(width, height, image.tobytes())
        if not changed and not force:
            return (width, height), None
        return (width, height), self.encode(image, self.max_width, self.quality)

    async def _capture_loop(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            started = loop.time()
            force = self._force_frame or self.last_frame is None
            self._force_frame = False
            try:
                size, data = await asyncio.to_thread(self._capture_step, self._detector, force)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                # 锁屏、UAC 安全桌面时截不到：记一次日志，1 秒后再试
                self._force_frame = self._force_frame or force
                if not self._grab_failed:
                    log.warning("截屏失败：%s", error)
                    self._grab_failed = True
                await asyncio.sleep(1)
                continue
            self._grab_failed = False
            if size != self.size:
                self.size = size
                # 校验和里带着尺寸，尺寸变了 data 一定有，meta 先于新尺寸的帧发出去
                for viewer in self.viewers:
                    viewer.push_meta(meta_message(*size))
            if data is None and self.last_frame is not None and loop.time() - self._last_sent >= self.keyframe_seconds:
                # 关键帧：画面没变也重发最新的一帧（不重新编码）
                data = self.last_frame
            if data is not None:
                self.last_frame = data
                self._last_sent = loop.time()
                for viewer in self.viewers:
                    viewer.push_frame(data)
            await asyncio.sleep(max(0.0, self.interval - (loop.time() - started)))

    async def _cursor_loop(self) -> None:
        while True:
            try:
                position = self.backend.cursor()
            except Exception:
                position = None
            if position is not None and position != self._cursor:
                self._cursor = position
                self._broadcast({"t": "cursor", "x": position[0], "y": position[1], "kind": "move"})
            await asyncio.sleep(self.cursor_interval)

    def _on_press_threadsafe(self, x: int, y: int) -> None:
        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self._on_press, x, y)

    def _on_press(self, x: int, y: int) -> None:
        if not self.viewers:
            return
        self._cursor = (x, y)
        self._broadcast({"t": "cursor", "x": x, "y": y, "kind": "press"})
