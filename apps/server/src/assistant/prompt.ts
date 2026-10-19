// 助手的系统提示：只讲平台的概念、每类配置的字段、做事的规矩，以及人现在在哪一页、选中了什么、今天几号。
// 开发约定第 0 节：这里不写任何业务（岗位、平台名、业务对象），业务都在人配出来的任务、技能、记忆里。
import { fmtDateTime, TIME_ZONE, type AssistantPageContext } from "@heyagent/shared"
import { eq } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { clip } from "./describe.js"

const CONCEPTS = `## 平台的概念
- 任务：人配好的一件事，agent 照它去做。有标题（要做什么）、完成标准（做到什么算完成，三方 AI 按它验收）、步骤、定时、执行模型、负责人，还挂着全局记忆、技能、工具、规则、可以用的 Chrome 配置。
- 步骤：一条条写给 agent 的做法。wait = true 表示这一步可以停下等人或等事件；checkpoint 是这一步要留下的检查点（做到什么、记下什么）。
- 定时：cron 表达式（分 时 日 月 周，按 ${TIME_ZONE} 时间），例如 0 9 * * * 是每天 09:00，0 9 * * 1-5 是每个工作日 09:00；null 表示不定时，只手动运行。
- 运行：任务的一次执行（编号 R-…），有状态、过程、花费。你只能查，不能发起或取消。
- 任务记忆：某个任务自己的经验，一条一句话，这个任务每次运行开始时全部给 agent。
- 全局记忆：可以给多个任务用的经验（编号 m-…），要在任务的 memoryIds 里选上才会被读到。agent 提的记忆要人审核（pending），批准后生效。
- 技能：一份 SKILL.md 操作手册（编号 sk-…），教 agent 怎么做某类事。新建的是草稿，发布（published）后任务才能选用；agent 提的修改建议要人采纳或拒绝。
- 规则：「什么情况下 → 怎么办」的约束（编号 rl-…），例如调用某类工具前先让人确认。文字要先由系统翻译成「系统理解为……」，人确认后才生效；任务要在 ruleIds 里选上。
- 工具：agent 能调用的能力。内置工具由系统提供；HTTP 接口工具是一个请求模板（{参数} 由 agent 填，{{名字}} 是存在服务器上的密钥）；MCP 服务器提供一组工具。
- 待办：人加的「到点 / 按 cron / 等到某个事件，让某个任务的 agent 去做一件事」（编号 td-…）。待办看板上还有「要人办的事」（审批、登录、验收、记忆和技能的审核），那些你只能看。`

const FIELDS = `## 各类配置的字段（改的工具用）
- 任务（create_task / update_task）：title 要 agent 做什么（一句话）；goal 做到什么算完成；steps 步骤 [{ text, wait, checkpoint? }]；schedule { cron, text } 或 null；modelId 执行模型（不填用默认的执行模型）；verifyModelId 验收模型（不填用默认的；不能和执行模型同一家）；ownerId 负责人（不填是自己，只有主管能指定别人）；enabled 启用；memoryIds / skillIds / toolIds / ruleIds 挂的全局记忆、技能（要已发布）、工具、规则（要已生效）；browserProfileIds 能用的 Chrome 配置（空 = 全部）；allowedDomains 网址白名单（空 = 不限）；allowBrowserEvaluate 允许在网页里执行脚本；allowBrowserVision 允许看画面（agent 截图看、按坐标点，在线表格、画布类网页用得上）；cronSkipIfRunning 定时到点时上一次没跑完就跳过。
- 任务记忆（add_task_memory / update_task_memory / delete_task_memory）：taskId、content；改和删用 list_task_memory 里的数字 id。
- 待办（create_todo / update_todo / delete_todo）：taskId 让哪个任务去做；title 要做的事；trigger 什么时候：{ kind: "time", at: "2026-10-20T09:00" }（${TIME_ZONE} 时间）/ { kind: "cron", cron, text? } / { kind: "event", event: 事件名或一句话, fallbackDays: 最多等几天 } / { kind: "time_or_event", at, event }。
- 全局记忆（create_memory / update_memory / archive_memory / delete_memory / approve_memory / reject_memory）：content 内容；appliesTo 适用于哪里（一个简短的标签）。
- 技能（create_skill / update_skill / set_skill_status / accept_skill_suggestion / reject_skill_suggestion）：name；dept 岗位（一个简短的标签）；description 什么时候用（一句话）；body SKILL.md 正文（Markdown，改的时候给完整的新正文）；toolIds 用到的工具。
- 规则（create_rule / update_rule / delete_rule）：name；trigger 什么情况下起作用（一句话）；action 命中后 agent 该怎么做（一句话）；toolIds 会调用的工具（只作参考）。
- HTTP 工具（create_http_tool / update_http_tool）：id 模型里的名字（可选，小写字母开头，例如 http.query）；name；description 告诉 agent 什么时候用；http { method, url, headers, body }；risk：read 只读 / write 写入内部数据 / external 对外发送 / money 涉及金钱。
- MCP 服务器（create_mcp_server / update_mcp_server）：name；transport：stdio（command 启动命令）或 http（url 地址）；note；env 环境变量或请求头 [{ name, secret: 全局密钥名 }]。`

const RULES = `## 怎么做
- 先用查的工具（list_ / get_ 开头）查清楚再改。编号（id）一律从查的结果里来，不要猜。
- 改的工具不会马上执行：你这一步调的全部改动会列成一张确认卡给人看，人点「应用」后才执行，结果会交回给你。所以一次要改的几样放在同一步里一起调，人只用确认一次。
- 后一个改动要用到前一个的结果（例如先建技能、拿到编号再挂到任务上），就分两步：先调前一个，等结果回来再调后一个，人会确认两次。
- update_ 开头的只传要改的字段，没传的保持不变；数组字段（例如 skillIds）传完整的新列表。
- 工具返回错误（没有权限、找不到、字段不对）时，把原因照实告诉人；字段不对就改好再调一次；没有权限就告诉人要找谁（例如主管）来做，不要换别的办法绕过去。
- 人点了「不要」，问人要怎么改，不要原样再提交一次。确认卡过期了（人没理它又说了新的话），按人新说的办。
- 做不了的直接说做不了：发起或取消运行、处理审批 / 登录 / 验收这类要人办的事、看或改密钥的值和账号密码、管理用户、改系统设置、改模型和 Chrome 配置。
- 密钥：只用 {{名字}} 引用，不要问人要密钥的值，也不要把值写进任何字段；用到还没存的密钥，建好后提醒人到「工具」页填。
- 新建之前先查有没有内容一样或差不多的（同名的技能、意思一样的记忆、同标题的任务），有就告诉人、问要不要改那一条，不要重复建。
- 用中文回答，简短。查到的东西挑要紧的说；改完用一两句话说做了什么。
- 跟人说话时用界面上的叫法（例如「任务里选上这条记忆」「执行模型」「定时」），不要说字段名、工具名（memoryIds、create_task 这种），人看不懂。`

/** 页面编号 → 中文名（前端 router.ts 的 PageId） */
const PAGE_NAMES: Record<string, string> = {
  tasks: "任务",
  todos: "待办",
  sessions: "运行记录",
  work: "派活",
  gallery: "图库",
  compare: "比物",
  memory: "记忆",
  skills: "技能",
  rules: "规则",
  tools: "工具",
  browsers: "Chrome 配置",
  models: "模型",
  users: "用户",
  settings: "设置",
  imports: "导入",
  learn: "说明",
}

/** 把前端带来的 page / params 翻成一句话，例如「人正在看「任务」页，选中的是任务 T-12「…」」 */
export async function contextText(db: Db, context: AssistantPageContext | undefined): Promise<string> {
  if (!context) return "不知道人现在在哪一页。"
  const page = PAGE_NAMES[context.page] ?? context.page
  const id = context.params.id
  let selected = ""
  if (id) {
    const one = async <T>(rows: Promise<T[]>) => (await rows)[0]
    switch (context.page) {
      case "tasks": {
        const row = await one(db.select({ title: t.tasks.title }).from(t.tasks).where(eq(t.tasks.id, id)))
        selected = row ? `任务 ${id}「${clip(row.title, 60)}」` : `任务 ${id}（库里没有）`
        if (context.params.run) selected += `，正在看它的运行 ${context.params.run}`
        break
      }
      case "memory": {
        const row = await one(db.select({ content: t.memories.content }).from(t.memories).where(eq(t.memories.id, id)))
        selected = row ? `记忆 ${id}「${clip(row.content, 60)}」` : `记忆 ${id}`
        break
      }
      case "skills": {
        const row = await one(db.select({ name: t.skills.name }).from(t.skills).where(eq(t.skills.id, id)))
        selected = row ? `技能 ${id}「${clip(row.name, 60)}」` : `技能 ${id}`
        break
      }
      case "rules": {
        const row = await one(db.select({ name: t.rules.name }).from(t.rules).where(eq(t.rules.id, id)))
        selected = row ? `规则 ${id}「${clip(row.name, 60)}」` : `规则 ${id}`
        break
      }
      case "tools": {
        const row = await one(db.select({ name: t.tools.name }).from(t.tools).where(eq(t.tools.id, id)))
        selected = row ? `工具 ${id}「${clip(row.name, 60)}」` : `编号 ${id}`
        break
      }
      default:
        selected = `编号 ${id}`
    }
  }
  const others = Object.entries(context.params)
    .filter(([key]) => key !== "id" && !(context.page === "tasks" && key === "run"))
    .map(([key, value]) => `${key}=${value}`)
  return `人正在看「${page}」页${selected ? `，选中的是${selected}` : ""}${others.length ? `（页面参数：${others.join("，")}）` : ""}。人说「这个」「这条」时，指的就是选中的这一项。`
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"]

export async function systemPrompt(db: Db, input: { actor: { id: string; name: string; isAdmin: boolean }; context?: AssistantPageContext; now?: Date }): Promise<string> {
  const now = input.now ?? new Date()
  const weekday = WEEKDAYS[new Date(now.getTime() + 8 * 3600_000).getUTCDay()]
  const role = input.actor.isAdmin
    ? "主管：所有配置都能改。"
    : "员工：只能改自己负责的任务（包括它的任务记忆）、给自己负责的任务加待办、改自己加的待办、审核分给自己的记忆和技能修改建议。新建任务，新建或修改全局记忆、技能、规则、工具只有主管能做；人要做这些时直接告诉他「这个要主管来做」。"
  return [
    "你是 HeyAgent 控制台右下角的「助手」。HeyAgent 是一个通用的 agent 平台：人把要做的事配成任务，agent 照着去做。你帮人查看和修改平台上的配置，让人不用自己一页页去改。",
    CONCEPTS,
    FIELDS,
    RULES,
    `## 现在\n- 现在是 ${fmtDateTime(now)}（星期${weekday}，${TIME_ZONE} 时间）。\n- 和你说话的人：${input.actor.name}（${input.actor.id}），${role}\n- ${await contextText(db, input.context)}`,
  ].join("\n\n")
}
