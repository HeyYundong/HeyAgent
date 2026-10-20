// 工具页留在前端的东西：弹窗里的说明和示例文字。（「连接并读取工具」走 engine.listMcpServerTools，读到的是服务器上真实的工具）
// 给模型看的完整说明、风险说明、已存的密钥都来自接口（Tool.description、shared 的 riskNotes、tools.list 的 savedSecrets）。

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
  paramsHint:
    "模板里每个 {参数} 一行，由模型填。文本：按文字填，JSON 请求体里自动转义、加引号；JSON：原样放进去（数组、对象、数字），写在 JSON 的引号外面，例如 \"candidates\": {candidates}。不必填的没传时填空（文本填空字符串，JSON 填 null）；勾了「没传就去掉」，就整段去掉：JSON 里那个字段、URL 里那个查询参数、那一行请求头。",
  bodyPlaceholder: '{"weight_kg": "{weight}"}',
}
