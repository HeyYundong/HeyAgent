// 图库的图片处理（sharp）：认格式、读尺寸、做缩略图、做给 embedding 模型的输入图；把各种「指一张图」的写法读成文件内容。
import sharp from "sharp"
import type { GalleryImageRef } from "@heyagent/shared"

import type { DbLike } from "../engine/records.js"
import { runtime } from "../engine/runtime.js"
import { getFileRow, readFileData } from "../files/service.js"
import { GalleryError } from "./errors.js"

/** 解码时最多多少像素（防止很小的文件解出巨大的图把内存撑爆）：约 1 亿像素，够 10000×10000 */
const MAX_PIXELS = 100_000_000
const THUMB_SIZE = 512
/** 给模型的图：长边 1024。模型只看这么大，再大只是多传数据 */
const MODEL_INPUT_SIZE = 1024
const URL_TIMEOUT_MS = 20_000

const FORMAT_MIME: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" }

const open = (data: Buffer) => sharp(data, { animated: false, limitInputPixels: MAX_PIXELS })

export interface DecodedImage {
  mime: string
  /** 按 EXIF 方向转正以后的宽高 */
  width: number
  height: number
}

const sizeText = () => `${Math.round(runtime.uploadMaxBytes / 1024 / 1024)} MB`

export function checkSize(bytes: number) {
  if (bytes > runtime.uploadMaxBytes) throw new GalleryError("too_large", `图片太大，最多 ${sizeText()}`)
}

export async function decodeImage(data: Buffer): Promise<DecodedImage> {
  if (data.length === 0) throw new GalleryError("bad_request", "图片是空的")
  checkSize(data.length)
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>
  try {
    meta = await open(data).metadata()
  } catch {
    throw new GalleryError("bad_request", "认不出这张图片：支持 jpg、png、webp、gif")
  }
  const mime = meta.format ? FORMAT_MIME[meta.format] : undefined
  if (!mime || !meta.width || !meta.height) throw new GalleryError("bad_request", `不支持的图片格式${meta.format ? `（${meta.format}）` : ""}：支持 jpg、png、webp、gif`)
  if (meta.width * meta.height > MAX_PIXELS) throw new GalleryError("too_large", "图片像素太多（超过 1 亿像素）")
  const rotated = (meta.orientation ?? 1) >= 5
  return { mime, width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height }
}

/** 缩略图：长边 512 的 webp（满屏图片墙用） */
export async function makeThumbnail(data: Buffer): Promise<Buffer> {
  return open(data).rotate().resize(THUMB_SIZE, THUMB_SIZE, { fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
}

/**
 * 给 embedding 模型的图：转正、长边缩到 1024、透明的地方垫白、存成 JPEG。
 * 存图和搜图都过这一道，同一张图不管原来是什么格式、多大，算出来的向量都尽量一样
 */
export async function modelInputImage(data: Buffer): Promise<Buffer> {
  try {
    return await open(data)
      .rotate()
      .resize(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90 })
      .toBuffer()
  } catch {
    throw new GalleryError("bad_request", "认不出这张图片：支持 jpg、png、webp、gif")
  }
}

/** 读出来的图片内容 */
export interface LoadedImage {
  data: Buffer
  /** 文件名（上传时记下来） */
  name: string
}

export interface RefOptions {
  /** agent 用：只能指这次运行看得到的文件（附件、截图、产物）。不传 = 任何文件都行（登录的人本来就能下载所有文件） */
  canReadFile?: (fileId: string) => Promise<boolean>
}

/** 把 base64 / 网址 / 文件 id 读成图片内容。imageId 由调用方自己处理（能直接用存好的向量） */
export async function loadImageRef(db: DbLike, ref: Exclude<GalleryImageRef, { imageId: string }>, options: RefOptions = {}): Promise<LoadedImage> {
  if ("base64" in ref) {
    const text = ref.base64.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "")
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) throw new GalleryError("bad_request", "base64 内容不对")
    // base64 每 4 个字符是 3 个字节，先估一下，免得解出一大块再报太大
    checkSize(Math.floor((text.length * 3) / 4))
    return { data: Buffer.from(text, "base64"), name: "image" }
  }
  if ("fileId" in ref) {
    if (options.canReadFile && !(await options.canReadFile(ref.fileId))) throw new GalleryError("not_found", `这次运行里没有文件 ${ref.fileId}`)
    const row = await getFileRow(db, ref.fileId)
    if (!row) throw new GalleryError("not_found", `找不到文件 ${ref.fileId}`)
    checkSize(row.size)
    const data = await readFileData(row).catch(() => {
      throw new GalleryError("not_found", `文件 ${ref.fileId} 的内容不见了`)
    })
    return { data, name: row.name }
  }
  return downloadImage(ref.url)
}

async function downloadImage(url: string): Promise<LoadedImage> {
  let response: Response
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(URL_TIMEOUT_MS), headers: { accept: "image/*" } })
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? `${URL_TIMEOUT_MS / 1000} 秒没下载完` : (error as Error).message
    throw new GalleryError("bad_request", `下载图片失败：${reason}`)
  }
  if (!response.ok || !response.body) throw new GalleryError("bad_request", `下载图片失败：HTTP ${response.status}`)
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (declared) checkSize(declared)
  // 边读边数，超过上限就停（content-length 可能没有或者不准）
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length
    checkSize(total)
    chunks.push(Buffer.from(chunk))
  }
  return { data: Buffer.concat(chunks), name: nameFromUrl(response.url || url) }
}

/** 网址最后一段当文件名（解不开的 %xx 就原样留着） */
function nameFromUrl(url: string) {
  const last = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? ""
  try {
    return decodeURIComponent(last) || "image"
  } catch {
    return last || "image"
  }
}
