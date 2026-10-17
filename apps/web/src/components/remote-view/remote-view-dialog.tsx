// 远程画面放进一个大弹窗：session 的「看浏览器」、要人办的事里的「去浏览器里处理」、浏览器页的「打开 Chrome」都用它，
// 区别只在底部的按钮（footer）。
import * as React from "react"

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

import { RemoteView } from "."

interface RemoteViewDialogProps {
  browserId: string
  title: React.ReactNode
  description?: React.ReactNode
  /** 底部按钮；不传就只有右上角的关闭 */
  footer?: React.ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  onClosed?: (reason: string) => void
  /** 只看不操作 */
  viewOnly?: boolean
}

export function RemoteViewDialog({ browserId, title, description, footer, open, onOpenChange, onClosed, viewOnly }: RemoteViewDialogProps) {
  return (
    // 点弹窗外面不关：人在画面里拖滑块时很容易拖出边界
    <Dialog open={open} onOpenChange={(next, details) => (next || details.reason !== "outside-press") && onOpenChange(next)}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {open && <RemoteView browserId={browserId} onClosed={onClosed} viewOnly={viewOnly} />}
        {footer && <DialogFooter className="sm:items-center">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}
