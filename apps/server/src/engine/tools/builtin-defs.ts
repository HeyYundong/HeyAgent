// 内置工具的说明（给模型看的）和输入 schema（在 @heyagent/shared 的 builtinToolInputs）。
// 全部通用：代码里不出现任何业务。worker 启动时同步进 tools 表（source = builtin），不能删、不能改。
import {
  ALWAYS_ON_BUILTIN_TOOLS,
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
      "产出一个文本文件（csv、md、json、txt 等），挂到这次运行上，界面里能看能下载",
    description:
      "要交付表格、文档、数据时调用，内容是完整的文件文本。同名文件可以多次保存，每次都是新文件。返回文件 id。",
    risk: "write",
  },
  {
    id: "file.read",
    name: "读附件",
    summary: "读这次运行的附件或文件：文本直接返回内容，图片交给你看",
    description:
      "附件清单见系统提示（id、名字、类型）。文本文件返回内容（太长会截断），图片会作为图片发给你。",
    risk: "read",
  },
]

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
  for (const [position, def] of BUILTIN_TOOLS.entries()) {
    const values = {
      id: def.id,
      name: def.name,
      summary: def.summary,
      description: def.description,
      source: "builtin" as const,
      risk: def.risk,
      alwaysOn: ALWAYS_ON_BUILTIN_TOOLS.includes(def.id),
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
  const ids = BUILTIN_TOOLS.map((def) => def.id)
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
