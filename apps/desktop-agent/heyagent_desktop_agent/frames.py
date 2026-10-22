"""画面帧：缩放尺寸、画面有没有变（纯函数，开发机上能测）"""

from __future__ import annotations

import zlib
from typing import Optional


def scaled_size(width: int, height: int, max_width: int) -> tuple[int, int]:
    """等比缩到最宽 max_width；本来就不宽的不放大"""
    if max_width <= 0 or width <= max_width:
        return width, height
    return max_width, max(1, round(height * max_width / width))


class ChangeDetector:
    """记住上一帧原始像素的校验和；一样就不发。尺寸变了一定算变了"""

    def __init__(self) -> None:
        self._last: Optional[tuple[int, int, int]] = None

    def changed(self, width: int, height: int, pixels: bytes) -> bool:
        # crc32 对几 MB 的数据只要几毫秒，比缩小再编码 JPEG 便宜得多
        signature = (width, height, zlib.crc32(pixels))
        if signature == self._last:
            return False
        self._last = signature
        return True

    def reset(self) -> None:
        self._last = None
