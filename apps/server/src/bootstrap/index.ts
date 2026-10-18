// 空白正式环境的初始化：API 启动时执行，可以重复执行（已经有的不动）。
// 1. 不建任何账号：一个用户都没有时，控制台显示「设置管理员」页，由第一个打开的人自己定账号和密码（见 setup.ts）；
// 2. 写入全局设置的默认值；
// 3. 环境变量里有 OpenRouter 的 key（OPENROUTER_API_KEY_FILE 指向的文件，或 OPENROUTER_API_KEY）、还没配过 OpenRouter 时：建 OpenRouter 服务（key 加密存）、刷新模型列表、设好三个默认模型。
// 4. 把内置工具同步进 tools 表（worker 启动时也会同步一次）：worker 还没起时，空白环境的工具页也能看到它们。
// 5. 比物：一个比对标准都没有时建初始的「同款判断」（模型 = 最便宜的视觉模型；还没有视觉模型就等接好模型服务以后再建）。
// 6. 图库的 embedding 模型还没设过、库里也还没有 embedding 模型（升级前建的环境）：刷新一次 OpenRouter 的模型列表（公开接口，不花钱），设成 BOOTSTRAP_EMBED_MODEL。
// 不灌任何演示数据（任务、记忆、技能、规则、平台都由用户自己加）。
import { and, count, eq } from "drizzle-orm"
import { OPENROUTER_DEFAULT_URL, sameFamily } from "@heyagent/shared"

import { ensureDefaultStandard } from "../compare/service.js"
import { addProvider, refreshProvider, writeDefaults } from "../data/config/models.js"
import { ensureDefaultSettings } from "../data/config/settings.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { syncBuiltinTools } from "../engine/tools/builtin-defs.js"
import type { Keyring } from "../lib/crypto.js"
import { setupNeeded } from "./setup.js"

/** 初始化时选的默认模型（OpenRouter 上的名字）：执行、规划、验收（验收和执行不同家） */
export const BOOTSTRAP_MODELS = { run: "anthropic/claude-sonnet-5.5", plan: "anthropic/claude-opus-5.5", verify: "google/gemini-3.8-flash" } as const

/**
 * 图库默认的 embedding 模型（用户 2026-10-17 同意用推荐的，以后在模型页能换）：图文同一个向量空间（能用一句描述找图），中文好；
 * 一张图约 $0.00013（258 token，2026-10-17 实测）
 */
export const BOOTSTRAP_EMBED_MODEL = "google/gemini-embedding-2"

export interface BootstrapOptions {
  keyring: Keyring
  /** .env 里的 OpenRouter key（可以没有） */
  openrouterApiKey?: string
  log?: (message: string) => void
}

export interface BootstrapResult {
  /** 还没有任何账号：等人打开控制台设置管理员 */
  setupNeeded: boolean
  openrouter: "created" | "exists" | "skipped" | "failed"
}

async function setupOpenRouter(db: Db, options: BootstrapOptions): Promise<BootstrapResult["openrouter"]> {
  if (!options.openrouterApiKey) return "skipped"
  const [existing] = await db.select({ id: t.modelProviders.id }).from(t.modelProviders).where(eq(t.modelProviders.kind, "openrouter"))
  if (existing) return "exists"
  try {
    // 初始化只用公开的模型列表接口，不拿 key 去调任何接口
    const { id } = await addProvider(db, options.keyring, null, { kind: "openrouter", baseUrl: OPENROUTER_DEFAULT_URL, apiKey: options.openrouterApiKey }, { verifyKey: false })
    const [defaults] = await db.select({ n: count() }).from(t.modelDefaults)
    if ((defaults?.n ?? 0) === 0) {
      const ids = { run: `${id}/${BOOTSTRAP_MODELS.run}`, plan: `${id}/${BOOTSTRAP_MODELS.plan}`, verify: `${id}/${BOOTSTRAP_MODELS.verify}` }
      const found = (await db.select({ id: t.models.id }).from(t.models).where(eq(t.models.providerId, id))).map((row) => row.id)
      if ([ids.run, ids.plan, ids.verify].every((each) => found.includes(each)) && !sameFamily(ids.run, ids.verify)) {
        const embed = `${id}/${BOOTSTRAP_EMBED_MODEL}`
        await writeDefaults(db, null, { ...ids, ...(found.includes(embed) ? { embed } : {}) })
      } else {
        options.log?.("OpenRouter 的模型列表里找不到预设的默认模型，请到「模型」页手动设置默认模型")
      }
    }
    options.log?.(`已接入 OpenRouter（key 已加密保存），模型列表已刷新`)
    // 后台重试接上时，比物的默认标准也在这时建（启动时还没有视觉模型）
    await ensureDefaultStandard(db).catch(() => undefined)
    return "created"
  } catch (error) {
    // 连不上外网时不要挡住 API 启动：API 进程会在后台自动重试（retryOpenRouterInBackground），管理员也可以在「模型」页手动加
    options.log?.(`接入 OpenRouter 失败，稍后会自动重试：${error instanceof Error ? error.message : String(error)}`)
    return "failed"
  }
}

/** 后台重试的间隔：30 秒、1 分钟、2 分钟、5 分钟，之后每 10 分钟一次 */
export const OPENROUTER_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000]

/**
 * 启动时接入 OpenRouter 失败（例如服务器开机时网络还没好），就在后台按间隔重试，直到接上，或者管理员已经在「模型」页手动加好。
 * 不这样做的话，空白环境会一直没有模型，要等下次重启才再试。返回一个停止函数，关机时调用。
 */
export function retryOpenRouterInBackground(db: Db, options: BootstrapOptions, delaysMs: readonly number[] = OPENROUTER_RETRY_DELAYS_MS): () => void {
  let stopped = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (stopped) return
    const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 600_000
    attempt += 1
    timer = setTimeout(() => {
      void setupOpenRouter(db, options)
        .catch(() => "failed" as const)
        .then((result) => {
          if (result === "failed") schedule()
        })
    }, delay)
    // 不让这个定时器拖住进程退出
    timer.unref?.()
  }
  schedule()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

export async function bootstrap(db: Db, options: BootstrapOptions): Promise<BootstrapResult> {
  await ensureDefaultSettings(db)
  await syncBuiltinTools(db)
  const openrouter = await setupOpenRouter(db, options)
  if (await ensureDefaultStandard(db).catch(() => false)) options.log?.("建好了比物的默认标准「同款判断」（可以在比物页改）")
  await ensureEmbedDefault(db, options).catch((error) => options.log?.(`没设好图库的 embedding 模型：${error instanceof Error ? error.message : String(error)}`))
  const needed = await setupNeeded(db)
  if (needed) options.log?.("还没有任何账号：打开控制台，按提示设置管理员的邮箱和密码")
  return { setupNeeded: needed, openrouter }
}

/**
 * 升级前建的环境：模型列表里还没有 embedding 模型、也没设过图库的 embedding 模型时，刷新一次 OpenRouter 的列表再设上。
 * 只在「一个 embedding 模型都没有」时做：之后主管把它清空或换掉，重启也不会被改回来
 */
async function ensureEmbedDefault(db: Db, options: BootstrapOptions) {
  const [embed] = await db.select({ n: count() }).from(t.modelDefaults).where(eq(t.modelDefaults.role, "embed"))
  if ((embed?.n ?? 0) > 0) return
  const [embeddings] = await db.select({ n: count() }).from(t.models).where(eq(t.models.kind, "embedding"))
  if ((embeddings?.n ?? 0) > 0) return
  const [provider] = await db.select({ id: t.modelProviders.id }).from(t.modelProviders).where(and(eq(t.modelProviders.kind, "openrouter"), eq(t.modelProviders.status, "ok")))
  if (!provider) return
  const check = await refreshProvider(db, options.keyring, null, provider.id)
  if (!check.ok) return options.log?.(`刷新 OpenRouter 模型列表失败，图库的 embedding 模型请到「模型」页手动设：${check.message}`)
  const modelId = `${provider.id}/${BOOTSTRAP_EMBED_MODEL}`
  const [model] = await db.select({ vision: t.models.vision }).from(t.models).where(and(eq(t.models.id, modelId), eq(t.models.kind, "embedding")))
  if (!model?.vision) return options.log?.(`OpenRouter 上找不到 ${BOOTSTRAP_EMBED_MODEL}，图库的 embedding 模型请到「模型」页手动设`)
  await db.insert(t.modelDefaults).values({ role: "embed", modelId }).onConflictDoNothing()
  await db.insert(t.auditEvents).values({ actorId: null, action: "model_defaults.update", targetTable: "model_defaults", targetId: "defaults", detail: { embed: modelId, by: "bootstrap" } })
  options.log?.(`图库的 embedding 模型设成了 ${BOOTSTRAP_EMBED_MODEL}（可以在「模型」页换）`)
}
