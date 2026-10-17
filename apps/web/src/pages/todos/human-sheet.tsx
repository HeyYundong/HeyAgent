// 「要人办的事」的详情（复用 v2「待我处理」的内容和操作）：审批 / 验收 / 登录 / 记忆审核 / 技能修改。
// 段落文字在接口返回的 item.detail（原型的 humanDetails），这里按同一个格式渲染，并补上「处理完之后」：挂起的 session 会继续。
import * as React from "react"
import { BanknoteIcon, CheckIcon, EyeIcon, TriangleAlertIcon, XIcon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription } from "@/components/ui/alert-dialog"
import { AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlockLine } from "@/components/ui/code-block"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { href } from "@/lib/router"
import { findById, fmtShort, humanItemKindLabel, type HumanItem, type SessionRun } from "@heyagent/shared"

import { useRulesQuery, useStaffName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

import { Block, DetailSheet, Said, TextLink, dots } from "./sheets"

// canAct：主管，或者分给自己的事；否则只读（没有操作按钮，顶部写分给了谁）
// onDone：真正提交的那一下（批准、拒绝、确认付款……）。记忆审核、技能修改在这里直接调配置接口（M1 P2）；
// 审批、验收、登录要继续 session，由 P3 接引擎，现在页面传进来的是统一的只读提示
type Props = { item: HumanItem; runs: SessionRun[]; open: boolean; userId: string; canAct: boolean; onClose: () => void; onDone: () => void }

export function HumanSheet({ item, runs, open, userId, canAct, onClose, onDone }: Props) {
  const staffName = useStaffName()
  const rules = useRulesQuery().data ?? []
  const detail = item.detail
  const run = findById(runs, item.runId)
  const rule = findById(rules, item.ruleId)
  const closeAfter = { onSuccess: () => onClose() }
  const approveMemory = useAction(trpc.memories.approve.mutationOptions(closeAfter), { success: detail.done?.[0] ?? "已通过" })
  const rejectMemory = useAction(trpc.memories.reject.mutationOptions(closeAfter), { success: "已拒绝" })
  const acceptSkill = useAction(trpc.skills.acceptSuggestion.mutationOptions(closeAfter), { success: detail.done?.[0] ?? "已合并" })
  const rejectSkill = useAction(trpc.skills.rejectSuggestion.mutationOptions(closeAfter), { success: "已拒绝" })
  // 记忆审核、技能修改：直接调配置接口；其余的事要继续 session，P3 接
  const done = () => {
    if (item.kind === "memory" && item.memoryId) approveMemory.mutate({ id: item.memoryId })
    else if (item.kind === "skill" && item.skillId) acceptSkill.mutate({ id: item.skillId })
    else onDone()
  }
  const reject = (reason: string) => {
    if (item.kind === "memory" && item.memoryId) rejectMemory.mutate({ id: item.memoryId, reason: reason || undefined })
    else if (item.kind === "skill" && item.skillId) rejectSkill.mutate({ id: item.skillId, reason: reason || undefined })
    else onDone()
  }
  const primary = detail.link ? <Button nativeButton={false} render={<a href={href(detail.link.page, { id: detail.link.id })} />}>{detail.primary}</Button>
    : detail.pay ? <PayButton label={detail.primary} confirm={detail.pay} onConfirm={done} />
      : <Button onClick={done}><CheckIcon data-icon="inline-start" />{detail.primary}</Button>
  const secondary = detail.secondaryDone ? <Button variant="outline" onClick={done}>{detail.secondary}</Button>
    : <RejectButton hint={detail.rejectHint ?? ""} onReject={reject} />

  return (
    <DetailSheet
      open={open} onClose={onClose} title={item.title}
      badges={<><Badge variant="outline">{humanItemKindLabel[item.kind]}</Badge>{detail.pay && <Badge variant="destructive"><BanknoteIcon data-icon="inline-start" />涉及金钱</Badge>}</>}
      meta={dots(
        item.taskId && <TextLink to={href("tasks", { id: item.taskId })}>{item.taskId}</TextLink>,
        rule ? <>规则「<TextLink to={href("rules", { id: rule.id })}>{rule.name}</TextLink>」拦下</> : item.summary,
        fmtShort(item.createdAt),
        `分给 ${item.assigneeId === userId ? "你" : staffName(item.assigneeId)}`,
      )}
      footer={canAct && <>{primary}{secondary}</>}
    >
      {!canAct && <Alert><EyeIcon /><AlertDescription>这件事分给了 {staffName(item.assigneeId)}，你只能查看。</AlertDescription></Alert>}
      {detail.warn && (
        <Alert variant="destructive"><TriangleAlertIcon /><AlertTitle>{detail.warn[0]}</AlertTitle><AlertDescription>{detail.warn[1]}</AlertDescription></Alert>
      )}
      {detail.sections.map(({ title, text, block, diff }) => (
        <DetailSection key={title} title={title}>
          {text && <p className={block || diff ? "mb-2" : undefined}>{text}</p>}
          {block && <Block title={block.title}>{block.text}</Block>}
          {diff && <Block title="操作手册的改动">{diff.map((line, index) => <CodeBlockLine key={index} variant={line.variant}>{line.text}</CodeBlockLine>)}</Block>}
        </DetailSection>
      ))}
      {item.kind === "verify" && run?.verification && <DetailSection title="三方 AI 和执行 agent 的对话">
        {run.verification.notes.map((note, index) => <Said key={index} {...note} />)}
      </DetailSection>}
      {run?.waiting && (item.kind === "approval" || item.kind === "login") && (
        <DetailSection title="处理完之后" description="不会新开 session">
          <p className="mb-2">{run.id} 已挂起，在等：{run.waiting.what}。处理完，系统就继续这个 session，agent 接着往下做。</p>
          <TextLink to={href("todos", { id: run.id })}>看这次运行 →</TextLink>
        </DetailSection>
      )}
    </DetailSheet>
  )
}

/** 「拒绝」：弹窗填原因（可不填），agent 会照着调整 */
function RejectButton({ hint, onReject }: { hint: string; onReject: (reason: string) => void }) {
  // 原因随拒绝一起提交（记忆审核、技能修改已经接通）
  const [reason, setReason] = React.useState("")
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" />}><XIcon data-icon="inline-start" />拒绝</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>拒绝这件事</DialogTitle><DialogDescription>{hint}</DialogDescription></DialogHeader>
        <Field>
          <FieldLabel htmlFor="reject-reason">原因</FieldLabel><Textarea id="reject-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
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
