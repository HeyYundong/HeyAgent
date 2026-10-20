// 输入框上要随消息发的图（2026-10-20）：点「加图片」选、在输入框里粘贴、拖到面板上。一加进来就上传（POST /api/files），
// 发消息时只带文件编号。只收 png / jpeg / gif / webp，一条消息最多 ASSISTANT_MAX_IMAGES 张。
// 显示用 registry 的 Attachment（缩略图、上传中 / 出错的 state、移除按钮），横着排、多了左右滚（AttachmentGroup）。
import * as React from "react"
import { TriangleAlertIcon, XIcon } from "lucide-react"
import { ASSISTANT_MAX_IMAGES, type AssistantImage } from "@heyagent/shared"

import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment"
import { fmtSize, uploadFile } from "@/lib/files"

/** 模型能看的图片格式（和服务器收的一致） */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]
export const IMAGE_ACCEPT = IMAGE_TYPES.join(",")

export type PendingImage = {
  key: string
  name: string
  /** 缩略图：刚选的是本地 blob 地址，放回来的（没发出去）是服务器地址 */
  preview: string
  state: "uploading" | "error" | "done"
  /** 传好了才有 */
  uploaded?: AssistantImage
  error?: string
}

let nextKey = 0
const newKey = () => `img-${++nextKey}`
const release = (item: PendingImage) => item.preview.startsWith("blob:") && URL.revokeObjectURL(item.preview)

/** 拖进来的东西里有没有文件（拖文字、链接时不管） */
export const hasFiles = (event: React.DragEvent) => [...event.dataTransfer.items].some((item) => item.kind === "file")

export function usePendingImages() {
  const [items, setItems] = React.useState<PendingImage[]>([])
  /** 加图时的提示（格式不对、超过张数），下次加图或发出去时清掉 */
  const [notice, setNotice] = React.useState<string | null>(null)
  // 最新的一份同时记在 ref 里（每次改都同步写）：上传回来、发送时读到的不会是上一次渲染的旧值
  const itemsRef = React.useRef(items)
  const commit = (list: PendingImage[]) => {
    itemsRef.current = list
    setItems(list)
  }
  // 面板卸载时释放预览图
  React.useEffect(() => () => itemsRef.current.forEach(release), [])

  /** 上传回来时改那一张（已经移除了就不管） */
  const patch = (key: string, next: Partial<PendingImage>) => commit(itemsRef.current.map((item) => (item.key === key ? { ...item, ...next } : item)))

  /** 加图：不是这几种格式的、超过张数的不要，并说一声；其余马上上传 */
  function add(files: Iterable<File>) {
    const all = [...files]
    const images = all.filter((file) => IMAGE_TYPES.includes(file.type))
    const room = Math.max(0, ASSISTANT_MAX_IMAGES - itemsRef.current.length)
    const taken = images.slice(0, room)
    const notes: string[] = []
    if (images.length < all.length) notes.push("只能发 png、jpg、gif、webp 图片")
    if (taken.length < images.length) notes.push(`一条消息最多 ${ASSISTANT_MAX_IMAGES} 张图`)
    setNotice(notes.length ? `${notes.join("；")}，多的没加上。` : null)
    if (taken.length === 0) return
    const added = taken.map((file) => ({ file, item: { key: newKey(), name: file.name || "粘贴的图片", preview: URL.createObjectURL(file), state: "uploading" } satisfies PendingImage }))
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

  /** 发出去了：清空输入框上的图，返回传好的那些 */
  function take(): AssistantImage[] {
    const sent = itemsRef.current.flatMap((item) => (item.uploaded ? [item.uploaded] : []))
    itemsRef.current.forEach(release)
    commit([])
    setNotice(null)
    return sent
  }

  /** 没发出去：图放回来（人这期间又加了图就不覆盖） */
  function restore(images: AssistantImage[]) {
    if (images.length === 0 || itemsRef.current.length > 0) return
    commit(images.map((image): PendingImage => ({ key: newKey(), name: image.name, preview: image.url, state: "done", uploaded: image })))
  }

  return {
    items,
    notice,
    add,
    remove,
    take,
    restore,
    full: items.length >= ASSISTANT_MAX_IMAGES,
    uploading: items.some((item) => item.state === "uploading"),
    failed: items.some((item) => item.state === "error"),
    ready: items.filter((item) => item.state === "done").length,
  }
}

export type PendingImages = ReturnType<typeof usePendingImages>

/** 输入框上方的一排图：上传中半透明、出错标红写原因，右边一个移除 */
export function PendingImageList({ images }: { images: PendingImages }) {
  return (
    <AttachmentGroup className="w-full">
      {images.items.map((item) => {
        const description = item.state === "uploading" ? "正在上传…" : item.state === "error" ? (item.error ?? "没传上去") : fmtSize(item.uploaded?.size ?? 0)
        return (
          <Attachment key={item.key} size="sm" state={item.state} className="max-w-48">
            <AttachmentMedia variant={item.state === "error" ? "icon" : "image"}>{item.state === "error" ? <TriangleAlertIcon /> : <img src={item.preview} alt={item.name} />}</AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle title={item.name}>{item.name}</AttachmentTitle>
              <AttachmentDescription title={description}>{description}</AttachmentDescription>
            </AttachmentContent>
            <AttachmentActions>
              <AttachmentAction aria-label={`移除 ${item.name}`} onClick={() => images.remove(item.key)}>
                <XIcon />
              </AttachmentAction>
            </AttachmentActions>
          </Attachment>
        )
      })}
    </AttachmentGroup>
  )
}
