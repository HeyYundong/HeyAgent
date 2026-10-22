"""DOM 键码 → Windows 虚拟键码（纯函数，开发机上能测）。

控制台发来的 key 消息里有 DOM 的 `code`（物理键位，例如 KeyA、ShiftLeft）和 `keyCode`。
优先按 `code` 换算：它和键盘布局无关，左右 Shift / Ctrl 也分得开；没有 `code` 时退回 `keyCode`
（DOM 的 keyCode 本来就是照 Windows 虚拟键码定的，大多数键数值相同）。
"""

from __future__ import annotations

from typing import NamedTuple, Optional


class Key(NamedTuple):
    vk: int
    # 扩展键（方向键、Insert/Delete、右 Ctrl / Alt、小键盘的回车和除号……）：SendInput 要带 KEYEVENTF_EXTENDEDKEY，
    # 否则会被当成小键盘上的同名键（例如 NumLock 关着时按出 2 而不是 ↓）
    extended: bool = False


VK_BACK = 0x08
VK_TAB = 0x09
VK_RETURN = 0x0D
VK_SHIFT = 0x10
VK_CONTROL = 0x11
VK_MENU = 0x12
VK_PAUSE = 0x13
VK_CAPITAL = 0x14
VK_ESCAPE = 0x1B
VK_SPACE = 0x20
VK_PRIOR = 0x21
VK_NEXT = 0x22
VK_END = 0x23
VK_HOME = 0x24
VK_LEFT = 0x25
VK_UP = 0x26
VK_RIGHT = 0x27
VK_DOWN = 0x28
VK_SNAPSHOT = 0x2C
VK_INSERT = 0x2D
VK_DELETE = 0x2E
VK_LWIN = 0x5B
VK_RWIN = 0x5C
VK_APPS = 0x5D
VK_NUMPAD0 = 0x60
VK_MULTIPLY = 0x6A
VK_ADD = 0x6B
VK_SEPARATOR = 0x6C
VK_SUBTRACT = 0x6D
VK_DECIMAL = 0x6E
VK_DIVIDE = 0x6F
VK_F1 = 0x70
VK_NUMLOCK = 0x90
VK_SCROLL = 0x91
VK_LSHIFT = 0xA0
VK_RSHIFT = 0xA1
VK_LCONTROL = 0xA2
VK_RCONTROL = 0xA3
VK_LMENU = 0xA4
VK_RMENU = 0xA5
VK_VOLUME_MUTE = 0xAD
VK_VOLUME_DOWN = 0xAE
VK_VOLUME_UP = 0xAF
VK_MEDIA_NEXT_TRACK = 0xB0
VK_MEDIA_PREV_TRACK = 0xB1
VK_MEDIA_STOP = 0xB2
VK_MEDIA_PLAY_PAUSE = 0xB3
VK_OEM_1 = 0xBA  # ;:
VK_OEM_PLUS = 0xBB  # =+
VK_OEM_COMMA = 0xBC
VK_OEM_MINUS = 0xBD
VK_OEM_PERIOD = 0xBE
VK_OEM_2 = 0xBF  # /?
VK_OEM_3 = 0xC0  # `~
VK_OEM_4 = 0xDB  # [{
VK_OEM_5 = 0xDC  # \|
VK_OEM_6 = 0xDD  # ]}
VK_OEM_7 = 0xDE  # '"
VK_OEM_102 = 0xE2  # 102 键键盘上 Shift 旁边那个 \


def _build_code_map() -> dict[str, Key]:
    table: dict[str, Key] = {}
    for offset in range(26):
        letter = chr(ord("A") + offset)
        table[f"Key{letter}"] = Key(ord(letter))
    for digit in range(10):
        table[f"Digit{digit}"] = Key(ord("0") + digit)
        table[f"Numpad{digit}"] = Key(VK_NUMPAD0 + digit)
    for n in range(1, 25):
        table[f"F{n}"] = Key(VK_F1 + n - 1)
    table.update(
        {
            "Backspace": Key(VK_BACK),
            "Tab": Key(VK_TAB),
            "Enter": Key(VK_RETURN),
            "NumpadEnter": Key(VK_RETURN, True),
            "ShiftLeft": Key(VK_LSHIFT),
            "ShiftRight": Key(VK_RSHIFT),
            "ControlLeft": Key(VK_LCONTROL),
            "ControlRight": Key(VK_RCONTROL, True),
            "AltLeft": Key(VK_LMENU),
            "AltRight": Key(VK_RMENU, True),
            "MetaLeft": Key(VK_LWIN, True),
            "MetaRight": Key(VK_RWIN, True),
            "OSLeft": Key(VK_LWIN, True),
            "OSRight": Key(VK_RWIN, True),
            "ContextMenu": Key(VK_APPS, True),
            "Pause": Key(VK_PAUSE),
            "CapsLock": Key(VK_CAPITAL),
            "Escape": Key(VK_ESCAPE),
            "Space": Key(VK_SPACE),
            "PageUp": Key(VK_PRIOR, True),
            "PageDown": Key(VK_NEXT, True),
            "End": Key(VK_END, True),
            "Home": Key(VK_HOME, True),
            "ArrowLeft": Key(VK_LEFT, True),
            "ArrowUp": Key(VK_UP, True),
            "ArrowRight": Key(VK_RIGHT, True),
            "ArrowDown": Key(VK_DOWN, True),
            "PrintScreen": Key(VK_SNAPSHOT, True),
            "Insert": Key(VK_INSERT, True),
            "Delete": Key(VK_DELETE, True),
            "NumpadMultiply": Key(VK_MULTIPLY),
            "NumpadAdd": Key(VK_ADD),
            "NumpadComma": Key(VK_SEPARATOR),
            "NumpadSubtract": Key(VK_SUBTRACT),
            "NumpadDecimal": Key(VK_DECIMAL),
            "NumpadDivide": Key(VK_DIVIDE, True),
            "NumLock": Key(VK_NUMLOCK, True),
            "ScrollLock": Key(VK_SCROLL),
            "Semicolon": Key(VK_OEM_1),
            "Equal": Key(VK_OEM_PLUS),
            "Comma": Key(VK_OEM_COMMA),
            "Minus": Key(VK_OEM_MINUS),
            "Period": Key(VK_OEM_PERIOD),
            "Slash": Key(VK_OEM_2),
            "Backquote": Key(VK_OEM_3),
            "BracketLeft": Key(VK_OEM_4),
            "Backslash": Key(VK_OEM_5),
            "BracketRight": Key(VK_OEM_6),
            "Quote": Key(VK_OEM_7),
            "IntlBackslash": Key(VK_OEM_102),
            "AudioVolumeMute": Key(VK_VOLUME_MUTE, True),
            "AudioVolumeDown": Key(VK_VOLUME_DOWN, True),
            "AudioVolumeUp": Key(VK_VOLUME_UP, True),
            "MediaTrackNext": Key(VK_MEDIA_NEXT_TRACK, True),
            "MediaTrackPrevious": Key(VK_MEDIA_PREV_TRACK, True),
            "MediaStop": Key(VK_MEDIA_STOP, True),
            "MediaPlayPause": Key(VK_MEDIA_PLAY_PAUSE, True),
        }
    )
    return table


CODE_TO_KEY: dict[str, Key] = _build_code_map()

# keyCode 兜底时也要标扩展键的虚拟键码
_EXTENDED_VKS = {
    VK_PRIOR,
    VK_NEXT,
    VK_END,
    VK_HOME,
    VK_LEFT,
    VK_UP,
    VK_RIGHT,
    VK_DOWN,
    VK_SNAPSHOT,
    VK_INSERT,
    VK_DELETE,
    VK_LWIN,
    VK_RWIN,
    VK_APPS,
    VK_DIVIDE,
    VK_NUMLOCK,
    VK_RCONTROL,
    VK_RMENU,
}

# DOM keyCode 和 Windows 虚拟键码不一样的几个（Firefox 的旧值）
_KEYCODE_FIXUPS = {59: VK_OEM_1, 61: VK_OEM_PLUS, 173: VK_OEM_MINUS, 224: VK_LWIN}


def key_for(code: Optional[str], key_code: Optional[int]) -> Optional[Key]:
    """按 DOM code（优先）或 keyCode 找虚拟键码；找不到返回 None（这条消息丢掉）"""
    if code:
        found = CODE_TO_KEY.get(code)
        if found is not None:
            return found
    if key_code is None:
        return None
    vk = _KEYCODE_FIXUPS.get(key_code, key_code)
    # 0、229（输入法占位）、超出 1..254 的都不是真的按键
    if vk <= 0 or vk >= 255 or vk == 229:
        return None
    return Key(vk, vk in _EXTENDED_VKS)


# 工具栏的「组合键」按钮（shared 的 desktopComboSchema）：按住前面的键，按最后一个，再倒序抬起
COMBOS: dict[str, tuple[Key, ...]] = {
    "win": (Key(VK_LWIN, True),),
    "alt+tab": (Key(VK_LMENU), Key(VK_TAB)),
    "alt+f4": (Key(VK_LMENU), Key(VK_F1 + 3)),
    "win+d": (Key(VK_LWIN, True), Key(ord("D"))),
    "win+r": (Key(VK_LWIN, True), Key(ord("R"))),
}
