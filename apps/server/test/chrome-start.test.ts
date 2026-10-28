// 起 Chrome（docs/dev/sub-agents.md 21.3 第 3、4 条）：同一个进程里排队一个一个起、启动超时自动再起一次、运行被停掉时马上杀掉。
// 开发机上没有 Chrome：用一个假的「Chrome」脚本（按 user-data-dir 里的 plan 文件决定每次是卡住还是过几秒报 DevTools 地址）。
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

type ChromeModule = typeof import("../src/browser/chrome.js")

const root = mkdtempSync(join(tmpdir(), "heyagent-fake-chrome-"))
const bin = join(root, "chrome")
// 每起一次记一行：start <毫秒> <pid> <目录>、ready <毫秒> <pid> <目录>；plan 第 n 行是第 n 次怎么做（hang = 一直不报地址，数字 = 过几秒报）
writeFileSync(
  bin,
  `#!/bin/sh
dir="$HOME"
n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/count"
plan=$(sed -n "\${n}p" "$dir/plan")
echo "start $(date +%s%3N) $$ $dir" >> "$dir/../log"
if [ "$plan" = "hang" ]; then exec sleep 60; fi
sleep "$plan"
echo "ready $(date +%s%3N) $$ $dir" >> "$dir/../log"
echo "DevTools listening on ws://127.0.0.1:9/devtools/browser/fake-$n" >&2
exec sleep 60
`
)
chmodSync(bin, 0o755)

let chrome: ChromeModule
const handles: { proc: import("node:child_process").ChildProcess }[] = []
let caseNo = 0

beforeAll(async () => {
  process.env.CHROME_BIN = bin
  chrome = await import("../src/browser/chrome.js")
})

afterEach(async () => {
  for (const handle of handles.splice(0)) await chrome.killGroup(handle.proc, 500)
  chrome.chromeStart.timeoutMs = 30_000
  chrome.chromeStart.retries = 1
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

/** 一组「Chrome」：同一个父目录（共用 log），每个一个 user-data-dir，写好 plan */
function group(plans: string[][]) {
  const base = join(root, `case-${++caseNo}`)
  mkdirSync(base)
  const dirs = plans.map((plan, index) => {
    const dir = join(base, `p${index}`)
    mkdirSync(dir)
    writeFileSync(join(dir, "plan"), `${plan.join("\n")}\n`)
    return dir
  })
  const log = () =>
    readFileSync(join(base, "log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [what, at, pid, dir] = line.split(" ")
        return { what: what!, at: Number(at), pid: Number(pid), dir: dir! }
      })
  return { dirs, log }
}

const options = (dir: string) => ({ userDataDir: dir, display: 99 })
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("起 Chrome", () => {
  it("同一个进程里排队：前一个报了地址，后一个才开始起", async () => {
    const { dirs, log } = group([["0.4"], ["0.4"]])
    const [a, b] = await Promise.all(dirs.map((dir) => chrome.startChrome(options(dir))))
    handles.push(a!, b!)
    expect([a!.wsEndpoint, b!.wsEndpoint]).toEqual(["ws://127.0.0.1:9/devtools/browser/fake-1", "ws://127.0.0.1:9/devtools/browser/fake-1"])
    const lines = log()
    expect(lines.map((line) => `${line.what} ${line.dir === dirs[0] ? "a" : "b"}`)).toEqual(["start a", "ready a", "start b", "ready b"])
    expect(lines[2]!.at).toBeGreaterThanOrEqual(lines[1]!.at)
  })

  it("启动超时自动再起一次：第一次卡住的被杀掉，第二次起来了；两次都超时才报错", async () => {
    chrome.chromeStart.timeoutMs = 400
    const once = group([["hang", "0.1"]])
    const handle = await chrome.startChrome(options(once.dirs[0]!))
    handles.push(handle)
    expect(handle.wsEndpoint).toBe("ws://127.0.0.1:9/devtools/browser/fake-2")
    const first = once.log()[0]!
    expect(alive(first.pid)).toBe(false)

    const twice = group([["hang", "hang", "0.1"]])
    const error = await chrome.startChrome(options(twice.dirs[0]!)).catch((each: unknown) => each)
    expect(error).toBeInstanceOf(chrome.ChromeStartTimeoutError)
    expect((error as Error).message).toContain("Chrome 启动超时（试了 2 次，每次 0 秒）")
    // 只试两次，两次的进程都杀掉了
    const starts = twice.log().filter((line) => line.what === "start")
    expect(starts).toHaveLength(2)
    for (const line of starts) expect(alive(line.pid)).toBe(false)
  })

  it("运行被停掉：正在起的马上杀掉、不再试；排队的不再等", async () => {
    const { dirs, log } = group([["hang"], ["0.1"]])
    const running = new AbortController()
    const queued = new AbortController()
    const startedAt = Date.now()
    const first = chrome.startChrome(options(dirs[0]!), running.signal).catch((each: unknown) => each)
    const second = chrome.startChrome(options(dirs[1]!), queued.signal).catch((each: unknown) => each)
    await new Promise((resolve) => setTimeout(resolve, 300))
    // 第二个还在排队：停掉它，马上返回，没起过
    queued.abort()
    expect(await second).toBeInstanceOf(chrome.ChromeStartAbortedError)
    // 第一个正在起（卡住）：停掉它，不等 30 秒超时
    running.abort()
    expect(await first).toBeInstanceOf(chrome.ChromeStartAbortedError)
    expect(Date.now() - startedAt).toBeLessThan(5000)
    const lines = log()
    expect(lines.map((line) => line.dir)).toEqual([dirs[0]])
    expect(alive(lines[0]!.pid)).toBe(false)
    // 停掉的都放开了排队：下一个照常起
    const next = group([["0.1"]])
    handles.push(await chrome.startChrome(options(next.dirs[0]!)))
  })

  it("已经停掉的运行不起 Chrome", async () => {
    const { dirs } = group([["0.1"]])
    const controller = new AbortController()
    controller.abort()
    expect(await chrome.startChrome(options(dirs[0]!), controller.signal).catch((each: unknown) => each)).toBeInstanceOf(chrome.ChromeStartAbortedError)
  })
})
