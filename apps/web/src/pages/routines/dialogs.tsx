// 流程页的几个弹窗（docs/dev/routine-library.md 9.1）：改名字和说明、版本记录（回到以前的版本）、调用记录。
// 改名字：React Hook Form + shared 的 routineLibraryUpdateInputSchema；回到以前的版本：先 preview 列出不兼容的改动和受影响的，AlertDialog 确认后 publish；
// 调用记录：routineLibrary.calls 分页（新的在前），可以按调用的任务筛。
import * as React from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { RotateCcwIcon, TriangleAlertIcon } from "lucide-react"
import {
  fmtDateTime,
  routineCallViaLabel,
  routineLibraryUpdateInputSchema,
  routineStopKindLabel,
  type RoutineLibraryDetail,

} from "@heyagent/shared"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useToolName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href } from "@/lib/router"
import { trpc } from "@/lib/trpc"
import { TextLink } from "@/pages/sessions/parts"

import { CallResultBadge, secondsText } from "./parts"
import { Affected } from "./publish-dialog"

// ---------- 改名字和「什么时候用」 ----------

export function EditDialog({ entry, open, onOpenChange }: { entry: RoutineLibraryDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const form = useForm<{ routineId: string; title: string; summary: string }>({
    resolver: zodResolver(routineLibraryUpdateInputSchema),
    defaultValues: { routineId: entry.routineId, title: entry.title, summary: entry.summary },
  })
  const { errors } = form.formState
  const update = useAction(trpc.routineLibrary.update.mutationOptions(), { success: "已保存，下一次运行开始用新的名字和说明" })
  const submit = form.handleSubmit(async (values) => {
    if (await update.submit(values)) onOpenChange(false)
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>改名字和说明</DialogTitle>
          <DialogDescription>短名 {entry.toolId} 不能改：任务、规则、脚本都按它引用。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field data-invalid={!!errors.title}>
              <FieldLabel htmlFor="library-title">名字</FieldLabel>
              <Input id="library-title" aria-invalid={!!errors.title} {...form.register("title")} />
              <FieldError errors={[errors.title]} />
            </Field>
            <Field data-invalid={!!errors.summary}>
              <FieldLabel htmlFor="library-summary">什么时候用</FieldLabel>
              <Textarea id="library-summary" rows={3} aria-invalid={!!errors.summary} {...form.register("summary")} />
              <FieldDescription>给模型看的一句话，agent 平时靠它决定用不用。</FieldDescription>
              <FieldError errors={[errors.summary]} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending && <Spinner data-icon="inline-start" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------- 版本记录 ----------

/** 每发布一次一行：版本、发布的人、时间、当时在用几个任务；不是现在的版本能「回到这一版」（主管） */
export function HistoryDialog({ entry, isAdmin, open, onOpenChange }: { entry: RoutineLibraryDetail; isAdmin: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [restoring, setRestoring] = React.useState<number | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>「{entry.title}」的版本记录</DialogTitle>
          <DialogDescription>每发布一次记一行。发布过的版本都能再发布回去，选用它的任务下一次运行开始用。</DialogDescription>
        </DialogHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>版本</TableHead>
              <TableHead>发布的人</TableHead>
              <TableHead>时间</TableHead>
              <TableHead>当时在用</TableHead>
              <TableHead><span className="sr-only">操作</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entry.publishes.map((row, index) => (
              <TableRow key={`${row.version}-${row.publishedAt}`}>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-1.5">
                    第 {row.version} 版
                    {index === 0 && <Badge variant="outline">现在</Badge>}
                    {row.compat.length > 0 && <Badge variant="secondary" title={row.compat.map((issue) => issue.text).join("；")}>不兼容 {row.compat.length} 处</Badge>}
                  </span>
                </TableCell>
                <TableCell>{row.publishedBy?.name ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{fmtDateTime(row.publishedAt)}</TableCell>
                <TableCell className="tabular-nums">{row.taskCount} 个任务</TableCell>
                <TableCell className="text-right">
                  {isAdmin && row.version !== entry.publishedVersion && (
                    <Button variant="outline" size="sm" onClick={() => setRestoring(row.version)}>
                      <RotateCcwIcon data-icon="inline-start" />回到这一版
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {restoring !== null && <RestoreDialog key={restoring} entry={entry} version={restoring} onClose={() => setRestoring(null)} />}
      </DialogContent>
    </Dialog>
  )
}

/** 回到以前的版本：preview 列出不兼容的改动和受影响的，有不兼容的要勾确认 */
function RestoreDialog({ entry, version, onClose }: { entry: RoutineLibraryDetail; version: number; onClose: () => void }) {
  const toolName = useToolName()
  const [accept, setAccept] = React.useState(false)
  const preview = useQuery(trpc.routineLibrary.preview.queryOptions({ routineId: entry.routineId, version }))
  const publish = useAction(trpc.routineLibrary.publish.mutationOptions({ onSuccess: onClose }), { success: `已回到第 ${version} 版，选用它的任务下一次运行开始用`, errorTitle: "没能回到这一版" })
  const breaking = (preview.data?.compat.length ?? 0) > 0
  const problems = preview.data?.problems ?? []
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>回到第 {version} 版？</AlertDialogTitle>
          <AlertDialogDescription>换下现在的第 {entry.publishedVersion} 版。正在跑的运行不受影响，选用它的任务从下一次运行开始用第 {version} 版。</AlertDialogDescription>
        </AlertDialogHeader>
        {preview.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : preview.isError ? (
          <Alert variant="destructive"><TriangleAlertIcon /><AlertTitle>没查到换回去的影响</AlertTitle><AlertDescription>{preview.error.message}</AlertDescription></Alert>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            {problems.length > 0 && (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>现在不能发布这一版</AlertTitle>
                <AlertDescription><ul className="list-disc pl-5">{problems.map((text) => <li key={text}>{text}</li>)}</ul></AlertDescription>
              </Alert>
            )}
            {breaking && <ul className="list-disc pl-5">{preview.data.compat.map((issue) => <li key={`${issue.kind}-${issue.field}`}>{issue.text}</li>)}</ul>}
            <Affected affected={preview.data.affected} toolName={toolName} />
            {breaking && (
              <Field orientation="horizontal">
                <Checkbox id="restore-accept" checked={accept} onCheckedChange={(checked) => setAccept(checked === true)} />
                <FieldLabel htmlFor="restore-accept">我知道这些任务会受影响</FieldLabel>
              </Field>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>先不换</AlertDialogCancel>
          <AlertDialogAction
            disabled={publish.isPending || !preview.data || problems.length > 0 || (breaking && !accept)}
            onClick={() => publish.mutate({ routineId: entry.routineId, version, title: entry.title, summary: entry.summary, acceptBreaking: breaking ? true : undefined })}
          >
            {publish.isPending ? <Spinner data-icon="inline-start" /> : <RotateCcwIcon data-icon="inline-start" />}回到第 {version} 版
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------- 调用记录 ----------

const ALL = "all"

/** 全部调用记录（新的在前，一页 50 条），可以按调用的任务筛；每行点进那次运行 */
export function CallsDialog({ entry, open, onOpenChange }: { entry: RoutineLibraryDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [taskId, setTaskId] = React.useState<string>(ALL)
  const calls = useInfiniteQuery(
    trpc.routineLibrary.calls.infiniteQueryOptions(
      { routineId: entry.routineId, taskId: taskId === ALL ? undefined : taskId },
      { enabled: open, getNextPageParam: (page) => page.nextCursor ?? undefined }
    )
  )
  const taskItems = [{ value: ALL, label: "全部任务" }, ...entry.stats.byTask.map((row) => ({ value: row.taskId, label: `${row.taskId} ${row.title}` }))]
  const rows = calls.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>「{entry.title}」的调用记录</DialogTitle>
          <DialogDescription>agent 调、脚本调都算；库流程里再调别的库流程，两层各记一次。</DialogDescription>
        </DialogHeader>
        <Select items={taskItems} value={taskId} onValueChange={(value) => value && setTaskId(String(value))}>
          <SelectTrigger className="w-full sm:w-72" aria-label="按调用的任务筛">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {taskItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {calls.isPending ? (
          <div className="flex flex-col gap-2">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-8 w-full" />)}</div>
        ) : calls.isError ? (
          <Alert variant="destructive"><TriangleAlertIcon /><AlertTitle>调用记录没取到</AlertTitle><AlertDescription>{calls.error.message}</AlertDescription></Alert>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有调用记录。</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>运行</TableHead>
                  <TableHead>怎么调</TableHead>
                  <TableHead>结局</TableHead>
                  <TableHead>步数 · 用时</TableHead>
                  <TableHead>停下的原因</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((call) => (
                  <TableRow key={call.id}>
                    <TableCell className="tabular-nums">{fmtDateTime(call.at)}</TableCell>
                    <TableCell>
                      <span className="flex flex-col">
                        <TextLink to={href("sessions", { id: call.sessionId })}>{call.sessionId}</TextLink>
                        <span className="max-w-48 truncate text-xs text-muted-foreground" title={call.taskTitle}>{call.taskTitle}</span>
                      </span>
                    </TableCell>
                    <TableCell>{routineCallViaLabel[call.via]}{call.depth > 1 ? `（第 ${call.depth} 层）` : ""} · 第 {call.version} 版</TableCell>
                    <TableCell><CallResultBadge result={call.result} /></TableCell>
                    <TableCell className="tabular-nums">{call.steps} 步 · {secondsText(call.ms)}</TableCell>
                    <TableCell className="max-w-64 truncate" title={call.stopReason ?? undefined}>
                      {call.stopKind ? `${call.stopStep ? `第 ${call.stopStep} 步 · ` : ""}${call.stopReason ?? routineStopKindLabel[call.stopKind]}` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {calls.hasNextPage && (
              <Button variant="outline" size="sm" className="justify-self-start" disabled={calls.isFetchingNextPage} onClick={() => void calls.fetchNextPage()}>
                {calls.isFetchingNextPage && <Spinner data-icon="inline-start" />}再看更早的
              </Button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
