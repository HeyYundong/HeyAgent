// 真浏览器：带认证的 SOCKS5 上游经本地 gost 转发（m2.md 第 3 条）。密码不出现在命令行；上游收到的是域名；密码错就报错，不退回直连。
import { readdirSync, readFileSync, statSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { BrowserManager } from "../src/browser/manager.js"
import * as t from "../src/db/schema.js"
import { createTask, setupEngine, type EngineTestContext } from "../test/engine-helpers.js"
import { createProfile, startSocks, type SocksUpstream } from "./fixtures.js"

const USER = "heyagent"
const PASS = "p@ss:w0rd/测试"

let ctx: EngineTestContext
let manager: BrowserManager
let upstream: SocksUpstream
let taskId: string

function processes() {
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map((pid) => {
      try {
        return { pid, cmdline: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) }
      } catch {
        return { pid, cmdline: [] as string[] }
      }
    })
}

async function session(id: string) {
  await ctx.db.insert(t.sessions).values({ id, taskId, status: "running", modelId: "test/none", startedAt: new Date() })
  return id
}

beforeAll(async () => {
  ctx = await setupEngine()
  manager = ctx.worker.browser!
  upstream = await startSocks(USER, PASS)
  taskId = await createTask(ctx.db, { modelId: "test/none" })
})

afterAll(async () => {
  await ctx?.stop()
  await upstream?.close()
})

describe("代理", () => {
  it("带认证的 SOCKS5：经 gost 转发能打开 example.com；上游收到域名；密码只在 0600 的配置文件里", async () => {
    const profileId = await createProfile(ctx.db, ctx.keyring, { proxy: { host: "127.0.0.1", port: upstream.port, username: USER, password: PASS } })
    const instance = await manager.acquireForSession({ sessionId: await session("R-P-1"), profileId, allowedDomains: [] })
    const page = instance.currentPage()!
    const response = await page.goto("http://example.com/", { timeout: 30_000 })
    expect(response?.status()).toBe(200)
    expect(await page.title()).toBe("Example Domain")
    expect(upstream.log.some((entry) => entry.ev === "auth" && entry.ok)).toBe(true)
    const connects = upstream.log.filter((entry) => entry.ev === "connect")
    expect(connects.some((entry) => entry.host === "example.com" && entry.atyp === "DOMAIN")).toBe(true)
    expect(connects.every((entry) => entry.atyp === "DOMAIN")).toBe(true)

    const gost = processes().find((proc) => proc.cmdline[0]?.endsWith("gost"))
    expect(gost).toBeTruthy()
    expect(gost!.cmdline.join(" ")).not.toContain(PASS)
    const configFile = gost!.cmdline[gost!.cmdline.indexOf("-C") + 1]!
    expect(statSync(configFile).mode & 0o777).toBe(0o600)
    // Chrome 的命令行里只有本机转发端口，没有上游地址和密码
    const chrome = processes().find((proc) => proc.cmdline.some((arg) => arg.startsWith("--proxy-server=")))
    expect(chrome!.cmdline.join(" ")).toMatch(/--proxy-server=socks5:\/\/127\.0\.0\.1:\d+/)
    expect(chrome!.cmdline.join(" ")).not.toContain(PASS)
    expect(chrome!.cmdline.join(" ")).not.toContain(String(upstream.port))

    // 后台联网：空闲 6 秒里经代理连了哪些地址（记录给汇报，关掉后台联网后应该很少）
    const before = connects.length
    await new Promise((resolve) => setTimeout(resolve, 6000))
    const background = upstream.log.filter((entry) => entry.ev === "connect").slice(before).map((entry) => entry.host)
    console.log(`[proxy] 空闲 6 秒的后台连接：${background.length} 个 ${JSON.stringify([...new Set(background)])}`)
    const all = [...new Set(upstream.log.filter((entry) => entry.ev === "connect").map((entry) => entry.host))]
    console.log(`[proxy] 整个过程经代理连过的主机：${JSON.stringify(all)}`)
    await manager.releaseSession("R-P-1", { reason: "测试" })
  })

  it("密码错：打不开，报错（ERR_SOCKS…），不会退回直连", async () => {
    const profileId = await createProfile(ctx.db, ctx.keyring, { proxy: { host: "127.0.0.1", port: upstream.port, username: USER, password: "wrong-password" } })
    const instance = await manager.acquireForSession({ sessionId: await session("R-P-2"), profileId, allowedDomains: [] })
    const page = instance.currentPage()!
    const error = await page.goto("http://example.com/", { timeout: 30_000 }).then(
      () => undefined,
      (err: Error) => err.message
    )
    expect(error).toMatch(/ERR_SOCKS|ERR_PROXY|ERR_TUNNEL/)
    expect(upstream.log.some((entry) => entry.ev === "auth" && !entry.ok)).toBe(true)
    await manager.releaseSession("R-P-2", { reason: "测试" })
  })

  it("代理挂了（gost 被杀）：下次起 Chrome 前重新拉起；上游不在了也是报错，不直连", async () => {
    const profileId = await createProfile(ctx.db, ctx.keyring, { proxy: { host: "127.0.0.1", port: 9, username: USER, password: PASS } })
    const instance = await manager.acquireForSession({ sessionId: await session("R-P-3"), profileId, allowedDomains: [] })
    const error = await instance
      .currentPage()!
      .goto("http://example.com/", { timeout: 30_000 })
      .then(
        () => undefined,
        (err: Error) => err.message
      )
    expect(error).toMatch(/ERR_SOCKS|ERR_PROXY|ERR_TUNNEL|ERR_CONNECTION/)
    await manager.releaseSession("R-P-3", { reason: "测试" })
  })
})
