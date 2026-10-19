import * as React from "react"
import { CircleCheckIcon, CircleDashedIcon, CpuIcon, EllipsisIcon, PencilIcon, PlugZapIcon, PlusIcon, RefreshCwIcon, SaveIcon, SearchIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react"

import { ModelCombobox } from "@/components/shell/model-combobox"
import { DetailPanel, DetailSection, EmptyState, HelpTip, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toast } from "@/components/ui/toast"
import { can, findById, fmtDateTime, modelFamily, sameFamily, type ProviderCheck, type TaskDef } from "@heyagent/shared"

import { useModelsQuery, useTasksQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href, setParams, useRoute } from "@/lib/router"
import { trpc } from "@/lib/trpc"
import { useMe } from "@/lib/session"

import { connectionRows, contextText, KIND_LABEL, priceText, providerLine, ROLES, tasksOnProvider, type Defaults, type Provider } from "./data"
import { ProviderDialog } from "./provider-dialog"

const LINK = "underline underline-offset-4 hover:text-foreground"
/** 模型表格默认最多显示几行，其余的靠搜索 */
const TABLE_LIMIT = 50

// 写操作（M1 接通，都只有主管）：添加 / 编辑 / 删除模型服务、测试连接、刷新模型列表、保存默认设置。
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
  // 进来时（没选东西）右边直接显示默认设置；窄屏照样先看列表，所以 hasSelection 不算这种情况
  const showDefaults = id === "defaults" || !id
  const models = providers.flatMap((p) => p.models)
  const nameOf = (modelId: string) => models.find((m) => m.id === modelId)?.name ?? modelId

  // 有任务在用它的模型时后端拒绝删除，toast 里显示是哪些任务
  const removeProvider = useAction(trpc.models.deleteProvider.mutationOptions({ onSuccess: () => setParams({ id: null }) }), { success: "模型服务已删除" })
  const saveDefaults = useAction(trpc.models.setDefaults.mutationOptions(), { success: "默认设置已保存，之后新建的任务按它预选模型" })

  function remove() {
    setConfirmDelete(false)
    if (selected) removeProvider.mutate({ id: selected.id })
  }

  const addButton = <Button onClick={() => setDialog("new")}><PlusIcon data-icon="inline-start" />添加模型服务</Button>

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
    <>
      <PageFrame
        queries={queries}
        isEmpty={providers.length === 0}
        header={
          <SimpleHeader
            title="模型"
            description="agent 用哪些大模型：接入的模型服务，以及新建任务时默认选哪个。"
            learnId="models"
            action={isAdmin && addButton}
          />
        }
        empty={
          isAdmin ? (
            <EmptyState icon={<CpuIcon />} title="还没接入模型服务" action={addButton}
              description="点「添加模型服务」，选 OpenRouter 或直连 Claude、OpenAI、DeepSeek，填 API Key；连上后会读出能用的模型，再到「默认设置」选执行、规划、验收模型。" />
          ) : (
            <EmptyState icon={<CpuIcon />} title="还没接入模型服务" description="还没有模型服务，由主管来接。接好以后 agent 才能干活。" />
          )
        }
      >
        <MasterDetail
          hasSelection={!!selected || id === "defaults"}
          list={
            <>
              <PickGroup>
                <PickItem to={href("models", { id: "defaults" })} selected={showDefaults} title="默认设置"
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
            showDefaults ? (
              <DetailPanel title="默认设置" meta={`新建任务时预先选好的模型，建任务时还能改。${isAdmin ? "" : "只有主管能改默认设置。"}`}>
                <DefaultsSection key={Object.values(defaults).join()} providers={providers} defaults={defaults} readOnly={!isAdmin} nameOf={nameOf}
                  saving={saveDefaults.isPending} onSave={(next) => saveDefaults.mutate(next)} />
              </DetailPanel>
            ) : selected ? (
              <ProviderDetail key={selected.id} provider={selected} tasks={tasks} defaults={defaults} isAdmin={isAdmin} actions={isAdmin && menu} />
            ) : null
          }
        />
      </PageFrame>
      {dialog && (
        <ProviderDialog provider={dialog === "edit" ? selected : undefined} onClose={() => setDialog(null)} />
      )}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{selected?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              {selected && tasksOnProvider(selected, tasks).length > 0
                ? `有 ${tasksOnProvider(selected, tasks).length} 个任务在用它的模型，要先给这些任务换模型才能删。`
                : "没有任务直接选用它的模型。默认设置里用到它的模型会换成别家的。"}
              保存的 API Key 一起删除，不能撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** 改完点「保存」才生效；执行和验收同一家时验收下面报错，保存不了 */
function DefaultsSection({ providers, defaults, readOnly, nameOf, saving, onSave }: {
  providers: Provider[]; defaults: Defaults; readOnly: boolean; nameOf: (id: string) => string; saving: boolean; onSave: (next: Defaults) => void
}) {
  const [draft, setDraft] = React.useState(defaults)
  const models = providers.flatMap((p) => p.models)
  // 图库只能用能处理图片的 embedding 模型
  const embeddingModels = providers.flatMap((p) => p.embeddingModels ?? []).filter((m) => m.vision)
  const clash = sameFamily(draft.run, draft.verify)
  const dirty = ROLES.some((role) => draft[role.id] !== defaults[role.id]) || (draft.embed ?? "") !== (defaults.embed ?? "") || (draft.assistant ?? "") !== (defaults.assistant ?? "")
  return (
    <DetailSection title="默认用哪个模型" description="三方验收不能和执行用同一家的模型：同一家容易犯同样的错，验收看不出来，就不算第三方了。"
      action={!readOnly && (
        <Button size="sm" disabled={!dirty || clash || saving} onClick={() => onSave({ ...draft, embed: draft.embed ?? "", assistant: draft.assistant ?? "" })}>
          {saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
          保存
        </Button>
      )}>
      <FieldGroup>
        {ROLES.map((role) => {
          const invalid = role.id === "verify" && clash
          return (
            <Field key={role.id} data-invalid={invalid}>
              <FieldLabel htmlFor={`default-${role.id}`}>{role.label}</FieldLabel>
              <ModelCombobox id={`default-${role.id}`} className="w-full sm:w-96" models={models} value={draft[role.id]} disabled={readOnly} aria-invalid={invalid}
                onValueChange={(next) => setDraft({ ...draft, [role.id]: next })} />
              <FieldDescription>{role.hint} 家族：{modelFamily(draft[role.id])}</FieldDescription>
              {invalid && (
                <FieldError>
                  执行用的 {nameOf(draft.run)} 也是 {modelFamily(draft.run)} 家的。同一家容易犯同样的错，验收看不出来，就不算第三方了。请换一家，换好才能保存。
                </FieldError>
              )}
            </Field>
          )
        })}
        <Field>
          <div className="flex items-center gap-1">
            <FieldLabel htmlFor="default-assistant">助手</FieldLabel>
            <HelpTip>右下角助手用的模型，不选就用「规划」那个。每段对话还可以在助手的「本对话的设置」里单独换。</HelpTip>
          </div>
          <ModelCombobox id="default-assistant" className="w-full sm:w-96" models={models} value={draft.assistant ?? ""} disabled={readOnly} clearable placeholder={`不选（用规划：${nameOf(draft.plan)}）`}
            onValueChange={(next) => setDraft({ ...draft, assistant: next || undefined })} />
        </Field>
        <Field>
          <FieldLabel htmlFor="default-embed">图库的 embedding 模型</FieldLabel>
          <ModelCombobox id="default-embed" className="w-full sm:w-96" models={embeddingModels} value={draft.embed ?? ""} disabled={readOnly} clearable placeholder="不用（图库不能以图搜图）"
            onValueChange={(next) => setDraft({ ...draft, embed: next || undefined })} />
          <FieldDescription>
            把图片和描述变成向量，图库的以图搜图、比对、按描述找图都用它。只列能处理图片的 embedding 模型。
            换了以后后台用新模型把所有图重算一遍，算完之前检索还用旧模型。
            {embeddingModels.length === 0 && " 现在一个都没有：到 OpenRouter 服务里点「刷新模型列表」。"}
          </FieldDescription>
        </Field>
      </FieldGroup>
    </DetailSection>
  )
}

const STATUS_BADGE = {
  ok: { variant: "outline", icon: CircleCheckIcon, label: "已连接" },
  error: { variant: "destructive", icon: TriangleAlertIcon, label: "连不上" },
  unconfigured: { variant: "outline", icon: CircleDashedIcon, label: "未配置" },
} as const

/** 测试连接、刷新列表的结果：接口不报错，ok 为 false 时 message 里是原因；连上了但有要提醒的事（note）用 warning */
function checkToast(title: { ok: string; fail: string }, check: ProviderCheck) {
  const type = !check.ok ? "error" : check.note ? "warning" : "success"
  toast.add({ title: check.ok ? title.ok : title.fail, description: [check.message, check.note].filter(Boolean).join("。"), type })
}

function ProviderDetail({ provider, tasks, defaults, isAdmin, actions }: {
  provider: Provider; tasks: TaskDef[]; defaults: Defaults; isAdmin: boolean; actions: React.ReactNode
}) {
  const used = tasksOnProvider(provider, tasks)
  const defaultRoles = ROLES.filter((role) => provider.models.some((m) => m.id === defaults[role.id]))
  const status = STATUS_BADGE[provider.status]
  const test = useAction(trpc.models.testProvider.mutationOptions({ onSuccess: (check) => checkToast({ ok: "连接正常", fail: "连不上" }, check) }))
  const refresh = useAction(trpc.models.refreshProvider.mutationOptions({ onSuccess: (check) => checkToast({ ok: "模型列表已刷新", fail: "没刷新成功" }, check) }))
  const [query, setQuery] = React.useState("")
  const text = query.trim().toLowerCase()
  const matched = text ? provider.models.filter((m) => m.name.toLowerCase().includes(text) || m.id.toLowerCase().includes(text)) : provider.models
  const shown = matched.slice(0, TABLE_LIMIT)
  const embeddings = [...(provider.embeddingModels ?? [])].sort((a, b) => Number(b.vision ?? false) - Number(a.vision ?? false))
  const embedDefault = embeddings.find((m) => m.id === defaults.embed)
  const assistantDefault = provider.models.find((m) => m.id === defaults.assistant)

  return (
    <DetailPanel
      title={provider.name}
      badges={<Badge variant={status.variant}><status.icon data-icon="inline-start" />{status.label}</Badge>}
      meta={`${KIND_LABEL[provider.kind]} · ${provider.models.length} 个模型 · ${provider.checkedAt ? `上次检查 ${fmtDateTime(provider.checkedAt)}` : "还没检查过"}`}
      actions={actions}
    >
      <DetailSection title="连接" action={isAdmin && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate({ id: provider.id })}>
            {test.isPending ? <Spinner data-icon="inline-start" /> : <PlugZapIcon data-icon="inline-start" />}
            测试连接
          </Button>
          <Button size="sm" variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate({ id: provider.id })}>
            {refresh.isPending ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            刷新模型列表
          </Button>
        </div>
      )}>
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
          <div className="flex flex-col gap-3">
            <InputGroup className="sm:max-w-sm">
              <InputGroupAddon><SearchIcon /></InputGroupAddon>
              <InputGroupInput aria-label="搜模型" placeholder={`在 ${provider.models.length} 个模型里搜名字或 id`} value={query} onChange={(event) => setQuery(event.target.value)} />
            </InputGroup>
            {matched.length === 0 ? (
              <p className="text-muted-foreground">没有名字或 id 里带「{query.trim()}」的模型。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow><TableHead>模型</TableHead><TableHead>适合干什么</TableHead><TableHead>上下文</TableHead><TableHead>价格</TableHead><TableHead>看图</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1">
                          {m.name}
                          {ROLES.filter((role) => defaults[role.id] === m.id).map((role) => <Badge key={role.id} variant="secondary">默认{role.label}</Badge>)}
                          {defaults.assistant === m.id && <Badge variant="secondary">默认助手</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="w-full max-w-0"><div className="truncate" title={m.note}>{m.note}</div></TableCell>
                      <TableCell>{contextText(m)}</TableCell>
                      <TableCell>{priceText(m)}</TableCell>
                      <TableCell>{m.vision ? "能" : "不能"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {matched.length > shown.length && (
              <p className="text-xs text-muted-foreground">
                只显示前 {shown.length} 个，还有 {matched.length - shown.length} 个{text ? "匹配的" : ""}，输入名字或 id 搜索查看。
              </p>
            )}
          </div>
        )}
      </DetailSection>
      {embeddings.length > 0 && (
        <DetailSection title="embedding 模型" description="把图片、文字变成向量的模型，图库检索用（在「默认设置」里选）。能处理图片的才能以图搜图，排在前面。价格是每百万 token（美元）。">
          <Table>
            <TableHeader>
              <TableRow><TableHead>模型</TableHead><TableHead>能处理图片</TableHead><TableHead>价格</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {embeddings.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      {m.name}
                      {defaults.embed === m.id && <Badge variant="secondary">图库默认</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>{m.vision ? "能" : "不能"}</TableCell>
                  <TableCell>{m.priceIn === 0 ? "免费" : `$${m.priceIn}`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DetailSection>
      )}
      <DetailSection title="被哪些任务用了">
        <div className="flex flex-col gap-2">
          {used.length === 0 && <p className="text-muted-foreground">还没有任务直接选用这里的模型。</p>}
          {used.map((task) => (
            <p key={task.id}>
              <a href={href("tasks", { id: task.id })} className={LINK}>{task.title}</a>
              <span className="text-xs text-muted-foreground"> · {provider.models.find((m) => m.id === task.modelId)?.name}</span>
            </p>
          ))}
          {(defaultRoles.length > 0 || embedDefault || assistantDefault) && (
            <p className="text-xs text-muted-foreground">
              默认设置里：
              {[
                ...defaultRoles.map((role) => `${role.label}用 ${provider.models.find((m) => m.id === defaults[role.id])?.name}`),
                ...(assistantDefault ? [`助手用 ${assistantDefault.name}`] : []),
                ...(embedDefault ? [`图库用 ${embedDefault.name}`] : []),
              ].join("，")}
              。
            </p>
          )}
        </div>
      </DetailSection>
    </DetailPanel>
  )
}
