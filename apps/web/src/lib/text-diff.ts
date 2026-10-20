// 两段文字的差异对比（助手改动确认卡用）：先按句对齐，再在改过的句子里按词标出加了 / 删了什么；任务步骤按条对比、带编号。
// 只做计算，不碰 React。算法：jsdiff 的 diffArrays（Myers），两层——
//   第 1 层：把文字切成「句」（换行单独成一段），逐句对比，得到没改 / 删 / 加；
//   第 2 层：挨着的「删 + 加」里，像的两句配成一对「改」，在句子里按词（Intl.Segmenter，中文不靠空格也能分词）再对比一次。
import { diffArrays } from "diff"

/** 句子里的一段：没改 / 加的 / 删的 */
export interface DiffSegment {
  text: string
  kind: "same" | "add" | "del"
}

/** 编号（任务步骤用）：改前第几步 / 改后第几步，从 1 开始 */
interface DiffNumbers {
  beforeNo?: number
  afterNo?: number
}

/** 一行（一句或一步）：没改 / 删掉 / 新加 / 改了（两边各一串词段） */
export type DiffRow = DiffNumbers &
  ({ kind: "same"; text: string } | { kind: "del"; text: string } | { kind: "add"; text: string } | { kind: "mod"; before: DiffSegment[]; after: DiffSegment[] })

/** 折叠后的一行：没改的一长串收成一个 fold */
export type FoldedRow = DiffRow | { kind: "fold"; rows: DiffRow[] }

export interface DiffCounts {
  /** 改了几处（连在一起的改动算一处） */
  hunks: number
  del: number
  add: number
  mod: number
}

export interface DiffResult {
  rows: DiffRow[]
  counts: DiffCounts
}

/** 句子数超过这么多就不再按词细比（只标整句加 / 删），免得卡 */
const HUGE = 3000
/** 两句有这么多文字相同才算「改了这一句」，否则算删一句、加一句 */
const SIMILAR = 0.4
/** 一句删的往后最多看几句加的，找像的那句配对 */
const PAIR_WINDOW = 10
/** 一块里配对最多试这么多次按词对比，再多（整篇重写）就直接列成删 / 加 */
const PAIR_BUDGET = 3000
/** 逐句对比最多算这么多处增删；超过说明几乎整篇重写了，直接整篇删、整篇加，免得卡住 */
const MAX_EDITS = 1000

const ENDERS = new Set(["。", "！", "？", "；", "!", "?", ";", "…"])
/** 句末标点后面紧跟的引号、括号也算这一句的 */
const CLOSERS = new Set(["」", "』", "”", "’", "）", ")", "]", "】", "》", '"', "'"])

/**
 * 切成句：换行（连同中间的空白行）单独成一段；句末标点（。！？；!?;… 和后面的引号括号、空格）、英文「. 」后断开。
 * 分隔符都留在段里，各段拼起来就是原文。
 */
export function splitSentences(text: string): string[] {
  const units: string[] = []
  let i = 0
  while (i < text.length) {
    let j = i
    if (text[i] === "\n") {
      // 一个或几个换行，中间只有空格的空白行也算进来；不吞下一行开头的缩进
      j++
      for (;;) {
        let k = j
        while (k < text.length && (text[k] === " " || text[k] === "\t")) k++
        if (text[k] === "\n") j = k + 1
        else break
      }
    } else {
      while (j < text.length && text[j] !== "\n") {
        const c = text[j]!
        j++
        if (ENDERS.has(c)) {
          while (j < text.length && (ENDERS.has(text[j]!) || CLOSERS.has(text[j]!))) j++
          while (j < text.length && (text[j] === " " || text[j] === "\t")) j++
          break
        }
        if (c === "." && (text[j] === " " || text[j] === "\t")) {
          while (j < text.length && (text[j] === " " || text[j] === "\t")) j++
          break
        }
      }
    }
    units.push(text.slice(i, j))
    i = j
  }
  return units
}

let segmenter: Intl.Segmenter | undefined

/** 切成词：中文按词典分词，空格、标点各自成一段 */
export function splitWords(text: string): string[] {
  segmenter ??= new Intl.Segmenter("zh", { granularity: "word" })
  return Array.from(segmenter.segment(text), (part) => part.segment)
}

/** 两段在词上对比：两边各一串词段，以及相同文字占比（0～1） */
export function diffWords(before: string, after: string): { before: DiffSegment[]; after: DiffSegment[]; similarity: number } {
  if (before === after)
    return {
      before: [{ text: before, kind: "same" }],
      after: [{ text: after, kind: "same" }],
      similarity: 1,
    }
  const chunks = diffArrays(splitWords(before), splitWords(after)).map((chunk) => ({
    text: chunk.value.join(""),
    kind: chunk.added ? ("add" as const) : chunk.removed ? ("del" as const) : ("same" as const),
  }))
  // 夹在两处改动中间的一个字、一个标点、一段空白算进改动里，不然高亮碎成一小块一小块
  const cleaned: { text: string; kind: "same" | "add" | "del" }[] = []
  chunks.forEach((chunk, index) => {
    const tiny = chunk.kind === "same" && (chunk.text.length <= 1 || chunk.text.trim() === "")
    if (tiny && index > 0 && index < chunks.length - 1 && chunks[index - 1]!.kind !== "same" && chunks[index + 1]!.kind !== "same") {
      cleaned.push({ text: chunk.text, kind: "del" }, { text: chunk.text, kind: "add" })
    } else cleaned.push(chunk)
  })
  const beforeSegs: DiffSegment[] = []
  const afterSegs: DiffSegment[] = []
  let same = 0
  for (const chunk of cleaned) {
    if (chunk.kind !== "add") pushSegment(beforeSegs, chunk)
    if (chunk.kind !== "del") pushSegment(afterSegs, chunk)
    if (chunk.kind === "same") same += chunk.text.length
  }
  const total = before.length + after.length
  return {
    before: beforeSegs,
    after: afterSegs,
    similarity: total === 0 ? 1 : (2 * same) / total,
  }
}

/** 追加一段，和前一段同类就合并 */
function pushSegment(segments: DiffSegment[], segment: DiffSegment) {
  if (!segment.text) return
  const last = segments[segments.length - 1]
  if (last && last.kind === segment.kind) last.text += segment.text
  else segments.push({ ...segment })
}

/**
 * 一块连着的「删 + 加」配对：删的每一句往后找最像的那句加的，够像（≥ SIMILAR）就算「改」，
 * 中间跳过的加的照常列成新加；配不上的就是删 / 加。sameCount 为真时两边条数一样就按位置一一配（步骤整条重写也算「改了这一步」）
 */
function pairBlock(removed: string[], added: string[], fine: boolean, sameCount: boolean): DiffRow[] {
  const rows: DiffRow[] = []
  if (!fine || removed.length * Math.min(added.length, PAIR_WINDOW) > PAIR_BUDGET) {
    for (const text of removed) rows.push({ kind: "del", text })
    for (const text of added) rows.push({ kind: "add", text })
    return rows
  }
  if (sameCount && removed.length === added.length) {
    removed.forEach((text, index) => {
      const words = diffWords(text, added[index]!)
      rows.push({ kind: "mod", before: words.before, after: words.after })
    })
    return rows
  }
  let next = 0
  for (const text of removed) {
    let best = -1
    let bestWords: ReturnType<typeof diffWords> | undefined
    // 空白行不和别的配对
    if (text.trim()) {
      for (let k = next; k < Math.min(added.length, next + PAIR_WINDOW); k++) {
        if (!added[k]!.trim()) continue
        const words = diffWords(text, added[k]!)
        if (words.similarity >= SIMILAR && (!bestWords || words.similarity > bestWords.similarity)) {
          best = k
          bestWords = words
        }
      }
    }
    if (best < 0 || !bestWords) {
      rows.push({ kind: "del", text })
      continue
    }
    for (let k = next; k < best; k++) rows.push({ kind: "add", text: added[k]! })
    rows.push({ kind: "mod", before: bestWords.before, after: bestWords.after })
    next = best + 1
  }
  for (let k = next; k < added.length; k++) rows.push({ kind: "add", text: added[k]! })
  return rows
}

/** 两串（句子或步骤）逐条对比，挨着的删 + 加交给 pairBlock */
function diffUnits(before: string[], after: string[], fine: boolean, sameCount: boolean): DiffRow[] {
  // 先去掉两头相同的部分，只比中间
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  const rows: DiffRow[] = before.slice(0, head).map((text) => ({ kind: "same", text }))
  const middleBefore = before.slice(head, before.length - tail)
  const middleAfter = after.slice(head, after.length - tail)
  let removed: string[] = []
  let added: string[] = []
  const flush = () => {
    if (removed.length || added.length) rows.push(...pairBlock(removed, added, fine, sameCount))
    removed = []
    added = []
  }
  const chunks = diffArrays(middleBefore, middleAfter, {
    maxEditLength: MAX_EDITS,
  }) ?? [
    {
      value: middleBefore,
      removed: true,
      added: false,
      count: middleBefore.length,
    },
    {
      value: middleAfter,
      removed: false,
      added: true,
      count: middleAfter.length,
    },
  ]
  for (const chunk of chunks) {
    if (chunk.removed) removed.push(...chunk.value)
    else if (chunk.added) added.push(...chunk.value)
    else {
      flush()
      for (const text of chunk.value) rows.push({ kind: "same", text })
    }
  }
  flush()
  for (const text of before.slice(before.length - tail)) rows.push({ kind: "same", text })
  return rows
}

const isBlank = (text: string) => text.trim() === ""

/** 一行算不算「看得见的一句」（空白行、换行不算句数） */
export function rowHasText(row: DiffRow) {
  return row.kind === "mod" ? true : !isBlank(row.text)
}

/** 数一数：几处改动，删 / 加 / 改各几句（几步） */
function countRows(rows: DiffRow[]): DiffCounts {
  const counts: DiffCounts = { hunks: 0, del: 0, add: 0, mod: 0 }
  let inHunk = false
  for (const row of rows) {
    if (row.kind === "same") {
      inHunk = false
      continue
    }
    if (!inHunk) counts.hunks++
    inHunk = true
    if (rowHasText(row)) counts[row.kind]++
  }
  return counts
}

/** 两段文字对比：按句对齐，改过的句子里按词标出来。只隔一个换行的没改的行去掉（每句本来就单独一行显示） */
export function diffText(before: string, after: string): DiffResult {
  const left = splitSentences(before)
  const right = splitSentences(after)
  const fine = left.length <= HUGE && right.length <= HUGE
  const rows = diffUnits(left, right, fine, false).filter((row) => !(row.kind === "same" && row.text === "\n"))
  return { rows, counts: countRows(rows) }
}

/** 任务步骤对比：整条比，配对后标上改前 / 改后的第几步 */
export function diffSteps(before: string[], after: string[]): DiffResult {
  const rows = diffUnits(before, after, true, true)
  let beforeNo = 0
  let afterNo = 0
  for (const row of rows) {
    if (row.kind !== "add") row.beforeNo = ++beforeNo
    if (row.kind !== "del") row.afterNo = ++afterNo
  }
  return { rows, counts: countRows(rows) }
}

/**
 * 没改的一长串收起来：每处改动前后各留 context 行，再多出 2 行以上的收成一个 fold（只多 1 行就不收了，收起来也不省地方）
 */
export function foldRows(rows: DiffRow[], context = 1): FoldedRow[] {
  const out: FoldedRow[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i]!.kind !== "same") {
      out.push(rows[i]!)
      i++
      continue
    }
    let j = i
    while (j < rows.length && rows[j]!.kind === "same") j++
    const run = rows.slice(i, j)
    const keepHead = i > 0 ? context : 0
    const keepTail = j < rows.length ? context : 0
    if (run.length - keepHead - keepTail >= 2) {
      out.push(...run.slice(0, keepHead), { kind: "fold", rows: run.slice(keepHead, run.length - keepTail) }, ...run.slice(run.length - keepTail))
    } else out.push(...run)
    i = j
  }
  return out
}
