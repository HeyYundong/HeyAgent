// 虚拟机的生命周期（worker，docs/dev/desktop-vm.md 第 1 节）：接口只改 desired / op，这里让每台往目标走。
// - 一台一个 pg-boss 任务（desktop.vm，singletonKey = 桌面 id）：同一台同时只有一个操作在做；
// - 模板：建目录 → OEM 目录（Python 安装包、桌面服务、密钥、install.bat）→ 建容器开机（installing）→ 第一次连上桌面服务（setup）
//   → 管理员装好软件点「做成模板」（seal）：正常关机 → 删容器 → 磁盘改只读 → ready；
// - 桌面：qemu-img 在模板盘上建 qcow2 写时复制的盘（一次性容器，路径和宿主机一样）→ 复制 dockur 认「已经装好」的文件（MAC 不复制）
//   → 建容器开机（starting）→ 连上桌面服务（running）；
// - 对账（每 30 秒）：按 Podman 实际状态更正；desired = running 但没在跑的（宿主机重启过）自动开机；开着的查 /health；
// - 开机中、装 Windows 中每 5 秒查一次 /health，超时（桌面 10 分钟、模板 4 小时）记出错；
// - 开机时端口被占（对外连接正好占着）：换一个空的端口、重建容器再开（ports.ts），最多 5 次。
import { randomBytes } from "node:crypto"
import { copyFile, chmod, mkdir, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"

import { and, eq, inArray } from "drizzle-orm"

import { audit } from "../../data/config/common.js"
import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import type { DesktopVmOp } from "../../db/schema.js"
import { bossFor, desktopVmJobOptions, QUEUES } from "../../engine/queue.js"
import { getKeyring } from "../../engine/runtime.js"
import { decryptText } from "../../lib/crypto.js"
import { agentHealth, errorText, loadDesktopTarget } from "../client.js"
import { wakeDesktopWaiters } from "../leases.js"
import { diskOf, GUEST_AGENT_PORT, GUEST_MCP_PORT, oemDirOf, vmConfig, vmUrls, VM_USER } from "./config.js"
import { memoryProblem } from "./host.js"
import { prepareOem } from "./oem.js"
import { podmanFor, type ContainerSpec, type ContainerState, type PodmanClient } from "./podman.js"
import { lockVms, pickFreePorts, portFree, portTakenError } from "./ports.js"

export type VmRow = typeof t.desktopVms.$inferSelect & { kind: "manual" | "vm" | "template"; name: string; keySecretId: string | null }

const log = (...args: unknown[]) => console.log("[desktop-vm]", ...args)

export async function loadVm(db: Db, desktopId: string): Promise<VmRow | undefined> {
  const [row] = await db
    .select({ vm: t.desktopVms, kind: t.desktops.kind, name: t.desktops.name, keySecretId: t.desktops.keySecretId })
    .from(t.desktopVms)
    .innerJoin(t.desktops, eq(t.desktops.id, t.desktopVms.desktopId))
    .where(eq(t.desktopVms.desktopId, desktopId))
  return row ? { ...row.vm, kind: row.kind, name: row.name, keySecretId: row.keySecretId } : undefined
}

/** 让 worker 去处理这台（接口改完 desired / op 后调；同一台排着的只留一个） */
export async function enqueueVm(db: Db, desktopId: string) {
  const boss = await bossFor(db)
  await boss.send(QUEUES.desktopVm, { desktopId }, desktopVmJobOptions(desktopId))
}

type Patch = Partial<Pick<typeof t.desktopVms.$inferInsert, "state" | "desired" | "op" | "message" | "installedAt">>

/** 改状态：状态变了才更新 state_since。where 给了就只在当前状态是它时改（和健康检查不抢） */
async function patchVm(db: Db, row: VmRow, patch: Patch, onlyIf?: { state?: string; op?: DesktopVmOp | null }) {
  const set: Record<string, unknown> = { ...patch, updatedAt: new Date() }
  if (patch.state && patch.state !== row.state) set.stateSince = new Date()
  const conditions = [eq(t.desktopVms.desktopId, row.desktopId)]
  if (onlyIf?.state) conditions.push(eq(t.desktopVms.state, onlyIf.state as VmRow["state"]))
  const updated = await db
    .update(t.desktopVms)
    .set(set)
    .where(and(...conditions))
    .returning({ id: t.desktopVms.desktopId })
  if (updated.length) Object.assign(row, set)
  return updated.length > 0
}

/** 清掉做完的一次性操作：只在 op 还是它的时候清（做的过程中人又点了别的，留着下一轮做） */
async function clearOp(db: Db, row: VmRow, op: DesktopVmOp) {
  await db
    .update(t.desktopVms)
    .set({ op: null, updatedAt: new Date() })
    .where(and(eq(t.desktopVms.desktopId, row.desktopId), eq(t.desktopVms.op, op)))
  row.op = null
}

function requirePodman(): PodmanClient {
  const podman = podmanFor(vmConfig.podmanSocket)
  if (!podman) throw new Error("没有配置 Podman（HEYAGENT_PODMAN_SOCKET），本机不能开虚拟机")
  return podman
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  )

async function secretText(db: Db, secretId: string | null | undefined): Promise<string> {
  if (!secretId) return ""
  const [secret] = await db.select().from(t.secrets).where(eq(t.secrets.id, secretId))
  return secret ? decryptText(getKeyring(), secret.enc, { table: "secrets", id: secret.id, version: secret.version }) : ""
}

/** 一台虚拟机的容器（dockurr/windows）。开发机实测必须的写法见 docs/dev/desktop-vm.md 第 1 节 */
export function vmContainerSpec(row: VmRow, options: { password: string; templateDir?: string; oemDir?: string }): ContainerSpec {
  return {
    name: row.container,
    image: vmConfig.image,
    env: {
      VERSION: "11",
      LANGUAGE: "Chinese",
      REGION: "zh-CN",
      KEYBOARD: "zh-CN",
      RAM_SIZE: `${row.memoryGb}G`,
      CPU_CORES: String(row.cpus),
      DISK_SIZE: `${row.diskGb}G`,
      DISK_FMT: "qcow2",
      USERNAME: VM_USER,
      PASSWORD: options.password,
      USER_PORTS: `${GUEST_MCP_PORT},${GUEST_AGENT_PORT}`,
    },
    devices: [{ path: "/dev/kvm" }, { path: "/dev/net/tun" }],
    cap_add: ["NET_ADMIN"],
    // API 上 groupadd: ["keep-groups"] 不生效（容器里打不开 /dev/kvm），这个注解才行
    annotations: { "run.oci.keep_original_groups": "1" },
    // rootlessport 在 sg kvm 下起不来，端口转发交给 slirp4netns
    netns: { nsmode: "slirp4netns" },
    network_options: { slirp4netns: ["port_handler=slirp4netns"] },
    portmappings: [
      { host_ip: vmConfig.bind, host_port: row.mcpPort, container_port: GUEST_MCP_PORT, protocol: "tcp" },
      { host_ip: vmConfig.bind, host_port: row.agentPort, container_port: GUEST_AGENT_PORT, protocol: "tcp" },
    ],
    mounts: [
      { source: row.dir, destination: "/storage" },
      // 桌面的盘是模板盘上的写时复制：模板目录同路径只读挂进来，盘里记的模板盘绝对路径才对
      ...(options.templateDir ? [{ source: options.templateDir, destination: options.templateDir, readOnly: true }] : []),
      ...(options.oemDir ? [{ source: options.oemDir, destination: "/oem", readOnly: true }] : []),
    ],
    labels: { "heyagent.desktop": row.desktopId, "heyagent.kind": row.kind },
    stop_timeout: vmConfig.stopTimeoutSeconds,
  }
}

/** dockur 认「已经装好」要的文件（windows.base / ver / boot / rom / vars …）：MAC 不复制（每台要不同），安装镜像不复制 */
export const isStateFile = (name: string) => name.startsWith("windows.") && name !== "windows.mac" && !name.toLowerCase().endsWith(".iso")

export async function copyStateFiles(templateDir: string, dir: string): Promise<string[]> {
  const copied: string[] = []
  for (const entry of await readdir(templateDir, { withFileTypes: true })) {
    if (!entry.isFile() || !isStateFile(entry.name)) continue
    const info = await stat(join(templateDir, entry.name))
    // 状态文件都很小（UEFI 的 rom / vars 几 MB）；大文件是镜像之类的，不复制
    if (info.size > 64 * 1024 * 1024) continue
    await copyFile(join(templateDir, entry.name), join(dir, entry.name))
    copied.push(entry.name)
  }
  return copied
}

/** 在模板盘上建这台的盘（qcow2 写时复制）：用 dockur 镜像里的 qemu-img 跑一个一次性容器，两个目录同路径挂进去 */
export async function createOverlay(podman: PodmanClient, templateDir: string, dir: string, name: string) {
  const base = diskOf(templateDir)
  if (!(await exists(base))) throw new Error(`模板的磁盘不见了（${base}）`)
  await podman.runOnce({
    name: `${name}-qemu-img`,
    image: vmConfig.image,
    entrypoint: ["qemu-img"],
    command: ["create", "-f", "qcow2", "-b", base, "-F", "qcow2", diskOf(dir)],
    mounts: [
      { source: templateDir, destination: templateDir, readOnly: true },
      { source: dir, destination: dir },
    ],
  })
}

/** 建这台的磁盘和容器（已经有的不重建） */
async function ensureContainer(db: Db, podman: PodmanClient, row: VmRow) {
  await podman.ensureImage(vmConfig.image)
  await mkdir(row.dir, { recursive: true })
  let templateDir: string | undefined
  if (row.kind === "vm") {
    const template = row.templateId ? await loadVm(db, row.templateId) : undefined
    if (!template) throw new Error("建这台桌面用的模板不见了")
    templateDir = template.dir
    if (!(await exists(diskOf(row.dir)))) {
      await createOverlay(podman, template.dir, row.dir, row.container)
      await copyStateFiles(template.dir, row.dir)
    }
  }
  let oemDir: string | undefined
  if (row.kind === "template" && !row.installedAt) {
    oemDir = oemDirOf(row.dir)
    await prepareOem(oemDir, row.storagePath, await secretText(db, row.keySecretId))
  }
  const password = await secretText(db, row.vmPasswordSecretId)
  await podman.createContainer(vmContainerSpec(row, { password: password || randomBytes(12).toString("hex"), templateDir, oemDir }))
}

/**
 * 改文件权限、删目录。worker 在 pod 里跑时是 uid 1000、没有任何 capability（deploy/pod.yaml），而 dockur、qemu-img 容器里的 root
 * （宿主机上是运行 Podman 的那个用户）建的文件它改不了权限（EPERM），dockur 建的子目录（tmp/）里的东西也删不掉（EACCES）。
 * 遇到这两种错时交给一次性的容器（容器里的 root）做；worker 直接跑在宿主机上（开发机）时用不到
 */
const denied = (error: unknown) => ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")

async function asContainerRoot(podman: PodmanClient, row: Pick<VmRow, "container" | "dir">, [program, ...args]: [string, ...string[]]) {
  await podman.ensureImage(vmConfig.image)
  await podman.runOnce({
    name: `${row.container}-fs`,
    image: vmConfig.image,
    entrypoint: [program],
    command: args,
    mounts: [{ source: row.dir, destination: row.dir }],
  })
}

export async function makeReadOnly(podman: PodmanClient, row: Pick<VmRow, "container" | "dir">, file: string) {
  try {
    await chmod(file, 0o444)
  } catch (error) {
    if (!denied(error)) throw error
    await asContainerRoot(podman, row, ["chmod", "0444", file])
  }
}

export async function removeDir(podman: PodmanClient, row: Pick<VmRow, "container" | "dir">) {
  try {
    await rm(row.dir, { recursive: true, force: true })
  } catch (error) {
    if (!denied(error)) throw error
    await asContainerRoot(podman, row, ["find", row.dir, "-mindepth", "1", "-delete"])
    await rm(row.dir, { recursive: true, force: true })
  }
}

/** 关机：给 Windows 正常关机的时间，之后强制关 */
async function stopContainer(db: Db, podman: PodmanClient, row: VmRow, container: ContainerState | undefined) {
  if (!container?.running) return
  await patchVm(db, row, { state: "stopping", message: null })
  await podman.stop(row.container, vmConfig.stopTimeoutSeconds)
}

const startedState = (row: VmRow) => (row.kind === "template" && !row.installedAt ? "installing" : "starting")

async function logsTail(podman: PodmanClient, name: string) {
  const text = (await podman.logs(name, 15).catch(() => "")).trim()
  return text ? `。最后的日志：${text.slice(-600)}` : ""
}

async function ensureRunning(db: Db, podman: PodmanClient, row: VmRow, container: ContainerState | undefined): Promise<"done" | "again"> {
  if (container?.running) {
    // 库里记的不是开着（比如 worker 中途退出过）：按开着算，等健康检查
    if (!["starting", "installing", "running", "setup"].includes(row.state)) await patchVm(db, row, { state: startedState(row), message: null })
    return "done"
  }
  // 刚开的机又退出了：不再自动重开，记出错（避免一直重开），人点「开机」再试
  if (container && ["starting", "installing"].includes(row.state) && container.startedAt && new Date(container.startedAt) >= new Date(row.stateSince.getTime() - 5_000)) {
    await patchVm(db, row, { state: "error", message: `虚拟机没开起来（容器退出码 ${container.exitCode}）${await logsTail(podman, row.container)}` })
    return "done"
  }
  const problem = await memoryProblem(db, row.memoryGb, row.desktopId)
  if (problem) {
    await patchVm(db, row, { state: "error", message: problem })
    return "done"
  }
  await startWithFreePorts(db, podman, row, Boolean(container))
  await patchVm(db, row, { state: startedState(row), message: null })
  log(`开机：${row.desktopId}（${row.container}）`)
  return "done"
}

/** 开机时最多试几次（每次端口被占就换了再试） */
const PORT_TRIES = 5

/**
 * 开机（建容器、podman start）。开机前先试这台的两个端口能不能 listen，占着的换成端口段里空着的；Podman 开机时报端口被占，
 * 两个都换了再开（看不出是哪个）。最多试 PORT_TRIES 次，都不行记出错「端口都被占了」
 */
async function startWithFreePorts(db: Db, podman: PodmanClient, row: VmRow, hasContainer: boolean) {
  const busy = new Set<number>()
  for (let attempt = 1; ; attempt++) {
    const taken: number[] = []
    for (const port of [row.mcpPort, row.agentPort]) if (!(await portFree(port))) taken.push(port)
    let why = "开机前试了一下，被别的程序占着"
    if (taken.length === 0) {
      if (!hasContainer) await ensureContainer(db, podman, row)
      try {
        await podman.start(row.container)
        return
      } catch (error) {
        if (!portTakenError(error)) throw error
        taken.push(row.mcpPort, row.agentPort)
        why = `Podman 开机时绑端口失败（${(error as Error).message.slice(0, 300)}）`
      }
    }
    for (const port of taken) busy.add(port)
    if (attempt >= PORT_TRIES)
      throw new Error(`端口都被占了：开机试了 ${PORT_TRIES} 次，每次要用的端口都被别的程序占着（最后一次 ${taken.join("、")}：${why}）。等一会儿再点「开机」`)
    await movePorts(db, podman, row, taken, busy, why)
    hasContainer = false
  }
}

/**
 * 把这台被占着的端口换成端口段里空着的（避开别的虚拟机分到的、这次已经知道占着的），库里的端口和地址一起改，记审计和日志。
 * 端口是建容器时定的：先删掉容器（这时没在跑；盘、状态文件都在目录里），开机时按新端口重建
 */
async function movePorts(db: Db, podman: PodmanClient, row: VmRow, taken: number[], busy: Set<number>, why: string) {
  await podman.remove(row.container)
  const from = { mcpPort: row.mcpPort, agentPort: row.agentPort }
  const to = await db.transaction(async (tx) => {
    await lockVms(tx)
    const moveMcp = taken.includes(row.mcpPort)
    const moveAgent = taken.includes(row.agentPort)
    const picked = await pickFreePorts(tx, Number(moveMcp) + Number(moveAgent), busy)
    if (picked.length < Number(moveMcp) + Number(moveAgent)) {
      const [low, high] = vmConfig.portRange
      throw new Error(`端口都被占了：${low}-${high} 里没有空着的端口（别的桌面分走的、别的程序占着的都不能用；这台的 ${taken.join("、")} 被占着）。删掉不用的桌面，或等一会儿再点「开机」`)
    }
    const next = { mcpPort: moveMcp ? picked.shift()! : row.mcpPort, agentPort: moveAgent ? picked.shift()! : row.agentPort }
    await tx
      .update(t.desktopVms)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(t.desktopVms.desktopId, row.desktopId))
    await tx.update(t.desktops).set(vmUrls(next.mcpPort, next.agentPort)).where(eq(t.desktops.id, row.desktopId))
    await audit(tx, null, "desktop.vm.ports", "desktops", row.desktopId, { name: row.name, from, to: next, reason: why })
    return next
  })
  Object.assign(row, to)
  log(`换端口：${row.desktopId} Windows-MCP ${from.mcpPort} → ${to.mcpPort}，桌面服务 ${from.agentPort} → ${to.agentPort}（${why}）`)
}

async function ensureStopped(db: Db, podman: PodmanClient, row: VmRow, container: ContainerState | undefined): Promise<"done" | "again"> {
  await stopContainer(db, podman, row, container)
  if (row.state !== "stopped") await patchVm(db, row, { state: "stopped", message: null })
  return "done"
}

/**
 * 做成模板：正常关机 → 删容器 → 磁盘改只读 → 删 OEM 目录（里面有密钥）和 Windows 安装镜像 → ready。
 * 安装镜像（win11x64_zh.iso，约 8 GB）dockur 装完不删；做好的模板不会再开机，从它建的桌面也不用它（不复制 .iso，见 isStateFile）
 */
async function seal(db: Db, podman: PodmanClient, row: VmRow, container: ContainerState | undefined) {
  if (row.kind !== "template" || !row.installedAt) {
    await clearOp(db, row, "seal")
    return
  }
  await stopContainer(db, podman, row, container)
  await podman.remove(row.container)
  const disk = diskOf(row.dir)
  if (!(await exists(disk))) throw new Error(`模板的磁盘不见了（${disk}）`)
  await makeReadOnly(podman, row, disk)
  await rm(oemDirOf(row.dir), { recursive: true, force: true })
  for (const name of await readdir(row.dir)) if (name.toLowerCase().endsWith(".iso")) await rm(join(row.dir, name), { force: true })
  await patchVm(db, row, { state: "ready", desired: "stopped", message: null })
  await clearOp(db, row, "seal")
  log(`做成模板：${row.desktopId}`)
}

/** 重置：关机 → 删容器、删盘和复制来的文件（MAC 留着）→ 在模板盘上重建 → 按 desired 开机 */
async function reset(db: Db, podman: PodmanClient, row: VmRow, container: ContainerState | undefined) {
  if (row.kind !== "vm") {
    await clearOp(db, row, "reset")
    return
  }
  await stopContainer(db, podman, row, container)
  await podman.remove(row.container)
  for (const name of await readdir(row.dir).catch(() => [] as string[]))
    if (name === "data.qcow2" || isStateFile(name)) await rm(join(row.dir, name), { force: true })
  await ensureContainer(db, podman, row)
  await patchVm(db, row, { state: "stopped", message: null })
  await clearOp(db, row, "reset")
  log(`重置：${row.desktopId}`)
}

async function restart(db: Db, podman: PodmanClient, row: VmRow, container: ContainerState | undefined) {
  await stopContainer(db, podman, row, container)
  await patchVm(db, row, { state: "stopped", desired: "running", message: null })
  await clearOp(db, row, "restart")
}

/** 删除：关机、删容器、删目录、删这一行（模板连同它的密钥）。模板还有桌面在用时不删（接口已经挡住，这里再兜一次） */
async function destroy(db: Db, podman: PodmanClient, row: VmRow) {
  if (row.kind === "template") {
    const [used] = await db.select({ id: t.desktopVms.desktopId }).from(t.desktopVms).where(eq(t.desktopVms.templateId, row.desktopId)).limit(1)
    if (used) {
      await patchVm(db, row, { state: "error", op: null, message: "还有桌面是用这个模板建的，删不了" })
      return
    }
  }
  const container = await podman.inspect(row.container)
  if (container?.running) await podman.stop(row.container, Math.min(30, vmConfig.stopTimeoutSeconds)).catch(() => {})
  await podman.remove(row.container)
  await removeDir(podman, row)
  await db.transaction(async (tx) => {
    await tx.delete(t.desktops).where(eq(t.desktops.id, row.desktopId))
    if (row.kind === "template") await tx.delete(t.secrets).where(and(eq(t.secrets.scope, "desktop"), eq(t.secrets.refId, row.desktopId)))
  })
  log(`删掉了：${row.desktopId}`)
}

/**
 * 往目标走一步。返回 again = 做完一个操作，还要接着看（例如重置完要开机）。
 * 出错记在这台的状态里（error + 原因），不往外抛
 */
export async function reconcileVm(db: Db, desktopId: string): Promise<"done" | "again"> {
  const row = await loadVm(db, desktopId)
  if (!row) return "done"
  try {
    const podman = requirePodman()
    if (row.op === "delete") {
      await destroy(db, podman, row)
      return "done"
    }
    if (row.state === "ready" && !row.op) return "done"
    // 出错了等人处理（点开机、重启、重置、删除）
    if (row.state === "error" && !row.op) return "done"
    const container = await podman.inspect(row.container)
    if (row.op === "seal") {
      await seal(db, podman, row, container)
      return "done"
    }
    if (row.op === "reset") {
      await reset(db, podman, row, container)
      return "again"
    }
    if (row.op === "restart") {
      await restart(db, podman, row, container)
      return "again"
    }
    if (row.state === "ready") return "done"
    // 要 await：直接 return 出去的 promise 出错时进不了下面的 catch（不记出错，pg-boss 隔 10 秒重试）
    return await (row.desired === "running" ? ensureRunning(db, podman, row, container) : ensureStopped(db, podman, row, container))
  } catch (error) {
    const message = (error as Error).message.slice(0, 1000)
    console.warn(`[desktop-vm] ${desktopId}：${message}`)
    // 删除出错：留在 deleting，下一轮对账再试
    if (row.op === "delete") await patchVm(db, row, { message: `删除没成功，稍后再试：${message}` })
    else await patchVm(db, row, { state: "error", op: null, message })
    return "done"
  }
}

/** pg-boss 任务：一直走到不用再走（最多几步） */
export async function runVmJob(db: Db, desktopId: string) {
  for (let step = 0; step < 6; step++) if ((await reconcileVm(db, desktopId)) === "done") return
}

/**
 * Windows-MCP 起来了没有：不带密钥 GET 一下，回了任何 HTTP 响应（正常是 401）就算起来了。
 * 开发机（机械盘）实测桌面服务通了以后 Windows-MCP 还要几分钟才起来，只看 /health 的话 agent 会先碰到「Windows-MCP 连不上」
 */
async function mcpAnswers(mcpUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(mcpUrl, { redirect: "manual", signal: AbortSignal.timeout(5_000) })
    await res.body?.cancel().catch(() => {})
    return undefined
  } catch (error) {
    return `桌面服务通了，Windows-MCP 还没起来（${errorText(error)}）`
  }
}

/**
 * 开机中、装 Windows 中的：查桌面服务 /health（再看 Windows-MCP 起来没有）。通了 → 桌面 running、模板 setup（第一次记 installed_at）；
 * 超时记出错。开着的（running / setup）连不上只写 message，不改状态（Windows 可能在重启装更新）
 */
export async function checkVmHealth(db: Db, row: VmRow): Promise<void> {
  const target = await loadDesktopTarget(db, getKeyring(), row.desktopId)
  if (!target) return
  const ok = await agentHealth(target, 5_000).then(
    () => (row.state === "starting" || row.state === "installing" ? mcpAnswers(target.mcpUrl) : undefined),
    (error: unknown) => (error as Error).message
  )
  if (row.state === "starting" || row.state === "installing") {
    if (ok === undefined) {
      const next = row.kind === "template" ? "setup" : "running"
      const changed = await patchVm(db, row, { state: next, message: null, ...(row.kind === "template" && !row.installedAt ? { installedAt: new Date() } : {}) }, { state: row.state })
      if (changed) {
        log(`连上了：${row.desktopId} → ${next}`)
        if (next === "running") await wakeDesktopWaiters(db, row.desktopId).catch(() => {})
      }
      return
    }
    const timeout = row.state === "installing" ? vmConfig.installTimeoutMs : vmConfig.startTimeoutMs
    if (Date.now() - row.stateSince.getTime() > timeout) {
      const what = row.state === "installing" ? `装了 ${Math.round(timeout / 3_600_000)} 小时，Windows 还没装好` : `开机 ${Math.round(timeout / 60_000)} 分钟了，还连不上`
      await patchVm(db, row, { state: "error", message: `${what}（${ok}）` }, { state: row.state })
    }
    return
  }
  if (row.state === "running" || row.state === "setup") {
    const message = ok === undefined ? null : `桌面服务连不上：${ok}`
    if ((row.message ?? null) !== message) await patchVm(db, row, { message }, { state: row.state })
  }
}

async function allVms(db: Db, states?: VmRow["state"][]): Promise<VmRow[]> {
  const rows = await db
    .select({ vm: t.desktopVms, kind: t.desktops.kind, name: t.desktops.name, keySecretId: t.desktops.keySecretId, mcpUrl: t.desktops.mcpUrl, agentUrl: t.desktops.agentUrl })
    .from(t.desktopVms)
    .innerJoin(t.desktops, eq(t.desktops.id, t.desktopVms.desktopId))
    .where(states ? inArray(t.desktopVms.state, states) : undefined)
  // 地址按现在的 HEYAGENT_DESKTOP_VM_HOST 和端口：部署改了地址也跟着改（地址由系统管）
  for (const row of rows) {
    const urls = vmUrls(row.vm.mcpPort, row.vm.agentPort)
    if (row.mcpUrl !== urls.mcpUrl || row.agentUrl !== urls.agentUrl) await db.update(t.desktops).set(urls).where(eq(t.desktops.id, row.vm.desktopId))
  }
  return rows.map((row) => ({ ...row.vm, kind: row.kind, name: row.name, keySecretId: row.keySecretId }))
}

/** 每 5 秒：开机中、装 Windows 中的查 /health */
export async function vmHealthTick(db: Db) {
  for (const row of await allVms(db, ["starting", "installing"])) await checkVmHealth(db, row).catch((error) => console.warn(`[desktop-vm] 查 ${row.desktopId} 出错`, error))
}

/**
 * 对账（每 30 秒，worker 启动时也跑一次）：要动的（有等着做的操作、状态和 desired 对不上、容器没了或退出了）交给 desktop.vm 任务；
 * 开着的查 /health
 */
export async function sweepVms(db: Db) {
  if (!vmConfig.podmanSocket) return
  const rows = await allVms(db)
  for (const row of rows) {
    if (row.op || !["ready", "error"].includes(row.state)) await enqueueVm(db, row.desktopId)
    if (row.state === "running" || row.state === "setup") await checkVmHealth(db, row).catch(() => {})
  }
}
