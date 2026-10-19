// 运行详情右上角的「空间文件」：这次运行的整个文件空间（任务附件、agent 存的文件、浏览器下载、截图、工具输出全文、刚上传的）。
// 点开是一个大弹窗：按来源分标签页、按名字搜，表格列出名字 / 来源 / 大小 / 时间，点名字预览（复用 components/files 的 FileViewer），右边下载。
// 和抽屉里的 SessionFiles 用同一个查询（engine.sessionFiles），实时推送刷新时两边一起变。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { DownloadIcon, FolderOpenIcon, SearchIcon } from "lucide-react"
import { fmtDateTime, type SessionFile, type SessionSummary } from "@heyagent/shared"

import { FileViewer, fileSourceLabel, fileTypeIcon, isImageFile } from "@/components/files"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fmtSize } from "@/lib/files"
import { trpc } from "@/lib/trpc"

/** 标签页上的来源，按这个顺序排；任务附件和这次运行的附件都算「附件」 */
const SOURCES = [
  { id: "download", label: "浏览器下载" },
  { id: "artifact", label: "产物" },
  { id: "screenshot", label: "截图" },
  { id: "attachment", label: "附件" },
  { id: "tool_output", label: "工具输出全文" },
  { id: "upload", label: "刚上传" },
] as const satisfies readonly { id: SessionFile["kind"]; label: string }[]

type Source = SessionFile["kind"]
type Filter = Source | "all"

const sourceOf = (file: SessionFile): Source => (file.scope === "task" ? "attachment" : file.kind)

function useSpaceFiles(sessionId: string) {
  return useQuery(trpc.engine.sessionFiles.queryOptions({ sessionId }))
}

/** 「空间文件」按钮：一直显示（没有文件也能点开看）；取到列表后带上文件数 */
export function RunSpaceButton({ run }: { run: SessionSummary }) {
  const list = useSpaceFiles(run.id)
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <FolderOpenIcon data-icon="inline-start" />
        空间文件
        {list.data && <span className="text-muted-foreground tabular-nums">{list.data.length}</span>}
      </Button>
      {open && <RunSpaceDialog run={run} onClose={() => setOpen(false)} />}
    </>
  )
}

function RunSpaceDialog({ run, onClose }: { run: SessionSummary; onClose: () => void }) {
  const list = useSpaceFiles(run.id)
  const files = React.useMemo(() => [...(list.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [list.data])
  const total = files.reduce((sum, file) => sum + file.size, 0)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>空间文件</DialogTitle>
          <DialogDescription>{list.data ? `共 ${files.length} 个文件 · ${fmtSize(total)}` : `运行 ${run.id} 的文件`}</DialogDescription>
        </DialogHeader>
        {list.isPending ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-8 w-full" />)}
          </div>
        ) : list.isError ? (
          <Alert variant="destructive">
            <AlertDescription>文件列表没取到，稍后再试。</AlertDescription>
          </Alert>
        ) : files.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FolderOpenIcon /></EmptyMedia>
              <EmptyTitle>空间里还没有文件</EmptyTitle>
              <EmptyDescription>agent 存的文件、浏览器下载、截图都会出现在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <SpaceFiles files={files} />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 有文件时：来源标签页 + 搜名字 + 表格；点名字预览，图片在当前筛出来的图片里左右切换 */
function SpaceFiles({ files }: { files: SessionFile[] }) {
  const [filter, setFilter] = React.useState<Filter>("all")
  const [query, setQuery] = React.useState("")
  // 记 id 不记对象：列表实时刷新后弹窗跟着新数据走，文件没了弹窗就关掉
  const [viewingId, setViewingId] = React.useState<string | null>(null)

  const counts = new Map<Source, number>()
  for (const file of files) counts.set(sourceOf(file), (counts.get(sourceOf(file)) ?? 0) + 1)
  const sources = SOURCES.filter((source) => counts.has(source.id))
  // 选中的来源没文件了（比如被删了）就回到「全部」
  const active: Filter = filter !== "all" && !counts.has(filter) ? "all" : filter

  const needle = query.trim().toLowerCase()
  const shown = files.filter((file) => (active === "all" || sourceOf(file) === active) && (!needle || file.name.toLowerCase().includes(needle)))
  const viewing = files.find((file) => file.id === viewingId)
  const images = shown.filter(isImageFile)

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Tabs value={active} onValueChange={(value) => setFilter(value as Filter)} className="min-w-0 flex-1">
          <TabsList variant="line" className="no-scrollbar w-full justify-start overflow-x-auto">
            <TabsTrigger value="all" className="flex-none">
              全部
              <span className="text-muted-foreground tabular-nums">{files.length}</span>
            </TabsTrigger>
            {sources.map((source) => (
              <TabsTrigger key={source.id} value={source.id} className="flex-none">
                {source.label}
                <span className="text-muted-foreground tabular-nums">{counts.get(source.id)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <InputGroup className="w-full sm:w-56">
          <InputGroupAddon><SearchIcon /></InputGroupAddon>
          <InputGroupInput aria-label="搜文件名" placeholder="搜文件名" value={query} onChange={(event) => setQuery(event.target.value)} />
        </InputGroup>
      </div>
      {shown.length === 0 ? (
        <p className="text-muted-foreground">{needle ? `没有名字里带「${query.trim()}」的文件。` : "这一类没有文件。"}</p>
      ) : (
        <div className="border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名字</TableHead>
                <TableHead className="hidden sm:table-cell">来源</TableHead>
                <TableHead className="hidden sm:table-cell">大小</TableHead>
                <TableHead className="hidden sm:table-cell">时间</TableHead>
                <TableHead className="w-10"><span className="sr-only">操作</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((file) => {
                const Icon = fileTypeIcon(file)
                return (
                  <TableRow key={file.id}>
                    <TableCell className="max-w-48 sm:max-w-sm">
                      <Button variant="ghost" size="sm" className="max-w-full" title={file.name} onClick={() => setViewingId(file.id)}>
                        <Icon data-icon="inline-start" />
                        <span className="truncate">{file.name}</span>
                      </Button>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell"><Badge variant="outline">{fileSourceLabel(file)}</Badge></TableCell>
                    <TableCell className="hidden sm:table-cell"><span className="text-muted-foreground tabular-nums">{fmtSize(file.size)}</span></TableCell>
                    <TableCell className="hidden sm:table-cell"><span className="text-muted-foreground tabular-nums">{fmtDateTime(file.createdAt)}</span></TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" aria-label={`下载 ${file.name}`} nativeButton={false} render={<a href={file.url} download={file.name} />}>
                        <DownloadIcon />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {viewing && <FileViewer file={viewing} images={isImageFile(viewing) ? images : []} onShow={(file) => setViewingId(file.id)} onClose={() => setViewingId(null)} />}
    </div>
  )
}
