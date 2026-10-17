import { describe, expect, it } from "vitest"

import { domainSchema, hostMatches, normalizeDomain, taskInputSchema, urlAllowed, viewerClientMessageSchema } from "../src/index.js"

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
