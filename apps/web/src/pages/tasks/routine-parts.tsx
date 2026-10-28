// 固化流程（docs/dev/solidify.md 第 9 节）几处共用的小块：状态徽章、一版脚本的内容（步骤说明、输入和交回、会改东西的步骤、假设、脚本、和旧版的对比）、试跑报告。
// 任务详情「固化流程」的「看脚本」弹窗、版本记录，和「等人处理」里的「审核固化流程」都用这里的组件，内容来自 routine.version。
// 全部是 registry 组件的组合：Badge、Trace、CodeBlock（经 components/files 的 CodeView）、Table、Collapsible、Item；截图用已登记的 FileList。
// 第三期（19.8）：固化员建议建的 HTTP 工具（HttpSuggestions）放在「假设」后面，审核卡和「看脚本」弹窗都经 RoutineVersionView 显示。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { diffLines } from "diff"
import { BotIcon, ChevronDownIcon, ChevronRightIcon, CircleCheckIcon, CirclePauseIcon, CircleStopIcon, CircleXIcon, FlaskConicalIcon, GitCompareIcon, HourglassIcon, WorkflowIcon } from "lucide-react"
import {
  routineStatusLabel,
  routineStopKindLabel,
  routineVersionId,
  routineVersionStatusLabel,
  type HttpToolSuggestion,
  type RoutineStatus,
  type RoutineStop,
  type RoutineTestRound,
  type RoutineVersion,
  type RoutineVersionStatus,
  type SessionRoutineState,
} from "@heyagent/shared"

import { CodeView, FileList } from "@/components/files"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "@/components/ui/code-block"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Item, ItemContent, ItemDescription, ItemFooter, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { useSessionQuery } from "@/lib/data"
import { href } from "@/lib/router"
import { trpc } from "@/lib/trpc"
import { Part, TextLink } from "@/pages/sessions/parts"

import { StepList } from "./parts"

// ---------- 徽章和文字 ----------

/** 固化流程的状态：试用 / 正式 / 停用（停用不是出错，不用红色；自动停用的原因另外写） */
export function RoutineStatusBadge({ status }: { status: RoutineStatus }) {
  if (status === "trial") return <Badge variant="secondary"><FlaskConicalIcon data-icon="inline-start" />{routineStatusLabel.trial}</Badge>
  if (status === "active") return <Badge variant="outline"><CircleCheckIcon data-icon="inline-start" />{routineStatusLabel.active}</Badge>
  return <Badge variant="outline"><CirclePauseIcon data-icon="inline-start" />{routineStatusLabel.paused}</Badge>
}

/** 一版的状态：写脚本中 / 试跑中（转圈）、待审核、没成功、启用过、不用；current = 正在用的那一版 */
export function VersionStatusBadge({ status, current = false }: { status: RoutineVersionStatus; current?: boolean }) {
  if (current) return <Badge variant="outline"><WorkflowIcon data-icon="inline-start" />正在用</Badge>
  if (status === "drafting" || status === "testing") return <Badge variant="secondary"><Spinner data-icon="inline-start" />{routineVersionStatusLabel[status]}</Badge>
  if (status === "review") return <Badge><HourglassIcon data-icon="inline-start" />{routineVersionStatusLabel.review}</Badge>
  if (status === "failed") return <Badge variant="destructive"><CircleXIcon data-icon="inline-start" />{routineVersionStatusLabel.failed}</Badge>
  if (status === "approved") return <Badge variant="outline"><CircleCheckIcon data-icon="inline-start" />{routineVersionStatusLabel.approved}</Badge>
  return <Badge variant="ghost">{routineVersionStatusLabel.rejected}</Badge>
}

/** 运行办成后系统自动固化的那一版（docs/dev/solidify.md 17.1）；人点「固化成流程」的不加 */
export function AutoBadge() {
  return <Badge variant="outline"><BotIcon data-icon="inline-start" />自动固化</Badge>
}

/** 「300 毫秒」「1.2 秒」「18 秒」「3.5 分钟」 */
export function durationText(ms: number) {
  if (ms < 1000) return `${ms} 毫秒`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} 秒`
  if (ms < 120_000) return `${Math.round(ms / 1000)} 秒`
  return `${(ms / 60_000).toFixed(1)} 分钟`
}

/** 接着跑时才有的几种停下（第 17.2 节）：原因前面带上种类的中文名，看得出是接着跑出的事 */
const RESUME_STOPS = new Set<RoutineStop["kind"]>(["replay_mismatch", "resume_lost", "rejected"])

/** 脚本停下的原因：有原因写原因（接着跑的几种带上种类），没有写种类 */
export const stopReasonText = (stop: RoutineStop) =>
  !stop.reason ? routineStopKindLabel[stop.kind] : RESUME_STOPS.has(stop.kind) ? `${routineStopKindLabel[stop.kind]}：${stop.reason}` : stop.reason

/** 固化试跑的运行 id 是 RT-<n>-v<版本>-t<轮>：取第几轮 */
export const testRoundOf = (sessionId: string) => Number(/-t(\d+)$/.exec(sessionId)?.[1] ?? 0) || undefined

/** 运行上的脚本状态写成一句话（运行详情的头部） */
export function routineRunText(state: SessionRoutineState, sessionId: string, ended: boolean): string {
  const stop = state.stoppedAt
  if (state.mode === "test") {
    const round = testRoundOf(sessionId)
    const head = `固化试跑（第 ${state.version} 版${round ? `第 ${round} 轮` : ""}）`
    if (state.state === "running") return `${head}：正在跑第 ${state.steps + 1} 步`
    if (stop?.kind === "test_commit") return `${head}：走了 ${state.steps} 步 · 停在提交前「${stop.label ?? "提交"}」${state.ms !== undefined ? ` · ${durationText(state.ms)}` : ""}`
    if (stop?.kind === "test_blocked") return `${head}：走了 ${state.steps} 步 · 停在对外发送前（${stop.label ?? stop.tool ?? "下一步"}）`
    if (state.state === "finished") return `${head}：脚本跑完了 · ${state.steps} 步，报的结果只记下、不生效`
    return stop ? `${head}：停在第 ${stop.step} 步 · ${routineStopKindLabel[stop.kind]}（${stopReasonText(stop)}）` : `${head}：停下了`
  }
  const head = `固化流程第 ${state.version} 版`
  if (state.state === "running") return `正在按${head}跑：第 ${state.steps + 1} 步`
  if (state.state === "suspended") {
    const step = stop?.step ?? state.steps
    return `${head}停在第 ${step} 步等人处理${stop ? `（${stopReasonText(stop)}）` : ""}${ended ? "" : "，处理完接着跑"}`
  }
  const took = `${state.steps} 步${state.ms !== undefined ? ` · ${durationText(state.ms)}` : ""}`
  // 脚本报了办成、三方验收反问、agent 接着做的（第 17.3 节）：执行模型调过了，不能写「没调执行模型」
  if (state.state === "finished" && state.agentAfter) return `按${head}跑：${took} · 脚本跑完了，验收反问后 agent 接着做`
  if (state.state === "finished") return `按${head}跑：${took} · 没调执行模型`
  if (state.state === "fell_back") {
    const where = !stop ? "停下了" : stop.step === 0 ? `没跑（${stopReasonText(stop)}）` : `停在第 ${stop.step} 步（${stopReasonText(stop)}）`
    return `${head}${where}，${ended ? "agent 接着做完" : "agent 正在接着做"}`
  }
  if (stop?.kind === "input") return `${head}停在第 ${stop.step} 步：输入有问题（${stop.reason}），记没办成`
  if (stop?.kind === "cancelled") return `${head}跑到第 ${stop.step} 步时运行被取消`
  return stop ? `${head}停在第 ${stop.step} 步：${routineStopKindLabel[stop.kind]}${stop.reason ? `（${stop.reason}）` : ""}` : `${head}停下了`
}

/** 停下等人后接着跑过的（第 17.2 节）：「等人处理后接着跑了 2 次（最近一次按记录跳过 5 步）」；没接着跑过是 undefined */
export function routineResumeText(state: SessionRoutineState): string | undefined {
  if (!state.resumes) return undefined
  return `等人处理后接着跑了 ${state.resumes} 次${state.replayed !== undefined ? `（最近一次按记录跳过 ${state.replayed} 步）` : ""}`
}

// ---------- 输入和交回（从 JSON Schema 取字段名、说明） ----------

interface SchemaField {
  name: string
  label: string
  description?: string
  required: boolean
}

/** 脚本输入里系统自带的两项（routineInputOf）：附件和附加说明 */
const BUILTIN_INPUT: Record<string, string> = { $attachments: "附件", $note: "附加说明" }

/** JSON Schema 顶层的字段：名字、说明、必不必填 */
export function schemaFields(schema: Record<string, unknown>): SchemaField[] {
  const properties = schema.properties && typeof schema.properties === "object" ? (schema.properties as Record<string, unknown>) : {}
  const required = Array.isArray(schema.required) ? schema.required.filter((each): each is string => typeof each === "string") : []
  return Object.entries(properties).map(([name, value]) => {
    const spec = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
    return {
      name,
      label: BUILTIN_INPUT[name] ?? name,
      description: typeof spec.description === "string" ? spec.description : undefined,
      required: required.includes(name),
    }
  })
}

function FieldList({ fields, empty }: { fields: SchemaField[]; empty: string }) {
  if (fields.length === 0) return <p className="text-muted-foreground">{empty}</p>
  return (
    <ul className="flex flex-col gap-1">
      {fields.map((field) => (
        <li key={field.name} className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{field.label}</span>
          {!field.required && <span className="text-xs text-muted-foreground">可以不填</span>}
          {field.description && <span className="text-muted-foreground">{field.description}</span>}
        </li>
      ))}
    </ul>
  )
}

/** 要的输入和交回的结果，两列（窄屏上下排） */
export function RoutineIO({ version }: { version: Pick<RoutineVersion, "inputSchema" | "outputSchema"> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">要的输入</span>
        <FieldList fields={schemaFields(version.inputSchema)} empty="不要输入" />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">交回的结果</span>
        <FieldList fields={schemaFields(version.outputSchema)} empty="不交回结果" />
      </div>
    </div>
  )
}

// ---------- 脚本和对比 ----------

export const RoutineScript = ({ code }: { code: string }) => <CodeView code={code} language="javascript" title="routine.mjs" lineNumbers className="max-h-96" />

/** 两段文字按行比：删的一行标「−」、加的一行标「+」，没改的灰着（CodeBlockLine 的 added / removed 变体） */
export function LineDiff({ title, before, after }: { title: string; before: string; after: string }) {
  const parts = React.useMemo(() => diffLines(before, after), [before, after])
  const lines = parts.flatMap((part) =>
    part.value.replace(/\n$/, "").split("\n").map((text) => ({ text, variant: part.added ? "added" as const : part.removed ? "removed" as const : "default" as const }))
  )
  const changed = lines.some((line) => line.variant !== "default")
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader><CodeBlockTitle>{title}</CodeBlockTitle></CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-96">
        {changed ? lines.map((line, index) => (
          <CodeBlockLine key={index} variant={line.variant}>{line.text || " "}</CodeBlockLine>
        )) : <CodeBlockLine>没有改动</CodeBlockLine>}
      </CodeBlockContent>
    </CodeBlock>
  )
}

/** 默认收起的一块：标题是一个小按钮 */
export function Folded({ label, icon, children, defaultOpen = false }: { label: string; icon?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="self-start" />}>
        {open ? <ChevronDownIcon data-icon="inline-start" /> : <ChevronRightIcon data-icon="inline-start" />}
        {icon}
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/** 修的版本：取它改的那一版，步骤说明和脚本各给一份对比（默认收起） */
function BaseDiff({ version }: { version: RoutineVersion }) {
  const baseId = routineVersionId(version.routineId, version.baseVersion ?? 0)
  const base = useQuery(trpc.routine.version.queryOptions({ id: baseId }, { enabled: version.baseVersion !== null }))
  if (version.baseVersion === null) return null
  return (
    <Folded label={`和第 ${version.baseVersion} 版比`} icon={<GitCompareIcon data-icon="inline-start" />}>
      {base.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : base.isError ? (
        <p className="text-muted-foreground">第 {version.baseVersion} 版没取到，对比看不了。</p>
      ) : (
        <>
          <LineDiff title="步骤说明的改动" before={base.data.description} after={version.description} />
          <LineDiff title="脚本的改动" before={base.data.code} after={version.code} />
        </>
      )}
    </Folded>
  )
}

/**
 * 一版脚本的内容。review = 审核卡里用：多一段试跑结果，脚本收起来、带和旧版的对比；
 * 不是 review（「看脚本」弹窗）：脚本直接展开，试跑结果、对比也给，放在后面
 */
export function RoutineVersionView({ version, review = false }: { version: RoutineVersion; review?: boolean }) {
  const steps = version.description.split("\n").map((line) => line.trim()).filter(Boolean)
  const script = version.code ? <RoutineScript code={version.code} /> : <p className="text-muted-foreground">没有脚本。</p>
  return (
    <div className="flex flex-col gap-4">
      <Part title="步骤说明" description="固化员写给人看的步骤，一步一行。脚本照这些步骤做。">
        {steps.length ? <StepList steps={steps} /> : <p className="text-muted-foreground">没写步骤说明。</p>}
      </Part>
      <Part title="要的输入和交回" description="脚本开始时拿到的输入，和办完要交回的结果。被派来的任务：输入就是派活的参数，交回就是声明的结果；附件和附加说明是每次运行自带的。">
        <RoutineIO version={version} />
      </Part>
      {review && <Part title="试跑结果" description="照原来那次运行的输入，在沙箱里真跑一遍脚本：走到第一个会改东西的步骤（提交、保存、发送）前停下，不做那一步。读到的结果和原来那次对一对。"><RoutineTestReportView version={version} /></Part>}
      <Part title="会改东西的步骤" description="脚本在这些步骤前标了「提交」：试跑停在第一个前面；试用期每次做之前截图存证；做过以后再出错，交给 agent 时会写明「可能已经生效」。">
        {version.commits.length ? (
          <div className="flex flex-wrap gap-1.5">{version.commits.map((label) => <Badge key={label} variant="outline">{label}</Badge>)}</div>
        ) : <p className="text-muted-foreground">没有，只读不改。</p>}
      </Part>
      <Part title="假设" description="脚本默认成立的事。和实际不一样时脚本会跑不通，交给 agent 接着做。">
        {version.assumptions.length ? (
          <ul className="flex list-disc flex-col gap-1 pl-5">{version.assumptions.map((text) => <li key={text}>{text}</li>)}</ul>
        ) : <p className="text-muted-foreground">没写假设。</p>}
      </Part>
      <HttpSuggestions suggestions={version.httpToolSuggestions ?? []} />
      <Part title="脚本" description="只能用 heyagent 的 SDK 调这个任务的工具，每一步都经过工具网关：规则、白名单、审批、验证码检测、过程记录和 agent 自己调一样。">
        {review ? <Folded label={`看脚本（${version.code.split("\n").length} 行）`}>{script}</Folded> : script}
        <BaseDiff version={version} />
      </Part>
      {!review && version.testReport && version.testReport.rounds.length > 0 && <Part title="试跑结果"><RoutineTestReportView version={version} /></Part>}
    </div>
  )
}

// ---------- HTTP 工具建议（docs/dev/solidify.md 19.7、19.8） ----------

/**
 * 固化员建议建的 HTTP 工具：每条一个 Item（名字 + 方法、网址模板、理由、要准备的密钥），配置（http 那一段）收在折叠的 CodeBlock 里，自带复制。
 * 只列出来，系统不自动建；没有建议时不显示
 */
export function HttpSuggestions({ suggestions }: { suggestions: HttpToolSuggestion[] }) {
  if (suggestions.length === 0) return null
  return (
    <Part title="HTTP 工具建议" description="这些接口用 token 认证，直接调接口用不了。主管可以在工具页照着建 HTTP 工具，密钥写成 {{名字}}；系统不会自动建。">
      <ItemGroup className="gap-2">
        {suggestions.map((suggestion, index) => (
          <Item key={`${suggestion.name}-${index}`} variant="outline" size="sm">
            <ItemContent className="min-w-0">
              <ItemTitle className="flex-wrap">{suggestion.name}<Badge variant="outline">{suggestion.http.method}</Badge></ItemTitle>
              <ItemDescription className="line-clamp-none">
                <span className="block font-mono break-all">{suggestion.http.url}</span>
                {suggestion.summary && <span className="block">{suggestion.summary}</span>}
                {suggestion.reason && <span className="block">{suggestion.reason}</span>}
              </ItemDescription>
              <span className="text-xs">
                要准备的密钥：{suggestion.secrets.length ? suggestion.secrets.join("、") : "不用"}
                {suggestion.requestSeqs.length > 0 && <span className="text-muted-foreground"> · 依据 network/requests.jsonl 第 {suggestion.requestSeqs.join("、")} 个请求</span>}
              </span>
            </ItemContent>
            <ItemFooter className="flex-col items-stretch">
              <Folded label="看配置">
                <CodeView code={JSON.stringify(suggestion.http, null, 2)} language="json" title="HTTP 工具配置" />
              </Folded>
            </ItemFooter>
          </Item>
        ))}
      </ItemGroup>
    </Part>
  )
}

// ---------- 试跑报告 ----------

/** 最后一轮试跑：一行结论 + 每一步 + 结果对比 + 停下时的截图；前面没过的几轮一句话 */
export function RoutineTestReportView({ version }: { version: RoutineVersion }) {
  const rounds = version.testReport?.rounds ?? []
  if (version.skipTest && rounds.length === 0)
    return <p className="text-muted-foreground">点「固化成流程」时选了不试跑：脚本没真跑过，只过了程序检查。启用后试用期的头几次运行要多看看。</p>
  if (rounds.length === 0) return <p className="text-muted-foreground">{version.status === "drafting" || version.status === "testing" ? "还在写、试跑，好了这里会显示结果。" : "没有试跑记录。"}</p>
  const last = rounds.at(-1)!
  const earlier = rounds.slice(0, -1)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {last.passed
          ? <Badge variant="outline"><CircleCheckIcon data-icon="inline-start" />通过</Badge>
          : <Badge variant="destructive"><CircleXIcon data-icon="inline-start" />没通过</Badge>}
        <span>第 {last.round} 轮 · 走了 {last.steps} 步{last.stoppedAt ? ` · ${roundStopText(last.stoppedAt)}` : ""}</span>
        <TextLink to={href("sessions", { id: last.sessionId })}>看这次试跑 {last.sessionId}</TextLink>
      </div>
      {last.error && <p className="text-destructive">{last.error}</p>}
      <TestRunSteps round={last} />
      {last.compare && last.compare.length > 0 && <CompareTable compare={last.compare} />}
      {last.screenshotFileId && <RoundScreenshot sessionId={last.sessionId} fileId={last.screenshotFileId} />}
      {earlier.length > 0 && (
        <ul className="flex flex-col gap-1 text-muted-foreground">
          {earlier.map((round) => (
            <li key={round.round}>
              第 {round.round} 轮{round.passed ? "通过" : "没过"}：{round.error ?? (round.stoppedAt ? roundStopText(round.stoppedAt) : `走了 ${round.steps} 步`)}{" "}
              <TextLink to={href("sessions", { id: round.sessionId })}>看过程</TextLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const roundStopText = (stop: RoutineStop) =>
  stop.kind === "test_commit" ? `停在提交前「${stop.label ?? "提交"}」` : stop.kind === "test_blocked" ? `停在对外发送前（${stop.label ?? stop.tool ?? "下一步"}）` : `停在第 ${stop.step} 步：${stopReasonText(stop)}`

/** 试跑的每一步：取那次试跑运行的过程，列出脚本做的步骤（trace.routineStep），最后一行写停在哪 */
function TestRunSteps({ round }: { round: RoutineTestRound }) {
  const detail = useSessionQuery(round.sessionId)
  if (detail.isPending) return <div className="flex flex-col gap-2">{Array.from({ length: Math.min(round.steps || 3, 5) }, (_, index) => <Skeleton key={index} className="h-4 w-2/3" />)}</div>
  if (detail.isError) return <p className="text-muted-foreground">试跑的过程没取到，可以点上面的链接去看。</p>
  const steps = detail.data.events.filter((event) => event.trace?.routineStep)
  const stop = round.stoppedAt
  const failedStep = stop && !stop.kind.startsWith("test_") ? stop.step : undefined
  return (
    <Trace className="gap-1.5">
      {steps.map((event) => {
        const failed = event.trace!.routineStep === failedStep
        return (
          <TraceLine key={event.seq} status={failed ? "error" : undefined}>
            <TraceIcon>{failed ? <CircleXIcon /> : <CircleCheckIcon />}</TraceIcon>
            <TraceDescription className="tabular-nums">{event.trace!.routineStep}.</TraceDescription>
            <TraceTitle>{event.title}</TraceTitle>
            {event.ms !== undefined && <TraceDescription className="hidden sm:inline">{durationText(event.ms)}</TraceDescription>}
          </TraceLine>
        )
      })}
      {stop && stop.kind.startsWith("test_") && (
        <TraceLine status="pending">
          <TraceIcon><CircleStopIcon /></TraceIcon>
          <TraceDescription className="tabular-nums">{stop.step}.</TraceDescription>
          <TraceTitle>{stop.label ?? stop.tool ?? "下一步"}：停在这里，没做</TraceTitle>
        </TraceLine>
      )}
      {steps.length === 0 && <p className="text-muted-foreground">这次试跑没有记下脚本的步骤。</p>}
    </Trace>
  )
}

/** 要交回的结果：原来那次运行和试跑一项一项对。不一样不算没通过（比如榜单每天在变），给人看 */
function CompareTable({ compare }: { compare: NonNullable<RoutineTestRound["compare"]> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow><TableHead>结果</TableHead><TableHead>原来那次</TableHead><TableHead>试跑</TableHead><TableHead><span className="sr-only">一样吗</span></TableHead></TableRow>
      </TableHeader>
      <TableBody>
        {compare.map((row) => (
          <TableRow key={row.field}>
            <TableCell className="font-medium">{row.field}</TableCell>
            <TableCell className="max-w-48 truncate" title={row.expected}>{row.expected}</TableCell>
            <TableCell className="max-w-48 truncate" title={row.actual}>{row.actual}</TableCell>
            <TableCell>{row.same ? <Badge variant="outline"><CircleCheckIcon data-icon="inline-start" />一样</Badge> : <Badge variant="secondary">不一样</Badge>}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** 停下时的截图：从那次试跑的空间文件里找（有名字、大小，点了看大图） */
function RoundScreenshot({ sessionId, fileId }: { sessionId: string; fileId: string }) {
  const files = useQuery(trpc.engine.sessionFiles.queryOptions({ sessionId }))
  if (files.isPending) return <Skeleton className="h-24 w-40" />
  const file = files.data?.find((each) => each.id === fileId)
  if (!file) return <p className="text-muted-foreground">停下时截了图，但没取到：<TextLink to={`/api/files/${fileId}`}>直接打开</TextLink></p>
  return <FileList files={[file]} />
}
