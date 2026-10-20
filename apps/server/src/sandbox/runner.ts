// 沙箱执行（docs/dev/session-space.md 第 5 节，做法照 spikes/sandbox/2026-10-20 实测过的）：
// setpriv 先清掉 worker 为 Chrome 留的 SYS_CHROOT（bwrap 不能在带权限的进程里跑），再用 bubblewrap 起一个新的命名空间沙箱：
// 独立的用户、PID、网络、IPC、UTS 命名空间，环境变量全清，根目录是只读的独立 Debian（/opt/sandbox-root），
// /workspace 可写（空间文件的镜像），附件这类只读来源只读挂在 /workspace/<目录>，HOME 是这个 session 自己的目录。
// 没有 /proc（Podman 给容器的 /proc 加了遮罩，沙箱里挂不了新的）。
// 限制：Python、bash 用 ulimit -v 限内存；Node 的 V8 一启动就要很大的虚拟地址，虚拟内存放宽到 4 GB、堆用 --max-old-space-size 限；
// ulimit -t 限 CPU 时间、-u 防 fork 炸弹、-f 限单个文件；墙钟超时杀掉整个进程组（bwrap 带 --die-with-parent，沙箱跟着没）。
import { spawn } from "node:child_process"
import { accessSync, constants, existsSync } from "node:fs"
import { delimiter, join } from "node:path"

import type { SandboxConfig } from "../engine/runtime.js"

export type CodeLanguage = "python" | "node" | "bash"

/** 沙箱里的固定位置 */
export const SANDBOX_WORKSPACE = "/workspace"
export const SANDBOX_HOME = "/home/sandbox"
export const SANDBOX_CODE_DIR = "/tmp/.code"
export const SANDBOX_PROXY_DIR = "/tmp/.proxy"
export const PROXY_SOCKET_NAME = "proxy.sock"
const PROXY_PORT = 3128

export interface SandboxRunSpec {
  language: CodeLanguage
  /** 沙箱里要跑的脚本（绝对路径） */
  script: string
  args: string[]
  stdin?: string
  timeoutSec: number
  /** 宿主上的目录 */
  workspaceDir: string
  homeDir: string
  /** 直接给的代码放在这里（只读挂到 /tmp/.code） */
  codeDir?: string
  /** 出网代理的 socket 所在目录（只读挂到 /tmp/.proxy）；不给 = 不能联网 */
  proxyDir?: string
  /** 只读挂到 /workspace 下的目录：{ host, name }，name 例如 attachments */
  readonlyDirs: { host: string; name: string }[]
  config: SandboxConfig
}

export interface CapturedOutput {
  /** 留下来的文字（超过上限时是开头 + 结尾，中间写省略了多少） */
  text: string
  totalBytes: number
  /** 没留下来的字节数（0 = 全文都在） */
  droppedBytes: number
}

export interface SandboxRunResult {
  exitCode: number
  timedOut: boolean
  ms: number
  stdout: CapturedOutput
  stderr: CapturedOutput
}

export type SandboxRunner = (spec: SandboxRunSpec) => Promise<SandboxRunResult>

/** 沙箱里的启动脚本：先起 socat 把代理的 unix socket 转成 127.0.0.1:3128，再设限制、换成用户的程序 */
const WRAPPER = [
  `if [ -S ${SANDBOX_PROXY_DIR}/${PROXY_SOCKET_NAME} ]; then`,
  `  socat TCP-LISTEN:${PROXY_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${SANDBOX_PROXY_DIR}/${PROXY_SOCKET_NAME} 2>/dev/null &`,
  `  i=0; while [ $i -lt 100 ] && ! (exec 3<>/dev/tcp/127.0.0.1/${PROXY_PORT}) 2>/dev/null; do sleep 0.02; i=$((i+1)); done`,
  "fi",
  'ulimit -v "$1" && ulimit -t "$2" && ulimit -u "$3" && ulimit -f "$4" || exit 126',
  "shift 4",
  'exec "$@"',
].join("\n")

const KB = 1024

/** bwrap 的参数（不含 setpriv），测试用来检查挂载和环境变量 */
export function buildSandboxArgs(spec: SandboxRunSpec): string[] {
  const { config } = spec
  const proxy = `http://127.0.0.1:${PROXY_PORT}`
  const env: Record<string, string> = {
    PATH: `${SANDBOX_HOME}/.local/bin:${SANDBOX_HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: SANDBOX_HOME,
    USER: "sandbox",
    LOGNAME: "sandbox",
    LANG: "C.UTF-8",
    TMPDIR: "/tmp",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    // 数值库只开一个线程：CPU 按一个核算（ulimit -t），线程也算进 ulimit -u（OpenBLAS 默认按核数开几十个）
    OPENBLAS_NUM_THREADS: "1",
    OMP_NUM_THREADS: "1",
    MKL_NUM_THREADS: "1",
    NUMEXPR_NUM_THREADS: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    // npm install -g 装进 home（根目录只读）；require 能找到
    NPM_CONFIG_PREFIX: `${SANDBOX_HOME}/.npm-global`,
    NODE_PATH: `${SANDBOX_HOME}/.npm-global/lib/node_modules`,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_AUDIT: "false",
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1",
  }
  if (spec.language === "node")
    env.NODE_OPTIONS = `--max-old-space-size=${Math.max(64, Math.floor(config.memoryBytes / 1024 / 1024))}`
  // 不加 --disable-userns（要写 /proc/sys/user/max_user_namespaces，Podman 里 /proc/sys 只读）和 --hostname（Podman 里设不了）：实测都起不来
  const args = ["--unshare-all", "--unshare-user", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"]
  for (const [key, value] of Object.entries(env)) args.push("--setenv", key, value)
  args.push(
    "--ro-bind", config.rootfs, "/",
    "--dev", "/dev",
    "--size", String(config.tmpBytes), "--tmpfs", "/tmp",
    "--bind", spec.workspaceDir, SANDBOX_WORKSPACE
  )
  for (const dir of spec.readonlyDirs) args.push("--ro-bind", dir.host, `${SANDBOX_WORKSPACE}/${dir.name}`)
  args.push("--bind", spec.homeDir, SANDBOX_HOME)
  if (spec.codeDir) args.push("--ro-bind", spec.codeDir, SANDBOX_CODE_DIR)
  if (spec.proxyDir) args.push("--ro-bind", spec.proxyDir, SANDBOX_PROXY_DIR)
  args.push("--chdir", SANDBOX_WORKSPACE)

  const virtual = spec.language === "node" ? config.nodeVirtualBytes : config.memoryBytes
  const program = { python: "python3", node: "node", bash: "bash" }[spec.language]
  args.push(
    "--",
    "/bin/bash",
    "-c",
    WRAPPER,
    "heyagent-sandbox",
    String(Math.floor(virtual / KB)),
    // CPU 时间：平均一个核跑满整个超时，多给一点余量（墙钟超时兜底）
    String(spec.timeoutSec + 2),
    String(config.maxProcesses),
    String(Math.floor(config.spaceMaxBytes / KB)),
    program,
    spec.script,
    ...spec.args
  )
  return args
}

/** 收集一路输出：开头留到上限，超出后只留最后一段 */
class OutputCollector {
  private head: Buffer[] = []
  private headBytes = 0
  private tail: Buffer[] = []
  private tailBytes = 0
  total = 0
  private readonly cap: number
  private readonly tailCap: number

  constructor(cap: number) {
    this.cap = cap
    this.tailCap = Math.min(256 * KB, Math.floor(cap / 4))
  }

  push(chunk: Buffer) {
    this.total += chunk.length
    if (this.headBytes < this.cap) {
      const room = this.cap - this.headBytes
      const part = chunk.length <= room ? chunk : chunk.subarray(0, room)
      this.head.push(part)
      this.headBytes += part.length
      if (part.length === chunk.length) return
      chunk = chunk.subarray(room)
    }
    this.tail.push(chunk)
    this.tailBytes += chunk.length
    while (this.tailBytes - (this.tail[0]?.length ?? 0) >= this.tailCap) this.tailBytes -= this.tail.shift()!.length
  }

  result(): CapturedOutput {
    const head = Buffer.concat(this.head).toString("utf8")
    if (this.total <= this.headBytes) return { text: head, totalBytes: this.total, droppedBytes: 0 }
    let tail = Buffer.concat(this.tail)
    if (tail.length > this.tailCap) tail = tail.subarray(tail.length - this.tailCap)
    const dropped = this.total - this.headBytes - tail.length
    return {
      text: `${head}\n…（输出太多，中间省略了 ${dropped} 字节）…\n${tail.toString("utf8")}`,
      totalBytes: this.total,
      droppedBytes: dropped,
    }
  }
}

function findOnPath(command: string) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    const full = join(dir, command)
    try {
      accessSync(full, constants.X_OK)
      return full
    } catch {
      // 下一个
    }
  }
  return undefined
}

function spawnSandbox(spec: SandboxRunSpec): Promise<SandboxRunResult> {
  const setpriv = findOnPath("setpriv")!
  const bwrap = findOnPath("bwrap")!
  const started = Date.now()
  return new Promise((resolve, reject) => {
    // detached：自己一个进程组，超时时整组杀掉
    const child = spawn(setpriv, ["--inh-caps=-all", "--ambient-caps=-all", bwrap, ...buildSandboxArgs(spec)], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    })
    const stdout = new OutputCollector(spec.config.outputCaptureBytes)
    const stderr = new OutputCollector(spec.config.outputCaptureBytes)
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    let timedOut = false
    let settled = false
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
      } catch {
        // 已经没了
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
      // 万一 close 一直不来（管道被沙箱里的孙进程拿着），5 秒后照样收尾
      setTimeout(() => finish(137), 5000).unref()
    }, spec.timeoutSec * 1000)
    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode: timedOut ? 137 : exitCode,
        timedOut,
        ms: Date.now() - started,
        stdout: stdout.result(),
        stderr: stderr.result(),
      })
    }
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code, signal) => {
      killGroup()
      finish(code ?? (signal ? 128 + (signalNumber[signal] ?? 1) : 1))
    })
    child.stdin.on("error", () => {
      // 程序没读完 stdin 就退出了：不算错
    })
    child.stdin.end(spec.stdin ?? "")
  })
}

const signalNumber: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGTERM: 15, SIGXCPU: 24, SIGXFSZ: 25 }

export const bwrapRunner: SandboxRunner = spawnSandbox

let availability: { at: number; reason?: string } | undefined

/**
 * 沙箱能不能用：setpriv、bwrap、根文件系统都在，而且真能起一个空沙箱（用户命名空间可能被禁）。
 * 返回不能用的原因；能用返回 undefined。能用的结果一直缓存，不能用的 1 分钟后再查
 */
export async function sandboxUnavailable(config: SandboxConfig): Promise<string | undefined> {
  if (availability && (!availability.reason || Date.now() - availability.at < 60_000)) return availability.reason
  const reason = await probe(config)
  availability = { at: Date.now(), reason }
  return reason
}

/** 测试用：清掉缓存 */
export function resetSandboxAvailability() {
  availability = undefined
}

async function probe(config: SandboxConfig): Promise<string | undefined> {
  if (!findOnPath("setpriv")) return "worker 里没有 setpriv（util-linux）"
  if (!findOnPath("bwrap")) return "worker 里没有装 bubblewrap（bwrap）。沙箱要在 worker 镜像里跑（deploy/worker.Containerfile）"
  for (const file of ["bin/bash", "usr/local/bin/python3", "usr/local/bin/node", "usr/bin/socat"])
    if (!existsSync(join(config.rootfs, file)))
      return `沙箱的根文件系统 ${config.rootfs} 不完整（缺 /${file}），要用 worker 镜像构建时装好的那份`
  if (!existsSync(join(config.rootfs, "workspace")) || !existsSync(join(config.rootfs, SANDBOX_HOME.slice(1))))
    return `沙箱的根文件系统 ${config.rootfs} 里没有 /workspace 或 ${SANDBOX_HOME}`
  const setpriv = findOnPath("setpriv")!
  const bwrap = findOnPath("bwrap")!
  return new Promise((resolve) => {
    const child = spawn(
      setpriv,
      ["--inh-caps=-all", "--ambient-caps=-all", bwrap, "--unshare-all", "--unshare-user", "--die-with-parent", "--clearenv", "--ro-bind", config.rootfs, "/", "--", "/bin/true"],
      { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }
    )
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve(`起不了 bwrap：${error.message}`)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? undefined : `bwrap 起不来（退出码 ${code}）：${stderr.trim().slice(0, 300) || "没有输出"}`)
    })
  })
}
