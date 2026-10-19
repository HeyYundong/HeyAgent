// 改动确认卡：助手这一轮要做的改动，一项一行（改前 → 改后），人点「应用」才做，点「不要」可以顺便说为什么。
// 有删除 / 归档 / 驳回的，「应用」是 destructive，写明「会删除 N 项」。卡本身就是确认，不再弹 AlertDialog（docs/dev/copilot.md 9.4）。
import * as React from "react"
import { ArrowUpRightIcon, CircleAlertIcon, CircleCheckIcon, SendIcon, Trash2Icon, XIcon } from "lucide-react"
import type { AssistantChange, AssistantProposal } from "@heyagent/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"

import { href, type PageId } from "@/lib/router"

const STATUS_TEXT: Record<AssistantProposal["status"], string> = {
  pending: "等你确认",
  applied: "已应用",
  rejected: "没要",
  expired: "已过期",
}

/** 超过这么长的值先只显示开头，点「展开」看全部 */
const LONG_VALUE = 160

interface ProposalCardProps {
  proposal: AssistantProposal
  /** 有请求正在进行（发消息或应用），按钮先不能点 */
  busy: boolean
  /** 正在应用 / 不要的就是这张 */
  deciding: boolean
  onDecide: (accept: boolean, note?: string) => void
  /** 点了「去看看」（窄屏时顺手收起面板） */
  onNavigate?: () => void
}

export function ProposalCard({ proposal, busy, deciding, onDecide, onNavigate }: ProposalCardProps) {
  const [rejecting, setRejecting] = React.useState(false)
  const [note, setNote] = React.useState("")
  /** 点的是哪个：转圈显示在那个按钮上 */
  const [chosen, setChosen] = React.useState<"accept" | "reject" | null>(null)
  const pending = proposal.status === "pending"
  const destructive = proposal.changes.filter((change) => change.destructive).length

  const accept = () => {
    setChosen("accept")
    onDecide(true)
  }
  const reject = () => {
    setChosen("reject")
    onDecide(false, note)
    setRejecting(false)
    setNote("")
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{pending ? `要做 ${proposal.changes.length} 项改动` : `${proposal.changes.length} 项改动`}</CardTitle>
        {!pending && (
          <CardAction>
            <Badge variant="outline">{STATUS_TEXT[proposal.status]}</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <ItemGroup>
          {proposal.changes.map((change) => (
            <ChangeItem key={change.callId} change={change} onNavigate={onNavigate} />
          ))}
        </ItemGroup>
      </CardContent>
      {pending && (
        <CardFooter className="flex-col items-stretch gap-2">
          {rejecting ? (
            <InputGroup>
              <InputGroupTextarea
                autoFocus
                rows={2}
                maxLength={2000}
                value={note}
                placeholder="为什么不要、要怎么改（可以不写）"
                aria-label="为什么不要"
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setRejecting(false)
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                    event.preventDefault()
                    if (!busy) reject()
                  }
                }}
              />
              <InputGroupAddon align="block-end">
                <InputGroupButton variant="ghost" onClick={() => setRejecting(false)}>
                  <XIcon data-icon="inline-start" />
                  取消
                </InputGroupButton>
                <InputGroupButton variant="outline" className="ml-auto" disabled={busy} onClick={reject}>
                  <SendIcon data-icon="inline-start" />
                  不要了
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant={destructive ? "destructive" : "default"} size="sm" disabled={busy} onClick={accept}>
                {deciding && chosen === "accept" ? <Spinner data-icon="inline-start" /> : <CircleCheckIcon data-icon="inline-start" />}
                {destructive ? `应用（会删除 ${destructive} 项）` : "应用"}
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setRejecting(true)}>
                {deciding && chosen === "reject" && <Spinner data-icon="inline-start" />}
                不要
              </Button>
            </div>
          )}
        </CardFooter>
      )}
    </Card>
  )
}

function ChangeItem({ change, onNavigate }: { change: AssistantChange; onNavigate?: () => void }) {
  const result = change.result
  return (
    <Item variant="outline" size="xs" role="listitem">
      {(result || change.destructive) && (
        <ItemMedia variant="icon">
          {result ? result.ok ? <CircleCheckIcon /> : <CircleAlertIcon className="text-destructive" /> : <Trash2Icon className="text-destructive" />}
        </ItemMedia>
      )}
      <ItemContent className="min-w-0">
        <ItemTitle>{change.title}</ItemTitle>
        {change.fields.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {change.fields.map((field, index) => (
              <li key={index} className="wrap-break-word">
                <span>{field.label}：</span>
                {field.before !== undefined && <FieldValue value={field.before} crossed={field.after !== undefined} />}
                {field.before !== undefined && field.after !== undefined && <span> → </span>}
                {field.after !== undefined && <FieldValue value={field.after} />}
              </li>
            ))}
          </ul>
        )}
        {result && (
          <div className="flex flex-wrap items-center gap-x-2">
            <p className={result.ok ? "text-muted-foreground" : "wrap-break-word text-destructive"}>{result.message}</p>
            {result.link && (
              <Button variant="link" size="xs" nativeButton={false} render={<a href={href(result.link.page as PageId, result.link.params)} onClick={onNavigate} />}>
                去看看
                <ArrowUpRightIcon data-icon="inline-end" />
              </Button>
            )}
          </div>
        )}
      </ItemContent>
    </Item>
  )
}

/** 一个字段的值：改前的划掉；太长的先收起来 */
function FieldValue({ value, crossed = false }: { value: string; crossed?: boolean }) {
  const [open, setOpen] = React.useState(false)
  const long = value.length > LONG_VALUE
  const text = long && !open ? `${value.slice(0, LONG_VALUE)}…` : value
  return (
    <>
      <span className={crossed ? "text-muted-foreground line-through" : "whitespace-pre-wrap text-foreground"}>{text || "（空）"}</span>
      {long && (
        <Button variant="link" size="xs" onClick={() => setOpen(!open)}>
          {open ? "收起" : "展开"}
        </Button>
      )}
    </>
  )
}
