// 会话页的一页（sessions.page）：标签、各标签个数、搜索、只看等我处理（主管 / 员工）、翻页和总数、排序（开始 / 结束、正序 / 倒序、空的在最后）、已结束的办成 / 没办成。
// 期望值从 sessions.list（全部摘要）和 todos.board（没处理的事）按同样的规则算，不写死演示数据的个数。
import { groupOf, outcomeOf, sessionGroups, type HumanItem, type SessionSummary } from "@heyagent/shared"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { notifyAssignee } from "../src/engine/humans.js"
import { humanItemLink } from "../src/engine/notify.js"
import { login, query, setupApp, type TestApp } from "./helpers.js"

let ctx: TestApp
let lin: string
let wang: string
let all: SessionSummary[]
let items: HumanItem[]

/** 和服务端一样的顺序：开始时间新的在前，同一时间按编号倒序 */
const byStart = (a: SessionSummary, b: SessionSummary) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)
const ids = (list: { id: string }[]) => list.map((each) => each.id)

beforeAll(async () => {
  ctx = await setupApp()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
  all = (await query(ctx.app, "sessions.list", lin)).data
  items = (await query(ctx.app, "todos.board", lin)).data.humanItems
})
afterAll(async () => {
  await ctx?.close()
})

describe("sessions.page", () => {
  it("不登录不能看；员工也能看", async () => {
    expect((await query(ctx.app, "sessions.page", undefined, { group: "running" })).status).toBe(401)
    expect((await query(ctx.app, "sessions.page", wang, { group: "ended" })).data.total).toBeGreaterThan(0)
  })

  it("每个标签只列这一组状态，按开始时间倒序；各标签个数和 groupOf 分组一致", async () => {
    const expected = Object.fromEntries(sessionGroups.map((group) => [group.id, all.filter((run) => groupOf(run) === group.id).length]))
    for (const { id: group } of sessionGroups) {
      const page = (await query(ctx.app, "sessions.page", lin, { group, pageSize: 200 })).data
      expect(page.counts).toEqual(expected)
      expect(page.total, group).toBe(expected[group])
      expect(ids(page.items), group).toEqual(ids(all.filter((run) => groupOf(run) === group).sort(byStart)))
    }
    // 已结束 = 已结束、没完成、出错
    expect(expected.ended).toBe(all.filter((run) => ["done", "incomplete", "failed"].includes(run.status)).length)
  })

  it("摘要的形状和 sessions.list 一样", async () => {
    const page = (await query(ctx.app, "sessions.page", lin, { group: "human" })).data
    expect(page.items.length).toBeGreaterThan(0)
    for (const run of page.items) expect(run).toEqual(all.find((each) => each.id === run.id))
  })

  it("翻页：一页几个、总数、第几页；超出的页给最后一页", async () => {
    const ended = all.filter((run) => groupOf(run) === "ended").sort(byStart)
    expect(ended.length).toBeGreaterThanOrEqual(3)
    const first = (await query(ctx.app, "sessions.page", lin, { group: "ended", pageSize: 2 })).data
    expect(first).toMatchObject({ total: ended.length, page: 1, pageSize: 2 })
    expect(ids(first.items)).toEqual(ids(ended.slice(0, 2)))
    const second = (await query(ctx.app, "sessions.page", lin, { group: "ended", pageSize: 2, page: 2 })).data
    expect(ids(second.items)).toEqual(ids(ended.slice(2, 4)))
    const last = Math.ceil(ended.length / 2)
    const beyond = (await query(ctx.app, "sessions.page", lin, { group: "ended", pageSize: 2, page: 99 })).data
    expect(beyond.page).toBe(last)
    expect(ids(beyond.items)).toEqual(ids(ended.slice((last - 1) * 2, last * 2)))
    expect((await query(ctx.app, "sessions.page", lin, { group: "ended", pageSize: 0 })).status).toBe(400)
  })

  it("搜索：session 编号（不分大小写）、任务编号、任务名；% _ 当普通字符；个数跟着搜索变", async () => {
    const run = all.find((each) => groupOf(each) === "ended")!
    const byId = (await query(ctx.app, "sessions.page", lin, { group: "ended", q: run.id.toLowerCase() })).data
    expect(ids(byId.items)).toContain(run.id)
    const byTask = (await query(ctx.app, "sessions.page", lin, { group: "ended", q: run.taskId, pageSize: 200 })).data
    expect(ids(byTask.items)).toEqual(ids(all.filter((each) => groupOf(each) === "ended" && each.taskId.includes(run.taskId)).sort(byStart)))
    const [task] = await ctx.db.select({ title: t.tasks.title }).from(t.tasks).where(eq(t.tasks.id, run.taskId))
    const byTitle = (await query(ctx.app, "sessions.page", lin, { group: "ended", q: task!.title.slice(0, 4), pageSize: 200 })).data
    expect(ids(byTitle.items)).toContain(run.id)
    const percent = (await query(ctx.app, "sessions.page", lin, { group: "ended", q: "%" })).data
    expect(percent.total).toBe(0)
    expect(Object.values(percent.counts).every((n) => n === 0)).toBe(true)
  })

  it("按任务、来源、结果筛：结果和 outcomeOf 一样（没记结果的出错算没办成）", async () => {
    const run = all[0]!
    const byTask = (await query(ctx.app, "sessions.page", lin, { group: groupOf(run), taskId: run.taskId, pageSize: 200 })).data
    expect(ids(byTask.items)).toEqual(ids(all.filter((each) => groupOf(each) === groupOf(run) && each.taskId === run.taskId).sort(byStart)))
    const notAchieved = (await query(ctx.app, "sessions.page", lin, { group: "ended", outcome: "not_achieved", pageSize: 200 })).data
    expect(ids(notAchieved.items)).toEqual(ids(all.filter((each) => groupOf(each) === "ended" && outcomeOf(each) === "not_achieved").sort(byStart)))
    const manual = (await query(ctx.app, "sessions.page", lin, { group: "ended", source: "manual", pageSize: 200 })).data
    expect(ids(manual.items)).toEqual(ids(all.filter((each) => groupOf(each) === "ended" && each.source === "manual").sort(byStart)))
  })

  it("只看等我处理：等人处理、有挡住它的事是我的——主管算全部，员工只算分给自己的", async () => {
    const blocking = (assignee?: string) =>
      all
        .filter((run) => run.status === "needs_human" && items.some((item) => item.runId === run.id && ["approval", "verify", "login"].includes(item.kind) && (!assignee || item.assigneeId === assignee)))
        .sort(byStart)
    const admin = (await query(ctx.app, "sessions.page", lin, { group: "ended", mine: true, pageSize: 200 })).data
    expect(ids(admin.items)).toEqual(ids(blocking()))
    expect(admin.items.length).toBeGreaterThan(0)
    const staff = (await query(ctx.app, "sessions.page", wang, { group: "ended", mine: true, pageSize: 200 })).data
    expect(ids(staff.items)).toEqual(ids(blocking("u-wang")))
    // 各标签个数不算「只看等我处理」
    expect(staff.counts.human).toBe(all.filter((run) => run.status === "needs_human").length)
  })

  it("排序：按开始 / 结束时间、正序 / 倒序，没结束的（结束时间空）总在最后，同一时间按编号同方向排", async () => {
    const cmp = (key: "startedAt" | "endedAt", dir: 1 | -1) => (a: SessionSummary, b: SessionSummary) => {
      const x = a[key] ?? null
      const y = b[key] ?? null
      if (x === null || y === null) return x === y ? dir * a.id.localeCompare(b.id) : x === null ? 1 : -1
      return dir * (x.localeCompare(y) || a.id.localeCompare(b.id))
    }
    // 「只看等我处理」之外，各标签里都排一遍（执行中的结束时间都是空的）
    for (const { id: group } of sessionGroups) {
      const list = all.filter((run) => groupOf(run) === group)
      for (const [sort, key] of [["started", "startedAt"], ["ended", "endedAt"]] as const) {
        for (const [dir, sign] of [["asc", 1], ["desc", -1]] as const) {
          const page = (await query(ctx.app, "sessions.page", lin, { group, sort, dir, pageSize: 200 })).data
          expect(ids(page.items), `${group} ${sort} ${dir}`).toEqual(ids([...list].sort(cmp(key, sign))))
        }
      }
    }
    // 已结束、却没记结束时间的（老数据）：正序、倒序都排在最后
    const ended = all.filter((run) => groupOf(run) === "ended")
    const victim = ended[0]!
    await ctx.db.update(t.sessions).set({ endedAt: null }).where(eq(t.sessions.id, victim.id))
    try {
      for (const dir of ["asc", "desc"] as const) {
        const page = (await query(ctx.app, "sessions.page", lin, { group: "ended", sort: "ended", dir, pageSize: 200 })).data
        const items = page.items as SessionSummary[]
        const firstNull = items.findIndex((run) => !run.endedAt)
        expect(items.slice(firstNull).every((run) => !run.endedAt), dir).toBe(true)
        expect(ids(items.slice(firstNull)), dir).toContain(victim.id)
        expect(items).toHaveLength(ended.length)
      }
    } finally {
      await ctx.db.update(t.sessions).set({ endedAt: victim.endedAt ? new Date(victim.endedAt) : null }).where(eq(t.sessions.id, victim.id))
    }
    expect((await query(ctx.app, "sessions.page", lin, { group: "ended", sort: "nope" })).status).toBe(400)
  })

  it("已结束的办成、没办成：和 outcomeOf 一样（没记结果的出错算没办成，复核中两边都不算），跟着来源、任务、结果、搜索变", async () => {
    const count = (list: SessionSummary[]) => ({
      achieved: list.filter((run) => groupOf(run) === "ended" && outcomeOf(run) === "achieved").length,
      notAchieved: list.filter((run) => groupOf(run) === "ended" && outcomeOf(run) === "not_achieved").length,
    })
    const page = (await query(ctx.app, "sessions.page", lin, { group: "running" })).data
    expect(page.endedOutcome).toEqual(count(all))
    expect(page.endedOutcome.achieved + page.endedOutcome.notAchieved).toBeGreaterThan(0)
    const run = all.find((each) => groupOf(each) === "ended")!
    const byTask = (await query(ctx.app, "sessions.page", lin, { group: "ended", taskId: run.taskId })).data
    expect(byTask.endedOutcome).toEqual(count(all.filter((each) => each.taskId === run.taskId)))
    const manual = (await query(ctx.app, "sessions.page", lin, { group: "ended", source: "manual" })).data
    expect(manual.endedOutcome).toEqual(count(all.filter((each) => each.source === "manual")))
    const onlyBad = (await query(ctx.app, "sessions.page", lin, { group: "ended", outcome: "not_achieved" })).data
    expect(onlyBad.endedOutcome).toEqual({ achieved: 0, notAchieved: count(all).notAchieved })
    // 「只看等我处理」不影响
    expect((await query(ctx.app, "sessions.page", lin, { group: "ended", mine: true })).data.endedOutcome).toEqual(count(all))

    // 复核中（已结束、还没结果）两边都不算：拿一次已结束的运行，先记办成，再把结果清空
    const victim = all.find((each) => each.status === "done")!
    const ended = async () => (await query(ctx.app, "sessions.page", lin, { group: "ended" })).data.endedOutcome
    try {
      await ctx.db.update(t.sessions).set({ outcome: "achieved" }).where(eq(t.sessions.id, victim.id))
      const before = await ended()
      await ctx.db.update(t.sessions).set({ outcome: null }).where(eq(t.sessions.id, victim.id))
      expect(await ended()).toEqual({ achieved: before.achieved - 1, notAchieved: before.notAchieved })
    } finally {
      await ctx.db.update(t.sessions).set({ outcome: victim.outcome ?? null }).where(eq(t.sessions.id, victim.id))
    }
  })

  it("今天的花费：今天开始的运行加起来", async () => {
    const page = (await query(ctx.app, "sessions.page", lin, { group: "running" })).data
    expect(typeof page.spentToday).toBe("number")
    expect(page.spentToday).toBeGreaterThanOrEqual(0)
  })
})

describe("「等你处理」通知的链接：会话页「等人处理」", () => {
  it("挡住运行的事带运行编号，记忆审核、技能修改带这件事的编号", async () => {
    expect(humanItemLink()).toBe("#/sessions?status=human")
    await notifyAssignee(ctx.db as never, { id: "ap-x", kind: "approval", title: "审批 x", summary: "s", assigneeId: "u-wang", taskId: "T-1024", sessionId: "R-1024-1" })
    await notifyAssignee(ctx.db as never, { id: "m-x", kind: "memory", title: "记忆 x", summary: "s", assigneeId: "u-wang", taskId: "T-1024", sessionId: "R-1024-1" })
    const rows = await ctx.db.select({ title: t.notifications.title, link: t.notifications.link }).from(t.notifications).where(eq(t.notifications.userId, "u-wang"))
    expect(rows.find((row) => row.title === "等你处理：审批 x")?.link).toBe("#/sessions?status=human&id=R-1024-1")
    expect(rows.find((row) => row.title === "等你处理：记忆 x")?.link).toBe("#/sessions?status=human&id=m-x")
  })
})
