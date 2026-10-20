// Minimal egress proxy on a unix socket: HTTP CONNECT + plain HTTP, blocks private/loopback destinations.
import http from "node:http"
import net from "node:net"
import dns from "node:dns/promises"
import fs from "node:fs"

const SOCK = process.argv[2]
const blocked = (ip) => {
  const v = net.isIPv6(ip) ? ip.toLowerCase() : ip
  if (net.isIPv4(v)) {
    const [a, b] = v.split(".").map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:")
}
async function resolve(host) {
  const ip = net.isIP(host) ? host : (await dns.lookup(host)).address
  if (blocked(ip)) throw new Error(`blocked ${host} -> ${ip}`)
  return ip
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url)
    const ip = await resolve(url.hostname)
    const up = http.request({ host: ip, port: url.port || 80, method: req.method, path: url.pathname + url.search,
      headers: { ...req.headers, host: url.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
    up.on("error", (e) => { res.writeHead(502); res.end(String(e)) })
    req.pipe(up)
  } catch (e) { res.writeHead(403); res.end(String(e.message)); console.error("DENY", e.message) }
})
server.on("connect", async (req, sock, head) => {
  const [host, port] = req.url.split(":")
  try {
    const ip = await resolve(host)
    const up = net.connect(Number(port) || 443, ip, () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up) })
    up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy())
  } catch (e) { sock.end(`HTTP/1.1 403 Forbidden\r\n\r\n${e.message}`); console.error("DENY", e.message) }
})
try { fs.unlinkSync(SOCK) } catch {}
server.listen(SOCK, () => console.error("proxy on", SOCK))
