// 「桌面存放位置」分区（docs/dev/desktop-vm.md 第 2、3、6 节）：新建桌面、做模板时能选的盘（部署时配置的目录），
// 选默认位置、手动标 SSD / HDD（系统按 Linux 的 rotational 标记认，虚拟机、RAID 上可能认错）；顺带显示本机内存和开着的虚拟机。
// 表单：React Hook Form + shared 的 desktopStorageSettingsSchema；数据来自 desktops.host（storages 里的 isDefault、kindOverridden）。
import { zodResolver } from "@hookform/resolvers/zod"
import { SaveIcon, TriangleAlertIcon } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import { desktopStorageSettingsSchema, type DesktopHost, type DesktopStorageSettings } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"

import { useDesktopHostQuery, useDesktopsQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href } from "@/lib/router"
import { trpc } from "@/lib/trpc"
import { DISK_LABEL, storageLine } from "@/pages/desktops/vm-parts"

const LINK = "underline underline-offset-4 hover:text-foreground"
const HELP = "新建桌面、做模板时能选的盘（部署时配置的目录）。系统自己认是 SSD 还是机械硬盘，认错了在这里改。默认位置是新建桌面时预先选好的那个；不选就用第一块能用的 SSD。"

export function DesktopStorageSection() {
  const hostQuery = useDesktopHostQuery()
  return (
    <DetailSection title="桌面存放位置" description={HELP}>
      {hostQuery.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : hostQuery.isError || !hostQuery.data ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>没查到本机情况</AlertTitle>
          <AlertDescription>刷新一下页面再试。</AlertDescription>
        </Alert>
      ) : (
        // 换了数据（别人改过、实时推送）就重新初始化表单
        <StorageForm key={JSON.stringify(hostQuery.data.storages)} host={hostQuery.data} />
      )}
    </DetailSection>
  )
}

const valuesOf = (host: DesktopHost): DesktopStorageSettings => ({
  defaultPath: host.storages.find((storage) => storage.isDefault)?.path,
  kindOverrides: Object.fromEntries(
    host.storages.filter((storage) => storage.kindOverridden && storage.kind !== "unknown").map((storage) => [storage.path, storage.kind as "ssd" | "hdd"])
  ),
})

const AUTO = "auto"

function StorageForm({ host }: { host: DesktopHost }) {
  const values = valuesOf(host)
  const form = useForm<DesktopStorageSettings>({ resolver: zodResolver(desktopStorageSettingsSchema), defaultValues: values })
  const { isDirty } = form.formState
  const save = useAction(trpc.desktops.setStorageSettings.mutationOptions(), { success: "桌面存放位置已保存" })
  const vms = (useDesktopsQuery().data ?? []).filter((desktop) => desktop.vm && ["creating", "installing", "starting", "running", "setup"].includes(desktop.vm.state))
  const usable = host.storages.filter((storage) => !storage.problem)
  const defaultItems = usable.map((storage) => ({ value: storage.path, label: `${storage.path} · ${storageLine(storage)}` }))

  const submit = form.handleSubmit(async (next) => {
    if (await save.submit(next)) form.reset(next)
  })

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {!host.available && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>这台服务器现在开不了虚拟机</AlertTitle>
          <AlertDescription>{host.problem ?? "虚拟机服务没开。"} 「桌面」页只能登记已有电脑，请运维按运维手册「桌面」一节检查。</AlertDescription>
        </Alert>
      )}
      <dl className="grid gap-3 sm:grid-cols-3">
        <Fact label="本机内存" value={`${Math.round(host.memoryGb)} GB`} />
        <Fact label="CPU" value={`${host.cpus} 核`} />
        <Fact label="开着的虚拟机" value={`${host.runningVms} 台，共用 ${Math.round(host.usedMemoryGb)} GB 内存`} />
      </dl>
      {vms.length > 0 && (
        <p className="text-muted-foreground">
          开着的：
          {vms.map((desktop, index) => (
            <span key={desktop.id}>
              {index > 0 && "、"}
              <a href={href("desktops", { id: desktop.id })} className={LINK}>{desktop.name}</a>（{desktop.vm!.memoryGb} GB）
            </span>
          ))}
          。内存不够时新建、开机会被拒绝，先关掉不用的。
        </p>
      )}
      {host.storages.length === 0 ? (
        <p className="text-muted-foreground">部署时没有配置存放位置（HEYAGENT_DESKTOP_STORAGE_ROOTS），请运维按运维手册「桌面」一节配置。</p>
      ) : (
        <FieldGroup>
          <Controller
            control={form.control}
            name="defaultPath"
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="dvm-default">默认位置</FieldLabel>
                <Select items={defaultItems} value={field.value ?? null} onValueChange={(value) => value && field.onChange(String(value))}>
                  <SelectTrigger id="dvm-default" className="w-full sm:w-96">
                    <SelectValue placeholder="第一块能用的 SSD" />
                  </SelectTrigger>
                  <SelectContent>
                    {defaultItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>新建桌面时预先选好这个，人还可以改。</FieldDescription>
              </Field>
            )}
          />
          <Controller
            control={form.control}
            name="kindOverrides"
            render={({ field }) => (
              <FieldSet>
                <FieldLegend variant="label">每块盘</FieldLegend>
                <FieldDescription>认错了就手动标。机械硬盘上 Windows 会很慢，新建时会提醒。</FieldDescription>
                <ItemGroup className="gap-2">
                  {host.storages.map((storage, index) => {
                    const manual = field.value[storage.path]
                    const kindItems = [
                      { value: AUTO, label: storage.kindOverridden ? "自动识别" : `自动识别（${DISK_LABEL[storage.kind]}）` },
                      { value: "ssd", label: "标成 SSD" },
                      { value: "hdd", label: "标成 HDD 机械硬盘" },
                    ]
                    return (
                      <Item key={storage.path} size="sm" variant="outline">
                        <ItemContent className="min-w-0">
                          <ItemTitle className="font-mono break-all">{storage.path}</ItemTitle>
                          <ItemDescription>
                            {storageLine(storage)}，共 {Math.floor(storage.totalGb)} GB{storage.kindOverridden ? " · 手动标的" : ""}
                            {storage.problem && <span className="block text-destructive">不能用：{storage.problem}</span>}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Select items={kindItems} value={manual ?? AUTO} onValueChange={(value) => {
                            const next = { ...field.value }
                            if (value === "ssd" || value === "hdd") next[storage.path] = value
                            else delete next[storage.path]
                            field.onChange(next)
                          }}>
                            <SelectTrigger size="sm" aria-label={`${storage.path} 是什么盘`} id={`dvm-kind-${index}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {kindItems.map((item) => (
                                <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </ItemActions>
                      </Item>
                    )
                  })}
                </ItemGroup>
              </FieldSet>
            )}
          />
        </FieldGroup>
      )}
      {host.storages.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!isDirty || save.isPending}>
            {save.isPending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
            保存
          </Button>
          {isDirty && (
            <Button type="button" variant="ghost" onClick={() => form.reset(values)}>
              撤销修改
            </Button>
          )}
        </div>
      )}
    </form>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
