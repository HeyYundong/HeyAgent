// 「登录」类要人办的事（遇到验证码或登录页，M2）：截图 + 去浏览器里处理。是处理面板（human-item.tsx）里的一段。
// - 运行的 Chrome 还保留着（browser.sessionBrowser 的 open）：打开它的远程画面处理，好了点「已处理好了」，同一个 Chrome 接着跑；
// - 过了保留时间已经关了：用 browser.openForLogin(profileId, accountId) 新开一个，处理好、关掉（关就保存），再点「已处理好了」。
import * as React from "react"
import { MonitorIcon } from "lucide-react"
import type { HumanItem } from "@heyagent/shared"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useBrowsersQuery } from "@/lib/data"
import { usePlatformName } from "@/pages/browsers/data"
import { LoginBrowserDialog, OpenLoginButton, useOpenLogin } from "@/pages/browsers/login-browser"
import { SessionBrowserDialog, useSessionBrowser } from "@/pages/tasks/run-browser"

import { Part } from "./parts"

type Info = NonNullable<HumanItem["detail"]["browser"]>

export function HumanBrowserSection({ item, info, canAct, onResolved }: { item: HumanItem; info: Info; canAct: boolean; onResolved: () => void }) {
  const query = useSessionBrowser(info.sessionId)
  const [viewing, setViewing] = React.useState(false)
  const login = useOpenLogin()
  const profiles = useBrowsersQuery().data ?? []
  const platformName = usePlatformName()
  const profile = profiles.find((each) => each.id === info.profileId)
  const accountName = (accountId: string) => {
    const site = profile?.sites.find((each) => each.accountId === accountId)
    return site ? `${platformName(site.platformId)} · ${site.account}` : accountId
  }
  const browser = query.data
  const open = Boolean(browser?.open && browser.browserId)

  return (
    <Part title="远程画面" description={profile ? `Chrome 配置「${profile.name}」` : undefined}>
      <div className="flex flex-col gap-3">
        {info.screenshotFileId && (
          <a href={`/api/files/${info.screenshotFileId}`} target="_blank" rel="noreferrer" className="block border" aria-label="遇到时的截图（点开看大图）">
            <img src={`/api/files/${info.screenshotFileId}`} alt="遇到验证码或登录页时的截图" className="block h-auto w-full" />
          </a>
        )}
        {query.isPending ? (
          <Spinner />
        ) : query.isError ? (
          <p className="text-destructive">没查到这次运行的 Chrome，稍后再试。</p>
        ) : open ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground">
              {browser?.state === "held" ? "运行的 Chrome 还保留着，打开远程画面处理，好了点「已处理好了」，agent 在同一个 Chrome 里接着做。" : "运行的 Chrome 开着，可以打开远程画面看。"}
            </p>
            <Button variant={canAct ? "default" : "outline"} onClick={() => setViewing(true)}>
              <MonitorIcon data-icon="inline-start" />
              {canAct ? "去浏览器里处理" : "看画面"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground">
              运行的 Chrome 过了保留时间，已经写回登录态关掉了。{canAct ? "点「新开 Chrome 处理」，在里面处理好、关掉（会保存），再回来点「已处理好了」；agent 继续时会新起一个 Chrome。" : ""}
            </p>
            {canAct && <OpenLoginButton label="新开 Chrome 处理" pending={login.pending} onClick={() => void login.start({ profileId: info.profileId, accountId: info.accountId })} />}
          </div>
        )}
      </div>
      {viewing && browser?.browserId && (
        <SessionBrowserDialog runId={info.sessionId} browserId={browser.browserId} item={item} onClose={() => setViewing(false)} onResolved={onResolved} />
      )}
      {login.opened && (
        <LoginBrowserDialog
          key={login.opened.browserId}
          browserId={login.opened.browserId}
          title={`${profile?.name ?? info.profileId} · 处理「${item.title}」`}
          description="处理好验证码或登录后关掉（会保存），再点「已处理好了」。"
          accountName={accountName}
          onClose={login.clear}
        />
      )}
    </Part>
  )
}
