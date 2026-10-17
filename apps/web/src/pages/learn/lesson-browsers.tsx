import { useState } from "react"
import { AppWindowIcon, CookieIcon, GlobeIcon, NetworkIcon, RefreshCwIcon, UserIcon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { ItemGroup } from "@/components/ui/item"
import { href } from "@/lib/router"
import { accountStatusLabel, browserProfiles, findById, platforms } from "./demo-data/prototype"

import { browserScenarios, proxyText } from "./demo-data/lessons"
import { Code, Lesson, Step, TextLink } from "./parts"

const options = browserScenarios.map((item) => ({ id: item.id, label: item.label }))

export function BrowsersLesson() {
  const [scenarioId, setScenarioId] = useState(browserScenarios[0].id)
  const scenario = browserScenarios.find((item) => item.id === scenarioId) ?? browserScenarios[0]
  const index = browserProfiles.findIndex((item) => item.id === scenario.browserId)
  const profile = browserProfiles[index]
  const site = profile.sites.find((item) => item.platformId === scenario.platformId)
  const siteName = site ? `${findById(platforms, site.platformId)?.name}「${site.account}」` : ""
  const full = site ? site.running >= site.maxConcurrent : false

  return (
    <Lesson
      title="浏览器：多个 Chrome，共用登录态"
      meta="服务器上开着几个 Chrome，各走各的代理。每个 Chrome 有一个登录态保险箱，存 cookie 和 session，所有 agent 共用：人登录一次，大家都能用。用哪个 Chrome 由 agent 看说明自己选。员工也能自己打开 Chrome（新网站也行）；新建 Chrome、改代理只有主管能做。"
      choice={{ label: "选一件要用浏览器的事", value: scenario.id, options, onChange: setScenarioId }}
    >
      <DetailSection title={`情况：${scenario.situation}`} description="agent 看到的 Chrome 列表就是这几句说明">
        <Code
          icon={<AppWindowIcon />}
          title={`可用的 Chrome（${browserProfiles.length} 个）`}
          lines={browserProfiles.map((item, i) => `- ${item.name}：${item.description}${i === index ? "   ← 选这个" : ""}`)}
          highlight={index}
        />
      </DetailSection>

      <DetailSection title={`选了「${profile.name}」之后`} action={<TextLink to={href("browsers", { id: profile.id })}>去浏览器页 →</TextLink>}>
        <ItemGroup className="gap-1">
          <Step tone="run" icon={<NetworkIcon />} title="走这个 Chrome 的代理" text={proxyText(profile)} />
          <Step tone="run" icon={<CookieIcon />} title={`从保险箱带上登录态：v${profile.vaultVersion}，${profile.cookieCount} 个 cookie`} />
          {site ? (
            <Step
              tone={full ? "wait" : "run"}
              icon={<UserIcon />}
              title={`${siteName}：同时最多 ${site.maxConcurrent} 个 session`}
              text={`现在 ${site.running} 个在用，满了就排队。同一个账号多处同时登录，容易被平台风控`}
            />
          ) : (
            <Step tone="skip" icon={<UserIcon />} title="这个网站不用登录，不占账号" text="还没登录过任何网站；要登录的话，员工自己打开这个 Chrome 登录一次就行" />
          )}
          <Step
            tone={site && site.status !== "ok" ? "block" : "pass"}
            icon={<GlobeIcon />}
            title={`打开 ${scenario.url}`}
            text={
              site?.status === "ok" || !site
                ? `${site ? `${siteName}${accountStatusLabel[site.status]}，` : ""}直接用`
                : `${siteName}${accountStatusLabel[site.status]}：员工自己去「浏览器」里打开这个 Chrome 处理，待办里会多一张登录卡`
            }
          />
          <Step
            tone="log"
            icon={<RefreshCwIcon />}
            title={`用完把 cookie 的变化合并回保险箱，变成 v${profile.vaultVersion + 1}`}
            text="下一个用这个 Chrome 的 agent 直接带上，不用再登录"
          />
        </ItemGroup>
      </DetailSection>
    </Lesson>
  )
}
