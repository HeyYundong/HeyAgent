import * as React from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { ModelProviderKind } from "@heyagent/shared"

import { DEFAULT_URL, KIND_LABEL, type Provider } from "./data"

/** provider 不传就是添加。onSave：校验通过后调用（M0 只读：页面传进来的是统一的只读提示） */
type ProviderDialogProps = { provider?: Provider; onSave: () => void; onClose: () => void }

/** 添加 / 编辑模型服务：类型（Ollama / OpenRouter）、地址、API Key。M1 起保存前先真的测一次连接 */
export function ProviderDialog({ provider, onSave, onClose }: ProviderDialogProps) {
  const [kind, setKind] = React.useState<ModelProviderKind>(provider?.kind ?? "ollama")
  const [baseUrl, setBaseUrl] = React.useState(provider?.baseUrl || DEFAULT_URL[provider?.kind ?? "ollama"])
  const [apiKey, setApiKey] = React.useState("")
  const [submitted, setSubmitted] = React.useState(false)
  const urlBad = submitted && !/^https?:\/\/\S+$/.test(baseUrl.trim())
  const keyMissing = submitted && kind === "openrouter" && !provider && !apiKey.trim()

  function pickKind(next: ModelProviderKind) {
    setKind(next)
    setBaseUrl(DEFAULT_URL[next])
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    const url = baseUrl.trim()
    if (!/^https?:\/\/\S+$/.test(url) || (kind === "openrouter" && !provider && !apiKey.trim())) return
    onSave()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{provider ? `编辑「${provider.name}」` : "添加模型服务"}</DialogTitle>
            <DialogDescription>保存前会先连一次，读出这家能用的模型。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>类型</FieldLabel>
              <ToggleGroup variant="outline" spacing={0} disabled={!!provider} value={[kind]}
                onValueChange={(next) => next[0] && pickKind(next[0] as ModelProviderKind)}>
                {(["ollama", "openrouter"] as const).map((k) => <ToggleGroupItem key={k} value={k}>{KIND_LABEL[k]}</ToggleGroupItem>)}
              </ToggleGroup>
              <FieldDescription>
                {kind === "ollama" ? "公司自己机器上跑的开源模型，免费，数据不出内网。" : "一个 Key 用上 Claude 等云端模型，按 token 付费。"}
              </FieldDescription>
            </Field>
            <Field data-invalid={urlBad}>
              <FieldLabel htmlFor="mp-url">地址</FieldLabel>
              <Input id="mp-url" value={baseUrl} aria-invalid={urlBad} onChange={(event) => setBaseUrl(event.target.value)} />
              {urlBad && <FieldError>填完整地址，以 http:// 或 https:// 开头</FieldError>}
            </Field>
            {kind === "openrouter" ? (
              <Field data-invalid={keyMissing}>
                <FieldLabel htmlFor="mp-key">API Key</FieldLabel>
                <Input id="mp-key" type="password" placeholder={provider ? "不改就留空" : "sk-or-v1-…"} value={apiKey}
                  aria-invalid={keyMissing} onChange={(event) => setApiKey(event.target.value)} />
                {keyMissing ? <FieldError>填 OpenRouter 的 API Key</FieldError> : <FieldDescription>保存后只显示前后几位。</FieldDescription>}
              </Field>
            ) : (
              <FieldDescription>Ollama 不需要 API Key。</FieldDescription>
            )}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>取消</Button>
            <Button type="submit">{provider ? "测试并保存" : "连接并添加"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
