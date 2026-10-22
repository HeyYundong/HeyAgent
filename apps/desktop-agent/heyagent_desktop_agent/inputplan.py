"""把一条（校验过的）控制台消息换成一串抽象的输入动作（纯函数，开发机上能测）。

动作是元组，由 win32.send_actions 用 SendInput 执行：
- ("move", x, y)                 鼠标移到屏幕物理像素 (x, y)
- ("button", name, down)         name: left / right / middle / back / forward
- ("wheel", units) / ("hwheel", units)   Windows 的滚轮量（120 = 一格；wheel 正数 = 往上滚，hwheel 正数 = 往右）
- ("key", vk, extended, down)    虚拟键码
- ("unicode", unit, down)        一个 UTF-16 码元（KEYEVENTF_UNICODE，不经输入法，中文直接上屏）
- ("paste", text[, restore])     放进剪贴板再按 Ctrl+V（多行、长文字）；restore = 贴完把原来剪贴板里的文字放回去（POST /type 用）

文字（text 消息）：短的一行（输入法组好的字）按 UTF-16 码元逐个 unicode 发；有换行或超过 PASTE_MIN_UNITS 个码元的
（粘贴的大段文字）走剪贴板 + Ctrl+V。实测（Win11 记事本、开着微软拼音）：unicode 字符要经过输入法框架，程序大约
100 字 / 秒才处理完，比按键慢，而且和回车键走的不是一条路——多行文字逐个发会串行、乱序；把换行也按 unicode 发
（\\r）记事本又只当成空格。所以大段文字用剪贴板：快、换行对、顺序不乱。剪贴板里会留着这段文字（和远程桌面的剪贴板同步一样）。
同样的原因，unicode 字发出去以后，紧跟着的按键、鼠标键要等一等（Pacer），免得「打完字马上回车发送」时回车跑到字前面。

按键：能打出字的键（keyDown 带 text，没按 Ctrl / Alt / Win）按文字发（unicode），不按虚拟键码发。
人在控制台那边已经用自己的输入法打好了字，要是按虚拟键码发，虚拟机里的中文输入法（中文模式）会再组一次字，
打 abc 出来的是候选框。这和浏览器远程画面的做法一致（CDP 按 text 插入字符）。回车、空格照样按键发：
回车要触发「发送」「确定」，空格要能勾选框、按按钮。

一条 WebSocket 连接一个 InputPlanner：记着按下没抬起的键和鼠标键（断开时全部抬起，免得卡住），
以及滚轮不足一格的零头。
"""

from __future__ import annotations

from .keymap import COMBOS, key_for

Action = tuple

WHEEL_DELTA = 120
# 浏览器一格滚轮是 100 像素（wheelDelta 已把按行、按页的换成像素），换成 Windows 的一格 120
WHEEL_UNITS_PER_PIXEL = WHEEL_DELTA / 100


def to_absolute(x: float, y: float, width: int, height: int) -> tuple[int, int]:
    """屏幕物理像素 → SendInput MOUSEEVENTF_ABSOLUTE 的 0..65535 坐标（主屏）"""
    px = min(max(round(x), 0), max(width - 1, 0))
    py = min(max(round(y), 0), max(height - 1, 0))
    ax = round(px * 65535 / (width - 1)) if width > 1 else 0
    ay = round(py * 65535 / (height - 1)) if height > 1 else 0
    return ax, ay


# 超过这么多个 UTF-16 码元的文字走剪贴板
PASTE_MIN_UNITS = 64
# 估计程序处理一个 unicode 字要多久（实测记事本约 10 毫秒），按它给后面的按键让路
UNICODE_SETTLE_SECONDS = 0.012
# 最多等这么久
MAX_SETTLE_SECONDS = 2.0


def utf16_units(text: str) -> list[int]:
    data = text.encode("utf-16-le")
    return [data[i] | (data[i + 1] << 8) for i in range(0, len(data), 2)]


def text_actions(text: str) -> list[Action]:
    """文字 → 按 UTF-16 码元逐个 unicode 按下、抬起（emoji 等辅助平面字符是一对代理码元，照样逐个发）"""
    actions: list[Action] = []
    for unit in utf16_units(text):
        actions.append(("unicode", unit, True))
        actions.append(("unicode", unit, False))
    return actions


def plan_text(text: str, restore_clipboard: bool = False) -> list[Action]:
    """text 消息 / POST /type：多行或长的走剪贴板（换行统一成 Windows 的 \\r\\n），短的一行逐字发。
    restore_clipboard：贴完把剪贴板原来的文字放回去（agent 打字不该冲掉剪贴板里人的东西；远程画面里人粘贴不用）"""
    if "\n" in text or "\r" in text or len(utf16_units(text)) > PASTE_MIN_UNITS:
        pasted = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
        return [("paste", pasted, True)] if restore_clipboard else [("paste", pasted)]
    return text_actions(text)


class Pacer:
    """unicode 字发出去以后，按键、鼠标键、粘贴要等前面的字大致处理完再发（鼠标移动、滚轮不用等）"""

    def __init__(self, per_unit: float = UNICODE_SETTLE_SECONDS) -> None:
        self.per_unit = per_unit
        self.settle_until = 0.0

    def delay_before(self, actions: list[Action], now: float) -> float:
        if any(action[0] in ("key", "button", "paste") for action in actions):
            return min(max(0.0, self.settle_until - now), MAX_SETTLE_SECONDS)
        return 0.0

    def sent(self, actions: list[Action], now: float) -> None:
        units = sum(1 for action in actions if action[0] == "unicode" and action[2])
        if units:
            self.settle_until = max(now, self.settle_until) + units * self.per_unit


# 修饰键位（同 CDP）：Alt=1 Ctrl=2 Meta=4 Shift=8
_COMMAND_MODIFIERS = 1 | 2 | 4


def types_text(message: dict) -> bool:
    """这个 keyDown 是不是「打一个字」：带 text、是一个可见字符（不是回车、空格、控制字符），没按 Ctrl / Alt / Win"""
    text = message.get("text")
    if not text or message.get("modifiers", 0) & _COMMAND_MODIFIERS:
        return False
    return all(ch.isprintable() and not ch.isspace() for ch in text)


class InputPlanner:
    def __init__(self) -> None:
        self.pressed_keys: dict[int, bool] = {}  # vk → extended
        self.pressed_buttons: set[str] = set()
        # 按文字发出去的键：它们的 keyUp 不用再发
        self.text_keys: set = set()
        self._wheel_rest = 0.0
        self._hwheel_rest = 0.0

    def plan(self, message: dict, width: int, height: int) -> list[Action]:
        kind = message["t"]
        if kind == "mouse":
            return self._mouse(message, width, height)
        if kind == "key":
            return self._key(message)
        if kind == "text":
            return plan_text(message["text"])
        if kind == "combo":
            return self._combo(message["keys"])
        return []

    def release_all(self) -> list[Action]:
        """连接断开时：抬起还按着的键和鼠标键"""
        actions: list[Action] = [("key", vk, ext, False) for vk, ext in self.pressed_keys.items()]
        actions += [("button", name, False) for name in sorted(self.pressed_buttons)]
        self.pressed_keys.clear()
        self.pressed_buttons.clear()
        return actions

    def _mouse(self, message: dict, width: int, height: int) -> list[Action]:
        x = min(max(round(message["x"]), 0), max(width - 1, 0))
        y = min(max(round(message["y"]), 0), max(height - 1, 0))
        actions: list[Action] = [("move", x, y)]
        kind = message["type"]
        button = message.get("button", "none")
        if kind == "mousePressed" and button != "none":
            actions.append(("button", button, True))
            self.pressed_buttons.add(button)
        elif kind == "mouseReleased" and button != "none":
            actions.append(("button", button, False))
            self.pressed_buttons.discard(button)
        elif kind == "mouseWheel":
            vertical, self._wheel_rest = self._wheel_units(-message.get("deltaY", 0), self._wheel_rest)
            horizontal, self._hwheel_rest = self._wheel_units(message.get("deltaX", 0), self._hwheel_rest)
            if vertical:
                actions.append(("wheel", vertical))
            if horizontal:
                actions.append(("hwheel", horizontal))
        return actions

    @staticmethod
    def _wheel_units(pixels: float, rest: float) -> tuple[int, float]:
        """按整格（120 的倍数）发，不足一格的零头留着和下一次加起来：不少老程序只认整格"""
        total = rest + pixels * WHEEL_UNITS_PER_PIXEL
        # 浮点误差：100 像素 × 1.2 可能是 119.99999
        notches = int(round(total / WHEEL_DELTA, 6))
        units = notches * WHEEL_DELTA
        return units, total - units

    def _key(self, message: dict) -> list[Action]:
        kind = message["type"]
        if kind == "char":
            return []
        ident = message.get("code") or message.get("keyCode")
        if kind == "keyDown" and types_text(message):
            self.text_keys.add(ident)
            return text_actions(message["text"])
        if kind == "keyUp" and ident in self.text_keys:
            self.text_keys.discard(ident)
            return []
        key = key_for(message.get("code"), message.get("keyCode"))
        if key is None:
            return []
        down = kind in ("keyDown", "rawKeyDown")
        if down:
            self.pressed_keys[key.vk] = key.extended
        else:
            self.pressed_keys.pop(key.vk, None)
        return [("key", key.vk, key.extended, down)]

    @staticmethod
    def _combo(name: str) -> list[Action]:
        keys = COMBOS.get(name)
        if not keys:
            return []
        actions: list[Action] = [("key", k.vk, k.extended, True) for k in keys]
        actions += [("key", k.vk, k.extended, False) for k in reversed(keys)]
        return actions

