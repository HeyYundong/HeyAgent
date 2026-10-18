// 比图页（docs/dev/compare.md）：两张图交给视觉模型，按比对标准逐项打分、写差异，判断是不是同款；每次比对都存档。
// 页面上人能比；agent 在运行里用「比图」工具组；外部系统用 HTTP 接口或 MCP（API 密钥）。都记在这里。
// 左边比对记录（新的在前，能搜标题、编号，往下翻页），右边一次比对的结果。比对中的那条比完由实时推送刷新。
import * as React from "react"
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query"
import {
  BotIcon, ChevronLeftIcon, ChevronRightIcon, CircleCheckIcon, CircleSlashIcon, CopyIcon, EllipsisIcon, KeyRoundIcon, PlusIcon, RotateCwIcon, ScanEyeIcon, SearchIcon, Trash2Icon, TriangleAlertIcon, UserIcon,
} from "lucide-react"
import { can, compareConfidenceLabel, fmtShort, type Comparison } from "@heyagent/shared"
import { TRPCClientError } from "@trpc/client"

import { DetailPanel, DetailSection, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AspectRatio } from "@/components/ui/aspect-ratio"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"

import { useModels, useTasksQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href, navigate, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { NewCompareDialog } from "./new-dialog"
import { money, ScoreBadge, useSourceText } from "./parts"

/** 左边一页多少条（「再看更早的」再拉下一页） */
const PAGE_SIZE = 50

const LINK = "underline underline-offset-4 hover:text-foreground"

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

export default function ComparePage() {
  const { params } = useRoute()
  const selectedId = params.get("id")
  const [creating, setCreating] = React.useState(false)
  const [box, setBox] = React.useState("")
  const query = useDebounced(box.trim(), 300)
  const sourceText = useSourceText()

  // 换搜索词时先留着上一次的列表（placeholderData），不回到整页骨架屏
  const listQuery = useInfiniteQuery({
    ...trpc.compare.list.infiniteQueryOptions({ query: query || undefined, limit: PAGE_SIZE }, { getNextPageParam: (last) => last.nextCursor }),
    placeholderData: keepPreviousData,
  })
  const records = listQuery.data?.pages.flatMap((page) => page.items) ?? []
  const selected = records.find((record) => record.id === selectedId)

  const newButton = (
    <Button onClick={() => setCreating(true)}>
      <PlusIcon data-icon="inline-start" />
      新比对
    </Button>
  )
  const header = (
    <SimpleHeader title="比图" description="两张图交给视觉模型，按比对标准逐项打分、写出差异，判断是不是同款；每次比对都存档。agent 和外部系统也能用。" action={newButton} />
  )

  return (
    <>
      {/* 弹窗放在 PageFrame 外面：列表为空时 PageFrame 只显示空状态、不渲染 children，放在里面的话空状态上的按钮打不开弹窗 */}
      <PageFrame
        header={header}
        queries={[listQuery]}
        isEmpty={!query && records.length === 0}
        empty={<EmptyState icon={<ScanEyeIcon />} title="还没有比对过" description="点「新比对」放两张图试试；agent 在任务里选上「比图」工具也能自己比。" action={newButton} />}
      >
        <MasterDetail
          hasSelection={Boolean(selectedId)}
          emptyHint="从左边选一次比对看结果"
          list={
            <>
              <InputGroup>
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput aria-label="搜比对" placeholder="搜标题、编号" value={box} onChange={(event) => setBox(event.target.value)} />
                {listQuery.isFetching && query && (
                  <InputGroupAddon align="inline-end">
                    <Spinner />
                  </InputGroupAddon>
                )}
              </InputGroup>
              {records.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">没有搜到「{query}」，换个词试试。</p>
              ) : (
                <PickGroup>
                  {records.map((record) => (
                    <PickItem
                      key={record.id}
                      to={href("compare", { id: record.id })}
                      selected={record.id === selectedId}
                      title={record.title}
                      description={`${fmtShort(record.createdAt)} · ${sourceText(record)}`}
                      badge={<ScoreBadge record={record} />}
                    />
                  ))}
                </PickGroup>
              )}
              {listQuery.hasNextPage && (
                <Button variant="ghost" size="sm" className="self-center" disabled={listQuery.isFetchingNextPage} onClick={() => void listQuery.fetchNextPage()}>
                  {listQuery.isFetchingNextPage && <Spinner data-icon="inline-start" />}
                  再看更早的
                </Button>
              )}
            </>
          }
          detail={selectedId ? <CompareDetail key={selectedId} id={selectedId} record={selected} /> : null}
        />
      </PageFrame>
      <NewCompareDialog
        key={creating ? "open" : "closed"}
        open={creating}
        onOpenChange={setCreating}
        onStarted={(record) => {
          setCreating(false)
          setBox("")
          navigate("compare", { id: record.id })
        }}
      />
    </>
  )
}

const isNotFound = (error: unknown) => error instanceof TRPCClientError && error.data?.code === "NOT_FOUND"

/** 详情：先用列表里的那条马上显示，同时取最新的（直接打开链接、列表还没翻到它时也能看） */
function CompareDetail({ id, record }: { id: string; record?: Comparison }) {
  const detailQuery = useQuery(trpc.compare.get.queryOptions({ id }))
  const shown = detailQuery.data ?? record
  if (detailQuery.isError && !shown)
    return (
      <Alert variant={isNotFound(detailQuery.error) ? "default" : "destructive"}>
        <TriangleAlertIcon />
        <AlertTitle>{isNotFound(detailQuery.error) ? "这次比对不在了" : "加载失败"}</AlertTitle>
        <AlertDescription>{isNotFound(detailQuery.error) ? "可能已经被删掉了。从左边选别的比对。" : "网络不稳定，没拿到这次比对。"}</AlertDescription>
      </Alert>
    )
  if (!shown)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  return <Detail record={shown} />
}

function Detail({ record }: { record: Comparison }) {
  const { user } = useMe()
  const { modelName } = useModels()
  const sourceText = useSourceText()
  const tasks = useTasksQuery().data
  const [zoom, setZoom] = React.useState<0 | 1 | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const [promptOpen, setPromptOpen] = React.useState(false)
  const again = useAction(trpc.compare.again.mutationOptions(), { success: "开始再比一次了", errorTitle: "没开始比" })
  const remove = useAction(trpc.compare.delete.mutationOptions(), { success: "比对记录删掉了", errorTitle: "没删成" })
  const canDelete = record.createdById !== null && can(user, "compare.manage", { createdById: record.createdById })
  const images = [record.imageA, record.imageB]
  const model = modelName(record.modelId)
  const SourceIcon = record.via === "agent" ? BotIcon : record.via === "web" ? UserIcon : KeyRoundIcon
  const taskTitle = tasks?.find((task) => task.id === record.taskId)?.title
  /** 两行放得下的要求不用「展开全文」 */
  const longPrompt = record.prompt.split("\n").length > 2 || record.prompt.length > 120

  const copyVerdict = async () => {
    const lines = [
      `${record.title}（${record.id}）`,
      record.score === null ? "总分：—" : `总分：${record.score} / 100${record.passed ? "，达标" : "，没达标"}（合格线 ${record.passScore}）`,
      record.verdict,
      ...record.reasons.map((reason) => `- ${reason}`),
    ].filter(Boolean)
    try {
      await navigator.clipboard.writeText(lines.join("\n"))
      toast.add({ title: "结论已复制", type: "success" })
    } catch {
      toast.add({ title: "没复制成", description: "浏览器不让读写剪贴板，手动选中文字复制吧。", type: "error" })
    }
  }

  return (
    <DetailPanel
      title={record.title}
      badges={
        <>
          <ScoreBadge record={record} />
          {record.status === "done" && record.passed !== null && (record.passed ? <Badge>达标</Badge> : <Badge variant="ghost">没达标</Badge>)}
        </>
      }
      meta={
        <span className="inline-flex flex-wrap items-center gap-1">
          {record.id} · {record.standardName ? `标准「${record.standardName}」` : "自己写的要求"}（合格线 {record.passScore}）· {model} · 花费 {money(record.costUsd)} · {fmtShort(record.createdAt)} ·
          <SourceIcon className="size-3" />
          {record.via === "agent" && record.sessionId ? (
            <a className={LINK} href={record.taskId ? href("tasks", { id: record.taskId, run: record.sessionId }) : href("sessions", { id: record.sessionId })}>
              {taskTitle ? `${taskTitle} · ${record.sessionId}` : `运行 ${record.sessionId}`}
            </a>
          ) : (
            sourceText(record)
          )}
        </span>
      }
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={again.isPending}
            onClick={async () => {
              const created = await again.submit({ id: record.id })
              if (created) navigate("compare", { id: created.id })
            }}
          >
            {again.isPending ? <Spinner data-icon="inline-start" /> : <RotateCwIcon data-icon="inline-start" />}
            再比一次
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="这次比对的更多操作" />}>
              {remove.isPending ? <Spinner /> : <EllipsisIcon />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem disabled={record.status !== "done"} onClick={() => void copyVerdict()}>
                <CopyIcon />
                复制结论
              </DropdownMenuItem>
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
                    <Trash2Icon />
                    删除记录
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <DetailSection title="两张图" description="第一张是参照，第二张是要判断的。点图看大图。">
        <div className="grid grid-cols-2 gap-4">
          {images.map((image, index) => {
            // 网址来的图标签常常就是网址本身：来源里已经有了就不重复
            const label = image.label && !image.from.includes(image.label) ? image.label : ""
            const caption = [index === 0 ? "第一张" : "第二张", label, image.from].filter(Boolean).join(" · ")
            return (
              <button
                key={index}
                type="button"
                title={caption}
                className="flex min-w-0 flex-col gap-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setZoom(index as 0 | 1)}
              >
                <div className="w-full border bg-muted">
                  <AspectRatio ratio={1}>
                    <img src={image.url} alt={image.label || caption} className="size-full object-cover" />
                  </AspectRatio>
                </div>
                <span className="w-full truncate text-xs text-muted-foreground">{caption}</span>
              </button>
            )
          })}
        </div>
      </DetailSection>

      {record.status === "running" && (
        <DetailSection title="结论">
          <Trace>
            <div>
              <TraceLine>
                <TraceIcon>
                  <CircleCheckIcon />
                </TraceIcon>
                <TraceTitle>两张图已经准备好（统一缩到长边 1024）</TraceTitle>
              </TraceLine>
            </div>
            <div>
              <TraceLine status="running">
                <TraceIcon>
                  <Spinner />
                </TraceIcon>
                <TraceTitle>{model} 正在逐项比对</TraceTitle>
              </TraceLine>
            </div>
          </Trace>
        </DetailSection>
      )}

      {record.status === "failed" && (
        <Alert variant="destructive">
          <CircleSlashIcon />
          <AlertTitle>没比成</AlertTitle>
          <AlertDescription>{record.error ?? "没有记下原因。可以「再比一次」。"}</AlertDescription>
        </Alert>
      )}

      {record.status === "done" && (
        <>
          <DetailSection title="结论" description="总分 0～100；把握度是模型对这次判断有多确定。看不清、证据不够时不给分。">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-4">
                <span className="font-heading text-4xl font-semibold tabular-nums">{record.score ?? "—"}</span>
                <span className="pb-1 text-muted-foreground">
                  / 100 · 把握度{record.confidence ? compareConfidenceLabel[record.confidence] : "—"} · 合格线 {record.passScore}
                </span>
              </div>
              {record.verdict && <p>{record.verdict}</p>}
              {record.reasons.length > 0 && (
                <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
                  {record.reasons.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              )}
            </div>
          </DetailSection>
          {(record.dimensions.length > 0 || record.differences.length > 0) && (
            <DetailSection title="各项分和差异">
              <div className="flex flex-col gap-4">
                {record.dimensions.length > 0 && (
                  <div className="flex flex-col gap-3">
                    {record.dimensions.map((dimension, index) => (
                      <div key={index} className="flex items-center gap-3">
                        <span className="w-24 shrink-0">{dimension.name}</span>
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <Progress value={dimension.score} aria-label={`${dimension.name} ${dimension.score} 分`} />
                          {dimension.note && <span className="text-xs text-muted-foreground">{dimension.note}</span>}
                        </div>
                        <span className="w-10 shrink-0 text-right tabular-nums">{dimension.score}</span>
                      </div>
                    ))}
                  </div>
                )}
                {record.differences.length > 0 && (
                  <ItemGroup className="gap-1">
                    {record.differences.map((difference, index) => (
                      <Item key={index} size="xs" variant="muted">
                        <ItemMedia variant="icon">
                          <CircleSlashIcon />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle className="line-clamp-none">{difference}</ItemTitle>
                        </ItemContent>
                      </Item>
                    ))}
                  </ItemGroup>
                )}
              </div>
            </DetailSection>
          )}
        </>
      )}

      <DetailSection title="比对要求" description="这次比对实际用的打分要求（标准以后改了，这里还是当时的）。">
        {longPrompt ? (
          <Collapsible open={promptOpen} onOpenChange={setPromptOpen}>
            {!promptOpen && <p className="line-clamp-2 whitespace-pre-line text-muted-foreground">{record.prompt}</p>}
            <CollapsibleContent>
              <p className="whitespace-pre-line">{record.prompt}</p>
            </CollapsibleContent>
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="mt-1" />}>{promptOpen ? "收起" : "展开全文"}</CollapsibleTrigger>
          </Collapsible>
        ) : (
          <p className="whitespace-pre-line text-muted-foreground">{record.prompt}</p>
        )}
      </DetailSection>

      {zoom !== null && <ZoomDialog images={images} index={zoom} onIndex={setZoom} onClose={() => setZoom(null)} />}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除比对「{record.title}」？</AlertDialogTitle>
            <AlertDialogDescription>
              删掉这条记录和它的结论。两张图没有别的地方（图库、其他比对、附件）用到的话也一起删掉。删掉后不能恢复；agent 或接口以后再查 {record.id} 会查不到。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                setConfirming(false)
                if (await remove.submit({ id: record.id })) navigate("compare")
              }}
            >
              <Trash2Icon data-icon="inline-start" />
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailPanel>
  )
}

/** 看大图：两张图之间左右切换（箭头按钮或键盘 ← →），和附件的看大图一样 */
function ZoomDialog({ images, index, onIndex, onClose }: { images: Comparison["imageA"][]; index: 0 | 1; onIndex: (index: 0 | 1) => void; onClose: () => void }) {
  const image = images[index]!
  const title = [index === 0 ? "第一张（参照）" : "第二张（要判断的）", image.label].filter(Boolean).join(" · ")
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && index === 1) onIndex(0)
      else if (event.key === "ArrowRight" && index === 0) onIndex(1)
      else return
      event.preventDefault()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [index, onIndex])
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-all">{title}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <img key={image.fileId} src={image.url} alt={title} className="h-auto w-full border" />
          <Button variant="secondary" size="icon" aria-label="上一张" disabled={index === 0} onClick={() => onIndex(0)} className="absolute top-1/2 left-2 -translate-y-1/2">
            <ChevronLeftIcon />
          </Button>
          <Button variant="secondary" size="icon" aria-label="下一张" disabled={index === 1} onClick={() => onIndex(1)} className="absolute top-1/2 right-2 -translate-y-1/2">
            <ChevronRightIcon />
          </Button>
        </div>
        <DialogFooter className="sm:items-center">
          <span className="break-all text-xs text-muted-foreground sm:mr-auto">
            第 {index + 1} / 2 张 · 来源：{image.from || "—"}
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
