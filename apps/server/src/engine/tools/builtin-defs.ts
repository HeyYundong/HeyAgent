// 内置工具的说明（给模型看的）和输入 schema（在 @heyagent/shared 的 builtinToolInputs）。
// 全部通用：代码里不出现任何业务。worker 启动时同步进 tools 表（source = builtin），不能删、不能改。
import {
  ALWAYS_ON_BUILTIN_TOOLS,
  BROWSER_TOOL_ID,
  COMPARE_TOOL_ID,
  GALLERY_TOOL_ID,
  builtinToolInputs,
  type BuiltinToolId,
  type Risk,
  type SnapshotTool,
} from "@heyagent/shared"
import { eq, inArray, notInArray, and } from "drizzle-orm"
import { z } from "zod"

import * as t from "../../db/schema.js"
import type { DbLike } from "../records.js"

export interface BuiltinToolDef {
  id: BuiltinToolId
  name: string
  summary: string
  description: string
  risk: Risk
  /**
   * 不单独选、跟着别的自动带上（快照里由 sessions.ts 加）：不同步进 tools 表，任务的「用哪些」、导入的内置工具清单里都没有它。
   * 「查派过的活」跟着「派活」，「报结果」跟着被派来的运行（派活第二期）
   */
  implied?: true
}

export const BUILTIN_TOOLS: BuiltinToolDef[] = [
  {
    id: "checkpoint.mark",
    name: "勾检查点",
    summary: "把一个检查点标记为完成或跳过，附上结果或跳过理由",
    description:
      "完成一个检查点后调用，写上结果或证据；做不到时标为跳过，必须写清理由。检查点编号见系统提示里的清单。",
    risk: "write",
  },
  {
    id: "session.wait",
    name: "挂起等待",
    summary:
      "记下在等什么，挂起当前 session；等到事件或到点后继续同一个 session",
    description:
      "需要等一段时间、或者等外部的事（回复、审批结果、某个事件）时调用。until / afterMinutes（到点继续）和 event（等事件）至少给一个；两个都给就是谁先到谁继续。挂起后这次运行先停下，继续时你会收到一条消息说明等到了什么，之前的上下文都还在。",
    risk: "write",
  },
  {
    id: "ask.human",
    name: "问人",
    summary: "向负责人提问或请人拍板，等回答后继续",
    description:
      "需要人批准、回答问题、或者去浏览器里登录时调用。会在待办里生成一件事交给负责人（或指定的人），session 进入「等人处理」，人处理完你会收到结果和备注再继续。",
    risk: "write",
  },
  {
    id: "plan.set",
    name: "写下步骤",
    summary: "写下你打算怎么做（几步），中途做法变了可以更新",
    description:
      "开始干活前调用一次，按顺序写下打算怎么做，一句话一步；做法变了就再调一次（整体替换）。负责人能看到你的步骤，觉得好可以一键存成任务的步骤。",
    risk: "write",
  },
  {
    id: "run.not_done",
    name: "报没完成",
    summary: "做不成时调用并写清原因，这次运行结束、记成「没完成」",
    description:
      "试过了还是做不成（找不到、没权限、对方拒绝、条件不满足等）时调用，reason 写清卡在哪、试过哪些办法、还差什么。调用后这次运行马上结束，状态记「没完成」，负责人会收到通知。不要在没做成时直接回复总结说做完了；能补救的先补救（问人、等待），确实做不成再调它。",
    risk: "read",
  },
  {
    id: "skill.load",
    name: "读取技能",
    summary: "按名字读取某个技能的全文",
    description:
      "系统提示里只有技能目录（名字和一句话）。要按某个技能做事前，先用它读出 SKILL.md 全文。",
    risk: "read",
  },
  {
    id: "memory.propose",
    name: "提议记忆",
    summary: "提议记住一件事，进入待办等人审核",
    description:
      "发现以后的运行也该知道的事（偏好、规律、注意事项）时提议一条记忆。记忆要人审核通过才生效；来自网页的内容要标明 evidence = web。",
    risk: "write",
  },
  {
    id: "skill.propose",
    name: "提议修改技能",
    summary: "对某个技能提出修改建议，进入待办等人审核",
    description:
      "发现技能写得不对或缺步骤时，给出改完以后的全文和一句话说明。修改要技能负责人审核通过才生效。",
    risk: "write",
  },
  {
    id: "notify.staff",
    name: "通知员工",
    summary: "给员工发站内通知，并按设置推送到通知渠道",
    description:
      "需要让某人知道一件事、但不用等他回复时调用。不填 to 就通知任务负责人。",
    risk: "write",
  },
  {
    id: "file.save",
    name: "存文件",
    summary:
      "产出一个文件（文本：csv、md、json、txt 等；Excel：xlsx、xls），挂到这次运行上，界面里能看能下载",
    description:
      "要交付表格、文档、数据时调用。文本文件：content 是完整的文件文本。Excel：文件名用 .xlsx 或 .xls，给 sheets（每个工作表一项：name 和 rows，rows 每行一个数组，格子是文字、数字、true/false 或 null），不用给 content；第一行一般写表头，日期写成文字（例如 2026-01-02），列宽自动按内容定。xls 最多 65536 行、256 列，没有特别要求就用 xlsx。同名文件可以多次保存，每次都是新文件。返回文件 id。",
    risk: "write",
  },
  {
    id: "work.dispatch",
    name: "派活",
    summary: "把要办的事一件一张派给别的任务，平台按对方的名额一张单开一次运行",
    description:
      "task 填对方任务的 id（系统提示里「可以派活给」列出了能派给谁、各要什么参数）；items 一件事一项（一次最多 50 张）：title 一句话说清是什么事，params 按对方的参数填，对方没有标「去重」的参数时还要填 key（同一件事每次都填同一个值）。同一件事重复派不会重复办：已经有的单只返回现状（排队第几位、在办、办完的结果、没办成的原因），已经结束的单不会重开，要重办由人在派活页点。ifExists = update 时，还在排队的单用这次的参数覆盖。返回每张一行：新建排第几位 / 已经有了现在怎样 / 被拒的原因。",
    risk: "write",
  },
  {
    id: "work.list",
    name: "查派过的活",
    summary: "查这个任务派出去的派活单：排队、在办、办完的结果、没办成的原因",
    description:
      "只能查这个任务派出去的单，最新的在前，默认 20 张。items 按单号查；status 按状态筛（open = 还没结束的）；thisRun = true 只看这次运行派的。等结果时用 session.wait 等事件 work.done:<单号>（一次等一张），醒来后用它看其余的。",
    risk: "read",
    implied: true,
  },
  {
    id: "work.report",
    name: "报结果",
    summary: "被派来的运行把结果的几个字段写回派活单；办不成时报 not_done 并写原因",
    description:
      "data 写结果的几个字段（名字 → 文字、数字或是 / 否，最多 20 个），可以调多次，同名字段以后一次为准；派活的一方和派活页都能看到。这件事办不成（例如找不到、对方拒绝）时 outcome = not_done、reason 写原因：运行结束后单记「没办成」，不会自动重试。只写自己这张单，不对外。",
    risk: "read",
    implied: true,
  },
  {
    id: "file.read",
    name: "读附件",
    summary: "读这次运行的附件或文件：文本直接返回内容，图片交给你看，表格（xlsx、xls、csv 等）按行列返回",
    description:
      "附件清单见系统提示（id、名字、类型），浏览器里下载的文件、存过的文件也能读。文本文件返回内容（太长会截断，用 offset 接着读），图片会作为图片发给你。表格文件（xlsx、xls、xlsm、xlsb、ods、csv、tsv）：只给 fileId 返回概览（每个工作表的名字、范围、前 20 行）；要看更多就加 sheet（名字或序号）、startRow（行号）、rows（默认 200，最多 500），输出末尾会告诉你下一段从哪行接着读。表格只给存着的值、不给公式，日期写成 YYYY-MM-DD。",
    risk: "read",
  },
]

/**
 * 「浏览器」（M2）：任务选了它，工具网关就开放整组浏览器工具（browser.use + Playwright MCP 的工具，见 browser/tools.ts）。
 * 它本身不能直接调用，所以不在 builtinToolInputs 里。
 */
export const BROWSER_TOOL_DEF = {
  id: BROWSER_TOOL_ID,
  name: "浏览器",
  summary: "用服务器上有界面的 Chrome 操作网页：打开、看结构、点击、输入、上传文件、截图存档",
  description:
    "开放整组浏览器工具：系统从任务允许的 Chrome 配置里自动分配一个空闲的（代理、登录态、时区语言跟着配置走，要用特定的可以用 browser.use 指定），以及打开网页、看页面结构、查找、点击、输入、选择、上传文件、截图等。遇到简单的验证码先自己试着过，过不了的验证码和登录页交给人处理。",
  risk: "external" as Risk,
}

export function browserSnapshotTool(): SnapshotTool {
  return {
    id: BROWSER_TOOL_DEF.id,
    name: BROWSER_TOOL_DEF.name,
    summary: BROWSER_TOOL_DEF.summary,
    description: BROWSER_TOOL_DEF.description,
    source: "builtin",
    risk: BROWSER_TOOL_DEF.risk,
  }
}

/**
 * 「图库」：任务选了它，工具网关就开放整组图库工具（gallery.search / compare / get / add / update，见 gallery/tools.ts）。
 * 和「浏览器」一样本身不能直接调用。agent 不能删图。
 */
export const GALLERY_TOOL_DEF = {
  id: GALLERY_TOOL_ID,
  name: "图库",
  summary: "在图库里以图搜图、按描述找图、比对两张图是不是同款，把图连同文本（JSON）和标签存进图库",
  description:
    "开放整组图库工具：检索（以图搜图、按一句描述找、按标签和 JSON 字段筛）、比对两张图的相似度、按 id 看一张（可以看缩略图）、传图（这次运行的截图、附件或网址）、改文本和标签。不能删图。",
  risk: "write" as Risk,
}

export function gallerySnapshotTool(): SnapshotTool {
  return {
    id: GALLERY_TOOL_DEF.id,
    name: GALLERY_TOOL_DEF.name,
    summary: GALLERY_TOOL_DEF.summary,
    description: GALLERY_TOOL_DEF.description,
    source: "builtin",
    risk: GALLERY_TOOL_DEF.risk,
  }
}

/**
 * 「比物」：任务选了它，工具网关就开放整组比物工具（compare.images / get / list / standards，见 compare/tools.ts）。
 * 和「图库」一样本身不能直接调用。agent 不能删比对记录。
 */
export const COMPARE_TOOL_DEF = {
  id: COMPARE_TOOL_ID,
  name: "比物",
  summary: "两张图交给视觉模型，按比对标准逐项打分、写出差异，判断是不是达到合格线（例如是不是同款）",
  description:
    "开放整组比物工具：比两张图（网址、图库的图、这次运行的截图或附件；等比完返回分数、是否达标、把握度、结论、理由、差异）、按 id 看一条比对、比对记录（默认只列这次运行的）、比对标准。每次比对都存档，页面上能看。",
  risk: "write" as Risk,
}

export function compareSnapshotTool(): SnapshotTool {
  return {
    id: COMPARE_TOOL_DEF.id,
    name: COMPARE_TOOL_DEF.name,
    summary: COMPARE_TOOL_DEF.summary,
    description: COMPARE_TOOL_DEF.description,
    source: "builtin",
    risk: COMPARE_TOOL_DEF.risk,
  }
}

/** 能在任务里单独选的内置工具（同步进 tools 表、导入的内置工具清单用它） */
export const SELECTABLE_BUILTIN_TOOLS = BUILTIN_TOOLS.filter((tool) => !tool.implied)

export const builtinDef = (id: string) =>
  BUILTIN_TOOLS.find((tool) => tool.id === id)
export const isBuiltinTool = (id: string): id is BuiltinToolId =>
  id in builtinToolInputs

/** 给模型的 JSON Schema */
export function builtinJsonSchema(id: BuiltinToolId): Record<string, unknown> {
  const schema = z.toJSONSchema(builtinToolInputs[id], {
    target: "draft-7",
  }) as Record<string, unknown>
  delete schema.$schema
  return schema
}

export function builtinSnapshotTool(id: BuiltinToolId): SnapshotTool {
  const def = builtinDef(id)!
  return {
    id,
    name: def.name,
    summary: def.summary,
    description: def.description,
    source: "builtin",
    risk: def.risk,
    alwaysOn: ALWAYS_ON_BUILTIN_TOOLS.includes(id) || undefined,
  }
}

/** 启动时把内置工具同步进 tools 表：有就更新，没有就插入；代码里已经没有的内置工具删掉 */
export async function syncBuiltinTools(db: DbLike) {
  const all: { id: string; name: string; summary: string; description: string; risk: Risk }[] = [...SELECTABLE_BUILTIN_TOOLS, BROWSER_TOOL_DEF, GALLERY_TOOL_DEF, COMPARE_TOOL_DEF]
  for (const [position, def] of all.entries()) {
    const values = {
      id: def.id,
      name: def.name,
      summary: def.summary,
      description: def.description,
      source: "builtin" as const,
      risk: def.risk,
      alwaysOn: (ALWAYS_ON_BUILTIN_TOOLS as readonly string[]).includes(def.id),
    }
    const [existing] = await db
      .select({ id: t.tools.id, source: t.tools.source })
      .from(t.tools)
      .where(eq(t.tools.id, def.id))
    if (existing && existing.source !== "builtin") {
      console.warn(
        `[engine] 工具 ${def.id} 已被非内置工具占用，内置工具没有同步`
      )
      continue
    }
    if (existing)
      await db.update(t.tools).set(values).where(eq(t.tools.id, def.id))
    else
      await db.insert(t.tools).values({ ...values, position: 1000 + position })
  }
  const ids = all.map((def) => def.id)
  const stale = await db
    .select({ id: t.tools.id })
    .from(t.tools)
    .where(and(eq(t.tools.source, "builtin"), notInArray(t.tools.id, ids)))
  if (stale.length) {
    await db.delete(t.tools).where(
      inArray(
        t.tools.id,
        stale.map((row) => row.id)
      )
    )
  }
}
