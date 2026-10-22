"""控制台 → 桌面服务的消息校验（纯函数）。

和 packages/shared/src/desktop.ts 的 desktopViewerClientMessageSchema 一致：mouse / key / text 三种沿用浏览器
远程画面的 viewerClientMessageSchema，另加 combo。服务端（API）转发前已经按同一个 schema 校验过，
这里再校验一遍，不认识、不合法的一律丢掉（返回 None），不报错、不断开。
和 zod 一样：多出来的字段忽略；可选字段可以不给，但给了 null 不行。
"""

from __future__ import annotations

import math
from typing import Any, Optional

MOUSE_TYPES = ("mousePressed", "mouseReleased", "mouseMoved", "mouseWheel")
MOUSE_BUTTONS = ("none", "left", "middle", "right", "back", "forward")
KEY_TYPES = ("keyDown", "keyUp", "rawKeyDown", "char")
COMBO_KEYS = ("win", "alt+tab", "alt+f4", "win+d", "win+r")
TEXT_MAX = 10_000

_MISSING = object()


class _Invalid(Exception):
    pass


def _number(value: Any) -> float:
    # bool 是 int 的子类，JSON 的 true 不能当数字
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise _Invalid
    return value


def _int(value: Any, low: int, high: int) -> int:
    number = _number(value)
    if number != int(number) or not low <= number <= high:
        raise _Invalid
    return int(number)


def _string(value: Any, max_len: int, min_len: int = 0) -> str:
    # zod 的 max/min 按 JS 字符串长度（UTF-16 码元）算
    if not isinstance(value, str):
        raise _Invalid
    units = len(value.encode("utf-16-le")) // 2
    if not min_len <= units <= max_len:
        raise _Invalid
    return value


def _enum(value: Any, allowed: tuple[str, ...]) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise _Invalid
    return value


def _optional(data: dict, name: str, check) -> Any:
    value = data.get(name, _MISSING)
    if value is _MISSING:
        return None
    return check(value)


def _mouse(data: dict) -> dict:
    message = {
        "t": "mouse",
        "type": _enum(data.get("type"), MOUSE_TYPES),
        "x": _number(data.get("x")),
        "y": _number(data.get("y")),
    }
    optional = {
        "button": lambda v: _enum(v, MOUSE_BUTTONS),
        "buttons": lambda v: _int(v, 0, 31),
        "clickCount": lambda v: _int(v, 0, 3),
        "modifiers": lambda v: _int(v, 0, 15),
        "deltaX": _number,
        "deltaY": _number,
    }
    for name, check in optional.items():
        value = _optional(data, name, check)
        if value is not None:
            message[name] = value
    return message


def _key(data: dict) -> dict:
    message = {"t": "key", "type": _enum(data.get("type"), KEY_TYPES)}
    optional = {
        "key": lambda v: _string(v, 40),
        "code": lambda v: _string(v, 40),
        "keyCode": lambda v: _int(v, 0, 1000),
        "text": lambda v: _string(v, 8),
        "modifiers": lambda v: _int(v, 0, 15),
    }
    for name, check in optional.items():
        value = _optional(data, name, check)
        if value is not None:
            message[name] = value
    return message


def _text(data: dict) -> dict:
    return {"t": "text", "text": _string(data.get("text"), TEXT_MAX, 1)}


def _combo(data: dict) -> dict:
    return {"t": "combo", "keys": _enum(data.get("keys"), COMBO_KEYS)}


_PARSERS = {"mouse": _mouse, "key": _key, "text": _text, "combo": _combo}


def parse_client_message(data: Any) -> Optional[dict]:
    """校验一条已经 JSON 解析过的消息；合法返回整理后的 dict（只留认识的字段），否则 None"""
    if not isinstance(data, dict):
        return None
    parser = _PARSERS.get(data.get("t")) if isinstance(data.get("t"), str) else None
    if parser is None:
        return None
    try:
        return parser(data)
    except _Invalid:
        return None


def parse_type_request(data: Any) -> Optional[str]:
    """POST /type 的请求体 {"text": "..."}：text 是 1～10000 个字（按 UTF-16 码元算，同 zod）。不合法返回 None"""
    if not isinstance(data, dict):
        return None
    try:
        return _string(data.get("text"), TEXT_MAX, 1)
    except _Invalid:
        return None
