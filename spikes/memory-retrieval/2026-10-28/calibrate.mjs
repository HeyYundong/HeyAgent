// 记忆自动挑选的相似度门槛标定（docs/dev/memory-retrieval.md 9.3）：用真 embedding 模型算 30 条示例记忆和 10 个查询的余弦相似度，
// 看「该挑的」和「不该挑的」分数分布，找能留住九成该挑的、又挡掉绝大多数不该挑的门槛。
// 示例记忆和查询只是测试数据（通用的办公事务），不进产品代码。拼法和产品一致：记忆 = 「适用于\n内容」，查询 = 标题、目标、步骤一项一行。
// 用法（在仓库根目录）：node spikes/memory-retrieval/2026-10-28/calibrate.mjs .env [模型...]
// 结果写到同目录的 results-<模型>.json；key 只从 .env 读，不打印。
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const envFile = process.argv[2] ?? ".env"
const models = process.argv.slice(3).length ? process.argv.slice(3) : ["google/gemini-embedding-2"]
const key = readFileSync(envFile, "utf8").match(/^OPENROUTER_API_KEY=(.*)$/m)?.[1]?.trim()
if (!key) throw new Error(`没在 ${envFile} 里找到 OPENROUTER_API_KEY`)

const memories = [
  ["d1", "文档 · 共享盘", "共享盘里的文件按「年份-月份-名称」命名，名字里不要有空格"],
  ["d2", "文档 · 共享盘", "改别人建的文档前先另存一份副本，副本名后面加「-副本」"],
  ["d3", "文档 · 共享盘", "共享盘的「归档」目录只读，要放文件先发给管理员"],
  ["d4", "文档 · 共享盘", "PDF 文件上传前先确认页数和原件一致"],
  ["d5", "文档 · 共享盘", "大于 100MB 的文件不要放共享盘，改用网盘链接"],
  ["c1", "会议 · 日历", "约会议时先查对方日历，避开午休 12:00-13:30"],
  ["c2", "会议 · 日历", "会议邀请标题写「主题 + 日期」，正文附上议程"],
  ["c3", "会议 · 日历", "周五下午不安排跨部门会议"],
  ["c4", "会议 · 日历", "会议室要提前一天在日历里预订，超过 10 人订大会议室"],
  ["c5", "会议 · 日历", "会议结束后 24 小时内把纪要发到群里"],
  ["s1", "表格 · 在线表格", "在线表格粘贴数据时先单击选中单元格再按 Ctrl+V，不要双击进入编辑状态"],
  ["s2", "表格 · 在线表格", "改汇总表前先筛掉空行，否则合计会算错"],
  ["s3", "表格 · 在线表格", "日期列统一写成 2026-01-31 这种格式"],
  ["s4", "表格 · 在线表格", "表格里的公式列不要手动覆盖，改数据只改原始数据列"],
  ["s5", "表格 · 在线表格", "多人同时编辑的表格，改之前先看右上角有没有别人在线"],
  ["e1", "邮件 · 收发", "发给外部的邮件要抄送部门负责人"],
  ["e2", "邮件 · 收发", "附件超过 20MB 改发下载链接"],
  ["e3", "邮件 · 收发", "标题以「【需回复】」开头的邮件当天要回复"],
  ["e4", "邮件 · 收发", "回复客户邮件用公司签名模板，不要用个人签名"],
  ["e5", "邮件 · 收发", "群发邮件用密送，不要把收件人地址暴露给彼此"],
  ["w1", "网页 · 后台", "内部系统登录要验证码时请人处理，不要反复刷新"],
  ["w2", "网页 · 后台", "后台超过 30 分钟不操作会自动退出，要重新登录"],
  ["w3", "网页 · 后台", "后台的导出按钮在列表页右上角，导出前先选好时间范围"],
  ["w4", "网页 · 后台", "网页加载慢时等右下角的加载圈消失再点"],
  ["w5", "网页 · 后台", "登录时勾选「记住我」，下次不用再输密码"],
  ["r1", "报销 · 单据", "报销单要附发票照片，照片要看得清发票号"],
  ["r2", "报销 · 单据", "差旅报销按出差天数算补贴，每天上限 200 元"],
  ["r3", "报销 · 单据", "超过 5000 元的报销要部门负责人先审批"],
  ["r4", "报销 · 单据", "发票抬头必须写公司全称"],
  ["r5", "报销 · 单据", "报销单在月底前 3 天提交，晚了顺延到下个月"],
]

// [标题, 目标, 步骤[], 该挑的记忆（人工标）]
const queries = [
  ["整理共享盘里本季度的文件", "本季度的文件按规范命名后放到对应目录", ["列出本季度新增的文件", "按规范改名", "移到对应目录"], ["d1", "d3"]],
  ["安排下周的项目周会", "给项目组发会议邀请并订好会议室", ["查参会人的日历", "订会议室", "发会议邀请"], ["c1", "c2", "c4"]],
  ["把本月数据粘贴到在线汇总表", "汇总表里有本月数据且合计正确", ["打开在线表格", "粘贴数据", "核对合计"], ["s1", "s2", "s4"]],
  ["回复客户的询价邮件", "客户当天收到回复", ["读邮件", "写回复", "发送"], ["e1", "e3", "e4"]],
  ["从后台导出上个月的订单列表", "导出的文件保存好", ["登录后台", "选时间范围", "导出"], ["w1", "w3", "w4"]],
  ["提交本月的差旅报销", "报销单提交成功", ["整理发票", "填报销单", "提交审批"], ["r1", "r2", "r4", "r5"]],
  ["整理上周的会议纪要并发出去", "纪要发到群里", ["汇总会议记录", "整理成纪要", "发到群里"], ["c5"]],
  ["给所有合作方群发项目进展邮件", "所有合作方都收到邮件", ["整理收件人", "写邮件", "发送"], ["e1", "e5"]],
  ["在在线表格里补录日期和金额", "补录完成，格式统一", ["打开表格", "逐行补录日期和金额", "核对"], ["s1", "s3", "s4"]],
  ["登录内部系统下载报销单的附件", "附件存到共享盘", ["登录系统", "找到报销单", "下载附件", "上传到共享盘"], ["w1", "w4", "d1"]],
]

const memoryText = ([, appliesTo, content]) => `${appliesTo}\n${content}`
const queryText = ([title, goal, steps]) => [title, goal, ...steps].join("\n")

async function embed(model, texts) {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "HeyAgent" },
    body: JSON.stringify({ model, input: texts.map((text) => ({ content: [{ type: "text", text }] })), dimensions: 1024, encoding_format: "float" }),
  })
  const body = await res.json()
  if (!res.ok || !Array.isArray(body.data)) throw new Error(`HTTP ${res.status}：${JSON.stringify(body.error ?? body).slice(0, 300)}`)
  return { vectors: [...body.data].sort((a, b) => a.index - b.index).map((row) => row.embedding), usage: body.usage }
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / Math.sqrt(na * nb)
}
const r4 = (x) => Math.round(x * 10_000) / 10_000
const stats = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return { n: xs.length, min: r4(sorted[0]), p10: r4(at(0.1)), avg: r4(xs.reduce((s, x) => s + x, 0) / xs.length), p90: r4(at(0.9)), max: r4(sorted.at(-1)) }
}

for (const model of models) {
  const texts = [...memories.map(memoryText), ...queries.map(queryText)]
  const { vectors, usage } = await embed(model, texts)
  if (vectors.some((v) => v.length !== 1024)) throw new Error(`${model} 返回的不是 1024 维`)
  const memVecs = vectors.slice(0, memories.length)
  const queryVecs = vectors.slice(memories.length)
  const pairs = []
  queries.forEach((q, qi) => {
    memories.forEach((m, mi) => pairs.push({ q: qi + 1, m: m[0], relevant: q[3].includes(m[0]), score: r4(cosine(queryVecs[qi], memVecs[mi])) }))
  })
  const relevant = pairs.filter((p) => p.relevant).map((p) => p.score)
  const irrelevant = pairs.filter((p) => !p.relevant).map((p) => p.score)
  // 每个候选门槛：留住多少该挑的、放进多少不该挑的；以及按产品的挑法（≥ 门槛的前 5 条）算查准、查全
  const sweep = []
  for (let th = 0.3; th <= 0.9001; th += 0.01) {
    let picked = 0, hit = 0
    queries.forEach((q, qi) => {
      const top = pairs.filter((p) => p.q === qi + 1 && p.score >= th).sort((a, b) => b.score - a.score).slice(0, 5)
      picked += top.length
      hit += top.filter((p) => p.relevant).length
    })
    sweep.push({
      threshold: r4(th),
      keepRelevant: r4(relevant.filter((s) => s >= th).length / relevant.length),
      passIrrelevant: r4(irrelevant.filter((s) => s >= th).length / irrelevant.length),
      top5Precision: picked ? r4(hit / picked) : null,
      top5Recall: r4(hit / relevant.length),
      top5Picked: picked,
    })
  }
  const perQuery = queries.map((q, qi) => ({
    query: q[0],
    want: q[3],
    top: pairs.filter((p) => p.q === qi + 1).sort((a, b) => b.score - a.score).slice(0, 6).map((p) => `${p.m}${p.relevant ? "*" : ""} ${p.score}`),
  }))
  const result = { model, at: new Date().toISOString(), usage, relevant: stats(relevant), irrelevant: stats(irrelevant), sweep, perQuery, pairs }
  writeFileSync(join(here, `results-${model.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify(result, null, 2))
  console.log(`\n== ${model}  usage=${JSON.stringify(usage)}`)
  console.log("该挑的  ", JSON.stringify(result.relevant))
  console.log("不该挑的", JSON.stringify(result.irrelevant))
  for (const row of sweep.filter((row) => Math.round(row.threshold * 100) % 2 === 0)) console.log(JSON.stringify(row))
  for (const row of perQuery) console.log(row.query, row.want.join(","), "|", row.top.join("  "))
}
