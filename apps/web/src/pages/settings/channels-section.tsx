// 「通知渠道」分区：站内通知（要人处理、运行失败、等太久、规则通知、agent 调「通知员工」等）同时推送到这里启用的渠道；只有「运行完成」不推。
// 列表每行：名字、类型、地址掩码、启用开关（直接保存）、编辑、删除（二次确认）。
import * as React from "react"
import { BellIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent } from "@/components/ui/alert-dialog"
import { AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

import { ChannelDialog, KIND_LABEL, type Channel } from "./channel-dialog"

export function ChannelsSection({ channels }: { channels: Channel[] }) {
  /** "new" = 加渠道；Channel = 编辑这个渠道 */
  const [editing, setEditing] = React.useState<Channel | "new" | null>(null)
  const [removing, setRemoving] = React.useState<Channel | null>(null)
  const toggle = useAction(trpc.settings.saveChannel.mutationOptions(), {
    success: (_data, vars) => (vars.enabled ? `已启用「${vars.name}」` : `已停用「${vars.name}」，先不往这里推`),
  })
  const remove = useAction(trpc.settings.deleteChannel.mutationOptions(), { success: "渠道已删除" })

  async function confirmRemove() {
    if (!removing) return
    if (await remove.submit({ id: removing.id })) setRemoving(null)
  }

  return (
    <DetailSection
      title="通知渠道"
      description="除了「运行完成」，所有站内通知都会同时推送到下面启用的渠道。"
      action={
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          <PlusIcon data-icon="inline-start" />
          加渠道
        </Button>
      }
    >
      {channels.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BellIcon />
            </EmptyMedia>
            <EmptyTitle>还没有通知渠道</EmptyTitle>
            <EmptyDescription>现在通知只在站内显示。加一个飞书、企业微信群机器人或 webhook，通知会同时推过去。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {channels.map((channel) => (
            <Item key={channel.id} size="sm" variant="outline">
              <ItemContent className="min-w-0">
                <ItemTitle className="flex-wrap">
                  {channel.name}
                  <Badge variant="outline">{KIND_LABEL[channel.kind]}</Badge>
                  {!channel.enabled && <Badge variant="ghost">已停用</Badge>}
                </ItemTitle>
                <ItemDescription className="line-clamp-1 font-mono break-all">{channel.urlMasked ?? "地址没读到，编辑时重新填一次"}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  checked={channel.enabled}
                  disabled={toggle.isPending}
                  onCheckedChange={(enabled) => toggle.mutate({ id: channel.id, name: channel.name, kind: channel.kind, enabled })}
                  aria-label={`启用「${channel.name}」`}
                />
                <Button variant="ghost" size="icon-sm" aria-label={`编辑「${channel.name}」`} onClick={() => setEditing(channel)}>
                  <PencilIcon />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`删除「${channel.name}」`} onClick={() => setRemoving(channel)}>
                  <Trash2Icon />
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}

      {editing && <ChannelDialog channel={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}

      <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除渠道「{removing?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后通知不再推到这里，存着的 webhook 地址也一起删掉，不能恢复。只是想暂停的话，把开关关掉就行。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不删</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => void confirmRemove()}>
              {remove.isPending && <Spinner data-icon="inline-start" />}
              删除渠道
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailSection>
  )
}
