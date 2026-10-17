// 选一个模型（可搜索）：模型服务刷新后可能有几百个模型，下拉要能按名字 / id 搜。基于 @/components/ui/combobox（Base UI）。
import type { ModelInfo } from "@heyagent/shared"

import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox"

interface ModelComboboxProps {
  id?: string
  value: string
  onValueChange: (value: string) => void
  models: ModelInfo[]
  placeholder?: string
  disabled?: boolean
  "aria-invalid"?: boolean
  className?: string
  /** 可以清空（清空 = 用默认）：输入框右边多一个 ×，清空时 onValueChange("") */
  clearable?: boolean
}

const sameModel = (a: ModelInfo, b: ModelInfo) => a.id === b.id

export function ModelCombobox({ id, value, onValueChange, models, placeholder = "搜模型名", disabled, "aria-invalid": invalid, className, clearable = false }: ModelComboboxProps) {
  // 选中的模型不在列表里（刷新后下架了）也要显示出来，让人知道要换
  const selected = models.find((model) => model.id === value) ?? (value ? { id: value, name: value, note: "", contextK: 0, priceIn: 0, priceOut: 0 } : null)
  return (
    <Combobox<ModelInfo>
      items={models}
      value={selected}
      disabled={disabled}
      isItemEqualToValue={sameModel}
      itemToStringLabel={(model) => model.name}
      autoHighlight
      filter={(model, query) => {
        const text = query.trim().toLowerCase()
        return !text || model.name.toLowerCase().includes(text) || model.id.toLowerCase().includes(text)
      }}
      onValueChange={(model) => (model ? onValueChange(model.id) : clearable && onValueChange(""))}
    >
      <ComboboxInput id={id} className={className ?? "w-full"} placeholder={placeholder} aria-invalid={invalid} showClear={clearable && !!value} />
      <ComboboxContent>
        <ComboboxEmpty>没有匹配的模型</ComboboxEmpty>
        <ComboboxList>
          {(model: ModelInfo) => (
            <ComboboxItem key={model.id} value={model}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{model.name}</span>
                <span className="truncate text-muted-foreground">{model.id}</span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
