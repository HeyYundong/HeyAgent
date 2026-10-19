// 本对话的设置（docs/dev/copilot.md 10.2）：「以前的对话」旁边的按钮，点开 Popover 改这一段对话用的模型、一次最多几步、最多花多少。
// 空着 / 「跟默认走」= null：模型跟「模型」页的助手默认（没配用规划的），上限跟「设置 → 助手」。
// 已有的对话存到服务器（assistant.updateSettings）；新对话还没发第一句时先记在前端，第一条消息时带上。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery } from "@tanstack/react-query"
import { SaveIcon, Settings2Icon } from "lucide-react"
import { Controller, useForm } from "react-hook-form"
import { assistantChatSettingsFormSchema, type AssistantChatSettings, type AssistantChatSettingsForm, type ModelInfo } from "@heyagent/shared"

import { ModelCombobox } from "@/components/shell/model-combobox"
import { HelpTip } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { useModels } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { queryClient, trpc } from "@/lib/trpc"

interface ChatSettingsButtonProps {
  /** null = 新对话（还没发第一句） */
  chatId: string | null
  /** 现在的设置；null = 还在读这段对话 */
  settings: AssistantChatSettings | null
  disabled?: boolean
  /** 新对话：设置先记在前端 */
  onDraft: (settings: AssistantChatSettings) => void
}

export function ChatSettingsButton({ chatId, settings, disabled, onDraft }: ChatSettingsButtonProps) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="本对话的设置" disabled={disabled || !settings} />} />}>
          <Settings2Icon />
        </TooltipTrigger>
        <TooltipContent>本对话的设置</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle className="flex items-center gap-1">
            本对话的设置
            <HelpTip>只管这一段对话；空着的跟默认走：模型看「模型」页，上限看「设置 → 助手」。</HelpTip>
          </PopoverTitle>
        </PopoverHeader>
        {settings && (
          <SettingsForm
            chatId={chatId}
            settings={settings}
            onSaved={(next) => {
              if (!chatId) onDraft(next)
              setOpen(false)
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

const toForm = (settings: AssistantChatSettings): AssistantChatSettingsForm => ({
  modelId: settings.modelId ?? "",
  maxSteps: settings.maxSteps === null ? "" : String(settings.maxSteps),
  maxCostUsd: settings.maxCostUsd === null ? "" : String(settings.maxCostUsd),
})

/** 模型下拉的第一项「跟默认走（xxx）」：编号是空字符串，选它 = modelId 为 null */
const followItem = (name: string): ModelInfo => ({ id: "", name, note: "", contextK: 0, priceIn: 0, priceOut: 0 })

function SettingsForm({ chatId, settings, onSaved }: { chatId: string | null; settings: AssistantChatSettings; onSaved: (settings: AssistantChatSettings) => void }) {
  const { models } = useModels()
  const defaults = useQuery(trpc.assistant.defaults.queryOptions())
  const form = useForm<AssistantChatSettingsForm, unknown, AssistantChatSettings>({ resolver: zodResolver(assistantChatSettingsFormSchema), defaultValues: toForm(settings) })
  const { errors, isDirty } = form.formState
  const save = useAction(trpc.assistant.updateSettings.mutationOptions(), { success: "已保存，下一句起按新设置", errorTitle: "没保存" })

  const defaultName = defaults.data ? (defaults.data.modelName ?? "还没配") : "…"
  const modelItems = [followItem(`跟默认走（${defaultName}）`), ...models]
  const fallback = (value: number | undefined) => (value === undefined ? "跟默认走" : `跟默认走（${value}）`)

  const submit = form.handleSubmit(async (next) => {
    if (!chatId) return onSaved(next)
    const saved = await save.submit({ id: chatId, ...next })
    if (!saved) return
    // 记录不用重新拉：只把设置写进缓存
    queryClient.setQueryData(trpc.assistant.get.queryKey({ id: chatId }), (old) => (old ? { ...old, modelId: saved.modelId, maxSteps: saved.maxSteps, maxCostUsd: saved.maxCostUsd } : old))
    onSaved(next)
  })

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel htmlFor="assistant-chat-model">模型</FieldLabel>
          <Controller
            control={form.control}
            name="modelId"
            render={({ field }) => <ModelCombobox id="assistant-chat-model" models={modelItems} value={field.value} onValueChange={field.onChange} />}
          />
        </Field>
        <Field data-invalid={!!errors.maxSteps}>
          <FieldLabel htmlFor="assistant-chat-steps">一次最多几步</FieldLabel>
          <InputGroup>
            <InputGroupInput id="assistant-chat-steps" type="number" inputMode="numeric" step="1" placeholder={fallback(defaults.data?.maxSteps)} aria-invalid={!!errors.maxSteps} {...form.register("maxSteps")} />
            <InputGroupAddon align="inline-end">
              <InputGroupText>步</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
          <FieldError errors={[errors.maxSteps]} />
        </Field>
        <Field data-invalid={!!errors.maxCostUsd}>
          <FieldLabel htmlFor="assistant-chat-cost">一次最多花多少</FieldLabel>
          <InputGroup>
            <InputGroupInput id="assistant-chat-cost" type="number" inputMode="decimal" step="0.01" placeholder={fallback(defaults.data?.maxCostUsd)} aria-invalid={!!errors.maxCostUsd} {...form.register("maxCostUsd")} />
            <InputGroupAddon align="inline-end">
              <InputGroupText>美元</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
          <FieldError errors={[errors.maxCostUsd]} />
        </Field>
      </FieldGroup>
      <Button type="submit" size="sm" className="self-end" disabled={!isDirty || save.isPending}>
        {save.isPending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
        保存
      </Button>
    </form>
  )
}
