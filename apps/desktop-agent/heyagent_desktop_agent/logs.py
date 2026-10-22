"""日志：pythonw 没有控制台（sys.stdout / sys.stderr 是 None），把它们接到日志文件上"""

from __future__ import annotations

import os
import sys
from typing import Optional

MAX_LOG_BYTES = 10 * 1024 * 1024


def redirect_output(log_file: Optional[str]) -> None:
    """stdout、stderr 都写到 log_file（追加；超过 10 MB 先改名成 .1，只留一份旧的）。
    没给文件、又没有控制台时写到空设备，免得 print / logging 报错"""
    if log_file:
        os.makedirs(os.path.dirname(os.path.abspath(log_file)), exist_ok=True)
        try:
            if os.path.getsize(log_file) > MAX_LOG_BYTES:
                os.replace(log_file, log_file + ".1")
        except OSError:
            pass
        stream = open(log_file, "a", encoding="utf-8", errors="backslashreplace", buffering=1)
    elif sys.stdout is None or sys.stderr is None:
        stream = open(os.devnull, "w", encoding="utf-8")
    else:
        return
    sys.stdout = stream
    sys.stderr = stream
