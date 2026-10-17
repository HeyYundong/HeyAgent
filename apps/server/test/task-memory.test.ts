// 任务记忆：负责人直接写、改、删；运行时放进系统提示；运行结束后三方 AI 总结、提取候选，人审核通过的记进任务记忆。
// 真实的测试库 + 进程内 worker + 假模型（执行、总结都按 model id 找剧本），不花钱、不连外网。
import { asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { digestLog } from "../src/engine/digest.js"
import { login, query } from "./helpers.js"
import {
  createTask,
  mutate,
  Script,
  sessionRow,
  setupEngine,
  step,
  text,
  useScript,
  waitStatus,
  type EngineTestContext,
} from "./engine-helpers.js"

let ctx: EngineTestContext
let lin: string // 主管
let wang: string // 员工，测试任务的负责人
let li: string // 另一个员工

// 执行模型和三方模型要不是同一家：qwen = 阿里通义，claude = Anthropic
const EXEC = "test/qwen-tm-exec"
const DIGEST = "test/claude-tm-digest"
const SAME = "test/qwen-tm-same"

const digestJson = (value: unknown) => step([text(JSON.stringify(value))], 0.003)

beforeAll(async () => {
  ctx = await setupEngine()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
  li = await login(ctx.app, "lijing@heyagent.local")
  await ctx.db.insert(t.models).values([
    { id: EXEC, providerId: "openrouter", name: "测试执行模型", contextK: 128 },
    { id: DIGEST, providerId: "openrouter", name: "测试三方模型", contextK: 128 },
    { id: SAME, providerId: "openrouter", name: "同一家的模型", contextK: 128 },
  ])
}, 120_000)

afterAll(async () => {
  await ctx?.stop()
})

async function runToDone(taskId: string, script: Script) {
  useScript(EXEC, script)
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
  if (!res.data) throw new Error(`runNow 失败：${JSON.stringify(res.error)}`)
  const sessionId = res.data.sessionId as string
  await waitStatus(ctx.db, sessionId, "done")
  return sessionId
}

const entriesOf = (taskId: string) =>
  ctx.db.select().from(t.taskMemoryEntries).where(eq(t.taskMemoryEntries.taskId, taskId)).orderBy(asc(t.taskMemoryEntries.id))

describe("任务记忆：写、改、删和权限", () => {
  it("负责人和主管能写、改、删，别的员工不能；空的不能存；任务删了记忆一起删", async () => {
    const taskId = await createTask(ctx.db, { modelId: EXEC })
    const added = await mutate(ctx.app, "taskMemory.add", wang, { taskId, content: "  报表要按日期倒序  " })
    expect(added.error).toBeUndefined()
    const byAdmin = await mutate(ctx.app, "taskMemory.add", lin, { taskId, content: "先登录再搜索" })
    expect(byAdmin.error).toBeUndefined()
    expect((await mutate(ctx.app, "taskMemory.add", li, { taskId, content: "别人加的" })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "taskMemory.add", wang, { taskId, content: "   " })).error?.data?.code).toBe("BAD_REQUEST")

    const list = await query(ctx.app, "taskMemory.list", li, { taskId })
    expect(list.data).toMatchObject([
      { id: added.data.id, taskId, content: "报表要按日期倒序", createdById: "u-wang" },
      { id: byAdmin.data.id, content: "先登录再搜索", createdById: "u-lin" },
    ])
    expect(list.data[0].sourceSessionId).toBeUndefined()

    expect((await mutate(ctx.app, "taskMemory.update", li, { id: added.data.id, content: "改掉" })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "taskMemory.update", wang, { id: added.data.id, content: "报表按日期倒序，最新的在最上面" })).error).toBeUndefined()
    expect((await mutate(ctx.app, "taskMemory.delete", li, { id: byAdmin.data.id })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "taskMemory.delete", wang, { id: byAdmin.data.id })).error).toBeUndefined()
    expect((await mutate(ctx.app, "taskMemory.delete", wang, { id: 999_999 })).error?.data?.code).toBe("NOT_FOUND")
    expect((await entriesOf(taskId)).map((row) => row.content)).toEqual(["报表按日期倒序，最新的在最上面"])

    const audits = await ctx.db.select().from(t.auditEvents).where(eq(t.auditEvents.targetId, taskId))
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining(["task_memory.add", "task_memory.update", "task_memory.delete"]))

    // 没运行过的任务可以删，记忆跟着删
    expect((await mutate(ctx.app, "tasks.delete", wang, { id: taskId })).error).toBeUndefined()
    expect(await entriesOf(taskId)).toEqual([])
  })
})

describe("运行时：任务记忆放进系统提示", () => {
  it("每次运行开始时冻结进快照，系统提示里有「任务记忆」一节；没有记忆就没有这一节", async () => {
    const taskId = await createTask(ctx.db, { modelId: EXEC })
    const empty = new Script([step([text("做完了")])])
    const first = await runToDone(taskId, empty)
    expect((await sessionRow(ctx.db, first))!.snapshot!.taskMemory).toEqual([])
    expect(JSON.stringify(empty.prompts[0]!.prompt[0])).not.toContain("## 任务记忆")

    await mutate(ctx.app, "taskMemory.add", wang, { taskId, content: "登录页在右上角" })
    await mutate(ctx.app, "taskMemory.add", wang, { taskId, content: "导出按钮要等表格加载完" })
    const script = new Script([step([text("做完了")])])
    const second = await runToDone(taskId, script)
    expect((await sessionRow(ctx.db, second))!.snapshot!.taskMemory).toEqual(["登录页在右上角", "导出按钮要等表格加载完"])
    const system = JSON.stringify(script.prompts[0]!.prompt[0])
    expect(system).toContain("## 任务记忆")
    expect(system).toContain("- 登录页在右上角\\n- 导出按钮要等表格加载完")
  })
})

describe("运行结束后：三方 AI 总结、提取候选，人审核", () => {
  let taskId: string
  let sessionId: string

  beforeAll(async () => {
    taskId = await createTask(ctx.db, { modelId: EXEC, title: "整理每日报表", goal: "导出报表并存成文件" })
    await mutate(ctx.app, "taskMemory.add", wang, { taskId, content: "报表在「数据」菜单下" })
    sessionId = await runToDone(taskId, new Script([step([text("报表导出好了，第一次点导出没反应，刷新后才成功。")])]))
  })

  it("不是负责人不能总结；验收模型和执行模型同一家的不能总结", async () => {
    expect((await mutate(ctx.app, "taskMemory.summarize", li, { sessionId })).error?.data?.code).toBe("FORBIDDEN")
    await ctx.db.update(t.tasks).set({ verifyModelId: SAME }).where(eq(t.tasks.id, taskId))
    const res = await mutate(ctx.app, "taskMemory.summarize", wang, { sessionId })
    expect(res.error?.data?.code).toBe("BAD_REQUEST")
    expect(res.error?.message).toContain("同一家")
  })

  it("总结：结果存在运行上，候选去掉空的、重复的和已有的，花费记到这次运行上", async () => {
    // 任务没选验收模型：用默认验收模型
    await ctx.db.update(t.tasks).set({ verifyModelId: null }).where(eq(t.tasks.id, taskId))
    await ctx.db.update(t.modelDefaults).set({ modelId: DIGEST }).where(eq(t.modelDefaults.role, "verify"))
    const script = useScript(
      DIGEST,
      new Script([
        digestJson({
          summary: "导出了报表。第一次点导出没反应，刷新页面后成功。",
          memories: [
            { text: "点导出没反应时先刷新页面再点", reason: "第一次导出失败，刷新后成功" },
            { text: "报表在「数据」菜单下", reason: "已有" },
            { text: "  ", reason: "空的" },
            { text: "点导出没反应时 先刷新页面再点", reason: "重复" },
            { text: "导出的文件名带上日期", reason: "最终答复里提到" },
          ],
        }),
      ])
    )
    const before = (await sessionRow(ctx.db, sessionId))!
    const res = await mutate(ctx.app, "taskMemory.summarize", wang, { sessionId })
    expect(res.error).toBeUndefined()
    expect(res.data).toMatchObject({
      modelId: DIGEST,
      byId: "u-wang",
      summary: "导出了报表。第一次点导出没反应，刷新页面后成功。",
      candidates: [
        { text: "点导出没反应时先刷新页面再点", reason: "第一次导出失败，刷新后成功", status: "pending" },
        { text: "导出的文件名带上日期", reason: "最终答复里提到", status: "pending" },
      ],
      costUsd: 0.003,
    })
    // 给三方模型的材料：任务、现有记忆、过程（含最终答复）
    const prompt = script.promptText(0)
    expect(prompt).toContain("整理每日报表")
    expect(prompt).toContain("## 现有的任务记忆（不要重复）")
    expect(prompt).toContain("报表在「数据」菜单下")
    expect(prompt).toContain("第一次点导出没反应，刷新后才成功")
    expect(JSON.stringify(script.prompts[0]!.prompt[0])).toContain("三方复盘员")

    const after = (await sessionRow(ctx.db, sessionId))!
    expect(after.status).toBe("done")
    expect(after.costUsd).toBeCloseTo(before.costUsd + 0.003, 6)
    expect(after.tokensIn).toBe(before.tokensIn + 100)
    const run = await query(ctx.app, "sessions.get", li, { id: sessionId })
    expect(run.data.digest).toMatchObject({ modelId: DIGEST, candidates: [{ status: "pending" }, { status: "pending" }] })
    // 只是候选：还没记进任务记忆
    expect((await entriesOf(taskId)).map((row) => row.content)).toEqual(["报表在「数据」菜单下"])
  })

  it("审核：采用的（可以改字）记进任务记忆并标明来源，不要的标为没采用；处理完的不能再处理", async () => {
    expect((await mutate(ctx.app, "taskMemory.review", li, { sessionId, items: [{ index: 0, accept: true, text: "x" }] })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "taskMemory.review", wang, { sessionId, items: [{ index: 0, accept: true, text: " " }] })).error?.data?.code).toBe("BAD_REQUEST")
    expect((await mutate(ctx.app, "taskMemory.review", wang, { sessionId, items: [{ index: 5, accept: false, text: "" }] })).error?.data?.code).toBe("BAD_REQUEST")

    // 先只处理第一条：采用，改一下文字
    const first = await mutate(ctx.app, "taskMemory.review", wang, { sessionId, items: [{ index: 0, accept: true, text: "点「导出」没反应时，先刷新页面再点" }] })
    expect(first.error).toBeUndefined()
    expect(first.data).toEqual({ accepted: 1, rejected: 0 })
    let digest = (await sessionRow(ctx.db, sessionId))!.digest!
    expect(digest.candidates.map((candidate) => candidate.status)).toEqual(["accepted", "pending"])
    expect(digest.reviewedAt).toBeUndefined()

    const second = await mutate(ctx.app, "taskMemory.review", lin, { sessionId, items: [{ index: 1, accept: false, text: "导出的文件名带上日期" }] })
    expect(second.data).toEqual({ accepted: 0, rejected: 1 })
    digest = (await sessionRow(ctx.db, sessionId))!.digest!
    expect(digest.candidates).toMatchObject([
      { text: "点「导出」没反应时，先刷新页面再点", status: "accepted" },
      { text: "导出的文件名带上日期", status: "rejected" },
    ])
    expect(digest.reviewedById).toBe("u-lin")
    expect(digest.reviewedAt).toBeDefined()

    const entries = await entriesOf(taskId)
    expect(entries.map((row) => row.content)).toEqual(["报表在「数据」菜单下", "点「导出」没反应时，先刷新页面再点"])
    expect(entries[1]).toMatchObject({ sourceSessionId: sessionId, createdById: "u-wang" })
    expect(digest.candidates[0]!.entryId).toBe(entries[1]!.id)

    const again = await mutate(ctx.app, "taskMemory.review", wang, { sessionId, items: [{ index: 1, accept: true, text: "改主意了" }] })
    expect(again.error?.data?.code).toBe("CONFLICT")
    const audits = await ctx.db.select().from(t.auditEvents).where(eq(t.auditEvents.action, "task_memory.review"))
    expect(audits.at(-1)!.detail).toMatchObject({ sessionId, rejected: 1 })
  })

  it("下一次运行读到审核通过的那条", async () => {
    const script = new Script([step([text("做完了")])])
    await runToDone(taskId, script)
    expect(JSON.stringify(script.prompts[0]!.prompt[0])).toContain("点「导出」没反应时，先刷新页面再点")
  })

  it("没结束的运行不能总结；没有验收模型时说清楚", async () => {
    const running = `${sessionId}-x`
    await ctx.db.insert(t.sessions).values({ id: running, taskId, status: "waiting", modelId: EXEC, startedAt: new Date() })
    const res = await mutate(ctx.app, "taskMemory.summarize", wang, { sessionId: running })
    expect(res.error?.data?.code).toBe("BAD_REQUEST")
    expect(res.error?.message).toContain("还没结束")

    await ctx.db.delete(t.modelDefaults).where(eq(t.modelDefaults.role, "verify"))
    const missing = await mutate(ctx.app, "taskMemory.summarize", wang, { sessionId })
    expect(missing.error?.message).toContain("没有默认验收模型")
  })
})

describe("过程记录给三方模型时的长度", () => {
  const event = (n: number, size = 100) => ({ kind: "think", title: `第 ${n} 步`, detail: "字".repeat(size), toolId: null, input: null, output: null })

  it("不超预算原样给；超了留开头和结尾，中间写明省略了几条", () => {
    expect(digestLog([event(1), event(2)], 10_000)).toHaveLength(2)
    const lines = digestLog(Array.from({ length: 100 }, (_, index) => event(index + 1)), 2_000)
    const marker = lines.findIndex((line) => line.includes("省略"))
    expect(marker).toBeGreaterThan(0)
    expect(lines[0]).toContain("第 1 步")
    expect(lines.at(-1)).toContain("第 100 步")
    expect(lines.join("\n").length).toBeLessThan(2_200)
    expect(lines[marker]).toContain(`中间 ${100 - lines.length + 1} 条省略`)
  })
})
