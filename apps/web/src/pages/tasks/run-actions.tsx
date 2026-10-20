// 任务和运行的引擎操作（M1 P3 接 engine-router）：立即运行（可带附件）、立即继续、取消、任务附件、这次运行的文件。
// 任务抽屉、运行详情、Session 页的抽屉、待办看板都用这里的组件，权限照 shared 的 can()（后端也按同样的规则拦）。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { CircleStopIcon, PlayIcon } from "lucide-react"
import { isRunEnded, type SessionSummary, type TaskDef, type UploadedFile } from "@heyagent/shared"

import { FileList, UploadButton } from "@/components/files"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

/** 还没结束的运行（可以取消） */
export const isActive = (run?: SessionSummary) => Boolean(run && !isRunEnded(run.status))

/** 立即运行：成功后打开这次运行的过程，实时看事件 */
export function useStartRun(task: TaskDef) {
  return useAction(
    trpc.engine.runNow.mutationOptions({ onSuccess: ({ sessionId }) => navigate("tasks", { id: task.id, run: sessionId }) }),
    { success: ({ sessionId }) => `已开始运行 ${sessionId}`, errorTitle: "没能开始运行" }
  )
}

/** 立即继续（只对「挂起等待」的运行；「等人处理」的要先去待办里处理那件事） */
export function ResumeButton({ run, size = "default" }: { run: SessionSummary; size?: "sm" | "default" }) {
  const resume = useAction(trpc.engine.resumeNow.mutationOptions(), { success: `${run.id} 已继续，接着刚才的地方做`, errorTitle: "没能继续" })
  return (
    <Button size={size} disabled={resume.isPending} onClick={() => resume.mutate({ sessionId: run.id })}>
      {resume.isPending ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}立即继续
    </Button>
  )
}

/** 取消运行：不可撤回，AlertDialog 二次确认，按钮用 destructive */
export function CancelRunDialog({ run, open, onOpenChange }: { run: SessionSummary; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [reason, setReason] = React.useState("")
  const cancel = useAction(trpc.engine.cancel.mutationOptions({ onSuccess: () => onOpenChange(false) }), { success: `${run.id} 已取消`, errorTitle: "没能取消" })
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>取消运行 {run.id}？</AlertDialogTitle>
          <AlertDialogDescription>取消后这次运行标为失败，不能恢复；在等的事、没处理的待办一起作废。已经做完的操作（发出去的消息、存下的文件）不会撤回。</AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor={`cancel-reason-${run.id}`}>原因（可以不填）</FieldLabel>
          <Textarea id={`cancel-reason-${run.id}`} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel>先不取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={cancel.isPending} onClick={() => cancel.mutate({ sessionId: run.id, reason: reason.trim() || undefined })}>
            {cancel.isPending ? <Spinner data-icon="inline-start" /> : <CircleStopIcon data-icon="inline-start" />}取消运行
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** 带附件运行：先上传（POST /api/files），再把 id 传给 runNow。这些附件只属于这一次运行；任务附件另外每次都带 */
export function RunWithFilesDialog({ task, open, onOpenChange }: { task: TaskDef; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [files, setFiles] = React.useState<UploadedFile[]>([])
  const [note, setNote] = React.useState("")
  const run = useStartRun(task)
  const start = async () => {
    const started = await run.submit({ taskId: task.id, attachmentFileIds: files.map((file) => file.id), note: note.trim() || undefined })
    if (started) onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>带附件运行 {task.id}</DialogTitle>
          <DialogDescription>这次运行额外带上这些文件和一句说明，agent 用「读附件」工具读文件。任务本身的附件照样会带。</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel>这次的附件</FieldLabel>
          <FileList files={files} onRemove={(file) => setFiles((list) => list.filter((each) => each.id !== file.id))} empty={<FieldDescription>还没选文件。文本文件 agent 直接读内容，图片会交给能看图的模型。</FieldDescription>} />
          <div><UploadButton onUploaded={(file) => setFiles((list) => [...list, file])} /></div>
        </Field>
        <Field>
          <FieldLabel htmlFor={`run-note-${task.id}`}>附加说明（可以不填）</FieldLabel>
          <Textarea id={`run-note-${task.id}`} rows={2} placeholder="例如：这次只处理附件里的数据" value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
          <Button disabled={run.isPending} onClick={() => void start()}>
            {run.isPending ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}立即运行
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 任务附件：每次运行都带。负责人和主管能上传、移除；已经开始的运行快照里还有，照样能读 */
export function TaskAttachments({ task, canEdit }: { task: TaskDef; canEdit: boolean }) {
  const list = useQuery(trpc.engine.taskAttachments.queryOptions({ taskId: task.id }))
  const attach = useAction(trpc.engine.attachToTask.mutationOptions(), { success: (file) => `已加上附件 ${file.name}`, errorTitle: "附件没加上" })
  const detach = useAction(trpc.engine.detachFromTask.mutationOptions(), { success: "附件已移除", errorTitle: "附件没移除" })
  if (list.isPending) return <Spinner />
  if (list.isError) return <p className="text-destructive">附件列表没取到，稍后再试。</p>
  return (
    <div className="flex flex-col gap-2">
      <FileList
        files={list.data}
        removingId={detach.isPending ? detach.variables?.fileId : undefined}
        onRemove={canEdit ? (file) => detach.mutate({ taskId: task.id, fileId: file.id }) : undefined}
        empty={<p className="text-muted-foreground">没有附件。{canEdit ? "加上的文件每次运行都会带，agent 用「读附件」工具读。" : ""}</p>}
      />
      {canEdit && <div><UploadButton onUploaded={(file) => attach.submit({ taskId: task.id, fileId: file.id }).then(() => undefined)} /></div>}
    </div>
  )
}

/** 这次运行的文件和附件（engine.sessionFiles）；新文件由实时推送（files 表）自动出现 */
export function SessionFiles({ run }: { run: SessionSummary }) {
  const list = useQuery(trpc.engine.sessionFiles.queryOptions({ sessionId: run.id }))
  if (list.isPending) return <Spinner />
  if (list.isError) return <p className="text-destructive">文件列表没取到，稍后再试。</p>
  const artifacts = list.data.filter((file) => file.kind !== "attachment")
  const attachments = list.data.filter((file) => file.kind === "attachment")
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground">这次运行的文件（{artifacts.length}）</span>
        <FileList files={artifacts} empty={<p className="text-muted-foreground">还没有文件。agent 存的文件、浏览器下载、截图会出现在这里。</p>} />
      </div>
      {attachments.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground">附件（{attachments.length}）</span>
          <FileList files={attachments} />
        </div>
      )}
    </div>
  )
}
