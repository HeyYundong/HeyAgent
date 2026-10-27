// 固化脚本测试的公共部分：开发机上没有 bwrap，用「直接跑 node」的 runner 跑 SDK 和脚本（路径照沙箱的换成宿主机上的），
// 工具桥 socket 的路径同样从 HEYAGENT_BRIDGE 读；在库里建固化流程和一版脚本。
import { spawn } from "node:child_process"
import { join } from "node:path"

import { eq } from "drizzle-orm"

import type { Db } from "../src/db/client.js"
import * as t from "../src/db/schema.js"
import { SANDBOX_CODE_DIR, TOOLS_SOCKET_NAME, type SandboxRunner } from "../src/sandbox/runner.js"

/** 不带 bwrap 的 runner：用本机的 node 跑；/tmp/.code 换成 codeDir；环境变量只给 PATH 和 HEYAGENT_BRIDGE */
export const directNodeRunner: SandboxRunner = (spec) =>
  new Promise((resolve, reject) => {
    const map = (path: string) => (spec.codeDir && path.startsWith(`${SANDBOX_CODE_DIR}/`) ? join(spec.codeDir, path.slice(SANDBOX_CODE_DIR.length + 1)) : path)
    const started = Date.now()
    const child = spawn(process.execPath, [map(spec.script), ...spec.args.map(map)], {
      cwd: spec.workspaceDir,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(spec.toolsDir ? { HEYAGENT_BRIDGE: join(spec.toolsDir, TOOLS_SOCKET_NAME) } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, spec.timeoutSec * 1000)
    const onAbort = () => child.kill("SIGKILL")
    spec.signal?.addEventListener("abort", onAbort, { once: true })
    if (spec.signal?.aborted) onAbort()
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      spec.signal?.removeEventListener("abort", onAbort)
      const out = (text: string) => ({ text, totalBytes: Buffer.byteLength(text), droppedBytes: 0 })
      resolve({ exitCode: timedOut ? 137 : (code ?? 137), timedOut, ms: Date.now() - started, stdout: out(stdout), stderr: out(stderr) })
    })
    child.stdin.on("error", () => {})
    child.stdin.end(spec.stdin ?? "")
  })

let routineCounter = 900

/** 给任务建固化流程和一版脚本：approved = 启用的版本（任务开关打开「先跑流程」）；testing = 要试跑的一版 */
export async function createRoutine(
  db: Db,
  taskId: string,
  input: {
    code: string
    name?: string
    status?: "trial" | "active" | "paused"
    versionStatus?: "approved" | "testing"
    inputSchema?: Record<string, unknown>
  }
) {
  const id = `RT-${++routineCounter}`
  const versionStatus = input.versionStatus ?? "approved"
  await db.insert(t.routines).values({ id, taskId, status: input.status ?? "trial", activeVersion: versionStatus === "approved" ? 1 : null })
  const versionId = `${id}-v1`
  await db.insert(t.routineVersions).values({
    id: versionId,
    routineId: id,
    version: 1,
    status: versionStatus,
    name: input.name ?? "测试流程",
    code: input.code,
    inputSchema: input.inputSchema ?? {},
    outputSchema: {},
  })
  if (versionStatus === "approved") await db.update(t.tasks).set({ routineMode: "first" }).where(eq(t.tasks.id, taskId))
  return { routineId: id, versionId }
}

/** 一段固化脚本：import + run 的函数体 */
export const routineCode = (body: string) => `import ha from "heyagent"\n\nexport default async function run(input) {\n${body}\n}\n`
