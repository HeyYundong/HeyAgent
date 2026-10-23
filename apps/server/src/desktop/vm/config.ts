// 系统开的桌面的部署配置（docs/dev/desktop-vm.md 第 1～3 节）：全部从环境变量读，每次用到时重新读（测试里改环境变量就生效）。
import { join } from "node:path"

import { DESKTOP_MIN_FREE_GB } from "@heyagent/shared"

import { repoRoot } from "../../env.js"

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

const positive = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** dockurr/windows 6.06（2026-10-05），用摘要锁死：标签可能被重新指向 */
export const DOCKUR_IMAGE = "docker.io/dockurr/windows@sha256:16fd7c39a3e48bb946d29c59dc6015942e5b900a1fa5d7e5552053bfc48ee2ea"
/** 模板里装的 Python，worker 下载后按 sha256 校验 */
export const PYTHON_VERSION = "3.14.8"
const PYTHON_SHA256 = "759be887b96e736a3ca886daf8d575f18fcae1a09efab6902f42d59e8999f8ef"
/** Windows 里的登录用户（自动登录，平时用不到） */
export const VM_USER = "heyagent"
/** 每个存放位置下面放虚拟机的目录名 */
export const VM_DIR_NAME = "heyagent-desktops"
/** 容器里两个服务的端口（install.ps1 的默认值，dockur 的 USER_PORTS 转进 Windows） */
export const GUEST_MCP_PORT = 8000
export const GUEST_AGENT_PORT = 8001

export const vmConfig = {
  /** Podman REST API 的 unix socket（libpod）；没配 = 本机不能开虚拟机 */
  get podmanSocket() {
    return process.env.HEYAGENT_PODMAN_SOCKET?.trim() || ""
  },
  /** 可选的存放位置（绝对路径，部署时配置；worker / api 容器里同路径挂进去） */
  get storageRoots() {
    return list(process.env.HEYAGENT_DESKTOP_STORAGE_ROOTS).map((path) => path.replace(/\/+$/, "") || "/")
  },
  /** 两个服务的端口映射到本机哪个地址 */
  get bind() {
    return process.env.HEYAGENT_DESKTOP_BIND?.trim() || "127.0.0.1"
  },
  /** 服务器连虚拟机用的地址（pod 里跑时是宿主机在 slirp4netns 里的地址） */
  get vmHost() {
    return process.env.HEYAGENT_DESKTOP_VM_HOST?.trim() || "127.0.0.1"
  },
  /** 给虚拟机分端口的范围（含两端） */
  get portRange(): [number, number] {
    const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(process.env.HEYAGENT_DESKTOP_PORT_RANGE ?? "")
    const low = match ? Number(match[1]) : 42000
    const high = match ? Number(match[2]) : 42999
    return low > 0 && high <= 65535 && low < high ? [low, high] : [42000, 42999]
  },
  /** 留给系统和别的服务的内存（GB） */
  get reservedGb() {
    const value = Number(process.env.HEYAGENT_DESKTOP_RESERVED_GB)
    return Number.isFinite(value) && value >= 0 && process.env.HEYAGENT_DESKTOP_RESERVED_GB?.trim() ? value : 24
  },
  /** 新建时至少要剩多少空间（GB） */
  get minFreeGb() {
    return positive("HEYAGENT_DESKTOP_MIN_FREE_GB", DESKTOP_MIN_FREE_GB)
  },
  /** worker 对账间隔 */
  get sweepMs() {
    return positive("HEYAGENT_DESKTOP_VM_SWEEP_MS", 30_000)
  },
  /** 开机中、装 Windows 中多久查一次桌面服务的 /health */
  get healthMs() {
    return positive("HEYAGENT_DESKTOP_VM_HEALTH_MS", 5_000)
  },
  /** 开机后多久还连不上算出错：20 分钟（开发机机械盘上实测开机到 Windows-MCP 起来要 7～12 分钟） */
  get startTimeoutMs() {
    return positive("HEYAGENT_DESKTOP_VM_START_TIMEOUT_MS", 20 * 60_000)
  },
  /** 模板装 Windows 多久还没装好算出错（4 小时） */
  get installTimeoutMs() {
    return positive("HEYAGENT_DESKTOP_VM_INSTALL_TIMEOUT_MS", 8 * 60 * 60_000)
  },
  /** 关机时给 Windows 多少秒正常关机（之后强制关） */
  get stopTimeoutSeconds() {
    return positive("HEYAGENT_DESKTOP_VM_STOP_SECONDS", 120)
  },
  /** 判断本机有没有 KVM 的设备文件；设成空串 = 不检查（API 在 pod 里看不到宿主机的 /dev 时） */
  get kvmDevice() {
    return process.env.HEYAGENT_DESKTOP_KVM_DEVICE ?? "/dev/kvm"
  },
  /** /sys、/proc 的位置（测试里换成假的目录） */
  get sysRoot() {
    return process.env.HEYAGENT_DESKTOP_SYS_ROOT || "/sys"
  },
  get procRoot() {
    return process.env.HEYAGENT_DESKTOP_PROC_ROOT || "/proc"
  },
  /** 本仓库的 apps/desktop-agent（做模板时放进 OEM 目录） */
  get agentDir() {
    return process.env.HEYAGENT_DESKTOP_AGENT_DIR || join(repoRoot, "apps", "desktop-agent")
  },
  /** Python 安装包的下载地址和 sha256（换成内网镜像时两个一起改） */
  get pythonUrl() {
    return process.env.HEYAGENT_DESKTOP_PYTHON_URL || `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-amd64.exe`
  },
  get pythonSha256() {
    return (process.env.HEYAGENT_DESKTOP_PYTHON_SHA256 || PYTHON_SHA256).toLowerCase()
  },
  get image() {
    return process.env.HEYAGENT_DESKTOP_IMAGE || DOCKUR_IMAGE
  },
}

export const vmUrls = (mcpPort: number, agentPort: number) => {
  const host = vmConfig.vmHost.includes(":") ? `[${vmConfig.vmHost}]` : vmConfig.vmHost
  return { mcpUrl: `http://${host}:${mcpPort}/mcp`, agentUrl: `http://${host}:${agentPort}` }
}

/** 虚拟机的目录：<存放位置>/heyagent-desktops/<desktopId> */
export const vmDirOf = (storagePath: string, desktopId: string) => join(storagePath, VM_DIR_NAME, desktopId)
/** 下载的安装包缓存：<存放位置>/heyagent-desktops/cache */
export const cacheDirOf = (storagePath: string) => join(storagePath, VM_DIR_NAME, "cache")
export const containerNameOf = (desktopId: string) => `heyagent-${desktopId}`
/** 虚拟机的系统盘（dockur 的 DISK_FMT=qcow2 时叫 data.qcow2） */
export const diskOf = (dir: string) => join(dir, "data.qcow2")
export const oemDirOf = (dir: string) => join(dir, "oem")
