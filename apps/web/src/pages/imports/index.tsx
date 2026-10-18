// 导入页：把别的 agent 打的 zip 包交给 AI 读懂，整理成这里的任务、技能、记忆、规则和工具，人一步步确认后一次导入（docs/dev/imports.md）。
// 左边是导入记录（每上传一个包一条），右边按状态显示：读包中 → 待确认（向导）→ 已导入（还要做的事、导入了什么）；没读成、已撤销。
// 只有主管能用（导入会建任务和配置），侧边栏放在「管理」组。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { DownloadIcon, EllipsisIcon, LayoutGridIcon, PackageOpenIcon, RotateCwIcon, SquareIcon, Trash2Icon, TriangleAlertIcon, Undo2Icon, UploadIcon } from "lucide-react"
import { can, fmtShort, type ImportDetail, type ImportPlan, type ImportRecord } from "@heyagent/shared"
import { TRPCClientError } from "@trpc/client"

import { DetailPanel, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"

import { useModels, useModelsQuery, useStaffName, useStaffQuery } from "@/lib/data"
import { fmtSize } from "@/lib/files"
import { importFileUrl } from "@/lib/imports"
import { useAction } from "@/lib/mutations"
import { href, navigate, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { money, StatusBadge } from "./parts"
import { FailedView, ImportedView, ReadingView, UndoneView } from "./result"
import { PackGuideDialog, RereadDialog, UploadDialog } from "./upload-dialog"
import { Wizard } from "./wizard"

const DESCRIPTION = "把别的 agent 打的 zip 包交给 AI 读懂，整理成这里的任务、技能、记忆、规则和工具；你一步步确认后才导入。"

export default function ImportsPage() {
  const { user } = useMe()
  const isAdmin = can(user, "config.manage", {})
  if (!isAdmin)
    return (
      <div className="flex flex-1 flex-col gap-6">
        <SimpleHeader title="导入" description={DESCRIPTION} />
        <EmptyState icon={<PackageOpenIcon />} title="只有主管能导入" description="导入会新建任务、技能、记忆、规则和工具，所以只有主管能用。" />
      </div>
    )
  return <AdminImports />
}

function AdminImports() {
  const { params } = useRoute()
  const listQuery = useQuery(trpc.imports.list.queryOptions())
  const modelsQuery = useModelsQuery()
  const staffQuery = useStaffQuery()
  const [uploading, setUploading] = React.useState(false)
  const [guide, setGuide] = React.useState(false)
  const records = listQuery.data ?? []
  const selectedId = params.get("id")
  const selected = records.find((record) => record.id === selectedId)
  const staffName = useStaffName()

  const header = (
    <SimpleHeader
      title="导入"
      description={DESCRIPTION}
      action={
        <Button onClick={() => setUploading(true)}>
          <UploadIcon data-icon="inline-start" />
          上传 zip 包
        </Button>
      }
    />
  )

  return (
    <PageFrame
      header={header}
      queries={[listQuery, modelsQuery, staffQuery]}
      isEmpty={records.length === 0}
      empty={
        <EmptyState
          icon={<PackageOpenIcon />}
          title="还没有导入过"
          description="别的 agent 的任务想搬过来？让它把任务、技能、记忆、配置打成一个 zip 包，上传后 AI 读懂、整理好，你一步步确认就能导入。"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => setUploading(true)}>
                <UploadIcon data-icon="inline-start" />
                上传 zip 包
              </Button>
              <Button variant="outline" onClick={() => setGuide(true)}>
                打包说明
              </Button>
            </div>
          }
        />
      }
    >
      <MasterDetail
        hasSelection={Boolean(selectedId)}
        emptyHint="从左边选一次导入；要导入新的包，点右上角「上传 zip 包」"
        list={
          <PickGroup>
            {records.map((record) => (
              <PickItem
                key={record.id}
                to={href("imports", { id: record.id })}
                selected={record.id === selectedId}
                title={record.name ?? record.fileName}
                description={record.name ? `${record.fileName} · ${fmtShort(record.createdAt)}` : `${fmtShort(record.createdAt)} · ${fmtSize(record.size)}`}
                badge={<StatusBadge status={record.status} />}
              />
            ))}
          </PickGroup>
        }
        detail={selectedId ? <ImportDetailView key={selectedId} id={selectedId} record={selected} staffName={staffName} /> : null}
      />
      <UploadDialog
        key={uploading ? "open" : "closed"}
        open={uploading}
        onOpenChange={setUploading}
        onStarted={(record) => {
          setUploading(false)
          navigate("imports", { id: record.id })
        }}
      />
      <PackGuideDialog open={guide} onOpenChange={setGuide} />
    </PageFrame>
  )
}

const isNotFound = (error: unknown) => error instanceof TRPCClientError && error.data?.code === "NOT_FOUND"

function ImportDetailView({ id, record, staffName }: { id: string; record?: ImportRecord; staffName: (id: string | undefined) => string }) {
  const detailQuery = useQuery(trpc.imports.get.queryOptions({ id }))
  const { modelName } = useModels()
  const [confirming, setConfirming] = React.useState<"abandon" | "undo" | null>(null)
  const [rereading, setRereading] = React.useState(false)
  const stop = useAction(trpc.imports.stop.mutationOptions(), { success: "停止读包了", errorTitle: "没停下来" })
  const abandon = useAction(trpc.imports.abandon.mutationOptions(), { success: "已放弃这次导入", errorTitle: "没放弃成" })
  const undo = useAction(trpc.imports.undo.mutationOptions(), { success: "已撤销导入", errorTitle: "没撤销成" })
  const detail = detailQuery.data
  const shown = detail ?? record

  if (detailQuery.isError && !detail)
    return (
      <Alert variant={isNotFound(detailQuery.error) ? "default" : "destructive"}>
        <TriangleAlertIcon />
        <AlertTitle>{isNotFound(detailQuery.error) ? "这次导入不在了" : "加载失败"}</AlertTitle>
        <AlertDescription>{isNotFound(detailQuery.error) ? "可能已经被放弃、删掉了。从左边选别的导入。" : "网络不稳定，没拿到这次导入的详情。"}</AlertDescription>
      </Alert>
    )
  if (!shown)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )

  const status = shown.status
  const firstTask = detail?.result?.tasks[0]?.id

  return (
    <DetailPanel
      title={shown.name ?? shown.fileName}
      badges={<StatusBadge status={status} />}
      meta={
        <>
          {[shown.fileName, shown.fileCount ? `${shown.fileCount} 个文件` : null, fmtSize(shown.size)].filter(Boolean).join(" · ")} · {staffName(shown.createdById)} 上传于 {fmtShort(shown.createdAt)}
          {shown.importedAt && `，导入于 ${fmtShort(shown.importedAt)}`}
          {shown.undoneAt && `，撤销于 ${fmtShort(shown.undoneAt)}`} · 用 {modelName(shown.modelId)} 读，花费 {money(shown.costUsd)}
          {shown.note && (
            <>
              <br />
              补充说明：{shown.note}
            </>
          )}
        </>
      }
      actions={
        <>
          {status === "imported" && firstTask && (
            <Button variant="outline" size="sm" nativeButton={false} render={<a href={href("tasks", { id: firstTask })} />}>
              <LayoutGridIcon data-icon="inline-start" />
              去看任务
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="这次导入的更多操作" />}>
              {stop.isPending || abandon.isPending || undo.isPending ? <Spinner /> : <EllipsisIcon />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {status === "reading" && (
                <DropdownMenuItem onClick={() => stop.mutate({ id })}>
                  <SquareIcon />
                  停止读包
                </DropdownMenuItem>
              )}
              {status === "review" && (
                <DropdownMenuItem onClick={() => setRereading(true)}>
                  <RotateCwIcon />
                  重新读包
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => window.location.assign(importFileUrl(id))}>
                <DownloadIcon />
                下载原包
              </DropdownMenuItem>
              {(status === "review" || status === "failed" || status === "undone") && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirming("abandon")}>
                    <Trash2Icon />
                    放弃这次导入
                  </DropdownMenuItem>
                </>
              )}
              {status === "imported" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirming("undo")}>
                    <Undo2Icon />
                    撤销这次导入
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      {!detail ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <StatusBody detail={detail} onReread={() => setRereading(true)} />
      )}
      {shown && (
        <RereadDialog key={rereading ? "open" : "closed"} record={shown} open={rereading} onOpenChange={setRereading} />
      )}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          {confirming === "abandon" ? (
            <AlertDialogHeader>
              <AlertDialogTitle>放弃这次导入？</AlertDialogTitle>
              <AlertDialogDescription>
                {status === "undone" ? "这次导入已经撤销了。" : "还没导入，什么都没建。"}放弃后这条记录、上传的包和从包里取出的密钥都删掉，确认到一半的改动也没了。删掉后不能恢复。
              </AlertDialogDescription>
            </AlertDialogHeader>
          ) : (
            <AlertDialogHeader>
              <AlertDialogTitle>撤销导入「{shown.name ?? shown.fileName}」？</AlertDialogTitle>
              <AlertDialogDescription>
                会删掉这次导入新建的任务、技能、记忆、规则、工具和密钥；用的已有配置不动。导入的任务已经跑过的只停用，运行记录留着；还被别的任务用着的配置也留着。更新成新一版的技能会恢复成导入前的内容。删掉后不能恢复。
              </AlertDialogDescription>
            </AlertDialogHeader>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const which = confirming
                setConfirming(null)
                if (which === "abandon") {
                  if (await abandon.submit({ id })) navigate("imports")
                } else if (which === "undo") {
                  await undo.submit({ id })
                }
              }}
            >
              {confirming === "abandon" ? <Trash2Icon data-icon="inline-start" /> : <Undo2Icon data-icon="inline-start" />}
              {confirming === "abandon" ? "放弃" : "撤销导入"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailPanel>
  )
}

function StatusBody({ detail, onReread }: { detail: ImportDetail; onReread: () => void }) {
  if (detail.status === "reading") return <ReadingView detail={detail} />
  if (detail.status === "failed") return <FailedView detail={detail} onRetry={onReread} />
  if (detail.status === "imported") return <ImportedView detail={detail} />
  if (detail.status === "undone") return <UndoneView detail={detail} />
  if (!detail.plan)
    return (
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>没有导入方案</AlertTitle>
        <AlertDescription>这次导入是待确认，但没找到方案。从「⋯」重新读包。</AlertDescription>
      </Alert>
    )
  // 重新读过一遍就是新的方案：换个 key，页面上的草稿从新方案开始
  return <Wizard key={`${detail.id}:${detail.readAt ?? ""}`} detail={detail as ImportDetail & { plan: ImportPlan }} />
}
