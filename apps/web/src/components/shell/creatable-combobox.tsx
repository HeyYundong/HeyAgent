// 可以输入的下拉：下拉里是已有的选项；输入了新文字时多出一项「新建「xxx」」，选了就成为一个新选项。
// 新选项由页面记住（onCreate 里加进 options），这个组件不存数据。基于 @/components/ui/combobox（Base UI）。
import * as React from "react"
import { PlusIcon } from "lucide-react"

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"

interface Option {
  value: string
  label: string
  /** 「新建「xxx」」这一项 */
  create?: boolean
}

interface CreatableComboboxProps {
  id?: string
  value: string
  onValueChange: (value: string) => void
  /** 已有的选项（重复的会自动去掉） */
  options: string[]
  /** 选了「新建「xxx」」时调用：页面把 xxx 加进 options */
  onCreate: (value: string) => void
  placeholder?: string
  "aria-invalid"?: boolean
}

const sameValue = (a: Option, b: Option) => a.value === b.value

export function CreatableCombobox({
  id,
  value,
  onValueChange,
  options,
  onCreate,
  placeholder,
  "aria-invalid": invalid,
}: CreatableComboboxProps) {
  const [query, setQuery] = React.useState("")

  const existing = React.useMemo(
    () => [...new Set(options.map((option) => option.trim()).filter(Boolean))].map((option) => ({ value: option, label: option })),
    [options]
  )
  const typed = query.trim()
  const canCreate = typed !== "" && !existing.some((option) => option.value === typed)
  const items: Option[] = canCreate ? [...existing, { value: typed, label: `新建「${typed}」`, create: true }] : existing
  // 刚新建、页面还没加进 options 的值，也要能显示
  const selected = value ? (existing.find((option) => option.value === value) ?? { value, label: value }) : null

  return (
    <Combobox<Option>
      items={items}
      value={selected}
      isItemEqualToValue={sameValue}
      autoHighlight
      onInputValueChange={setQuery}
      onValueChange={(option) => {
        if (!option) return
        if (option.create) onCreate(option.value)
        onValueChange(option.value)
      }}
    >
      <ComboboxInput id={id} className="w-full" placeholder={placeholder} aria-invalid={invalid} />
      <ComboboxContent>
        <ComboboxEmpty>没有匹配的选项，输入文字可以新建</ComboboxEmpty>
        <ComboboxList>
          {(option: Option) => (
            <ComboboxItem key={option.create ? "__create" : option.value} value={option}>
              {option.create && <PlusIcon />}
              {option.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
