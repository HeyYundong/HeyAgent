// 图库：打开就是满屏的图片墙（按上传时间倒序，往下滚自动加载）。
// 顶部一行：以图搜图（选一张本地图，或者 Ctrl+V 粘贴）、标签筛选、关键词 / JSON 包含匹配；右上角上传（也可以把图片拖进页面）。
// 点一张图在右边抽屉里看大图、文本和标签，能找相似、编辑、删除。
import * as React from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { ImagesIcon, ImageUpIcon, RotateCwIcon, ScanSearchIcon, SearchIcon, SearchXIcon, TriangleAlertIcon, UploadIcon, XIcon } from "lucide-react"
import type { GalleryImage } from "@heyagent/shared"

import { EmptyState, HelpTip, PageFrame, SimpleHeader } from "@/components/shell/simple-page"
import { TagsCombobox } from "@/components/shell/tags-combobox"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AspectRatio } from "@/components/ui/aspect-ratio"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { parseSearchBox, searchGalleryByImage } from "@/lib/gallery"
import { errorMessage } from "@/lib/mutations"
import { href, setParams, useRoute } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { ImageSheetBody } from "./image-sheet"
import { UploadDialog } from "./upload-dialog"

/** 一页多少张（往下滚到底再拉下一页） */
const PAGE_SIZE = 60
/** 以图搜图最多看前多少张 */
const PROBE_LIMIT = 100

const percent = (score: number) => `${Math.round(score * 100)}%`
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

  const statsQuery = useQuery({ ...trpc.gallery.stats.queryOptions(), refetchInterval: (query) => (query.state.data?.pending ? 5000 : false) })
  const tagsQuery = useQuery(trpc.gallery.tags.queryOptions())
  const stats = statsQuery.data
  const canSearchByImage = Boolean(stats?.embedModel)
  const filter = { ...(tags.length ? { tags } : {}), ...search.filter }
  const filtered = Object.keys(filter).length > 0 || Boolean(similarTo) || Boolean(probe)

  const list = useInfiniteQuery({
    ...trpc.gallery.list.infiniteQueryOptions({ ...filter, similarTo: similarTo ?? undefined, limit: PAGE_SIZE }, { getNextPageParam: (last) => last.nextCursor }),
    enabled: !probe,
  })
  const probeQuery = useQuery({
    queryKey: ["gallery", "probe", probe?.url, filter],
    queryFn: () => searchGalleryByImage(probe!.file, { ...filter, limit: PROBE_LIMIT }),
    enabled: Boolean(probe),
    retry: false,
  })
  const active = probe ? probeQuery : list
  const images: GalleryImage[] = probe ? (probeQuery.data?.items ?? []) : (list.data?.pages.flatMap((page) => page.items) ?? [])

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
        header={<SimpleHeader title="图库" description="每张图带一段文本（JSON）和标签，可以以图搜图、按标签和字段找；agent 和外部系统也能用。" action={uploadButton} />}
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
            {probe ? (
              <Badge variant="secondary">
                <img src={probe.url} alt="" className="size-4 object-cover" />
                以图搜图
                <Button variant="ghost" size="icon-xs" aria-label="不按图搜了" onClick={clearProbe}>
                  <XIcon />
                </Button>
              </Badge>
            ) : similarTo ? (
              <Badge variant="secondary">
                <ScanSearchIcon data-icon="inline-start" />
                和 {similarTo} 相似
                <Button variant="ghost" size="icon-xs" aria-label="不找相似了" onClick={() => setParams({ similar: null })}>
                  <XIcon />
                </Button>
              </Badge>
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
          <StatusLine total={stats?.total} pending={stats?.pending ?? 0} lastError={stats?.lastError} shown={images.length} filtered={filtered} />

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
                <EmptyTitle>没有符合条件的图</EmptyTitle>
                <EmptyDescription>换个标签或关键词试试。</EmptyDescription>
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
                  <Tile key={image.id} image={image} selected={image.id === selectedId} />
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

function Tile({ image, selected }: { image: GalleryImage; selected: boolean }) {
  const label = [image.name, image.tags.join("、")].filter(Boolean).join(" · ")
  return (
    <button
      type="button"
      title={label}
      aria-label={label || image.id}
      aria-pressed={selected}
      onClick={() => setParams({ id: image.id })}
      className="relative block w-full overflow-hidden border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-primary"
    >
      <AspectRatio ratio={1}>
        <img src={image.thumbUrl} alt={image.name} loading="lazy" className="size-full object-cover" />
      </AspectRatio>
      {image.score !== undefined && (
        <Badge variant="secondary" className="absolute top-1 left-1">
          {percent(image.score)}
        </Badge>
      )}
    </button>
  )
}

/** 列表下面一行小字：共几张、正在重算向量、最近一次失败的原因 */
function StatusLine({ total, pending, lastError, shown, filtered }: { total?: number; pending: number; lastError?: string; shown: number; filtered: boolean }) {
  if (total === undefined) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>{filtered ? `找到 ${shown} 张` : `共 ${total} 张`}</span>
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
