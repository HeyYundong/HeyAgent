// 输入框上要随消息发的图和文件（2026-10-20）：点「加附件」选、在输入框里粘贴、拖到面板上。一加进来就上传（POST /api/files），
// 发消息时只带文件编号。按类型分：图片（png / jpeg / gif / webp，最多 ASSISTANT_MAX_IMAGES 张）进图片，
// 文本文件（md、txt、html、csv、json……）和 PDF、Word（.docx）进文件（最多 ASSISTANT_MAX_FILES 个，docs/dev/copilot.md 第 12 节）。
// 显示用 registry 的 Attachment（图是缩略图、文件是 FileTextIcon，上传中 / 出错的 state、移除按钮），排在同一排、多了左右滚（AttachmentGroup）。
// 文件的图标不用 components/files 的 fileTypeIcon：那个模块带着 Markdown、代码高亮，面板一直在页面上，不把它拉进首屏。
import * as React from "react"
import { FileTextIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { ASSISTANT_DOC_EXTENSIONS, ASSISTANT_DOC_MAX_BYTES, ASSISTANT_FILE_MAX_BYTES, ASSISTANT_MAX_FILES, ASSISTANT_MAX_IMAGES, ASSISTANT_TEXT_EXTENSIONS, assistantFileKind, oldWordProblem, type AssistantFile, type AssistantImage } from "@heyagent/shared"

import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment"
import { fmtSize, uploadFile } from "@/lib/files"

/** 模型能看的图片格式（和服务器收的一致） */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]
/** 选文件框：图片 + 文本、PDF、Word 的扩展名 */
export const ATTACHMENT_ACCEPT = [...IMAGE_TYPES, ...ASSISTANT_TEXT_EXTENSIONS, ...ASSISTANT_DOC_EXTENSIONS].join(",")

const MB = 1024 * 1024

export type PendingAttachment = {
  key: string
  kind: "image" | "file"
  name: string
  size: number
  /** 图的缩略图：刚选的是本地 blob 地址，放回来的（没发出去）是服务器地址；文件没有 */
  preview?: string
  state: "uploading" | "error" | "done"
  /** 传好了才有 */
  uploaded?: AssistantImage
  error?: string
}

let nextKey = 0
const newKey = () => `att-${++nextKey}`
const release = (item: PendingAttachment) => item.preview?.startsWith("blob:") && URL.revokeObjectURL(item.preview)

/** 拖进来的东西里有没有文件（拖文字、链接时不管） */
export const hasFiles = (event: React.DragEvent) => [...event.dataTransfer.items].some((item) => item.kind === "file")

/** 发出去的、放回来的：图和文件分开 */
export type Attached = { images: AssistantImage[]; files: AssistantFile[] }

export function usePendingAttachments() {
  const [items, setItems] = React.useState<PendingAttachment[]>([])
  /** 加附件时的提示（格式不对、太大、超过个数），下次加或发出去时清掉 */
  const [notice, setNotice] = React.useState<string | null>(null)
  // 最新的一份同时记在 ref 里（每次改都同步写）：上传回来、发送时读到的不会是上一次渲染的旧值
  const itemsRef = React.useRef(items)
  const commit = (list: PendingAttachment[]) => {
    itemsRef.current = list
    setItems(list)
  }
  // 面板卸载时释放预览图
  React.useEffect(() => () => itemsRef.current.forEach(release), [])

  /** 上传回来时改那一项（已经移除了就不管） */
  const patch = (key: string, next: Partial<PendingAttachment>) => commit(itemsRef.current.map((item) => (item.key === key ? { ...item, ...next } : item)))

  /** 加附件：按类型分成图和文件；格式不对、太大、超过个数的不要，并说一声；其余马上上传 */
  function add(list: Iterable<File>) {
    let images = itemsRef.current.filter((item) => item.kind === "image").length
    let files = itemsRef.current.length - images
    const notes: string[] = []
    let badType = false
    let tooManyImages = false
    let tooManyFiles = false
    const added: { file: File; item: PendingAttachment }[] = []
    for (const file of list) {
      const item = { key: newKey(), name: file.name, size: file.size, state: "uploading" } satisfies Omit<PendingAttachment, "kind">
      if (IMAGE_TYPES.includes(file.type)) {
        if (images >= ASSISTANT_MAX_IMAGES) tooManyImages = true
        else {
          images++
          added.push({ file, item: { ...item, kind: "image", name: file.name || "粘贴的图片", preview: URL.createObjectURL(file) } })
        }
        continue
      }
      const kind = assistantFileKind(file.name)
      const max = kind === "doc" ? ASSISTANT_DOC_MAX_BYTES : ASSISTANT_FILE_MAX_BYTES
      if (kind === "old-word") notes.push(oldWordProblem(file.name))
      else if (!kind) badType = true
      else if (file.size > max) notes.push(`${file.name} 太大，${kind === "doc" ? "PDF 和 Word 文件" : "文本文件"}最多 ${Math.round(max / MB)} MB`)
      else if (files >= ASSISTANT_MAX_FILES) tooManyFiles = true
      else {
        files++
        added.push({ file, item: { ...item, kind: "file" } })
      }
    }
    if (badType) notes.unshift("只能发图片（png、jpg、gif、webp）和文本文件（md、txt、html、csv、json 等）、PDF、Word（.docx）")
    if (tooManyImages) notes.push(`一条消息最多 ${ASSISTANT_MAX_IMAGES} 张图，多的没加上`)
    if (tooManyFiles) notes.push(`一条消息最多 ${ASSISTANT_MAX_FILES} 个文件，多的没加上`)
    setNotice(notes.length ? `${notes.join("；")}。` : null)
    if (added.length === 0) return
    commit([...itemsRef.current, ...added.map(({ item }) => item)])
    for (const { file, item } of added) {
      uploadFile(file).then(
        (uploaded) => patch(item.key, { state: "done", uploaded }),
        (error: unknown) => patch(item.key, { state: "error", error: error instanceof Error ? error.message : String(error) })
      )
    }
  }

  function remove(key: string) {
    const gone = itemsRef.current.find((item) => item.key === key)
    if (gone) release(gone)
    commit(itemsRef.current.filter((item) => item.key !== key))
    setNotice(null)
  }

  /** 发出去了：清空输入框上的附件，返回传好的那些 */
  function take(): Attached {
    const done = (kind: PendingAttachment["kind"]) => itemsRef.current.flatMap((item) => (item.kind === kind && item.uploaded ? [item.uploaded] : []))
    const sent = { images: done("image"), files: done("file") }
    itemsRef.current.forEach(release)
    commit([])
    setNotice(null)
    return sent
  }

  /** 没发出去：图和文件放回来（人这期间又加了就不覆盖） */
  function restore({ images, files }: Attached) {
    if (images.length + files.length === 0 || itemsRef.current.length > 0) return
    const back = (kind: PendingAttachment["kind"], file: AssistantImage): PendingAttachment => ({
      key: newKey(),
      kind,
      name: file.name,
      size: file.size,
      ...(kind === "image" ? { preview: file.url } : {}),
      state: "done",
      uploaded: file,
    })
    commit([...images.map((image) => back("image", image)), ...files.map((file) => back("file", file))])
  }

  const imageCount = items.filter((item) => item.kind === "image").length
  return {
    items,
    notice,
    add,
    remove,
    take,
    restore,
    /** 图和文件都满了：「加附件」按钮不能点 */
    full: imageCount >= ASSISTANT_MAX_IMAGES && items.length - imageCount >= ASSISTANT_MAX_FILES,
    uploading: items.some((item) => item.state === "uploading"),
    failed: items.some((item) => item.state === "error"),
    ready: items.filter((item) => item.state === "done").length,
  }
}

export type PendingAttachments = ReturnType<typeof usePendingAttachments>

/** 输入框上方的一排图和文件：上传中半透明、出错标红写原因，右边一个移除 */
export function PendingAttachmentList({ attachments }: { attachments: PendingAttachments }) {
  return (
    <AttachmentGroup className="w-full">
      {attachments.items.map((item) => {
        const description = item.state === "uploading" ? "正在上传…" : item.state === "error" ? (item.error ?? "没传上去") : fmtSize(item.uploaded?.size ?? item.size)
        return (
          <Attachment key={item.key} size="sm" state={item.state} className="max-w-48">
            <AttachmentMedia variant={item.kind === "image" && item.state !== "error" ? "image" : "icon"}>
              {item.state === "error" ? <TriangleAlertIcon /> : item.kind === "image" ? <img src={item.preview} alt={item.name} /> : <FileTextIcon />}
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle title={item.name}>{item.name}</AttachmentTitle>
              <AttachmentDescription title={description}>{description}</AttachmentDescription>
            </AttachmentContent>
            <AttachmentActions>
              <AttachmentAction aria-label={`移除 ${item.name}`} onClick={() => attachments.remove(item.key)}>
                <XIcon />
              </AttachmentAction>
            </AttachmentActions>
          </Attachment>
        )
      })}
    </AttachmentGroup>
  )
}
