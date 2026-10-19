// 附件和产物的显示与上传（组合 registry 的 Attachment、Button、Input、Dialog、CodeBlock、Table、Tabs、Empty）：任务附件、带附件运行、session 的附件和产物都用它。
// 图片显示缩略图，点了弹窗看大图（左右箭头或键盘 ← → 切换同一组里的其他图片）；文本文件点了弹窗看内容（Markdown 按 Markdown 显示）；
// 表格文件（xlsx、xls、csv 等）点了看每个工作表的前 200 行（服务器解析，GET /api/files/:id/sheet）；其他文件弹窗里只说「不能预览，请下载」。
// 下载走 GET /api/files/:id（要求登录，cookie 自动带上）。
// 另外导出 FileViewer（看图 / 看内容的弹窗）、fileSourceLabel（来源文字）、fileTypeIcon（按类型选图标）、isImageFile，给运行详情的「空间文件」列表等别的页面用。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FileIcon, FileSpreadsheetIcon, FileTextIcon, ImageIcon, PaperclipIcon, XIcon, type LucideIcon } from "lucide-react"
import type { SessionFile, SheetPreview, UploadedFile } from "@heyagent/shared"

import { MarkdownView } from "@/components/markdown"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger,
} from "@/components/ui/attachment"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "@/components/ui/toast"
import { fmtSize, uploadFile } from "@/lib/files"

const KIND_LABEL: Record<SessionFile["kind"], string> = {
  attachment: "附件",
  artifact: "产物",
  tool_output: "工具输出全文",
  screenshot: "截图",
  upload: "刚上传",
  download: "浏览器下载",
}

export type ShownFile = Pick<SessionFile, "id" | "name" | "mime" | "size" | "url"> & { kind?: SessionFile["kind"]; scope?: SessionFile["scope"] }

/** 弹窗里最多显示这么多字，再多的请下载 */
const MAX_PREVIEW_CHARS = 200_000
const TEXT_MIME = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|x-ndjson|csv))/
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|ya?ml|csv|tsv|log|xml|html?)$/i

/** 表格：服务器能解析的（和 apps/server/src/files/sheets.ts 的 isSheetFile 一致） */
const SHEET_MIME = /^(application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/vnd\.ms-excel(\.sheet\.(binary\.)?macroenabled\.12)?|application\/vnd\.oasis\.opendocument\.spreadsheet|text\/csv|text\/tab-separated-values)$/i
const SHEET_EXT = /\.(xlsx|xlsm|xlsb|xls|ods|csv|tsv)$/i
/** 预览只看每个工作表的前这么多行 */
const SHEET_PREVIEW_ROWS = 200

const isImage = (file: ShownFile) => file.mime.startsWith("image/")
const isSheet = (file: ShownFile) => SHEET_MIME.test(file.mime) || SHEET_EXT.test(file.name)
const isText = (file: ShownFile) => TEXT_MIME.test(file.mime) || TEXT_EXT.test(file.name)
const isMarkdown = (file: ShownFile) => file.mime === "text/markdown" || /\.(md|markdown)$/i.test(file.name)

/** 是不是图片（看大图时能左右切换） */
export const isImageFile = isImage

/** 文件的来源：任务附件（跨运行一直有效）单独写，其他按 kind */
export function fileSourceLabel(file: { kind: SessionFile["kind"]; scope?: SessionFile["scope"] }) {
  return file.scope === "task" ? "任务附件" : KIND_LABEL[file.kind]
}

/** 按文件类型选的图标：图片、表格、文本，其他是普通文件 */
export function fileTypeIcon(file: ShownFile): LucideIcon {
  if (isImage(file)) return ImageIcon
  if (isSheet(file)) return FileSpreadsheetIcon
  if (isText(file)) return FileTextIcon
  return FileIcon
}

function describe(file: ShownFile) {
  const parts = [fmtSize(file.size)]
  if (file.kind) parts.push(fileSourceLabel({ kind: file.kind, scope: file.scope }))
  return parts.join(" · ")
}

interface FileListProps {
  files: ShownFile[]
  onRemove?: (file: ShownFile) => void
  removingId?: string
  empty?: React.ReactNode
}

/** 一组文件：图片是缩略图（点了看大图），其他的是小卡（文本文件点了看内容）；都带下载，给了 onRemove 就多一个移除按钮 */
export function FileList({ files, onRemove, removingId, empty }: FileListProps) {
  // 记 id 不记对象：列表实时刷新后弹窗跟着新数据走，文件没了弹窗就关掉
  const [viewingId, setViewingId] = React.useState<string | null>(null)
  if (files.length === 0) return empty ? <>{empty}</> : null
  const viewing = files.find((file) => file.id === viewingId)
  const images = files.filter(isImage)
  const others = files.filter((file) => !isImage(file))
  const actions = (file: ShownFile) => (
    <AttachmentActions>
      <AttachmentAction aria-label={`下载 ${file.name}`} nativeButton={false} render={<a href={file.url} download={file.name} />}>
        <DownloadIcon />
      </AttachmentAction>
      {onRemove && (
        <AttachmentAction aria-label={`移除 ${file.name}`} disabled={removingId === file.id} onClick={() => onRemove(file)}>
          {removingId === file.id ? <Spinner /> : <XIcon />}
        </AttachmentAction>
      )}
    </AttachmentActions>
  )
  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((file) => (
            <Attachment key={file.id} orientation="vertical">
              <AttachmentMedia variant="image">
                <img src={file.url} alt={file.name} loading="lazy" />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle title={file.name}>{file.name}</AttachmentTitle>
                <AttachmentDescription>{describe(file)}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentTrigger aria-label={`看大图：${file.name}`} onClick={() => setViewingId(file.id)} />
              {actions(file)}
            </Attachment>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {others.map((file) => (
            <Attachment key={file.id} size="sm" className="max-w-full sm:max-w-72">
              <AttachmentMedia>{isSheet(file) ? <FileSpreadsheetIcon /> : <FileTextIcon />}</AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle title={file.name}>{file.name}</AttachmentTitle>
                <AttachmentDescription>{describe(file)}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentTrigger aria-label={`看内容：${file.name}`} onClick={() => setViewingId(file.id)} />
              {actions(file)}
            </Attachment>
          ))}
        </div>
      )}
      {viewing && <FileViewer file={viewing} images={isImage(viewing) ? images : []} onShow={(file) => setViewingId(file.id)} onClose={() => setViewingId(null)} />}
    </div>
  )
}

/** 看大图 / 看文本内容的弹窗。看图时 images 是同一组的全部图片：左右箭头、键盘 ← → 切换（到头就停，不循环） */
export function FileViewer({ file, images, onShow, onClose }: { file: ShownFile; images: ShownFile[]; onShow: (file: ShownFile) => void; onClose: () => void }) {
  const index = images.findIndex((each) => each.id === file.id)
  const prev = index > 0 ? images[index - 1] : undefined
  const next = index >= 0 ? images[index + 1] : undefined
  const paging = index >= 0 && images.length > 1

  // 挂在 window 的捕获阶段：弹窗里的按钮会拦下方向键、不往外冒泡；点到头的箭头按钮变成禁用后焦点也可能丢到弹窗外
  React.useEffect(() => {
    if (!paging) return
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null
      if (el?.closest("input, textarea, [contenteditable='true']")) return
      const target = event.key === "ArrowLeft" ? prev : event.key === "ArrowRight" ? next : undefined
      if (!target) return
      event.preventDefault()
      onShow(target)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [paging, prev, next, onShow])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="break-all">{file.name}</DialogTitle>
        </DialogHeader>
        {isImage(file) ? (
          <div className="relative">
            <img key={file.id} src={file.url} alt={file.name} className="h-auto w-full border" />
            {paging && (
              <>
                <Button variant="secondary" size="icon" aria-label="上一张" disabled={!prev} onClick={() => prev && onShow(prev)} className="absolute top-1/2 left-2 -translate-y-1/2">
                  <ChevronLeftIcon />
                </Button>
                <Button variant="secondary" size="icon" aria-label="下一张" disabled={!next} onClick={() => next && onShow(next)} className="absolute top-1/2 right-2 -translate-y-1/2">
                  <ChevronRightIcon />
                </Button>
              </>
            )}
          </div>
        ) : isSheet(file) ? (
          <SheetView file={file} />
        ) : isText(file) ? (
          <TextPreview file={file} />
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FileIcon /></EmptyMedia>
              <EmptyTitle>不能预览</EmptyTitle>
              <EmptyDescription>这种文件不能在这里看，请下载。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <DialogFooter className="sm:items-center">
          <span className="text-xs text-muted-foreground sm:mr-auto">{paging ? `第 ${index + 1} / ${images.length} 张 · ` : ""}{describe(file)}</span>
          <Button variant="outline" nativeButton={false} render={<a href={file.url} download={file.name} />}>
            <DownloadIcon data-icon="inline-start" />
            下载
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TextPreview({ file }: { file: ShownFile }) {
  const query = useQuery({
    queryKey: ["file-text", file.id],
    queryFn: async () => {
      const response = await fetch(file.url)
      if (!response.ok) throw new Error(`读不到文件（${response.status}）`)
      return response.text()
    },
    staleTime: Infinity,
  })
  if (query.isPending) return <Spinner />
  if (query.isError) return <p className="text-destructive">{query.error.message}</p>
  const cut = query.data.length > MAX_PREVIEW_CHARS
  const text = cut ? query.data.slice(0, MAX_PREVIEW_CHARS) : query.data
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {isMarkdown(file) ? (
        <MarkdownView>{text}</MarkdownView>
      ) : (
        <CodeBlock size="sm">
          <CodeBlockContent wrap>{text}</CodeBlockContent>
        </CodeBlock>
      )}
      {cut && <p className="text-xs text-muted-foreground">只显示了前 {MAX_PREVIEW_CHARS.toLocaleString()} 个字，完整内容请下载。</p>}
    </div>
  )
}

/** 表格文件：服务器解析好的每个工作表前 200 行；多个工作表用标签页切换 */
function SheetView({ file }: { file: ShownFile }) {
  const query = useQuery({
    queryKey: ["file-sheet", file.id],
    queryFn: async () => {
      const response = await fetch(`${file.url}/sheet?rows=${SHEET_PREVIEW_ROWS}`)
      const body = (await response.json().catch(() => ({}))) as Partial<SheetPreview> & { error?: string }
      if (!response.ok || !body.sheets) throw new Error(body.error ?? `读不到文件（${response.status}）`)
      return body as SheetPreview
    },
    staleTime: Infinity,
  })
  if (query.isPending) return <Spinner />
  if (query.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{query.error.message}</AlertDescription>
      </Alert>
    )
  const { sheets, rowLimit } = query.data
  if (sheets.length === 1) return <SheetTable sheet={sheets[0]!} rowLimit={rowLimit} />
  return (
    <Tabs defaultValue={0} className="min-w-0">
      <TabsList variant="line" className="no-scrollbar w-full justify-start overflow-x-auto">
        {sheets.map((sheet, index) => (
          <TabsTrigger key={index} value={index}>
            {sheet.name}
            {sheet.hidden ? "（隐藏）" : ""}
          </TabsTrigger>
        ))}
      </TabsList>
      {sheets.map((sheet, index) => (
        <TabsContent key={index} value={index}>
          <SheetTable sheet={sheet} rowLimit={rowLimit} />
        </TabsContent>
      ))}
    </Tabs>
  )
}

function SheetTable({ sheet, rowLimit }: { sheet: SheetPreview["sheets"][number]; rowLimit: number }) {
  if (sheet.totalRows === 0)
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><FileSpreadsheetIcon /></EmptyMedia>
          <EmptyDescription>这个工作表是空的。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  const notes = [
    sheet.totalRows > rowLimit ? `只显示前 ${rowLimit} 行，共 ${sheet.totalRows} 行 × ${sheet.totalCols} 列，完整内容请下载` : `共 ${sheet.totalRows} 行 × ${sheet.totalCols} 列`,
    sheet.merged ? `有 ${sheet.merged} 处合并单元格，值只显示在左上角那格` : "",
  ].filter(Boolean)
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              {sheet.columns.map((column) => (
                <TableHead key={column}>{column}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sheet.rows.map((row, index) => (
              <TableRow key={index}>
                <TableCell><span className="text-muted-foreground">{sheet.firstRow + index}</span></TableCell>
                {sheet.columns.map((column, col) => (
                  <TableCell key={column} title={row[col] || undefined} className="max-w-xs truncate">
                    {row[col] ?? ""}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">{notes.join("；")}。</p>
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
