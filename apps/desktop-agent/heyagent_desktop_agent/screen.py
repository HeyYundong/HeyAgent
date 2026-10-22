"""截图编码：缩放 + JPEG（Pillow）"""

from __future__ import annotations

import io

from .frames import scaled_size


def encode_jpeg(image, max_width: int, quality: int) -> bytes:
    from PIL import Image

    size = scaled_size(image.width, image.height, max_width)
    if size != image.size:
        # BILINEAR 够清楚，比 LANCZOS 快好几倍（5 帧 / 秒要省着用 CPU）
        image = image.resize(size, Image.Resampling.BILINEAR)
    if image.mode != "RGB":
        image = image.convert("RGB")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality)
    return buffer.getvalue()
