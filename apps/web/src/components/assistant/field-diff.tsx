// 确认卡上一个字段的差异对比（两边都有值时）：像 Git diff，删的红底「-」、加的绿底「+」，改过的句子里只高亮改了的词；
// 任务步骤逐条对比、保留编号；没改的长段收起来；宽屏可以开「左右对照」弹窗。算法在 lib/text-diff.ts
import * as React from "react"
import { ChevronsUpDownIcon, Columns2Icon } from "lucide-react"
import type { AssistantChange } from "@heyagent/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"

import { cn } from "@/lib/utils"
import { diffSteps, diffText, foldRows, rowHasText, type DiffResult, type DiffRow, type DiffSegment, type FoldedRow } from "@/lib/text-diff"

type FieldChange = AssistantChange["fields"][number]

/** 一行的样子：没改（灰字）/ 删（红底 -）/ 加（绿底 +） */
type Tone = "same" | "del" | "add"

const SIGN: Record<Tone, string> = { same: "", del: "-", add: "+" }
/** 读屏软件读到的前缀：颜色和 +/- 看不见，要说出来 */
const SR_TEXT: Record<Tone, string> = { same: "", del: "删除：", add: "新增：" }

interface FieldDiffProps {
  /** 这项改动的标题（左右对照弹窗的标题用） */
  title: string
  field: FieldChange
}

/** 一个字段改前、改后都有：上面一行「字段名：改了几处」和按钮，下面是逐行的对比 */
export function FieldDiff({ title, field }: FieldDiffProps) {
  const steps = field.steps
  const result = React.useMemo(() => (steps ? diffSteps(steps.before, steps.after) : diffText(field.before ?? "", field.after ?? "")), [steps, field.before, field.after])
  const folded = React.useMemo(() => foldRows(result.rows), [result])
  const canFold = folded.some((row) => row.kind === "fold")
  const [full, setFull] = React.useState(false)
  const isSteps = Boolean(steps)
  // 名字、定时、是 / 否这类一行的短值：一眼就看得出，不写「改了几处」，也不用左右对照
  const short = !steps && isShort(field.before ?? "") && isShort(field.after ?? "")

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2">
        <span>
          {field.label}：{!short && summaryText(result, isSteps)}
        </span>
        {!short && (
          <div className="ml-auto flex items-center">
            {canFold && (
              <Button variant="ghost" size="xs" onClick={() => setFull(!full)}>
                {full ? "只看改动" : "看全文"}
              </Button>
            )}
            <SideBySide title={title} label={field.label} result={result} isSteps={isSteps} />
          </div>
        )}
      </div>
      {result.rows.length === 0 ? <span>（空）</span> : <UnifiedRows rows={full ? result.rows : folded} isSteps={isSteps} />}
    </div>
  )
}

const isShort = (value: string) => value.length <= 80 && !value.includes("\n")

/** 「改了 2 处：删 1 句、加 1 句、改 3 句」；步骤是「改 1 步、加 1 步、删 1 步」 */
function summaryText({ counts }: DiffResult, isSteps: boolean) {
  if (counts.hunks === 0) return "没有改动"
  if (isSteps) {
    const parts = [counts.mod && `改 ${counts.mod} 步`, counts.add && `加 ${counts.add} 步`, counts.del && `删 ${counts.del} 步`].filter(Boolean)
    return parts.join("、") || "只改了顺序"
  }
  const parts = [counts.del && `删 ${counts.del} 句`, counts.add && `加 ${counts.add} 句`, counts.mod && `改 ${counts.mod} 句`].filter(Boolean)
  return `改了 ${counts.hunks} 处：${parts.join("、") || "只改了换行"}`
}

/** 收起来的那段有几句（几步）没改 */
function foldText(rows: DiffRow[], isSteps: boolean) {
  const count = rows.filter(rowHasText).length
  return count ? `还有 ${count} ${isSteps ? "步" : "句"}没改，展开` : "展开"
}

/** 收起的地方用这个状态记哪些点开了（按位置） */
function useOpenFolds(rows: FoldedRow[]) {
  const [open, setOpen] = React.useState<{
    rows: FoldedRow[]
    set: Set<number>
  }>({ rows, set: new Set() })
  // 行变了（切换全文 / 只看改动）就重新算
  const set = open.rows === rows ? open.set : new Set<number>()
  const expand = (index: number) => setOpen({ rows, set: new Set(set).add(index) })
  return { isOpen: (index: number) => set.has(index), expand }
}

/** 上下排的对比（卡上用）：每行左边一栏 +/-，改了的句子拆成一行 - 一行 + */
function UnifiedRows({ rows, isSteps }: { rows: FoldedRow[]; isSteps: boolean }) {
  const { isOpen, expand } = useOpenFolds(rows)
  return (
    <div className="flex flex-col border">
      {rows.map((row, index) =>
        row.kind === "fold" ? (
          isOpen(index) ? (
            row.rows.map((inner, innerIndex) => <UnifiedRow key={`${index}-${innerIndex}`} row={inner} isSteps={isSteps} />)
          ) : (
            <FoldButton key={index} onClick={() => expand(index)}>
              {foldText(row.rows, isSteps)}
            </FoldButton>
          )
        ) : (
          <UnifiedRow key={index} row={row} isSteps={isSteps} />
        )
      )}
    </div>
  )
}

function FoldButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <Button variant="ghost" size="xs" className="w-full justify-start" onClick={onClick}>
      <ChevronsUpDownIcon data-icon="inline-start" />
      {children}
    </Button>
  )
}

/** 一行对比：步骤先写一行「第 3 步 改了」这类说明 */
function UnifiedRow({ row, isSteps }: { row: DiffRow; isSteps: boolean }) {
  const label = isSteps ? stepLabel(row) : undefined
  const lines =
    row.kind === "mod" ? (
      <>
        <Line tone="del" no={isSteps ? row.beforeNo : undefined}>
          <Segments segments={row.before} />
        </Line>
        <Line tone="add" no={isSteps ? row.afterNo : undefined}>
          <Segments segments={row.after} />
        </Line>
      </>
    ) : (
      <TextLine row={row} isSteps={isSteps} />
    )
  if (!label) return lines
  return (
    <>
      <div className="flex pt-1">
        <span className="w-4 shrink-0" />
        <Badge variant="secondary">{label}</Badge>
      </div>
      {lines}
    </>
  )
}

/** 步骤改动的说明：「第 3 步 改了」「原第 2 步 → 第 3 步，改了」「新增第 4 步」「删掉原第 5 步」；没改的不写 */
function stepLabel(row: DiffRow) {
  if (row.kind === "add") return `新增第 ${row.afterNo} 步`
  if (row.kind === "del") return `删掉原第 ${row.beforeNo} 步`
  if (row.kind === "mod") return row.beforeNo === row.afterNo ? `第 ${row.afterNo} 步 改了` : `原第 ${row.beforeNo} 步 → 第 ${row.afterNo} 步，改了`
  return undefined
}

/** 整句没改 / 整句删 / 整句加的一行 */
function TextLine({ row, isSteps, side }: { row: Extract<DiffRow, { text: string }>; isSteps: boolean; side?: "before" | "after" }) {
  // 空白行：没改的留一点空隙当段落间距，删 / 加的写明是空行
  if (!row.text.trim()) {
    if (row.kind === "same") return <div aria-hidden className="h-2" />
    return (
      <Line tone={row.kind}>
        <span className="text-muted-foreground">{row.text === "\n" ? "（换行）" : "（空行）"}</span>
      </Line>
    )
  }
  const no = !isSteps ? undefined : row.kind === "del" || side === "before" ? row.beforeNo : row.afterNo
  // 没改的步骤编号变了（前面插了 / 删了步）：上下排时在后面注明原来是第几步
  const moved = isSteps && !side && row.kind === "same" && row.beforeNo !== row.afterNo
  return (
    <Line tone={row.kind} no={no}>
      {row.text}
      {moved && <span className="text-muted-foreground">（原第 {row.beforeNo} 步）</span>}
    </Line>
  )
}

/** 一行：左边 +/- 栏，右边文字（保留换行、长词折行）；no 是步骤编号 */
function Line({ tone, no, children }: { tone: Tone; no?: number; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex",
        tone === "same" && "text-muted-foreground",
        tone === "del" && "bg-diff-removed/40 text-foreground",
        tone === "add" && "bg-diff-added/40 text-foreground"
      )}
    >
      <span aria-hidden className="w-4 shrink-0 text-center select-none">
        {SIGN[tone]}
      </span>
      <span className="min-w-0 flex-1 wrap-break-word whitespace-pre-wrap">
        {SR_TEXT[tone] && <span className="sr-only">{SR_TEXT[tone]}</span>}
        {no !== undefined && `${no}. `}
        {children}
      </span>
    </div>
  )
}

/** 改了的句子：没改的词照常，删的词红底加删除线，加的词绿底 */
function Segments({ segments }: { segments: DiffSegment[] }) {
  return segments.map((segment, index) =>
    segment.kind === "same" ? (
      <React.Fragment key={index}>{segment.text}</React.Fragment>
    ) : segment.kind === "del" ? (
      <del key={index} className="bg-diff-removed">
        {segment.text}
      </del>
    ) : (
      <ins key={index} className="bg-diff-added no-underline">
        {segment.text}
      </ins>
    )
  )
}

// ---------- 左右对照 ----------

/** 左右对照的一行：两边各一格（没有的一边空着）；或者一段收起的 */
type PairLine = { kind: "pair"; left?: DiffRow; right?: DiffRow }
type SplitLine = PairLine | { kind: "fold"; rows: DiffRow[] }

const isPair = (line: SplitLine): line is PairLine => line.kind === "pair"

/** 排成左右两列：没改的两边都有；改了的左右并排；挨着的删 / 加也左右并排，多出来的一边空着 */
function toSplitLines(rows: FoldedRow[]): SplitLine[] {
  const lines: SplitLine[] = []
  let dels: DiffRow[] = []
  let adds: DiffRow[] = []
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) lines.push({ kind: "pair", left: dels[i], right: adds[i] })
    dels = []
    adds = []
  }
  for (const row of rows) {
    if (row.kind === "del") dels.push(row)
    else if (row.kind === "add") adds.push(row)
    else {
      flush()
      lines.push(row.kind === "fold" ? row : { kind: "pair", left: row, right: row })
    }
  }
  flush()
  return lines
}

/** 「左右对照」按钮和弹窗（只在宽屏显示：窄屏两列太挤） */
function SideBySide({ title, label, result, isSteps }: { title: string; label: string; result: DiffResult; isSteps: boolean }) {
  const [full, setFull] = React.useState(false)
  const folded = React.useMemo(() => foldRows(result.rows), [result])
  const canFold = folded.some((row) => row.kind === "fold")
  const lines = React.useMemo(() => toSplitLines(full ? result.rows : folded), [full, result, folded])
  const { isOpen, expand } = useOpenFolds(full ? result.rows : folded)

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="ghost" size="xs" className="hidden md:inline-flex" />}>
        <Columns2Icon data-icon="inline-start" />
        左右对照
      </DialogTrigger>
      <DialogContent className="flex max-h-11/12 flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {title}：{label}
          </DialogTitle>
          <div className="flex flex-wrap items-center gap-x-2">
            <DialogDescription>{summaryText(result, isSteps)}</DialogDescription>
            {canFold && (
              <Button variant="ghost" size="xs" onClick={() => setFull(!full)}>
                {full ? "只看改动" : "看全文"}
              </Button>
            )}
          </div>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto border">
          <div className="sticky top-0 grid grid-cols-2 border-b bg-popover font-medium">
            <span className="px-4">修改前</span>
            <span className="border-l px-4">修改后</span>
          </div>
          {lines.map((line, index) =>
            line.kind === "fold" ? (
              isOpen(index) ? (
                toSplitLines(line.rows)
                  .filter(isPair)
                  .map((inner, innerIndex) => <SplitRow key={`${index}-${innerIndex}`} line={inner} isSteps={isSteps} />)
              ) : (
                <FoldButton key={index} onClick={() => expand(index)}>
                  {foldText(line.rows, isSteps)}
                </FoldButton>
              )
            ) : (
              <SplitRow key={index} line={line} isSteps={isSteps} />
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 左右对照的一行：左边是改前那一格，右边是改后那一格 */
function SplitRow({ line, isSteps }: { line: PairLine; isSteps: boolean }) {
  return (
    <div className="grid grid-cols-2">
      <SplitCell row={line.left} side="before" isSteps={isSteps} />
      <div className="border-l">
        <SplitCell row={line.right} side="after" isSteps={isSteps} />
      </div>
    </div>
  )
}

function SplitCell({ row, side, isSteps }: { row?: DiffRow; side: "before" | "after"; isSteps: boolean }) {
  // 这一边没有对应的行：灰底空格
  if (!row) return <div aria-hidden className="h-full bg-muted" />
  if (row.kind === "mod") {
    return side === "before" ? (
      <Line tone="del" no={isSteps ? row.beforeNo : undefined}>
        <Segments segments={row.before} />
      </Line>
    ) : (
      <Line tone="add" no={isSteps ? row.afterNo : undefined}>
        <Segments segments={row.after} />
      </Line>
    )
  }
  return <TextLine row={row} isSteps={isSteps} side={side} />
}
