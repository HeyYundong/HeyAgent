// 导入：上传 zip 包走 HTTP（POST /api/imports，multipart：file、note、modelId），返回一条导入记录；下载原包 GET /api/imports/:id/file。
// 其余（列表、详情、存方案、导入、撤销……）走 tRPC imports.*。
// 上传用 XMLHttpRequest：fetch 拿不到上传进度，100 MB 的包要让人看到传到哪了。
import type { ImportRecord } from "@heyagent/shared"

/** 上传一个 zip 包，开始读包。onProgress 收到 0～100 的整数 */
export function uploadImport(file: File, fields: { note?: string; modelId?: string }, onProgress?: (percent: number) => void): Promise<ImportRecord> {
  const form = new FormData()
  form.append("file", file)
  if (fields.note?.trim()) form.append("note", fields.note.trim())
  if (fields.modelId) form.append("modelId", fields.modelId)

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", "/api/imports")
    xhr.responseType = "json"
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)))
    }
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as Partial<ImportRecord> & { error?: string }
      if (xhr.status >= 200 && xhr.status < 300 && body.id) resolve(body as ImportRecord)
      else reject(new Error(body.error ?? `没传上去：HTTP ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error("连不上服务器，请检查网络"))
    xhr.onabort = () => reject(new Error("上传取消了"))
    xhr.send(form)
  })
}

/** 下载上传的原包 */
export const importFileUrl = (id: string) => `/api/imports/${encodeURIComponent(id)}/file`
