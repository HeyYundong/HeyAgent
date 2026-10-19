// 以前的对话（本人最近 50 段）：点一段打开，每段可以删（删前确认）。
// 用 Popover 而不是 DropdownMenu：每一行有「打开」和「删除」两个按钮，菜单项里不能再放按钮。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { HistoryIcon, Trash2Icon } from "lucide-react"
import { relativeDayText, type AssistantChatSummary } from "@heyagent/shared"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { errorMessage, useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

interface HistoryButtonProps {
  currentId: string | null
  disabled?: boolean
  onOpenChat: (id: string) => void
  /** 删掉了一段（是正开着的那段时，面板回到新对话） */
  onDeleted: (id: string) => void
}

export function HistoryButton({ currentId, disabled, onOpenChat, onDeleted }: HistoryButtonProps) {
  const [open, setOpen] = React.useState(false)
  const [deleting, setDeleting] = React.useState<AssistantChatSummary | null>(null)
  const chats = useQuery({ ...trpc.assistant.chats.queryOptions(), enabled: open })
  const remove = useAction(trpc.assistant.delete.mutationOptions(), {
    success: "对话已删除",
    errorTitle: "没删掉",
  })

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger render={<PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="以前的对话" disabled={disabled} />} />}>
            <HistoryIcon />
          </TooltipTrigger>
          <TooltipContent>以前的对话</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-72">
          <PopoverHeader>
            <PopoverTitle>以前的对话</PopoverTitle>
          </PopoverHeader>
          <div className="-mx-1 flex max-h-80 flex-col overflow-y-auto">
            {chats.isPending ? (
              <div className="flex flex-col gap-2 px-1">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-2/3" />
              </div>
            ) : chats.isError ? (
              <p className="px-1 text-destructive">没读到：{errorMessage(chats.error)}</p>
            ) : chats.data.length === 0 ? (
              <p className="px-1 text-muted-foreground">还没有以前的对话</p>
            ) : (
              chats.data.map((chat) => (
                <div key={chat.id} className="flex items-center gap-1">
                  <Button
                    variant={chat.id === currentId ? "secondary" : "ghost"}
                    size="sm"
                    className="min-w-0 flex-1 justify-between"
                    onClick={() => {
                      onOpenChat(chat.id)
                      setOpen(false)
                    }}
                  >
                    <span className="truncate">{chat.title || "新对话"}</span>
                    <span className="shrink-0 text-muted-foreground">{relativeDayText(chat.updatedAt)}</span>
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`删除「${chat.title}」`} onClick={() => setDeleting(chat)}>
                    <Trash2Icon />
                  </Button>
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
      <AlertDialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这段对话？</AlertDialogTitle>
            <AlertDialogDescription>「{deleting?.title}」删除后不能恢复。已经应用的改动不受影响。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不删</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={async () => {
                if (!deleting) return
                const done = await remove.submit({ id: deleting.id })
                if (done) onDeleted(deleting.id)
                setDeleting(null)
              }}
            >
              {remove.isPending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
