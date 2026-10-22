"""不出窗口地跑另一个 Python 模块（给 Windows-MCP 用）：

    pythonw -m heyagent_desktop_agent.launch --log-file C:\\HeyAgent\\logs\\windows-mcp.log \\
        --auth-key-file C:\\HeyAgent\\key --env ANONYMIZED_TELEMETRY=false -- -m windows_mcp serve ...

- pythonw 没有控制台，sys.stdout / stderr 是 None，Windows-MCP（uvicorn、click）往里写会出错：先接到日志文件上；
- --auth-key-file：从文件读密钥，在进程里补上 `--auth-key <密钥>`。密钥不出现在计划任务的定义和进程命令行里；
- --env：在进程里设环境变量（计划任务不一定拿得到刚改的系统环境变量）。
"""

from __future__ import annotations

import argparse
import os
import runpy
import sys

from .logs import redirect_output


def split_argv(argv: list[str]) -> tuple[list[str], list[str]]:
    if "--" not in argv:
        raise SystemExit("用法：launch [选项] -- -m <模块> [参数…]")
    index = argv.index("--")
    return argv[:index], argv[index + 1 :]


def main(argv: list[str] | None = None) -> None:
    own, target = split_argv(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(prog="heyagent_desktop_agent.launch")
    parser.add_argument("--log-file")
    parser.add_argument("--auth-key-file")
    parser.add_argument("--env", action="append", default=[], metavar="NAME=VALUE")
    args = parser.parse_args(own)
    if len(target) < 2 or target[0] != "-m":
        raise SystemExit("-- 后面要是 -m <模块> [参数…]")
    module, module_args = target[1], target[2:]

    redirect_output(args.log_file)
    for item in args.env:
        name, _, value = item.partition("=")
        os.environ[name] = value
    if args.auth_key_file:
        with open(args.auth_key_file, encoding="utf-8-sig") as file:
            module_args = [*module_args, "--auth-key", file.read().strip()]

    sys.argv = [module, *module_args]
    runpy.run_module(module, run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
