// 图库要带文件的两个操作走 HTTP 接口（cookie 自动带上）：传图、上传一张图来搜。其余的（列表、找相似、改、删）走 tRPC。
import type { GalleryFilter, GalleryPage, GalleryUploadResult } from "@heyagent/shared"

async function send<T>(path: string, form: FormData): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { method: "POST", body: form })
  } catch {
    throw new Error("连不上服务器，请检查网络")
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `没成功：HTTP ${response.status}`)
  return body
}

/** 传一张图；一模一样的图已经在图库里时 duplicate 为 true */
export function uploadToGallery(file: File, fields: { text?: Record<string, unknown>; tags?: string[] }) {
  const form = new FormData()
  form.append("image", file)
  if (fields.text && Object.keys(fields.text).length) form.append("text", JSON.stringify(fields.text))
  if (fields.tags?.length) form.append("tags", JSON.stringify(fields.tags))
  return send<GalleryUploadResult>("/api/gallery/images", form)
}

/** 以图搜图：传一张本地的图，结果按相似度排；minScore 是相似度下限（-1～1） */
export function searchGalleryByImage(file: File, filter: GalleryFilter & { limit?: number; minScore?: number }) {
  const form = new FormData()
  form.append("image", file)
  if (filter.tags?.length) form.append("tags", JSON.stringify(filter.tags))
  if (filter.text) form.append("text", JSON.stringify(filter.text))
  if (filter.keyword) form.append("keyword", filter.keyword)
  if (filter.limit) form.append("limit", String(filter.limit))
  if (filter.minScore !== undefined) form.append("minScore", String(filter.minScore))
  return send<GalleryPage>("/api/gallery/search", form)
}

/** 搜索框：写的是 JSON 对象就按包含匹配，别的按关键词。JSON 写坏了返回 error */
export function parseSearchBox(value: string): { filter: Pick<GalleryFilter, "text" | "keyword">; error?: string } {
  const text = value.trim()
  if (!text) return { filter: {} }
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { filter: { text: parsed as Record<string, unknown> } }
    } catch {
      // 落到下面
    }
    return { filter: {}, error: "JSON 没写完整，例如 {\"颜色\": \"红\"}" }
  }
  return { filter: { keyword: text } }
}
