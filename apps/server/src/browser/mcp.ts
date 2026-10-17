// Playwright MCP（0.0.83）：每个 session 的 Chrome 配一个 stdio 进程，用 --cdp-endpoint 连我们自己起的 Chrome。
// 工具清单和 Chrome 无关（不连浏览器也能列出来），进程里只列一次、缓存起来，建工具网关时就能把工具交给模型，
// Chrome 等第一次真正调浏览器工具时才起（懒启动）。
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp"
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio"
import type { McpToolInfo } from "@heyagent/shared"

const require = createRequire(import.meta.url)

/** @playwright/mcp 的 package.json 只导出了 "." 和 package.json，cli.js 按目录找 */
export function mcpCliPath() {
  return join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js")
}

/** 一律屏蔽：RCE 等价，能拿到包括 HttpOnly 在内的全部 cookie（m2.md 第 1 条） */
export const BLOCKED_MCP_TOOLS = new Set(["browser_run_code_unsafe"])
/** 任务设置里打开「允许执行脚本」才给 */
export const EVALUATE_TOOL = "browser_evaluate"

function baseArgs(cdpEndpoint: string, outputDir: string) {
  return [
    mcpCliPath(),
    "--cdp-endpoint",
    cdpEndpoint,
    "--output-dir",
    outputDir,
    // 截图只存档，不回传给模型（m2.md 第 1 条）
    "--image-responses",
    "omit",
    // 动作类工具的返回不带快照（0.0.83 只给一个 agent 读不到的 .yml 链接），要看页面就显式调 browser_snapshot
    "--snapshot-mode",
    "none",
    "--codegen",
    "none",
    // 网页自己注册的工具不收（不受我们的网关管）
    "--no-webmcp",
  ]
}

let toolList: Promise<McpToolInfo[]> | undefined

/** Playwright MCP 的工具清单（进程里只列一次） */
export function listBrowserMcpTools(): Promise<McpToolInfo[]> {
  toolList ??= (async () => {
    const transport = new Experimental_StdioMCPTransport({
      command: process.execPath,
      // 列工具不连浏览器：给一个连不上的地址就行
      args: baseArgs("ws://127.0.0.1:9/devtools/browser/none", "/tmp"),
      stderr: "ignore",
    })
    const client = await createMCPClient({ transport, clientName: "heyagent", initializationOptions: { timeout: 30_000 } })
    try {
      const result = await client.listTools({ options: { timeout: 30_000 } })
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      }))
    } finally {
      await client.close().catch(() => {})
    }
  })()
  toolList.catch(() => {
    toolList = undefined
  })
  return toolList
}

export interface BrowserMcp {
  client: MCPClient
  close(): Promise<void>
}

/** 起一个连到这个 Chrome 的 MCP 进程。工作目录 = session 的临时目录（MCP 只能读写这里，上传的文件也放这里） */
export async function startBrowserMcp(cdpEndpoint: string, workDir: string, outputDir: string): Promise<BrowserMcp> {
  const transport = new Experimental_StdioMCPTransport({
    command: process.execPath,
    args: baseArgs(cdpEndpoint, outputDir),
    cwd: workDir,
    // 只给最少的环境变量（getEnvironment 会再补 PATH、HOME 等几个安全的），不把数据库地址、主密钥路径带进去
    env: { HOME: workDir, TMPDIR: join(dirname(workDir), "tmp"), TZ: process.env.TZ ?? "Asia/Shanghai" },
    stderr: "ignore",
  })
  const client = await createMCPClient({ transport, clientName: "heyagent", initializationOptions: { timeout: 30_000 } })
  return {
    client,
    async close() {
      await client.close().catch(() => {})
    },
  }
}
