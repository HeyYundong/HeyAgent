// 做模板时的 OEM 目录（docs/dev/desktop-vm.md 第 1 节）：
// dockur 装好 Windows 后第一次登录时，以管理员身份跑里面的 install.bat：装 Python 3.14 → 跑本仓库的 install.ps1（装 Windows-MCP 和桌面服务）。
// Python 安装包按固定版本 + sha256 下载，缓存在 <存放位置>/heyagent-desktops/cache/。
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { chmod, copyFile, cp, mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import { cacheDirOf, PYTHON_VERSION, vmConfig } from "./config.js"

const installerName = () => `python-${PYTHON_VERSION}-amd64.exe`

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256")
  await pipeline(createReadStream(file), hash)
  return hash.digest("hex")
}

/** 缓存里的 Python 安装包（没有或校验不过就重新下载），返回路径 */
export async function cachedPythonInstaller(storagePath: string): Promise<string> {
  const dir = cacheDirOf(storagePath)
  await mkdir(dir, { recursive: true })
  const file = join(dir, installerName())
  const expected = vmConfig.pythonSha256
  if ((await stat(file).catch(() => undefined))?.isFile() && (await sha256Of(file)) === expected) return file
  const part = `${file}.part`
  const res = await fetch(vmConfig.pythonUrl, { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) }).catch((error: unknown) => {
    throw new Error(`下载 Python 安装包失败（${vmConfig.pythonUrl}）：${(error as Error).message}`, { cause: error })
  })
  if (!res.ok || !res.body) throw new Error(`下载 Python 安装包失败（${vmConfig.pythonUrl}）：HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(part))
  const actual = await sha256Of(part)
  if (actual !== expected) {
    await rm(part, { force: true })
    throw new Error(`Python 安装包的 sha256 不对（${actual}），没有用它`)
  }
  await rename(part, file)
  return file
}

/** cmd 要 CRLF；只用 ASCII，免得代码页不对 */
export function installBat(): string {
  return [
    "@echo off",
    "rem HeyAgent desktop template: run once by dockur at the first logon (auto-logon user, elevated).",
    "set LOG=C:\\OEM\\heyagent-install.log",
    "echo [%date% %time%] install Python >> %LOG%",
    `start "" /wait C:\\OEM\\${installerName()} /quiet InstallAllUsers=1 PrependPath=1 Include_test=0 >> %LOG% 2>&1`,
    "echo [%date% %time%] run install.ps1 >> %LOG%",
    'powershell -NoProfile -ExecutionPolicy Bypass -File C:\\OEM\\desktop-agent\\install.ps1 -KeyFile C:\\OEM\\key -Python "C:\\Program Files\\Python314\\python.exe" >> %LOG% 2>&1',
    "echo [%date% %time%] install.ps1 exit %errorlevel% >> %LOG%",
    "del /f /q C:\\OEM\\key",
  ]
    .map((line) => `${line}\r\n`)
    .join("")
}

/** 不放进虚拟机的：缓存、测试、打包产物 */
const skipped = new Set(["__pycache__", "tests", ".gitignore", ".pytest_cache"])

/**
 * 准备 OEM 目录：Python 安装包、apps/desktop-agent、密钥文件、install.bat。重复调用会重新写一遍。
 * 密钥文件只给自己读；Windows 里 install.bat 跑完会删掉，做成模板时这个目录整个删掉
 */
export async function prepareOem(oemDir: string, storagePath: string, key: string): Promise<void> {
  const installer = await cachedPythonInstaller(storagePath)
  await rm(oemDir, { recursive: true, force: true })
  await mkdir(oemDir, { recursive: true, mode: 0o700 })
  await copyFile(installer, join(oemDir, basename(installer)))
  const agentDir = vmConfig.agentDir
  if (!(await stat(join(agentDir, "install.ps1")).catch(() => undefined))) throw new Error(`找不到桌面服务的安装文件（${agentDir}/install.ps1）`)
  await cp(agentDir, join(oemDir, "desktop-agent"), {
    recursive: true,
    filter: (source) => !skipped.has(basename(source)) && !source.endsWith(".egg-info"),
  })
  await writeFile(join(oemDir, "key"), key, { mode: 0o600 })
  await chmod(join(oemDir, "key"), 0o600)
  await writeFile(join(oemDir, "install.bat"), installBat())
}
