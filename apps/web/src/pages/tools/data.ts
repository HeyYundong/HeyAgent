// 工具页留在前端的东西：模拟「连接 MCP 后发现的工具」（M1 接真实的「连接并读取工具」后去掉）、弹窗里的说明和示例文字。
// 给模型看的完整说明、风险说明、已存的密钥都来自接口（Tool.description、shared 的 riskNotes、tools.list 的 savedSecrets）。

import type { Risk } from "@heyagent/shared"

/** 模拟「连接并读取工具」后发现的工具 */
export interface Discovered {
  id: string
  name: string
  summary: string
  risk: Risk
}

/** 已有服务器上还没加入的工具（编辑时重新读取会多出来） */
export const MORE_ON_SERVER: Record<string, Discovered[]> = {
  "mcp-playwright": [
    { id: "browser.pdf", name: "网页存 PDF", summary: "把当前页面存成 PDF", risk: "read" },
    { id: "browser.tabs", name: "切换标签页", summary: "列出、打开或关闭浏览器标签页", risk: "read" },
  ],
  "mcp-erp": [
    { id: "erp.stock", name: "查库存", summary: "按 SKU 查仓库库存和在途数量", risk: "read" },
  ],
}

/** 新服务器：按命令或地址里的关键词挑一组模拟结果，认不出就用第一组 */
export const DISCOVER_SAMPLES: { keyword: string; tools: Discovered[] }[] = [
  {
    keyword: "feishu",
    tools: [
      { id: "bitable.search", name: "查多维表格", summary: "按条件查询飞书多维表格里的记录", risk: "read" },
      { id: "bitable.create", name: "新增记录", summary: "往飞书多维表格里新增一行", risk: "write" },
      { id: "bitable.update", name: "更新记录", summary: "修改飞书多维表格里的一行", risk: "write" },
      { id: "im.send", name: "发飞书消息", summary: "给同事或群发一条飞书消息", risk: "write" },
    ],
  },
  {
    keyword: "filesystem",
    tools: [
      { id: "fs.read", name: "读文件", summary: "读取共享盘里的一个文件", risk: "read" },
      { id: "fs.list", name: "列目录", summary: "列出共享盘某个目录下的文件", risk: "read" },
      { id: "fs.write", name: "写文件", summary: "在共享盘里新建或覆盖一个文件", risk: "write" },
    ],
  },
]

/** 新建 / 编辑工具弹窗里的说明和示例文字 */
export const DIALOG_TEXT = {
  mcpHint: "填好启动命令或地址，连上后会列出服务器提供的工具，勾选要加入的。",
  httpHint: "填一个外部接口的请求模板。最快的办法：在浏览器开发者工具里「复制为 cURL」，粘贴到下面。",
  stdioHint: "在 HeyAgent 服务器上启动这个命令，通过标准输入输出通信。",
  mcpHttpHint: "MCP 服务已经在别处运行，填它的地址。",
  stdioPlaceholder: "npx -y @larksuiteoapi/lark-mcp mcp --tools bitable,im",
  mcpUrlPlaceholder: "http://192.168.31.40:3000/mcp",
  envPlaceholder: "FEISHU_APP_ID=cli_xxx\nFEISHU_APP_SECRET=xxx",
  curlPlaceholder: `curl -X POST https://api.example.com/v1/quotes \\
  -H "Authorization: Bearer {{API_TOKEN}}" \\
  -H "Content-Type: application/json" \\
  -d '{"weight_kg": "{weight}"}'`,
  descriptionPlaceholder: "例如：传入重量和尺寸，返回几家物流的报价和时效。只在要给客户报运费时用。",
  urlPlaceholder: "https://api.example.com/v1/{path}",
  leakHint: "改成 {{名字}}，值填到下面「密钥」里。",
  secretsHint: "模板里每个 {{名字}} 一个值。存在服务器上，模型和页面都看不到原文。",
  envHint: "每行一个「名字=值」，一般放密钥。值只存在服务器上，这里填的值同样不会给模型看。",
  bodyHint: "用 {参数} 标出要模型填的地方，{{名字}} 是密钥。",
  bodyPlaceholder: '{"weight_kg": "{weight}"}',
}
