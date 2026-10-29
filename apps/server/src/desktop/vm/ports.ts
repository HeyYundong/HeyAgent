// 系统开的桌面的端口（docs/dev/desktop-vm.md 第 1 节「端口」）：每台两个（Windows-MCP、桌面服务），从 HEYAGENT_DESKTOP_PORT_RANGE 里分，
// 记在 desktop_vms 的 mcp_port / agent_port，desktops 的 mcp_url / agent_url 按它们填（远程画面、agent、测试连接都读这两个地址）。
// 默认段 42000–42999 落在 Linux 给对外连接临时分配的端口段（32768–60999）里：开机时正好有一条对外连接占着要用的端口，
// Podman 绑端口就失败。所以开机前先试着 listen 一下，占着就换一个空的；Podman 报端口被占也换一个再开（lifecycle.ts 的 startWithFreePorts）。
import { createServer } from "node:net"

import { sql } from "drizzle-orm"

import type { DbOrTx } from "../../data/config/common.js"
import * as t from "../../db/schema.js"
import { vmConfig } from "./config.js"

/** 分端口、换端口、新建时查内存：同一时间只让一个做（事务级的锁，提交就放） */
export const lockVms = (tx: DbOrTx) => tx.execute(sql`select pg_advisory_xact_lock(7731001)`)

/** 库里已经分给虚拟机的端口（所有桌面、模板，两个端口都算） */
export async function usedPorts(tx: DbOrTx): Promise<Set<number>> {
  const rows = await tx.select({ mcp: t.desktopVms.mcpPort, agent: t.desktopVms.agentPort }).from(t.desktopVms)
  return new Set(rows.flatMap((row) => [row.mcp, row.agent]))
}

/**
 * 这个端口现在能不能 listen（在 HEYAGENT_DESKTOP_BIND 上）。只有 EADDRINUSE 算占着；别的错（例如这个地址不在本机）看不出来，当空着，交给 Podman。
 * 对外连接占着的端口也是 EADDRINUSE（测试里实测）。
 * worker 在 pod 里跑时 pod 有自己的网络，这里试不出宿主机上的占用（总是空着），就靠 Podman 开机报错再换
 */
export function portFree(port: number, host = vmConfig.bind): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code !== "EADDRINUSE"))
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)))
  })
}

/**
 * Podman 开机时绑端口失败。开发机 Podman 3.4.4 实测：slirp4netns 端口转发（我们用的）只说
 * `error from slirp4netns while setting up port redirection: map[desc:bad request: add_hostfwd: slirp_add_hostfwd failed]`，
 * rootlessport 说 `rootlessport listen tcp 127.0.0.1:<端口>: bind: address already in use`
 */
export const portTakenError = (error: unknown) => /slirp_add_hostfwd failed|address already in use|EADDRINUSE/i.test(error instanceof Error ? error.message : String(error))

/**
 * 在端口段里从小到大挑 count 个空着的：库里分给虚拟机的（含这台现在的）、avoid 里的（这次已经知道占着的）不要，
 * 挑的时候试着 listen 一下，占着的记进 avoid。不够 count 个就返回挑到的（调用方报错）。要在 lockVms 的事务里调
 */
export async function pickFreePorts(tx: DbOrTx, count: number, avoid: Set<number>): Promise<number[]> {
  const [low, high] = vmConfig.portRange
  const used = await usedPorts(tx)
  const picked: number[] = []
  for (let port = low; port <= high && picked.length < count; port++) {
    if (used.has(port) || avoid.has(port)) continue
    if (await portFree(port)) picked.push(port)
    else avoid.add(port)
  }
  return picked
}
