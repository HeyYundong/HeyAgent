// 引擎的进程级配置：主密钥、模型工厂、文件目录、时间参数。
// engine/api.ts 的函数签名只有 (db, input)（和包 P2 约好的），所以这些依赖放在进程级，worker、API、测试各自设置。
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type { LanguageModel } from "ai"

import { env, repoRoot } from "../env.js"
import type { EmbedInput } from "../gallery/embed.js"
import { loadKeyring, type Keyring } from "../lib/crypto.js"

export interface ModelFactoryInput {
  /** 任务里的模型 id，例如 openrouter/anthropic/claude-sonnet-5.5 */
  modelId: string
}

export interface EngineRuntime {
  keyring?: Keyring
  /** 测试用：直接给出模型（假模型）。不设就按 model_providers 配置走 OpenRouter */
  modelFactory?: (
    input: ModelFactoryInput
  ) => LanguageModel | Promise<LanguageModel>
  /** 测试用：图库的 embedding 直接给出向量（1024 维）。不设就调默认 embedding 模型 */
  embedFactory?: (input: { modelId: string; inputs: EmbedInput[] }) => number[][] | Promise<number[][]>
  /** 文件存放目录 */
  filesDir: string
  /** 模型或网络出错时重试几次、第一次等多久（毫秒，之后翻倍） */
  modelRetries: number
  modelRetryBaseMs: number
  /** 单个 pg-boss 任务最多跑多久，超过就排一个新的 session.run 自己退出 */
  maxRunMs: number
  /** HTTP 工具的超时和返回大小上限 */
  httpTimeoutMs: number
  httpMaxBytes: number
  /** 给模型的工具输出最多多少字符，超出部分存成文件 */
  toolOutputMaxChars: number
  /** 上传文件大小上限 */
  uploadMaxBytes: number
  /** 运行代码的沙箱（docs/dev/session-space.md 第 4、5 节） */
  sandbox: SandboxConfig
}

export interface SandboxConfig {
  /** 每个 session 一个目录（workspace/、home/ 等），在 worker 本地，不在文件卷 */
  dir: string
  /** 沙箱的根文件系统（worker 镜像构建时装好的 Debian + Python + Node），只读挂成 / */
  rootfs: string
  /** 默认超时（秒）；agent 最多能给 600 */
  defaultTimeoutSec: number
  /** Python、bash 的内存上限（ulimit -v）；Node 的堆用 --max-old-space-size 限，虚拟内存放到 nodeVirtualBytes */
  memoryBytes: number
  nodeVirtualBytes: number
  /** ulimit -u（按 uid 计数，和 worker、Chrome 共用，只用来防 fork 炸弹） */
  maxProcesses: number
  /** 沙箱里 /tmp（tmpfs）的大小 */
  tmpBytes: number
  /** 一次写回空间：最多几个文件、单个多大、合计多大 */
  syncMaxFiles: number
  syncMaxFileBytes: number
  syncMaxTotalBytes: number
  /** 一个 session 空间的总量（这次运行自己的文件） */
  spaceMaxBytes: number
  /** stdout / stderr 各最多在内存里留多少字节（超出的不进全文） */
  outputCaptureBytes: number
  /** 给模型看的 stdout / stderr 各留末尾多少字 */
  outputTailChars: number
  /** 出网代理允许的目标端口（空 = 不限） */
  proxyPorts: number[]
}

const num = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const MB = 1024 * 1024

const ports = (name: string, fallback: number[]) => {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === "") return fallback
  if (raw === "*") return []
  return raw
    .split(/[\s,]+/)
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536)
}

export const runtime: EngineRuntime = {
  filesDir: resolve(repoRoot, process.env.HEYAGENT_FILES_DIR ?? ".dev/files"),
  modelRetries: 3,
  modelRetryBaseMs: num("HEYAGENT_MODEL_RETRY_BASE_MS", 2000),
  maxRunMs: num("HEYAGENT_MAX_RUN_MINUTES", 30) * 60_000,
  httpTimeoutMs: 30_000,
  httpMaxBytes: 2 * 1024 * 1024,
  toolOutputMaxChars: 8000,
  uploadMaxBytes: num("HEYAGENT_UPLOAD_MAX_MB", 20) * 1024 * 1024,
  sandbox: {
    dir: resolve(process.env.HEYAGENT_SANDBOX_DIR ?? join(tmpdir(), "heyagent-sandbox")),
    rootfs: process.env.HEYAGENT_SANDBOX_ROOTFS ?? "/opt/sandbox-root",
    defaultTimeoutSec: num("HEYAGENT_SANDBOX_TIMEOUT_SECONDS", 60),
    memoryBytes: num("HEYAGENT_SANDBOX_MEMORY_MB", 1024) * MB,
    nodeVirtualBytes: num("HEYAGENT_SANDBOX_NODE_VIRTUAL_MB", 4096) * MB,
    maxProcesses: num("HEYAGENT_SANDBOX_MAX_PROCESSES", 1024),
    tmpBytes: num("HEYAGENT_SANDBOX_TMP_MB", 512) * MB,
    syncMaxFiles: num("HEYAGENT_SANDBOX_SYNC_MAX_FILES", 200),
    syncMaxFileBytes: num("HEYAGENT_SANDBOX_SYNC_MAX_FILE_MB", 50) * MB,
    syncMaxTotalBytes: num("HEYAGENT_SANDBOX_SYNC_MAX_TOTAL_MB", 200) * MB,
    spaceMaxBytes: num("HEYAGENT_SPACE_MAX_MB", 1024) * MB,
    outputCaptureBytes: num("HEYAGENT_SANDBOX_OUTPUT_CAPTURE_MB", 8) * MB,
    outputTailChars: 10_000,
    proxyPorts: ports("HEYAGENT_SANDBOX_PROXY_PORTS", [80, 443, 8080, 8443]),
  },
}

/** 改进程级配置（测试、worker 启动时用） */
export function configureEngine(patch: Partial<EngineRuntime>) {
  Object.assign(runtime, patch)
}

/** 主密钥：没设置过就从 HEYAGENT_KEK_FILE 读 */
export function getKeyring(): Keyring {
  if (!runtime.keyring) runtime.keyring = loadKeyring(env.kekFile)
  return runtime.keyring
}
