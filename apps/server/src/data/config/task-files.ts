// 任务附件的写操作：把刚上传的文件（POST /api/files，kind = upload，还没归属任务和运行）挂到任务上。
// 任务详情里的「附件」（tRPC engine.attachToTask）和右下角助手的 attach_files_to_task 都走这里，规矩只有一份。
import { and, eq, inArray, isNull } from "drizzle-orm"
import type { Actor } from "@heyagent/shared"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { assertCan, audit, badRequest, notFound, type DbOrTx } from "./common.js"

type FileRow = typeof t.files.$inferSelect

export const ATTACH_FORBIDDEN = "只有任务负责人和主管能改任务附件"

export async function attachTaskOf(db: DbOrTx, taskId: string) {
  const [task] = await db.select({ id: t.tasks.id, title: t.tasks.title, ownerId: t.tasks.ownerId }).from(t.tasks).where(eq(t.tasks.id, taskId))
  if (!task) throw notFound("任务", taskId)
  return task
}

/**
 * 查这些文件能不能挂到任务上：已经是这个任务的附件的算「已挂」（不重复挂），
 * 别的只收没归属的上传文件；有一个不行就报错，一个都不挂
 */
export async function attachableFiles(db: DbOrTx, taskId: string, fileIds: string[]): Promise<{ file: FileRow; already: boolean }[]> {
  const ids = [...new Set(fileIds)]
  const rows = ids.length ? await db.select().from(t.files).where(inArray(t.files.id, ids)) : []
  return ids.map((id) => {
    const file = rows.find((row) => row.id === id)
    if (!file) throw notFound("文件", id)
    if (file.taskId === taskId && !file.sessionId) return { file, already: true }
    if (file.kind !== "upload" || file.sessionId || file.taskId) throw badRequest(fileIds.length > 1 ? `文件 ${file.name}（${file.id}）已经用在别处，请重新上传` : "这个文件已经用在别处，请重新上传")
    return { file, already: false }
  })
}

/** 挂附件：查权限，在一个事务里改文件的归属、每个文件记一条审计（task.attach）。返回挂好以后的文件（按给的顺序） */
export async function attachFilesToTask(ctx: { db: Db; actor: Actor }, input: { taskId: string; fileIds: string[] }): Promise<FileRow[]> {
  const task = await attachTaskOf(ctx.db, input.taskId)
  assertCan(ctx.actor, "task.manage", { ownerId: task.ownerId }, ATTACH_FORBIDDEN)
  return ctx.db.transaction(async (tx) => {
    const files = await attachableFiles(tx, task.id, input.fileIds)
    const out: FileRow[] = []
    for (const { file, already } of files) {
      if (already) {
        out.push(file)
        continue
      }
      // 条件里再带一遍「没归属的上传文件」：同时被挂到两个任务上时只有一个成
      const [row] = await tx
        .update(t.files)
        .set({ taskId: task.id, kind: "attachment" })
        .where(and(eq(t.files.id, file.id), eq(t.files.kind, "upload"), isNull(t.files.taskId), isNull(t.files.sessionId)))
        .returning()
      if (!row) throw badRequest(`文件 ${file.name}（${file.id}）已经用在别处，请重新上传`)
      await audit(tx, ctx.actor.id, "task.attach", "tasks", task.id, { fileId: file.id, name: file.name })
      out.push(row)
    }
    return out
  })
}
