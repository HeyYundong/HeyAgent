// 带认证 SOCKS5 的本地转发（m2.md 第 3 条）：Chrome 不支持带用户名密码的 SOCKS5，所以每个这样的 Chrome 配置
// 在 worker 里常驻一个 gost：Chrome 连本机无密码的端口，gost 再带密码连上游。
// - 密码写进权限 0600 的配置文件（gost -C），不出现在任何进程的命令行里（/proc/<pid>/cmdline 谁都能读）；
// - 同一个 Chrome 配置的多个 session 共用一个 gost；配置变了（地址、账号、密码）就重启；
// - gost 挂了重新拉起；上游连不上时 Chrome 直接报 ERR_SOCKS_CONNECTION_FAILED，绝不退回直连（实测）。
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { BrowserUnavailableError, killGroup } from "./chrome.js"

export const GOST_BIN = process.env.GOST_BIN || "gost"

export interface UpstreamSocks {
  host: string
  port: number
  username: string
  password: string
}

interface Forwarder {
  key: string
  port: number
  proc: ChildProcess
  dir: string
  logs: string[]
}

/** 拿一个空闲端口（绑 0 再关掉；gost 马上就会占上） */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function listening(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1")
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

/** gost v3 的配置文件（写法见 spikes/browser/t-gost.mjs，实测过）；字符串都用 JSON 转义，YAML 认 */
export function gostConfig(localPort: number, upstream: UpstreamSocks) {
  return `services:
- name: local
  addr: 127.0.0.1:${localPort}
  handler:
    type: socks5
    chain: upstream
  listener:
    type: tcp
chains:
- name: upstream
  hops:
  - name: hop-0
    nodes:
    - name: node-0
      addr: ${JSON.stringify(`${upstream.host}:${upstream.port}`)}
      connector:
        type: socks5
        auth:
          username: ${JSON.stringify(upstream.username)}
          password: ${JSON.stringify(upstream.password)}
      dialer:
        type: tcp
log:
  level: warn
  format: text
`
}

export class GostPool {
  private readonly forwarders = new Map<string, Forwarder>()
  private readonly pending = new Map<string, Promise<number>>()

  /** 这个 Chrome 配置的本地转发端口；没有就起一个，配置变了或进程挂了就重起 */
  async ensure(profileId: string, upstream: UpstreamSocks): Promise<number> {
    const busy = this.pending.get(profileId)
    if (busy) return busy
    const job = this.ensureInner(profileId, upstream).finally(() => this.pending.delete(profileId))
    this.pending.set(profileId, job)
    return job
  }

  private async ensureInner(profileId: string, upstream: UpstreamSocks): Promise<number> {
    const key = createHash("sha256").update(JSON.stringify(upstream)).digest("hex")
    const current = this.forwarders.get(profileId)
    if (current && current.key === key && current.proc.exitCode === null && (await listening(current.port))) return current.port
    if (current) await this.stop(profileId)
    const port = await freePort()
    const dir = mkdtempSync(join(tmpdir(), "heyagent-gost-"))
    const file = join(dir, "gost.yaml")
    writeFileSync(file, gostConfig(port, upstream), { mode: 0o600 })
    const proc = spawn(GOST_BIN, ["-C", file], { stdio: ["ignore", "pipe", "pipe"], detached: true })
    const logs: string[] = []
    const keep = (chunk: Buffer) => {
      logs.push(String(chunk))
      logs.splice(0, Math.max(0, logs.length - 50))
    }
    proc.stdout!.on("data", keep)
    proc.stderr!.on("data", keep)
    const spawnError = new Promise<Error>((resolve) => proc.once("error", resolve))
    for (let i = 0; i < 50; i++) {
      const failed = await Promise.race([spawnError, sleep(100).then(() => undefined)])
      if (failed) {
        rmSync(dir, { recursive: true, force: true })
        throw new BrowserUnavailableError(`起不了代理转发 gost：${failed.message}`)
      }
      if (proc.exitCode !== null) break
      if (await listening(port)) {
        this.forwarders.set(profileId, { key, port, proc, dir, logs })
        return port
      }
    }
    await killGroup(proc, 1000)
    rmSync(dir, { recursive: true, force: true })
    throw new BrowserUnavailableError(`代理转发 gost 没起来：${logs.join("").slice(-500)}`)
  }

  /** 最近的日志（上游认证失败等会在这里），给报错用 */
  recentLog(profileId: string) {
    return this.forwarders.get(profileId)?.logs.join("").slice(-1000) ?? ""
  }

  async stop(profileId: string) {
    const current = this.forwarders.get(profileId)
    if (!current) return
    this.forwarders.delete(profileId)
    await killGroup(current.proc, 2000)
    rmSync(current.dir, { recursive: true, force: true })
  }

  async stopAll() {
    await Promise.all([...this.forwarders.keys()].map((id) => this.stop(id)))
  }
}
