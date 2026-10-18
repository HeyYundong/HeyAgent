// 上传 zip 包：选文件（或拖进来）→ 可选的补充说明 → 选读包的模型 → 开始读包（上传时显示进度）。
// 重新读包 / 再读一次：同样的补充说明 + 模型，方案作废重读。
// 「打包说明」：给原 agent 的一段话，照着打包 AI 读得更准。
import * as React from "react"
import { FileArchiveIcon, FileTextIcon, RotateCwIcon, TriangleAlertIcon, UploadIcon, XIcon } from "lucide-react"
import { IMPORT_MAX_MB, type ImportRecord } from "@heyagent/shared"

import { ModelCombobox } from "@/components/shell/model-combobox"
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "@/components/ui/code-block"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"

import { useModels } from "@/lib/data"
import { fmtSize } from "@/lib/files"
import { uploadImport } from "@/lib/imports"
import { useAction } from "@/lib/mutations"
import { queryClient, trpc } from "@/lib/trpc"

import { PACK_PROMPT } from "./parts"

const NOTE_PLACEHOLDER = "例如：原来在 Hermes 上跑的，两个任务的负责人都是王悦"
const MODEL_HINT = "包里的文字会发给这个模型（会出境），明文密钥先换成 {{名字}} 再发。一个包一般花几毛钱。"

/** 补充说明 + 用哪个模型读：上传和重新读包共用 */
function ReadFields({ idPrefix, note, onNote, modelId, onModel, disabled }: { idPrefix: string; note: string; onNote: (value: string) => void; modelId: string; onModel: (value: string) => void; disabled?: boolean }) {
  const { models, defaults, modelName } = useModels()
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-note`}>补充说明（可以不写）</FieldLabel>
        <Textarea id={`${idPrefix}-note`} rows={2} maxLength={2000} value={note} disabled={disabled} onChange={(event) => onNote(event.target.value)} placeholder={NOTE_PLACEHOLDER} />
        <FieldDescription>告诉 AI 这个包是什么、负责人是谁，整理得更准。</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-model`}>用哪个模型读</FieldLabel>
        <ModelCombobox
          id={`${idPrefix}-model`}
          models={models}
          value={modelId}
          disabled={disabled}
          onValueChange={onModel}
          clearable
          placeholder={defaults.plan ? `默认：${modelName(defaults.plan)}（规划模型）` : "搜模型名"}
        />
        <FieldDescription>
          {defaults.plan && modelId === defaults.plan ? "默认用「规划」模型。" : ""}
          {MODEL_HINT}
        </FieldDescription>
      </Field>
    </>
  )
}

export function UploadDialog({ open, onOpenChange, onStarted }: { open: boolean; onOpenChange: (open: boolean) => void; onStarted: (record: ImportRecord) => void }) {
  const { defaults } = useModels()
  const pickRef = React.useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = React.useState(false)
  const [file, setFile] = React.useState<File | null>(null)
  const [progress, setProgress] = React.useState<number | null>(null)
  const [error, setError] = React.useState<string>()
  const [note, setNote] = React.useState("")
  const [modelId, setModelId] = React.useState(defaults.plan)
  const [guide, setGuide] = React.useState(false)
  const uploading = progress !== null
  const tooBig = file ? file.size > IMPORT_MAX_MB * 1024 * 1024 : false

  function choose(list: FileList | null) {
    const picked = list?.[0]
    if (!picked) return
    setFile(picked)
    setError(undefined)
  }

  async function start() {
    if (!file || tooBig) return
    setProgress(0)
    setError(undefined)
    try {
      const record = await uploadImport(file, { note, modelId: modelId || undefined }, setProgress)
      await queryClient.invalidateQueries()
      toast.add({ title: "开始读包了", description: "一般 1～3 分钟，读完会通知你来确认。可以先去干别的。", type: "success" })
      onStarted(record)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "没传上去"
      setError(message)
      toast.add({ title: "没传上去", description: message, type: "error" })
    } finally {
      setProgress(null)
    }
  }

  const state = uploading ? "uploading" : error || tooBig ? "error" : "done"
  const description = uploading
    ? `正在上传… ${progress}%`
    : tooBig
      ? `${fmtSize(file!.size)}，超过 ${IMPORT_MAX_MB} MB 了`
      : error
        ? error
        : file
          ? `${fmtSize(file.size)} · 点「开始读包」上传`
          : ""

  return (
    <Dialog open={open} onOpenChange={(next) => !uploading && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>上传 zip 包</DialogTitle>
          <DialogDescription>
            AI 读完会整理成这里的任务、技能、记忆、规则和工具，你一步步确认后才导入。包里怎么放都行，想读得更准，先让原 agent 照
            <Button variant="link" size="xs" onClick={() => setGuide(true)}>
              打包说明
            </Button>
            整理一下。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field data-invalid={Boolean(error || tooBig)}>
            <input
              ref={pickRef}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              className="hidden"
              aria-label="选择 zip 包"
              onChange={(event) => {
                choose(event.target.files)
                event.target.value = ""
              }}
            />
            {file ? (
              <Attachment state={state}>
                <AttachmentMedia>{uploading ? <Spinner /> : error || tooBig ? <TriangleAlertIcon /> : <FileArchiveIcon />}</AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle title={file.name}>{file.name}</AttachmentTitle>
                  <AttachmentDescription title={description}>{description}</AttachmentDescription>
                </AttachmentContent>
                {!uploading && (
                  <AttachmentActions>
                    <AttachmentAction aria-label="换一个包" onClick={() => setFile(null)}>
                      <XIcon />
                    </AttachmentAction>
                  </AttachmentActions>
                )}
              </Attachment>
            ) : (
              <button
                type="button"
                onClick={() => pickRef.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragging(false)
                  choose(event.dataTransfer.files)
                }}
                data-dragging={dragging}
                className="flex flex-col items-center gap-2 border border-dashed p-6 text-sm text-muted-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring data-[dragging=true]:bg-muted"
              >
                <UploadIcon />
                选择 zip 包，或者拖到这里（最大 {IMPORT_MAX_MB} MB）
              </button>
            )}
          </Field>
          <ReadFields idPrefix="import" note={note} onNote={setNote} modelId={modelId} onModel={setModelId} disabled={uploading} />
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={uploading} />}>取消</DialogClose>
          <Button disabled={!file || tooBig || uploading} onClick={() => void start()}>
            {uploading && <Spinner data-icon="inline-start" />}
            开始读包
          </Button>
        </DialogFooter>
        <PackGuideDialog open={guide} onOpenChange={setGuide} />
      </DialogContent>
    </Dialog>
  )
}

/** 重新读包（待确认时）/ 再读一次（没读成时）：方案作废，可以换模型、补一句说明 */
export function RereadDialog({ record, open, onOpenChange }: { record: ImportRecord; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [note, setNote] = React.useState(record.note)
  const [modelId, setModelId] = React.useState(record.modelId)
  const reread = useAction(trpc.imports.reread.mutationOptions(), { success: "开始重新读包了，读完会通知你", errorTitle: "没能重新读包" })
  const again = record.status === "failed"

  return (
    <Dialog open={open} onOpenChange={(next) => !reread.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{again ? "再读一次" : "重新读包"}</DialogTitle>
          <DialogDescription>
            {again ? "用同一个包重新读。" : "现在的方案和你确认到一半的改动都会作废，按新的说明重新读一遍。"}可以换个模型、补一句说明。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <ReadFields idPrefix="reread" note={note} onNote={setNote} modelId={modelId} onModel={setModelId} disabled={reread.isPending} />
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={reread.isPending} />}>取消</DialogClose>
          <Button
            disabled={reread.isPending}
            onClick={async () => {
              if (await reread.submit({ id: record.id, note: note.trim(), modelId: modelId || undefined })) onOpenChange(false)
            }}
          >
            {reread.isPending ? <Spinner data-icon="inline-start" /> : <RotateCwIcon data-icon="inline-start" />}
            {again ? "再读一次" : "重新读包"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function PackGuideDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const lines = PACK_PROMPT.split("\n")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>打包说明</DialogTitle>
          <DialogDescription>包里怎么放 AI 都会读；照这样放，读得更准、更快。把下面这段话发给原 agent，让它打包。</DialogDescription>
        </DialogHeader>
        <CodeBlock size="sm">
          <CodeBlockHeader>
            <CodeBlockTitle>
              <FileTextIcon />
              发给原 agent 的话
            </CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton value={PACK_PROMPT} />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-96 font-sans">
            {lines.map((line, index) => (
              <CodeBlockLine key={index}>{line}</CodeBlockLine>
            ))}
          </CodeBlockContent>
        </CodeBlock>
        <DialogFooter>
          <DialogClose render={<Button />}>知道了</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
