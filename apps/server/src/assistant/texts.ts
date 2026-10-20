// 助手里的文本文件（docs/dev/copilot.md 第 12 节）：人随消息发的 md、txt、html、csv、json、PDF、Word……，和助手用 read_file 读的文件。
// - assistant_messages 里只存文件编号；发给模型时现读文件、抽出文字（extractFileText），放进那条 user 消息的 <file> 段里；
// - 能读哪些文件：和看图一样（登录就能看，要导入的 zip 不算），还要是文本（mime 是文本，或扩展名在 ASSISTANT_TEXT_EXTENSIONS 里）、
//   PDF 或 .docx（12.5 节），而且抽得出文字。旧版 .doc 不收；
// - 文本按 UTF-8 解码，不行试 GBK，有 NUL 的算二进制；HTML 先去掉 script、style、svg、注释和 data: 内联图，标签保留；
//   PDF 用 unpdf 按页抽文字，页之间一行「--- 第 3 页 ---」；Word 用 mammoth 抽纯文字；
// - 一条消息里的文件合起来最多放 TEXT_INLINE_MAX 字，放不下的只放开头，提示用 read_file 按 offset 接着读；
// - 文件被删了、内容没了：换成一句话（「[文件 f-xxx 已经删了]」），对话照常能接着聊。
import { extname } from "node:path"

import { ASSISTANT_DOC_MAX_BYTES, ASSISTANT_FILE_MAX_BYTES, ASSISTANT_TEXT_EXTENSIONS, oldWordProblem } from "@heyagent/shared"
import mammoth from "mammoth"
import { extractText } from "unpdf"

import type { DbOrTx } from "../data/config/common.js"
import { isTextMime, readFileData, type FileRow } from "../files/service.js"
import { decodeText } from "../imports/decode.js"
import { ImageLoader } from "./images.js"

/** 一条消息里所有文件合起来最多放多少字 */
export const TEXT_INLINE_MAX = 60_000
/** read_file 一次给多少字 */
export const READ_FILE_LIMIT = 20_000

const MB = 1024 * 1024
const PDF_MIME = "application/pdf"
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

export type TextKind = "text" | "html" | "pdf" | "docx"

type Named = Pick<FileRow, "name" | "mime">

/** 按 mime 和扩展名分：能读的是哪一种；读不了的返回 undefined（浏览器给的 mime 不一定对，例如 .ts 给成 video/mp2t，所以也看扩展名） */
export function textKindOf(row: Named): TextKind | undefined {
  const ext = extname(row.name).toLowerCase()
  if (row.mime === PDF_MIME || ext === ".pdf") return "pdf"
  if (row.mime === DOCX_MIME || ext === ".docx") return "docx"
  if (row.mime === "text/html" || ext === ".html" || ext === ".htm") return "html"
  if (isTextMime(row.mime) || ASSISTANT_TEXT_EXTENSIONS.includes(ext)) return "text"
  return undefined
}

/** 能用 read_file 读（list_run_files 的 text） */
export const isTextFile = (row: Named) => textKindOf(row) !== undefined

const isOldWord = (row: Named) => row.mime === "application/msword" || extname(row.name).toLowerCase() === ".doc"

/** 读不了的原因。retry = false 的（太大、格式不对要另存、扫描件）发消息时不加「重新上传再发」 */
export class TextProblem extends Error {
  readonly retry: boolean
  constructor(message: string, retry = true) {
    super(message)
    this.retry = retry
  }
}

/** 这个文件不能给助手读的原因（不看内容）；能读返回 undefined。limitSize：发消息时才限大小（文本 5 MB，PDF / Word 20 MB） */
export function textProblem(id: string, row: FileRow | undefined, limitSize = true): TextProblem | undefined {
  if (!row || row.kind === "import") return new TextProblem(`找不到文件 ${id}（可能已经删了）`)
  const kind = textKindOf(row)
  if (!kind) {
    if (isOldWord(row)) return new TextProblem(oldWordProblem(row.name), false)
    return new TextProblem(`${row.name}（${id}）不是文本文件，只能发 md、txt、html、csv、json 这类文本和 PDF、Word（.docx）`)
  }
  if (!limitSize) return undefined
  const doc = kind === "pdf" || kind === "docx"
  const max = doc ? ASSISTANT_DOC_MAX_BYTES : ASSISTANT_FILE_MAX_BYTES
  if (row.size > max) return new TextProblem(`${row.name}（${id}）太大，${doc ? "PDF 和 Word 文件" : "文本文件"}最多 ${Math.round(max / MB)} MB`, false)
  return undefined
}

/** HTML 去掉 script、style、svg 整段（没闭合的到结尾）、注释和 data: 的 base64 内联图，标签保留 */
export function cleanHtml(html: string) {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|svg)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, "data:…")
}

export interface Extracted {
  text: string
  kind: TextKind
  /** <file> 段和 read_file 开头的一句说明（HTML 清理过、PDF 几页……）；纯文本没有 */
  note?: string
}

/** 读文件、抽出文字。读不了抛 TextProblem（二进制、扫描件、加密 / 损坏、内容没了） */
export async function extractFileText(row: FileRow): Promise<Extracted> {
  const kind = textKindOf(row)
  if (!kind) throw new TextProblem(`${row.name}（${row.id}）不是文本文件`)
  let data: Buffer
  try {
    data = await readFileData(row)
  } catch {
    throw new TextProblem(`${row.name}（${row.id}）的内容不见了`)
  }
  if (kind === "pdf") {
    let pages: string[]
    try {
      pages = (await extractText(new Uint8Array(data), { mergePages: false })).text
    } catch {
      throw new TextProblem(`${row.name} 打不开（可能加密或损坏）`, false)
    }
    if (!pages.some((page) => page.trim())) throw new TextProblem(`${row.name} 里抽不出文字（可能是扫描件），截图发图片吧`, false)
    return { kind, text: pages.map((page, index) => `--- 第 ${index + 1} 页 ---\n${page.trim()}`).join("\n\n"), note: `（PDF，共 ${pages.length} 页，已抽出文字）` }
  }
  if (kind === "docx") {
    let text: string
    try {
      text = (await mammoth.extractRawText({ buffer: data })).value.trim()
    } catch {
      throw new TextProblem(`${row.name} 打不开（可能加密或损坏）`, false)
    }
    if (!text) throw new TextProblem(`${row.name} 里抽不出文字`, false)
    return { kind, text, note: "（Word 文档，已抽出文字）" }
  }
  const decoded = decodeText(data)
  if (decoded === undefined) throw new TextProblem(`${row.name}（${row.id}）看着是二进制，不是文本`)
  return kind === "html" ? { kind, text: cleanHtml(decoded), note: "（HTML，已去掉 script、style、svg 和注释）" } : { kind, text: decoded }
}

type LoadedText = { row: FileRow; extracted: Extracted } | { row?: FileRow; problem: TextProblem }

/**
 * 一次请求里读文件的缓存：文件的行和图共用 ImageLoader 那一份（一批查），内容读一次、抽一次（PDF 解析慢）。
 * 发消息前的检查、历史里的文件、read_file 都走它；每一步都把历史里的文件重新放进消息（不缓存给模型的结果），只是同一个请求里不重复读盘
 */
export class TextLoader {
  private readonly data = new Map<string, Promise<LoadedText>>()
  /** 文件行的缓存在这里（和看图共用） */
  readonly images: ImageLoader

  constructor(images: ImageLoader) {
    this.images = images
  }

  prefetch(ids: Iterable<string>) {
    return this.images.prefetch(ids)
  }

  row(id: string) {
    return this.images.row(id)
  }

  /** 文件的文字；文件没了、不是文本、读不出来、抽不出字的带 problem */
  load(id: string): Promise<LoadedText> {
    let pending = this.data.get(id)
    if (!pending) {
      pending = (async (): Promise<LoadedText> => {
        const row = await this.row(id)
        const problem = textProblem(id, row, false)
        if (problem) return { row, problem }
        try {
          return { row: row!, extracted: await extractFileText(row!) }
        } catch (error) {
          return { row, problem: error instanceof TextProblem ? error : new TextProblem(`${row!.name}（${id}）读不了：${(error as Error).message}`) }
        }
      })()
      this.data.set(id, pending)
    }
    return pending
  }
}

/** 人随消息发的文件：都要能读、不太大、抽得出文字；按给的顺序返回（重复的只留一个）。抽出来的留在 loader 里，这次请求不再抽 */
export async function checkChatTexts(loader: TextLoader, ids: string[]): Promise<{ rows: FileRow[] } | { error: string }> {
  const unique = [...new Set(ids)]
  await loader.prefetch(unique)
  const rows: FileRow[] = []
  for (const id of unique) {
    const row = await loader.row(id)
    let problem = textProblem(id, row)
    if (!problem) {
      const loaded = await loader.load(id)
      if ("problem" in loaded) problem = loaded.problem
    }
    if (problem) return { error: problem.retry ? `${problem.message}，重新上传再发` : problem.message }
    rows.push(row!)
  }
  return { rows }
}

/** read_file：一段一段读（同 agent 的 file.read），一次 READ_FILE_LIMIT 字。不限是不是这段对话里发的 */
export async function readFilePart(db: DbOrTx, fileId: string, offset = 0, loader = new TextLoader(new ImageLoader(db))): Promise<string> {
  const loaded = await loader.load(fileId)
  if ("problem" in loaded) throw loaded.problem
  const { row, extracted } = loaded
  const { text, note } = extracted
  const part = text.slice(offset, offset + READ_FILE_LIMIT)
  const rest = text.length - offset - part.length
  return `${row.name}${note ?? ""}（共 ${text.length} 字，从第 ${offset} 字开始）：\n${part}${rest > 0 ? `\n…（还有 ${rest} 字，用 offset = ${offset + part.length} 接着读）` : ""}`
}

/** 文件行没了（或者是要导入的 zip，看不到） */
const gone = (file: LoadedText) => !file.row || file.row.kind === "import"

/** 属性里的名字：双引号换成单引号，别把 <file> 的属性弄乱 */
const attr = (value: string) => value.replace(/"/g, "'")

/**
 * 人发的文件给模型的文字：「（附件：f-xxx 需求.md、f-yyy page.html）」+ 每个文件一段 <file>。
 * 所有文件合起来最多 TEXT_INLINE_MAX 字，按顺序放，放不下的只放开头（剩下的额度），后面的不放内容，都提示用 read_file 接着读
 */
export async function textsContent(loader: TextLoader, ids: string[]): Promise<string> {
  const loaded = await Promise.all(ids.map((id) => loader.load(id)))
  const names = ids.map((id, index) => `${id} ${gone(loaded[index]!) ? "（已经删了）" : loaded[index]!.row!.name}`)
  let room = TEXT_INLINE_MAX
  const blocks = ids.map((id, index) => {
    const file = loaded[index]!
    if ("problem" in file) return gone(file) ? `[文件 ${id} 已经删了]` : `[文件 ${id}（${file.row!.name}）的内容不见了]`
    const { text, note } = file.extracted
    const shown = text.slice(0, room)
    room -= shown.length
    const cut = shown.length < text.length ? `\n…（共 ${text.length} 字，这里只放了前 ${shown.length} 字，用 read_file 按 offset = ${shown.length} 接着读）` : ""
    return `<file id="${id}" name="${attr(file.row.name)}" chars="${text.length}">\n${note ? `${note}\n` : ""}${shown}${cut}\n</file>`
  })
  return [`（附件：${names.join("、")}）`, ...blocks].join("\n\n")
}
