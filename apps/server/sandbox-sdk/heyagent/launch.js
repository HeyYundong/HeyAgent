// 固化脚本的启动器（docs/dev/solidify.md 15.2 第 4 条）：沙箱里跑的就是它（node launch.js）。
// 从 stdin 读这次的输入（{ "input": … }），载入代码目录里的 routine.mjs，调它的 export default async function run(input)，
// 结束时（跑完、抛了错）向工具桥报 done，然后退出。脚本自己的 import 只能是 heyagent（程序检查管）。
// agent 调库流程（docs/dev/routine-library.md 5.2，工具桥 mode = tool）：stdin 多一个 { "library": { "slug": 短名 } }，
// routine.mjs 是那个库流程；顶层也按嵌套的规矩跑（ha.finish、ha.work.report 只收下来，ha.fail 不发请求），
// 跑完把结局放在 done 的 routine 里（{ end, finish?, data, kind?, error?, name?, steps }）。
import { readFileSync } from "node:fs"

import ha, { __finish, __runLibraryRoot, __start } from "./index.js"

let parsed = {}
try {
  const raw = readFileSync(0, "utf8")
  parsed = raw.trim() ? JSON.parse(raw) : {}
} catch (error) {
  await __finish({ ok: false, error: `读不了输入：${error?.message ?? error}`, name: "Error" })
  process.exit(0)
}
__start(parsed.input)

/** 代码目录：<目录>/routine.mjs，SDK 在 <目录>/node_modules/heyagent/ */
async function load() {
  const routine = await import(new URL("../../routine.mjs", import.meta.url).href)
  if (typeof routine.default !== "function") throw new Error("脚本没有 export default async function run(input)")
  return routine.default
}

if (parsed.library && typeof parsed.library === "object") {
  const outcome = await __runLibraryRoot(parsed.library.slug, async (input) => (await load())(input))
  const { stack, ...routine } = outcome
  await __finish({
    ok: outcome.end === "finished",
    ...(outcome.end === "error" ? { error: outcome.error, name: outcome.name, ...(stack ? { stack } : {}) } : {}),
    routine,
  })
  process.exit(0)
}

let result = { ok: true }
try {
  await (await load())(ha.input)
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
