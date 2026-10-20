// 助手里的图（docs/dev/copilot.md 第 11 节）：人随消息发的图、助手用 view_image 看的图。
// - assistant_messages 里只存文件编号，不存图片内容；发给模型时现读文件，缩成长边 1024 的 JPEG（gallery/images.ts 的 modelInputImage）；
// - 能看哪些文件：和 GET /api/files 一样（登录就能看），要导入的 zip 不算（里面可能有明文密钥）；还要是图片（png / jpeg / gif / webp）；
// - 当前模型看不了图、文件被删了：图换成一句话（「[图片 f-xxx（a.png）：当前模型看不了图]」），对话照常能接着聊。
import type { AssistantImage } from "@heyagent/shared"
import type { FilePart, TextPart } from "ai"
import { eq, inArray } from "drizzle-orm"

import type { DbOrTx } from "../data/config/common.js"
import * as t from "../db/schema.js"
import { fileUrl, isImageMime, readFileData, type FileRow } from "../files/service.js"
import { modelInputImage } from "../gallery/images.js"

/** 一步里 view_image 最多看几张（多的报错，让它下一步再看） */
export const VIEW_IMAGE_MAX_PER_STEP = 4

export const assistantImageOf = (row: Pick<FileRow, "id" | "name" | "mime" | "size">): AssistantImage => ({
  id: row.id,
  name: row.name,
  mime: row.mime,
  size: row.size,
  url: fileUrl(row.id),
})

/** 一批文件的行（一次查询） */
export async function fileRows(db: DbOrTx, ids: Iterable<string>): Promise<Map<string, FileRow>> {
  const list = [...new Set(ids)]
  if (list.length === 0) return new Map()
  const rows = await db.select().from(t.files).where(inArray(t.files.id, list))
  return new Map(rows.map((row) => [row.id, row]))
}

/** 这个文件不能给助手看的原因；能看返回 undefined */
export function imageProblem(id: string, row: FileRow | undefined): string | undefined {
  if (!row || row.kind === "import") return `找不到图片 ${id}（可能已经删了）`
  if (!isImageMime(row.mime)) return `${row.name}（${id}）不是图片，只能看 png、jpeg、gif、webp`
  return undefined
}

/** 人随消息发的图：都要能看；按给的顺序返回（重复的只留一个） */
export async function checkChatImages(db: DbOrTx, ids: string[]): Promise<{ rows: FileRow[] } | { error: string }> {
  const unique = [...new Set(ids)]
  const found = await fileRows(db, unique)
  const rows: FileRow[] = []
  for (const id of unique) {
    const problem = imageProblem(id, found.get(id))
    if (problem) return { error: `${problem}，重新上传再发` }
    rows.push(found.get(id)!)
  }
  return { rows }
}

/** view_image 的输入换成文件：fileId 直接用，图库的图用它的原图 */
export async function viewableImage(db: DbOrTx, input: { fileId?: string; galleryImageId?: string }): Promise<{ row: FileRow; from: string }> {
  let id = input.fileId
  let from = "文件"
  if (input.galleryImageId) {
    const [image] = await db.select({ fileId: t.galleryImages.fileId }).from(t.galleryImages).where(eq(t.galleryImages.id, input.galleryImageId))
    if (!image) throw new Error(`图库里没有 ${input.galleryImageId}`)
    id = image.fileId
    from = `图库 ${input.galleryImageId}`
  }
  const [row] = await db.select().from(t.files).where(eq(t.files.id, id!))
  const problem = imageProblem(id!, row)
  if (problem) throw new Error(problem)
  return { row: row!, from }
}

type Loaded = { row: FileRow; base64: string } | { row?: FileRow; missing: true }

/**
 * 一次请求里读图的缓存：文件的行一批查，图片内容读一次、缩一次。
 * 每一步都把历史里的图重新发给模型（不缓存给模型的结果），只是同一个请求里不重复读盘、缩图
 */
export class ImageLoader {
  private readonly rows = new Map<string, FileRow | undefined>()
  private readonly data = new Map<string, Promise<Loaded>>()
  private readonly db: DbOrTx

  constructor(db: DbOrTx) {
    this.db = db
  }

  /** 先把一批文件的行查好（historyForModel 一开始调一次） */
  async prefetch(ids: Iterable<string>) {
    const missing = [...new Set(ids)].filter((id) => !this.rows.has(id))
    if (missing.length === 0) return
    const found = await fileRows(this.db, missing)
    for (const id of missing) this.rows.set(id, found.get(id))
  }

  /** 记下已经查到的行（runChat、view_image 刚查过的，不用再查） */
  remember(row: FileRow) {
    this.rows.set(row.id, row)
  }

  async row(id: string): Promise<FileRow | undefined> {
    if (!this.rows.has(id)) await this.prefetch([id])
    return this.rows.get(id)
  }

  /** 图片内容（缩过的 JPEG，base64）；文件没了、读不出来、认不出是图片的算 missing */
  load(id: string): Promise<Loaded> {
    let pending = this.data.get(id)
    if (!pending) {
      pending = (async (): Promise<Loaded> => {
        const row = await this.row(id)
        if (imageProblem(id, row)) return { row, missing: true }
        try {
          return { row: row!, base64: (await modelInputImage(await readFileData(row!))).toString("base64") }
        } catch {
          return { row, missing: true }
        }
      })()
      this.data.set(id, pending)
    }
    return pending
  }
}

/** 一张图给模型的样子：能看就是 file part（JPEG），看不了 / 没了换成一句话 */
async function imagePart(loader: ImageLoader, id: string, vision: boolean): Promise<TextPart | FilePart> {
  const row = await loader.row(id)
  if (!row || row.kind === "import") return { type: "text", text: `[图片 ${id} 已经删了]` }
  if (!vision) return { type: "text", text: `[图片 ${id}（${row.name}）：当前模型看不了图]` }
  const loaded = await loader.load(id)
  if ("missing" in loaded) return { type: "text", text: `[图片 ${id}（${row.name}）的内容不见了]` }
  return { type: "file", data: loaded.base64, mediaType: "image/jpeg", filename: row.name }
}

/** 「f-xxx a.png、f-yyy b.jpg」：告诉模型图的文件编号，好让它再看、挂到任务上 */
async function idList(loader: ImageLoader, ids: string[]) {
  const names = await Promise.all(ids.map(async (id) => `${id} ${(await loader.row(id))?.name ?? "（已经删了）"}`))
  return names.join("、")
}

/** 人发的带图的消息给模型的内容：文字 + 「（附图：编号 名字……）」+ 每张图 */
export async function userContent(loader: ImageLoader, text: string, ids: string[], vision: boolean): Promise<(TextPart | FilePart)[]> {
  const note = `（附图：${await idList(loader, ids)}）`
  return [{ type: "text", text: text ? `${text}\n${note}` : note }, ...(await Promise.all(ids.map((id) => imagePart(loader, id, vision))))]
}

/** view_image 看的图给模型的内容（工具结果里放不了图，接在工具结果后面作为一条 user 消息） */
export async function viewedContent(loader: ImageLoader, ids: string[], vision: boolean): Promise<(TextPart | FilePart)[]> {
  return [{ type: "text", text: `view_image 看的图（${await idList(loader, ids)}）：` }, ...(await Promise.all(ids.map((id) => imagePart(loader, id, vision))))]
}
