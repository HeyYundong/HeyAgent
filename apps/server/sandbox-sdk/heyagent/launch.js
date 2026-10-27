// 固化脚本的启动器（docs/dev/solidify.md 15.2 第 4 条）：沙箱里跑的就是它（node launch.js）。
// 从 stdin 读这次的输入（{ "input": … }），载入代码目录里的 routine.mjs，调它的 export default async function run(input)，
// 结束时（跑完、抛了错）向工具桥报 done，然后退出。脚本自己的 import 只能是 heyagent（程序检查管）。
import { readFileSync } from "node:fs"

import ha, { __finish, __start } from "./index.js"

let parsed = {}
try {
  const raw = readFileSync(0, "utf8")
  parsed = raw.trim() ? JSON.parse(raw) : {}
} catch (error) {
  await __finish({ ok: false, error: `读不了输入：${error?.message ?? error}`, name: "Error" })
  process.exit(0)
}
__start(parsed.input)

let result = { ok: true }
try {
  // 代码目录：<目录>/routine.mjs，SDK 在 <目录>/node_modules/heyagent/
  const routine = await import(new URL("../../routine.mjs", import.meta.url).href)
  if (typeof routine.default !== "function") throw new Error("脚本没有 export default async function run(input)")
  await routine.default(ha.input)
} catch (error) {
  result = {
    ok: false,
    error: String(error?.message ?? error).slice(0, 2000),
    name: String(error?.name ?? "Error"),
    ...(error?.stack ? { stack: String(error.stack).slice(0, 4000) } : {}),
  }
}
await __finish(result)
process.exit(0)
