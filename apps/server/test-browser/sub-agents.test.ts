// 子 agent 抢 Chrome（docs/dev/sub-agents.md 6.3、第 13 节「名额」）：真浏览器 + 假模型。
// 任务只允许 1 个 Chrome，拆 2 个都要用浏览器的子 agent：一个拿到 Chrome，另一个「等待浏览器」、照样占着子 agent 名额；
// 前一个做完放开 Chrome，后一个接着做完，父运行只被叫醒一次。
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { startSessionImpl } from "../src/engine/sessions.js"
import { listSubagents } from "../src/engine/subagents/view.js"
import { call, createTask, eventsOf, finishWith, Script, sessionRow, setupEngine, step, useScript, waitFor, waitStatus, type CallOptions, type EngineTestContext } from "../test/engine-helpers.js"
import { createProfile, startSite, type TestSite } from "./fixtures.js"

let ctx: EngineTestContext
let site: TestSite
let profileId: string

beforeAll(async () => {
  ctx = await setupEngine()
  site = await startSite()
  profileId = await createProfile(ctx.db, ctx.keyring)
}, 120_000)

afterAll(async () => {
  release()
  await ctx?.stop()
  await site?.close()
})

let release!: () => void
const firstMayFinish = new Promise<void>((resolve) => (release = resolve))

const titleOf = (options: CallOptions) => /子目标「([^」]+)」/.exec(JSON.stringify(options.prompt))?.[1] ?? ""
const turnOf = (options: CallOptions) => options.prompt.filter((message) => message.role === "tool").length

describe("子 agent 抢 Chrome", () => {
  it("只允许 1 个 Chrome：一个在用，另一个等待浏览器（占名额），空出来接着做；父只叫醒一次", async () => {
    useScript(
      "test/sub-browser-child",
      new Script(
        Array.from({ length: 50 }, () => async (options: CallOptions) => {
          const title = titleOf(options)
          if (turnOf(options) === 0) return step([call("browser.navigate", { url: site.url("127.0.0.1", "/hello") })])
          // 拿到 Chrome 的那个卡着，直到测试看到另一个在等待浏览器
          await firstMayFinish
          return step(finishWith(`打开了页面：${title}`))
        })
      )
    )
    const parent = useScript(
      "test/sub-browser-parent",
      new Script([
        step([call("subagent.start", { items: [{ title: "甲", goal: "打开页面" }, { title: "乙", goal: "打开页面" }] })]),
        step([call("subagent.wait", {})]),
        step(finishWith("两个都打开了")),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/sub-browser-parent", toolIds: ["browser", "subagent.start"] })
    await ctx.db.update(t.tasks).set({ browserProfileIds: [profileId], subagentModelId: "test/sub-browser-child" }).where(eq(t.tasks.id, taskId))
    const { sessionId } = await startSessionImpl(ctx.db, { taskId, source: "manual" })
    // 父运行的系统提示写了只有 1 个 Chrome
    await waitFor(async () => parent.prompts.length >= 1, { what: "父运行开始" })
    expect(parent.promptText(0)).toContain("本任务只允许 1 个 Chrome，所以用浏览器的子 agent 只能一个一个做")
    // 甲拿到 Chrome、卡着；乙等待浏览器，占着名额
    const rows = await waitFor(
      async () => {
        const list = await listSubagents(ctx.db, sessionId)
        return list.length === 2 && list.some((row) => row.state === "running") && list.some((row) => row.state === "waiting" && row.waitingWhat?.includes("等待浏览器")) ? list : undefined
      },
      { what: "一个在跑、一个等待浏览器", timeout: 90_000 }
    )
    expect(rows.map((row) => row.state).sort()).toEqual(["running", "waiting"])
    expect((await sessionRow(ctx.db, sessionId))!.status).toBe("waiting")
    release()
    await waitStatus(ctx.db, `${sessionId}.1`, "done", 90_000)
    await waitStatus(ctx.db, `${sessionId}.2`, "done", 90_000)
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    expect(parent.promptText(2)).toContain("子 agent 都结束了（2 个：办成 2，没办成 0）")
    const resumes = (await eventsOf(ctx.db, sessionId)).filter((event) => event.kind === "resume")
    expect(resumes).toHaveLength(1)
    // 等过浏览器的那一个被叫醒过
    const waited = [...(await eventsOf(ctx.db, `${sessionId}.1`)), ...(await eventsOf(ctx.db, `${sessionId}.2`))]
    expect(waited.some((event) => event.kind === "resume" && event.title.includes("等到浏览器"))).toBe(true)
  }, 300_000)
})
