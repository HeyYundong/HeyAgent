// 引擎的进程级配置：主密钥、模型工厂、文件目录、时间参数。
// engine/api.ts 的函数签名只有 (db, input)（和包 P2 约好的），所以这些依赖放在进程级，worker、API、测试各自设置。
import { resolve } from "node:path"

import type { LanguageModel } from "ai"

import { env, repoRoot } from "../env.js"
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
}

const num = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
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
