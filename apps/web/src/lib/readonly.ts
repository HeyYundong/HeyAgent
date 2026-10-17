// 只读阶段（M0）：按钮和对话框照原型保留，真正提交的那一下统一弹这个提示（docs/dev/m0.md 包 3 第 6 步）。
import { toast } from "@/components/ui/toast"

export function readOnlyToast() {
  toast.add({ title: "只读阶段：这个操作下一个里程碑接通", type: "info" })
}
