// 系统开的桌面（docs/dev/desktop-vm.md）：存放位置识别、本机资源、模板（建 → 装 Windows → 装软件 → 做成模板）、
// 从模板建桌面（写时复制的盘、复制状态文件、分端口、自动登记地址）、开关机 / 重启 / 重置 / 删除、内存不够、权限、
// 分配时排除模板和关着的桌面、对账（容器没了、退出了、该开没开）、开机时端口被占自动换。
// Podman 是假的（podman-fake.ts，unix socket），「开机」时在分到的端口上起假的桌面服务和 Windows-MCP（desktop-helpers.ts）。
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { createServer, type Server, type Server as HttpServer } from "node:http"
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { serve } from "@hono/node-server"
import { and, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"

import * as t from "../src/db/schema.js"
import { loadDesktopTarget } from "../src/desktop/client.js"
import { attachDesktopViewRelay } from "../src/desktop/view-relay.js"
import { vmConfig } from "../src/desktop/vm/config.js"
import { makeReadOnly, reconcileVm, removeDir, sweepVms, vmHealthTick } from "../src/desktop/vm/lifecycle.js"
import { demux, podmanFor } from "../src/desktop/vm/podman.js"
import { portFree } from "../src/desktop/vm/ports.js"
import { detectDiskKind, devNumbers, discoverStorages } from "../src/desktop/vm/storage.js"
import { buildSnapshot } from "../src/engine/sessions.js"
import { startFakeAgent, startFakeMcp, type FakeAgent, type FakeMcp } from "./desktop-helpers.js"
import { call, createTask, Script, step, text, useScript, waitFor, waitStatus, type EngineTestContext } from "./engine-helpers.js"
import { login, mutate, query } from "./helpers.js"
import { startFakePodman, type FakeContainer, type FakePodman } from "./podman-fake.js"

const PYTHON_BYTES = Buffer.from("fake python installer\n")

/**
 * 假桌面服务绑的端口段（HEYAGENT_DESKTOP_PORT_RANGE）。不能在系统的临时端口段（ip_local_port_range，默认 32768–60999）里：
 * 原来写死的 47310–47399 在临时端口段里，本机任何一条往外的连接（数据库连接池、HTTP keep-alive、别的测试）都可能正好占着
 * 47314 这类端口，「开机」时假服务 listen 报 EADDRINUSE → 假 Podman 回 500 → 桌面记出错，偶发「等不到 running」，
 * 后面的删模板跟着 409（全量跑时连接多才碰上，单独跑能过）。现在在 20000–30999 里随机挑一段（别的工作区同时跑这个测试也不撞），
 * 先试着 listen 一下，占着的换一段
 */
async function pickPortBase(): Promise<number> {
  const free = (port: number) =>
    new Promise<boolean>((resolve) => {
      const probe = createTcpServer()
      probe.once("error", () => resolve(false))
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
    })
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 20_000 + 100 * Math.floor(Math.random() * 110)
    let ok = true
    for (let port = base + 10; port < base + 30 && ok; port++) ok = await free(port)
    if (ok) return base
  }
  throw new Error("20000–30999 里找不到空着的端口段")
}
let PORT_BASE = 0
/** 端口段里的第 n 个（模板 0、1，第一台桌面 2、3……） */
const portAt = (n: number) => PORT_BASE + 10 + n

let ctx: EngineTestContext
let lin: string
let wang: string
let li: string
let podman: FakePodman
let python: Server
let rootA: string
let rootB: string
let sysRoot: string
const fakeVms = new Map<string, { agent: FakeAgent; mcp: FakeMcp }>()
let templateId: string
let vmId: string

const ENV: Record<string, string> = {}
const setEnv = (values: Record<string, string>) => {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in ENV)) ENV[key] = process.env[key] ?? "\u0000"
    process.env[key] = value
  }
}

const vmRow = async (id: string) => (await ctx.db.select().from(t.desktopVms).where(eq(t.desktopVms.desktopId, id)))[0]
const desktopRow = async (id: string) => (await ctx.db.select().from(t.desktops).where(eq(t.desktops.id, id)))[0]
const listed = async (id: string, cookie = lin) => (await query(ctx.app, "desktops.list", cookie)).data.find((each: { id: string }) => each.id === id)
/** 这台在 desktop.vm 队列里还有没做完的任务（排着的、在做的、等重试的） */
async function vmJobsPending(id: string) {
  const rows = await ctx.db.execute<{ n: number }>(
    sql`select count(*)::int as n from pgboss.job where name = 'desktop.vm' and singleton_key = ${id} and state in ('created', 'retry', 'active')`
  )
  return (rows.rows[0]?.n ?? 0) > 0
}
/**
 * 等 worker 把这台做到某个状态（开机中 / 装 Windows 中的顺便查一次 /health）。还要等这台的 desktop.vm 任务都做完：
 * 容器退出、被删以后库里的状态还是 running，任务开机后才改成 starting；只看状态会在任务做完之前就「等到了」旧的 running，
 * 接下来的一步（关掉假服务再对账）和还在开机的任务撞上（对账测试偶发「等 记下连不上 超时」）
 */
async function waitState(id: string, state: string, timeout = 20_000) {
  const deadline = Date.now() + timeout
  let row: Awaited<ReturnType<typeof vmRow>>
  for (;;) {
    await vmHealthTick(ctx.db)
    row = await vmRow(id)
    if (row?.state === state && !row.op && !(await vmJobsPending(id))) return row
    if (Date.now() > deadline) throw new Error(`等 ${id} 变成 ${state} 超时，现在：${JSON.stringify(row)}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}
const requestsTo = (name: string, action: string) => podman.requests.filter((request) => request.path.startsWith(`/containers/${name}/${action}`))
const createBody = (name: string) => podman.requests.filter((request) => request.path === "/containers/create" && request.body?.name === name).at(-1)?.body as Record<string, unknown>

/** 假 Windows 开起来：dockur 建好盘和状态文件（模板第一次开机时），在映射出来的端口上起两个服务 */
async function boot(container: FakeContainer) {
  const storage = (container.spec.mounts as { source: string; destination: string }[]).find((mount) => mount.destination === "/storage")!.source
  if ((container.spec.labels as Record<string, string>)["heyagent.kind"] === "template") {
    await writeFile(join(storage, "data.qcow2"), "fake windows disk")
    for (const [name, value] of Object.entries({ "windows.base": "win11x64_zh.iso", "windows.ver": "6.06", "windows.boot": "", "windows.rom": "rom", "windows.vars": "vars" })) await writeFile(join(storage, name), value)
  }
  // dockur 没有 MAC 文件时生成一个（每台不同）
  const mac = join(storage, "windows.mac")
  if (!(await stat(mac).catch(() => undefined))) await writeFile(mac, `02:00:00:${Math.floor(Math.random() * 99)}:00:01`)
  if (holdServices) return
  await startServices(container)
}

/** 模板装 Windows 期间两个服务还没起来：测试先让它停在「装 Windows 中」 */
let holdServices = false

async function startServices(container: FakeContainer) {
  const desktopId = (container.spec.labels as Record<string, string>)["heyagent.desktop"]!
  const ports = container.spec.portmappings as { host_port: number; container_port: number }[]
  const target = await loadDesktopTarget(ctx.db, ctx.keyring, desktopId)
  const agent = await startFakeAgent(target!.key, { port: ports.find((port) => port.container_port === 8001)!.host_port })
  // 端口被占（listen 报 EADDRINUSE）时假 Podman 回 500：已经起来的桌面服务也关掉，不留着占端口
  const mcp = await startFakeMcp(target!.key, { port: ports.find((port) => port.container_port === 8000)!.host_port }).catch(async (error: unknown) => {
    await agent.close()
    throw error
  })
  fakeVms.set(container.name, { agent, mcp })
}

async function shutdown(container: FakeContainer) {
  const vm = fakeVms.get(container.name)
  fakeVms.delete(container.name)
  await vm?.agent.close()
  await vm?.mcp.close()
}

beforeAll(async () => {
  podman = await startFakePodman()
  podman.onStart = boot
  podman.onStop = shutdown
  PORT_BASE = await pickPortBase()
  python = createServer((_req, res) => res.writeHead(200, { "content-type": "application/octet-stream" }).end(PYTHON_BYTES))
  await new Promise<void>((resolve) => python.listen(0, "127.0.0.1", resolve))
  const base = mkdtempSync(join(tmpdir(), "heyagent-dvm-"))
  rootA = join(base, "ssd")
  rootB = join(base, "hdd")
  mkdirSync(rootA)
  mkdirSync(rootB)
  // 假的 /sys：两个目录在同一块盘上，先标成机械盘（rotational = 1）
  sysRoot = join(base, "sys")
  const { major, minor } = devNumbers((await stat(rootA, { bigint: true })).dev)
  mkdirSync(join(sysRoot, "dev", "block", `${major}:${minor}`, "queue"), { recursive: true })
  writeFileSync(join(sysRoot, "dev", "block", `${major}:${minor}`, "queue", "rotational"), "1\n")
  const proc = join(base, "proc")
  mkdirSync(proc)
  writeFileSync(join(proc, "meminfo"), `MemTotal:       ${64 * 1024 * 1024} kB\nMemFree:        1000 kB\n`)
  const kvm = join(base, "kvm")
  writeFileSync(kvm, "")
  setEnv({
    HEYAGENT_PODMAN_SOCKET: podman.socket,
    HEYAGENT_DESKTOP_STORAGE_ROOTS: `${rootA},${rootB}`,
    HEYAGENT_DESKTOP_SYS_ROOT: sysRoot,
    HEYAGENT_DESKTOP_PROC_ROOT: proc,
    HEYAGENT_DESKTOP_KVM_DEVICE: kvm,
    HEYAGENT_DESKTOP_RESERVED_GB: "24",
    HEYAGENT_DESKTOP_MIN_FREE_GB: "1",
    HEYAGENT_DESKTOP_PORT_RANGE: `${portAt(0)}-${portAt(89)}`,
    HEYAGENT_DESKTOP_VM_HOST: "127.0.0.1",
    HEYAGENT_DESKTOP_BIND: "127.0.0.1",
    HEYAGENT_DESKTOP_VM_STOP_SECONDS: "5",
    HEYAGENT_DESKTOP_PYTHON_URL: `http://127.0.0.1:${(python.address() as AddressInfo).port}/python.exe`,
    HEYAGENT_DESKTOP_PYTHON_SHA256: createHash("sha256").update(PYTHON_BYTES).digest("hex"),
  })
  // 定时器都不开：对账、健康检查由测试自己调；desktop.vm 任务照常由 worker 处理
  ctx = await setupEngine()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
  li = await login(ctx.app, "lijing@heyagent.local")
})

async function setupEngine() {
  const { setupEngine: setup } = await import("./engine-helpers.js")
  return setup({ desktopSweepMs: false, desktopVmSweepMs: false })
}

afterAll(async () => {
  await ctx?.stop()
  for (const vm of fakeVms.values()) {
    await vm.agent.close()
    await vm.mcp.close()
  }
  await podman?.close()
  await new Promise<void>((resolve) => (python ? python.close(() => resolve()) : resolve()))
  for (const [key, value] of Object.entries(ENV)) {
    if (value === "\u0000") delete process.env[key]
    else process.env[key] = value
  }
})

describe("存放位置和本机", () => {
  it("SSD / HDD 按 rotational 认（分区看上一级），读不到是 unknown；空间不够、目录不存在写进 problem；默认位置", async () => {
    const fake = mkdtempSync(join(tmpdir(), "heyagent-sys-"))
    const { major, minor } = devNumbers((await stat(rootA, { bigint: true })).dev)
    // 整块盘：dev/block/<maj>:<min>/queue/rotational
    mkdirSync(join(fake, "a", "dev", "block", `${major}:${minor}`, "queue"), { recursive: true })
    writeFileSync(join(fake, "a", "dev", "block", `${major}:${minor}`, "queue", "rotational"), "0\n")
    expect(await detectDiskKind(rootA, join(fake, "a"))).toBe("ssd")
    // 分区：dev/block/<maj>:<min> 链到 devices/…/sdx/sdx1，queue 在上一级
    mkdirSync(join(fake, "b", "devices", "pci", "sdx", "sdx1"), { recursive: true })
    mkdirSync(join(fake, "b", "devices", "pci", "sdx", "queue"))
    writeFileSync(join(fake, "b", "devices", "pci", "sdx", "queue", "rotational"), "1\n")
    mkdirSync(join(fake, "b", "dev", "block"), { recursive: true })
    symlinkSync(join(fake, "b", "devices", "pci", "sdx", "sdx1"), join(fake, "b", "dev", "block", `${major}:${minor}`))
    expect(await detectDiskKind(rootA, join(fake, "b"))).toBe("hdd")
    expect(await detectDiskKind(rootA, join(fake, "nothing"))).toBe("unknown")
    expect(devNumbers(BigInt(0x801))).toEqual({ major: 8, minor: 1 })
    expect(devNumbers(BigInt(0xfd00))).toEqual({ major: 253, minor: 0 })

    const missing = join(rootA, "nope")
    const storages = await discoverStorages({ kindOverrides: { [rootB]: "ssd" } }, { roots: [missing, rootA, rootB], sysRoot, minFreeGb: 1 })
    expect(storages[0]).toMatchObject({ path: missing, problem: "目录不存在", isDefault: false })
    expect(storages[1]).toMatchObject({ path: rootA, kind: "hdd", kindOverridden: false, isDefault: false })
    expect(storages[1]!.freeGb).toBeGreaterThan(1)
    expect(storages[1]!.totalGb).toBeGreaterThanOrEqual(storages[1]!.freeGb)
    // 手动标成 SSD 的那个是默认位置（没选默认 = 第一个 SSD）
    expect(storages[2]).toMatchObject({ path: rootB, kind: "ssd", kindOverridden: true, isDefault: true })
    const low = await discoverStorages({ kindOverrides: {} }, { roots: [rootA], sysRoot, minFreeGb: 1e9 })
    expect(low[0]!.problem).toMatch(/^剩余空间不够：剩 \d+ GB，至少要 1000000000 GB$/)
    expect(low[0]!.isDefault).toBe(false)
    // 设置里选的默认位置优先
    const chosen = await discoverStorages({ defaultPath: rootA, kindOverrides: { [rootB]: "ssd" } }, { roots: [rootA, rootB], sysRoot, minFreeGb: 1 })
    expect(chosen.map((each) => each.isDefault)).toEqual([true, false])

    expect(demux(Buffer.from("plain text"))).toBe("plain text")
  })

  it("desktops.host 所有人能看；设置存放位置只给主管、只能是配置里的位置", async () => {
    const host = await query(ctx.app, "desktops.host", wang)
    expect(host.error).toBeUndefined()
    expect(host.data).toMatchObject({ available: true, memoryGb: 64, usedMemoryGb: 0, runningVms: 0 })
    expect(host.data.cpus).toBeGreaterThan(0)
    expect(host.data.storages.map((each: { path: string; kind: string }) => [each.path, each.kind])).toEqual([
      [rootA, "hdd"],
      [rootB, "hdd"],
    ])
    expect(host.data.storages[0].isDefault).toBe(true)

    expect((await mutate(ctx.app, "desktops.setStorageSettings", wang, { kindOverrides: {} })).error?.data?.code).toBe("FORBIDDEN")
    const bad = await mutate(ctx.app, "desktops.setStorageSettings", lin, { defaultPath: "/etc", kindOverrides: {} })
    expect(bad.error).toMatchObject({ data: { code: "BAD_REQUEST" } })
    expect(bad.error!.message).toContain("/etc")
    expect((await mutate(ctx.app, "desktops.setStorageSettings", lin, { defaultPath: rootB, kindOverrides: { [rootA]: "ssd" } })).error).toBeUndefined()
    const after = (await query(ctx.app, "desktops.host", wang)).data
    expect(after.storages).toMatchObject([
      { path: rootA, kind: "ssd", kindOverridden: true, isDefault: false },
      { path: rootB, kind: "hdd", kindOverridden: false, isDefault: true },
    ])
    const [audit] = await ctx.db.select().from(t.auditEvents).where(eq(t.auditEvents.action, "desktop.storage.set"))
    expect(audit).toBeDefined()

    // Podman 连不上：不能开虚拟机
    setEnv({ HEYAGENT_PODMAN_SOCKET: join(rootA, "no.sock") })
    const down = (await query(ctx.app, "desktops.host", wang)).data
    expect(down.available).toBe(false)
    expect(down.problem).toContain("Podman 连不上")
    setEnv({ HEYAGENT_PODMAN_SOCKET: podman.socket })
  })
})

describe("模板", () => {
  it("主管建模板：OEM 目录、容器参数（KVM、网络、端口、注解）→ 装 Windows → 连上桌面服务是 setup → 做成模板（关机、删容器、盘只读）", async () => {
    const input = { name: "Standard Template", description: "办公软件", storagePath: rootA, diskGb: 64, memoryGb: 6, cpus: 4 }
    expect((await mutate(ctx.app, "desktops.createTemplate", wang, input)).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "desktops.createTemplate", lin, { ...input, storagePath: "/tmp" })).error?.data?.code).toBe("BAD_REQUEST")
    holdServices = true
    const created = await mutate(ctx.app, "desktops.createTemplate", lin, input)
    expect(created.error).toBeUndefined()
    templateId = created.data.id
    expect(templateId).toBe("dk-standard-template")
    const row = await waitState(templateId, "installing")
    const dir = join(rootA, "heyagent-desktops", templateId)
    expect(row).toMatchObject({ storagePath: rootA, dir, container: `heyagent-${templateId}`, desired: "running", memoryGb: 6, cpus: 4, diskGb: 64 })
    expect(row.installedAt).toBeNull()

    // 地址由系统按端口填，密钥是系统生成的（只存密文）
    const desktop = await desktopRow(templateId)
    expect(desktop).toMatchObject({ kind: "template", createdById: "u-lin", mcpUrl: `http://127.0.0.1:${row.mcpPort}/mcp`, agentUrl: `http://127.0.0.1:${row.agentPort}` })
    expect([row.mcpPort, row.agentPort]).toEqual([portAt(0), portAt(1)])
    const target = await loadDesktopTarget(ctx.db, ctx.keyring, templateId)
    expect(target!.key).toMatch(/^[0-9a-f]{48}$/)

    // 容器参数：开发机实测要的写法
    const body = createBody(`heyagent-${templateId}`)
    expect(body).toMatchObject({
      image: vmConfig.image,
      devices: [{ path: "/dev/kvm" }, { path: "/dev/net/tun" }],
      cap_add: ["NET_ADMIN"],
      annotations: { "run.oci.keep_original_groups": "1" },
      netns: { nsmode: "slirp4netns" },
      network_options: { slirp4netns: ["port_handler=slirp4netns"] },
      portmappings: [
        { host_ip: "127.0.0.1", host_port: row.mcpPort, container_port: 8000, protocol: "tcp" },
        { host_ip: "127.0.0.1", host_port: row.agentPort, container_port: 8001, protocol: "tcp" },
      ],
      mounts: [
        { type: "bind", source: dir, destination: "/storage", options: ["rbind", "rw"] },
        { type: "bind", source: join(dir, "oem"), destination: "/oem", options: ["rbind", "ro"] },
      ],
      labels: { "heyagent.desktop": templateId, "heyagent.kind": "template" },
      stop_timeout: 5,
    })
    expect(body.groupadd).toBeUndefined()
    const env = body.env as Record<string, string>
    expect(env).toMatchObject({ VERSION: "11", LANGUAGE: "Chinese", REGION: "zh-CN", KEYBOARD: "zh-CN", RAM_SIZE: "6G", CPU_CORES: "4", DISK_SIZE: "64G", DISK_FMT: "qcow2", USERNAME: "heyagent", USER_PORTS: "8000,8001" })
    expect(env.PASSWORD).toMatch(/^Ha-[0-9a-f]{24}$/)
    expect(JSON.stringify(await ctx.db.select().from(t.secrets).where(eq(t.secrets.refId, templateId)))).not.toContain(env.PASSWORD)

    // OEM 目录：校验过的 Python 安装包（也缓存了）、桌面服务、密钥文件、install.bat
    const oem = join(dir, "oem")
    expect(await readFile(join(oem, "python-3.14.8-amd64.exe"))).toEqual(PYTHON_BYTES)
    expect(await readFile(join(rootA, "heyagent-desktops", "cache", "python-3.14.8-amd64.exe"))).toEqual(PYTHON_BYTES)
    expect((await readdir(join(oem, "desktop-agent"))).sort()).toEqual(expect.arrayContaining(["install.ps1", "heyagent_desktop_agent", "pyproject.toml"]))
    expect(await readdir(join(oem, "desktop-agent"))).not.toContain("tests")
    expect(await readFile(join(oem, "key"), "utf8")).toBe(target!.key)
    expect(((await stat(join(oem, "key"))).mode & 0o777).toString(8)).toBe("600")
    const bat = await readFile(join(oem, "install.bat"), "utf8")
    expect(bat).toContain("C:\\OEM\\python-3.14.8-amd64.exe /quiet InstallAllUsers=1")
    expect(bat).toContain("install.ps1 -KeyFile C:\\OEM\\key")
    expect(bat.split("\r\n").length).toBeGreaterThan(5)

    // 列表：模板、虚拟机信息
    expect(await listed(templateId, wang)).toMatchObject({ kind: "template", createdById: "u-lin", vm: { state: "installing", storagePath: rootA, diskKind: "ssd", memoryGb: 6, cpus: 4, usedBy: 0 } })

    // 装好前不能做成模板；装好（两个服务连上了）→ setup
    expect((await mutate(ctx.app, "desktops.vmAction", lin, { id: templateId, action: "seal" })).error?.data?.code).toBe("CONFLICT")
    holdServices = false
    await startServices(podman.containers.get(`heyagent-${templateId}`)!)
    const setup = await waitState(templateId, "setup")
    expect(setup.installedAt).not.toBeNull()

    // 还没做好的模板不能拿来建桌面
    expect((await mutate(ctx.app, "desktops.createVm", wang, { name: "Too early", templateId })).error?.data?.code).toBe("CONFLICT")
    // 模板不给任务用
    const taskInput = { title: "桌面任务", goal: "做完", steps: [], schedule: null, memoryIds: [], skillIds: [], toolIds: ["desktop"], ruleIds: [], reviewModelId: "test/reviewer" }
    expect((await mutate(ctx.app, "tasks.create", lin, { ...taskInput, desktopIds: [templateId] })).error?.message).toContain("模板不能给任务用")

    // 做成模板：只有主管；关机（给 Windows 正常关机的时间）、删容器、盘只读、OEM 目录（有密钥）和安装镜像删掉
    expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: templateId, action: "seal" })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "desktops.vmAction", lin, { id: templateId, action: "reset" })).error?.data?.code).toBe("BAD_REQUEST")
    // dockur 装完留着的安装镜像：做成模板时删掉
    await writeFile(join(dir, "win11x64_zh.iso"), "iso")
    expect((await mutate(ctx.app, "desktops.vmAction", lin, { id: templateId, action: "seal" })).error).toBeUndefined()
    const ready = await waitState(templateId, "ready")
    expect(ready).toMatchObject({ desired: "stopped", message: null })
    expect(requestsTo(`heyagent-${templateId}`, "stop").at(-1)!.path).toContain("timeout=5")
    expect(podman.containers.has(`heyagent-${templateId}`)).toBe(false)
    expect(((await stat(join(dir, "data.qcow2"))).mode & 0o777).toString(8)).toBe("444")
    expect(await stat(oem).catch(() => undefined)).toBeUndefined()
    expect(await stat(join(dir, "win11x64_zh.iso")).catch(() => undefined)).toBeUndefined()
    const audits = await ctx.db.select({ action: t.auditEvents.action }).from(t.auditEvents).where(eq(t.auditEvents.targetId, templateId))
    expect(audits.map((each) => each.action)).toEqual(expect.arrayContaining(["desktop.template.create", "desktop.vm.seal"]))
    // 做好的模板不能再开机
    expect((await mutate(ctx.app, "desktops.vmAction", lin, { id: templateId, action: "start" })).error?.data?.code).toBe("CONFLICT")
  })
})

describe("从模板建的桌面", () => {
  it("员工从模板建：写时复制的盘、复制状态文件（MAC 不复制）、分端口、自动登记地址，开机后连得上", async () => {
    expect((await mutate(ctx.app, "desktops.createVm", wang, { name: "Ops VM 1", templateId, storagePath: "/somewhere" })).error?.data?.code).toBe("BAD_REQUEST")
    const created = await mutate(ctx.app, "desktops.createVm", wang, { name: "Ops VM 1", description: "运营用", templateId })
    expect(created.error).toBeUndefined()
    vmId = created.data.id
    const row = await waitState(vmId, "running")
    // 没填存放位置 = 默认位置（设置里选了 rootB）；内存、CPU 和模板一样
    const dir = join(rootB, "heyagent-desktops", vmId)
    expect(row).toMatchObject({ templateId, storagePath: rootB, dir, memoryGb: 6, cpus: 4, diskGb: 64, desired: "running", mcpPort: portAt(2), agentPort: portAt(3) })
    const templateDir = join(rootA, "heyagent-desktops", templateId)

    // qemu-img：一次性容器，两个目录同路径挂进去
    expect(podman.oneShots.at(-1)).toEqual(["qemu-img", "create", "-f", "qcow2", "-b", join(templateDir, "data.qcow2"), "-F", "qcow2", join(dir, "data.qcow2")])
    const qemu = createBody(`heyagent-${vmId}-qemu-img`)
    expect(qemu).toMatchObject({ entrypoint: ["qemu-img"], netns: { nsmode: "none" } })
    expect(qemu.mounts).toEqual([
      { type: "bind", source: templateDir, destination: templateDir, options: ["rbind", "ro"] },
      { type: "bind", source: dir, destination: dir, options: ["rbind", "rw"] },
    ])
    expect(podman.containers.has(`heyagent-${vmId}-qemu-img`)).toBe(false)
    expect(await readFile(join(dir, "data.qcow2"), "utf8")).toContain(join(templateDir, "data.qcow2"))
    // dockur 认「已经装好」的文件复制过来了，MAC 是这台自己生成的
    for (const name of ["windows.base", "windows.ver", "windows.boot", "windows.rom", "windows.vars"]) expect(await readFile(join(dir, name), "utf8")).toBe(await readFile(join(templateDir, name), "utf8"))
    // 桌面的容器：模板目录同路径只读挂进来，没有 OEM
    const body = createBody(`heyagent-${vmId}`)
    expect(body.mounts).toEqual([
      { type: "bind", source: dir, destination: "/storage", options: ["rbind", "rw"] },
      { type: "bind", source: templateDir, destination: templateDir, options: ["rbind", "ro"] },
    ])
    expect(body.labels).toEqual({ "heyagent.desktop": vmId, "heyagent.kind": "vm" })

    // 自动登记：地址按端口、密钥用模板的；建的人能测试连接，两个服务都通
    const desktop = await desktopRow(vmId)
    const template = await desktopRow(templateId)
    expect(desktop).toMatchObject({ kind: "vm", createdById: "u-wang", mcpUrl: `http://127.0.0.1:${portAt(2)}/mcp`, agentUrl: `http://127.0.0.1:${portAt(3)}`, keySecretId: template!.keySecretId })
    const health = await mutate(ctx.app, "desktops.test", wang, { id: vmId })
    expect(health.error).toBeUndefined()
    expect(health.data.mcp.ok).toBe(true)
    expect(health.data.agent).toMatchObject({ ok: true, version: "0.1.0-test" })
    expect((await mutate(ctx.app, "desktops.test", li, { id: vmId })).error?.data?.code).toBe("FORBIDDEN")

    expect(await listed(vmId, li)).toMatchObject({ kind: "vm", createdById: "u-wang", vm: { state: "running", templateId, templateName: "Standard Template", storagePath: rootB, diskKind: "hdd" } })
    expect((await listed(templateId)).vm.usedBy).toBe(1)
    expect((await listed(vmId)).vm.diskUsedGb).toBeGreaterThanOrEqual(0)
    const host = (await query(ctx.app, "desktops.host", wang)).data
    expect(host).toMatchObject({ usedMemoryGb: 6, runningVms: 1 })
  })

  it("权限：建的人和主管能管自己的桌面，别的员工不行；地址、密钥不让改；员工不能动模板", async () => {
    const desktop = await desktopRow(vmId)
    const input = { id: vmId, name: "Ops VM 1", description: "运营用，改了", mcpUrl: desktop!.mcpUrl, agentUrl: desktop!.agentUrl }
    expect((await mutate(ctx.app, "desktops.update", li, input)).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "desktops.update", wang, { ...input, mcpUrl: "http://10.0.0.1:8000/mcp" })).error?.data?.code).toBe("BAD_REQUEST")
    expect((await mutate(ctx.app, "desktops.update", wang, { ...input, key: "x".repeat(20) })).error?.data?.code).toBe("BAD_REQUEST")
    expect((await mutate(ctx.app, "desktops.update", wang, input)).error).toBeUndefined()
    expect((await desktopRow(vmId))!.description).toBe("运营用，改了")
    for (const action of ["stop", "restart", "reset", "start"]) expect((await mutate(ctx.app, "desktops.vmAction", li, { id: vmId, action })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "desktops.delete", li, { id: vmId })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "desktops.delete", wang, { id: templateId })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: vmId, action: "seal" })).error?.data?.code).toBe("BAD_REQUEST")
    const templateDesktop = await desktopRow(templateId)
    expect(
      (await mutate(ctx.app, "desktops.update", wang, { id: templateId, name: "x", description: "", mcpUrl: templateDesktop!.mcpUrl, agentUrl: templateDesktop!.agentUrl })).error?.data?.code
    ).toBe("FORBIDDEN")
    // 模板有桌面在用：删不了
    const refused = await mutate(ctx.app, "desktops.delete", lin, { id: templateId })
    expect(refused.error).toMatchObject({ data: { code: "CONFLICT" } })
    expect(refused.error!.message).toContain("有 1 台桌面是用模板「Standard Template」建的")
  })

  it("远程画面：建的人能看能操作（扫码登录），别的员工 403；模板只有主管", async () => {
    const server = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as HttpServer
    await new Promise((resolve) => server.once("listening", resolve))
    try {
      attachDesktopViewRelay(server, { db: ctx.db, auth: ctx.auth, keyring: () => ctx.keyring, trustedOrigins: [] })
      const port = (server.address() as AddressInfo).port
      const status = (cookie: string, id: string) =>
        new Promise<number>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/api/desktop/view/${id}`, { headers: { cookie } })
          ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0))
          ws.on("open", () => {
            ws.close()
            resolve(101)
          })
          ws.on("error", () => resolve(-1))
        })
      expect(await status(li, vmId)).toBe(403)
      expect(await status(wang, templateId)).toBe(403)
      const meta = await new Promise<unknown>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/desktop/view/${vmId}`, { headers: { cookie: wang } })
        ws.on("message", (data, isBinary) => {
          if (isBinary) return
          resolve(JSON.parse(String(data)))
          ws.close()
        })
        ws.on("unexpected-response", (_req, res) => reject(new Error(`升级失败 ${res.statusCode}`)))
      })
      expect(meta).toEqual({ t: "meta", width: 1920, height: 1080, canControl: true })
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("内存不够不让开；关机、开机、重启、重置；被运行占着要 force", async () => {
    // 64 GB − 留 24 GB = 40 GB；开着的这台 6 GB，再建 36 GB 的不行
    const refused = await mutate(ctx.app, "desktops.createVm", wang, { name: "Huge", templateId, memoryGb: 36 })
    expect(refused.error).toMatchObject({ data: { code: "CONFLICT" } })
    expect(refused.error!.message).toBe("本机内存不够了：开着 1 台共 6 GB，再开要 36 GB（本机 64 GB，留给系统 24 GB），先关掉不用的桌面")
    expect(await desktopRow("dk-huge")).toBeUndefined()

    const name = `heyagent-${vmId}`
    // 关机
    expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: vmId, action: "stop" })).error).toBeUndefined()
    await waitState(vmId, "stopped")
    expect(podman.containers.get(name)!.status).toBe("stopped")
    expect(fakeVms.has(name)).toBe(false)
    expect((await query(ctx.app, "desktops.host", wang)).data).toMatchObject({ usedMemoryGb: 0, runningVms: 0 })
    // 开机：开机中 → 连上了
    expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: vmId, action: "start" })).error).toBeUndefined()
    await waitFor(async () => ["starting", "running"].includes((await vmRow(vmId))!.state), { what: "开机" })
    await waitState(vmId, "running")
    // 重启：先关后开
    const stops = requestsTo(name, "stop").length
    const starts = requestsTo(name, "start").length
    expect((await mutate(ctx.app, "desktops.vmAction", lin, { id: vmId, action: "restart" })).error).toBeUndefined()
    await waitFor(async () => requestsTo(name, "start").length > starts, { what: "重启后开机" })
    await waitState(vmId, "running")
    expect(requestsTo(name, "stop").length).toBe(stops + 1)

    // 重置：被运行占着时不带 force 不行；带 force 放开占用。盘重新建，MAC 留着
    const dir = (await vmRow(vmId))!.dir
    const mac = await readFile(join(dir, "windows.mac"), "utf8")
    await writeFile(join(dir, "data.qcow2"), "changed by windows")
    const [holder] = await ctx.db.select({ id: t.sessions.id }).from(t.sessions).limit(1)
    await ctx.db.insert(t.desktopLeases).values({ desktopId: vmId, sessionId: holder!.id, state: "running", expiresAt: new Date(Date.now() + 60_000) })
    const busy = await mutate(ctx.app, "desktops.vmAction", wang, { id: vmId, action: "reset" })
    expect(busy.error).toMatchObject({ data: { code: "CONFLICT" } })
    expect(busy.error!.message).toContain("正被运行用着")
    expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: vmId, action: "start" })).error).toBeUndefined()
    const shots = podman.oneShots.length
    expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: vmId, action: "reset", force: true })).error).toBeUndefined()
    expect(await ctx.db.select().from(t.desktopLeases).where(eq(t.desktopLeases.desktopId, vmId))).toEqual([])
    await waitFor(async () => podman.oneShots.length > shots, { what: "重建盘" })
    await waitState(vmId, "running")
    expect(await readFile(join(dir, "data.qcow2"), "utf8")).toContain("fake qcow2 overlay")
    expect(await readFile(join(dir, "windows.mac"), "utf8")).toBe(mac)
    const audits = await ctx.db.select({ action: t.auditEvents.action, detail: t.auditEvents.detail }).from(t.auditEvents).where(eq(t.auditEvents.targetId, vmId))
    expect(audits.map((each) => each.action)).toEqual(expect.arrayContaining(["desktop.vm.create", "desktop.vm.stop", "desktop.vm.start", "desktop.vm.restart", "desktop.vm.reset"]))
    expect(audits.find((each) => each.action === "desktop.vm.reset")!.detail).toMatchObject({ force: true, releasedSessionId: holder!.id })
  })

  it("开机后又退出了：记出错（带日志），不自动重开；点开机再试", async () => {
    const created = await mutate(ctx.app, "desktops.createVm", lin, { name: "Flaky", templateId, memoryGb: 4, cpus: 2 })
    expect(created.error).toBeUndefined()
    podman.failNextStart = true
    const id = created.data.id as string
    const enqueue = async () => {
      await sweepVms(ctx.db)
      return (await vmRow(id))!.state === "error" ? true : undefined
    }
    const failed = await waitFor(enqueue, { what: "出错" })
    expect(failed).toBe(true)
    const row = (await vmRow(id))!
    expect(row.message).toContain("虚拟机没开起来（容器退出码 1）")
    expect(row.message).toContain("KVM acceleration is not available")
    // 出错的不再自动开（对账跳过）
    const starts = requestsTo(`heyagent-${id}`, "start").length
    await reconcileVm(ctx.db, id)
    expect(requestsTo(`heyagent-${id}`, "start").length).toBe(starts)
    expect((await mutate(ctx.app, "desktops.vmAction", lin, { id, action: "start" })).error).toBeUndefined()
    await waitState(id, "running")
    expect((await query(ctx.app, "desktops.host", wang)).data).toMatchObject({ usedMemoryGb: 10, runningVms: 2 })
    // 删除：worker 关机、删容器、删目录、删行
    expect((await mutate(ctx.app, "desktops.delete", lin, { id })).error).toBeUndefined()
    expect((await vmRow(id))?.state ?? "gone").toMatch(/deleting|gone/)
    await waitFor(async () => !(await desktopRow(id)), { what: "删掉" })
    expect(podman.containers.has(`heyagent-${id}`)).toBe(false)
    expect(await stat(join(rootB, "heyagent-desktops", id)).catch(() => undefined)).toBeUndefined()
  })

  it("连着点：关机还没做完又点开机、重启，后点的不丢（排在后面做），不靠对账", async () => {
    // desktop.vm 是 stately 队列（一台一个 singletonKey）：在做的那个算 active，后点的排一个 created（再点的并进它），
    // 排着的那个开始时才读库里的 desired / op，所以连着点几下，最后一下的意思都会做到
    const name = `heyagent-${vmId}`
    await waitState(vmId, "running")
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    podman.onStop = async (container) => {
      await gate
      await shutdown(container)
    }
    try {
      const starts = requestsTo(name, "start").length
      expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: vmId, action: "stop" })).error).toBeUndefined()
      await waitFor(async () => (await vmRow(vmId))!.state === "stopping", { what: "开始关机" })
      expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: vmId, action: "start" })).error).toBeUndefined()
      expect((await mutate(ctx.app, "desktops.vmAction", lin, { id: vmId, action: "restart" })).error).toBeUndefined()
      release()
      await waitFor(async () => requestsTo(name, "start").length > starts, { what: "关完又开机" })
      await waitState(vmId, "running")
      expect(await vmRow(vmId)).toMatchObject({ desired: "running", op: null, message: null })
    } finally {
      release()
      podman.onStop = shutdown
    }
  })

  it("对账：容器没了 → 该开的重建并开机；该关的记成关着；退出了的自动开", async () => {
    const name = `heyagent-${vmId}`
    // 宿主机重启过：容器退出了，desired = running → 自动开
    await podman.exit(name, 0)
    await sweepVms(ctx.db)
    await waitFor(async () => podman.containers.get(name)?.status === "running", { what: "自动开机" })
    await waitState(vmId, "running")
    // 容器被删掉了：重建（盘还在，不重建盘）并开机
    const shots = podman.oneShots.length
    await podman.vanish(name)
    await sweepVms(ctx.db)
    await waitFor(async () => podman.containers.get(name)?.status === "running", { what: "重建容器" })
    await waitState(vmId, "running")
    expect(podman.oneShots.length).toBe(shots)
    // 健康检查：开着但连不上只写原因，不改状态
    await shutdown(podman.containers.get(name)!)
    await sweepVms(ctx.db)
    await waitFor(async () => (await vmRow(vmId))!.message?.startsWith("桌面服务连不上"), { what: "记下连不上" })
    expect((await vmRow(vmId))!.state).toBe("running")
    await startServices(podman.containers.get(name)!)
    await sweepVms(ctx.db)
    await waitFor(async () => (await vmRow(vmId))!.message === null, { what: "连上后清掉原因" })
    // 关着的（desired = stopped）容器没了：记成关着
    expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: vmId, action: "stop" })).error).toBeUndefined()
    await waitState(vmId, "stopped")
    await podman.vanish(name)
    await ctx.db.update(t.desktopVms).set({ state: "running" }).where(eq(t.desktopVms.desktopId, vmId))
    await sweepVms(ctx.db)
    await waitState(vmId, "stopped")
    expect(podman.containers.has(name)).toBe(false)
  })
})

describe("开机时端口被占", () => {
  // 默认端口段在系统的临时端口段里：开机时可能正好有一条对外连接占着要用的端口。开机前先试 listen，占着就换；Podman 报被占也换
  let portVmId: string
  const holders: TcpServer[] = []
  /** 开发机 Podman 3.4.4 实测：slirp4netns 端口转发绑不上时 start 报的错 */
  const SLIRP_TAKEN = (name: string) =>
    `unable to start container "id-${name}": error from slirp4netns while setting up port redirection: map[desc:bad request: add_hostfwd: slirp_add_hostfwd failed]`

  /**
   * 占着一个端口（别的程序已经占着的不用再占）。用 listen 占：Node 主动指定本地端口的连接带 SO_REUSEADDR，
   * 和同样带 SO_REUSEADDR 的 listen 不冲突，模拟不了；系统自动分端口的对外连接见第一个测试开头
   */
  const hold = (port: number) =>
    new Promise<TcpServer | undefined>((resolve, reject) => {
      const server = createTcpServer()
      server.once("error", (error: NodeJS.ErrnoException) => (error.code === "EADDRINUSE" ? resolve(undefined) : reject(error)))
      server.listen(port, "127.0.0.1", () => {
        holders.push(server)
        resolve(server)
      })
    })
  const release = async () => {
    for (const server of holders.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  afterAll(release)
  /** 端口段里接下来会分出去的 n 个端口（库里还没分的，从小到大） */
  async function nextUnallocated(n: number) {
    const [low] = vmConfig.portRange
    const used = new Set((await ctx.db.select({ a: t.desktopVms.mcpPort, b: t.desktopVms.agentPort }).from(t.desktopVms)).flatMap((row) => [row.a, row.b]))
    const ports: number[] = []
    for (let port = low; ports.length < n; port++) if (!used.has(port)) ports.push(port)
    return ports
  }
  const portAudits = async (id: string) =>
    (await ctx.db.select({ action: t.auditEvents.action, actorId: t.auditEvents.actorId, detail: t.auditEvents.detail }).from(t.auditEvents).where(eq(t.auditEvents.targetId, id)))
      .filter((each) => each.action === "desktop.vm.ports")
  async function waitError(id: string) {
    return waitFor(
      async () => {
        const row = await vmRow(id)
        return row?.state === "error" && !(await vmJobsPending(id)) ? row : undefined
      },
      { what: `${id} 出错` }
    )
  }
  const createsOf = (name: string) => podman.requests.filter((request) => request.path === "/containers/create" && request.body?.name === name)
  /** 库里记的端口、地址、容器的端口映射、连桌面（loadDesktopTarget、测试连接）用的都是这两个端口 */
  async function expectUsing(id: string, mcpPort: number, agentPort: number) {
    expect(await vmRow(id)).toMatchObject({ mcpPort, agentPort })
    expect(await desktopRow(id)).toMatchObject({ mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`, agentUrl: `http://127.0.0.1:${agentPort}` })
    expect(createBody(`heyagent-${id}`).portmappings).toEqual([
      { host_ip: "127.0.0.1", host_port: mcpPort, container_port: 8000, protocol: "tcp" },
      { host_ip: "127.0.0.1", host_port: agentPort, container_port: 8001, protocol: "tcp" },
    ])
    expect(await loadDesktopTarget(ctx.db, ctx.keyring, id)).toMatchObject({ mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`, agentUrl: `http://127.0.0.1:${agentPort}` })
    const health = await mutate(ctx.app, "desktops.test", wang, { id })
    expect(health.error).toBeUndefined()
    expect(health.data.mcp.ok).toBe(true)
    expect(health.data.agent.ok).toBe(true)
  }

  it("开机前要用的端口被占着：换一个空的开起来，库里记的、连桌面用的都是新的", async () => {
    // 先确认：系统给对外连接自动分的本地端口，开机前试 listen 能看出来被占（这就是要修的情况）
    const sink = createTcpServer((socket) => socket.on("error", () => {}))
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve))
    const outbound = await new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: (sink.address() as AddressInfo).port }, () => resolve(socket))
      socket.once("error", reject)
    })
    try {
      expect(await portFree(outbound.localPort!)).toBe(false)
    } finally {
      outbound.destroy()
      await new Promise<void>((resolve) => sink.close(() => resolve()))
    }

    const [held, second] = (await nextUnallocated(2)) as [number, number]
    expect(await hold(held)).toBeDefined()
    expect(await portFree(held)).toBe(false)
    try {
      const created = await mutate(ctx.app, "desktops.createVm", wang, { name: "Port VM", templateId, memoryGb: 4, cpus: 2 })
      expect(created.error).toBeUndefined()
      portVmId = created.data.id
      const row = await waitState(portVmId, "running")
      // 建的时候分到 held、second；开机前发现 held 被占，只换 Windows-MCP 那个
      expect(row.agentPort).toBe(second)
      expect(row.mcpPort).not.toBe(held)
      const others = (await ctx.db.select().from(t.desktopVms)).filter((each) => each.desktopId !== portVmId).flatMap((each) => [each.mcpPort, each.agentPort])
      expect(others).not.toContain(row.mcpPort)
      const [low, high] = vmConfig.portRange
      expect(row.mcpPort).toBeGreaterThanOrEqual(low)
      expect(row.mcpPort).toBeLessThanOrEqual(high)
      await expectUsing(portVmId, row.mcpPort, second)
      // 没拿被占的端口建过容器
      expect(createsOf(`heyagent-${portVmId}`).map((request) => (request.body!.portmappings as { host_port: number }[])[0]!.host_port)).toEqual([row.mcpPort])
      // 换端口记在审计里（系统做的，没有操作人）
      const audits = await portAudits(portVmId)
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({ actorId: null, detail: { from: { mcpPort: held, agentPort: second }, to: { mcpPort: row.mcpPort, agentPort: second } } })
      expect(audits[0]!.detail.reason).toContain("被别的程序占着")
    } finally {
      await release()
    }
  })

  it("Podman 开机时报端口被占：两个都换了、重建容器再开，成功", async () => {
    const name = `heyagent-${portVmId}`
    expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: portVmId, action: "stop" })).error).toBeUndefined()
    const before = await waitState(portVmId, "stopped")
    const creates = createsOf(name).length
    const starts = requestsTo(name, "start").length
    podman.startErrors.push(SLIRP_TAKEN(name))
    expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: portVmId, action: "start" })).error).toBeUndefined()
    const row = await waitState(portVmId, "running")
    expect(podman.startErrors).toEqual([])
    expect(requestsTo(name, "start").length).toBe(starts + 2)
    expect(createsOf(name).length).toBe(creates + 1)
    expect([row.mcpPort, row.agentPort]).not.toContain(before.mcpPort)
    expect([row.mcpPort, row.agentPort]).not.toContain(before.agentPort)
    expect(row.mcpPort).not.toBe(row.agentPort)
    await expectUsing(portVmId, row.mcpPort, row.agentPort)
    const audits = await portAudits(portVmId)
    expect(audits).toHaveLength(2)
    const last = audits.find((each) => (each.detail.from as { mcpPort: number }).mcpPort === before.mcpPort)!
    expect(last.detail).toMatchObject({ from: { mcpPort: before.mcpPort, agentPort: before.agentPort }, to: { mcpPort: row.mcpPort, agentPort: row.agentPort } })
    expect(last.detail.reason).toContain("slirp_add_hostfwd failed")
  })

  it("一直被占（试满 5 次）、端口段里全被占：记出错，原因写清楚；放开后点开机就好", async () => {
    const name = `heyagent-${portVmId}`
    expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: portVmId, action: "stop" })).error).toBeUndefined()
    await waitState(portVmId, "stopped")

    // Podman 每次都说被占：开 5 次、换 4 次端口，记出错
    const starts = requestsTo(name, "start").length
    for (let i = 0; i < 5; i++) podman.startErrors.push(SLIRP_TAKEN(name))
    expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: portVmId, action: "start" })).error).toBeUndefined()
    const failed = await waitError(portVmId)
    expect(failed.message).toMatch(/^端口都被占了：开机试了 5 次，每次要用的端口都被别的程序占着/)
    expect(podman.startErrors).toEqual([])
    expect(requestsTo(name, "start").length).toBe(starts + 5)
    expect(await portAudits(portVmId)).toHaveLength(2 + 4)
    expect(await desktopRow(portVmId)).toMatchObject({ mcpUrl: `http://127.0.0.1:${failed.mcpPort}/mcp`, agentUrl: `http://127.0.0.1:${failed.agentPort}` })

    // 端口段里全被占：这台现在的端口、换端口时能挑的（把端口段临时改小）都被占着
    const range = process.env.HEYAGENT_DESKTOP_PORT_RANGE!
    const window = [70, 71, 72, 73, 74].map(portAt)
    try {
      await hold(failed.mcpPort)
      for (const port of window) await hold(port)
      for (const port of [failed.mcpPort, ...window]) expect(await portFree(port)).toBe(false)
      setEnv({ HEYAGENT_DESKTOP_PORT_RANGE: `${window[0]}-${window.at(-1)}` })
      expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: portVmId, action: "start" })).error).toBeUndefined()
      await waitFor(async () => (await vmRow(portVmId))!.message !== failed.message, { what: "再开一次" })
      const full = await waitError(portVmId)
      expect(full.message).toContain(`端口都被占了：${window[0]}-${window.at(-1)} 里没有空着的端口`)
      expect(full.message).toContain(String(failed.mcpPort))
      // 端口没换
      expect(full).toMatchObject({ mcpPort: failed.mcpPort, agentPort: failed.agentPort })
      expect(await desktopRow(portVmId)).toMatchObject({ mcpUrl: `http://127.0.0.1:${failed.mcpPort}/mcp` })
    } finally {
      setEnv({ HEYAGENT_DESKTOP_PORT_RANGE: range })
      await release()
    }

    // 放开以后点开机：用原来的端口开起来（没被占就不换）
    expect((await mutate(ctx.app, "desktops.vmAction", wang, { id: portVmId, action: "start" })).error).toBeUndefined()
    const row = await waitState(portVmId, "running")
    expect(row).toMatchObject({ mcpPort: failed.mcpPort, agentPort: failed.agentPort, message: null })
    await expectUsing(portVmId, failed.mcpPort, failed.agentPort)

    // 删掉，后面的测试照原来的样子
    expect((await mutate(ctx.app, "desktops.delete", wang, { id: portVmId })).error).toBeUndefined()
    await waitFor(async () => !(await desktopRow(portVmId)), { what: "删掉" })
  })
})

describe("分配", () => {
  it("快照不含模板；关着的桌面自动分配时跳过，指定的那台关着直接报错（不挂起）", async () => {
    // 一台手动登记的（空着、连得上）
    const mcp = await startFakeMcp("manual-key-0123456789abcdef")
    const agent = await startFakeAgent("manual-key-0123456789abcdef")
    try {
      const manual = await mutate(ctx.app, "desktops.create", lin, { name: "Manual PC", description: "实体机", mcpUrl: mcp.url, agentUrl: agent.url, key: "manual-key-0123456789abcdef" })
      expect(manual.error).toBeUndefined()
      const manualId = manual.data.id as string
      expect((await vmRow(vmId))!.state).toBe("stopped")

      const all = await createTask(ctx.db, { modelId: "test/dvm-auto", toolIds: ["desktop"] })
      const snapshot = await buildSnapshot(ctx.db, all, { source: "manual", runAttachments: [] })
      const ids = snapshot.desktop!.desktops.map((desktop) => desktop.id)
      expect(ids).toContain(vmId)
      expect(ids).toContain(manualId)
      expect(ids).not.toContain(templateId)

      // 允许关着的桌面和手动的：跳过关着的，分到手动的
      await ctx.db.update(t.tasks).set({ desktopIds: [vmId, manualId] }).where(eq(t.tasks.id, all))
      useScript("test/dvm-auto", new Script([step([call("desktop.snapshot", {})]), step([text("好了")])]))
      const run1 = await mutate(ctx.app, "engine.runNow", wang, { taskId: all })
      await waitStatus(ctx.db, run1.data.sessionId, "done", 60_000)
      const [session1] = await ctx.db.select().from(t.sessions).where(eq(t.sessions.id, run1.data.sessionId))
      expect(session1!.desktopId).toBe(manualId)

      // 只允许关着的那台：报错「关着」，不挂起
      const only = await createTask(ctx.db, { modelId: "test/dvm-off", toolIds: ["desktop"] })
      await ctx.db.update(t.tasks).set({ desktopIds: [vmId] }).where(eq(t.tasks.id, only))
      const script = useScript("test/dvm-off", new Script([step([call("desktop.snapshot", {})]), step([call("desktop.use", { desktopId: vmId })]), step([text("桌面关着，停下来报告")])]))
      const run2 = await mutate(ctx.app, "engine.runNow", wang, { taskId: only })
      await waitStatus(ctx.db, run2.data.sessionId, "done", 60_000)
      expect(JSON.stringify(script.prompts[1]!.prompt.at(-1))).toContain("桌面「Ops VM 1」关着，请在桌面页开机")
      expect(JSON.stringify(script.prompts[2]!.prompt.at(-1))).toContain("桌面「Ops VM 1」关着，请在桌面页开机")
      const waits = await ctx.db.select().from(t.sessionWaits).where(and(eq(t.sessionWaits.sessionId, run2.data.sessionId)))
      expect(waits).toEqual([])
      expect(await ctx.db.select().from(t.desktopLeases).where(eq(t.desktopLeases.desktopId, vmId))).toEqual([])
      await mutate(ctx.app, "desktops.delete", lin, { id: manualId })
    } finally {
      await mcp.close()
      await agent.close()
    }
  })
})

describe("pod 里的 worker 没有权限时", () => {
  // pod 里 worker 是 uid 1000、没有 capability，dockur（容器里的 root）建的子目录删不掉：交给一次性容器（同路径挂进去）清掉。
  // 用不可写的子目录模拟（root 跑测试时删得掉，测不出来）
  it.skipIf(process.getuid?.() === 0)("删目录遇到 EACCES 时用一次性容器清空再删；能自己做的不起容器", async () => {
    const client = podmanFor(podman.socket)!
    const dir = mkdtempSync(join(tmpdir(), "heyagent-vmdir-"))
    mkdirSync(join(dir, "tmp"))
    writeFileSync(join(dir, "tmp", "win11x64_zh.iso"), "iso")
    writeFileSync(join(dir, "data.qcow2"), "disk")
    await chmod(join(dir, "tmp"), 0o555)
    const before = podman.oneShots.length
    await makeReadOnly(client, { container: "heyagent-dk-x", dir }, join(dir, "data.qcow2"))
    expect((await stat(join(dir, "data.qcow2"))).mode & 0o777).toBe(0o444)
    expect(podman.oneShots.length).toBe(before)
    await removeDir(client, { container: "heyagent-dk-x", dir })
    expect(await stat(dir).catch(() => undefined)).toBeUndefined()
    expect(podman.oneShots.at(-1)).toEqual(["find", dir, "-mindepth", "1", "-delete"])
    const fs = createBody("heyagent-dk-x-fs")
    expect(fs).toMatchObject({ entrypoint: ["find"], netns: { nsmode: "none" } })
    expect((fs.mounts as { source: string; destination: string }[])[0]).toMatchObject({ source: dir, destination: dir })
  })
})

describe("删除", () => {
  it("删桌面（关机、删容器、删目录），之后才能删模板（连同密钥）", async () => {
    expect((await mutate(ctx.app, "desktops.delete", wang, { id: vmId })).error).toBeUndefined()
    await waitFor(async () => !(await desktopRow(vmId)), { what: "桌面删掉" })
    expect(await stat(join(rootB, "heyagent-desktops", vmId)).catch(() => undefined)).toBeUndefined()
    const before = await ctx.db.select().from(t.secrets).where(eq(t.secrets.refId, templateId))
    expect(before.map((row) => row.name).sort()).toEqual(["key", "vmPassword"])
    expect((await mutate(ctx.app, "desktops.delete", lin, { id: templateId })).error).toBeUndefined()
    await waitFor(async () => !(await desktopRow(templateId)), { what: "模板删掉" })
    expect(await stat(join(rootA, "heyagent-desktops", templateId)).catch(() => undefined)).toBeUndefined()
    expect(await ctx.db.select().from(t.secrets).where(eq(t.secrets.refId, templateId))).toEqual([])
    expect(await ctx.db.select().from(t.desktopVms)).toEqual([])
    expect(readFileSync(join(rootA, "heyagent-desktops", "cache", "python-3.14.8-amd64.exe"))).toEqual(PYTHON_BYTES)
  })
})
