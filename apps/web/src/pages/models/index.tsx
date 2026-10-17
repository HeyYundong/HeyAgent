import * as React from "react"
import { CircleCheckIcon, CircleDashedIcon, CpuIcon, EllipsisIcon, PencilIcon, PlugZapIcon, PlusIcon, SaveIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react"

import { DetailPanel, DetailSection, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { can, findById, fmtDateTime, modelFamily, sameFamily, type TaskDef } from "@heyagent/shared"

import { useModelsQuery, useTasksQuery } from "@/lib/data"
import { readOnlyToast } from "@/lib/readonly"
import { href, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"

import { connectionRows, contextText, KIND_LABEL, priceText, providerLine, ROLES, tasksOnProvider, type Defaults, type Provider } from "./data"
import { ProviderDialog } from "./provider-dialog"

const LINK = "underline underline-offset-4 hover:text-foreground"

// M0 只读：添加、编辑、删除服务，测试连接，改默认设置都照原型显示，真正提交时弹「只读阶段」提示。
export default function ModelsPage() {
  const { user } = useMe()
  const isAdmin = can(user, "config.manage", {})
  const { params } = useRoute()
  const modelsQuery = useModelsQuery()
  const tasksQuery = useTasksQuery()
  const queries = [modelsQuery, tasksQuery]
  const providers = modelsQuery.data?.providers ?? []
  const defaults: Defaults = modelsQuery.data?.defaults ?? { run: "", plan: "", verify: "" }
  const tasks = tasksQuery.data ?? []
  const [dialog, setDialog] = React.useState<"new" | "edit" | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const id = params.get("id")
  const selected = findById(providers, id)
  const models = providers.flatMap((p) => p.models)
  const nameOf = (modelId: string) => models.find((m) => m.id === modelId)?.name ?? modelId

  function remove() {
    setConfirmDelete(false)
    readOnlyToast()
  }

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多操作" />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setDialog("edit")}><PencilIcon />编辑</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2Icon />删除</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <PageFrame
      queries={queries}
      isEmpty={providers.length === 0}
      header={
        <SimpleHeader
          title="模型"
          description="agent 用哪些大模型：接入的模型服务，以及新建任务时默认选哪个。"
          learnId="models"
          action={isAdmin && <Button onClick={() => setDialog("new")}><PlusIcon data-icon="inline-start" />添加模型服务</Button>}
        />
      }
      empty={<EmptyState icon={<CpuIcon />} title="还没接入模型服务" description="先接一个 Ollama（内网免费）或 OpenRouter（云端，按量付费），agent 才能干活。" />}
    >
      <MasterDetail
        hasSelection={!!selected || id === "defaults"}
        list={
          <>
            <PickGroup>
              <PickItem to={href("models", { id: "defaults" })} selected={id === "defaults"} title="默认设置"
                description={`执行 ${nameOf(defaults.run)} · 验收 ${nameOf(defaults.verify)}`} />
            </PickGroup>
            <PickGroup label="模型服务">
              {providers.map((p) => (
                <PickItem key={p.id} to={href("models", { id: p.id })} selected={p.id === id} title={p.name}
                  description={providerLine(p, KIND_LABEL[p.kind])}
                  badge={p.status === "error" ? <Badge variant="destructive">连不上</Badge> : p.status === "unconfigured" && <Badge variant="outline">未配置</Badge>} />
              ))}
            </PickGroup>
          </>
        }
        detail={
          id === "defaults" ? (
            <DetailPanel title="默认设置" meta={`新建任务时预先选好的模型，建任务时还能改。${isAdmin ? "" : "只有主管能改默认设置。"}`}>
              <DefaultsSection key={Object.values(defaults).join()} providers={providers} defaults={defaults} readOnly={!isAdmin} nameOf={nameOf}
                onSave={readOnlyToast} />
            </DetailPanel>
          ) : selected ? (
            <ProviderDetail key={selected.id} provider={selected} tasks={tasks} defaults={defaults} actions={isAdmin && menu} onTest={readOnlyToast} />
          ) : null
        }
      />

      {dialog && (
        <ProviderDialog provider={dialog === "edit" ? selected : undefined} onSave={readOnlyToast} onClose={() => setDialog(null)} />
      )}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{selected?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              {selected && tasksOnProvider(selected, tasks).length > 0 ? `有 ${tasksOnProvider(selected, tasks).length} 个任务在用它的模型，删除后这些任务要换模型才能运行。` : "没有任务直接选用它的模型。"}
              默认设置里用到它的模型会换成别家的。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageFrame>
  )
}

/** 改完点「保存」才生效；执行和验收同一家时验收下面报错，保存不了 */
function DefaultsSection({ providers, defaults, readOnly, nameOf, onSave }: {
  providers: Provider[]; defaults: Defaults; readOnly: boolean; nameOf: (id: string) => string; onSave: (next: Defaults) => void
}) {
  const [draft, setDraft] = React.useState(defaults)
  const items = providers.flatMap((p) => p.models.map((m) => ({ value: m.id, label: `${m.name} · ${p.name}` })))
  const clash = sameFamily(draft.run, draft.verify)
  const dirty = ROLES.some((role) => draft[role.id] !== defaults[role.id])
  return (
    <DetailSection title="默认用哪个模型" description="三方验收不能和执行用同一家的模型：同一家容易犯同样的错，验收看不出来，就不算第三方了。"
      action={!readOnly && <Button size="sm" disabled={!dirty || clash} onClick={() => onSave(draft)}><SaveIcon data-icon="inline-start" />保存</Button>}>
      <FieldGroup>
        {ROLES.map((role) => {
          const invalid = role.id === "verify" && clash
          return (
            <Field key={role.id} data-invalid={invalid}>
              <FieldLabel>{role.label}</FieldLabel>
              <Select items={items} value={draft[role.id]} disabled={readOnly} onValueChange={(next) => next && setDraft({ ...draft, [role.id]: String(next) })}>
                <SelectTrigger className="w-full sm:w-96" aria-invalid={invalid}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectGroup key={p.id}>
                      <SelectLabel>{p.name}</SelectLabel>
                      {p.models.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{role.hint} 家族：{modelFamily(draft[role.id])}</FieldDescription>
              {invalid && (
                <FieldError>
                  执行用的 {nameOf(draft.run)} 也是 {modelFamily(draft.run)} 家的。同一家容易犯同样的错，验收看不出来，就不算第三方了。请换一家，换好才能保存。
                </FieldError>
              )}
            </Field>
          )
        })}
      </FieldGroup>
    </DetailSection>
  )
}

const STATUS_BADGE = {
  ok: { variant: "outline", icon: CircleCheckIcon, label: "已连接" },
  error: { variant: "destructive", icon: TriangleAlertIcon, label: "连不上" },
  unconfigured: { variant: "outline", icon: CircleDashedIcon, label: "未配置" },
} as const

function ProviderDetail({ provider, tasks, defaults, actions, onTest }: {
  provider: Provider; tasks: TaskDef[]; defaults: Defaults; actions: React.ReactNode; onTest: () => void
}) {
  const used = tasksOnProvider(provider, tasks)
  const defaultRoles = ROLES.filter((role) => provider.models.some((m) => m.id === defaults[role.id]))
  const status = STATUS_BADGE[provider.status]

  return (
    <DetailPanel
      title={provider.name}
      badges={<Badge variant={status.variant}><status.icon data-icon="inline-start" />{status.label}</Badge>}
      meta={`${KIND_LABEL[provider.kind]} · ${provider.models.length} 个模型 · ${provider.checkedAt ? `上次检查 ${fmtDateTime(provider.checkedAt)}` : "还没检查过"}`}
      actions={actions}
    >
      <DetailSection title="连接" action={
        <Button size="sm" variant="outline" onClick={onTest}>
          <PlugZapIcon data-icon="inline-start" />
          测试连接
        </Button>
      }>
        <dl className="flex flex-wrap gap-x-10 gap-y-3">
          {connectionRows(provider).map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-all">{value}</dd></div>
          ))}
        </dl>
      </DetailSection>
      <DetailSection title="可用模型" description="价格是每百万 token 的输入 / 输出（美元）。">
        {provider.models.length === 0 ? (
          <p className="text-muted-foreground">还没有模型：这个服务还没配好，填好地址、连上以后会读出能用的模型。</p>
        ) : (
        <Table>
          <TableHeader>
            <TableRow><TableHead>模型</TableHead><TableHead>适合干什么</TableHead><TableHead>上下文</TableHead><TableHead>价格</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {provider.models.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    {m.name}
                    {ROLES.filter((role) => defaults[role.id] === m.id).map((role) => <Badge key={role.id} variant="secondary">默认{role.label}</Badge>)}
                  </div>
                </TableCell>
                <TableCell className="whitespace-normal">{m.note}</TableCell>
                <TableCell>{contextText(m)}</TableCell>
                <TableCell>{priceText(m)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        )}
      </DetailSection>
      <DetailSection title="被哪些任务用了">
        <div className="flex flex-col gap-2">
          {used.length === 0 && <p className="text-muted-foreground">还没有任务直接选用这里的模型。</p>}
          {used.map((task) => (
            <p key={task.id}>
              <a href={href("tasks", { id: task.id })} className={LINK}>{task.title}</a>
              <span className="text-xs text-muted-foreground"> · {provider.models.find((m) => m.id === task.modelId)?.name}</span>
            </p>
          ))}
          {defaultRoles.length > 0 && (
            <p className="text-xs text-muted-foreground">
              默认设置里：{defaultRoles.map((role) => `${role.label}用 ${provider.models.find((m) => m.id === defaults[role.id])?.name}`).join("，")}。
            </p>
          )}
        </div>
      </DetailSection>
    </DetailPanel>
  )
}
