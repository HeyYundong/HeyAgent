// 一件「要人办的事」的处理面板（原来「待办」页的 HumanSheet）：审批 / 验收争议 / 登录 / 记忆审核 / 技能修改。
// 两处用：运行详情顶上（这次运行没处理的事，每件一张，在哪看到就在哪处理）；会话页「等人处理」里不属于运行的事（记忆审核、技能修改）点开的抽屉。
// 段落文字在接口返回的 item.detail（原型的 humanDetails），这里按同一个格式渲染。
// 能不能处理：can(user, "humanItem.resolve")——主管，或者分给自己的事；否则只读（没有操作按钮，写分给了谁）。
// 记忆审核、技能修改直接调配置接口（M1 P2）；审批、验收、登录、花费到了上限要不要继续，调 engine.resolveHumanItem（M1 P3）：
// how = approve（批准）/ reject（拒绝）/ done（已处理，用于登录这类「去做了」的事），加备注；处理完关联的 session 继续。
// M2：遇到验证码 / 登录页的「登录」类事带 detail.browser：多一段「远程画面」（截图 + 去浏览器里处理），主按钮是「已处理好了」
// 桌面：agent 请人在桌面上处理的事带 detail.desktop：同样多一段「远程画面」（截图 + 打开桌面），主按钮是「已处理好了」
// M3：「审批工具调用」带 detail.toolCall：显示工具名和参数，只有「批准」「拒绝」，可以加备注；
//     「验收争议」带 detail.verification：显示验收报告（逐条结论），三种处理「算通过」「算失败」「补充说明后继续」（engine.resolveVerifyDispute，说明必填）；
//     记忆审核、技能修改：可以直接批，也可以按 memoryId / skillId 去记忆页、技能页看全文再审。
import * as React from "react"
import { BanknoteIcon, CheckIcon, EyeIcon, MessageSquareReplyIcon, TriangleAlertIcon, XIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription } from "@/components/ui/alert-dialog"
import { AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { CodeBlockLine } from "@/components/ui/code-block"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { href } from "@/lib/router"
import { can, findById, fmtShort, humanItemKindLabel, riskLabel, type HumanItem, type HumanItemKind } from "@heyagent/shared"

import { useModels, useRulesQuery, useSessionsQuery, useStaffName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"
import { VerificationReport } from "@/pages/tasks/verification"

import { HumanBrowserSection } from "./human-browser"
import { HumanDesktopSection } from "./human-desktop"
import { Block, Part, TextLink, dots } from "./parts"

/** 会话页上写的种类：验收这类到了人这里的都是「验收争议」 */
export const HUMAN_KIND_LABEL: Record<HumanItemKind, string> = { ...humanItemKindLabel, verify: "验收争议" }

// inRun：放在运行详情里（任务、运行不用再写；验收报告在下面「验收」里，不重复）；onDone：处理完（抽屉里用来关抽屉）
type Props = { item: HumanItem; inRun?: boolean; onDone?: () => void }

export function HumanItemPanel({ item, inRun = false, onDone }: Props) {
  const { user } = useMe()
  const staffName = useStaffName()
  const { modelName } = useModels()
  const rules = useRulesQuery().data ?? []
  const runs = useSessionsQuery().data ?? []
  const canAct = can(user, "humanItem.resolve", { assigneeId: item.assigneeId })
  const detail = item.detail
  const run = findById(runs, item.runId)
  const rule = findById(rules, item.ruleId)
  const after = { onSuccess: () => onDone?.() }
  const approveMemory = useAction(trpc.memories.approve.mutationOptions(after), { success: detail.done?.[0] ?? "已通过" })
  const rejectMemory = useAction(trpc.memories.reject.mutationOptions(after), { success: "已拒绝" })
  const acceptSkill = useAction(trpc.skills.acceptSuggestion.mutationOptions(after), { success: detail.done?.[0] ?? "已合并" })
  const rejectSkill = useAction(trpc.skills.rejectSuggestion.mutationOptions(after), { success: "已拒绝" })
  const engineItem = item.kind !== "memory" && item.kind !== "skill"
  const dispute = item.kind === "verify" ? (detail.verification ?? run?.verification) : undefined
  const [note, setNote] = React.useState("")
  const resolve = useAction(trpc.engine.resolveHumanItem.mutationOptions(after), {
    success: (result, vars) =>
      result.resumedSessionId
        ? `${vars.how === "reject" ? "已拒绝" : vars.how === "approve" ? "已批准" : "已处理"}，${result.resumedSessionId} 继续执行`
        : result.endedSessionId
          ? `已拒绝，${result.endedSessionId} 结束`
          : "已处理",
    errorTitle: "没处理成功",
  })
  // 主按钮：登录这类「请人去做」的是已处理，其余是批准；「次按钮也算完成」的（secondaryDone）按已处理
  const done = (how: "approve" | "done" = item.kind === "login" ? "done" : "approve") => {
    if (item.kind === "memory" && item.memoryId) approveMemory.mutate({ id: item.memoryId })
    else if (item.kind === "skill" && item.skillId) acceptSkill.mutate({ id: item.skillId })
    else resolve.mutate({ itemId: item.id, how, note: note.trim() || undefined })
  }
  const reject = (reason: string) => {
    if (item.kind === "memory" && item.memoryId) rejectMemory.mutate({ id: item.memoryId, reason: reason || undefined })
    else if (item.kind === "skill" && item.skillId) rejectSkill.mutate({ id: item.skillId, reason: reason || undefined })
    else resolve.mutate({ itemId: item.id, how: "reject", note: reason || note.trim() || undefined })
  }
  const busy = resolve.isPending || approveMemory.isPending || rejectMemory.isPending || acceptSkill.isPending || rejectSkill.isPending
  const doneButton = <Button disabled={busy} onClick={() => done()}>{busy ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}{detail.primary}</Button>
  // 带浏览器、桌面信息的：在这里（或远程画面里）直接点「已处理好了」；没有的（旧数据）主按钮仍是去浏览器页 / 桌面页的链接
  const primary = detail.browser || detail.desktop ? doneButton : detail.link ? <Button nativeButton={false} render={<a href={href(detail.link.page, { id: detail.link.id })} />}>{detail.primary}</Button>
    : detail.pay ? <PayButton label={detail.primary} confirm={detail.pay} onConfirm={() => done()} />
      : doneButton
  const secondary = detail.secondaryDone ? <Button variant="outline" disabled={busy} onClick={() => done("done")}>{detail.secondary}</Button>
    : <RejectButton id={item.id} label={engineItem ? detail.secondary : "拒绝"} hint={detail.toolCall ? "不执行这次调用，把「被拒绝：你的理由」作为工具结果交给 agent，它接着往下做。" : (detail.rejectHint ?? (engineItem ? "agent 会看到你的原因，照着调整。" : ""))} defaultReason={note.trim()} disabled={busy} onReject={reject} />
  // 结构化显示了的内容，后端拼好的同名文字段就不重复显示
  const hidden = new Set([...(detail.toolCall ? ["工具", "参数"] : []), ...(dispute ? ["每条检查点的结论", "验收过程"] : [])])
  // 运行详情里验收报告在下面「验收」区块，这里不重复（运行上没有验收记录时还是显示争议附的报告）
  const showReport = dispute && !(inRun && run?.verification)

  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">等人处理 · {HUMAN_KIND_LABEL[item.kind]}</Badge>
          {detail.pay && <Badge variant="destructive"><BanknoteIcon data-icon="inline-start" />涉及金钱</Badge>}
        </div>
        <CardTitle>{item.title}</CardTitle>
        <CardDescription>
          {dots(
            !inRun && item.taskId && <TextLink to={href("tasks", { id: item.taskId })}>{item.taskId}</TextLink>,
            rule ? <>规则「<TextLink to={href("rules", { id: rule.id })}>{rule.name}</TextLink>」{item.kind === "verify" ? "要求验收" : "拦下"}</> : item.summary,
            `提出 ${fmtShort(item.createdAt)}`,
            `分给 ${item.assigneeId === user.id ? "你" : staffName(item.assigneeId)}`,
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {!canAct && <Alert><EyeIcon /><AlertDescription>这件事分给了 {staffName(item.assigneeId)}，你只能查看。</AlertDescription></Alert>}
        {detail.warn && (
          <Alert variant="destructive"><TriangleAlertIcon /><AlertTitle>{detail.warn[0]}</AlertTitle><AlertDescription>{detail.warn[1]}</AlertDescription></Alert>
        )}
        {detail.toolCall && <ToolCallPart call={detail.toolCall} />}
        {showReport && (
          <Part title="验收报告" description={`三方 AI（${modelName(dispute.modelId)}）逐条核对的结论${dispute.round ? `，第 ${dispute.round} 轮` : ""}。算通过：运行完成；算失败：运行标失败；补充说明后继续：带着说明回到同一个 session 接着做。`}>
            <VerificationReport verification={dispute} />
          </Part>
        )}
        {dispute && !showReport && <p className="text-muted-foreground">三方 AI 逐条核对的结论在下面「验收」里。算通过：运行完成；算失败：运行标失败；补充说明后继续：带着说明回到同一个 session 接着做。</p>}
        {detail.sections.filter((section) => !hidden.has(section.title)).map(({ title, text, block, diff }) => (
          <Part key={title} title={title}>
            {text && <p>{text}</p>}
            {block && <Block title={block.title}>{block.text}</Block>}
            {diff && <Block title="操作手册的改动">{diff.map((line, index) => <CodeBlockLine key={index} variant={line.variant}>{line.text}</CodeBlockLine>)}</Block>}
          </Part>
        ))}
        {detail.browser && <HumanBrowserSection item={item} info={detail.browser} canAct={canAct} onResolved={() => onDone?.()} />}
        {detail.desktop && <HumanDesktopSection item={item} info={detail.desktop} canAct={canAct} onResolved={() => onDone?.()} />}
        {(item.memoryId || item.skillId) && <ReviewLink item={item} />}
        {run?.waiting && (item.kind === "approval" || item.kind === "login") && (
          <Part title="处理完之后" description="不会新开 session">
            <p>{run.id} 已挂起，在等：{run.waiting.what}。处理完，系统就继续这个 session，agent 接着往下做。</p>
          </Part>
        )}
        {canAct && engineItem && (
          <Field>
            <FieldLabel htmlFor={`human-note-${item.id}`}>{dispute ? "备注 / 说明" : "备注"}</FieldLabel>
            <Textarea id={`human-note-${item.id}`} rows={2} placeholder={dispute ? "例如：第 2 条你已经发过了，补一份发送记录就行" : "例如：可以，但数量减半"} value={note} onChange={(event) => setNote(event.target.value)} />
            <FieldDescription>{dispute ? "算通过、算失败时作为备注记下；「补充说明后继续」时必须写，agent 会照着做。" : "可以不填。写了的话，agent 继续时会看到。"}</FieldDescription>
          </Field>
        )}
      </CardContent>
      {canAct && <CardFooter className="flex-wrap gap-2">{dispute ? <DisputeButtons item={item} note={note} onDone={() => onDone?.()} /> : <>{primary}{secondary}</>}</CardFooter>}
    </Card>
  )
}

/** 「拒绝」：弹窗填原因（可不填），agent 会照着调整 */
function RejectButton({ id, label, hint, defaultReason, disabled, onReject }: { id: string; label: string; hint: string; defaultReason: string; disabled?: boolean; onReject: (reason: string) => void }) {
  // 原因随拒绝一起提交；打开时带上上面备注里已经写的
  const [reason, setReason] = React.useState("")
  return (
    <Dialog onOpenChange={(open) => open && setReason(defaultReason)}>
      <DialogTrigger render={<Button variant="outline" disabled={disabled} />}><XIcon data-icon="inline-start" />{label}</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{label}</DialogTitle><DialogDescription>{hint}</DialogDescription></DialogHeader>
        <Field>
          <FieldLabel htmlFor={`reject-reason-${id}`}>原因</FieldLabel><Textarea id={`reject-reason-${id}`} value={reason} onChange={(event) => setReason(event.target.value)} />
          <FieldDescription>可以不填。写了的话，agent 会照着调整。</FieldDescription>
        </Field>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>取消</DialogClose><DialogClose render={<Button variant="destructive" />} onClick={() => onReject(reason.trim())}>确认拒绝</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 涉及金钱的主按钮：先用 AlertDialog 二次确认，付款不能撤回 */
function PayButton({ label, confirm, onConfirm }: { label: string; confirm: [string, string]; onConfirm: () => void }) {
  const [open, setOpen] = React.useState(false)
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button />}><BanknoteIcon data-icon="inline-start" />{label}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{confirm[0]}</AlertDialogTitle><AlertDialogDescription>{confirm[1]}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>再想想</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { setOpen(false); onConfirm() }}>确认付款</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** 「审批工具调用」：agent 要调哪个工具、传什么参数（密钥类字段已经换成 ••••），哪条规则拦下的 */
function ToolCallPart({ call }: { call: NonNullable<HumanItem["detail"]["toolCall"]> }) {
  return (
    <Part title="要调用的工具" description="agent 已经决定调用，被规则拦下等你批准，还没执行。批准就照这些参数执行，拒绝就把理由告诉 agent。">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <a href={href("tools", { id: call.toolId })} className="text-base font-medium underline-offset-4 hover:underline">{call.toolName}</a>
          <span className="font-mono text-xs text-muted-foreground">{call.toolId}</span>
          {call.risk && call.risk in riskLabel && <Badge variant={call.risk === "money" ? "destructive" : "outline"}>{riskLabel[call.risk as keyof typeof riskLabel]}</Badge>}
        </div>
        <Block title="参数">{call.input}</Block>
        <p className="text-xs text-muted-foreground">
          规则「<TextLink to={href("rules", { id: call.ruleId })}>{call.ruleName}</TextLink>」要求调用前审批。像密钥的字段已经换成 ••••，执行时用的是真实的值。
        </p>
      </div>
    </Part>
  )
}

/** 记忆审核、技能修改：去对应页面看全文、上下文再审（那边也能批） */
function ReviewLink({ item }: { item: HumanItem }) {
  const to = item.memoryId ? href("memory", { id: item.memoryId }) : href("skills", { id: item.skillId })
  return (
    <Part title={item.memoryId ? "在记忆页审核" : "在技能页审核"} description={item.memoryId ? "记忆页能看到这条记忆的全文、来源和证据，审核按钮也在那里。" : "技能页能看到操作手册全文和这次的修改建议，审核按钮也在那里。"}>
      <p><TextLink to={to}>{item.memoryId ? `去记忆页看 ${item.memoryId} →` : `去技能页看 ${item.skillId} →`}</TextLink></p>
    </Part>
  )
}

/** 「验收争议」的三种处理：算通过 / 算失败（二次确认）/ 补充说明后继续（说明必填） */
function DisputeButtons({ item, note, onDone }: { item: HumanItem; note: string; onDone: () => void }) {
  const [failing, setFailing] = React.useState(false)
  const [explaining, setExplaining] = React.useState(false)
  const [text, setText] = React.useState("")
  const [error, setError] = React.useState<string>()
  const resolve = useAction(trpc.engine.resolveVerifyDispute.mutationOptions({ onSuccess: () => onDone() }), {
    success: (result, vars) =>
      vars.how === "continue" ? `已补充说明，${result.resumedSessionId ?? "运行"} 继续执行` : vars.how === "pass" ? `已判定算通过，${result.endedSessionId ?? "运行"} 完成` : `已判定算失败，${result.endedSessionId ?? "运行"} 结束`,
    errorTitle: "没处理成功",
  })
  const busy = resolve.isPending
  const remark = note.trim() || undefined
  const explain = () => {
    if (!text.trim()) {
      setError("写上说明：哪里要补、怎么补，agent 会照着做")
      return
    }
    setExplaining(false)
    resolve.mutate({ itemId: item.id, how: "continue", note: text.trim() })
  }
  return (
    <>
      <Button disabled={busy} onClick={() => resolve.mutate({ itemId: item.id, how: "pass", note: remark })}>
        {busy ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}算通过
      </Button>
      <Button variant="outline" disabled={busy} onClick={() => { setText(note.trim()); setError(undefined); setExplaining(true) }}>
        <MessageSquareReplyIcon data-icon="inline-start" />补充说明后继续
      </Button>
      <Button variant="outline" disabled={busy} onClick={() => setFailing(true)}>
        <XIcon data-icon="inline-start" />算失败
      </Button>
      <AlertDialog open={failing} onOpenChange={setFailing}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>判定这次运行算失败？</AlertDialogTitle>
            <AlertDialogDescription>运行会标成「失败」并结束，不能再继续。{remark ? `备注「${remark}」会记在运行里。` : "可以先在上面的备注里写上原因。"}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>再想想</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => { setFailing(false); resolve.mutate({ itemId: item.id, how: "fail", note: remark }) }}>算失败</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={explaining} onOpenChange={setExplaining}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>补充说明后继续</DialogTitle>
            <DialogDescription>带着你的说明回到同一个 session 接着做；agent 再说做完了，会重新验收。</DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor={`dispute-explain-${item.id}`}>说明</FieldLabel>
            <Textarea id={`dispute-explain-${item.id}`} rows={4} aria-invalid={!!error} value={text} onChange={(event) => { setText(event.target.value); setError(undefined) }} placeholder="例如：第 2 条你已经发过了，补一份发送记录就行" />
            <FieldDescription>必填。写清楚哪里要补、怎么补。</FieldDescription>
            <FieldError>{error}</FieldError>
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
            <Button onClick={explain}>继续</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
