// 比物页的小零件：列表和详情共用的状态徽章、「谁发起的」、花费。
import { useQuery } from "@tanstack/react-query"
import { CircleCheckIcon } from "lucide-react"
import type { Comparison } from "@heyagent/shared"

import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"

import { useStaffName } from "@/lib/data"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

/** 比对中 / 97 分（达标带勾）/ 61 分 / 证据不足 / 没比成。颜色按 ui-rules 第 4 节的状态映射，不加新颜色 */
export function ScoreBadge({ record }: { record: Pick<Comparison, "status" | "score" | "passed"> }) {
  if (record.status === "running")
    return (
      <Badge variant="secondary">
        <Spinner data-icon="inline-start" />
        比对中
      </Badge>
    )
  if (record.status === "failed") return <Badge variant="destructive">没比成</Badge>
  if (record.score === null) return <Badge variant="ghost">证据不足</Badge>
  return record.passed ? (
    <Badge variant="outline">
      <CircleCheckIcon data-icon="inline-start" />
      {record.score} 分
    </Badge>
  ) : (
    <Badge variant="secondary">{record.score} 分</Badge>
  )
}

/** 「$0.0021」 */
export const money = (usd: number) => `$${usd.toFixed(4)}`

/**
 * 谁发起的，一句话：人名 / 运行 R-… / 接口 · 密钥名（MCP 同理）。
 * API 密钥的名字只有主管查得到（apiKeys.list），员工看到的是「接口」。
 */
export function useSourceText() {
  const staffName = useStaffName()
  const { isAdmin } = useMe()
  const keys = useQuery({ ...trpc.apiKeys.list.queryOptions(), enabled: isAdmin }).data
  return (record: Pick<Comparison, "via" | "createdById" | "sessionId" | "apiKeyId">) => {
    if (record.via === "agent") return record.sessionId ? `运行 ${record.sessionId}` : "agent"
    if (record.via === "api" || record.via === "mcp") {
      const kind = record.via === "api" ? "接口" : "MCP"
      const key = keys?.find((each) => each.id === record.apiKeyId)
      return key ? `${kind} · ${key.name}` : kind
    }
    return record.createdById ? staffName(record.createdById) : "—"
  }
}
