// 测试用的带认证 SOCKS5 上游（RFC 1928 + RFC 1929）。记录认证结果和 CONNECT 的地址类型（域名 / IP），
// 用来判断域名是不是一路交到了上游、本地有没有先解析。上游自己解析域名时直接问指定的 DNS 服务器，
// 不走系统解析，这样不会被 DNS 记录器算成「本地泄漏」。
import net from "node:net"
import dns from "node:dns"

export function startSocks({ port = 0, user = null, pass = null, dnsServer = null, log = [] } = {}) {
  const resolver = new dns.promises.Resolver()
  if (dnsServer) resolver.setServers([dnsServer])
  const resolve = async (host) => (net.isIP(host) ? host : (await resolver.resolve4(host))[0])
  const server = net.createServer((c) => {
    c.on("error", () => {})
    c.once("data", (hello) => {
      const methods = [...hello.subarray(2, 2 + hello[1])]
      const want = user ? 0x02 : 0x00
      if (!methods.includes(want)) { log.push({ ev: "no-acceptable-method", offered: methods }); c.end(Buffer.from([5, 0xff])); return }
      c.write(Buffer.from([5, want]))
      const afterAuth = () => c.once("data", async (req) => {
        const atyp = req[3]; let host, off
        if (atyp === 1) { host = [...req.subarray(4, 8)].join("."); off = 8 }
        else if (atyp === 3) { const n = req[4]; host = req.subarray(5, 5 + n).toString(); off = 5 + n }
        else { host = "ipv6"; off = 20 }
        const p = req.readUInt16BE(off)
        log.push({ ev: "connect", atyp: atyp === 3 ? "DOMAIN" : atyp === 1 ? "IPv4" : "IPv6", host, port: p })
        let ip
        try { ip = await resolve(host) } catch { c.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); return }
        const up = net.connect(p, ip, () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); up.pipe(c); c.pipe(up) })
        up.on("error", () => c.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])))
        c.on("close", () => up.destroy())
      })
      if (!user) return afterAuth()
      c.once("data", (a) => {
        const ul = a[1], u = a.subarray(2, 2 + ul).toString(), pl = a[2 + ul], pw = a.subarray(3 + ul, 3 + ul + pl).toString()
        const ok = u === user && pw === pass
        log.push({ ev: "auth", user: u, ok })
        c.write(Buffer.from([1, ok ? 0 : 1])); if (ok) afterAuth(); else c.end()
      })
    })
  })
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, port: server.address().port, log, close: () => new Promise((rr) => server.close(rr)) })))
}
