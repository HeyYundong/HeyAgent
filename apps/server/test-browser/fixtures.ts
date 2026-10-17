// 真浏览器测试的公共部分：本地测试站点（登录、cookie 轮换、验证码页、上传、白名单链接）、带认证的测试 SOCKS5 上游、
// 建测试用的 Chrome 配置 / 平台 / 账号。站点只监听 127.0.0.1；Chrome 把 *.localhost 解析到本机，用不同的子域名当不同的「平台」。
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server } from "node:http"
import net from "node:net"
import dns from "node:dns"

import { eq } from "drizzle-orm"

import type { Db } from "../src/db/client.js"
import * as t from "../src/db/schema.js"
import { encrypt, mask, type Keyring } from "../src/lib/crypto.js"

export interface TestSite {
  port: number
  /** http://<host>:<port> */
  url(host: string, path?: string): string
  /** 合法的 sid（轮换后旧的也还算，免得交替的 session 互相顶掉） */
  sids: Set<string>
  requests: { host: string; path: string }[]
  close(): Promise<void>
}

const html = (title: string, body: string) =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

function cookies(req: IncomingMessage) {
  return Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair[0])
      .map(([key, ...rest]) => [key, rest.join("=")])
  )
}

export async function startSite(): Promise<TestSite> {
  const sids = new Set<string>()
  const requests: { host: string; path: string }[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    const host = (req.headers.host ?? "").split(":")[0]!
    requests.push({ host, path: url.pathname })
    const jar = cookies(req)
    const send = (status: number, body: string, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers })
      res.end(body)
    }
    const redirect = (to: string, headers: Record<string, string | string[]> = {}) => send(302, "", { location: to, ...headers })
    const newSid = () => {
      const sid = randomBytes(6).toString("hex")
      sids.add(sid)
      return sid
    }
    switch (url.pathname) {
      case "/login":
        if (req.method === "POST") return redirect("/me", { "set-cookie": `sid=${newSid()}; Path=/; HttpOnly` })
        return send(200, html("登录", `<form method="post" action="/login"><input name="user" value="tester"><input id="pw" type="password" name="pw"><button id="go" type="submit">登录</button></form>`))
      case "/me":
        if (jar.sid && sids.has(jar.sid)) return send(200, html("我的账号", `<p id="who">OK sid=${jar.sid}</p><p>pref=${jar.pref ?? "-"}</p>`))
        return redirect("/login?next=/me")
      case "/rotate":
        return send(200, html("轮换", `<p>rotated</p>`), { "set-cookie": `sid=${newSid()}; Path=/; HttpOnly` })
      case "/pref":
        return send(200, html("偏好", `<p>pref set</p>`), { "set-cookie": `pref=dark; Path=/; Max-Age=86400` })
      case "/logout":
        if (jar.sid) sids.delete(jar.sid)
        return send(200, html("已退出", `<p>bye</p>`), { "set-cookie": `sid=; Path=/; Max-Age=0` })
      case "/captcha":
        if (jar.passed === "1") return redirect("/secret")
        return send(
          200,
          html(
            "安全验证",
            `<h1>请完成安全验证</h1><p>拖动滑块或点击下面的按钮</p><button id="human" style="width:300px;height:80px" onclick="document.cookie='passed=1; path=/'; location.href='/secret'">我不是机器人</button>`
          )
        )
      case "/secret":
        return send(200, html("通过了", `<p id="code">暗号：蓝色海豚</p>`))
      case "/upload":
        return send(
          200,
          html(
            "上传",
            `<input id="file" type="file"><p id="out">还没选文件</p><script>document.getElementById('file').addEventListener('change', async (e) => { const f = e.target.files[0]; const text = await f.text(); document.getElementById('out').textContent = '选了 ' + f.name + ' 内容 ' + text; })</script>`
          )
        )
      case "/pw":
        // 规则拿不准的页面：有密码框，但地址和标题都不像登录页
        return send(200, html("资料", `<p>请输入口令查看</p><input type="password">`))
      case "/links":
        return send(200, html("链接", `<a id="ok" href="/hello">本站</a> <a id="bad" href="${url.searchParams.get("bad") ?? "http://blocked.localhost/"}">外站</a>`))
      case "/hello":
        return send(
          200,
          html(
            "你好",
            `<p>Hello 世界</p><input id="box" style="position:absolute;left:20px;top:100px;width:400px;height:40px" oninput="document.title='值:'+this.value"><button id="alert" style="position:absolute;left:20px;top:200px;width:200px;height:40px" onclick="alert('弹框来了')">弹框</button>`
          )
        )
      default:
        return send(200, html("测试站点", `<p>${host}</p>`))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    url: (host, path = "/") => `http://${host}:${port}${path}`,
    sids,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

export interface SocksUpstream {
  port: number
  log: { ev: string; host?: string; atyp?: string; ok?: boolean }[]
  close(): Promise<void>
}

/** 测试用的带认证 SOCKS5 上游（RFC 1928 + 1929，改自 spikes/browser/lib/socks.mjs）：记下认证结果和 CONNECT 的地址类型 */
export async function startSocks(user: string, pass: string): Promise<SocksUpstream> {
  const log: SocksUpstream["log"] = []
  const server = net.createServer((client) => {
    client.on("error", () => {})
    client.once("data", (hello) => {
      const methods = [...hello.subarray(2, 2 + hello[1]!)]
      if (!methods.includes(0x02)) {
        log.push({ ev: "no-auth-method" })
        client.end(Buffer.from([5, 0xff]))
        return
      }
      client.write(Buffer.from([5, 0x02]))
      client.once("data", (auth) => {
        const ulen = auth[1]!
        const name = auth.subarray(2, 2 + ulen).toString()
        const plen = auth[2 + ulen]!
        const word = auth.subarray(3 + ulen, 3 + ulen + plen).toString()
        const ok = name === user && word === pass
        log.push({ ev: "auth", ok })
        client.write(Buffer.from([1, ok ? 0 : 1]))
        if (!ok) return void client.end()
        client.once("data", async (request) => {
          const atyp = request[3]
          let host: string
          let offset: number
          if (atyp === 1) {
            host = [...request.subarray(4, 8)].join(".")
            offset = 8
          } else if (atyp === 3) {
            const len = request[4]!
            host = request.subarray(5, 5 + len).toString()
            offset = 5 + len
          } else {
            host = "ipv6"
            offset = 20
          }
          const port = request.readUInt16BE(offset)
          log.push({ ev: "connect", host, atyp: atyp === 3 ? "DOMAIN" : atyp === 1 ? "IPv4" : "IPv6" })
          let ip = host
          if (!net.isIP(host)) {
            try {
              ip = (await dns.promises.resolve4(host))[0]!
            } catch {
              return void client.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]))
            }
          }
          const upstream = net.connect(port, ip, () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
            upstream.pipe(client)
            client.pipe(upstream)
          })
          upstream.on("error", () => client.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])))
          client.on("close", () => upstream.destroy())
        })
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { port: (server.address() as net.AddressInfo).port, log, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

let counter = 0

/** 建一个测试用的 Chrome 配置（默认直连），返回 id */
export async function createProfile(
  db: Db,
  keyring: Keyring,
  input: { name?: string; proxy?: { host: string; port: number; username?: string; password?: string } } = {}
) {
  const id = `br-t${++counter}-${randomBytes(2).toString("hex")}`
  await db.insert(t.browserProfiles).values({
    id,
    name: input.name ?? `测试 Chrome ${id}`,
    description: "测试用",
    proxyKind: input.proxy ? "socks5" : "none",
    proxyHost: input.proxy?.host ?? null,
    proxyPort: input.proxy?.port ?? null,
    proxyUsername: input.proxy?.username ?? null,
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
  })
  if (input.proxy?.password) {
    const secretId = `sec-${id}`
    await db.insert(t.secrets).values({
      id: secretId,
      scope: "browser_proxy",
      refId: id,
      name: "password",
      version: 1,
      enc: encrypt(keyring, input.proxy.password, { table: "secrets", id: secretId, version: 1 }),
      masked: mask(input.proxy.password),
    })
    await db.update(t.browserProfiles).set({ proxyPasswordSecretId: secretId }).where(eq(t.browserProfiles.id, id))
  }
  return id
}

/** 建平台（带域名）和这个 Chrome 配置在该平台的账号，返回账号 id */
export async function createAccount(db: Db, input: { profileId: string; domain: string; maxConcurrent?: number; probeUrl?: string }) {
  const platformId = `p-${++counter}-${randomBytes(2).toString("hex")}`
  await db.insert(t.platforms).values({ id: platformId, name: `平台 ${platformId}`, domains: [input.domain] })
  const accountId = `acc-${platformId}`
  await db.insert(t.browserAccounts).values({
    id: accountId,
    profileId: input.profileId,
    platformId,
    account: "tester",
    status: "expired",
    maxConcurrent: input.maxConcurrent ?? 1,
    probeUrl: input.probeUrl ?? null,
  })
  return accountId
}
