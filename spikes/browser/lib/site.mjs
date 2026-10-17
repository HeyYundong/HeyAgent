// 本地测试站点：静态文件 + 记录请求头（看 Accept-Language）。只监听 127.0.0.1。
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site")
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" }

export function startSite({ port = 0, host = "127.0.0.1" } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, acceptLanguage: req.headers["accept-language"], userAgent: req.headers["user-agent"] })
    const u = new URL(req.url, "http://x")
    const p = path.normalize(path.join(ROOT, u.pathname === "/" ? "index.html" : u.pathname))
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end("not found"); return }
    res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream", "cache-control": "no-store" })
    fs.createReadStream(p).pipe(res)
  })
  return new Promise((r) => server.listen(port, host, () => {
    const base = `http://${host}:${server.address().port}`
    r({ server, base, requests, close: () => new Promise((rr) => server.close(rr)) })
  }))
}
