// Podman 的 REST API（libpod，unix socket）：建、开、关、删容器，跑一次性的 qemu-img。pod 里没有 podman 命令行，只能走 API。
// 开发机实测 Podman 3.4.4（docs/dev/desktop-vm.md 第 1 节）：停掉的容器 State.Status 是 stopped（新版是 exited），没开过的是 configured / created。
import { request } from "node:http"

/** Podman 连不上（socket 不存在、服务没开） */
export class PodmanUnavailableError extends Error {}

export class PodmanError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface ContainerState {
  /** running / paused / configured / created / stopped / exited … */
  status: string
  running: boolean
  exitCode: number
  startedAt?: string
  finishedAt?: string
  error?: string
}

export interface PortMapping {
  host_ip: string
  host_port: number
  container_port: number
  protocol: "tcp"
}

export interface Mount {
  source: string
  destination: string
  readOnly?: boolean
}

/** libpod 的 SpecGenerator 里用得到的字段 */
export interface ContainerSpec {
  name: string
  image: string
  env?: Record<string, string>
  entrypoint?: string[]
  command?: string[]
  devices?: { path: string }[]
  cap_add?: string[]
  annotations?: Record<string, string>
  netns?: { nsmode: string }
  network_options?: Record<string, string[]>
  portmappings?: PortMapping[]
  mounts?: Mount[]
  labels?: Record<string, string>
  stop_timeout?: number
}

const API = "/v3.0.0/libpod"

interface Response {
  status: number
  body: Buffer
}

export class PodmanClient {
  readonly socketPath: string
  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  private call(method: string, path: string, options: { body?: unknown; timeoutMs?: number } = {}): Promise<Response> {
    const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: `${API}${path}`,
          method,
          headers: { host: "podman", ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) },
          timeout: options.timeoutMs ?? 60_000,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on("data", (chunk: Buffer) => chunks.push(chunk))
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
          res.on("error", reject)
        }
      )
      req.on("timeout", () => req.destroy(new Error(`Podman 超过 ${Math.round((options.timeoutMs ?? 60_000) / 1000)} 秒没有响应（${method} ${path}）`)))
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (["ENOENT", "ECONNREFUSED", "EACCES", "ENOTSOCK"].includes(error.code ?? "")) reject(new PodmanUnavailableError(`Podman 连不上（${this.socketPath}：${error.code}）`))
        else reject(error)
      })
      if (payload) req.write(payload)
      req.end()
    })
  }

  private static fail(what: string, res: Response): never {
    let reason = res.body.toString("utf8").slice(0, 500)
    try {
      const body = JSON.parse(reason) as { message?: unknown; cause?: unknown }
      if (typeof body.message === "string") reason = body.message
    } catch {
      // 不是 JSON：用原文
    }
    throw new PodmanError(`${what}失败：${reason || `HTTP ${res.status}`}`, res.status)
  }

  async ping(timeoutMs = 5_000): Promise<void> {
    const res = await this.call("GET", "/_ping", { timeoutMs })
    if (res.status !== 200) PodmanClient.fail("连接 Podman ", res)
  }

  async imageExists(image: string): Promise<boolean> {
    const res = await this.call("GET", `/images/${encodeURIComponent(image)}/exists`)
    return res.status === 204
  }

  /** 拉镜像（几百 MB，最多等 30 分钟） */
  async pullImage(image: string): Promise<void> {
    const res = await this.call("POST", `/images/pull?reference=${encodeURIComponent(image)}&quiet=true`, { timeoutMs: 30 * 60_000 })
    if (res.status !== 200) PodmanClient.fail(`拉镜像 ${image} `, res)
    // 出错时状态码也可能是 200，错误写在流里
    const text = res.body.toString("utf8")
    const error = /"error"\s*:\s*"([^"]+)"/.exec(text)
    if (error) throw new PodmanError(`拉镜像 ${image} 失败：${error[1]}`, 500)
  }

  async ensureImage(image: string): Promise<void> {
    if (!(await this.imageExists(image))) await this.pullImage(image)
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    const { mounts, ...rest } = spec
    const body = {
      ...rest,
      ...(mounts
        ? { mounts: mounts.map((mount) => ({ type: "bind", source: mount.source, destination: mount.destination, options: ["rbind", mount.readOnly ? "ro" : "rw"] })) }
        : {}),
    }
    const res = await this.call("POST", "/containers/create", { body, timeoutMs: 120_000 })
    if (res.status !== 201) PodmanClient.fail(`建容器 ${spec.name} `, res)
    return (JSON.parse(res.body.toString("utf8")) as { Id: string }).Id
  }

  /** 容器的状态；没有这个容器返回 undefined */
  async inspect(name: string): Promise<ContainerState | undefined> {
    const res = await this.call("GET", `/containers/${encodeURIComponent(name)}/json`)
    if (res.status === 404) return undefined
    if (res.status !== 200) PodmanClient.fail(`查看容器 ${name} `, res)
    const state = (JSON.parse(res.body.toString("utf8")) as { State?: Record<string, unknown> }).State ?? {}
    const time = (value: unknown) => (typeof value === "string" && !value.startsWith("0001-") ? value : undefined)
    return {
      status: String(state.Status ?? "unknown"),
      running: state.Running === true,
      exitCode: Number(state.ExitCode ?? 0),
      ...(time(state.StartedAt) ? { startedAt: time(state.StartedAt) } : {}),
      ...(time(state.FinishedAt) ? { finishedAt: time(state.FinishedAt) } : {}),
      ...(typeof state.Error === "string" && state.Error ? { error: state.Error } : {}),
    }
  }

  async start(name: string): Promise<void> {
    const res = await this.call("POST", `/containers/${encodeURIComponent(name)}/start`, { timeoutMs: 120_000 })
    // 304 = 本来就开着
    if (res.status !== 204 && res.status !== 304) PodmanClient.fail(`开容器 ${name} `, res)
  }

  /** 关机：给 timeoutSeconds 秒正常关（dockur 收到信号会让 Windows 关机），之后强制关 */
  async stop(name: string, timeoutSeconds: number): Promise<void> {
    const res = await this.call("POST", `/containers/${encodeURIComponent(name)}/stop?timeout=${timeoutSeconds}`, { timeoutMs: (timeoutSeconds + 60) * 1000 })
    // 304 = 本来就关着；404 = 没有这个容器
    if (res.status !== 204 && res.status !== 304 && res.status !== 404) PodmanClient.fail(`关容器 ${name} `, res)
  }

  /** 删容器（开着的也强制删）；本来就没有不算错 */
  async remove(name: string): Promise<void> {
    const res = await this.call("DELETE", `/containers/${encodeURIComponent(name)}?force=true`, { timeoutMs: 180_000 })
    if (res.status !== 200 && res.status !== 204 && res.status !== 404) PodmanClient.fail(`删容器 ${name} `, res)
  }

  /** 等容器停下来，返回退出码 */
  async wait(name: string, timeoutMs: number): Promise<number> {
    const res = await this.call("POST", `/containers/${encodeURIComponent(name)}/wait?condition=stopped&condition=exited`, { timeoutMs })
    if (res.status !== 200) PodmanClient.fail(`等容器 ${name} `, res)
    const value = Number(JSON.parse(res.body.toString("utf8") || "0"))
    return Number.isFinite(value) ? value : 0
  }

  /** 最后几行日志（stdout + stderr） */
  async logs(name: string, tail = 30): Promise<string> {
    const res = await this.call("GET", `/containers/${encodeURIComponent(name)}/logs?stdout=true&stderr=true&tail=${tail}`)
    if (res.status !== 200) return ""
    return demux(res.body)
  }

  /**
   * 跑一个一次性的容器（例如 qemu-img），等它结束、删掉。退出码不是 0 时带上最后的日志抛错
   */
  async runOnce(spec: ContainerSpec, timeoutMs = 30 * 60_000): Promise<string> {
    await this.remove(spec.name)
    await this.createContainer({ netns: { nsmode: "none" }, ...spec })
    try {
      await this.start(spec.name)
      const code = await this.wait(spec.name, timeoutMs)
      const output = await this.logs(spec.name, 50)
      if (code !== 0) throw new PodmanError(`${spec.entrypoint?.join(" ") ?? spec.name} 退出码 ${code}：${output.trim().slice(-500)}`, 500)
      return output
    } finally {
      await this.remove(spec.name).catch(() => {})
    }
  }
}

/** 日志流（没有 tty 时）：每帧 8 字节头（第 1 字节是 1 stdout / 2 stderr，后 4 字节是长度），拼起来按行连上 */
export function demux(buffer: Buffer): string {
  const parts: string[] = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset]
    const size = buffer.readUInt32BE(offset + 4)
    if (stream === undefined || stream > 2 || offset + 8 + size > buffer.length) return buffer.toString("utf8")
    parts.push(buffer.subarray(offset + 8, offset + 8 + size).toString("utf8"))
    offset += 8 + size
  }
  if (offset < buffer.length) return buffer.toString("utf8")
  return parts.map((part) => (part.endsWith("\n") ? part : `${part}\n`)).join("")
}

let cached: { socket: string; client: PodmanClient } | undefined

/** 按 HEYAGENT_PODMAN_SOCKET 的客户端；没配返回 undefined */
export function podmanFor(socket: string): PodmanClient | undefined {
  if (!socket) return undefined
  if (cached?.socket !== socket) cached = { socket, client: new PodmanClient(socket) }
  return cached.client
}
