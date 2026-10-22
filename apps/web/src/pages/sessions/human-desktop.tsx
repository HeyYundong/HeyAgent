// 「在桌面上处理」类要人办的事（agent 调了 desktop.ask_human，docs/dev/desktop.md 第 4 节）：截图 + 打开桌面。是处理面板（human-item.tsx）里的一段。
// 桌面这时保留给这个运行（held）：打开远程画面处理（扫码登录、关弹框……），好了点「已处理好了」，同一个运行接着用这台桌面。
// 过了保留时间桌面会自动放开：还是能打开处理（只要它空着或主管在看），点「已处理好了」后运行重新去占这台桌面。
import * as React from "react"
import { MonitorIcon } from "lucide-react"
import { findById, type HumanItem } from "@heyagent/shared"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useDesktopsQuery } from "@/lib/data"
import { SessionDesktopDialog, useSessionDesktop } from "@/pages/tasks/run-desktop"

import { Part } from "./parts"

type Info = NonNullable<HumanItem["detail"]["desktop"]>

export function HumanDesktopSection({ item, info, canAct, onResolved }: { item: HumanItem; info: Info; canAct: boolean; onResolved: () => void }) {
  const query = useSessionDesktop(info.sessionId)
  const [viewing, setViewing] = React.useState(false)
  const desktop = findById(useDesktopsQuery().data ?? [], info.desktopId)
  const held = query.data?.open && query.data.desktopId === info.desktopId
  const name = desktop?.name ?? query.data?.desktopName

  return (
    <Part title="远程画面" description={name ? `桌面「${name}」` : undefined}>
      <div className="flex flex-col gap-3">
        {info.screenshotFileId && (
          <a href={`/api/files/${info.screenshotFileId}`} target="_blank" rel="noreferrer" className="block border" aria-label="请人处理时的截图（点开看大图）">
            <img src={`/api/files/${info.screenshotFileId}`} alt="请人处理时桌面的截图" className="block h-auto w-full" />
          </a>
        )}
        {query.isPending ? (
          <Spinner />
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground">
              {query.isError
                ? "没查到这台桌面现在的情况，还是可以打开看看。"
                : held
                  ? "桌面还保留给这次运行，打开远程画面处理，好了点「已处理好了」，agent 在同一台桌面上接着做。"
                  : "桌面过了保留时间，已经放开了。还可以打开处理（别的运行可能正在用它）；点「已处理好了」后，agent 会重新去占这台桌面。"}
            </p>
            <Button variant={canAct ? "default" : "outline"} onClick={() => setViewing(true)}>
              <MonitorIcon data-icon="inline-start" />
              {canAct ? "打开桌面" : "看画面"}
            </Button>
          </div>
        )}
      </div>
      {viewing && (
        <SessionDesktopDialog runId={info.sessionId} desktopId={info.desktopId} desktopName={name} item={item} viewOnly={!canAct}
          onClose={() => setViewing(false)} onResolved={onResolved} />
      )}
    </Part>
  )
}
