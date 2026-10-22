"""Windows 上的实际操作：DPI 感知、截屏、鼠标位置、SendInput、低级鼠标钩子。只在 Windows 上导入。

全部用 ctypes 调 user32 / shcore，不依赖 pywin32。坐标一律是主屏的物理像素（进程已经 DPI 感知）。
"""

from __future__ import annotations

import ctypes
import logging
import threading
import time
from ctypes import wintypes
from typing import Callable, Optional, Sequence

from .inputplan import Pacer, to_absolute
from .keymap import VK_LCONTROL

log = logging.getLogger(__name__)

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

ULONG_PTR = ctypes.c_size_t
LRESULT = ctypes.c_ssize_t

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_XDOWN = 0x0080
MOUSEEVENTF_XUP = 0x0100
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000
MOUSEEVENTF_ABSOLUTE = 0x8000
XBUTTON1 = 0x0001
XBUTTON2 = 0x0002

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

_BUTTON_FLAGS = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 0),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 0),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, 0),
    "back": (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, XBUTTON1),
    "forward": (MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, XBUTTON2),
}


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("pt", wintypes.POINT),
        ("mouseData", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


HOOKPROC = ctypes.WINFUNCTYPE(LRESULT, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.SendInput.restype = wintypes.UINT
user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
user32.GetCursorPos.restype = wintypes.BOOL
user32.GetSystemMetrics.argtypes = [ctypes.c_int]
user32.GetSystemMetrics.restype = ctypes.c_int
user32.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
user32.MapVirtualKeyW.restype = wintypes.UINT
user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD]
user32.SetWindowsHookExW.restype = wintypes.HHOOK
user32.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
user32.CallNextHookEx.restype = LRESULT
user32.UnhookWindowsHookEx.argtypes = [wintypes.HHOOK]
user32.UnhookWindowsHookEx.restype = wintypes.BOOL
user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
user32.GetMessageW.restype = wintypes.BOOL
user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.PostThreadMessageW.restype = wintypes.BOOL
user32.OpenClipboard.argtypes = [wintypes.HWND]
user32.OpenClipboard.restype = wintypes.BOOL
user32.EmptyClipboard.restype = wintypes.BOOL
user32.CloseClipboard.restype = wintypes.BOOL
user32.IsClipboardFormatAvailable.argtypes = [wintypes.UINT]
user32.IsClipboardFormatAvailable.restype = wintypes.BOOL
user32.GetClipboardData.argtypes = [wintypes.UINT]
user32.GetClipboardData.restype = wintypes.HANDLE
user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
user32.SetClipboardData.restype = wintypes.HANDLE
user32.CreateWindowExW.argtypes = [
    wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
]
user32.CreateWindowExW.restype = wintypes.HWND
user32.DestroyWindow.argtypes = [wintypes.HWND]
user32.DestroyWindow.restype = wintypes.BOOL
kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalLock.restype = wintypes.LPVOID
kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalUnlock.restype = wintypes.BOOL
kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalFree.restype = wintypes.HGLOBAL
kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE
kernel32.GetCurrentThreadId.restype = wintypes.DWORD

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
HWND_MESSAGE = wintypes.HWND(-3)
SM_CXSCREEN = 0
SM_CYSCREEN = 1
WH_MOUSE_LL = 14
WM_QUIT = 0x0012
_PRESS_MESSAGES = {0x0201, 0x0204, 0x0207, 0x020B}  # 左 / 右 / 中 / X 键按下


def set_dpi_awareness() -> str:
    """进程设成按显示器 DPI 感知：否则在 125%、150% 缩放下截图和坐标都被系统缩放过。要在建任何窗口、截屏之前调"""
    try:
        # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4（Win10 1703+）
        if ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return "per-monitor-v2"
    except (AttributeError, OSError):
        pass
    try:
        # PROCESS_PER_MONITOR_DPI_AWARE = 2
        if ctypes.windll.shcore.SetProcessDpiAwareness(2) == 0:
            return "per-monitor"
    except (AttributeError, OSError):
        pass
    ctypes.windll.user32.SetProcessDPIAware()
    return "system"


def screen_size() -> tuple[int, int]:
    return user32.GetSystemMetrics(SM_CXSCREEN), user32.GetSystemMetrics(SM_CYSCREEN)


def cursor_pos() -> Optional[tuple[int, int]]:
    point = wintypes.POINT()
    # 锁屏、UAC 安全桌面时取不到
    if not user32.GetCursorPos(ctypes.byref(point)):
        return None
    return point.x, point.y


def grab():
    """截主屏，返回 PIL Image（RGB，物理像素）"""
    from PIL import ImageGrab

    return ImageGrab.grab()


def _mouse(flags: int, dx: int = 0, dy: int = 0, data: int = 0) -> INPUT:
    item = INPUT(type=INPUT_MOUSE)
    item.u.mi = MOUSEINPUT(dx, dy, data & 0xFFFFFFFF, flags, 0, 0)
    return item


def _key(vk: int, scan: int, flags: int) -> INPUT:
    item = INPUT(type=INPUT_KEYBOARD)
    item.u.ki = KEYBDINPUT(vk, scan, flags, 0, 0)
    return item


def build_inputs(actions: Sequence[tuple], width: int, height: int) -> list[INPUT]:
    inputs: list[INPUT] = []
    for action in actions:
        kind = action[0]
        if kind == "move":
            ax, ay = to_absolute(action[1], action[2], width, height)
            inputs.append(_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, ax, ay))
        elif kind == "button":
            down_flag, up_flag, data = _BUTTON_FLAGS[action[1]]
            inputs.append(_mouse(down_flag if action[2] else up_flag, data=data))
        elif kind == "wheel":
            inputs.append(_mouse(MOUSEEVENTF_WHEEL, data=action[1]))
        elif kind == "hwheel":
            inputs.append(_mouse(MOUSEEVENTF_HWHEEL, data=action[1]))
        elif kind == "key":
            vk, extended, down = action[1], action[2], action[3]
            flags = (KEYEVENTF_EXTENDEDKEY if extended else 0) | (0 if down else KEYEVENTF_KEYUP)
            inputs.append(_key(vk, user32.MapVirtualKeyW(vk, 0) & 0xFFFF, flags))
        elif kind == "unicode":
            unit, down = action[1], action[2]
            inputs.append(_key(0, unit, KEYEVENTF_UNICODE | (0 if down else KEYEVENTF_KEYUP)))
    return inputs


class _Clipboard:
    """打开剪贴板（with 用）。剪贴板要有个所有者窗口，不然 SetClipboardData 可能失败：临时建一个看不见的消息窗口"""

    def __enter__(self) -> "_Clipboard":
        self.hwnd = user32.CreateWindowExW(0, "STATIC", None, 0, 0, 0, 0, 0, HWND_MESSAGE, None, None, None)
        for _ in range(20):
            # 别的程序正开着剪贴板时打不开，稍等再试
            if user32.OpenClipboard(self.hwnd):
                return self
            time.sleep(0.05)
        if self.hwnd:
            user32.DestroyWindow(self.hwnd)
        raise OSError(f"打不开剪贴板（错误码 {ctypes.get_last_error()}）")

    def __exit__(self, *exc: object) -> None:
        user32.CloseClipboard()
        if self.hwnd:
            user32.DestroyWindow(self.hwnd)


def get_clipboard_text() -> Optional[str]:
    """剪贴板里的文字；没有文字（空的、是图片、是文件）返回 None"""
    with _Clipboard():
        if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return None
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return None
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            return None
        try:
            return ctypes.wstring_at(pointer)
        finally:
            kernel32.GlobalUnlock(handle)


def set_clipboard_text(text: str) -> None:
    """文字放进剪贴板（CF_UNICODETEXT）"""
    with _Clipboard():
        user32.EmptyClipboard()
        data = text.encode("utf-16-le") + b"\x00\x00"
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not handle:
            raise MemoryError("GlobalAlloc 失败")
        pointer = kernel32.GlobalLock(handle)
        ctypes.memmove(pointer, data, len(data))
        kernel32.GlobalUnlock(handle)
        if not user32.SetClipboardData(CF_UNICODETEXT, handle):
            kernel32.GlobalFree(handle)
            raise OSError(f"SetClipboardData 失败（错误码 {ctypes.get_last_error()}）")
        # 成功后这块内存归系统管，不能再释放


# 按了 Ctrl+V 以后，等多久再把剪贴板换回去：程序是异步读剪贴板的，换早了贴进去的是原来的内容
PASTE_SETTLE_SECONDS = 1.0


_CTRL_V = [("key", VK_LCONTROL, False, True), ("key", ord("V"), False, True), ("key", ord("V"), False, False), ("key", VK_LCONTROL, False, False)]
_BATCH = 200


def _send_inputs(inputs: list[INPUT]) -> int:
    sent = 0
    for start in range(0, len(inputs), _BATCH):
        batch = inputs[start : start + _BATCH]
        array = (INPUT * len(batch))(*batch)
        count = user32.SendInput(len(batch), array, ctypes.sizeof(INPUT))
        sent += count
        if count != len(batch):
            # 常见原因：锁屏 / UAC 安全桌面，或者目标窗口权限比本进程高（UIPI）
            log.warning("SendInput 只送进去 %d/%d 个（错误码 %d）", count, len(batch), ctypes.get_last_error())
            break
        if start + _BATCH < len(inputs):
            time.sleep(0.01)
    return sent


def send_actions(actions: Sequence[tuple], width: int, height: int) -> int:
    """执行 inputplan 的动作；返回实际送进去的输入数。paste 动作：放进剪贴板再按 Ctrl+V"""
    sent = 0
    pending: list[tuple] = []
    for action in [*actions, None]:
        if action is not None and action[0] != "paste":
            pending.append(action)
            continue
        if pending:
            sent += _send_inputs(build_inputs(pending, width, height))
            pending = []
        if action is not None:
            sent += _paste(action[1], restore=len(action) > 2 and bool(action[2]), width=width, height=height)
    return sent


def _paste(text: str, restore: bool, width: int, height: int) -> int:
    previous = None
    if restore:
        try:
            previous = get_clipboard_text()
        except OSError:
            log.warning("读不到原来的剪贴板，贴完不还原")
    set_clipboard_text(text)
    sent = _send_inputs(build_inputs(_CTRL_V, width, height))
    if restore:
        time.sleep(PASTE_SETTLE_SECONDS)
        # 只还原文字（原来是图片、文件的还原不了）；这期间剪贴板被别人改过就不动
        if previous is not None and get_clipboard_text() == text:
            set_clipboard_text(previous)
    return sent


class MouseHook:
    """低级鼠标钩子：任何鼠标键按下（人点的、agent 用 Windows-MCP 点的都算）都回调 on_press(x, y)。
    只在有人看画面时装：钩子回调在本进程里跑，整个系统的鼠标事件都要过它一下"""

    def __init__(self, on_press: Callable[[int, int], None]) -> None:
        self._on_press = on_press
        self._thread: Optional[threading.Thread] = None
        self._thread_id = 0
        self._ready = threading.Event()
        # 回调对象要一直被引用着，不然被回收后系统调到野指针
        self._proc = HOOKPROC(self._callback)

    def _callback(self, code: int, wparam: int, lparam: int) -> int:
        if code == 0 and wparam in _PRESS_MESSAGES:
            try:
                info = ctypes.cast(lparam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
                self._on_press(info.pt.x, info.pt.y)
            except Exception:  # 钩子回调里不能抛异常
                log.exception("鼠标钩子回调出错")
        return user32.CallNextHookEx(None, code, wparam, lparam)

    def _run(self) -> None:
        self._thread_id = kernel32.GetCurrentThreadId()
        hook = user32.SetWindowsHookExW(WH_MOUSE_LL, self._proc, kernel32.GetModuleHandleW(None), 0)
        self._ready.set()
        if not hook:
            log.warning("装鼠标钩子失败（错误码 %d），远程画面不显示按下的位置", ctypes.get_last_error())
            return
        msg = wintypes.MSG()
        try:
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                pass
        finally:
            user32.UnhookWindowsHookEx(hook)

    def start(self) -> None:
        if self._thread is not None:
            return
        self._ready.clear()
        self._thread = threading.Thread(target=self._run, name="mouse-hook", daemon=True)
        self._thread.start()
        self._ready.wait(2)

    def stop(self) -> None:
        thread, self._thread = self._thread, None
        if thread is None:
            return
        if self._thread_id:
            user32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)
        thread.join(2)
        self._thread_id = 0


class WindowsBackend:
    """给 ViewHub / app 用的统一接口（测试里换成假的）"""

    def __init__(self) -> None:
        self._hook: Optional[MouseHook] = None
        self._pacer = Pacer()

    screen_size = staticmethod(screen_size)
    cursor = staticmethod(cursor_pos)
    grab = staticmethod(grab)

    def send(self, actions: Sequence[tuple], width: int, height: int) -> int:
        """只在输入线程里调（一个接一个）：先等前面打的字处理完（Pacer），再发"""
        delay = self._pacer.delay_before(list(actions), time.monotonic())
        if delay > 0:
            time.sleep(delay)
        try:
            return send_actions(actions, width, height)
        finally:
            self._pacer.sent(list(actions), time.monotonic())

    def type_text(self, actions: Sequence[tuple], width: int, height: int) -> int:
        """POST /type：发完再等字大致处理完才返回（粘贴的在 _paste 里已经等过）"""
        sent = self.send(actions, width, height)
        delay = self._pacer.settle_until - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        return sent

    def start_hook(self, on_press: Callable[[int, int], None]) -> None:
        if self._hook is None:
            self._hook = MouseHook(on_press)
            self._hook.start()

    def stop_hook(self) -> None:
        hook, self._hook = self._hook, None
        if hook is not None:
            hook.stop()
