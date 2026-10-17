// 测试用的本地 MCP 服务器（stdio，每行一条 JSON-RPC）。不依赖任何包，只实现 initialize、tools/list、tools/call。
// 工具 shout：把 text 转成大写；顺便把环境变量 MCP_SECRET 的值带回去，测试检查它会被隐藏。
import { createInterface } from "node:readline"

const tools = [
  {
    name: "shout",
    description: "把文字转成大写",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "ping",
    description: "返回 pong",
    inputSchema: { type: "object", properties: {} },
  },
]

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.id === undefined) return // 通知
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result })
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "echo-test", version: "1.0.0" },
      })
    case "tools/list":
      return reply({ tools })
    case "tools/call": {
      const { name, arguments: args } = message.params
      if (name === "shout")
        return reply({
          content: [
            {
              type: "text",
              text: `${String(args.text).toUpperCase()} (secret=${process.env.MCP_SECRET ?? "none"})`,
            },
          ],
        })
      if (name === "ping")
        return reply({ content: [{ type: "text", text: "pong" }] })
      return reply({
        content: [{ type: "text", text: `没有工具 ${name}` }],
        isError: true,
      })
    }
    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      })
  }
})
