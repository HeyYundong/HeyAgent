// DNS 记录器：监听 127.0.0.1:53/udp，记下每个查询的域名，再转发给真实 DNS 并原样回包。
// 配合 podman run --dns=127.0.0.1 使用：容器里任何走系统解析的 DNS 查询都会被记下来，用来查 DNS 泄漏。
import dgram from "node:dgram"

function qname(buf) {
  let i = 12; const labels = []
  while (i < buf.length && buf[i] !== 0) { const n = buf[i]; labels.push(buf.subarray(i + 1, i + 1 + n).toString()); i += n + 1 }
  const qtype = buf.readUInt16BE(i + 1)
  return { name: labels.join("."), qtype: { 1: "A", 28: "AAAA", 65: "HTTPS", 5: "CNAME" }[qtype] || String(qtype) }
}

export function startDnsLog({ upstream, port = 53, log = [] }) {
  const srv = dgram.createSocket("udp4")
  srv.on("message", (msg, rinfo) => {
    try { log.push({ t: Date.now(), ...qname(msg) }) } catch { log.push({ t: Date.now(), name: "?" }) }
    const up = dgram.createSocket("udp4")
    const timer = setTimeout(() => up.close(), 3000)
    up.on("message", (resp) => { srv.send(resp, rinfo.port, rinfo.address); clearTimeout(timer); up.close() })
    up.send(msg, 53, upstream)
  })
  return new Promise((r, j) => { srv.once("error", j); srv.bind(port, "127.0.0.1", () => r({ log, close: () => srv.close() })) })
}
