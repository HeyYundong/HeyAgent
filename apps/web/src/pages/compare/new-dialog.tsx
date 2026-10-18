// 新比对弹窗：两张图（拖进来、Ctrl+V 粘贴、上传、从图库选、填网址）+ 比对标准（或这次自己写要求）+ 标题。
// 上传的图先走 POST /api/files 拿到文件 id；图库的图用 imageId；网址交给服务器去下载。开始后马上返回「比对中」的记录。
// 表单：React Hook Form + Field（图片不是表单字段，放在 state 里）。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { CheckIcon, ImageIcon, ImagesIcon, LinkIcon, SearchIcon, UploadIcon, XIcon } from "lucide-react"
import { Controller, useForm, useWatch } from "react-hook-form"
import type { CompareCreateInput, Comparison, GalleryImageRef } from "@heyagent/shared"

import { AspectRatio } from "@/components/ui/aspect-ratio"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"

import { useModels } from "@/lib/data"
import { uploadFile } from "@/lib/files"
import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

import { StandardsDialog } from "./standards-dialog"

/** 比对标准下拉里「这次自己写要求」那一项 */
const CUSTOM = "custom"
/** 模型下拉里「跟着标准」那一项 */
const FOLLOW = "follow"
const URL_PATTERN = /^https?:\/\/\S+$/

/** 一张图的位置：空着 / 正在上传 / 选好了（ref 是交给接口的图片引用） */
type Slot = { state: "empty" } | { state: "uploading"; preview: string } | { state: "ready"; ref: GalleryImageRef; preview: string; name: string }
const EMPTY: Slot = { state: "empty" }

const isImageFile = (file: File) => file.type.startsWith("image/")

interface FormValues {
  standard: string
  prompt: string
  passScore: number
  modelId: string
  title: string
}

export function NewCompareDialog({ open, onOpenChange, onStarted }: { open: boolean; onOpenChange: (open: boolean) => void; onStarted: (record: Comparison) => void }) {
  const standardsQuery = useQuery(trpc.compare.standards.queryOptions())
  const modelsQuery = useQuery({ ...trpc.compare.models.queryOptions(), retry: false })
  const { modelName } = useModels()
  const standards = standardsQuery.data ?? []
  const fallback = standards.find((each) => each.isDefault) ?? standards[0]

  const [slots, setSlots] = React.useState<[Slot, Slot]>([EMPTY, EMPTY])
  const [managing, setManaging] = React.useState(false)
  const [picking, setPicking] = React.useState<0 | 1 | null>(null)
  const [changingModel, setChangingModel] = React.useState(false)
  const form = useForm<FormValues>({ defaultValues: { standard: "", prompt: "", passScore: 90, modelId: FOLLOW, title: "" } })
  const { errors } = form.formState
  const create = useAction(trpc.compare.create.mutationOptions(), {
    success: (record) => (record.reused ? `${record.id} 是 10 分钟内比过同样的，直接用上次的结果` : undefined),
    errorTitle: "没开始比",
  })

  // 标准拿到以后默认选中默认的那个；一个标准都没有时只能自己写要求
  const [standardValue, modelId] = useWatch({ control: form.control, name: ["standard", "modelId"] })
  const chosen = standardValue || (fallback ? fallback.id : CUSTOM)
  const custom = chosen === CUSTOM
  const current = standards.find((each) => each.id === chosen)
  const followModel = (custom ? fallback : current)?.modelId

  const setSlot = (index: 0 | 1, slot: Slot) =>
    setSlots((list) => {
      const next: [Slot, Slot] = [...list]
      const old = next[index]
      if (old.state !== "empty" && old.preview.startsWith("blob:") && old.preview !== ("preview" in slot ? slot.preview : "")) URL.revokeObjectURL(old.preview)
      next[index] = slot
      return next
    })

  // 关掉弹窗时释放本地预览
  const slotsRef = React.useRef(slots)
  React.useEffect(() => {
    slotsRef.current = slots
  }, [slots])
  React.useEffect(() => () => slotsRef.current.forEach((slot) => slot.state !== "empty" && slot.preview.startsWith("blob:") && URL.revokeObjectURL(slot.preview)), [])

  const upload = async (index: 0 | 1, file: File) => {
    if (!isImageFile(file)) {
      toast.add({ title: "只能放图片", description: `${file.name} 不是图片。`, type: "error" })
      return
    }
    const preview = URL.createObjectURL(file)
    setSlot(index, { state: "uploading", preview })
    try {
      const uploaded = await uploadFile(file)
      setSlot(index, { state: "ready", ref: { fileId: uploaded.id }, preview, name: file.name })
    } catch (error) {
      setSlot(index, EMPTY)
      toast.add({ title: `${file.name} 没传上去`, description: error instanceof Error ? error.message : String(error), type: "error" })
    }
  }

  // Ctrl+V 粘贴图片：放进第一个空着的位置（两张都有了就换第二张）。管理标准、从图库选的弹窗开着时不管
  React.useEffect(() => {
    if (!open || managing || picking !== null) return
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find(isImageFile)
      if (!file) return
      event.preventDefault()
      const index = slotsRef.current[0].state === "empty" ? 0 : 1
      void upload(index, file)
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
    // upload 只用到 setState 和稳定的函数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, managing, picking])

  const [a, b] = slots
  const ready = a.state === "ready" && b.state === "ready"

  const submit = form.handleSubmit(async (values) => {
    if (a.state !== "ready" || b.state !== "ready") return
    const input: CompareCreateInput = {
      imageA: a.ref,
      imageB: b.ref,
      ...(custom ? { prompt: values.prompt.trim(), passScore: values.passScore } : { standard: chosen }),
      ...(values.modelId !== FOLLOW ? { modelId: values.modelId } : {}),
      ...(values.title.trim() ? { title: values.title.trim() } : {}),
    }
    const record = await create.submit(input)
    if (record) onStarted(record)
  })

  const standardItems = [...standards.map((each) => ({ value: each.id, label: `${each.name}（合格线 ${each.passScore}）` })), { value: CUSTOM, label: "这次自己写要求" }]
  const models = modelsQuery.data ?? []
  const modelItems = [
    { value: FOLLOW, label: followModel ? `跟着标准（${modelName(followModel)}）` : "跟着标准" },
    ...models.map((model) => ({ value: model.id, label: model.name })),
  ]

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>新比对</DialogTitle>
            <DialogDescription>两张图交给视觉模型，按比对标准逐项打分、写出差异。一般十几秒，比完在左边列表里。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid grid-cols-2 gap-4">
              {(["第一张（参照）", "第二张（要判断的）"] as const).map((label, index) => (
                <ImageSlot
                  key={label}
                  label={label}
                  slot={slots[index as 0 | 1]}
                  onFile={(file) => void upload(index as 0 | 1, file)}
                  onUrl={(url) => setSlot(index as 0 | 1, { state: "ready", ref: { url }, preview: url, name: url })}
                  onGallery={() => setPicking(index as 0 | 1)}
                  onClear={() => setSlot(index as 0 | 1, EMPTY)}
                />
              ))}
            </div>
            <Field>
              <FieldLabel htmlFor="cmp-standard">比对标准</FieldLabel>
              <div className="flex gap-2">
                <Controller
                  control={form.control}
                  name="standard"
                  render={({ field }) => (
                    <Select items={standardItems} value={chosen} onValueChange={(value) => value && field.onChange(String(value))} disabled={standardsQuery.isPending}>
                      <SelectTrigger id="cmp-standard" className="min-w-0 flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {standardItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <Button type="button" variant="outline" onClick={() => setManaging(true)}>
                  管理标准
                </Button>
              </div>
              {!custom && (
                <FieldDescription>
                  用 {modelName(modelId !== FOLLOW ? modelId : current?.modelId)}，总分到 {current?.passScore ?? "—"} 算达标。
                  {!changingModel && (
                    <Button type="button" variant="link" size="xs" onClick={() => setChangingModel(true)}>
                      换模型
                    </Button>
                  )}
                </FieldDescription>
              )}
            </Field>
            {custom && (
              <>
                <Field data-invalid={!!errors.prompt}>
                  <FieldLabel htmlFor="cmp-prompt">这次的要求</FieldLabel>
                  <Textarea
                    id="cmp-prompt"
                    rows={4}
                    placeholder="写清楚什么算像、看哪些方面、怎么打分。例如：只看颜色是否一致，形状不同没关系"
                    aria-invalid={!!errors.prompt}
                    {...form.register("prompt", { validate: (value) => (custom && !value.trim() ? "写清楚这次比什么、怎么打分" : value.length > 4000 ? "最多 4000 字" : true) })}
                  />
                  <FieldError errors={[errors.prompt]} />
                </Field>
                <Field data-invalid={!!errors.passScore}>
                  <FieldLabel htmlFor="cmp-pass">合格线</FieldLabel>
                  <Input
                    id="cmp-pass"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={100}
                    step={1}
                    className="w-full sm:w-32"
                    aria-invalid={!!errors.passScore}
                    {...form.register("passScore", { valueAsNumber: true, validate: (value) => (Number.isInteger(value) && value >= 0 && value <= 100 ? true : "0～100 的整数") })}
                  />
                  {errors.passScore ? <FieldError errors={[errors.passScore]} /> : <FieldDescription>总分到这里算达标。不想存成标准时用；常用的要求建议在「管理标准」里存一个。</FieldDescription>}
                </Field>
              </>
            )}
            {(custom || changingModel) && (
              <Field>
                <FieldLabel htmlFor="cmp-model">模型</FieldLabel>
                <Controller
                  control={form.control}
                  name="modelId"
                  render={({ field }) => (
                    <Select items={modelItems} value={field.value} onValueChange={(value) => value && field.onChange(String(value))}>
                      <SelectTrigger id="cmp-model" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {modelItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldDescription>{modelsQuery.isError ? "视觉模型列表没取到，先跟着标准用。" : "只列能看图的模型，按价格从低到高。"}</FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="cmp-title">标题（可以不写）</FieldLabel>
              <Input id="cmp-title" maxLength={200} placeholder="例如：保温杯 · 候选 4 号" {...form.register("title")} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={create.isPending} />}>取消</DialogClose>
            <Button type="submit" disabled={!ready || create.isPending}>
              {create.isPending && <Spinner data-icon="inline-start" />}
              开始比对
            </Button>
          </DialogFooter>
        </form>
        <StandardsDialog open={managing} onOpenChange={setManaging} />
        {picking !== null && (
          <GalleryPickDialog
            onClose={() => setPicking(null)}
            onPick={(image) => {
              setSlot(picking, { state: "ready", ref: { imageId: image.id }, preview: image.thumbUrl, name: image.name })
              setPicking(null)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * 一张图的位置：没选时是虚线框（拖进来 / 上传 / 从图库选 / 填网址），选了显示缩略图和「换一张」。
 * 虚线框是普通的 div（里面有按钮，不能再套 button），上传用隐藏的 <input type=file>，和图库的上传区同一写法。
 */
function ImageSlot({
  label,
  slot,
  onFile,
  onUrl,
  onGallery,
  onClear,
}: {
  label: string
  slot: Slot
  onFile: (file: File) => void
  onUrl: (url: string) => void
  onGallery: () => void
  onClear: () => void
}) {
  const pickRef = React.useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = React.useState(false)
  const [typing, setTyping] = React.useState(false)
  const [url, setUrl] = React.useState("")
  const [broken, setBroken] = React.useState(false)
  const urlBad = url.trim() !== "" && !URL_PATTERN.test(url.trim())
  const inputId = React.useId()

  const confirmUrl = () => {
    const value = url.trim()
    if (!URL_PATTERN.test(value)) return
    setTyping(false)
    setBroken(false)
    onUrl(value)
  }

  return (
    <Field>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <input
        ref={pickRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onFile(file)
          event.target.value = ""
        }}
      />
      {slot.state !== "empty" ? (
        <div className="relative border bg-muted">
          <AspectRatio ratio={1}>
            {broken ? (
              <div className="flex size-full flex-col items-center justify-center gap-2 p-4 text-center text-xs break-all text-muted-foreground">
                <LinkIcon />
                {slot.state === "ready" ? slot.name : ""}
                <span>浏览器里预览不了，服务器会去下载</span>
              </div>
            ) : (
              <img src={slot.preview} alt={label} className="size-full object-cover" onError={() => setBroken(true)} />
            )}
          </AspectRatio>
          {slot.state === "uploading" ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/60">
              <Spinner />
            </div>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="icon-xs"
              className="absolute top-1 right-1"
              aria-label={`换一张${label}`}
              onClick={() => {
                setBroken(false)
                onClear()
              }}
            >
              <XIcon />
            </Button>
          )}
        </div>
      ) : typing ? (
        <div className="flex aspect-square flex-col justify-center gap-2 border border-dashed p-4">
          <InputGroup>
            <InputGroupInput
              id={inputId}
              autoFocus
              placeholder="https://…"
              value={url}
              aria-invalid={urlBad}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  confirmUrl()
                } else if (event.key === "Escape") {
                  event.stopPropagation()
                  setTyping(false)
                }
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="用这个网址" disabled={!url.trim() || urlBad} onClick={confirmUrl}>
                <CheckIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <span className="text-xs text-muted-foreground">{urlBad ? "要以 http:// 或 https:// 开头" : "图片的网址，服务器去下载。"}</span>
          <Button type="button" variant="ghost" size="xs" className="self-start" onClick={() => setTyping(false)}>
            返回
          </Button>
        </div>
      ) : (
        <div
          data-dragging={dragging}
          onDragOver={(event) => {
            if (![...event.dataTransfer.items].some((item) => item.kind === "file")) return
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            const file = [...event.dataTransfer.files].find(isImageFile)
            if (file) onFile(file)
          }}
          className="flex flex-col items-center gap-2 border border-dashed p-4 text-center text-xs text-muted-foreground data-[dragging=true]:bg-muted"
        >
          <ImageIcon />
          拖进来、Ctrl+V 粘贴，或者
          <div className="flex flex-wrap justify-center gap-1">
            <Button id={inputId} type="button" variant="outline" size="xs" onClick={() => pickRef.current?.click()}>
              <UploadIcon data-icon="inline-start" />
              上传
            </Button>
            <Button type="button" variant="outline" size="xs" onClick={onGallery}>
              <ImagesIcon data-icon="inline-start" />
              从图库选
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                setUrl("")
                setTyping(true)
              }}
            >
              <LinkIcon data-icon="inline-start" />
              填网址
            </Button>
          </div>
        </div>
      )}
    </Field>
  )
}

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

/** 从图库选一张：图片墙 + 关键词搜（在每张图的文本里找），最多显示最近的 60 张 */
function GalleryPickDialog({ onPick, onClose }: { onPick: (image: { id: string; thumbUrl: string; name: string }) => void; onClose: () => void }) {
  const [box, setBox] = React.useState("")
  const keyword = useDebounced(box.trim(), 300)
  const list = useQuery(trpc.gallery.list.queryOptions({ ...(keyword ? { keyword } : {}), limit: 60 }))
  const images = list.data?.items ?? []
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>从图库选</DialogTitle>
          <DialogDescription>点一张图就选上。按关键词在图的文本里找；更多筛选去「图库」页。</DialogDescription>
        </DialogHeader>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput aria-label="搜图库" placeholder="关键词" value={box} onChange={(event) => setBox(event.target.value)} />
          {list.isFetching && (
            <InputGroupAddon align="inline-end">
              <Spinner />
            </InputGroupAddon>
          )}
        </InputGroup>
        {list.isPending ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="aspect-square w-full" />
            ))}
          </div>
        ) : list.isError ? (
          <p className="text-sm text-destructive">图库没取到，关掉再试一次。</p>
        ) : images.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ImagesIcon />
              </EmptyMedia>
              <EmptyDescription>{keyword ? `没有文本里带「${keyword}」的图。` : "图库还是空的。可以直接上传，或者先去「图库」传图。"}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {images.map((image) => {
              const label = [image.name, image.tags.join("、")].filter(Boolean).join(" · ") || image.id
              return (
                <button
                  key={image.id}
                  type="button"
                  title={label}
                  aria-label={label}
                  onClick={() => onPick(image)}
                  className="block w-full overflow-hidden border bg-muted outline-none hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <AspectRatio ratio={1}>
                    <img src={image.thumbUrl} alt={image.name} loading="lazy" className="size-full object-cover" />
                  </AspectRatio>
                </button>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
