// 派活的对外 HTTP 接口（派活第三期，docs/dev/dispatch-p3.md 第 2 节；接口说明写进 docs/dev/api.md 第 16.9 节）。
// 鉴权同图库、比物（lib/api-auth.ts）：Authorization: Bearer <API 密钥> 优先，没带看 cookie。
// 密钥调用 via = api（要被派任务开着「外部系统能派活」，权限按密钥创建人现在的角色算）；cookie 调用和控制台「派一张」一样（via = human）。
//   POST /api/work-items              派一张：WorkApiCreateInput；新建 201，同一件事已经有单 200（existing = true，不重开）
//   GET  /api/work-items?task=&key=&status=&limit=&cursor=   查单：新派的在前，不限天数
//   GET  /api/work-items/:id          一张单（WorkItem：状态、结果、没办成的原因）
//   POST /api/work-items/:id/cancel   不办了（{ reason? }）
// 错误一律 { error: "给人看的中文" }：400 输入不对、401 密钥不对、403 任务没开「外部系统能派活」或没权限、404 没有任务 / 单、
// 409 任务没开「可以被派活」/ 单的状态不对、413 太大、429 撞了上限（每天最多被派、最多排队）。
// 现在是空壳：认人、解析输入以后回 501「还没做好」。包 A 实现（engine/dispatch/manage.ts 加 dispatchByApi 等）。
import { workApiCancelInputSchema, workApiCreateInputSchema, workApiListQuerySchema } from "@heyagent/shared"
import type { Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { z } from "zod"

import type { Auth } from "../auth.js"
import type { Db } from "../db/client.js"
import { authenticateRequest, zodMessage, type ApiCaller } from "../lib/api-auth.js"
import { WorkError } from "./service.js"

interface Deps {
  db: Db
  auth: Auth
}

/** 接口自己的错误：带 HTTP 状态 */
class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 501
  constructor(status: HttpError["status"], message: string) {
    super(message)
    this.status = status
  }
}

const WORK_ERROR_STATUS: Record<WorkError["code"], 400 | 403 | 404 | 409> = { BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409 }

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpError(400, zodMessage(result.error))
  return result.data
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new HttpError(400, "内容要是 JSON（Content-Type: application/json）")
  }
}

const notYet = () => new HttpError(501, "派活的对外接口还没做好")

export function registerWorkRoutes(app: Hono, deps: Deps) {
  /** 包一层：认人 → 执行 → 统一处理错误 */
  const handle = (action: (c: Context, caller: ApiCaller) => Promise<Response>) => async (c: Context) => {
    try {
      const caller = await authenticateRequest(deps, c.req.raw)
      if ("reason" in caller) return c.json({ error: caller.reason }, 401)
      return await action(c, caller)
    } catch (error) {
      if (error instanceof HttpError) return c.json({ error: error.message }, error.status)
      if (error instanceof WorkError) return c.json({ error: error.message }, WORK_ERROR_STATUS[error.code])
      console.error("[work-api]", error)
      return c.json({ error: "服务器出错了，请稍后再试" }, 500)
    }
  }

  app.post(
    "/api/work-items",
    bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "内容太大（最多 256 KB）" }, 413) }),
    handle(async (c) => {
      const input = parse(workApiCreateInputSchema, await readJson(c))
      // 没有去重参数时，去重键也可以放在请求头 Idempotency-Key 里（内容里的 key 优先）
      void { ...input, key: input.key ?? c.req.header("idempotency-key")?.trim() }
      throw notYet()
    })
  )

  app.get(
    "/api/work-items",
    handle(async (c) => {
      void parse(workApiListQuerySchema, c.req.query())
      throw notYet()
    })
  )

  app.get(
    "/api/work-items/:id",
    handle(async () => {
      throw notYet()
    })
  )

  app.post(
    "/api/work-items/:id/cancel",
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "内容太大" }, 413) }),
    handle(async (c) => {
      // 没有内容也行（不写原因）
      const body = (await c.req.text()).trim() ? await readJson(c) : {}
      void parse(workApiCancelInputSchema, body)
      throw notYet()
    })
  )
}
