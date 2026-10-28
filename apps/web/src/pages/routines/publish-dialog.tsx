// 发布到流程库 / 发布新版本（docs/dev/routine-library.md 9.1、9.2）：主管才有。
// 第一次发布：选来源任务（只列有转过正式版本的，routineLibrary.candidates）→ 版本（只列转过正式的）→ 名字、短名（第一次才能填）、什么时候用。
// 下面只读地列出 routineLibrary.preview 随填随查的结果：要的工具、风险、会改东西的步骤；新版本再列不兼容的改动和受影响的任务、流程，
// 要勾「我知道这些任务会受影响」才能发。程序检查不过（problems）写原因、按钮置灰。
// 表单：React Hook Form + shared 的 routineLibraryPublishInputSchema。
import * as React from "react"
import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch, type Control } from "react-hook-form"
import { TriangleAlertIcon, UploadIcon } from "lucide-react"
import {
  defaultLibrarySummary,
  defaultRoutineSlug,
  riskLabel,
  routineLibraryPublishInputSchema,
  routineToolId,
  routineVersionId,
  type RoutineLibraryCandidate,
  type RoutineLibraryPreview,
  type RoutineLibraryPublishInput,
} from "@heyagent/shared"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useToolName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { requiresText } from "./parts"

const sameCandidate = (a: RoutineLibraryCandidate, b: RoutineLibraryCandidate) => a.routineId === b.routineId

/** 停下来不打字 400 毫秒再查短名 */
function useDebounced<T>(value: T, ms = 400) {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return debounced
}

/**
 * routineId / version 传了就是从详情、来源任务那里打开的（来源任务、版本已选好，来源任务不能换）；不传就是第一次发布、自己选。
 * 外面按 open 换 key，每次打开都是新的表单
 */
export function PublishDialog({ open, onOpenChange, routineId: fixedRoutine, version: fixedVersion }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  routineId?: string
  version?: number
}) {
  const toolName = useToolName()
  const candidates = useQuery(trpc.routineLibrary.candidates.queryOptions(undefined, { enabled: open }))
  const form = useForm<RoutineLibraryPublishInput>({
    resolver: zodResolver(routineLibraryPublishInputSchema),
    defaultValues: { routineId: fixedRoutine ?? "", version: fixedVersion ?? 0, slug: "", title: "", summary: "", acceptBreaking: false },
  })
  const { errors, dirtyFields } = form.formState
  const [routineId, version, slug, acceptBreaking] = useWatch({ control: form.control, name: ["routineId", "version", "slug", "acceptBreaking"] })
  const candidate = candidates.data?.find((each) => each.routineId === routineId)
  const listed = candidate?.library ?? null
  // 已经在库里（撤下的也算）：名字、什么时候用默认取登记上的；短名不能改
  const detail = useQuery(trpc.routineLibrary.get.queryOptions({ routineId }, { enabled: open && Boolean(listed) }))
  const versionRow = useQuery(trpc.routine.version.queryOptions({ id: routineVersionId(routineId, version) }, { enabled: open && Boolean(routineId) && version > 0 }))
  const slugForPreview = useDebounced(listed ? undefined : (slug ?? ""))
  const preview = useQuery(trpc.routineLibrary.preview.queryOptions({ routineId, version, slug: slugForPreview }, { enabled: open && Boolean(routineId) && version > 0 }))

  // 换了来源任务：版本选最新的转正式版本，短名、名字填默认的
  React.useEffect(() => {
    if (!candidate) return
    if (!candidate.versions.some((each) => each.version === form.getValues("version"))) form.setValue("version", candidate.versions[0]?.version ?? 0)
    form.setValue("slug", candidate.library ? undefined : defaultRoutineSlug(candidate.name, candidate.routineId))
    if (!candidate.library) form.setValue("title", candidate.name)
  }, [candidate, form])
  // 在库里的：名字、什么时候用取登记上的（人没改过才填）
  React.useEffect(() => {
    if (!detail.data) return
    if (!form.getFieldState("title").isDirty) form.setValue("title", detail.data.title)
    if (!form.getFieldState("summary").isDirty) form.setValue("summary", detail.data.summary)
  }, [detail.data, form])
  // 第一次发布：什么时候用默认取流程的名字，没有就用来源任务的标题（4.2；步骤说明的第一行说的是怎么做，不合适）
  React.useEffect(() => {
    if (listed || !versionRow.data || dirtyFields.summary) return
    form.setValue("summary", defaultLibrarySummary({ name: versionRow.data.name, taskTitle: candidate?.taskTitle }))
  }, [versionRow.data, candidate?.taskTitle, listed, dirtyFields.summary, form])

  const compat = preview.data?.compat ?? []
  const problems = preview.data?.problems ?? []
  const blocked = !preview.data || problems.length > 0 || (compat.length > 0 && !acceptBreaking)
  const publish = useAction(trpc.routineLibrary.publish.mutationOptions(), { success: (data) => `已发布第 ${data.version} 版，选用它的任务下一次运行开始用`, errorTitle: "没发布成" })

  const submit = form.handleSubmit(async (values) => {
    const done = await publish.submit({ ...values, slug: listed ? undefined : values.slug, acceptBreaking: compat.length > 0 ? values.acceptBreaking : undefined })
    if (done) {
      onOpenChange(false)
      navigate("routines", { id: done.routineId })
    }
  })

  const isNew = !listed
  const versionItems = (candidate?.versions ?? []).map((each) => ({ value: String(each.version), label: `第 ${each.version} 版${each.name && each.name !== candidate?.name ? `「${each.name}」` : ""}` }))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? "发布到流程库" : `发布「${detail.data?.title ?? candidate?.name ?? ""}」的新版本`}</DialogTitle>
          <DialogDescription>
            发布后它变成一个工具，别的任务在「用哪些 → 流程」里选上就能用；选用它的任务从下一次运行开始用这一版。在别的任务里跑时，按那个任务的规则、白名单和 Chrome 配置。
          </DialogDescription>
        </DialogHeader>
        {candidates.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : candidates.isError ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>能发布的流程没取到</AlertTitle>
            <AlertDescription>{candidates.error.message}</AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field data-invalid={!!errors.routineId}>
                  <FieldLabel htmlFor="publish-source">来源任务</FieldLabel>
                  {fixedRoutine ? (
                    <Input id="publish-source" readOnly value={candidate ? `${candidate.taskId} ${candidate.taskTitle}` : fixedRoutine} />
                  ) : (
                    <Combobox<RoutineLibraryCandidate>
                      items={candidates.data}
                      value={candidate ?? null}
                      isItemEqualToValue={sameCandidate}
                      itemToStringLabel={(each) => `${each.taskId} ${each.taskTitle}`}
                      autoHighlight
                      onValueChange={(each) => form.setValue("routineId", each?.routineId ?? "", { shouldValidate: true })}
                    >
                      <ComboboxInput id="publish-source" className="w-full" placeholder="搜任务名或编号" aria-invalid={!!errors.routineId} />
                      <ComboboxContent>
                        <ComboboxEmpty>没有转过正式的固化流程</ComboboxEmpty>
                        <ComboboxList>
                          {(each: RoutineLibraryCandidate) => (
                            <ComboboxItem key={each.routineId} value={each}>
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate">{each.taskTitle}</span>
                                <span className="truncate text-muted-foreground">{each.taskId} · {each.name}{each.library ? ` · 已在库里（${routineToolId(each.library.slug)}）` : ""}</span>
                              </span>
                            </ComboboxItem>
                          )}
                        </ComboboxList>
                      </ComboboxContent>
                    </Combobox>
                  )}
                  <FieldDescription>只列固化流程转过正式（连着 3 次脚本直接办成）的任务。</FieldDescription>
                  {errors.routineId && <FieldError errors={[{ message: "先选来源任务" }]} />}
                </Field>
                <Field data-invalid={!!errors.version}>
                  <FieldLabel htmlFor="publish-version">版本</FieldLabel>
                  <Select items={versionItems} value={version ? String(version) : null} onValueChange={(value) => value && form.setValue("version", Number(value), { shouldValidate: true })}>
                    <SelectTrigger id="publish-version" className="w-full" disabled={!candidate}>
                      <SelectValue placeholder="先选来源任务" />
                    </SelectTrigger>
                    <SelectContent>
                      {versionItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {listed ? `库里现在是第 ${listed.publishedVersion} 版。选以前发布过的就是回到那一版。` : "只列转过正式的版本。"}
                  </FieldDescription>
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field data-invalid={!!errors.title}>
                  <FieldLabel htmlFor="publish-title">名字</FieldLabel>
                  <Input id="publish-title" aria-invalid={!!errors.title} {...form.register("title")} />
                  <FieldDescription>任务弹窗、过程里显示的名字。</FieldDescription>
                  <FieldError errors={[errors.title]} />
                </Field>
                <Field data-invalid={!!errors.slug}>
                  <FieldLabel htmlFor="publish-slug">短名</FieldLabel>
                  {isNew ? (
                    <InputGroup>
                      <InputGroupAddon><InputGroupText>routine.</InputGroupText></InputGroupAddon>
                      <InputGroupInput id="publish-slug" className="font-mono" aria-invalid={!!errors.slug} {...form.register("slug")} />
                    </InputGroup>
                  ) : (
                    <Input id="publish-slug" className="font-mono" readOnly value={listed ? routineToolId(listed.slug) : ""} />
                  )}
                  <FieldDescription>{isNew ? "英文小写、数字、下划线。它就是工具 id，脚本里 ha.routine 按它调，发布后不能改。" : "发布后不能改。"}</FieldDescription>
                  <FieldError errors={[errors.slug]} />
                </Field>
              </div>
              <Field data-invalid={!!errors.summary}>
                <FieldLabel htmlFor="publish-summary">什么时候用</FieldLabel>
                <Textarea id="publish-summary" rows={2} placeholder="例如：要知道某家工厂报了什么价时用" aria-invalid={!!errors.summary} {...form.register("summary")} />
                <FieldDescription>给模型看的一句话，agent 平时靠它决定用不用。默认是流程的名字，最好改成「要……时用」，写清什么情况下用它。</FieldDescription>
                <FieldError errors={[errors.summary]} />
              </Field>
              {routineId && version > 0 && (
                <PreviewView preview={preview} toolName={toolName} acceptBreaking={Boolean(acceptBreaking)} control={form.control} />
              )}
            </FieldGroup>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
              <Button type="submit" disabled={publish.isPending || blocked}>
                {publish.isPending ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
                发布第 {version || "?"} 版
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 发布前看一眼：要的工具、风险、会改东西的步骤、程序检查、不兼容的改动和受影响的 */
function PreviewView({ preview, toolName, acceptBreaking, control }: {
  preview: UseQueryResult<RoutineLibraryPreview, { message: string }>
  toolName: (id: string) => string
  acceptBreaking: boolean
  control: Control<RoutineLibraryPublishInput>
}) {
  if (preview.isPending) return <Skeleton className="h-24 w-full" />
  if (preview.isError)
    return (
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>没查到发布后的样子</AlertTitle>
        <AlertDescription>{preview.error.message}</AlertDescription>
      </Alert>
    )
  const data = preview.data
  const breaking = data.compat.length > 0
  return (
    <div className="flex flex-col gap-3 border p-3 text-sm">
      <dl className="flex flex-col gap-2">
        <Line label="要的工具">{requiresText(data.requires, toolName)}</Line>
        <Line label="风险"><Badge variant="outline">{riskLabel[data.risk]}</Badge></Line>
        <Line label="会改东西">
          {data.commits.length ? <span className="flex flex-wrap gap-1.5">{data.commits.map((label) => <Badge key={label} variant="secondary">{label}</Badge>)}</span> : "只读，不改东西"}
        </Line>
      </dl>
      {data.problems.length > 0 && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>现在不能发布</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5">{data.problems.map((text) => <li key={text}>{text}</li>)}</ul>
          </AlertDescription>
        </Alert>
      )}
      {breaking && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>和现在库里的版本比，有不兼容的改动</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <ul className="list-disc pl-5">{data.compat.map((issue) => <li key={`${issue.kind}-${issue.field}`}>{issue.text}</li>)}</ul>
            <Affected affected={data.affected} toolName={toolName} />
          </AlertDescription>
        </Alert>
      )}
      {!breaking && (data.affected.tasks.length > 0 || data.affected.routines.length > 0) && <Affected affected={data.affected} toolName={toolName} />}
      {breaking && (
        <Controller
          control={control}
          name="acceptBreaking"
          render={({ field }) => (
            <Field orientation="horizontal">
              <Checkbox id="publish-accept" checked={acceptBreaking} onCheckedChange={(checked) => field.onChange(checked === true)} />
              <FieldContent>
                <FieldLabel htmlFor="publish-accept">我知道这些任务会受影响</FieldLabel>
                <FieldDescription>脚本里调它的流程可能跑不通、交给 agent；开着自动固化的会自动修。</FieldDescription>
              </FieldContent>
            </Field>
          )}
        />
      )}
    </div>
  )
}

const Line = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1 sm:flex-row sm:gap-4">
    <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
    <dd className="min-w-0">{children}</dd>
  </div>
)

/** 受影响的：选了它的任务（发布后缺什么就用不了）、脚本里调它的固化流程。版本记录「回到这一版」也用 */
export function Affected({ affected, toolName }: { affected: RoutineLibraryPreview["affected"]; toolName: (id: string) => string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground">受影响的</span>
      <ul className="flex flex-col gap-1">
        {affected.tasks.map((task) => (
          <li key={task.taskId}>
            任务 {task.taskId}「{task.title}」{task.missing.length ? `：发布后用不了它（缺 ${task.missing.map((id) => (id === "fetch" ? "「允许直接调网站接口」" : id === "vision" ? "「允许看画面」" : `「${toolName(id)}」`)).join("、")}）` : "：下一次运行用新版"}
          </li>
        ))}
        {affected.routines.map((routine) => (
          <li key={`${routine.routineId}-${routine.version}`}>任务 {routine.taskId} 的固化流程「{routine.title}」第 {routine.version} 版：脚本里调它</li>
        ))}
        {affected.tasks.length === 0 && affected.routines.length === 0 && <li>现在没有任务在用它。</li>}
      </ul>
    </div>
  )
}
