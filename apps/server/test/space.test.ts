// Session 空间走完整引擎（真实的测试库 + 假模型）：file.save 按路径存、覆盖 id 不变；file.list / read / edit / delete；
// 自动带上的工具；code.run 用替身沙箱（开发机没有 bwrap）跑：准备目录、写回空间（新建、覆盖、删掉、超限、符号链接）、输出格式和截断、
// 沙箱起不来时的报错、运行结束后删目录。真沙箱的测试见 sandbox-it.test.ts（要在 worker 镜像里跑）。
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { configureEngine, runtime } from "../src/engine/runtime.js"
import { saveFile } from "../src/files/service.js"
import { setSandboxDeps } from "../src/sandbox/code-run.js"
import type { SandboxRunSpec } from "../src/sandbox/runner.js"
import { sessionDirs } from "../src/sandbox/workspace.js"
import { login, query } from "./helpers.js"
import { call, createTask, eventsOf, mutate, Script, sessionRow, setupEngine, step, text, useScript, waitFor, waitStatus, type EngineTestContext } from "./engine-helpers.js"

let ctx: EngineTestContext
let wang: string
const sandboxDir = mkdtempSync(join(tmpdir(), "heyagent-sandbox-test-"))

beforeAll(async () => {
  ctx = await setupEngine()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  configureEngine({ sandbox: { ...runtime.sandbox, dir: sandboxDir, syncMaxFileBytes: 1024 * 1024, outputTailChars: 9000 } })
}, 120_000)

afterAll(async () => {
  setSandboxDeps(undefined)
  await ctx?.stop()
  await rm(sandboxDir, { recursive: true, force: true })
})

async function runNow(taskId: string, attachmentFileIds: string[] = []) {
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId, attachmentFileIds })
  return res.data!.sessionId as string
}

const toolOutputs = async (sessionId: string) =>
  (await eventsOf(ctx.db, sessionId)).filter((event) => event.kind === "tool").map((event) => ({ toolId: event.toolId, title: event.title, output: event.output ?? "" }))

const artifactAt = async (sessionId: string, path: string) => {
  const [row] = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.path, path)))
  return row
}

describe("file.save / list / read / edit / delete", () => {
  it("按路径存、覆盖 id 不变、路径不合规矩报错；列出、按路径读、按原文改、只能删 agent 写的", async () => {
    const attached = await saveFile(ctx.db, { data: Buffer.from("要三列"), name: "需求.txt", kind: "upload" })
    useScript(
      "test/space-files",
      new Script([
        step([
          call("file.save", { path: "state/progress.json", content: '{"step":1}' }),
          call("file.save", { path: "/state/progress.json", content: '{"step":2}' }),
          call("file.save", { path: "attachments/x.txt", content: "x" }),
          call("file.save", { path: "../x.txt", content: "x" }),
          call("file.save", { path: "state/progress.json/a.txt", content: "x" }),
          call("file.save", { path: "state", content: "x" }),
          call("file.save", { path: "scripts/a.py", content: "print('hi')\nx = 1\n" }),
          call("file.save", { path: "data.bin", content: "x" }),
        ]),
        step([
          call("file.list", {}),
          call("file.list", { prefix: "state/" }),
          call("file.read", { path: "state/progress.json" }),
          call("file.read", { path: "attachments/需求.txt" }),
          call("file.read", {}),
          call("file.edit", { path: "scripts/a.py", edits: [{ old: "x = 1", new: "x = 2" }] }),
          call("file.edit", { path: "scripts/a.py", edits: [{ old: "x = 2", new: "x = 3" }, { old: "nope", new: "" }] }),
          call("file.edit", { path: "attachments/需求.txt", edits: [{ old: "要", new: "不要" }] }),
          call("file.delete", { path: "attachments/需求.txt" }),
          call("file.delete", { path: "scripts/a.py" }),
          call("file.read", { path: "scripts/a.py" }),
        ]),
        step([text("好了")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/space-files", toolIds: ["file.save", "file.read"] })
    const sessionId = await runNow(taskId, [attached.id])
    await waitStatus(ctx.db, sessionId, "done")
    const outputs = await toolOutputs(sessionId)
    const out = (index: number) => outputs[index]!.output

    const state = (await artifactAt(sessionId, "state/progress.json"))!
    expect(out(0)).toMatch(new RegExp(`^已新建文件 state/progress.json（id ${state.id}，10 字节）`))
    expect(out(1)).toMatch(new RegExp(`^已覆盖文件 state/progress.json（id ${state.id}，id 不变，10 字节）`))
    expect(out(2)).toContain("attachments/ 是只读的保留目录")
    expect(outputs[2]!.title).toContain("出错")
    expect(out(3)).toContain("不能有 ..")
    expect(out(4)).toContain("state/progress.json 已经是一个文件，不能当目录用")
    expect(out(5)).toContain("只能存文本和代码") // 没有扩展名
    expect(out(7)).toContain("只能存文本和代码")
    // 覆盖：同一行，内容是新的，更新时间晚于创建时间，旧内容删掉了
    expect(state.updatedAt.getTime()).toBeGreaterThan(state.createdAt.getTime())
    expect(readFileSync(join(ctx.filesDir, state.storagePath), "utf8")).toBe('{"step":2}')
    const rows = await ctx.db.select().from(t.files).where(eq(t.files.sessionId, sessionId))
    expect(rows.filter((row) => row.path === "state/progress.json")).toHaveLength(1)

    // 列出
    expect(out(8)).toContain("空间里有 3 个文件")
    expect(out(8)).toMatch(/attachments\/需求\.txt · f-\w+ · 附件 · 9 字节 · 建于/)
    expect(out(8)).toMatch(/scripts\/a\.py · f-\w+ · agent 写的/)
    expect(out(8)).toMatch(/state\/progress\.json · f-\w+ · agent 写的 · 10 字节 · 更新于/)
    expect(out(9)).toContain("state/ 下有 1 个文件")
    expect(out(9)).not.toContain("scripts/")
    expect(out(10)).toContain('{"step":2}')
    expect(out(11)).toContain("要三列")
    expect(out(12)).toContain("fileId 和 path 要给一个")
    // 改：成功的改了、id 不变；失败的整次不改
    expect(out(13)).toContain("已改 scripts/a.py：替换了 1 段")
    expect(out(14)).toContain("第 2 段 old 在文件里找不到")
    expect(out(15)).toContain("是只读的")
    expect(out(16)).toContain("只能删 agent 写的文件；attachments/需求.txt 是附件，只读")
    expect(out(17)).toMatch(/^已删掉 scripts\/a\.py/)
    expect(out(18)).toContain("空间里没有 scripts/a.py")
    expect(await artifactAt(sessionId, "scripts/a.py")).toBeUndefined()

    // 自动带上的工具：存文件 → 列出、改、删；没选运行代码
    const tools = (await sessionRow(ctx.db, sessionId))!.snapshot!.tools.map((tool) => tool.id)
    expect(tools).toEqual(expect.arrayContaining(["file.save", "file.read", "file.list", "file.edit", "file.delete"]))
    expect(tools).not.toContain("code.run")

    // 接口：带路径和更新时间
    const files = await query(ctx.app, "engine.sessionFiles", wang, { sessionId })
    expect(files.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "attachments/需求.txt", kind: "attachment", scope: "session" }),
        expect.objectContaining({ id: state.id, path: "state/progress.json", kind: "artifact", updatedAt: state.updatedAt.toISOString() }),
      ])
    )
  })

  it("只读附件不带「改文件」「删文件」；读附件自动带上「列出文件」", async () => {
    const attached = await saveFile(ctx.db, { data: Buffer.from("x"), name: "a.txt", kind: "upload" })
    useScript("test/space-implied", new Script([step([text("没事做")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/space-implied" })
    const sessionId = await runNow(taskId, [attached.id])
    await waitStatus(ctx.db, sessionId, "done")
    const tools = (await sessionRow(ctx.db, sessionId))!.snapshot!.tools.map((tool) => tool.id)
    expect(tools).toEqual(expect.arrayContaining(["file.read", "file.list"]))
    expect(tools).not.toContain("file.edit")
    expect(tools).not.toContain("file.save")
  })
})

describe("code.run（替身沙箱）", () => {
  const specs: SandboxRunSpec[] = []

  /** 替身：按第一个参数模拟代码做的事，直接改宿主上的 workspace 目录 */
  const fakeRunner = async (spec: SandboxRunSpec) => {
    specs.push(spec)
    const ws = spec.workspaceDir
    const ok = (stdout = "", stderr = "") => ({
      exitCode: 0,
      timedOut: false,
      ms: 1234,
      stdout: { text: stdout, totalBytes: stdout.length, droppedBytes: 0 },
      stderr: { text: stderr, totalBytes: stderr.length, droppedBytes: 0 },
    })
    switch (spec.args[0]) {
      case "write": {
        await mkdir(join(ws, "out"), { recursive: true })
        await writeFile(join(ws, "out/result.csv"), "a,b\n1,2\n")
        await writeFile(join(ws, "state/progress.json"), '{"step":"code"}')
        await rm(join(ws, "old.txt"))
        await writeFile(join(ws, "big.bin"), Buffer.alloc(1536 * 1024))
        await symlink("/etc/passwd", join(ws, "out/link"))
        await mkdir(join(ws, "__pycache__"), { recursive: true })
        await writeFile(join(ws, "__pycache__/x.pyc"), "x")
        return ok(`${"x".repeat(10_000)}END\n`, "warn: something\n")
      }
      case "timeout":
        return { ...ok("", "partial\n"), exitCode: 137, timedOut: true, ms: 5003 }
      case "fail":
        return { ...ok("", "Traceback: boom\n"), exitCode: 1 }
      default:
        return ok()
    }
  }

  it("写回空间、输出格式和截断、只读来源、自动带上的工具；运行结束后删目录", async () => {
    setSandboxDeps({ unavailable: async () => undefined, runner: fakeRunner })
    const attached = await saveFile(ctx.db, { data: Buffer.from("名称,数量\n苹果,3\n"), name: "报价.csv", kind: "upload" })
    let dirExisted = false
    useScript(
      "test/space-code",
      new Script([
        step([
          call("file.save", { path: "state/progress.json", content: '{"step":1}' }),
          call("file.save", { path: "old.txt", content: "old" }),
        ]),
        step([
          call("code.run", { language: "python", code: "print(1)", args: ["write"] }),
          call("code.run", { language: "python", file: "scripts/nope.py" }),
          call("code.run", { language: "bash", file: "/workspace/state/progress.json", args: ["timeout"], timeout: 5 }),
          call("code.run", { language: "python", code: "x", file: "a.py" }),
          call("code.run", { language: "node", code: "boom()", args: ["fail"] }),
        ]),
        async () => {
          dirExisted = existsSync(specs[0]!.workspaceDir)
          return step([call("file.list", {})])
        },
        step([text("做完了，结果在 out/result.csv")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/space-code", toolIds: ["code.run"] })
    const sessionId = await runNow(taskId, [attached.id])
    const dirs = sessionDirs(sandboxDir, sessionId)
    await waitStatus(ctx.db, sessionId, "done")
    expect(dirExisted).toBe(true)

    const outputs = await toolOutputs(sessionId)
    const runs = outputs.filter((each) => each.toolId === "code.run")
    expect(runs).toHaveLength(5)
    const first = runs[0]!.output
    expect(first.split("\n")[0]).toBe("退出码 0 · 用时 1.2 秒")
    expect(first).toContain("写回空间：新建 out/result.csv；覆盖 state/progress.json；删掉 old.txt")
    expect(first).toContain("没写回：out/link（是符号链接，不跟随）；big.bin（超过 1 MB）")
    expect(first).not.toContain("__pycache__")
    expect(first).toMatch(/--- stdout ---\n…（前面还有 1004 字，全文见 tool-outputs\/code-run-[\w-]+-stdout\.txt）\nx+END\n--- stderr ---\nwarn: something$/)
    // 网关没有再截一次（输出比 8000 字长）
    expect(first.length).toBeGreaterThan(runtime.toolOutputMaxChars)
    expect(first).not.toContain("全文已存为文件")
    expect(runs[0]!.title).toBe("运行代码")
    expect(runs[1]!.output).toContain("空间里没有 scripts/nope.py")
    expect(runs[2]!.output).toBe("超时（5 秒），整组进程已被杀掉 · 退出码 137 · 用时 5.0 秒\n--- stderr ---\npartial")
    expect(runs[3]!.output).toContain("file（空间里的脚本路径）和 code（直接给代码）要给一个，而且只能给一个")
    expect(runs[4]!.output).toBe("退出码 1 · 用时 1.2 秒\n--- stderr ---\nTraceback: boom")
    expect(runs[4]!.title).toBe("运行代码") // 退出码不为 0 不算工具出错

    // 交给沙箱的：直接给的代码放在 code 目录；file 的路径换成 /workspace 下；附件在只读目录里
    expect(specs[0]).toMatchObject({ language: "python", script: "/tmp/.code/main.py", args: ["write"], timeoutSec: 60, workspaceDir: dirs.workspace, homeDir: dirs.home })
    expect(specs[0]!.readonlyDirs.find((dir) => dir.name === "attachments")!.host).toBe(join(dirs.ro, "attachments"))
    expect(specs[1]).toMatchObject({ language: "bash", script: "/workspace/state/progress.json", timeoutSec: 5, codeDir: undefined })
    expect(specs[2]).toMatchObject({ language: "node", script: "/tmp/.code/main.js" })

    // 库里：覆盖的 id 不变，删掉的没了，新建的有路径；stdout 全文存成了工具输出
    const state = (await artifactAt(sessionId, "state/progress.json"))!
    expect(readFileSync(join(ctx.filesDir, state.storagePath), "utf8")).toBe('{"step":"code"}')
    expect(await artifactAt(sessionId, "old.txt")).toBeUndefined()
    const result = (await artifactAt(sessionId, "out/result.csv"))!
    expect(result).toMatchObject({ kind: "artifact", name: "result.csv", mime: "text/csv" })
    expect(await artifactAt(sessionId, "big.bin")).toBeUndefined()
    const [full] = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "tool_output")))
    expect(readFileSync(join(ctx.filesDir, full!.storagePath), "utf8")).toBe(`${"x".repeat(10_000)}END\n`)
    expect(outputs.at(-1)!.output).toContain("out/result.csv")
    expect(outputs.at(-1)!.output).toContain("attachments/报价.csv")

    // 自动带上：运行代码 → 存文件、读附件、列出、改、删
    const tools = (await sessionRow(ctx.db, sessionId))!.snapshot!.tools.map((tool) => tool.id)
    expect(tools).toEqual(expect.arrayContaining(["code.run", "file.save", "file.read", "file.list", "file.edit", "file.delete"]))
    // 运行结束：沙箱目录删掉了
    await waitFor(async () => !existsSync(dirs.root), { what: "沙箱目录删掉" })
  })

  it("沙箱起不来：报「沙箱没起来：原因」，算工具出错，别的照常", async () => {
    setSandboxDeps({ unavailable: async () => "worker 里没有装 bubblewrap（bwrap）" })
    const script = useScript(
      "test/space-nosandbox",
      new Script([step([call("code.run", { language: "bash", code: "echo hi" }), call("file.save", { path: "a.txt", content: "a" })]), step([text("好")])])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/space-nosandbox", toolIds: ["code.run"] })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "done")
    const outputs = await toolOutputs(sessionId)
    expect(outputs[0]).toMatchObject({ toolId: "code.run", title: "运行代码（出错）", output: "沙箱没起来：worker 里没有装 bubblewrap（bwrap）" })
    expect(outputs[1]!.output).toContain("已新建文件 a.txt")
    // 系统提示：空间和运行代码的说明
    const system = script.promptText(0)
    expect(system).toContain("## 空间文件")
    expect(system).toContain("state/progress.json")
    expect(system).toContain("## 运行代码")
    expect(system).toContain("不能直连 TCP / UDP")
    expect(system).toContain("在最后的总结里写明路径")
  })

  it("运行中的 session 的目录留着；已经结束的在清理时删掉", async () => {
    const { cleanupSessionSandbox, sweepSandboxDirs } = await import("../src/sandbox/code-run.js")
    await mkdir(join(sandboxDir, "R-gone-1"), { recursive: true })
    const [running] = await ctx.db.select({ id: t.sessions.id }).from(t.sessions).limit(1)
    await ctx.db.update(t.sessions).set({ status: "waiting" }).where(eq(t.sessions.id, running!.id))
    await mkdir(join(sandboxDir, running!.id), { recursive: true })
    await sweepSandboxDirs(ctx.db)
    expect(existsSync(join(sandboxDir, "R-gone-1"))).toBe(false)
    expect(existsSync(join(sandboxDir, running!.id))).toBe(true)
    await cleanupSessionSandbox(ctx.db, running!.id)
    expect(existsSync(join(sandboxDir, running!.id))).toBe(true)
    await ctx.db.update(t.sessions).set({ status: "done" }).where(eq(t.sessions.id, running!.id))
    await cleanupSessionSandbox(ctx.db, running!.id)
    expect(existsSync(join(sandboxDir, running!.id))).toBe(false)
  })
})
