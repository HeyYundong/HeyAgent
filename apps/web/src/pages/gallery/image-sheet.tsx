// 图库右边的抽屉：大图、标签、文本（JSON）、向量，底部「找相似」「编辑」「删除」，更多里是下载原图。
// 上传的人和主管能编辑、删除；别的人只能看和找相似。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { DownloadIcon, EllipsisIcon, PencilIcon, ScanSearchIcon, Trash2Icon } from "lucide-react"
import { can, fmtDateTime, galleryViaLabel, type GalleryImage } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent, CodeBlockCopyButton } from "@/components/ui/code-block"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"

import { useStaffName } from "@/lib/data"
import { fmtSize } from "@/lib/files"
import { useAction } from "@/lib/mutations"
import { setParams } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { EditDialog } from "./edit-dialog"

export function ImageSheetBody({ id, canSearchByImage, onSimilar }: { id: string; canSearchByImage: boolean; onSimilar: () => void }) {
  const query = useQuery(trpc.gallery.get.queryOptions({ id }))
  const tagsQuery = useQuery(trpc.gallery.tags.queryOptions())
  const staffName = useStaffName()
  const { user } = useMe()
  const [editing, setEditing] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const remove = useAction(trpc.gallery.delete.mutationOptions({ onSuccess: () => setParams({ id: null }) }), { success: "已删除" })
  const image = query.data

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="aspect-square w-full" />
      </div>
    )
  }
  if (!image) {
    return (
      <SheetHeader>
        <SheetTitle>找不到这张图</SheetTitle>
        <SheetDescription>{id} 可能已经被删除。</SheetDescription>
      </SheetHeader>
    )
  }

  const canManage = can(user, "gallery.manage", { createdById: image.createdById ?? "" })
  const uploader = image.via === "agent" ? `agent（${image.sessionId ?? "运行"}）` : staffName(image.createdById)

  return (
    <>
      <SheetHeader className="pr-12">
        <div className="flex flex-wrap items-center gap-2 pb-1 text-muted-foreground">
          <span className="font-mono">{image.id}</span>
          {!image.embedded && <Badge variant="outline">还没算向量</Badge>}
        </div>
        <SheetTitle className="break-all">{image.name}</SheetTitle>
        <SheetDescription>
          {image.width}×{image.height} · {fmtSize(image.size)} · {galleryViaLabel[image.via]} · {uploader} · {fmtDateTime(image.createdAt)}
        </SheetDescription>
      </SheetHeader>
      <Separator />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 *:shrink-0">
        <a href={image.url} target="_blank" rel="noreferrer" title="打开原图">
          <img src={image.url} alt={image.name} className="w-full border bg-muted object-contain" />
        </a>
        <DetailSection title="标签">
          {image.tags.length ? (
            <div className="flex flex-wrap gap-1">
              {image.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">没有标签</p>
          )}
        </DetailSection>
        <DetailSection title="文本" description="每张图带的一段 JSON：检索时可以按关键词、包含匹配、字段条件找。">
          {Object.keys(image.text).length ? (
            <CodeBlock size="sm">
              <CodeBlockContent wrap>{JSON.stringify(image.text, null, 2)}</CodeBlockContent>
            </CodeBlock>
          ) : (
            <p className="text-muted-foreground">没有文本</p>
          )}
        </DetailSection>
        <EmbeddingSection id={image.id} embedded={image.embedded} />
      </div>
      <Separator />
      <SheetFooter className="mt-0 flex-row items-center justify-between">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!canSearchByImage} onClick={onSimilar}>
            <ScanSearchIcon data-icon="inline-start" />
            找相似
          </Button>
          {canManage && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <PencilIcon data-icon="inline-start" />
              编辑
            </Button>
          )}
          {canManage && (
            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2Icon data-icon="inline-start" />
              删除
            </Button>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多操作" />}>
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem render={<a href={image.url} download={image.name} />}>
              <DownloadIcon />
              下载原图
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SheetFooter>

      {editing && <EditDialog image={image} tagOptions={tagsQuery.data ?? []} onClose={() => setEditing(false)} />}
      <DeleteDialog image={image} open={confirmDelete} onOpenChange={setConfirmDelete} pending={remove.isPending} onConfirm={() => remove.mutate({ id: image.id })} />
    </>
  )
}

/** 向量只显示前几个数，复制按钮复制整个数组（JSON） */
const EMBEDDING_PREVIEW = 8

function EmbeddingSection({ id, embedded }: { id: string; embedded: boolean }) {
  const query = useQuery({ ...trpc.gallery.embedding.queryOptions({ id }), enabled: embedded })
  const embedding = query.data
  return (
    <DetailSection
      title="向量"
      action={embedding && <CodeBlockCopyButton value={JSON.stringify(embedding.vector)} aria-label={`复制完整向量（${embedding.vector.length} 个数）`} />}
      description={embedding ? `当前 embedding 模型「${embedding.model.name}」算出的 ${embedding.vector.length} 维向量。这里只显示前 ${EMBEDDING_PREVIEW} 个数，点右上角的复制图标复制完整数组（JSON）。` : "当前 embedding 模型算出的向量，以图搜图、比对都用它。"}>
      {!embedded ? (
        <p className="text-muted-foreground">当前模型还没算这张图的向量。</p>
      ) : query.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : query.isError ? (
        <p className="text-muted-foreground">向量没读出来：{query.error.message}</p>
      ) : !embedding ? (
        <p className="text-muted-foreground">当前模型还没算这张图的向量。</p>
      ) : (
        <CodeBlock size="sm">
          <CodeBlockContent wrap>
            [{embedding.vector.slice(0, EMBEDDING_PREVIEW).join(", ")}
            {embedding.vector.length > EMBEDDING_PREVIEW ? `, … 共 ${embedding.vector.length} 个]` : "]"}
          </CodeBlockContent>
        </CodeBlock>
      )}
    </DetailSection>
  )
}

function DeleteDialog({ image, open, onOpenChange, pending, onConfirm }: { image: GalleryImage; open: boolean; onOpenChange: (open: boolean) => void; pending: boolean; onConfirm: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除「{image.name}」？</AlertDialogTitle>
          <AlertDialogDescription>图片文件、文本、标签和向量一起删除，不能撤销。用到这张图 id 的地方会找不到它。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>保留</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={onConfirm}>
            确认删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
