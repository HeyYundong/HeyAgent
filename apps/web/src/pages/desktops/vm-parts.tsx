// 系统开的桌面（docs/dev/desktop-vm.md 第 6 节）的小部件：状态徽章、盘的类型、选存放位置。桌面页、两个弹窗、设置页共用。
import * as React from "react"
import { CircleCheckIcon } from "lucide-react"
import type { Desktop, DesktopStorage, DesktopVmState, DiskKind } from "@heyagent/shared"

import { Badge } from "@/components/ui/badge"
import { FieldContent, FieldDescription, FieldLabel, FieldTitle, Field } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"

type Variant = "outline" | "secondary" | "ghost" | "destructive" | "default"

/** 徽章按 ui-rules 第 4 节：开着 → outline + 对勾；在变的 → secondary + Spinner；关着 → ghost；出错 → destructive；等人动手 → default */
const VM_STATE: Record<DesktopVmState, { label: string; variant: Variant; busy?: boolean; ok?: boolean }> = {
  creating: { label: "新建中", variant: "secondary", busy: true },
  installing: { label: "装 Windows 中", variant: "secondary", busy: true },
  starting: { label: "开机中", variant: "secondary", busy: true },
  running: { label: "开着", variant: "outline", ok: true },
  setup: { label: "等装软件", variant: "default" },
  ready: { label: "做好了", variant: "outline", ok: true },
  stopping: { label: "关机中", variant: "secondary", busy: true },
  stopped: { label: "关着", variant: "ghost" },
  error: { label: "出错了", variant: "destructive" },
  deleting: { label: "删除中", variant: "secondary", busy: true },
}

export const vmStateLabel = (state: DesktopVmState) => VM_STATE[state].label
/** 正在变（开机、关机、新建……）：这时候不给开关机按钮 */
export const vmBusy = (state: DesktopVmState) => Boolean(VM_STATE[state].busy)

export function VmStateBadge({ state }: { state: DesktopVmState }) {
  const { label, variant, busy, ok } = VM_STATE[state]
  return (
    <Badge variant={variant}>
      {busy && <Spinner data-icon="inline-start" />}
      {ok && <CircleCheckIcon data-icon="inline-start" />}
      {label}
    </Badge>
  )
}

export const DISK_LABEL: Record<DiskKind, string> = { ssd: "SSD", hdd: "HDD 机械硬盘", unknown: "看不出来" }

/** 一个存放位置的一句话：「SSD · 剩 812 GB」 */
export const storageLine = (storage: DesktopStorage) => `${DISK_LABEL[storage.kind]} · 剩 ${Math.floor(storage.freeGb)} GB`

/** 选的这个位置要提醒什么：不能用的原因 / 机械硬盘慢 / 看不出来 */
export function storageHint(storage: DesktopStorage) {
  if (storage.problem) return `不能用：${storage.problem}`
  if (storage.kind === "hdd") return "机械硬盘，Windows 会很慢（读一次界面要十几秒以上）。有 SSD 就选 SSD。"
  if (storage.kind === "unknown") return "看不出是 SSD 还是机械硬盘，可以请主管在「设置 → 桌面存放位置」里标一下。"
  return undefined
}

/** 选存放位置：每个位置一行（路径、SSD / HDD、剩多少），SSD 标「推荐」，不能用的置灰写原因 */
export function StoragePicker({
  id,
  storages,
  value,
  onChange,
  invalid,
}: {
  id: string
  storages: DesktopStorage[]
  value: string | undefined
  onChange: (path: string) => void
  invalid?: boolean
}) {
  return (
    <RadioGroup value={value ?? ""} onValueChange={(next) => onChange(String(next))} aria-invalid={invalid}>
      {storages.map((storage, index) => {
        const itemId = `${id}-${index}`
        const hint = storageHint(storage)
        return (
          <FieldLabel key={storage.path} htmlFor={itemId}>
            <Field orientation="horizontal" data-disabled={storage.problem ? true : undefined}>
              <FieldContent className="min-w-0">
                <FieldTitle className="flex-wrap">
                  <span className="font-mono break-all">{storage.path}</span>
                  {storage.kind === "ssd" && !storage.problem && <Badge variant="outline">推荐</Badge>}
                  {storage.isDefault && <Badge variant="secondary">默认</Badge>}
                </FieldTitle>
                <FieldDescription>
                  {storageLine(storage)}
                  {hint && <span className={storage.problem || storage.kind === "hdd" ? "block text-destructive" : "block"}>{hint}</span>}
                </FieldDescription>
              </FieldContent>
              <RadioGroupItem value={storage.path} id={itemId} disabled={Boolean(storage.problem)} />
            </Field>
          </FieldLabel>
        )
      })}
    </RadioGroup>
  )
}

/** 能选的默认位置：设置里的默认；它不能用就第一个能用的 SSD，再不行第一个能用的 */
export function defaultStoragePath(storages: DesktopStorage[]) {
  const usable = storages.filter((storage) => !storage.problem)
  return (usable.find((storage) => storage.isDefault) ?? usable.find((storage) => storage.kind === "ssd") ?? usable[0])?.path
}

/** 从 since 到现在过了几分钟，每 30 秒刷新一次（模板装 Windows 时显示「已经 N 分钟」） */
export function useMinutesSince(since: string | undefined) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  if (!since) return 0
  return Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000))
}

/** 分钟 → 「23 分钟」「1 小时 5 分钟」 */
export const durationText = (minutes: number) =>
  minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`

export const isVm = (desktop: Desktop) => desktop.kind === "vm"
export const isTemplate = (desktop: Desktop) => desktop.kind === "template"
