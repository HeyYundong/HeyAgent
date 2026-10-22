"""传文件：文件名清理、重名加序号、取文件的路径白名单（纯函数为主，开发机上能测）。

路径判断用 ntpath（Windows 的路径规则），所以在 Linux 上也能按 Windows 的写法测。
"""

from __future__ import annotations

import ntpath
import os
import re
from typing import Callable, Iterable, Optional

MAX_FILE_BYTES = 200 * 1024 * 1024
MAX_NAME_CHARS = 150

_RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}
_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')


def sanitize_name(name: str) -> str:
    """只留文件名本身，去掉 Windows 不允许的字符和保留名；空了就叫 file"""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    base = _BAD_CHARS.sub("_", base).strip().rstrip(". ")
    if not base or base in (".", ".."):
        base = "file"
    stem, ext = ntpath.splitext(base)
    if stem.split(".")[0].upper() in _RESERVED:
        stem = f"_{stem}"
    # 太长的截短，扩展名保留（扩展名本身离谱地长就一起截）
    if len(ext) > 20:
        stem, ext = stem + ext, ""
    stem = stem[: max(MAX_NAME_CHARS - len(ext), 1)]
    return f"{stem}{ext}"


def numbered_names(name: str) -> Iterable[str]:
    """a.txt, a (1).txt, a (2).txt, …"""
    yield name
    stem, ext = ntpath.splitext(name)
    n = 1
    while True:
        yield f"{stem} ({n}){ext}"
        n += 1


def unique_name(name: str, exists: Callable[[str], bool]) -> str:
    for candidate in numbered_names(name):
        if not exists(candidate):
            return candidate
    raise AssertionError("unreachable")


def _norm(path: str) -> str:
    return ntpath.normcase(ntpath.normpath(path)).rstrip("\\")


def is_allowed_path(path: str, roots: Iterable[str]) -> bool:
    """path 必须是某个 root 下面的文件（不能是 root 本身）。
    path、roots 都应该已经 realpath 过（跟随了符号链接 / 目录联接）；这里再拒绝几种危险写法：
    相对路径、UNC（\\\\server\\share）、设备路径（\\\\?\\、\\\\.\\）、备用数据流（a.txt:stream）"""
    if not path or "\x00" in path:
        return False
    if path.startswith(("\\\\", "//")):
        return False
    drive, rest = ntpath.splitdrive(path)
    if not drive or not rest.startswith(("\\", "/")):
        return False
    if ":" in rest:
        return False
    target = _norm(path)
    for root in roots:
        if not root:
            continue
        base = _norm(root)
        if target != base and target.startswith(base + "\\"):
            return True
    return False


def resolve_download(path: str, roots: Iterable[str], realpath: Callable[[str], str] = os.path.realpath) -> Optional[str]:
    """检查要取的文件：先按原样查一遍（挡住 UNC 等），再跟随链接后查一遍。不允许返回 None"""
    roots = list(roots)
    if not is_allowed_path(path, roots):
        return None
    real = realpath(path)
    real_roots = [realpath(root) for root in roots if root]
    if not is_allowed_path(real, real_roots):
        return None
    return real


def header_file_name(name: str) -> str:
    """X-File-Name 响应头：HTTP 头只能是 latin-1，统一按 UTF-8 做百分号编码（同 encodeURIComponent）"""
    from urllib.parse import quote

    return quote(name, safe="!'()*-._~")
