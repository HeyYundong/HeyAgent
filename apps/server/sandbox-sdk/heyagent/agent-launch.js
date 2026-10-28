// agent 用 code.run（tools: true）跑的脚本的启动器（docs/dev/solidify.md 18.1）：沙箱里跑的是 node agent-launch.js <脚本> [参数…]。
// 先让 import "heyagent" / require("heyagent") 在任何位置都指向这份 SDK（脚本可能是 /workspace 里存的文件，那里没有 node_modules），
// 再把 process.argv 换成「node <脚本> [参数…]」，载入脚本。脚本是普通程序（ESM、CommonJS 都行），跑完就退出；
// 没接住的错照常打到 stderr、退出码 1。
import { registerHooks } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const sdk = new URL("./index.js", import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "heyagent") return { url: sdk, format: "module", shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const [script, ...args] = process.argv.slice(2)
if (!script) {
  console.error("agent-launch.js：没有给要跑的脚本")
  process.exit(2)
}
const full = resolve(script)
process.argv = [process.argv[0], full, ...args]
await import(pathToFileURL(full).href)
