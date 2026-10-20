// 三方验收报告（M3）：总结论、每条检查点的结论和理由、负责人怎么处理的、验收问答。
// 运行详情的「验收」卡和「验收争议」的处理面板都用它（数据都是 Verification）。
import { CircleCheckIcon, CircleHelpIcon, CircleXIcon, GavelIcon } from "lucide-react"
import { fmtShort, type Verification, type VerifyVerdict } from "@heyagent/shared"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Message, MessageContent, MessageGroup, MessageHeader } from "@/components/ui/message"

import { useStaffName } from "@/lib/data"

/** 通过 / 不通过 / 存疑：不只靠颜色，图标和文字都不一样 */
const VERDICT: Record<VerifyVerdict, { label: string; icon: typeof CircleCheckIcon; variant: "outline" | "destructive" | "secondary" }> = {
  pass: { label: "通过", icon: CircleCheckIcon, variant: "outline" },
  fail: { label: "不通过", icon: CircleXIcon, variant: "destructive" },
  unsure: { label: "存疑", icon: CircleHelpIcon, variant: "secondary" },
}

export function VerdictBadge({ verdict }: { verdict: VerifyVerdict }) {
  const { label, icon: Icon, variant } = VERDICT[verdict]
  return <Badge variant={variant}><Icon data-icon="inline-start" />{label}</Badge>
}

const RESOLUTION = { pass: "判定算通过", fail: "判定算失败", continue: "补充说明后让 agent 继续" } as const

export function VerificationReport({ verification, showNotes = true }: { verification: Verification; showNotes?: boolean }) {
  const staffName = useStaffName()
  const { items = [], resolution } = verification
  const counts = (["pass", "fail", "unsure"] as const).map((verdict) => [verdict, items.filter((item) => item.verdict === verdict).length] as const).filter(([, n]) => n > 0)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {verification.verdict && <VerdictBadge verdict={verification.verdict} />}
        <p className="font-medium">{verification.headline}</p>
      </div>
      {resolution && (
        <Alert>
          <GavelIcon />
          <AlertTitle>{resolution.byName ?? staffName(resolution.byId)} {RESOLUTION[resolution.how]} · {fmtShort(resolution.at)}</AlertTitle>
          {resolution.note && <AlertDescription>{resolution.how === "continue" ? "说明：" : "备注："}{resolution.note}</AlertDescription>}
        </Alert>
      )}
      {items.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">
            每条检查点的结论：{counts.map(([verdict, n]) => `${VERDICT[verdict].label} ${n} 条`).join("、")}
          </span>
          <ItemGroup className="gap-2">
            {items.map((item) => {
              const { icon: Icon } = VERDICT[item.verdict]
              return (
                <Item key={item.index} variant="outline" size="xs">
                  <ItemMedia variant="icon"><Icon /></ItemMedia>
                  <ItemContent>
                    <ItemTitle className="flex-wrap">{item.index}. {item.title}<VerdictBadge verdict={item.verdict} /></ItemTitle>
                    <ItemDescription className="line-clamp-none">{item.reason}</ItemDescription>
                  </ItemContent>
                </Item>
              )
            })}
          </ItemGroup>
        </div>
      )}
      {showNotes && verification.notes.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">验收问答（三方 AI 有疑问时先问执行 agent，它可以说明或补做）</span>
          <MessageGroup className="gap-3">
            {verification.notes.map((note, index) => (
              <Message key={index} align={note.by === "verifier" ? "start" : "end"}>
                <MessageContent>
                  <MessageHeader>{note.by === "verifier" ? "三方 AI" : "执行 agent"}</MessageHeader>
                  <Bubble variant={note.by === "verifier" ? "muted" : "outline"}><BubbleContent className="whitespace-pre-line">{note.text}</BubbleContent></Bubble>
                </MessageContent>
              </Message>
            ))}
          </MessageGroup>
        </div>
      )}
    </div>
  )
}
