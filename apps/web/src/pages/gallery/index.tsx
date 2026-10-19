// 图库：打开就是满屏的图片墙（按上传时间倒序，往下滚自动加载）。
// 顶部一行：以图搜图（选一张本地图，或者 Ctrl+V 粘贴）、标签筛选、关键词 / JSON 包含匹配；右上角上传（也可以把图片拖进页面）。
// 以图搜图、找相似时多两个框：最多几张、相似度下限（默认 50 张、90%）。
// 点一张图在右边抽屉里看大图、文本和标签，能找相似、编辑、删除。
// 「选择」进入多选：点图勾上（只能勾自己能删的），一起删。
import * as React from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { ImagesIcon, ImageUpIcon, ListChecksIcon, RotateCwIcon, ScanSearchIcon, SearchIcon, SearchXIcon, Trash2Icon, TriangleAlertIcon, UploadIcon, XIcon } from "lucide-react"
import { can, type GalleryImage } from "@heyagent/shared"

import { EmptyState, HelpTip, PageFrame, SimpleHeader } from "@/components/shell/simple-page"
import { TagsCombobox } from "@/components/shell/tags-combobox"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AspectRatio } from "@/components/ui/aspect-ratio"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ButtonGroup } from "@/components/ui/button-group"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { parseSearchBox, searchGalleryByImage } from "@/lib/gallery"
import { errorMessage, useAction } from "@/lib/mutations"
import { href, setParams, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { ImageSheetBody } from "./image-sheet"
import { UploadDialog } from "./upload-dialog"

/** 一页多少张（往下滚到底再拉下一页） */
const PAGE_SIZE = 60
/** 以图搜图（传一张图、找相似）默认只看最像的前 50 张、相似度不低于 90% 的；页面上能改 */
const IMAGE_SEARCH_LIMIT = 50
const IMAGE_SEARCH_MIN_PERCENT = 90

const percent = (score: number) => `${Math.round(score * 100)}%`
/** 框里的数字：取整、限在 min～max；空着或不是数字用默认值 */
function toInt(text: string, min: number, max: number, fallback: number) {
  const number = Number(text)
  if (!text.trim() || !Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}
const isImageFile = (file: File) => file.type.startsWith("image/")

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

export default function GalleryPage() {
  const { params } = useRoute()
  const selectedId = params.get("id")
  const similarTo = params.get("similar")
  const [tags, setTags] = React.useState<string[]>([])
  const [box, setBox] = React.useState("")
  const search = parseSearchBox(useDebounced(box, 300))
  /** 以图搜图用的本地图片 */
  const [probe, setProbe] = React.useState<{ file: File; url: string } | null>(null)
  /** 上传弹窗：null = 关着；数组 = 开着（拖进来的图先放进去） */
  const [uploadFiles, setUploadFiles] = React.useState<File[] | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const pickRef = React.useRef<HTMLInputElement>(null)
  const { user } = useMe()
  /** 多选：null = 没在选；Set = 选中的 id */
  const [picked, setPicked] = React.useState<Set<string> | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  /** 以图搜图：最多几张、相似度下限（%） */
  const [limitBox, setLimitBox] = React.useState(String(IMAGE_SEARCH_LIMIT))
  const [minBox, setMinBox] = React.useState(String(IMAGE_SEARCH_MIN_PERCENT))
  const searchLimit = toInt(useDebounced(limitBox, 400), 1, 200, IMAGE_SEARCH_LIMIT)
  const minPercent = toInt(useDebounced(minBox, 400), 0, 100, IMAGE_SEARCH_MIN_PERCENT)
  const minScore = minPercent / 100
  const imageSearch = Boolean(probe || similarTo)

  const statsQuery = useQuery({ ...trpc.gallery.stats.queryOptions(), refetchInterval: (query) => (query.state.data?.pending ? 5000 : false) })
  const tagsQuery = useQuery(trpc.gallery.tags.queryOptions())
  const stats = statsQuery.data
  const canSearchByImage = Boolean(stats?.embedModel)
  const filter = { ...(tags.length ? { tags } : {}), ...search.filter }
  const filtered = Object.keys(filter).length > 0 || Boolean(similarTo) || Boolean(probe)

  const list = useInfiniteQuery({
    ...trpc.gallery.list.infiniteQueryOptions({ ...filter, ...(similarTo ? { similarTo, minScore, limit: searchLimit } : { limit: PAGE_SIZE }) }, { getNextPageParam: (last) => last.nextCursor }),
    enabled: !probe,
  })
  const probeQuery = useQuery({
    queryKey: ["gallery", "probe", probe?.url, filter, searchLimit, minScore],
    queryFn: () => searchGalleryByImage(probe!.file, { ...filter, limit: searchLimit, minScore }),
    enabled: Boolean(probe),
    retry: false,
  })
  const active = probe ? probeQuery : list
  const images: GalleryImage[] = probe ? (probeQuery.data?.items ?? []) : (list.data?.pages.flatMap((page) => page.items) ?? [])
  const canDelete = (image: GalleryImage) => can(user, "gallery.manage", { createdById: image.createdById ?? "" })
  const deletable = images.filter(canDelete)
  const removeMany = useAction(
    trpc.gallery.deleteMany.mutationOptions({
      onSuccess: ({ ids }) => {
        setConfirmDelete(false)
        setPicked(null)
        if (selectedId && ids.includes(selectedId)) setParams({ id: null })
      },
    }),
    { success: ({ ids }) => `已删除 ${ids.length} 张` }
  )
  const togglePick = (id: string) =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // 多选时按 Esc 退出（确认框开着时让它自己处理）
  React.useEffect(() => {
    if (!picked || confirmDelete) return
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setPicked(null)
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [picked, confirmDelete])

  const startProbe = (file: File) => {
    setParams({ similar: null })
    setProbe({ file, url: URL.createObjectURL(file) })
  }
  const clearProbe = () => setProbe(null)
  // 换了图或者不搜了：释放上一张的预览地址
  React.useEffect(() => {
    if (!probe) return
    const { url } = probe
    return () => URL.revokeObjectURL(url)
  }, [probe])

  // Ctrl+V 粘贴一张图：以图搜图（弹窗开着的时候不管）
  React.useEffect(() => {
    if (!canSearchByImage || uploadFiles) return
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find(isImageFile)
      if (!file) return
      event.preventDefault()
      setParams({ similar: null })
      setProbe({ file, url: URL.createObjectURL(file) })
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [canSearchByImage, uploadFiles])

  const uploadButton = (
    <Button onClick={() => setUploadFiles([])}>
      <UploadIcon data-icon="inline-start" />
      上传
    </Button>
  )
  const allPicked = deletable.length > 0 && deletable.every((image) => picked?.has(image.id))
  const headerAction = picked ? (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">已选 {picked.size} 张</span>
      <Button variant="outline" disabled={deletable.length === 0} onClick={() => setPicked(allPicked ? new Set() : new Set(deletable.map((image) => image.id)))}>
        {allPicked ? "全不选" : "全选"}
      </Button>
      <Button variant="destructive" disabled={picked.size === 0} onClick={() => setConfirmDelete(true)}>
        <Trash2Icon data-icon="inline-start" />
        删除
      </Button>
      <Button variant="ghost" onClick={() => setPicked(null)}>
        取消
      </Button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center gap-2">
      {images.length > 0 && (
        <Button variant="outline" onClick={() => setPicked(new Set())}>
          <ListChecksIcon data-icon="inline-start" />
          选择
        </Button>
      )}
      {uploadButton}
    </div>
  )

  return (
    <div
      className="flex flex-1 flex-col"
      onDragOver={(event) => {
        if (uploadFiles || ![...event.dataTransfer.items].some((item) => item.kind === "file")) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false)
      }}
      onDrop={(event) => {
        if (uploadFiles) return
        event.preventDefault()
        setDragging(false)
        const files = [...event.dataTransfer.files].filter(isImageFile)
        if (files.length) setUploadFiles(files)
      }}
    >
      <PageFrame
        queries={[statsQuery]}
        skeleton="grid"
        isEmpty={stats?.total === 0}
        header={<SimpleHeader title="图库" description="每张图带一段文本（JSON）和标签，可以以图搜图、按标签和字段找；agent 和外部系统也能用。" action={headerAction} />}
        empty={<EmptyState icon={<ImagesIcon />} title="图库还是空的" description="点「上传」选图片，或者直接把图片拖进这个页面。每张图可以带标签和一段 JSON 说明。" action={uploadButton} />}
      >
        <div className="flex flex-col gap-4">
          {stats && !stats.embedModel && (
            <Alert>
              <TriangleAlertIcon />
              <AlertTitle>还没设 embedding 模型</AlertTitle>
              <AlertDescription>以图搜图、比对要用它。传图、按标签和字段找不受影响。</AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm" nativeButton={false} render={<a href={href("models", { id: "defaults" })} />}>
                  去设置
                </Button>
              </AlertAction>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={pickRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) startProbe(file)
                event.target.value = ""
              }}
            />
            {imageSearch ? (
              <ButtonGroup>
                {probe ? (
                  <Tooltip>
                    <TooltipTrigger render={<Button variant="outline" onClick={() => pickRef.current?.click()} />}>
                      <img src={probe.url} alt="" data-icon="inline-start" className="size-4 object-cover" />
                      以图搜图
                    </TooltipTrigger>
                    <TooltipContent>换一张图，也可以直接 Ctrl+V 粘贴</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger render={<Button variant="outline" onClick={() => setParams({ id: similarTo })} />}>
                      <ScanSearchIcon data-icon="inline-start" />和 {similarTo} 相似
                    </TooltipTrigger>
                    <TooltipContent>看这张图</TooltipContent>
                  </Tooltip>
                )}
                <Button variant="outline" size="icon" aria-label={probe ? "不按图搜了" : "不找相似了"} onClick={() => (probe ? clearProbe() : setParams({ similar: null }))}>
                  <XIcon />
                </Button>
              </ButtonGroup>
            ) : (
              <Tooltip>
                <TooltipTrigger render={<span />}>
                  <Button variant="outline" disabled={!canSearchByImage} onClick={() => pickRef.current?.click()}>
                    <ImageUpIcon data-icon="inline-start" />
                    以图搜图
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{canSearchByImage ? "选一张图，或者直接 Ctrl+V 粘贴" : "还没设 embedding 模型"}</TooltipContent>
              </Tooltip>
            )}
            {imageSearch && (
              <>
                <InputGroup className="w-32">
                  <InputGroupAddon>最多</InputGroupAddon>
                  <InputGroupInput
                    type="number"
                    min={1}
                    max={200}
                    aria-label="最多几张"
                    value={limitBox}
                    onChange={(event) => setLimitBox(event.target.value)}
                    onBlur={() => setLimitBox(String(toInt(limitBox, 1, 200, IMAGE_SEARCH_LIMIT)))}
                  />
                  <InputGroupAddon align="inline-end">张</InputGroupAddon>
                </InputGroup>
                <InputGroup className="w-40">
                  <InputGroupAddon>相似度 ≥</InputGroupAddon>
                  <InputGroupInput
                    type="number"
                    min={0}
                    max={100}
                    aria-label="相似度不低于（%）"
                    value={minBox}
                    onChange={(event) => setMinBox(event.target.value)}
                    onBlur={() => setMinBox(String(toInt(minBox, 0, 100, IMAGE_SEARCH_MIN_PERCENT)))}
                  />
                  <InputGroupAddon align="inline-end">
                    %
                    <HelpTip>只显示相似度不低于这个值的图，按相似度从高到低最多显示前面那么多张。用 gemini-embedding-2 时，同一张图改大小、裁边一般在 95% 以上，同类的不同图 80% 左右。</HelpTip>
                  </InputGroupAddon>
                </InputGroup>
              </>
            )}
            <TagsCombobox className="w-full sm:w-64" value={tags} onValueChange={setTags} options={tagsQuery.data ?? []} placeholder="按标签筛（都要有）" />
            <InputGroup className="min-w-48 flex-1">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput aria-label="关键词或 JSON" aria-invalid={Boolean(search.error)} placeholder='关键词，或 JSON：{"颜色": "红"}' value={box} onChange={(event) => setBox(event.target.value)} />
              <InputGroupAddon align="inline-end">
                <HelpTip>写普通文字：在每张图文本的所有值里找。写 JSON 对象：找文本里包含这一段的图（值要完全相等）。更复杂的条件（大于、小于、包含）用 HTTP 接口或 MCP。</HelpTip>
              </InputGroupAddon>
            </InputGroup>
          </div>
          {search.error && <p className="text-sm text-destructive">{search.error}</p>}
          <StatusLine total={stats?.total} pending={stats?.pending ?? 0} lastError={stats?.lastError} shown={active.isPending ? undefined : images.length} filtered={filtered} cap={imageSearch ? searchLimit : undefined} />

          {active.isPending ? (
            <WallSkeleton />
          ) : active.isError ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>没搜成</AlertTitle>
              <AlertDescription>{errorMessage(active.error)}</AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm" onClick={() => void active.refetch()}>
                  <RotateCwIcon data-icon="inline-start" />
                  重试
                </Button>
              </AlertAction>
            </Alert>
          ) : images.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchXIcon />
                </EmptyMedia>
                <EmptyTitle>{imageSearch ? `没有相似度 ≥ ${minPercent}% 的图` : "没有符合条件的图"}</EmptyTitle>
                <EmptyDescription>{imageSearch ? "把上面的相似度调低一些试试（同类的不同图一般 80% 左右），或者换个标签、关键词。" : "换个标签或关键词试试。"}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  variant="outline"
                  onClick={() => {
                    setTags([])
                    setBox("")
                    clearProbe()
                    setParams({ similar: null })
                  }}
                >
                  清除条件
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8">
                {images.map((image) => (
                  <Tile
                    key={image.id}
                    image={image}
                    selected={picked ? picked.has(image.id) : image.id === selectedId}
                    picking={Boolean(picked)}
                    disabled={Boolean(picked) && !canDelete(image)}
                    onClick={() => (picked ? togglePick(image.id) : setParams({ id: image.id }))}
                  />
                ))}
              </div>
              {!probe && list.hasNextPage && <LoadMore loading={list.isFetchingNextPage} onVisible={() => void list.fetchNextPage()} />}
            </>
          )}
        </div>
      </PageFrame>

      <Sheet open={Boolean(selectedId)} onOpenChange={(open) => !open && setParams({ id: null })}>
        <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
          {selectedId && (
            <ImageSheetBody
              key={selectedId}
              id={selectedId}
              canSearchByImage={canSearchByImage}
              onSimilar={() => {
                clearProbe()
                setParams({ id: null, similar: selectedId })
              }}
            />
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除选中的 {picked?.size ?? 0} 张图？</AlertDialogTitle>
            <AlertDialogDescription>图片文件、文本、标签和向量一起删除，不能撤销。用到这些图 id 的地方会找不到它们。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={removeMany.isPending || !picked?.size} onClick={() => picked && removeMany.mutate({ ids: [...picked] })}>
              {removeMany.isPending && <Spinner data-icon="inline-start" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {uploadFiles && <UploadDialog initialFiles={uploadFiles} tagOptions={tagsQuery.data ?? []} onClose={() => setUploadFiles(null)} />}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80">
          <div className="flex flex-col items-center gap-2 border border-dashed p-10 text-muted-foreground">
            <UploadIcon />
            松开就打开上传
          </div>
        </div>
      )}
    </div>
  )
}

function Tile({ image, selected, picking, disabled, onClick }: { image: GalleryImage; selected: boolean; picking: boolean; disabled: boolean; onClick: () => void }) {
  const label = [image.name, image.tags.join("、")].filter(Boolean).join(" · ")
  return (
    <button
      type="button"
      title={disabled ? "只有上传的人和主管能删这张图" : label}
      aria-label={label || image.id}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className="relative block w-full overflow-hidden border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-pressed:ring-2 aria-pressed:ring-primary"
    >
      <AspectRatio ratio={1}>
        <img src={image.thumbUrl} alt={image.name} loading="lazy" className="size-full object-cover" />
      </AspectRatio>
      {image.score !== undefined && (
        <Badge variant="secondary" className="absolute top-1 left-1">
          {percent(image.score)}
        </Badge>
      )}
      {picking && !disabled && <Checkbox checked={selected} tabIndex={-1} aria-hidden className="pointer-events-none absolute top-1 right-1" />}
    </button>
  )
}

/** 列表上面一行小字：共几张（shown 没有 = 还在找）、以图搜图到了张数上限、正在重算向量、最近一次失败的原因 */
function StatusLine({ total, pending, lastError, shown, filtered, cap }: { total?: number; pending: number; lastError?: string; shown?: number; filtered: boolean; cap?: number }) {
  if (total === undefined) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>{!filtered ? `共 ${total} 张` : shown === undefined ? "正在找…" : `找到 ${shown} 张`}</span>
      {cap !== undefined && shown !== undefined && shown >= cap && <span>只显示最像的前 {cap} 张</span>}
      {pending > 0 && (
        <span className="inline-flex items-center gap-1">
          <Spinner />
          还有 {pending} 张没算向量（换了模型或刚传上来），算完之前以图搜图可能找不到它们
        </span>
      )}
      {pending > 0 && lastError && <span className="text-destructive">最近一次失败：{lastError}</span>}
    </div>
  )
}

/** 滚到底自动拉下一页 */
function LoadMore({ loading, onVisible }: { loading: boolean; onVisible: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const callback = React.useRef(onVisible)
  React.useEffect(() => {
    callback.current = onVisible
  }, [onVisible])
  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver((entries) => entries[0]?.isIntersecting && callback.current(), { rootMargin: "800px" })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={ref} className="flex justify-center py-4">
      {loading && <Spinner />}
    </div>
  )
}

function WallSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8">
      {Array.from({ length: 24 }, (_, index) => (
        <Skeleton key={index} className="aspect-square w-full" />
      ))}
    </div>
  )
}
