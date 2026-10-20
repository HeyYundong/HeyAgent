// 真沙箱的集成测试：只在 HEYAGENT_SANDBOX_IT=1 时跑，要在 worker 镜像里（有 bwrap、setpriv、/opt/sandbox-root），
// 带上和 pod 里 worker 一样的限制（--cap-drop=all --cap-add=SYS_CHROOT --security-opt no-new-privileges），能连测试库、能上外网。
// 跑法见 docs/dev/session-space.md「实现记录」。走完整引擎：假模型按剧本调 code.run，断言工具输出和空间里的文件。
import { existsSync, mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { configureEngine, runtime } from "../src/engine/runtime.js"
import { saveFile } from "../src/files/service.js"
import { loadBook, overviewText } from "../src/files/sheets.js"
import { sessionDirs } from "../src/sandbox/workspace.js"
import { login } from "./helpers.js"
import { call, createTask, eventsOf, mutate, Script, setupEngine, step, text, useScript, waitFor, waitStatus, type EngineTestContext } from "./engine-helpers.js"

const enabled = process.env.HEYAGENT_SANDBOX_IT === "1"

describe.skipIf(!enabled)("真沙箱（worker 镜像里）", () => {
  let ctx: EngineTestContext
  let wang: string
  const sandboxDir = mkdtempSync(join(tmpdir(), "heyagent-sandbox-it-"))

  beforeAll(async () => {
    // 模拟 worker 进程里的密钥：沙箱里不能看到
    process.env.HEYAGENT_IT_SECRET = "it-secret-value-123"
    ctx = await setupEngine()
    wang = await login(ctx.app, "wangyue@heyagent.local")
    configureEngine({ sandbox: { ...runtime.sandbox, dir: sandboxDir } })
  }, 120_000)

  afterAll(async () => {
    await ctx?.stop()
    await rm(sandboxDir, { recursive: true, force: true })
  })

  it("Python + pandas 读附件、写 xlsx 回空间；Node；bash；环境变量和密钥看不到；超时杀整组；内存上限；出网代理放行公网、拦内网；pip 装的包这次运行里一直有效", async () => {
    const attached = await saveFile(ctx.db, { data: Buffer.from("名称,数量,单价\n苹果,3,2.5\n梨,4,1.5\n"), name: "报价.csv", kind: "upload" })
    const pandas = [
      "import pandas as pd, json",
      "df = pd.read_csv('/workspace/attachments/报价.csv')",
      "df['金额'] = df['数量'] * df['单价']",
      "import os; os.makedirs('out', exist_ok=True)",
      "df.to_excel('out/报表.xlsx', index=False)",
      "state = json.load(open('state/progress.json'))",
      "state['step'] = 2",
      "json.dump(state, open('state/progress.json', 'w'))",
      "print('合计', df['金额'].sum())",
    ].join("\n")
    const env = [
      "env | sort",
      "echo ---",
      "ls /app /data /run/heyagent-secrets /proc/1 2>&1 | head -5",
      "echo uid=$(id -u) host=$(hostname)",
      "cat /etc/os-release | head -1",
    ].join("\n")
    const net = [
      "curl -sS -o /dev/null -w 'example %{http_code}\\n' --max-time 20 https://example.com",
      // NO_PROXY 里有 localhost / 127.0.0.1（沙箱自己的回环）：--noproxy '' 强制走代理，看代理拦不拦
      "curl -sS --noproxy '' --max-time 5 http://127.0.0.1/ ; echo",
      "curl -sS --max-time 5 http://169.254.169.254/latest/meta-data/ ; echo",
      "curl -sS --noproxy '' --max-time 5 http://localhost:8080/ ; echo",
      "curl -sS --max-time 5 http://127.0.0.1:5432/ 2>&1 | tail -1",
      "curl -sS --max-time 5 http://example.com:5432/ ; echo",
      "curl -sS --noproxy '*' --max-time 5 https://1.1.1.1/ >/dev/null 2>&1 && echo DIRECT-OK || echo direct-blocked",
      "python3 -c \"import socket; s=socket.socket(); s.settimeout(3)\ntry:\n  s.connect(('1.1.1.1', 443)); print('RAW-OK')\nexcept Exception as e: print('raw-blocked', type(e).__name__)\"",
      "python3 -c \"import requests; print('requests', requests.get('https://example.com', timeout=20).status_code)\"",
    ].join("\n")
    useScript(
      "test/sandbox-it",
      new Script([
        step([
          call("file.save", { path: "state/progress.json", content: '{"step":1}' }),
          call("file.save", { path: "old.txt", content: "old" }),
          call("file.save", { path: "scripts/hello.js", content: "const fs = require('fs')\nfs.mkdirSync('out', { recursive: true })\nfs.writeFileSync('out/n.json', JSON.stringify({ v: process.version, argv: process.argv.slice(2) }))\nconsole.log('node', process.version, process.argv.slice(2).join(' '))\n" }),
        ]),
        step([
          call("code.run", { language: "python", code: pandas }), // 0
          call("code.run", { language: "node", file: "scripts/hello.js", args: ["a", "b c"] }), // 1
          call("code.run", { language: "bash", code: env }), // 2
          call("code.run", { language: "bash", code: "echo start; sleep 100 & sleep 100", timeout: 3 }), // 3
          call("code.run", { language: "python", code: "while True: pass", timeout: 3 }), // 4
          call("code.run", { language: "python", code: "x = bytearray(2 * 1024 ** 3)\nprint('ALLOCATED')" }), // 5
          call("code.run", { language: "node", code: "const a = []; for (;;) a.push(new Array(1e6).fill(1))", timeout: 60 }), // 6
          call("code.run", { language: "bash", code: net, timeout: 90 }), // 7
          call("code.run", { language: "bash", code: "pip install -q tabulate 2>&1 | tail -2; python3 -c 'import tabulate; print(\"tabulate\", tabulate.__version__)'", timeout: 180 }), // 8
          call("code.run", { language: "bash", code: "python3 -c 'import tabulate; print(\"still\", tabulate.__version__)'; ls /tmp; echo tmp-file > /tmp/x; rm old.txt; mkdir -p out; ln -s /etc/passwd out/link; echo hi > /workspace/attachments/x 2>&1 || echo attachments-readonly; for i in $(seq 1500); do sleep 20 & done", timeout: 10 }), // 9
          call("code.run", { language: "bash", code: "ls /tmp; echo stdin=$(cat); echo $0 $1 $2", args: ["x", "y"], stdin: "hello" }), // 10
        ]),
        step([text("做完了")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/sandbox-it", toolIds: ["code.run"] })
    const res = await mutate(ctx.app, "engine.runNow", wang, { taskId, attachmentFileIds: [attached.id] })
    const sessionId = res.data!.sessionId as string
    await waitStatus(ctx.db, sessionId, "done", 600_000)
    const runs = (await eventsOf(ctx.db, sessionId)).filter((event) => event.kind === "tool" && event.toolId === "code.run").map((event) => event.output ?? "")
    for (const [index, output] of runs.entries()) console.log(`\n===== code.run ${index} =====\n${output}`)

    // 0：pandas 读附件、写 xlsx、改状态文件
    expect(runs[0]).toMatch(/^退出码 0 · 用时/)
    expect(runs[0]).toContain("写回空间：新建 out/报表.xlsx；覆盖 state/progress.json")
    expect(runs[0]).toContain("合计 13.5")
    const [xlsx] = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.path, "out/报表.xlsx")))
    expect(overviewText(await loadBook(xlsx!), "out/报表.xlsx", 5000)).toContain("苹果\t3\t2.5\t7.5")
    // 1：Node 24，参数照传
    expect(runs[1]).toMatch(/node v24\.\d+\.\d+ a b c/)
    expect(runs[1]).toContain("新建 out/n.json")
    // 2：环境变量清空、密钥和 worker 的目录都看不到、没有 /proc、不是 root、独立的 Debian
    expect(runs[2]).not.toContain("it-secret-value-123")
    expect(runs[2]).not.toContain("DATABASE_URL")
    expect(runs[2]).not.toContain("OPENROUTER")
    expect(runs[2]).not.toContain("KEK")
    expect(runs[2]).toContain("HOME=/home/sandbox")
    expect(runs[2]).toMatch(/ls: cannot access '\/app'/)
    expect(runs[2]).toMatch(/ls: cannot access '\/proc\/1'/)
    expect(runs[2]).toContain("Debian GNU/Linux 12")
    // 3、4：超时杀整组（后台进程也没了），死循环同样被杀
    expect(runs[3]).toMatch(/^超时（3 秒），整组进程已被杀掉 · 退出码 137 · 用时 3\.\d 秒/)
    expect(runs[3]).toContain("start")
    expect(runs[4]).toMatch(/^超时（3 秒），整组进程已被杀掉 · 退出码 137/)
    // 5、6：内存上限
    expect(runs[5]).toContain("MemoryError")
    expect(runs[5]).not.toContain("ALLOCATED")
    expect(runs[6]).toMatch(/heap out of memory|Allocation failed/)
    expect(runs[6]).not.toMatch(/^退出码 0/)
    // 7：出网代理：公网放行，内网、本机、元数据地址拦下，直连不通
    expect(runs[7]).toContain("example 200")
    expect(runs[7]).toContain("requests 200")
    expect(runs[7]).toMatch(/127\.0\.0\.1 是内网或保留地址/)
    expect(runs[7]).toMatch(/169\.254\.169\.254 是内网或保留地址/)
    expect(runs[7]).toMatch(/localhost 是内网或保留地址/)
    expect(runs[7]).toContain("端口 5432 不允许")
    // 沙箱自己的回环上没有 pod 的 Postgres
    expect(runs[7]).toMatch(/Failed to connect to 127\.0\.0\.1 port 5432/)
    expect(runs[7]).toContain("direct-blocked")
    expect(runs[7]).toContain("raw-blocked")
    expect(runs[7]).toMatch(/访问了：example\.com/)
    expect(runs[7]).toContain("拒绝：127.0.0.1、169.254.169.254、localhost:8080、example.com:5432")
    // 8、9：pip 装进 home，下一次还在；/tmp 每次是新的；删掉的文件空间里也删；符号链接不写回；附件只读；fork 炸弹被挡
    expect(runs[8]).toMatch(/tabulate \d+\.\d+/)
    expect(runs[8]).toMatch(/访问了：.*pypi\.org/)
    expect(runs[9]).toMatch(/still \d+\.\d+/)
    expect(runs[9]).toContain("删掉 old.txt")
    expect(runs[9]).toContain("out/link（是符号链接，不跟随）")
    expect(runs[9]).toMatch(/Read-only file system|attachments-readonly/)
    expect(runs[9]).toMatch(/Resource temporarily unavailable|retry: /)
    expect(runs[10]).not.toContain("x\n") // 上一次写的 /tmp/x 没了
    expect(runs[10]).toContain("stdin=hello")
    expect(runs[10]).toMatch(/main\.sh x y/)
    const [old] = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.path, "old.txt")))
    expect(old).toBeUndefined()

    // 运行结束：沙箱目录删掉了
    // 状态在 runSession 里就改成 done，删目录在任务收尾时做：等一下
    await waitFor(async () => !existsSync(sessionDirs(sandboxDir, sessionId).root), { what: "沙箱目录删掉" })
  }, 600_000)
})
