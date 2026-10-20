// 出网代理（docs/dev/session-space.md 5.1）：沙箱没有网络，只能经它访问公网的 HTTP / HTTPS。
// 每次 code.run 起一个，听一个 unix socket（所在目录只读挂进沙箱，沙箱里由 socat 转成 127.0.0.1:3128），跑完就关，
// 所以「访问了哪些主机」就是这次运行的。支持 HTTP 转发和 HTTPS CONNECT。
// 防 SSRF：代理自己解析域名，解析结果只要有一个是回环、私有、链路本地、CGNAT、组播、保留、IPv6 唯一本地 / 链路本地 / IPv4 映射这类地址就拒绝（403），
// 连接时直接连解析出的 IP（防 DNS 重绑定）。目标端口按设置限制（默认 80 443 8080 8443），不能拿 CONNECT 去连邮件、数据库这类端口。
import dns from "node:dns/promises"
import { rmSync } from "node:fs"
import http from "node:http"
import net from "node:net"

// IPv4 和 IPv6 分两张表：同一张表里有 ::ffff:0:0/96 时，Node 会把所有 IPv4 地址当成映射地址一起拦掉
const blockV4 = new net.BlockList()
const blockV6 = new net.BlockList()
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  // 不拦 198.18.0.0/15（测试网段）：开了 fake-ip 的 DNS（例如 Clash）把所有公网域名解析到这里，拦了就完全上不了网（开发机实测）
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockV4.addSubnet(address, prefix, "ipv4")
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::", 96], // IPv4 兼容地址（已废弃）
  ["::ffff:0:0", 96], // IPv4 映射地址
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blockV6.addSubnet(address, prefix, "ipv6")

/** 这个地址是不是不许连的（内网、回环、保留……）；不是合法 IP 也算 */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 0) return true
  return family === 4 ? blockV4.check(ip, "ipv4") : blockV6.check(ip, "ipv6")
}

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>

const defaultLookup: Lookup = (host) => dns.lookup(host, { all: true, verbatim: true })

export interface ProxyOptions {
  /** 允许的目标端口；空 = 不限 */
  ports: number[]
  /** 日志里标明是哪次运行 */
  label: string
  connectTimeoutMs?: number
  idleTimeoutMs?: number
  /** 测试用：替换域名解析 */
  lookup?: Lookup
  /** 测试用：替换地址检查（连本机起的假服务器） */
  isBlocked?: (ip: string) => boolean
}

export interface ProxyReport {
  /** 访问过的主机（非默认端口带上端口），按第一次访问的顺序 */
  allowed: string[]
  denied: string[]
  /** 收发的字节数合计 */
  bytes: number
}

class Denied extends Error {}

/** CONNECT 的目标：host:port，IPv6 写成 [::1]:443 */
export function parseAuthority(value: string): { host: string; port: number } | undefined {
  const match = /^\[([^\]]+)\]:(\d+)$/.exec(value) ?? /^([^:[\]]+):(\d+)$/.exec(value)
  if (!match) return undefined
  const port = Number(match[2])
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { host: match[1]!.toLowerCase(), port }
}

export class EgressProxy {
  private readonly server: http.Server
  private readonly options: Required<ProxyOptions>
  private readonly allowed = new Map<string, number>()
  private readonly denied = new Set<string>()
  private readonly sockets = new Set<net.Socket>()
  private bytes = 0
  readonly socketPath: string

  private constructor(socketPath: string, options: ProxyOptions) {
    this.socketPath = socketPath
    this.options = {
      connectTimeoutMs: 15_000,
      idleTimeoutMs: 120_000,
      lookup: defaultLookup,
      isBlocked: isBlockedAddress,
      ...options,
    }
    this.server = http.createServer((req, res) => void this.forward(req, res))
    this.server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void this.tunnel(req, socket, head))
    this.server.on("connection", (socket: net.Socket) => {
      this.sockets.add(socket)
      socket.on("close", () => this.sockets.delete(socket))
    })
    // 坏请求（例如沙箱里探测端口时只连不发）不要打出错误栈
    this.server.on("clientError", (_error, socket) => socket.destroy())
  }

  static async start(socketPath: string, options: ProxyOptions): Promise<EgressProxy> {
    rmSync(socketPath, { force: true })
    const proxy = new EgressProxy(socketPath, options)
    await new Promise<void>((resolve, reject) => {
      proxy.server.once("error", reject)
      proxy.server.listen(socketPath, () => {
        proxy.server.off("error", reject)
        resolve()
      })
    })
    return proxy
  }

  report(): ProxyReport {
    return { allowed: [...this.allowed.keys()], denied: [...this.denied], bytes: this.bytes }
  }

  async close() {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    rmSync(this.socketPath, { force: true })
  }

  private label(host: string, port: number) {
    const name = host.includes(":") ? `[${host}]` : host
    return port === 80 || port === 443 ? name : `${name}:${port}`
  }

  private log(host: string, port: number, verdict: string, extra: string) {
    console.log(`[sandbox] 出网 ${this.options.label} ${this.label(host, port)} ${verdict} ${extra}`)
  }

  private deny(host: string, port: number, reason: string): never {
    this.denied.add(this.label(host, port))
    this.log(host, port, "拒绝", reason)
    throw new Denied(reason)
  }

  /** 检查端口、解析域名、检查地址；返回要连的 IP */
  private async resolve(host: string, port: number): Promise<string> {
    const { ports } = this.options
    if (ports.length && !ports.includes(port))
      this.deny(host, port, `端口 ${port} 不允许（只能访问 ${ports.join("、")} 端口的 HTTP / HTTPS）`)
    let addresses: { address: string; family: number }[]
    try {
      addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await this.options.lookup(host)
    } catch (error) {
      this.deny(host, port, `解析不了域名：${(error as Error).message}`)
    }
    if (addresses.length === 0) this.deny(host, port, "解析不出地址")
    const blocked = addresses.find((each) => this.options.isBlocked(each.address))
    if (blocked) this.deny(host, port, `${host} 是内网或保留地址（${blocked.address}），不许访问`)
    // IPv4 优先：容器里 IPv6 多半不通
    return (addresses.find((each) => each.family === 4) ?? addresses[0]!).address
  }

  private record(host: string, port: number, bytes: number) {
    const key = this.label(host, port)
    this.allowed.set(key, (this.allowed.get(key) ?? 0) + bytes)
    this.bytes += bytes
  }

  private async forward(req: http.IncomingMessage, res: http.ServerResponse) {
    let url: URL
    try {
      url = new URL(req.url ?? "")
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("只能当 HTTP 代理用（请求行要写完整网址）")
      return
    }
    if (url.protocol !== "http:") {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("HTTPS 请用 CONNECT")
      return
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
    const port = Number(url.port) || 80
    let ip: string
    try {
      ip = await this.resolve(host, port)
    } catch (error) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end(`被出网代理拒绝：${(error as Error).message}`)
      return
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: url.host }
    delete headers["proxy-connection"]
    delete headers["proxy-authorization"]
    // 放行就先记下主机：连接（例如 keep-alive 的隧道）可能要等沙箱退出后才关，字节数到时候再加
    this.record(host, port, 0)
    let bytes = 0
    const upstream = http.request(
      { host: ip, port, method: req.method, path: url.pathname + url.search, headers, agent: false, timeout: this.options.connectTimeoutMs },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.on("data", (chunk: Buffer) => (bytes += chunk.length))
        response.pipe(res)
        response.on("end", () => {
          this.record(host, port, bytes)
          this.log(host, port, "允许", `${bytes} 字节`)
        })
      }
    )
    upstream.on("timeout", () => upstream.destroy(new Error("连接超时")))
    upstream.on("error", (error) => {
      this.record(host, port, bytes)
      this.log(host, port, "允许", `出错：${error.message}`)
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
      res.end(`出网代理连不上 ${url.host}：${error.message}`)
    })
    req.on("data", (chunk: Buffer) => (bytes += chunk.length))
    req.pipe(upstream)
  }

  private async tunnel(req: http.IncomingMessage, client: net.Socket, head: Buffer) {
    const target = parseAuthority(req.url ?? "")
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n")
      return
    }
    const { host, port } = target
    let ip: string
    try {
      ip = await this.resolve(host, port)
    } catch (error) {
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain; charset=utf-8\r\n\r\n被出网代理拒绝：${(error as Error).message}`)
      return
    }
    this.record(host, port, 0)
    let bytes = 0
    let connected = false
    const upstream = net.connect({ host: ip, port })
    upstream.setTimeout(this.options.connectTimeoutMs)
    upstream.once("connect", () => {
      connected = true
      upstream.setTimeout(this.options.idleTimeoutMs)
      client.setTimeout(this.options.idleTimeoutMs)
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on("data", (chunk: Buffer) => (bytes += chunk.length))
    client.on("data", (chunk: Buffer) => (bytes += chunk.length))
    upstream.on("timeout", () => upstream.destroy(new Error(connected ? "空闲太久" : "连接超时")))
    client.on("timeout", () => client.destroy())
    let done = false
    const finish = (error?: Error) => {
      if (done) return
      done = true
      this.record(host, port, bytes)
      this.log(host, port, "允许", error && !connected ? `连不上：${error.message}` : `${bytes} 字节`)
    }
    upstream.on("error", (error) => {
      if (!connected) client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n出网代理连不上 ${host}:${port}：${error.message}`)
      else client.destroy()
      finish(error)
    })
    upstream.on("close", () => {
      client.destroy()
      finish()
    })
    client.on("error", () => upstream.destroy())
    client.on("close", () => upstream.destroy())
  }
}
