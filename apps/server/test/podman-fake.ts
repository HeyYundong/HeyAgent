// 假的 Podman REST API（libpod，unix socket）：记下收到的请求，模拟容器的状态（configured → running → stopped），
// 一次性的 qemu-img 容器真的在宿主机路径上写一个文件（容器里的路径和宿主机一样），chmod、find -delete 也真的做。
// 「开机」时调 onStart（测试在分到的端口上起假的桌面服务，模拟 Windows 开起来），关机、删容器时调 onStop。
import { mkdtempSync } from "node:fs"
import { chmod, lstat, readdir, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface FakeContainer {
  name: string
  spec: Record<string, unknown>
  status: "configured" | "running" | "stopped"
  exitCode: number
  startedAt?: string
  finishedAt?: string
  logs: string[]
}

export interface PodmanRequest {
  method: string
  path: string
  body?: Record<string, unknown>
}

export interface FakePodman {
  socket: string
  requests: PodmanRequest[]
  containers: Map<string, FakeContainer>
  /** 下一次开机（非一次性容器）立刻退出，退出码 1 */
  failNextStart: boolean
  /** 一次性容器（qemu-img）跑过的命令 */
  oneShots: string[][]
  onStart?: (container: FakeContainer) => Promise<void>
  onStop?: (container: FakeContainer) => Promise<void>
  /** 模拟容器自己没了（宿主机上被删掉） */
  vanish(name: string): Promise<void>
  /** 模拟容器自己退出了（宿主机重启过） */
  exit(name: string, code?: number): Promise<void>
  close(): Promise<void>
}

const now = () => new Date().toISOString()

/** 模拟 root：先把目录都改成自己能写，才删得掉（测试里用不可写的子目录模拟「dockur 建的、worker 删不掉的」） */
async function chmodTree(path: string) {
  const info = await lstat(path)
  if (!info.isDirectory()) return
  await chmod(path, 0o755)
  for (const entry of await readdir(path)) await chmodTree(join(path, entry))
}

function frame(text: string, stream = 1) {
  const payload = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

export async function startFakePodman(): Promise<FakePodman> {
  const socket = join(mkdtempSync(join(tmpdir(), "heyagent-podman-")), "podman.sock")
  const containers = new Map<string, FakeContainer>()
  const state = {
    requests: [] as PodmanRequest[],
    failNextStart: false,
    oneShots: [] as string[][],
    onStart: undefined as FakePodman["onStart"],
    onStop: undefined as FakePodman["onStop"],
  }
  const isOneShot = (container: FakeContainer) => Array.isArray(container.spec.entrypoint)

  const stopContainer = async (container: FakeContainer, code = 0) => {
    if (container.status !== "running") return
    container.status = "stopped"
    container.exitCode = code
    container.finishedAt = now()
    await state.onStop?.(container)
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://podman")
        const path = url.pathname.replace(/^\/v[\d.]+\/libpod/, "")
        const text = Buffer.concat(chunks).toString("utf8")
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined
        state.requests.push({ method: req.method ?? "GET", path: `${path}${url.search}`, ...(body ? { body } : {}) })
        const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value))
        const notFound = (name: string) => json(404, { cause: "no such container", message: `no container with name or ID "${name}" found: no such container`, response: 404 })

        if (path === "/_ping") return res.writeHead(200).end("OK")
        if (/^\/images\/.+\/exists$/.test(path)) return res.writeHead(204).end()
        if (path === "/images/pull") return json(200, { id: "fake" })
        if (path === "/containers/create" && req.method === "POST") {
          const name = String(body?.name)
          if (containers.has(name)) return json(409, { message: `the container name "${name}" is already in use` })
          containers.set(name, { name, spec: body ?? {}, status: "configured", exitCode: 0, logs: [] })
          return json(201, { Id: `id-${name}`, Warnings: [] })
        }
        const match = /^\/containers\/([^/]+)(?:\/(json|start|stop|wait|logs))?$/.exec(path)
        if (!match) return json(404, { message: `fake podman: 不认识 ${req.method} ${path}` })
        const name = decodeURIComponent(match[1]!)
        const action = match[2]
        const container = containers.get(name)
        if (req.method === "DELETE" && !action) {
          if (!container) return notFound(name)
          await stopContainer(container, 137)
          containers.delete(name)
          return json(200, [{ Id: `id-${name}` }])
        }
        if (!container) return notFound(name)
        if (action === "json")
          return json(200, {
            Name: name,
            State: {
              Status: container.status,
              Running: container.status === "running",
              ExitCode: container.exitCode,
              StartedAt: container.startedAt ?? "0001-01-01T00:00:00Z",
              FinishedAt: container.finishedAt ?? "0001-01-01T00:00:00Z",
            },
          })
        if (action === "start") {
          if (container.status === "running") return res.writeHead(304).end()
          container.status = "running"
          container.startedAt = now()
          if (isOneShot(container)) {
            const command = [...(container.spec.entrypoint as string[]), ...((container.spec.command as string[]) ?? [])]
            state.oneShots.push(command)
            // qemu-img create -f qcow2 -b <模板盘> -F qcow2 <新盘>：在宿主机路径上写个小文件代替
            if (command[0] === "qemu-img" && command[1] === "create") await writeFile(command.at(-1)!, `fake qcow2 overlay, backing ${command[5]}\n`)
            // 容器里的 root 改权限、清目录（worker 在 pod 里没有权限时，lifecycle.ts 的 makeReadOnly / removeDir）：在宿主机路径上照做
            if (command[0] === "chmod") await chmod(command[2]!, Number.parseInt(command[1]!, 8))
            if (command[0] === "find" && command.at(-1) === "-delete") {
              const dir = command[1]!
              for (const entry of await readdir(dir)) {
                await chmodTree(join(dir, entry))
                await rm(join(dir, entry), { recursive: true, force: true })
              }
            }
            container.logs.push(`Formatting '${command.at(-1)}', fmt=qcow2`)
            container.status = "stopped"
            container.finishedAt = now()
            return res.writeHead(204).end()
          }
          if (state.failNextStart) {
            state.failNextStart = false
            container.logs.push("ERROR: KVM acceleration is not available")
            container.status = "stopped"
            container.exitCode = 1
            container.finishedAt = now()
            return res.writeHead(204).end()
          }
          await state.onStart?.(container)
          return res.writeHead(204).end()
        }
        if (action === "stop") {
          if (container.status !== "running") return res.writeHead(304).end()
          await stopContainer(container)
          return res.writeHead(204).end()
        }
        if (action === "wait") return json(200, container.exitCode)
        if (action === "logs") return res.writeHead(200).end(Buffer.concat(container.logs.map((line) => frame(line))))
        return json(404, { message: "fake podman: 不认识" })
      })().catch((error: unknown) => {
        res.writeHead(500).end(JSON.stringify({ message: (error as Error).message }))
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  return {
    socket,
    containers,
    get requests() {
      return state.requests
    },
    get oneShots() {
      return state.oneShots
    },
    get failNextStart() {
      return state.failNextStart
    },
    set failNextStart(value: boolean) {
      state.failNextStart = value
    },
    get onStart() {
      return state.onStart
    },
    set onStart(value) {
      state.onStart = value
    },
    get onStop() {
      return state.onStop
    },
    set onStop(value) {
      state.onStop = value
    },
    async vanish(name: string) {
      const container = containers.get(name)
      if (!container) return
      await stopContainer(container, 137)
      containers.delete(name)
    },
    async exit(name: string, code = 0) {
      const container = containers.get(name)
      if (container) await stopContainer(container, code)
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
