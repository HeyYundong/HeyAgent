// 场景 9：worker 进程中途被杀掉（kill -9），重启后继续同一个 session。
// 起真实的 worker 子进程（src/worker.ts）；模型走真实的 OpenRouter provider，地址指向本测试里的一个假 OpenAI 兼容服务，
// 所以不花钱，也顺带验证了「key 从 secrets 解密、花费按返回的 usage.cost 记账」这条真实路径。
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDb } from "../src/db/client.js"
import * as t from "../src/db/schema.js"
import { startSession } from "../src/engine/api.js"
import { stopSenderBoss } from "../src/engine/queue.js"
import { configureEngine } from "../src/engine/runtime.js"
import { loadKeyring, newKekLine } from "../src/lib/crypto.js"
import { seedDemo } from "../src/seed/seed.js"
import {
  createTask,
  dropBossSchema,
  eventsOf,
  messagesOf,
  saveSecret,
  waitFor,
  waitStatus,
} from "./engine-helpers.js"
import { PASSWORD, resetTestDatabase, testDatabaseUrl } from "./helpers.js"

const serverDir = fileURLToPath(new URL("..", import.meta.url))
// 本进程发出的 session.run 也用短心跳（worker 被杀后 10 秒左右就能被发现）
process.env.HEYAGENT_RUN_HEARTBEAT_SECONDS = "10"
const url = testDatabaseUrl()
const { db, pool } = createDb(url, 5)
const dir = mkdtempSync(join(tmpdir(), "heyagent-crash-"))
const kekFile = join(dir, "kek")
writeFileSync(kekFile, newKekLine(1) + "\n", { mode: 0o600 })
const keyring = loadKeyring(kekFile)

// ---------- 假的 OpenAI 兼容服务（OpenRouter 的 /chat/completions） ----------

type Handler = (
  body: { messages: unknown[]; tools?: unknown[] },
  res: ServerResponse
) => void
const requests: { messages: unknown[]; tools?: unknown[]; auth?: string }[] = []
let handlers: Handler[] = []
let fake: Server
let port = 0

function completion(
  res: ServerResponse,
  message: Record<string, unknown>,
  finish: string,
  cost: number
) {
  res.setHeader("content-type", "application/json")
  res.end(
    JSON.stringify({
      id: `gen-${requests.length}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "fake/model",
      provider: "Fake",
      choices: [
        {
          index: 0,
          message: { role: "assistant", ...message },
          finish_reason: finish,
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        cost,
      },
    })
  )
}

function workerProcess(name: string): ChildProcess & { logs: string[] } {
  // 直接起 node（不经过 tsx 的命令行包装），kill -9 杀的就是 worker 本身
  const child = spawn(
    process.execPath,
    ["--conditions=@heyagent/source", "--import", "tsx", "src/worker.ts"],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        DATABASE_URL: url,
        HEYAGENT_KEK_FILE: kekFile,
        HEYAGENT_FILES_DIR: join(dir, "files"),
        HEYAGENT_RUN_HEARTBEAT_SECONDS: "10",
        HEYAGENT_WORKER_SUPERVISE_SECONDS: "2",
        HEYAGENT_WORKER_POLL_SECONDS: "0.5",
        HEYAGENT_MODEL_RETRY_BASE_MS: "50",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  ) as ChildProcess & { logs: string[] }
  child.logs = []
  child.stdout!.on("data", (chunk) => child.logs.push(`[${name}] ${chunk}`))
  child.stderr!.on("data", (chunk) => child.logs.push(`[${name}:err] ${chunk}`))
  return child
}

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) =>
    child.exitCode !== null || child.signalCode !== null
      ? resolve()
      : child.once("exit", () => resolve())
  )

let workerA: (ChildProcess & { logs: string[] }) | undefined
let workerB: (ChildProcess & { logs: string[] }) | undefined

beforeAll(async () => {
  await dropBossSchema(url)
  await resetTestDatabase(url)
  await seedDemo(db, keyring, { password: PASSWORD })
  configureEngine({ keyring })

  fake = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      const body = JSON.parse(raw || "{}")
      requests.push({
        messages: body.messages,
        tools: body.tools,
        auth: req.headers.authorization,
      })
      const handler = handlers[requests.length - 1]
      if (!handler)
        return completion(res, { content: "（没有准备这一步）" }, "stop", 0)
      handler(body, res)
    })
  })
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve))
  port = (fake.address() as AddressInfo).port

  await saveSecret(db, keyring, {
    id: "sec-fake-key",
    scope: "model_provider",
    refId: "fakeor",
    name: "api_key",
    value: "sk-fake-provider-key",
  })
  await db.insert(t.modelProviders).values({
    id: "fakeor",
    kind: "openrouter",
    name: "假 OpenRouter",
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    apiKeySecretId: "sec-fake-key",
    status: "ok",
  })
  await db.insert(t.models).values({
    id: "fakeor/fake/model",
    providerId: "fakeor",
    name: "假模型",
    contextK: 100,
    priceIn: 1,
    priceOut: 1,
  })
}, 120_000)

afterAll(async () => {
  for (const child of [workerA, workerB])
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL")
  fake?.closeAllConnections()
  await new Promise<void>((resolve) => fake?.close(() => resolve()))
  await stopSenderBoss(db)
  await pool.end()
})

describe("场景 9：worker 中途被杀掉", () => {
  it("kill -9 之后起一个新的 worker，接着跑同一个 session，消息历史完整、做过的不重做", async () => {
    let reachedSecond!: () => void
    const second = new Promise<void>((resolve) => (reachedSecond = resolve))
    handlers = [
      (_body, res) =>
        completion(
          res,
          {
            content: "先勾第一个检查点",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "checkpoint_mark",
                  arguments: JSON.stringify({
                    checkpoint: 1,
                    status: "done",
                    record: "做完第一步",
                  }),
                },
              },
            ],
          },
          "tool_calls",
          0.0002
        ),
      // 第二次调用：一直不回，等测试把 worker 杀掉
      () => reachedSecond(),
      (_body, res) =>
        completion(res, { content: "worker 重启后接着做完了" }, "stop", 0.0003),
    ]
    const taskId = await createTask(db, {
      modelId: "fakeor/fake/model",
      steps: [
        { id: "s1", text: "第一步", wait: false, checkpoint: "第一步做完" },
      ],
    })
    const { sessionId } = await startSession(db, {
      taskId,
      source: "manual",
      actorId: "u-wang",
    })

    workerA = workerProcess("A")
    await Promise.race([
      second,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`worker A 没走到第二步：${workerA!.logs.join("")}`)
            ),
          40_000
        )
      ),
    ])
    workerA.kill("SIGKILL")
    await exited(workerA)
    // 被杀时：第一步已经落库（检查点、消息），第二次模型调用没有结果
    const [checkpoint] = await db
      .select()
      .from(t.checkpoints)
      .where(eq(t.checkpoints.sessionId, sessionId))
    expect(checkpoint!.status).toBe("done")
    expect((await waitStatus(db, sessionId, "running")).stepCount).toBe(1)

    workerB = workerProcess("B")
    const done = await waitStatus(db, sessionId, "done", 60_000).catch(
      (error) => {
        throw new Error(
          `${(error as Error).message}\n${workerB!.logs.join("")}`
        )
      }
    )
    expect(done.id).toBe(sessionId)
    expect(done.stepCount).toBe(2)
    expect(done.costUsd).toBeCloseTo(0.0005, 6) // 只算真正有结果的两次（按 usage.cost）

    // 第三次请求（worker B 发的）带着完整的历史：第一步的工具调用和结果都在
    expect(requests).toHaveLength(3)
    const history = JSON.stringify(requests[2]!.messages)
    expect(history).toContain("call_1")
    expect(history).toContain("已勾上第 1 个检查点")
    expect(requests[0]!.auth).toBe("Bearer sk-fake-provider-key")
    // 检查点只勾了一次；过程里只有两次模型调用
    const events = await eventsOf(db, sessionId)
    expect(events.filter((event) => event.kind === "checkpoint")).toHaveLength(
      1
    )
    expect(events.filter((event) => event.kind === "think")).toHaveLength(2)
    expect(
      (await messagesOf(db, sessionId)).map((message) => message.role)
    ).toEqual(["user", "assistant", "tool", "assistant"])

    // 优雅退出
    workerB.kill("SIGTERM")
    await exited(workerB)
    expect(workerB.logs.join("")).toContain("正在关闭 worker")
  }, 150_000)

  it("worker 收到 SIGTERM 时正在跑的 session：交给下一个 worker 接着跑", async () => {
    requests.length = 0
    let reached!: () => void
    const hanging = new Promise<void>((resolve) => (reached = resolve))
    handlers = [
      () => reached(),
      (_body, res) =>
        completion(res, { content: "换了个 worker 做完了" }, "stop", 0.0001),
    ]
    const taskId = await createTask(db, { modelId: "fakeor/fake/model" })
    const { sessionId } = await startSession(db, {
      taskId,
      source: "manual",
      actorId: "u-wang",
    })
    workerA = workerProcess("A2")
    await hanging
    workerA.kill("SIGTERM")
    await exited(workerA)
    workerB = workerProcess("B2")
    await waitStatus(db, sessionId, "done", 60_000).catch((error) => {
      throw new Error(
        `${(error as Error).message}\n${workerA!.logs.join("")}\n${workerB!.logs.join("")}`
      )
    })
    await waitFor(async () => requests.length === 2, {
      what: "第二个 worker 重新调模型",
    })
    workerB.kill("SIGTERM")
    await exited(workerB)
  }, 150_000)
})
