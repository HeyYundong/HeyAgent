# 桌面服务（desktop-agent）

装在给 agent 用的 Windows 电脑上，和 Windows-MCP 0.8.8 一起组成一台「桌面」（说明见 `docs/dev/desktop.md`，运维见 `docs/ops.md`「桌面」一节）：

- **Windows-MCP**（端口 8000）：agent 读界面控件、点击、输入；
- **桌面服务**（本目录，端口 8001）：给控制台推远程画面、回传人的键鼠、截图、传文件。

两个服务用同一个密钥（`Authorization: Bearer <密钥>`），都跑在登录用户的桌面会话里（计划任务，`pythonw` 不出窗口）。

## 安装

前提：Windows 10 / 11，装好 Python 3.14（python.org 的安装包，为所有用户安装、加到 PATH），能上网（pip 要下载包）。
把本目录拷到那台电脑上，用「以管理员身份运行」的 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Key <密钥>
# 可选：-McpPort 8000 -AgentPort 8001 -AllowFrom 10.0.0.5（防火墙只放行 HeyAgent 服务器）-KeyFile <文件> -Python <python.exe>
```

重复运行就是更新。装好后：

| 东西 | 位置 |
|---|---|
| 密钥 | `C:\HeyAgent\key`（只有这个用户、管理员、SYSTEM 能读） |
| 日志 | `C:\HeyAgent\logs\desktop-agent.log`、`windows-mcp.log`（超过 10 MB 改名成 `.1`） |
| 传上来的文件 | `C:\HeyAgent\files\<日期>\` |
| 计划任务 | 任务计划程序里的 `\HeyAgent\DesktopAgent`、`\HeyAgent\WindowsMCP`（登录时启动，退出了 1 分钟后重启） |

## 接口

所有请求都要 `Authorization: Bearer <密钥>`：HTTP 不对返回 401；WebSocket 先接受再用关闭码 4401 关掉。坐标一律是**主屏的物理像素**（进程按显示器 DPI 感知）。

| 接口 | 说明 |
|---|---|
| `GET /health` | `{ ok: true, version, screen: { width, height } }` |
| `GET /screenshot?maxWidth=1280&quality=70` | `image/jpeg`（`maxWidth=0` 不缩）；响应头 `X-Screen-Width` / `X-Screen-Height`；锁屏、UAC 安全桌面时 503 |
| `WS /view` | 先发 `{t:"meta",width,height,canControl:true}`，之后是二进制 JPEG 帧（有人看才截屏，最多 5 帧 / 秒，画面没变不发，最宽 1280，质量 60）；鼠标位置变了发 `{t:"cursor",x,y,kind:"move"}`（每秒查 10 次），任何鼠标键按下发 `kind:"press"`；分辨率变了重发 meta。收的消息见 `packages/shared/src/desktop.ts` 的 `desktopViewerClientMessageSchema`，不认识的丢掉 |
| `POST /type` | 请求体 JSON `{ "text": "…" }`（1～10000 个 UTF-16 码元），在当前焦点处打字（焦点由调用方先点好），返回 `{ ok: true, chars }`；请求体不对 400。给 agent 打中文用（Windows-MCP 0.8.8 的 `Type` 打不出中文）。短的一行逐字 unicode，多行或长的走剪贴板 + Ctrl+V，贴完把原来剪贴板里的文字还原；发完、粘贴落地后才返回 |
| `POST /files?name=<文件名>` | 请求体是文件内容（≤ 200 MB），存到 `C:\HeyAgent\files\<日期>\<文件名>`（重名加「 (1)」这样的序号），返回 `{ path, size }` |
| `GET /files?path=<绝对路径>` | 取文件（≤ 200 MB），只允许用户目录（`%USERPROFILE%`）和 `C:\HeyAgent\files` 下面的；响应头 `X-File-Name` 是按 UTF-8 百分号编码的文件名（同 `encodeURIComponent`，要 `decodeURIComponent`） |

输入的换算：

- 鼠标 → `SendInput`（绝对坐标）；滚轮的 `deltaY` 每 100 像素算一格（120），不足一格的攒着和下一次一起发；
- 按键 → 按 DOM `code`（没有就 `keyCode`）换成虚拟键码，`keyDown` / `rawKeyDown` 按下、`keyUp` 抬起、`char` 忽略；连接断开时把还按着的键和鼠标键都抬起来。
  例外：能打出字的键（`keyDown` 带 `text`、没按 Ctrl / Alt / Win，回车和空格除外）按文字发，不按虚拟键码发——人已经在控制台那边用自己的输入法打好了字，按虚拟键码发的话，虚拟机里的中文输入法会再组一次字（打 abc 出来候选框）；
- 文字 → 短的一行（输入法组好的字，≤ 64 个 UTF-16 码元）按码元逐个 `KEYEVENTF_UNICODE`（中文直接上屏，不经输入法）；有换行或更长的（粘贴的大段文字）放进剪贴板再按 Ctrl+V（剪贴板里会留着这段文字）。
  原因（实测，Win11 记事本 + 微软拼音）：unicode 字要经过输入法框架，程序大约 100 字 / 秒才处理完，而且和回车键不走一条路，多行文字逐个发会串行、乱序；换行按 unicode 发又只变成空格。
  同样的原因，unicode 字发出去以后，紧跟着的按键、鼠标键会等一小会儿（每个字 12 毫秒，最多 2 秒），免得「打完字马上回车」时回车跑到字前面；
- 组合键（`combo`）→ `win`、`alt+tab`、`alt+f4`、`win+d`、`win+r` 对应的按键序列。

## 开发

只用 Windows-MCP 已经带进来的包（starlette、uvicorn、websockets、pillow）和标准库（ctypes），不加新依赖。
版本锁在 `pyproject.toml`（照验证用虚拟机里 `pip install windows-mcp==0.8.8` 装出来的版本）。

和 Windows 无关的逻辑（键码换算、消息校验、输入换算、路径白名单、文件名去重、画面变化检测、推送中心）放在单独的模块里，开发机（Linux，Python 3.10 以上）就能测：

```bash
cd apps/desktop-agent
python3 -m unittest
```

`win32.py`（ctypes 调 user32）、`app.py`（starlette）、`__main__.py` 只能在 Windows 上跑，在验证用的虚拟机上实测。

`launch.py` 是给 Windows-MCP 用的启动器：把 pythonw 的 stdout / stderr 接到日志文件，从密钥文件读密钥补上 `--auth-key`（密钥不出现在计划任务和进程命令行里），再在同一个进程里跑 `windows_mcp`。
