import { describe, expect, it } from "vitest"

import { browserActionLabel, browserActionTag, domainSchema, groupBrowserActions, hostMatches, normalizeDomain, taskInputSchema, urlAllowed, viewerClientMessageSchema } from "../src/index.js"

describe("域名", () => {
  it("规整用户填的域名", () => {
    expect(normalizeDomain("https://Shop.Example.com/a?b")).toBe("shop.example.com")
    expect(normalizeDomain("*.example.com")).toBe("example.com")
    expect(normalizeDomain(".example.com")).toBe("example.com")
    expect(normalizeDomain("192.168.31.100:5191")).toBe("192.168.31.100")
    expect(normalizeDomain("localhost")).toBe("localhost")
    expect(normalizeDomain("not a domain")).toBeUndefined()
    expect(normalizeDomain("")).toBeUndefined()
  })

  it("子域名也算", () => {
    expect(hostMatches("example.com", "example.com")).toBe(true)
    expect(hostMatches("www.example.com", "example.com")).toBe(true)
    expect(hostMatches("badexample.com", "example.com")).toBe(false)
    expect(hostMatches("example.com.evil.net", "example.com")).toBe(false)
  })

  it("白名单：空 = 不限制；只放 http(s) 和空白页", () => {
    expect(urlAllowed("https://anything.test/", []).ok).toBe(true)
    expect(urlAllowed("about:blank", ["example.com"]).ok).toBe(true)
    expect(urlAllowed("https://en.wikipedia.org/wiki/X", ["wikipedia.org"]).ok).toBe(true)
    const blocked = urlAllowed("https://other.test/", ["example.com"])
    expect(blocked.ok).toBe(false)
    expect(!blocked.ok && blocked.reason).toContain("other.test")
    expect(urlAllowed("file:///etc/passwd", []).ok).toBe(false)
    expect(urlAllowed("chrome://settings", []).ok).toBe(false)
  })

  it("schema 校验并规整", () => {
    expect(domainSchema.parse("HTTPS://Example.COM/x")).toBe("example.com")
    expect(domainSchema.safeParse("??").success).toBe(false)
    const task = taskInputSchema.parse({ title: "t", goal: "g", steps: [], schedule: null, allowedDomains: ["https://A.example.com"] })
    expect(task.allowedDomains).toEqual(["a.example.com"])
    expect(task.browserProfileIds).toEqual([])
    expect(task.allowBrowserEvaluate).toBe(false)
    expect(task.allowBrowserVision).toBe(false)
  })
})

describe("远程画面消息", () => {
  it("认识的消息通过，不认识的丢掉", () => {
    expect(viewerClientMessageSchema.safeParse({ t: "mouse", type: "mousePressed", x: 1, y: 2, button: "left", clickCount: 1 }).success).toBe(true)
    expect(viewerClientMessageSchema.safeParse({ t: "text", text: "中文输入" }).success).toBe(true)
    expect(viewerClientMessageSchema.safeParse({ t: "nav", action: "goto", url: "https://example.com" }).success).toBe(true)
    expect(viewerClientMessageSchema.safeParse({ t: "eval", code: "1" }).success).toBe(false)
    expect(viewerClientMessageSchema.safeParse({ t: "mouse", type: "drag", x: 1, y: 2 }).success).toBe(false)
  })
})

describe("网址解析", () => {
  it("协议和主机名", async () => {
    const { parseUrl } = await import("../src/index.js")
    expect(parseUrl("https://user:pw@Shop.Example.com:8443/a?b#c")).toEqual({ scheme: "https:", host: "shop.example.com" })
    expect(parseUrl("http://127.0.0.1:5191/x")).toEqual({ scheme: "http:", host: "127.0.0.1" })
    expect(parseUrl("http://[::1]:80/")).toEqual({ scheme: "http:", host: "::1" })
    expect(parseUrl("about:blank")).toEqual({ scheme: "about:", host: "" })
    expect(parseUrl("no scheme")).toBeUndefined()
  })
})

describe("最近用了这个 Chrome 的运行", () => {
  const event = (fields: { kind?: "plan" | "tool"; detail?: string; input?: string }) => ({ seq: 1, at: "2026-10-17T00:00:00.000Z", kind: "tool" as const, title: "t", ...fields })

  it("认系统分配时记的「打开了 Chrome」过程", async () => {
    const { browserIdsOf } = await import("../src/index.js")
    expect(browserIdsOf([event({ kind: "plan", detail: "Chrome 配置 br-a；浏览器 b-1" })])).toEqual(["br-a"])
    expect(browserIdsOf([event({ kind: "plan", detail: "Chrome 配置 br-a-2；浏览器 b-2；网址白名单：a.com" })])).toEqual(["br-a-2"])
    // 不是 plan、不在开头的不算
    expect(browserIdsOf([event({ kind: "tool", detail: "Chrome 配置 br-a；" }), event({ kind: "plan", detail: "用 Chrome 配置 br-a；" })])).toEqual([])
  })

  it("认 browser.use 的 profileId，也认旧格式 browser；去重、排序", async () => {
    const { browserIdsOf } = await import("../src/index.js")
    const events = [
      event({ input: '{"profileId":"br-a.b"}' }),
      event({ input: '{"browser": "br-a.b"}' }),
      event({ input: '{"url":"x","profileId" : "br-z","browser":"br-c"}' }),
      event({ input: '{"profile":"br-q","profileId":""}' }),
    ]
    expect(browserIdsOf(events)).toEqual(["br-a.b", "br-c", "br-z"])
  })

  it("按摘要的 browserIds 找，最多 3 个", async () => {
    const { recentRunsUsing } = await import("../src/index.js")
    const run = (id: string, browserIds: string[]) => ({ id, taskId: "T-1", browserIds })
    const runs = [run("R-1", ["br-a.b"]), run("R-2", ["br-a.b", "br-c"]), run("R-3", ["br-aXb"]), run("R-4", ["br-a.b-2"]), run("R-5", ["br-a.b"]), run("R-6", ["br-a.b"])]
    const found = recentRunsUsing("br-a.b", runs, [{ id: "T-1" } as never])
    expect(found.map((item) => item.run.id)).toEqual(["R-1", "R-2", "R-5"])
    expect(found[0]!.task?.id).toBe("T-1")
  })
})

describe("groupBrowserActions", () => {
  it("同一次运行同一个网址上连着的动作合成一行，动作去重计数，at 取最早", () => {
    // 倒序（最新的在前）
    const rows = groupBrowserActions([
      { at: "2026-10-17T10:05:00.000Z", url: "https://b.example/", sessionId: "R-1-1", action: "Click", failed: false },
      { at: "2026-10-17T10:04:00.000Z", url: "https://a.example/", sessionId: "R-1-1", action: "Input", failed: true },
      { at: "2026-10-17T10:03:00.000Z", url: "https://a.example/", sessionId: "R-1-1", action: "Click", failed: false },
      { at: "2026-10-17T10:02:00.000Z", url: "https://a.example/", sessionId: "R-1-1", action: "Click", failed: false },
      { at: "2026-10-17T10:01:00.000Z", url: "https://a.example/", sessionId: "R-1-1", action: "Open", failed: false },
      { at: "2026-10-17T10:00:00.000Z", url: "https://a.example/", sessionId: "R-2-1", action: "Open", failed: false },
    ])
    expect(rows).toEqual([
      { at: "2026-10-17T10:05:00.000Z", url: "https://b.example/", sessionId: "R-1-1", actions: [{ tag: "Click", count: 1, failed: false }] },
      {
        at: "2026-10-17T10:01:00.000Z",
        url: "https://a.example/",
        sessionId: "R-1-1",
        actions: [
          { tag: "Open", count: 1, failed: false },
          { tag: "Click", count: 2, failed: false },
          { tag: "Input", count: 1, failed: true },
        ],
      },
      { at: "2026-10-17T10:00:00.000Z", url: "https://a.example/", sessionId: "R-2-1", actions: [{ tag: "Open", count: 1, failed: false }] },
    ])
    expect(browserActionTag("browser_fill_form")).toBe("Input")
    expect(browserActionTag("browser_new_thing")).toBe("new_thing")
  })
})

describe("browserActionLabel", () => {
  it("动作标签 + 元素描述；不带要填的内容，网址只给域名", () => {
    expect(browserActionLabel("browser_click", { target: "e12", element: "搜索按钮" })).toBe("Click · 搜索按钮")
    expect(browserActionLabel("browser_type", { target: "e3", element: "密码框", text: "hunter2" })).toBe("Input · 密码框")
    expect(
      browserActionLabel("browser_fill_form", {
        fields: [
          { name: "账号", type: "textbox", target: "#user", value: "tester" },
          { name: "密码", type: "textbox", target: "#pw", value: "{{password}}" },
        ],
      })
    ).toBe("Input · 账号、密码")
    expect(browserActionLabel("browser_drag", { startElement: "滑块", endElement: "终点" })).toBe("Drag · 滑块 → 终点")
    expect(browserActionLabel("browser_press_key", { key: "Enter" })).toBe("Key · Enter")
    expect(browserActionLabel("browser_navigate", { url: "https://shop.example.com/search?q=secret" })).toBe("Open · shop.example.com")
    expect(browserActionLabel("browser_snapshot", {})).toBe("View")
    expect(browserActionLabel("browser_click", { element: "一".repeat(60) })).toBe(`Click · ${"一".repeat(39)}…`)
  })
})
