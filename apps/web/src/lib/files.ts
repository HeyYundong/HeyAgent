// 文件上传（POST /api/files，multipart，字段名 file）和大小显示。上传后拿到 id：立即运行时传给 engine.runNow，
// 或者用 engine.attachToTask 挂到任务上（每次运行都带）。下载直接用接口返回的 url（GET /api/files/:id，要求登录）。
import type { UploadedFile } from "@heyagent/shared"

export async function uploadFile(file: File): Promise<UploadedFile> {
  const form = new FormData()
  form.append("file", file)
  let response: Response
  try {
    response = await fetch("/api/files", { method: "POST", body: form })
  } catch {
    throw new Error("连不上服务器，请检查网络")
  }
  const body = (await response.json().catch(() => ({}))) as Partial<UploadedFile> & { error?: string }
  if (!response.ok || !body.id) throw new Error(body.error ?? `上传失败：HTTP ${response.status}`)
  return body as UploadedFile
}

/** 「12.3 KB」 */
export function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
