// 附件和产物的显示与上传（组合 registry 的 Attachment、Button、Input、Dialog、CodeBlock、Table、Tabs、Empty）：任务附件、带附件运行、session 的附件和产物都用它。
// 图片显示缩略图，点了弹窗看大图（左右箭头或键盘 ← → 切换同一组里的其他图片）；文本文件点了弹窗看内容（Markdown 按 Markdown 显示）；
// 表格文件（xlsx、xls、csv 等）点了看每个工作表的前 200 行（服务器解析，GET /api/files/:id/sheet）；其他文件弹窗里只说「不能预览，请下载」。
// 下载走 GET /api/files/:id（要求登录，cookie 自动带上）。
// 代码文件（.py .js .ts .sh .sql .toml .ini 等，docs/dev/session-space.md 3.1）按语言高亮显示（CodeView，复用 use-highlighted-code）。
// 有 path（空间里的路径，例如 state/progress.json）的文件显示路径，覆盖过的（updatedAt ≠ createdAt）会标出来。
// 网页请求记录 network/requests.jsonl（kind = network，或者 .jsonl 第一行能按记录的格式解析，docs/dev/solidify.md 19.8）分「表格」「原文」两个标签：表格一行一个请求，点一行看这一行的 JSON。
// 另外导出 FileViewer（看图 / 看内容的弹窗）、CodeView（带高亮的代码块）、fileSourceLabel（来源文字）、fileTypeIcon（按类型选图标）、isImageFile、canPreviewFile、filePathOf、isOverwritten，给运行详情的「空间文件」列表等别的页面用。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FileCodeIcon, FileIcon, FileSpreadsheetIcon, FileTextIcon, ImageIcon, PaperclipIcon, XIcon, type LucideIcon } from "lucide-react"
import { fmtDateTime, networkLogLineSchema, type NetworkLogEndLine, type NetworkLogLine, type NetworkRequestLine, type SessionFile, type SheetPreview, type UploadedFile } from "@heyagent/shared"

import { MarkdownView } from "@/components/markdown"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger,
} from "@/components/ui/attachment"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "@/components/ui/code-block"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "@/components/ui/toast"
import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import { fmtSize, uploadFile } from "@/lib/files"

const KIND_LABEL: Record<SessionFile["kind"], string> = {
  attachment: "附件",
  artifact: "agent 写的",
  tool_output: "工具输出全文",
  screenshot: "截图",
  upload: "刚上传",
  download: "浏览器下载",
  clipboard: "剪贴板",
  network: "网页请求",
}

export type ShownFile = Pick<SessionFile, "id" | "name" | "mime" | "size" | "url"> & Partial<Pick<SessionFile, "kind" | "scope" | "path" | "createdAt" | "updatedAt">>

/** 弹窗里最多显示这么多字，再多的请下载 */
const MAX_PREVIEW_CHARS = 200_000
const TEXT_MIME = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|x-ndjson|csv))/
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|ya?ml|csv|tsv|log|xml|html?|py|m?js|cjs|ts|sh|bash|sql|toml|ini|cfg)$/i
/** 代码文件按扩展名高亮（.ini .cfg .jsonl 的 MIME 只是 text/plain，只能看扩展名）；没有扩展名线索时看 MIME */
const CODE_EXT: Record<string, string> = { py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", sh: "bash", bash: "bash", sql: "sql", toml: "toml", ini: "ini", cfg: "ini", jsonl: "json" }
const CODE_MIME: Record<string, string> = { "text/x-python": "python", "text/javascript": "javascript", "text/x-typescript": "typescript", "text/x-shellscript": "bash", "text/x-sql": "sql", "text/x-toml": "toml" }
/** 超过这么多字就不做语法高亮（高亮在浏览器里同步算，太长会卡） */
const MAX_HIGHLIGHT_CHARS = 50_000

/** 表格：服务器能解析的（和 apps/server/src/files/sheets.ts 的 isSheetFile 一致） */
const SHEET_MIME = /^(application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/vnd\.ms-excel(\.sheet\.(binary\.)?macroenabled\.12)?|application\/vnd\.oasis\.opendocument\.spreadsheet|text\/csv|text\/tab-separated-values)$/i
const SHEET_EXT = /\.(xlsx|xlsm|xlsb|xls|ods|csv|tsv)$/i
/** 预览只看每个工作表的前这么多行 */
const SHEET_PREVIEW_ROWS = 200

const isImage = (file: ShownFile) => file.mime.startsWith("image/")
const isSheet = (file: ShownFile) => SHEET_MIME.test(file.mime) || SHEET_EXT.test(file.name)
const isText = (file: ShownFile) => TEXT_MIME.test(file.mime) || TEXT_EXT.test(file.name)
/** 代码文件的高亮语言；不是代码文件返回 undefined */
const codeLanguage = (file: ShownFile) => CODE_EXT[/\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? ""] ?? CODE_MIME[file.mime]
const isMarkdown = (file: ShownFile) => file.mime === "text/markdown" || /\.(md|markdown)$/i.test(file.name)
/** PDF、Word：不能在这里预览，图标和文本一样 */
const isDocument = (file: ShownFile) => /^application\/(pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/.test(file.mime) || /\.(pdf|docx?)$/i.test(file.name)

/** 是不是图片（看大图时能左右切换） */
export const isImageFile = isImage

/** FileViewer 能不能显示内容（图片、表格、文本）；不能的（PDF、Word 等）直接下载 */
export const canPreviewFile = (file: ShownFile) => isImage(file) || isSheet(file) || isText(file)

/** 空间里显示用的路径；没有路径（上传的附件等）退回文件名 */
export const filePathOf = (file: Pick<ShownFile, "name" | "path">) => file.path || file.name

/** 覆盖过：最后一次写入的时间晚于第一次 */
export const isOverwritten = (file: Pick<ShownFile, "createdAt" | "updatedAt">) => Boolean(file.createdAt && file.updatedAt && file.updatedAt !== file.createdAt)

/** 文件的来源：任务附件（跨运行一直有效）单独写，其他按 kind */
export function fileSourceLabel(file: { kind: SessionFile["kind"]; scope?: SessionFile["scope"] }) {
  return file.scope === "task" ? "任务附件" : KIND_LABEL[file.kind]
}

/** 按文件类型选的图标：图片、表格、代码、文本，其他是普通文件 */
export function fileTypeIcon(file: ShownFile): LucideIcon {
  if (isImage(file)) return ImageIcon
  if (isSheet(file)) return FileSpreadsheetIcon
  if (codeLanguage(file)) return FileCodeIcon
  if (isText(file) || isDocument(file)) return FileTextIcon
  return FileIcon
}

function describe(file: ShownFile) {
  const parts = [fmtSize(file.size)]
  if (file.kind) parts.push(fileSourceLabel({ kind: file.kind, scope: file.scope }))
  if (isOverwritten(file) && file.updatedAt) parts.push(`覆盖于 ${fmtDateTime(file.updatedAt)}`)
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
      <AttachmentAction aria-label={`下载 ${filePathOf(file)}`} nativeButton={false} render={<a href={file.url} download={file.name} />}>
        <DownloadIcon />
      </AttachmentAction>
      {onRemove && (
        <AttachmentAction aria-label={`移除 ${filePathOf(file)}`} disabled={removingId === file.id} onClick={() => onRemove(file)}>
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
                <AttachmentTitle title={filePathOf(file)}>{filePathOf(file)}</AttachmentTitle>
                <AttachmentDescription>{describe(file)}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentTrigger aria-label={`看大图：${filePathOf(file)}`} onClick={() => setViewingId(file.id)} />
              {actions(file)}
            </Attachment>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {others.map((file) => {
            const Icon = fileTypeIcon(file)
            return (
              <Attachment key={file.id} size="sm" className="max-w-full sm:max-w-72">
                <AttachmentMedia><Icon /></AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle title={filePathOf(file)}>{filePathOf(file)}</AttachmentTitle>
                  <AttachmentDescription>{describe(file)}</AttachmentDescription>
                </AttachmentContent>
                <AttachmentTrigger aria-label={`看内容：${filePathOf(file)}`} onClick={() => setViewingId(file.id)} />
                {actions(file)}
              </Attachment>
            )
          })}
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
          <DialogTitle className="break-all">{filePathOf(file)}</DialogTitle>
        </DialogHeader>
        {isImage(file) ? (
          <div className="relative">
            <img key={file.id} src={file.url} alt={filePathOf(file)} className="h-auto w-full border" />
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
  const network = React.useMemo(() => (query.data !== undefined ? networkLogOf(file, query.data) : undefined), [file, query.data])
  if (query.isPending) return <Spinner />
  if (query.isError) return <p className="text-destructive">{query.error.message}</p>
  const cut = query.data.length > MAX_PREVIEW_CHARS
  const text = cut ? query.data.slice(0, MAX_PREVIEW_CHARS) : query.data
  const raw = (
    <div className="flex min-w-0 flex-col gap-2">
      {isMarkdown(file) ? (
        <MarkdownView>{text}</MarkdownView>
      ) : (
        <CodeView code={text} language={codeLanguage(file)} />
      )}
      {cut && <p className="text-xs text-muted-foreground">只显示了前 {MAX_PREVIEW_CHARS.toLocaleString()} 个字，完整内容请下载。</p>}
    </div>
  )
  if (!network) return raw
  return (
    <Tabs defaultValue="table" className="min-w-0">
      <TabsList variant="line">
        <TabsTrigger value="table">表格</TabsTrigger>
        <TabsTrigger value="raw">原文</TabsTrigger>
      </TabsList>
      <TabsContent value="table"><NetworkLogTable log={network} /></TabsContent>
      <TabsContent value="raw">{raw}</TabsContent>
    </Tabs>
  )
}

// ---------- 网页请求记录 network/requests.jsonl（docs/dev/solidify.md 19.3、19.8） ----------

interface NetworkLog {
  rows: NetworkRequestLine[]
  end?: NetworkLogEndLine
  /** 解析不了的行数（只在原文里看得到） */
  bad: number
}

/** 一行一个 JSON；解析不了的行是 undefined */
function parseNetworkLines(text: string): (NetworkLogLine | undefined)[] {
  return text.split("\n").filter((line) => line.trim()).map((line) => {
    try {
      const parsed = networkLogLineSchema.safeParse(JSON.parse(line))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  })
}

/** 是网页请求记录（kind = network，或者 .jsonl 第一行能按记录的格式解析）才按表格显示；不是返回 undefined */
function networkLogOf(file: ShownFile, text: string): NetworkLog | undefined {
  if (file.kind !== "network" && !/\.jsonl$/i.test(file.name)) return undefined
  const lines = parseNetworkLines(text)
  if (file.kind !== "network" && !lines[0]) return undefined
  const log: NetworkLog = { rows: [], bad: 0 }
  for (const line of lines) {
    if (!line) log.bad++
    else if ("end" in line) log.end = line
    else log.rows.push(line)
  }
  return log
}

/** 「09:12:03」：本地时间的时:分:秒 */
const clockText = (at: string) => {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

/** 网址只显示路径和参数；解析不了原样 */
const requestPath = (url: string) => {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

/** 一行一个请求；点一行，下面显示这一行的 JSON（排好版）；最后一行是 end 时写后面还有几个没记 */
function NetworkLogTable({ log }: { log: NetworkLog }) {
  const [selected, setSelected] = React.useState<number | null>(null)
  const row = log.rows.find((each) => each.seq === selected)
  const toggle = (seq: number) => setSelected((current) => (current === seq ? null : seq))
  if (log.rows.length === 0 && !log.end)
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><FileIcon /></EmptyMedia>
          <EmptyDescription>没有记下请求{log.bad ? `（${log.bad} 行解析不了，看「原文」）` : ""}。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">序号</TableHead>
              <TableHead>时间</TableHead>
              <TableHead>方法</TableHead>
              <TableHead>网址</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>返回类型</TableHead>
              <TableHead className="text-right">大小</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {log.rows.map((each) => (
              <TableRow
                key={each.seq}
                tabIndex={0}
                aria-selected={each.seq === selected}
                data-state={each.seq === selected ? "selected" : undefined}
                onClick={() => toggle(each.seq)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return
                  event.preventDefault()
                  toggle(each.seq)
                }}
              >
                <TableCell className="text-muted-foreground tabular-nums">{each.seq}</TableCell>
                <TableCell className="tabular-nums">{clockText(each.at)}</TableCell>
                <TableCell><Badge variant="outline">{each.method}</Badge></TableCell>
                <TableCell className="max-w-xs truncate font-mono" title={each.url}>{requestPath(each.url)}</TableCell>
                <TableCell>
                  {each.status === 0
                    ? <Badge variant="destructive" title={each.error}>没返回</Badge>
                    : <Badge variant={each.status >= 400 ? "destructive" : "outline"}>{each.status}</Badge>}
                </TableCell>
                <TableCell className="max-w-40 truncate text-muted-foreground" title={each.responseType}>{each.responseType ?? ""}</TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">{each.bytes !== undefined ? fmtSize(each.bytes) : ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {log.end && <p className="text-xs text-muted-foreground">后面还有 {log.end.skipped} 个请求没记：{log.end.reason}</p>}
      {log.bad > 0 && <p className="text-xs text-muted-foreground">另有 {log.bad} 行解析不了，看「原文」。</p>}
      {row ? <CodeView code={JSON.stringify(row, null, 2)} language="json" title={`第 ${row.seq} 个请求`} /> : <p className="text-xs text-muted-foreground">点一行看这个请求的全部记录。</p>}
    </div>
  )
}

/**
 * 带语法高亮的代码块（组合 registry 的 CodeBlock 和 use-highlighted-code，和 SKILL.md 源码同一写法）。
 * language 不认识（或没给）就是纯文本；太长的不高亮。title 给了就多一个标题栏，右上角是复制按钮。
 */
export function CodeView({ code, language, title, lineNumbers, className }: { code: string; language?: string; title?: React.ReactNode; lineNumbers?: boolean; className?: string }) {
  const lines = useHighlightedCode(code, language && code.length <= MAX_HIGHLIGHT_CHARS ? language : "text")
  return (
    <CodeBlock size="sm">
      {title && (
        <CodeBlockHeader>
          <CodeBlockTitle>{title}</CodeBlockTitle>
          <CodeBlockActions><CodeBlockCopyButton value={code} /></CodeBlockActions>
        </CodeBlockHeader>
      )}
      {!title && <CodeBlockActions><CodeBlockCopyButton value={code} /></CodeBlockActions>}
      <CodeBlockContent lineNumbers={lineNumbers} wrap className={className}>
        {lines.map((line, index) => <CodeBlockLine key={index}>{line}</CodeBlockLine>)}
      </CodeBlockContent>
    </CodeBlock>
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
