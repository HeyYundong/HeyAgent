// 引擎的集成测试：真实的测试库 + 进程内 worker（pg-boss）+ 假模型（AI SDK 的 MockLanguageModelV4）。
// 覆盖 docs/dev/m1.md「P1 验收」的场景 1～8、10～12（场景 9「worker 被杀掉」在 engine-crash.test.ts，起真实的子进程）。
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"

import { and, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { syncTaskSchedule, syncTodo } from "../src/engine/api.js"
import { sha256Hex } from "../src/engine/http.js"
import { QUEUES } from "../src/engine/queue.js"
import { lineDiff } from "../src/engine/tools/builtin.js"
import { login, query } from "./helpers.js"
import {
  bossJobs,
  call,
  createTask,
  eventsOf,
  messagesOf,
  mutate,
  saveSecret,
  Script,
  sessionRow,
  setSetting,
  setupEngine,
  step,
  text,
  useScript,
  waitFor,
  waitStatus,
  type EngineTestContext,
} from "./engine-helpers.js"

let ctx: EngineTestContext
let lin: string // 主管
let wang: string // 员工，测试任务的负责人
let li: string // 另一个员工

beforeAll(async () => {
  ctx = await setupEngine({ cronWorkerIntervalSeconds: 2 })
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
  li = await login(ctx.app, "lijing@heyagent.local")
}, 120_000)

afterAll(async () => {
  await ctx?.stop()
})

const CHECKPOINT_STEP = [
  { id: "s1", text: "做完并汇报", wait: false, checkpoint: "汇总表已保存" },
]

async function runNow(
  taskId: string,
  cookie = wang,
  extra: Record<string, unknown> = {}
) {
  const res = await mutate(ctx.app, "engine.runNow", cookie, {
    taskId,
    ...extra,
  })
  if (!res.data) throw new Error(`runNow 失败：${JSON.stringify(res.error)}`)
  return res.data.sessionId as string
}

describe("场景 1：调内置工具再结束", () => {
  it("勾检查点 → 最终答复 → 已完成；每一步都落库", async () => {
    const script = useScript(
      "test/s1",
      new Script([
        step([
          text("先勾检查点"),
          call("checkpoint.mark", {
            checkpoint: 1,
            status: "done",
            record: "表已经存好",
          }),
        ]),
        step([text("全部完成，表在附件里")]),
      ])
    )
    const taskId = await createTask(ctx.db, {
      modelId: "test/s1",
      steps: CHECKPOINT_STEP,
    })
    const sessionId = await runNow(taskId)
    const done = await waitStatus(ctx.db, sessionId, "done")
    expect(done.endedAt).toBeTruthy()
    expect(done.stepCount).toBe(2)
    expect(done.costUsd).toBeCloseTo(0.002, 6)
    expect(done.tokensIn).toBe(200)

    // 工具定义不带 execute，名字里的点换成了下划线；每个任务都自带 3 个内置工具
    const toolNames = (script.prompts[0]!.tools ?? []).map((tool) => tool.name)
    expect(toolNames).toEqual(
      expect.arrayContaining(["checkpoint_mark", "session_wait", "ask_human"])
    )
    expect(script.promptText(1)).toContain("已勾上第 1 个检查点")

    const [checkpoint] = await ctx.db
      .select()
      .from(t.checkpoints)
      .where(eq(t.checkpoints.sessionId, sessionId))
    expect(checkpoint).toMatchObject({
      title: "汇总表已保存",
      kind: "artifact",
      status: "done",
    })
    const records = await ctx.db
      .select()
      .from(t.checkpointRecords)
      .where(eq(t.checkpointRecords.checkpointId, checkpoint!.id))
    expect(records.map((record) => record.text)).toEqual(["表已经存好"])

    const kinds = (await eventsOf(ctx.db, sessionId)).map((event) => event.kind)
    expect(kinds).toEqual([
      "plan",
      "think",
      "checkpoint",
      "tool",
      "think",
      "done",
    ])
    const roles = (await messagesOf(ctx.db, sessionId)).map(
      (message) => message.role
    )
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"])

    // 界面读的 sessions.get 能读出来（形状照 M0 的契约）
    const run = await query(ctx.app, "sessions.get", wang, { id: sessionId })
    expect(run.data).toMatchObject({
      id: sessionId,
      status: "done",
      checkpoints: [{ status: "done" }],
    })
    // 完成后给负责人发了站内通知
    const notes = await query(ctx.app, "engine.notifications.list", wang)
    expect(
      notes.data.items.some(
        (item: { title: string; sessionId?: string }) =>
          item.sessionId === sessionId && item.title.includes("运行完成")
      )
    ).toBe(true)
  })

  it("员工不能运行别人负责的任务；工具不在范围里、参数不对都被拦下", async () => {
    const script = useScript(
      "test/s1b",
      new Script([
        step([
          call("file.save", { name: "a.csv", content: "x" }),
          call("checkpoint.mark", { checkpoint: "第一个", status: "done" }),
        ]),
        step([text("好的，结束")]),
      ])
    )
    const taskId = await createTask(ctx.db, {
      modelId: "test/s1b",
      steps: CHECKPOINT_STEP,
    })
    const denied = await mutate(ctx.app, "engine.runNow", li, { taskId })
    expect(denied.error?.data?.code).toBe("FORBIDDEN")
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "done")
    const rules = (await eventsOf(ctx.db, sessionId)).filter(
      (event) => event.kind === "rule"
    )
    expect(rules.map((event) => event.detail)).toEqual([
      expect.stringContaining("不在本任务允许的范围里"),
      expect.stringContaining("参数不对"),
    ])
    expect(script.promptText(1)).toContain("被拦下")
    const files = await ctx.db
      .select()
      .from(t.files)
      .where(eq(t.files.sessionId, sessionId))
    expect(files).toHaveLength(0)
  })
})

describe("场景 2：HTTP 工具", () => {
  let server: Server
  let port = 0
  const received: { auth?: string; q?: string }[] = []
  const SECRET = "s3cr3t-token-value-0042"

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost")
      received.push({
        auth: req.headers.authorization,
        q: url.searchParams.get("q") ?? undefined,
      })
      res.setHeader("content-type", "application/json")
      if (url.pathname === "/big") return res.end("x".repeat(20_000))
      // 故意把收到的密钥原样带回来，测试它在给模型的结果里被隐藏
      res.end(
        JSON.stringify({
          ok: true,
          q: url.searchParams.get("q"),
          echoedAuth: req.headers.authorization,
        })
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
    await saveSecret(ctx.db, ctx.keyring, {
      id: "sec-test-token",
      scope: "http_tool",
      name: "TEST_TOKEN",
      value: SECRET,
    })
    await ctx.db.insert(t.tools).values([
      {
        id: "http.echo",
        name: "回声接口",
        summary: "测试用",
        description: "原样返回",
        source: "http",
        risk: "read",
        http: {
          method: "GET",
          url: `http://127.0.0.1:${port}/echo?q={q}`,
          headers: { Authorization: "Bearer {{TEST_TOKEN}}" },
        },
      },
      {
        id: "http.big",
        name: "大输出",
        summary: "测试用",
        description: "返回很长的内容",
        source: "http",
        risk: "read",
        http: { method: "GET", url: `http://127.0.0.1:${port}/big` },
      },
    ])
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it("密钥执行时才替换；返回里的密钥原文被隐藏；超长输出截断并存成文件", async () => {
    const script = useScript(
      "test/s2",
      new Script([
        step([
          call("http.echo", { q: "你好 {{TEST_TOKEN}}" }),
          call("http.big", {}),
        ]),
        step([text("拿到了")]),
      ])
    )
    const taskId = await createTask(ctx.db, {
      modelId: "test/s2",
      toolIds: ["http.echo", "http.big"],
    })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "done")

    // 发出去的请求带的是真密钥；模型填的参数里写 {{TEST_TOKEN}} 不会被换成密钥
    expect(received[0]).toEqual({
      auth: `Bearer ${SECRET}`,
      q: "你好 {{TEST_TOKEN}}",
    })
    // 模型只看到 [已隐藏]
    const second = script.promptText(1)
    expect(second).toContain("[已隐藏]")
    expect(second).not.toContain(SECRET)
    // 工具定义里模型看到的只有参数 q，没有密钥
    expect(JSON.stringify(script.prompts[0]!.tools)).not.toContain(SECRET)
    // 库里的过程和消息也没有原文
    const leaked = await ctx.db.execute(
      sql`select count(*)::int as n from session_events where session_id = ${sessionId} and (output like ${"%" + SECRET + "%"} or input like ${"%" + SECRET + "%"})`
    )
    expect(leaked.rows[0]).toEqual({ n: 0 })
    const leakedMessages = await ctx.db.execute(
      sql`select count(*)::int as n from session_messages where session_id = ${sessionId} and content::text like ${"%" + SECRET + "%"}`
    )
    expect(leakedMessages.rows[0]).toEqual({ n: 0 })

    // 超长输出：模型拿到开头 + 文件引用，全文存成了 tool_output 文件
    expect(second).toContain("全文已存为文件")
    const files = await ctx.db
      .select()
      .from(t.files)
      .where(
        and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "tool_output"))
      )
    expect(files).toHaveLength(1)
    expect(files[0]!.size).toBeGreaterThan(20_000)
  })
})

describe("场景 3：MCP 工具", () => {
  it("起一个本地 stdio MCP 服务器：环境变量从密钥来，返回里的密钥被隐藏", async () => {
    const serverPath = fileURLToPath(
      new URL("./fixtures/mcp-echo-server.mjs", import.meta.url)
    )
    await ctx.db.insert(t.mcpServers).values({
      id: "mcp-echo",
      name: "回声 MCP",
      transport: "stdio",
      command: `"${process.execPath}" "${serverPath}"`,
      status: "connected",
      envKeys: ["MCP_SECRET"],
    })
    await saveSecret(ctx.db, ctx.keyring, {
      id: "sec-mcp-echo",
      scope: "mcp_env",
      refId: "mcp-echo",
      name: "MCP_SECRET",
      value: "{{MCP_GLOBAL}}",
    })
    await saveSecret(ctx.db, ctx.keyring, {
      id: "sec-mcp-global",
      scope: "http_tool",
      name: "MCP_GLOBAL",
      value: "mcp-secret-value-123",
    })
    await ctx.db.insert(t.tools).values({
      id: "shout",
      name: "大声说",
      summary: "测试用",
      description: "",
      source: "mcp",
      serverId: "mcp-echo",
      risk: "read",
    })

    // 工具页的「连接并读取工具」
    const listed = await mutate(ctx.app, "engine.listMcpServerTools", lin, {
      serverId: "mcp-echo",
    })
    expect(listed.data).toMatchObject({
      ok: true,
      tools: [{ name: "shout" }, { name: "ping" }],
    })
    expect(
      (
        await mutate(ctx.app, "engine.listMcpServerTools", wang, {
          serverId: "mcp-echo",
        })
      ).error?.data?.code
    ).toBe("FORBIDDEN")

    const script = useScript(
      "test/s3",
      new Script([
        step([call("shout", { text: "hello" })]),
        step([text("好了")]),
      ])
    )
    const taskId = await createTask(ctx.db, {
      modelId: "test/s3",
      toolIds: ["shout"],
    })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "done")
    // 只给模型本任务选的 MCP 工具（ping 没选），schema 来自服务器
    const tools = script.prompts[0]!.tools ?? []
    expect(tools.map((tool) => tool.name)).toContain("shout")
    expect(tools.map((tool) => tool.name)).not.toContain("ping")
    const second = script.promptText(1)
    expect(second).toContain("HELLO (secret=[已隐藏])")
    expect(second).not.toContain("mcp-secret-value-123")
  })
})

describe("场景 4：session.wait 到点继续", () => {
  it("挂起 → 到点叫醒 → 同一个 session 接着跑，消息历史完整", async () => {
    const script = useScript(
      "test/s4",
      new Script([
        step([
          text("等 3 秒"),
          call("session.wait", { what: "等一会儿", afterMinutes: 0.05 }),
        ]),
        step([text("等到了，完成")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/s4" })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "waiting")
    const run = await query(ctx.app, "sessions.get", wang, { id: sessionId })
    expect(run.data.waiting).toMatchObject({
      what: "等一会儿",
      trigger: { kind: "time" },
    })
    await waitStatus(ctx.db, sessionId, "done", 20_000)

    expect(script.prompts).toHaveLength(2)
    const second = script.promptText(1)
    expect(second).toContain("等一会儿")
    expect(second).toContain("已挂起")
    expect(second).toContain("【继续】")
    const roles = (await messagesOf(ctx.db, sessionId)).map(
      (message) => message.role
    )
    expect(roles).toEqual(["user", "assistant", "tool", "user", "assistant"])
    const kinds = (await eventsOf(ctx.db, sessionId)).map((event) => event.kind)
    expect(kinds).toEqual(expect.arrayContaining(["wait", "resume", "done"]))
    const [wait] = await ctx.db
      .select()
      .from(t.sessionWaits)
      .where(eq(t.sessionWaits.sessionId, sessionId))
    expect(wait).toMatchObject({ status: "fired", firedCause: "timer" })
  })
})

describe("场景 5：只等事件", () => {
  it("事件到了继续（控制台触发），事件数据交给模型", async () => {
    const script = useScript(
      "test/s5",
      new Script([
        step([
          call("session.wait", { what: "等付款", event: "payment.received" }),
        ]),
        step([text("收到款了")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/s5" })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "waiting")
    const [wait] = await ctx.db
      .select()
      .from(t.sessionWaits)
      .where(eq(t.sessionWaits.sessionId, sessionId))
    // 只等事件：自动加兜底期限（默认 7 天）
    expect(wait!.fallbackDays).toBe(7)
    expect(wait!.deadlineAt!.getTime() - Date.now()).toBeGreaterThan(
      6.9 * 24 * 3600 * 1000
    )
    expect(
      (await bossJobs(ctx.db, QUEUES.remind)).some(
        (job) => job.data.waitId === wait!.id
      )
    ).toBe(true)

    expect(
      (
        await mutate(ctx.app, "engine.fireEvent", wang, {
          event: "payment.received",
        })
      ).error?.data?.code
    ).toBe("FORBIDDEN")
    const fired = await mutate(ctx.app, "engine.fireEvent", lin, {
      event: "payment.received",
      data: { amount: 42 },
    })
    expect(fired.data.resumedSessionIds).toEqual([sessionId])
    await waitStatus(ctx.db, sessionId, "done")
    expect(script.promptText(1)).toContain('\\"amount\\":42')
  })

  it("外部系统 POST /api/events：令牌按 sha256 校验", async () => {
    useScript(
      "test/s5b",
      new Script([
        step([call("session.wait", { what: "等回执", event: "receipt" })]),
        step([text("好")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/s5b" })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "waiting")
    const post = (token: string | undefined, body: unknown) =>
      ctx.app.request("/api/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      })
    expect((await post("anything", { event: "receipt" })).status).toBe(401) // 还没配令牌
    await setSetting(ctx.db, "events.token", {
      sha256: sha256Hex("good-token-123"),
      hint: "…123",
      createdAt: new Date().toISOString(),
    })
    expect((await post("bad-token", { event: "receipt" })).status).toBe(401)
    expect((await post(undefined, { event: "receipt" })).status).toBe(401)
    expect((await post("good-token-123", { nope: 1 })).status).toBe(400)
    const ok = await post("good-token-123", {
      event: "receipt",
      data: { no: "A-1" },
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({
      ok: true,
      resumedSessionIds: [sessionId],
    })
    await waitStatus(ctx.db, sessionId, "done")
  })

  it("兜底期限到了：只提醒负责人，不继续", async () => {
    useScript(
      "test/s5c",
      new Script([
        step([
          call("session.wait", {
            what: "等一个不会来的事件",
            event: "never.happens",
          }),
        ]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/s5c" })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "waiting")
    const [wait] = await ctx.db
      .select()
      .from(t.sessionWaits)
      .where(eq(t.sessionWaits.sessionId, sessionId))
    // 把期限挪到现在，模拟 7 天后
    await ctx.db
      .update(t.sessionWaits)
      .set({ deadlineAt: new Date(Date.now() - 1000) })
      .where(eq(t.sessionWaits.id, wait!.id))
    await ctx.worker.boss.send(QUEUES.remind, { waitId: wait!.id })
    const notes = await waitFor(
      async () => {
        const rows = await ctx.db
          .select()
          .from(t.notifications)
          .where(
            and(
              eq(t.notifications.sessionId, sessionId),
              eq(t.notifications.userId, "u-wang")
            )
          )
        return rows.length ? rows : undefined
      },
      { what: "兜底提醒" }
    )
    expect(notes.map((note) => note.title)).toEqual([
      expect.stringContaining("还没等到"),
    ])
    await sleep(1500)
    expect((await sessionRow(ctx.db, sessionId))!.status).toBe("waiting")
    const [after] = await ctx.db
      .select()
      .from(t.sessionWaits)
      .where(eq(t.sessionWaits.id, wait!.id))
    expect(after!.status).toBe("waiting")
    expect(after!.remindedAt).toBeTruthy()

    // 取消：标失败，等待作废
    const cancelled = await mutate(ctx.app, "engine.cancel", wang, {
      sessionId,
      reason: "不等了",
    })
    expect(cancelled.data).toEqual({ sessionId })
    const row = await sessionRow(ctx.db, sessionId)
    expect(row).toMatchObject({
      status: "failed",
      error: expect.stringContaining("不等了"),
    })
    const [cancelledWait] = await ctx.db
      .select()
      .from(t.sessionWaits)
      .where(eq(t.sessionWaits.id, wait!.id))
    expect(cancelledWait!.status).toBe("cancelled")
    const audit = await ctx.db
      .select()
      .from(t.auditEvents)
      .where(
        and(
          eq(t.auditEvents.action, "session.cancel"),
          eq(t.auditEvents.targetId, sessionId)
        )
      )
    expect(audit).toHaveLength(1)
  })
})

describe("场景 6：ask.human", () => {
  it("生成要人办的事 → 处理完继续，处理结果和备注交给模型", async () => {
    const script = useScript(
      "test/s6",
      new Script([
        step([
          call("ask.human", {
            question: "这段话可以发出去吗？\n内容：……",
            options: ["可以", "不可以"],
          }),
        ]),
        step([text("收到，已按批准处理")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/s6" })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "needs_human")
    const [item] = await ctx.db
      .select()
      .from(t.humanItems)
      .where(eq(t.humanItems.sessionId, sessionId))
    expect(item).toMatchObject({
      kind: "approval",
      assigneeId: "u-wang",
      status: "open",
      title: "这段话可以发出去吗？",
    })
    expect(item!.detail).toMatchObject({ primary: "可以", secondary: "不可以" })
    // 看板上能看到；不是分给自己的处理不了
    const board = await query(ctx.app, "todos.board", wang)
    expect(
      board.data.humanItems.some((each: { id: string }) => each.id === item!.id)
    ).toBe(true)
    expect(
      (
        await mutate(ctx.app, "engine.resolveHumanItem", li, {
          itemId: item!.id,
          how: "approve",
        })
      ).error?.data?.code
    ).toBe("FORBIDDEN")
    // 等人处理的不能「立即继续」
    expect(
      (await mutate(ctx.app, "engine.resumeNow", wang, { sessionId })).error
        ?.data?.code
    ).toBe("BAD_REQUEST")

    const resolved = await mutate(ctx.app, "engine.resolveHumanItem", wang, {
      itemId: item!.id,
      how: "approve",
      note: "可以发，语气再客气点",
    })
    expect(resolved.data).toEqual({ resumedSessionId: sessionId })
    await waitStatus(ctx.db, sessionId, "done")
    const second = script.promptText(1)
    expect(second).toContain("批准")
    expect(second).toContain("语气再客气点")
    // 处理过的再处理一次：冲突
    expect(
      (
        await mutate(ctx.app, "engine.resolveHumanItem", wang, {
          itemId: item!.id,
          how: "reject",
        })
      ).error?.data?.code
    ).toBe("CONFLICT")
    const audit = await ctx.db
      .select()
      .from(t.auditEvents)
      .where(
        and(
          eq(t.auditEvents.action, "human_item.resolve"),
          eq(t.auditEvents.targetId, item!.id)
        )
      )
    expect(audit[0]!.detail).toMatchObject({
      how: "approve",
      note: "可以发，语气再客气点",
    })
  })
})

describe("场景 7：时间和事件同时等", () => {
  it("事件先到先继续；后到的定时不起作用", async () => {
    useScript(
      "test/s7",
      new Script([
        step([
          call("session.wait", {
            what: "等回复，最多 3 秒",
            afterMinutes: 0.05,
            event: "reply",
          }),
        ]),
        step([text("等到回复了")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/s7" })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "waiting")
    const run = await query(ctx.app, "sessions.get", wang, { id: sessionId })
    expect(run.data.waiting.trigger.kind).toBe("time_or_event")
    const fired = await mutate(ctx.app, "engine.fireEvent", lin, {
      event: "reply",
    })
    expect(fired.data.resumedSessionIds).toEqual([sessionId])
    await waitStatus(ctx.db, sessionId, "done")
    // 等定时到点、叫醒任务跑完
    const [wait] = await ctx.db
      .select()
      .from(t.sessionWaits)
      .where(eq(t.sessionWaits.sessionId, sessionId))
    await waitFor(
      async () =>
        (await bossJobs(ctx.db, QUEUES.wake)).find(
          (job) => job.data.waitId === wait!.id && job.state === "completed"
        ),
      { what: "叫醒任务跑完" }
    )
    expect(wait).toMatchObject({ status: "fired", firedCause: "event" })
    const resumes = (await eventsOf(ctx.db, sessionId)).filter(
      (event) => event.kind === "resume"
    )
    expect(resumes).toHaveLength(1)
    expect((await sessionRow(ctx.db, sessionId))!.status).toBe("done")
    const continued = (await messagesOf(ctx.db, sessionId)).filter(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content).includes("【继续】")
    )
    expect(continued).toHaveLength(1)
  })

  it("反过来：定时先到，后到的事件不起作用", async () => {
    useScript(
      "test/s7b",
      new Script([
        step([
          call("session.wait", {
            what: "等 3 秒或者事件",
            afterMinutes: 0.05,
            event: "late.event",
          }),
        ]),
        step([text("到点了")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/s7b" })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "waiting")
    await waitStatus(ctx.db, sessionId, "done", 20_000)
    const fired = await mutate(ctx.app, "engine.fireEvent", lin, {
      event: "late.event",
    })
    expect(fired.data.resumedSessionIds).toEqual([])
    expect(
      (await eventsOf(ctx.db, sessionId)).filter(
        (event) => event.kind === "resume"
      )
    ).toHaveLength(1)
  })
})

describe("场景 8：超过花费上限转人工", () => {
  it("到上限 → 生成「要不要继续」→ 同意后调高上限继续 → 完成", async () => {
    await setSetting(ctx.db, "session.maxCostUsd", 0.01)
    try {
      const script = useScript(
        "test/s8",
        new Script([
          step(
            [
              text("第一步很贵"),
              call("checkpoint.mark", { checkpoint: 1, status: "done" }),
            ],
            0.02
          ),
          step([text("完成")], 0.001),
        ])
      )
      const taskId = await createTask(ctx.db, {
        modelId: "test/s8",
        steps: CHECKPOINT_STEP,
      })
      const sessionId = await runNow(taskId)
      await waitStatus(ctx.db, sessionId, "needs_human")
      const [item] = await ctx.db
        .select()
        .from(t.humanItems)
        .where(eq(t.humanItems.sessionId, sessionId))
      expect(item).toMatchObject({
        kind: "approval",
        title: "花费到了上限，要不要继续",
        assigneeId: "u-wang",
        urgency: 1,
      })
      expect(script.prompts).toHaveLength(1)
      const resolved = await mutate(ctx.app, "engine.resolveHumanItem", lin, {
        itemId: item!.id,
        how: "approve",
      })
      expect(resolved.data).toEqual({ resumedSessionId: sessionId })
      const done = await waitStatus(ctx.db, sessionId, "done")
      expect(done.costLimitUsd).toBeCloseTo(0.03, 6)
      expect(script.prompts).toHaveLength(2)
    } finally {
      await setSetting(ctx.db, "session.maxCostUsd", 2)
    }
  })

  it("步数到上限，不同意就结束运行", async () => {
    await setSetting(ctx.db, "session.maxSteps", 1)
    try {
      useScript(
        "test/s8b",
        new Script([
          step([call("checkpoint.mark", { checkpoint: 1, status: "done" })]),
        ])
      )
      const taskId = await createTask(ctx.db, {
        modelId: "test/s8b",
        steps: CHECKPOINT_STEP,
      })
      const sessionId = await runNow(taskId)
      await waitStatus(ctx.db, sessionId, "needs_human")
      const [item] = await ctx.db
        .select()
        .from(t.humanItems)
        .where(eq(t.humanItems.sessionId, sessionId))
      expect(item!.title).toBe("步数到了上限，要不要继续")
      const resolved = await mutate(ctx.app, "engine.resolveHumanItem", wang, {
        itemId: item!.id,
        how: "reject",
        note: "先停",
      })
      expect(resolved.data).toEqual({ endedSessionId: sessionId })
      expect(await sessionRow(ctx.db, sessionId)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("决定不继续"),
      })
    } finally {
      await setSetting(ctx.db, "session.maxSteps", 100)
    }
  })

  it("模型一直出错：退避重试 3 次后标失败，写清原因", async () => {
    let calls = 0
    useScript(
      "test/s8c",
      new Script(
        Array.from({ length: 5 }, () => () => {
          calls += 1
          throw new Error("上游 502")
        })
      )
    )
    const taskId = await createTask(ctx.db, { modelId: "test/s8c" })
    const sessionId = await runNow(taskId)
    const failed = await waitStatus(ctx.db, sessionId, "failed")
    expect(calls).toBe(4)
    expect(failed.error).toContain("上游 502")
    const errors = (await eventsOf(ctx.db, sessionId)).filter(
      (event) => event.kind === "error"
    )
    expect(errors).toHaveLength(4) // 3 次重试 + 1 次失败
  })
})

describe("场景 10：cron 触发新 session", () => {
  it("按任务 id 注册 schedule（上海时区），到点新开一次运行；停用后取消", async () => {
    useScript(
      "test/s10",
      new Script(
        Array.from({ length: 5 }, () => step([text("定时任务做完了")]))
      )
    )
    const taskId = await createTask(ctx.db, {
      modelId: "test/s10",
      scheduleCron: "* * * * *",
    })
    await syncTaskSchedule(ctx.db, taskId)
    const schedule = await ctx.worker.boss.getSchedule(QUEUES.taskCron, taskId)
    expect(schedule).toMatchObject({
      cron: "* * * * *",
      timezone: "Asia/Shanghai",
      data: { taskId },
    })
    const [task] = await ctx.db
      .select()
      .from(t.tasks)
      .where(eq(t.tasks.id, taskId))
    expect(task!.nextRunAt!.getTime()).toBeGreaterThan(Date.now())

    const session = await waitFor(
      async () => {
        const [row] = await ctx.db
          .select()
          .from(t.sessions)
          .where(
            and(
              eq(t.sessions.taskId, taskId),
              eq(t.sessions.triggeredBy, "cron")
            )
          )
        return row
      },
      { timeout: 90_000, interval: 1000, what: "cron 触发" }
    )
    expect(session.id).toMatch(new RegExp(`^R-${taskId.slice(2)}-\\d{4}`))
    await waitStatus(ctx.db, session.id, "done")

    await ctx.db
      .update(t.tasks)
      .set({ enabled: false })
      .where(eq(t.tasks.id, taskId))
    await syncTaskSchedule(ctx.db, taskId)
    expect(
      await ctx.worker.boss.getSchedule(QUEUES.taskCron, taskId)
    ).toBeNull()
  }, 120_000)
})

describe("场景 11：人加的待办触发", () => {
  it("任务有挂起中的 session：用待办标题作为「等到了什么」继续它", async () => {
    const script = useScript(
      "test/s11",
      new Script([
        step([
          call("session.wait", { what: "等客户回复", event: "customer.reply" }),
        ]),
        step([text("客户回复了，完成")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/s11" })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "waiting")
    await ctx.db.insert(t.humanTodos).values({
      id: "td-901",
      taskId,
      title: "客户在群里回复了报价",
      triggerKind: "time",
      at: new Date(Date.now() + 1500),
      createdById: "u-wang",
    })
    await syncTodo(ctx.db, "td-901")
    await waitStatus(ctx.db, sessionId, "done", 20_000)
    expect(script.promptText(1)).toContain("客户在群里回复了报价")
    const [todo] = await ctx.db
      .select()
      .from(t.humanTodos)
      .where(eq(t.humanTodos.id, "td-901"))
    expect(todo!.status).toBe("done")
    expect(
      await ctx.db
        .select()
        .from(t.sessions)
        .where(eq(t.sessions.taskId, taskId))
    ).toHaveLength(1)
  })

  it("没有挂起的 session：用待办标题作为附加说明新开一次运行；事件待办由事件触发", async () => {
    const script = useScript(
      "test/s11b",
      new Script([step([text("按待办做完了")]), step([text("第二次也做完了")])])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/s11b" })
    await ctx.db.insert(t.humanTodos).values({
      id: "td-902",
      taskId,
      title: "整理本周的数据",
      triggerKind: "time",
      at: new Date(Date.now() + 1000),
      createdById: "u-wang",
    })
    await syncTodo(ctx.db, "td-902")
    const session = await waitFor(
      async () =>
        (
          await ctx.db
            .select()
            .from(t.sessions)
            .where(eq(t.sessions.taskId, taskId))
        )[0],
      { what: "待办新开运行" }
    )
    expect(session).toMatchObject({
      triggeredBy: "todo",
      note: "整理本周的数据",
    })
    await waitStatus(ctx.db, session.id, "done")
    expect(script.promptText(0)).toContain("附加说明：整理本周的数据")

    // 事件待办：事件到了触发
    await ctx.db.insert(t.humanTodos).values({
      id: "td-903",
      taskId,
      title: "货到了就处理",
      triggerKind: "event",
      event: "goods.arrived",
      fallbackDays: 3,
      createdById: "u-wang",
    })
    await syncTodo(ctx.db, "td-903")
    expect(
      (await bossJobs(ctx.db, QUEUES.todoRemind)).some(
        (job) => job.data.todoId === "td-903"
      )
    ).toBe(true)
    const fired = await mutate(ctx.app, "engine.fireEvent", lin, {
      event: "goods.arrived",
    })
    expect(fired.data.firedTodoIds).toEqual(["td-903"])
    await waitFor(
      async () =>
        (
          await ctx.db
            .select()
            .from(t.sessions)
            .where(
              and(eq(t.sessions.taskId, taskId), eq(t.sessions.status, "done"))
            )
        ).length === 2,
      { what: "事件待办新开运行" }
    )
  })
})

describe("待办的立即执行（engine.runTodoNow，M1 P3）", () => {
  it("有挂起的 session 就继续它；一次性待办执行后结束；别人加的、别人负责的任务不能执行", async () => {
    const script = useScript(
      "test/todo-now",
      new Script([
        step([call("session.wait", { what: "等资料", afterMinutes: 600 })]),
        step([text("资料到了，完成")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/todo-now" })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "waiting")
    await ctx.db.insert(t.humanTodos).values({
      id: "td-950",
      taskId,
      title: "资料已经放进共享盘",
      triggerKind: "time",
      at: new Date(Date.now() + 3_600_000),
      createdById: "u-wang",
    })
    await syncTodo(ctx.db, "td-950")
    // 李静既不是加这条的人，也不是任务负责人
    const denied = await mutate(ctx.app, "engine.runTodoNow", li, { todoId: "td-950" })
    expect(denied.error?.data?.code).toBe("FORBIDDEN")
    const ran = await mutate(ctx.app, "engine.runTodoNow", wang, { todoId: "td-950" })
    expect(ran.data).toEqual({ resumedSessionId: sessionId })
    await waitStatus(ctx.db, sessionId, "done")
    expect(script.promptText(1)).toContain("资料已经放进共享盘")
    const [todo] = await ctx.db.select().from(t.humanTodos).where(eq(t.humanTodos.id, "td-950"))
    expect(todo!.status).toBe("done")
    // 已经执行过的不能再执行
    const again = await mutate(ctx.app, "engine.runTodoNow", wang, { todoId: "td-950" })
    expect(again.error?.data?.code).toBe("CONFLICT")
    const audits = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.action, "todo.run"), eq(t.auditEvents.targetId, "td-950")))
    expect(audits).toHaveLength(1)
  })
})

describe("场景 12：file.save 和 file.read", () => {
  it("上传附件 → 立即运行带附件 → 读文本和图片 → 存产物；能列出、能下载", async () => {
    type Uploaded = { id: string; name: string; mime: string; url: string }
    const upload = async (
      name: string,
      type: string,
      data: Uint8Array | string,
      cookie: string | null = wang
    ) => {
      const form = new FormData()
      form.append(
        "file",
        new File(
          [typeof data === "string" ? data : new Blob([new Uint8Array(data)])],
          name,
          { type }
        )
      )
      return ctx.app.request("/api/files", {
        method: "POST",
        body: form,
        headers: cookie ? { cookie } : {},
      })
    }
    const json = async (res: Response | Promise<Response>) =>
      (await (await res).json()) as Uploaded
    expect((await upload("x.txt", "text/plain", "x", null)).status).toBe(401)
    const txt = await json(
      upload("需求.txt", "text/plain", "要整理三列：名称、数量、价格")
    )
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    )
    const img = await json(upload("图.png", "image/png", png))
    expect(txt).toMatchObject({
      name: "需求.txt",
      mime: "text/plain",
      url: `/api/files/${txt.id}`,
    })

    const script = useScript(
      "test/s12",
      new Script([
        step([
          call("file.read", { fileId: txt.id }),
          call("file.read", { fileId: img.id }),
          call("file.save", {
            name: "结果.csv",
            content: "名称,数量,价格\nA,1,2",
          }),
          call("file.save", { name: "evil.exe", content: "x" }),
        ]),
        step([text("表存好了")]),
      ])
    )
    const taskId = await createTask(ctx.db, {
      modelId: "test/s12",
      toolIds: ["file.read", "file.save"],
    })
    // 任务附件：跨运行一直有效
    const taskFile = await json(upload("模板.md", "text/markdown", "# 模板"))
    const attached = await mutate(ctx.app, "engine.attachToTask", wang, {
      taskId,
      fileId: taskFile.id,
    })
    expect(attached.data).toMatchObject({
      id: taskFile.id,
      scope: "task",
      kind: "attachment",
    })
    expect(
      (
        await mutate(ctx.app, "engine.attachToTask", li, {
          taskId,
          fileId: taskFile.id,
        })
      ).error?.data?.code
    ).toBe("FORBIDDEN")

    const sessionId = await runNow(taskId, wang, {
      attachmentFileIds: [txt.id, img.id],
    })
    await waitStatus(ctx.db, sessionId, "done")
    // 文本直接给内容；图片作为下一条用户消息的图片
    const second = script.prompts[1]!.prompt
    expect(JSON.stringify(second)).toContain("要整理三列")
    const parts = second.flatMap((message) =>
      Array.isArray(message.content)
        ? (message.content as { type: string; mediaType?: string }[])
        : []
    )
    const imagePart = parts.find(
      (part) => part.type === "file" && part.mediaType?.startsWith("image/")
    )
    expect(imagePart).toBeTruthy()
    expect(JSON.stringify(second)).toContain("只能存文本格式")
    // 系统提示里有附件清单（任务附件 + 这次带的）
    const system = JSON.stringify(script.prompts[0]!.prompt[0])
    expect(system).toContain(txt.id)
    expect(system).toContain(taskFile.id)

    const files = await query(ctx.app, "engine.sessionFiles", wang, {
      sessionId,
    })
    const byName = Object.fromEntries(
      (
        files.data as {
          name: string
          kind: string
          scope: string
          id: string
        }[]
      ).map((file) => [file.name, file])
    )
    expect(byName["需求.txt"]).toMatchObject({
      kind: "attachment",
      scope: "session",
    })
    expect(byName["模板.md"]).toMatchObject({
      kind: "attachment",
      scope: "task",
    })
    expect(byName["结果.csv"]).toMatchObject({
      kind: "artifact",
      scope: "session",
    })
    expect(byName["evil.exe"]).toBeUndefined()

    const download = await ctx.app.request(
      `/api/files/${byName["结果.csv"]!.id}`,
      { headers: { cookie: li } }
    )
    expect(download.status).toBe(200)
    expect(download.headers.get("content-disposition")).toContain("attachment")
    expect(await download.text()).toBe("名称,数量,价格\nA,1,2")
    expect(
      (await ctx.app.request(`/api/files/${byName["结果.csv"]!.id}`)).status
    ).toBe(401)

    // 用过的上传文件不能再用到别的运行里
    const reuse = await mutate(ctx.app, "engine.runNow", wang, {
      taskId,
      attachmentFileIds: [txt.id],
    })
    expect(reuse.error?.data?.code).toBe("BAD_REQUEST")
    // 去掉任务附件
    expect(
      (
        await mutate(ctx.app, "engine.detachFromTask", wang, {
          taskId,
          fileId: taskFile.id,
        })
      ).data
    ).toEqual({ ok: true })
    expect(
      (await query(ctx.app, "engine.taskAttachments", wang, { taskId })).data
    ).toEqual([])
  })
})

describe("其他接口", () => {
  it("立即继续：挂起等待中的 session 马上继续", async () => {
    useScript(
      "test/o1",
      new Script([
        step([call("session.wait", { what: "等明天", afterMinutes: 600 })]),
        step([text("提前继续，完成")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/o1" })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "waiting")
    expect(
      (await mutate(ctx.app, "engine.resumeNow", li, { sessionId })).error?.data
        ?.code
    ).toBe("FORBIDDEN")
    expect(
      (await mutate(ctx.app, "engine.resumeNow", wang, { sessionId })).data
    ).toEqual({ sessionId })
    await waitStatus(ctx.db, sessionId, "done")
    const [wait] = await ctx.db
      .select()
      .from(t.sessionWaits)
      .where(eq(t.sessionWaits.sessionId, sessionId))
    expect(wait!.firedCause).toBe("resume_now")
  })

  it("通知：列表、未读数、标已读；notify.staff 给指定的人发", async () => {
    useScript(
      "test/o2",
      new Script([
        step([
          call("notify.staff", {
            title: "请看一下结果",
            body: "在附件里",
            to: ["lijing@heyagent.local"],
          }),
        ]),
        step([text("已通知")]),
      ])
    )
    const taskId = await createTask(ctx.db, {
      modelId: "test/o2",
      toolIds: ["notify.staff"],
    })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "done")
    const list = await query(ctx.app, "engine.notifications.list", li)
    expect(list.data.items[0]).toMatchObject({
      title: "请看一下结果",
      body: "在附件里",
      sessionId,
    })
    expect(list.data.unread).toBeGreaterThanOrEqual(1)
    const marked = await mutate(ctx.app, "engine.notifications.markRead", li, {
      ids: [list.data.items[0].id],
    })
    expect(marked.data.updated).toBe(1)
    const all = await mutate(ctx.app, "engine.notifications.markRead", li, {})
    expect(all.data.updated).toBeGreaterThanOrEqual(0)
    expect(
      (await query(ctx.app, "engine.notifications.list", li)).data.unread
    ).toBe(0)
  })

  it("memory.propose、skill.propose、skill.load：进入待办等人审核", async () => {
    const [skill] = await ctx.db
      .select()
      .from(t.skills)
      .where(eq(t.skills.status, "published"))
      .limit(1)
    const newBody = `${skill!.body}\n\n## 新增的一段\n多核对一次。`
    const script = useScript(
      "test/o3",
      new Script([
        step([
          call("skill.load", { skill: skill!.id }),
          call("memory.propose", {
            content: "这位客户只要整箱发货",
            appliesTo: "客户偏好 · 测试客户",
            evidence: "chat",
          }),
          call("skill.propose", {
            skill: skill!.id,
            summary: "加一步核对",
            newBody,
          }),
        ]),
        step([text("提议好了")]),
      ])
    )
    const taskId = await createTask(ctx.db, {
      modelId: "test/o3",
      skillIds: [skill!.id],
      toolIds: ["skill.load", "memory.propose", "skill.propose"],
    })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "done")
    expect(script.promptText(1)).toContain(
      skill!.body.slice(0, 30).replace(/\n/g, "\\n")
    )
    const items = await ctx.db
      .select()
      .from(t.humanItems)
      .where(eq(t.humanItems.sessionId, sessionId))
    expect(items.map((item) => item.kind).sort()).toEqual(["memory", "skill"])
    const [memory] = await ctx.db
      .select()
      .from(t.memories)
      .where(eq(t.memories.sourceSessionId, sessionId))
    expect(memory).toMatchObject({
      status: "pending",
      sourceKind: "agent",
      sourceTaskId: taskId,
      reviewerId: "u-wang",
    })
    const [suggestion] = await ctx.db
      .select()
      .from(t.skillSuggestions)
      .where(eq(t.skillSuggestions.sessionId, sessionId))
    expect(
      suggestion!
        .diff!.filter((line) => line.variant === "added")
        .map((line) => line.text)
    ).toEqual(["", "## 新增的一段", "多核对一次。"])
    // 记忆、技能的审核不走引擎接口
    const memoryItem = items.find((item) => item.kind === "memory")!
    expect(
      (
        await mutate(ctx.app, "engine.resolveHumanItem", lin, {
          itemId: memoryItem.id,
          how: "approve",
        })
      ).error?.data?.code
    ).toBe("BAD_REQUEST")
  })

  it("lineDiff：默认和删除的行都是原文里的行，新增的行插在前一行后面", () => {
    const diff = lineDiff("a\nb\nc", "a\nB\nc\nd")
    expect(diff).toEqual([
      { variant: "default", text: "a" },
      { variant: "removed", text: "b" },
      { variant: "added", text: "B" },
      { variant: "default", text: "c" },
      { variant: "added", text: "d" },
    ])
  })

  it("停用的任务不能运行；内置工具已同步进 tools 表", async () => {
    const taskId = await createTask(ctx.db, {
      modelId: "test/none",
      enabled: false,
    })
    expect(
      (await mutate(ctx.app, "engine.runNow", wang, { taskId })).error?.data
        ?.code
    ).toBe("BAD_REQUEST")
    const builtin = await ctx.db
      .select()
      .from(t.tools)
      .where(eq(t.tools.source, "builtin"))
    expect(builtin.map((tool) => tool.id).sort()).toEqual([
      "ask.human",
      "browser",
      "checkpoint.mark",
      "file.read",
      "file.save",
      "memory.propose",
      "notify.staff",
      "plan.set",
      "session.wait",
      "skill.load",
      "skill.propose",
    ])
    expect(
      builtin
        .filter((tool) => tool.alwaysOn)
        .map((tool) => tool.id)
        .sort()
    ).toEqual(["ask.human", "checkpoint.mark", "plan.set", "session.wait"])
  })
})
