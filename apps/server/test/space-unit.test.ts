// Session 空间和运行代码的单元测试（不连库、不起沙箱）：路径规范化、空间里的路径和去重、file.edit 的替换、
// 出网代理拦内网地址（真起一个代理，连本机的假服务器）、code.run 的输出格式和截断、沙箱参数、workspace 的同步和对比。
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { runtime } from "../src/engine/runtime.js"
import { applyEdits } from "../src/engine/tools/builtin.js"
import {
  assignSpacePaths,
  mimeFromName,
  normalizeSpacePath,
  spaceFileName,
  SpacePathError,
  TEXT_SAVE_EXTENSIONS,
  withSuffix,
  type FileRow,
  type SpaceEntry,
} from "../src/files/service.js"
import { sha256Hex } from "../src/files/storage.js"
import { formatCodeRunOutput, spaceReadPath, tailOf } from "../src/sandbox/code-run.js"
import { EgressProxy, isBlockedAddress, parseAuthority } from "../src/sandbox/proxy.js"
import { buildSandboxArgs } from "../src/sandbox/runner.js"
import { diffWorkspace, prepareWorkspace, sessionDirs } from "../src/sandbox/workspace.js"

const bad = (raw: string) => {
  try {
    normalizeSpacePath(raw)
  } catch (error) {
    expect(error).toBeInstanceOf(SpacePathError)
    return (error as Error).message
  }
  throw new Error(`${raw} 没报错`)
}

describe("路径", () => {
  it("规范化：去掉开头的 / 和 ./；不许 ..、空段、控制字符、反斜杠；长度、层数；保留目录", () => {
    expect(normalizeSpacePath("state/progress.json")).toBe("state/progress.json")
    expect(normalizeSpacePath("  /./a/b.py ")).toBe("a/b.py")
    expect(normalizeSpacePath("//x.txt")).toBe("x.txt")
    expect(normalizeSpacePath("报表/汇总 2026.xlsx")).toBe("报表/汇总 2026.xlsx")
    expect(bad("../etc/passwd")).toContain("..")
    expect(bad("a/../b")).toContain("..")
    expect(bad("a//b")).toContain("空的一段")
    expect(bad("a/./b")).toContain("空的一段")
    expect(bad("dir/")).toContain("空的一段")
    expect(bad("/")).toContain("不能是空的")
    expect(bad("a\nb.txt")).toContain("控制字符")
    expect(bad("a\\b.txt")).toContain("反斜杠")
    expect(bad(`a"b.txt`)).toContain("双引号")
    expect(bad("x".repeat(101))).toContain("这一段太长")
    expect(bad("字".repeat(90))).toContain("这一段太长") // 270 字节，超过文件系统的 255
    expect(bad(`${"a/".repeat(8)}b`)).toContain("最多 8 层")
    expect(bad(`${"abcdefghij/".repeat(7)}${"x".repeat(240)}`)).toContain("最多 300 字")
    expect(bad("attachments/a.txt")).toContain("只读的保留目录")
    expect(bad("Downloads/a.txt")).toContain("只读的保留目录")
    expect(bad("tool-outputs")).toContain("只读的保留目录")
    expect(bad("screenshots/x.png")).toContain("out/x.png")
    expect(normalizeSpacePath("attachments2/a.txt")).toBe("attachments2/a.txt")
  })

  it("读的路径容忍 /workspace/ 开头", () => {
    expect(spaceReadPath("/workspace/state/a.json")).toBe("state/a.json")
    expect(spaceReadPath("./attachments/x.xlsx")).toBe("attachments/x.xlsx")
  })

  it("别的来源的文件名：. 和 .. 换掉，太长的截短并保留扩展名", () => {
    expect(spaceFileName("..")).toBe("file")
    expect(spaceFileName("a/b\tc.txt")).toBe("a_b_c.txt")
    const long = spaceFileName(`${"报".repeat(100)}.xlsx`)
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200)
    expect(long.endsWith(".xlsx")).toBe(true)
    expect(withSuffix("downloads/报表.xlsx", 2)).toBe("downloads/报表-2.xlsx")
    expect(withSuffix("downloads/README", 3)).toBe("downloads/README-3")
    expect(withSuffix(".bashrc", 2)).toBe(".bashrc-2")
  })

  it("代码类型能存，按文本看；.env 不行", () => {
    for (const ext of [".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".bash", ".sql", ".toml", ".ini", ".cfg", ".jsonl"]) {
      expect(TEXT_SAVE_EXTENSIONS).toContain(ext)
      expect(mimeFromName(`a${ext}`).startsWith("text/")).toBe(true)
    }
    expect(mimeFromName("a.py")).toBe("text/x-python")
    expect(mimeFromName("a.sh")).toBe("text/x-shellscript")
    expect(TEXT_SAVE_EXTENSIONS).not.toContain(".env")
  })
})

let fileNo = 0
const row = (input: Partial<FileRow> & Pick<FileRow, "kind" | "name">): FileRow => {
  const at = new Date(Date.UTC(2026, 9, 20, 0, 0, fileNo++))
  return {
    id: `f-${String(fileNo).padStart(4, "0")}`,
    sessionId: "S-1",
    taskId: null,
    mime: mimeFromName(input.name),
    size: 1,
    storagePath: "x",
    sha256: `sha-${fileNo}`,
    createdById: null,
    path: null,
    createdAt: at,
    updatedAt: at,
    ...input,
  }
}

describe("空间里的路径（2.3）", () => {
  it("agent 写的在自己的路径；别的来源放固定目录，同名加 -2 -3；结果和输入顺序无关", () => {
    const rows = [
      row({ kind: "attachment", name: "报价.xlsx", sessionId: null, taskId: "T-1" }),
      row({ kind: "attachment", name: "报价.xlsx" }),
      row({ kind: "download", name: "export.csv" }),
      row({ kind: "download", name: "export.csv" }),
      row({ kind: "download", name: "export.csv" }),
      row({ kind: "screenshot", name: "page.jpg" }),
      row({ kind: "tool_output", name: "http.send-call-1.txt" }),
      row({ kind: "artifact", name: "progress.json", path: "state/progress.json" }),
      row({ kind: "artifact", name: "old.csv" }), // 加路径之前存的产物
      row({ kind: "artifact", name: "old.csv", path: "old.csv" }),
      row({ kind: "upload", name: "x.txt" }),
    ]
    const expected = [
      "attachments/报价.xlsx",
      "attachments/报价-2.xlsx",
      "downloads/export.csv",
      "downloads/export-2.csv",
      "downloads/export-3.csv",
      "screenshots/page.jpg",
      "tool-outputs/http.send-call-1.txt",
      "state/progress.json",
      "old-2.csv", // 有路径的先占住 old.csv
      "old.csv",
      "attachments/x.txt",
    ]
    const entries = assignSpacePaths(rows, "S-1")
    expect(entries.map((entry) => entry.path)).toEqual(expected)
    expect(assignSpacePaths([...rows].reverse(), "S-1").map((entry) => entry.path)).toEqual(expected)
    expect(entries[0]).toMatchObject({ scope: "task", source: "attachment", writable: false })
    expect(entries[7]).toMatchObject({ scope: "session", source: "agent", writable: true })
    expect(entries[2]).toMatchObject({ source: "download", writable: false })
  })
})

describe("file.edit 的替换", () => {
  const text = "a = 1\nb = 2\nc = 1\n"
  it("每段正好出现一次，按顺序替换", () => {
    expect(applyEdits(text, [{ old: "b = 2", new: "b = 3" }])).toEqual({ text: "a = 1\nb = 3\nc = 1\n" })
    // 第二段在第一段替换后的文本里找
    expect(applyEdits(text, [{ old: "a = 1", new: "a = 9" }, { old: "c = 1", new: "" }])).toEqual({ text: "a = 9\nb = 2\n\n" })
  })
  it("找不到、不唯一（重叠的也算）：报错，不给新文本", () => {
    expect(applyEdits(text, [{ old: "= 1", new: "x" }])).toEqual({ error: expect.stringContaining("出现了 2 次") })
    expect(applyEdits(text, [{ old: "b = 2", new: "b = 3" }, { old: "zzz", new: "" }])).toEqual({ error: expect.stringContaining("第 2 段 old 在文件里找不到") })
    expect(applyEdits("aaa", [{ old: "aa", new: "b" }])).toEqual({ error: expect.stringContaining("出现了 2 次") })
  })
})

describe("出网代理", () => {
  it("内网、回环、保留地址一律拦", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fd00::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::a00:1", "ff02::1", "2001:db8::1", "not-an-ip"])
      expect(isBlockedAddress(ip), ip).toBe(true)
    for (const ip of ["8.8.8.8", "93.184.215.14", "172.32.0.1", "100.128.0.1", "198.18.0.1", "2606:4700::1111"]) expect(isBlockedAddress(ip), ip).toBe(false)
  })

  it("CONNECT 的目标解析", () => {
    expect(parseAuthority("example.com:443")).toEqual({ host: "example.com", port: 443 })
    expect(parseAuthority("[::1]:8443")).toEqual({ host: "::1", port: 8443 })
    expect(parseAuthority("example.com")).toBeUndefined()
    expect(parseAuthority("a:99999")).toBeUndefined()
  })

  const dir = mkdtempSync(join(tmpdir(), "heyagent-proxy-"))
  afterAll(() => rm(dir, { recursive: true, force: true }))

  /** 经 unix socket 发一个代理请求，返回状态码和正文 */
  const viaProxy = (socketPath: string, url: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ socketPath, path: url, method: "GET", headers: { host: new URL(url).host } }, (res) => {
        let body = ""
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on("error", reject)
      req.end()
    })
  const connect = (socketPath: string, target: string, send?: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = net.connect(socketPath, () => socket.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n${send ?? ""}`))
      let data = ""
      socket.on("data", (chunk) => {
        data += chunk
        if (send && data.includes(send.toUpperCase())) socket.end()
      })
      socket.on("end", () => resolve(data))
      socket.on("close", () => resolve(data))
      socket.on("error", reject)
    })

  it("拒绝：本机和内网地址（含解析到内网的域名）、不允许的端口；记下拒绝了哪些主机", async () => {
    const proxy = await EgressProxy.start(join(dir, "a.sock"), {
      ports: [80, 443],
      label: "test",
      lookup: async (host) => (host === "evil.test" ? [{ address: "10.0.0.5", family: 4 }] : [{ address: "93.184.215.14", family: 4 }]),
    })
    try {
      const local = await viaProxy(proxy.socketPath, "http://127.0.0.1/")
      expect(local.status).toBe(403)
      expect(local.body).toContain("内网或保留地址")
      expect((await viaProxy(proxy.socketPath, "http://evil.test/")).body).toContain("10.0.0.5")
      expect((await viaProxy(proxy.socketPath, "http://169.254.169.254/latest/meta-data/")).status).toBe(403)
      expect(await connect(proxy.socketPath, "[::1]:443")).toContain("403")
      expect(await connect(proxy.socketPath, "smtp.test:25")).toContain("端口 25 不允许")
      expect(proxy.report()).toMatchObject({ allowed: [], denied: ["127.0.0.1", "evil.test", "169.254.169.254", "[::1]", "smtp.test:25"] })
    } finally {
      await proxy.close()
    }
  })

  it("允许：HTTP 转发和 CONNECT 隧道都通，按主机记字节数（测试里放开地址检查，连本机的假服务器）", async () => {
    const web = http.createServer((req, res) => res.end(`hello ${req.url} ${req.headers.host}`))
    await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve))
    const webPort = (web.address() as net.AddressInfo).port
    const echo = net.createServer((socket) => socket.on("data", (chunk) => socket.write(chunk.toString().toUpperCase())))
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve))
    const echoPort = (echo.address() as net.AddressInfo).port
    const proxy = await EgressProxy.start(join(dir, "b.sock"), {
      ports: [],
      label: "test",
      isBlocked: () => false,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    })
    try {
      const res = await viaProxy(proxy.socketPath, `http://site.test:${webPort}/a?b=1`)
      expect(res).toEqual({ status: 200, body: `hello /a?b=1 site.test:${webPort}` })
      expect(await connect(proxy.socketPath, `tunnel.test:${echoPort}`, "ping")).toContain("200 Connection Established")
      await new Promise((resolve) => setTimeout(resolve, 100))
      const report = proxy.report()
      expect(report.allowed).toEqual([`site.test:${webPort}`, `tunnel.test:${echoPort}`])
      expect(report.denied).toEqual([])
      expect(report.bytes).toBeGreaterThan(0)
      // 还开着的隧道（keep-alive，沙箱退出后才关）也要算进「访问了」（真模型联调时漏过：requests 的连接在报告之后才关）
      const open = net.connect(proxy.socketPath, () => open.write(`CONNECT keepalive.test:${echoPort} HTTP/1.1\r\n\r\n`))
      await new Promise<void>((resolve) => open.once("data", () => resolve()))
      expect(proxy.report().allowed).toContain(`keepalive.test:${echoPort}`)
      open.destroy()
    } finally {
      await proxy.close()
      web.close()
      echo.close()
    }
  })
})

describe("code.run 的输出（3.2）", () => {
  it("第一行、写回、访问、stdout / stderr；没内容的不写", () => {
    expect(
      formatCodeRunOutput({
        exitCode: 0,
        timedOut: false,
        timeoutSec: 60,
        ms: 1234,
        synced: { created: ["out/result.csv"], updated: ["state/progress.json"], deleted: ["tmp/a.txt"] },
        notSynced: [],
        network: { allowed: ["pypi.org", "files.pythonhosted.org"], denied: ["127.0.0.1"] },
        stdout: { text: "ok\n", omitted: 0 },
        stderr: { text: "", omitted: 0 },
      })
    ).toBe(
      [
        "退出码 0 · 用时 1.2 秒",
        "写回空间：新建 out/result.csv；覆盖 state/progress.json；删掉 tmp/a.txt",
        "访问了：pypi.org、files.pythonhosted.org；拒绝：127.0.0.1",
        "--- stdout ---",
        "ok",
      ].join("\n")
    )
    expect(
      formatCodeRunOutput({
        exitCode: 137,
        timedOut: true,
        timeoutSec: 60,
        ms: 60_010,
        synced: { created: [], updated: [], deleted: [] },
        notSynced: [{ path: "big.bin", reason: "超过 50 MB" }],
        network: { allowed: [], denied: [] },
        stderr: { text: "tail", omitted: 25, fullPath: "tool-outputs/code-run-x-stderr.txt" },
      })
    ).toBe(
      [
        "超时（60 秒），整组进程已被杀掉 · 退出码 137 · 用时 60.0 秒",
        "没写回：big.bin（超过 50 MB）",
        "--- stderr ---",
        "…（前面还有 25 字，全文见 tool-outputs/code-run-x-stderr.txt）",
        "tail",
      ].join("\n")
    )
  })

  it("末尾截断：留最后 N 字，不切开代理对", () => {
    expect(tailOf("abcdef", 10)).toEqual({ text: "abcdef", omitted: 0 })
    expect(tailOf("abcdef", 2)).toEqual({ text: "ef", omitted: 4 })
    expect(tailOf("a😀b", 2)).toEqual({ text: "b", omitted: 3 })
  })
})

describe("沙箱参数", () => {
  it("清环境变量、只读根目录、只读挂附件目录、没有 /proc；Node 放宽虚拟内存并限堆", () => {
    const base = {
      script: "/tmp/.code/main.py",
      args: ["--x", "1"],
      timeoutSec: 30,
      workspaceDir: "/s/workspace",
      homeDir: "/s/home",
      codeDir: "/s/code",
      proxyDir: "/s/p",
      readonlyDirs: [{ host: "/s/ro/attachments", name: "attachments" }],
      config: runtime.sandbox,
    }
    const py = buildSandboxArgs({ ...base, language: "python" })
    const text = py.join(" ")
    expect(py.slice(0, 2)).toEqual(["--unshare-all", "--unshare-user"])
    expect(text).toContain("--clearenv")
    expect(text).toContain(`--ro-bind ${runtime.sandbox.rootfs} /`)
    expect(text).toContain("--bind /s/workspace /workspace")
    expect(text).toContain("--ro-bind /s/ro/attachments /workspace/attachments")
    expect(text).toContain("--bind /s/home /home/sandbox")
    expect(text).toContain("--ro-bind /s/p /tmp/.proxy")
    expect(text).not.toContain("--proc")
    expect(text).not.toContain("DATABASE_URL")
    expect(text).toContain("--setenv HTTPS_PROXY http://127.0.0.1:3128")
    // 限制和命令在最后：内存（KB）、CPU 秒、进程数、文件大小，然后是程序
    const tail = py.slice(py.indexOf("heyagent-sandbox") + 1)
    expect(tail).toEqual([String(runtime.sandbox.memoryBytes / 1024), "32", String(runtime.sandbox.maxProcesses), String(runtime.sandbox.spaceMaxBytes / 1024), "python3", "/tmp/.code/main.py", "--x", "1"])
    const node = buildSandboxArgs({ ...base, language: "node" })
    expect(node.slice(node.indexOf("heyagent-sandbox") + 1)[0]).toBe(String(runtime.sandbox.nodeVirtualBytes / 1024))
    expect(node.join(" ")).toContain("--setenv NODE_OPTIONS --max-old-space-size=1024")
  })
})

describe("workspace 的同步和对比", () => {
  const base = mkdtempSync(join(tmpdir(), "heyagent-ws-"))
  afterAll(() => rm(base, { recursive: true, force: true }))
  const contents = new Map<string, Buffer>()
  const entry = (path: string, data: string, input: Partial<FileRow> & Pick<FileRow, "kind">): SpaceEntry => {
    const r = row({ name: path.split("/").pop()!, path: input.kind === "artifact" ? path : null, sha256: sha256Hex(Buffer.from(data)), ...input })
    contents.set(r.id, Buffer.from(data))
    const writable = input.kind === "artifact"
    return { row: r, path, scope: "session", source: writable ? "agent" : "attachment", writable }
  }
  let reads = 0
  const read = async (each: SpaceEntry) => {
    reads++
    return contents.get(each.row.id)!
  }

  it("准备：可写的放 workspace、只读的放 ro；第二次只拉变了的；空间里没有的删掉；跑完对比出新建、改动、删掉，touch 不算改", async () => {
    const dirs = sessionDirs(base, "R-1-1")
    const state = entry("state/progress.json", '{"done":1}', { kind: "artifact" })
    const script = entry("scripts/a.py", "print(1)", { kind: "artifact" })
    const attachment = entry("attachments/报价.xlsx", "xlsx", { kind: "attachment" })
    let prepared = await prepareWorkspace(dirs, [state, script, attachment], read)
    expect(reads).toBe(3)
    expect(await readFile(join(dirs.workspace, "state/progress.json"), "utf8")).toBe('{"done":1}')
    expect(await readFile(join(dirs.ro, "attachments/报价.xlsx"), "utf8")).toBe("xlsx")
    expect(prepared.readonlyDirs.map((dir) => dir.name)).toEqual(["attachments", "downloads", "screenshots", "tool-outputs"])
    expect([...prepared.before.keys()].sort()).toEqual(["scripts/a.py", "state/progress.json"])

    // 模拟代码跑了一次：改一个、touch 一个、删一个、新建几个、建符号链接、在 node_modules 里装包
    await writeFile(join(dirs.workspace, "state/progress.json"), '{"done":2}')
    await writeFile(join(dirs.workspace, "scripts/a.py"), "print(1)") // 内容没变
    await mkdir(join(dirs.workspace, "out"), { recursive: true })
    await writeFile(join(dirs.workspace, "out/result.csv"), "a,b")
    await symlink("/etc/passwd", join(dirs.workspace, "out/link"))
    await mkdir(join(dirs.workspace, "node_modules/x"), { recursive: true })
    await writeFile(join(dirs.workspace, "node_modules/x/index.js"), "")
    await mkdir(join(dirs.workspace, `${"d/".repeat(9)}`), { recursive: true })
    await writeFile(join(dirs.workspace, `${"d/".repeat(9)}deep.txt`), "x")
    await rm(join(dirs.workspace, "scripts/a.py"))
    await writeFile(join(dirs.workspace, "scripts/a.py"), "print(1)") // 删了重建、内容一样：不算改
    let diff = await diffWorkspace(prepared)
    expect(diff.changes.map((change) => [change.path, change.kind])).toEqual([
      ["out/result.csv", "create"],
      ["state/progress.json", "update"],
    ])
    expect(diff.deleted).toEqual([])
    expect(diff.skipped.map((item) => item.path)).toEqual([`${"d/".repeat(9)}deep.txt`, "out/link"])

    // 只读的文件在 ro 下，代码改不了（这里直接看权限）
    await expect(writeFile(join(dirs.ro, "attachments/报价.xlsx"), "x")).rejects.toThrow()

    // 第二次准备：空间里 state 变了（假装写回了）、out/result.csv 没写回（例如超限）、scripts/a.py 被 file.delete 删了
    const state2 = entry("state/progress.json", '{"done":2}', { kind: "artifact", id: state.row.id })
    reads = 0
    prepared = await prepareWorkspace(dirs, [state2, attachment], read)
    expect(reads).toBe(1) // 只有 state 变了；附件没变不重写
    const left = readdirSync(dirs.workspace).sort()
    // 空目录留着（scripts/ 里的文件被删了，目录还在）
    expect(left).toEqual(["attachments", "d", "downloads", "node_modules", "out", "screenshots", "scripts", "state", "tool-outputs"])
    expect(existsSync(join(dirs.workspace, "out/result.csv"))).toBe(false)
    expect(existsSync(join(dirs.workspace, "out/link"))).toBe(false)
    expect(existsSync(join(dirs.workspace, "scripts/a.py"))).toBe(false)
    expect(existsSync(join(dirs.workspace, "node_modules/x/index.js"))).toBe(true)

    // 代码删掉一个、把一个改成读不了
    await rm(join(dirs.workspace, "state/progress.json"))
    await writeFile(join(dirs.workspace, "x.txt"), "x")
    await chmod(join(dirs.workspace, "x.txt"), 0o000)
    diff = await diffWorkspace(prepared)
    expect(diff.deleted).toEqual(["state/progress.json"])
    expect(diff.skipped.map((item) => item.path)).toContain("x.txt")
    await chmod(join(dirs.workspace, "x.txt"), 0o644)
  })
})
