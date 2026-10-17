// 传图：一次可以选多张（或者拖进来），这一批用同样的标签和文本（JSON 对象）。一张一张传，每张显示状态；
// 一模一样的图已经在图库里时不新建，显示「已经在图库里」。全部成功就关掉，有失败的留着让人看原因、再试。
// 表单：React Hook Form + shared 的 galleryFormSchema（标签、文本），图片列表单独放在 state 里。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { CircleCheckIcon, ImagePlusIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import { galleryFormSchema, galleryFormText, type GalleryForm, type GalleryTagCount } from "@heyagent/shared"

import { TagsCombobox } from "@/components/shell/tags-combobox"
import {
  Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle,
} from "@/components/ui/attachment"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"

import { fmtSize } from "@/lib/files"
import { uploadToGallery } from "@/lib/gallery"
import { queryClient } from "@/lib/trpc"

interface Pending {
  key: string
  file: File
  preview: string
  state: "idle" | "uploading" | "done" | "error"
  note?: string
}

let nextKey = 0
const toPending = (file: File): Pending => ({ key: String(nextKey++), file, preview: URL.createObjectURL(file), state: "idle" })

export function UploadDialog({ initialFiles, tagOptions, onClose }: { initialFiles: File[]; tagOptions: GalleryTagCount[]; onClose: () => void }) {
  const [items, setItems] = React.useState<Pending[]>(() => initialFiles.map(toPending))
  const [busy, setBusy] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const pickRef = React.useRef<HTMLInputElement>(null)
  const form = useForm<GalleryForm>({ resolver: zodResolver(galleryFormSchema), defaultValues: { tags: [], text: "" } })
  const { errors } = form.formState

  // 关掉时释放预览图
  const itemsRef = React.useRef(items)
  React.useEffect(() => {
    itemsRef.current = items
  }, [items])
  React.useEffect(() => () => itemsRef.current.forEach((item) => URL.revokeObjectURL(item.preview)), [])

  const add = (files: Iterable<File>) => {
    const images = [...files].filter((file) => file.type.startsWith("image/"))
    if (images.length) setItems((list) => [...list, ...images.map(toPending)])
  }
  const patch = (key: string, next: Partial<Pending>) => setItems((list) => list.map((item) => (item.key === key ? { ...item, ...next } : item)))
  const removeItem = (key: string) =>
    setItems((list) => {
      const gone = list.find((item) => item.key === key)
      if (gone) URL.revokeObjectURL(gone.preview)
      return list.filter((item) => item.key !== key)
    })

  const todo = items.filter((item) => item.state === "idle" || item.state === "error")

  const submit = form.handleSubmit(async (values) => {
    if (todo.length === 0) return
    setBusy(true)
    const fields = { tags: values.tags, text: galleryFormText(values.text) }
    let created = 0
    let duplicate = 0
    let failed = 0
    for (const item of todo) {
      patch(item.key, { state: "uploading", note: undefined })
      try {
        const result = await uploadToGallery(item.file, fields)
        if (result.duplicate) duplicate += 1
        else created += 1
        patch(item.key, { state: "done", note: result.duplicate ? `已经在图库里（${result.image.id}）` : result.image.id })
      } catch (error) {
        failed += 1
        patch(item.key, { state: "error", note: error instanceof Error ? error.message : "没传上去" })
      }
    }
    setBusy(false)
    await queryClient.invalidateQueries()
    const summary = [created && `传了 ${created} 张`, duplicate && `${duplicate} 张已经在图库里`, failed && `${failed} 张失败`].filter(Boolean).join("，")
    toast.add({ title: failed ? "有图没传上去" : "传好了", description: summary, type: failed ? "error" : "success" })
    if (!failed) onClose()
  })

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>上传到图库</DialogTitle>
            <DialogDescription>这一批图用同样的标签和文本，传完以后每张都能单独改。</DialogDescription>
          </DialogHeader>
          <input
            ref={pickRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={(event) => {
              add(event.target.files ?? [])
              event.target.value = ""
            }}
          />
          <button
            type="button"
            onClick={() => pickRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setDragging(false)
              add(event.dataTransfer.files)
            }}
            data-dragging={dragging}
            className="flex flex-col items-center gap-2 border border-dashed p-6 text-sm text-muted-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring data-[dragging=true]:bg-muted"
          >
            <ImagePlusIcon />
            选择图片，或者拖到这里（可以多选；jpg、png、webp、gif，每张最多 20 MB）
          </button>
          {items.length > 0 && (
            <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto">
              {items.map((item) => (
                <Attachment key={item.key} orientation="vertical" state={item.state === "idle" ? "done" : item.state}>
                  <AttachmentMedia variant="image">
                    {item.state === "uploading" ? <Spinner /> : <img src={item.preview} alt={item.file.name} />}
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle title={item.file.name}>{item.file.name}</AttachmentTitle>
                    <AttachmentDescription title={item.note}>
                      {item.state === "done" && <CircleCheckIcon data-icon="inline-start" />}
                      {item.state === "error" && <TriangleAlertIcon data-icon="inline-start" />}
                      {item.note ?? fmtSize(item.file.size)}
                    </AttachmentDescription>
                  </AttachmentContent>
                  {(item.state === "idle" || item.state === "error") && !busy && (
                    <AttachmentActions>
                      <AttachmentAction aria-label={`不传 ${item.file.name}`} onClick={() => removeItem(item.key)}>
                        <XIcon />
                      </AttachmentAction>
                    </AttachmentActions>
                  )}
                </Attachment>
              ))}
            </div>
          )}
          <FieldGroup>
            <Field data-invalid={Boolean(errors.tags)}>
              <FieldLabel htmlFor="gallery-upload-tags">标签</FieldLabel>
              <Controller
                control={form.control}
                name="tags"
                render={({ field }) => (
                  <TagsCombobox id="gallery-upload-tags" creatable value={field.value} onValueChange={field.onChange} options={tagOptions} placeholder="选已有的，或输入新标签" aria-invalid={Boolean(errors.tags)} />
                )}
              />
              <FieldError errors={[errors.tags]} />
            </Field>
            <Field data-invalid={Boolean(errors.text)}>
              <FieldLabel htmlFor="gallery-upload-text">文本（JSON 对象）</FieldLabel>
              <Textarea id="gallery-upload-text" className="min-h-28 font-mono" spellCheck={false} placeholder='{"名称": "…", "来源": "…"}' aria-invalid={Boolean(errors.text)} {...form.register("text")} />
              {errors.text ? <FieldError errors={[errors.text]} /> : <FieldDescription>可以空着。检索时能按关键词、包含匹配、字段条件找。</FieldDescription>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={busy} />}>取消</DialogClose>
            <Button type="submit" disabled={busy || todo.length === 0}>
              {busy && <Spinner data-icon="inline-start" />}
              {todo.length ? `上传 ${todo.length} 张` : "上传"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
