// 设置页（主管专用）：一列内容，四张卡片——运行上限、浏览器、外部事件令牌、通知渠道。
import { useQuery } from "@tanstack/react-query"
import { SettingsIcon, ShieldOffIcon } from "lucide-react"
import { can } from "@heyagent/shared"

import { EmptyState, PageFrame, SimpleHeader } from "@/components/shell/simple-page"

import { trpc } from "@/lib/trpc"
import { useMe } from "@/lib/session"

import { BrowserSection } from "./browser-section"
import { ChannelsSection } from "./channels-section"
import { LimitsSection } from "./limits-section"
import { TokenSection } from "./token-section"

const DESCRIPTION = "全局生效的几项设置：agent 跑多久要停下来问人、浏览器开多少、外部系统怎么发事件进来、通知推到哪里。"

export default function SettingsPage() {
  const { user } = useMe()
  if (!can(user, "settings.manage", {})) {
    return (
      <div className="flex flex-1 flex-col gap-6">
        <SimpleHeader title="设置" description={DESCRIPTION} />
        <EmptyState icon={<ShieldOffIcon />} title="只有主管能改设置" description="这里的设置对所有人生效，由主管维护。有需要请找主管。" />
      </div>
    )
  }
  return <SettingsManager />
}

function SettingsManager() {
  const settingsQuery = useQuery(trpc.settings.get.queryOptions())
  const settings = settingsQuery.data

  return (
    <PageFrame
      queries={[settingsQuery]}
      isEmpty={!settings}
      skeleton="table"
      header={<SimpleHeader title="设置" description={DESCRIPTION} />}
      empty={<EmptyState icon={<SettingsIcon />} title="没读到设置" description="刷新一下页面再试。" />}
    >
      {settings && (
        <div className="flex w-full max-w-3xl flex-col gap-4">
          <LimitsSection
            limits={{ maxCostUsd: settings.maxCostUsd, maxSteps: settings.maxSteps, eventFallbackDays: settings.eventFallbackDays }}
          />
          <BrowserSection values={settings.browser} />
          <TokenSection token={settings.eventToken} />
          <ChannelsSection channels={settings.channels} />
        </div>
      )}
    </PageFrame>
  )
}
