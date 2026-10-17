// 顶栏的通知按钮（engine.notifications）：显示未读数，点开是最近的通知列表（Popover + Item）。
// 点一条：标成已读，跳到它的链接（没有链接的按所属任务 / 运行跳）。新通知由实时推送（notifications 表）自动刷新。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { BellIcon, CheckCheckIcon } from "lucide-react"
import { fmtShort, type AppNotification } from "@heyagent/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { useAction } from "@/lib/mutations"
import { href } from "@/lib/router"
import { trpc } from "@/lib/trpc"

/** 通知要跳去哪：有 link 用 link（引擎写的是 #/tasks?id=…&run=… 这类 hash 地址），否则按运行、任务 */
function linkOf(item: AppNotification) {
  if (item.link?.startsWith("#/")) return item.link
  if (item.taskId) return href("tasks", { id: item.taskId, run: item.sessionId })
  return undefined
}

export function NotificationsButton() {
  const [open, setOpen] = React.useState(false)
  const list = useQuery(trpc.engine.notifications.list.queryOptions({ limit: 30 }))
  const markRead = useAction(trpc.engine.notifications.markRead.mutationOptions(), { errorTitle: "没能标成已读" })
  const unread = list.data?.unread ?? 0
  const items = list.data?.items ?? []
  const label = unread ? `通知（${unread} 条未读）` : "通知"

  const openItem = (item: AppNotification) => {
    if (!item.readAt) markRead.mutate({ ids: [item.id] })
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" size={unread ? "sm" : "icon-sm"} aria-label={label} />}>
        <BellIcon data-icon={unread ? "inline-start" : undefined} />
        {unread > 0 && <Badge>{unread > 99 ? "99+" : unread}</Badge>}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-2 p-0 sm:w-96">
        <PopoverHeader className="flex-row items-center justify-between gap-2 border-b p-2.5">
          <div className="flex flex-col gap-0.5">
            <PopoverTitle>通知</PopoverTitle>
            <PopoverDescription>{unread ? `${unread} 条未读` : "都看过了"}</PopoverDescription>
          </div>
          <Button variant="ghost" size="xs" disabled={unread === 0 || markRead.isPending} onClick={() => markRead.mutate({})}>
            <CheckCheckIcon data-icon="inline-start" />全部标为已读
          </Button>
        </PopoverHeader>
        <div className="max-h-96 overflow-y-auto px-2.5 pb-2.5">
          {list.isPending ? (
            <div className="flex justify-center py-6"><Spinner /></div>
          ) : list.isError ? (
            <p className="py-4 text-destructive">通知没取到，稍后再试。</p>
          ) : items.length === 0 ? (
            <Empty className="py-6">
              <EmptyHeader>
                <EmptyMedia variant="icon"><BellIcon /></EmptyMedia>
                <EmptyTitle>还没有通知</EmptyTitle>
                <EmptyDescription>有事等你处理、任务跑完或出错时，会在这里提醒你。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup className="gap-1">
              {items.map((item) => {
                const to = linkOf(item)
                return (
                  <Item key={item.id} size="xs" variant={item.readAt ? "default" : "muted"} render={to ? <a href={to} /> : <button type="button" />} onClick={() => openItem(item)}>
                    <ItemMedia>
                      <span className={item.readAt ? "size-2 rounded-full bg-border" : "size-2 rounded-full bg-primary"} aria-label={item.readAt ? "已读" : "未读"} />
                    </ItemMedia>
                    <ItemContent className="min-w-0 text-left">
                      <ItemTitle className="line-clamp-2">{item.title}</ItemTitle>
                      <ItemDescription className="line-clamp-2">{[fmtShort(item.createdAt), item.body].filter(Boolean).join(" · ")}</ItemDescription>
                    </ItemContent>
                  </Item>
                )
              })}
            </ItemGroup>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
