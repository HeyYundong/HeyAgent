// 附件和产物的显示与上传（组合 registry 的 Attachment、Button、Input）：任务附件、带附件运行、session 的附件和产物都用它。
// 下载走 GET /api/files/:id（要求登录，cookie 自动带上）；图片在新标签页直接显示，其他文件下载。
import * as React from "react"
import { DownloadIcon, FileTextIcon, ImageIcon, PaperclipIcon, XIcon } from "lucide-react"
import type { SessionFile, UploadedFile } from "@heyagent/shared"

import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { fmtSize, uploadFile } from "@/lib/files"

const KIND_LABEL: Record<SessionFile["kind"], string> = {
  attachment: "附件",
  artifact: "产物",
  tool_output: "工具输出全文",
  screenshot: "截图",
  upload: "刚上传",
}

type ShownFile = Pick<SessionFile, "id" | "name" | "mime" | "size" | "url"> & { kind?: SessionFile["kind"]; scope?: SessionFile["scope"] }

function describe(file: ShownFile) {
  const parts = [fmtSize(file.size)]
  if (file.kind) parts.push(file.scope === "task" ? "任务附件" : KIND_LABEL[file.kind])
  return parts.join(" · ")
}

/** 一组文件：每个一张小卡，带下载；给了 onRemove 就多一个移除按钮 */
export function FileList({ files, onRemove, removingId, empty }: { files: ShownFile[]; onRemove?: (file: ShownFile) => void; removingId?: string; empty?: React.ReactNode }) {
  if (files.length === 0) return empty ? <>{empty}</> : null
  return (
    <div className="flex flex-wrap gap-2">
      {files.map((file) => (
        <Attachment key={file.id} size="sm" className="max-w-full sm:max-w-72">
          <AttachmentMedia>{file.mime.startsWith("image/") ? <ImageIcon /> : <FileTextIcon />}</AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle title={file.name}>{file.name}</AttachmentTitle>
            <AttachmentDescription>{describe(file)}</AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            <AttachmentAction aria-label={`下载 ${file.name}`} nativeButton={false} render={<a href={file.url} target={file.mime.startsWith("image/") ? "_blank" : undefined} rel="noreferrer" download={file.mime.startsWith("image/") ? undefined : file.name} />}>
              <DownloadIcon />
            </AttachmentAction>
            {onRemove && (
              <AttachmentAction aria-label={`移除 ${file.name}`} disabled={removingId === file.id} onClick={() => onRemove(file)}>
                {removingId === file.id ? <Spinner /> : <XIcon />}
              </AttachmentAction>
            )}
          </AttachmentActions>
        </Attachment>
      ))}
    </div>
  )
}

/** 「上传附件」按钮：可以一次选多个，一个个传，传好一个回调一次；失败的弹 toast */
export function UploadButton({ onUploaded, label = "上传附件", disabled, size = "sm" }: { onUploaded: (file: UploadedFile) => void | Promise<void>; label?: string; disabled?: boolean; size?: "sm" | "default" }) {
  const input = React.useRef<HTMLInputElement>(null)
  const [busy, setBusy] = React.useState(false)
  const pick = async (list: FileList | null) => {
    const picked = [...(list ?? [])]
    if (input.current) input.current.value = ""
    if (picked.length === 0) return
    setBusy(true)
    try {
      for (const file of picked) {
        try {
          await onUploaded(await uploadFile(file))
        } catch (error) {
          toast.add({ title: `${file.name} 没传上去`, description: error instanceof Error ? error.message : String(error), type: "error" })
        }
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Input ref={input} type="file" multiple hidden aria-hidden tabIndex={-1} onChange={(event) => void pick(event.target.files)} />
      <Button type="button" variant="outline" size={size} disabled={disabled || busy} onClick={() => input.current?.click()}>
        {busy ? <Spinner data-icon="inline-start" /> : <PaperclipIcon data-icon="inline-start" />}
        {busy ? "正在上传…" : label}
      </Button>
    </>
  )
}
