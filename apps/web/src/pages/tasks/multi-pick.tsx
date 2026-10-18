// 多选（Combobox 多选）：任务弹窗的「用哪些」「谁能派活给它」、导入向导的 Chrome 配置和修改弹窗共用。
import { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxContent, ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxValue, useComboboxAnchor } from "@/components/ui/combobox"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"

export type Option = { value: string; label: string; hint?: string; disabled?: boolean }

/** placeholder：没选时的占位（不写就是「选 xx，可以多选」） */
export function MultiPick({ id, label, options, value, onChange, description, notes, placeholder, hideLabel = false }: {
  id: string
  label: string
  options: Option[]
  value: string[]
  onChange: (value: string[]) => void
  description?: string
  notes?: string[]
  placeholder?: string
  /** 外面已经有标题时（例如导入向导的任务卡片）只给读屏用 */
  hideLabel?: boolean
}) {
  const anchor = useComboboxAnchor()
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v
  return (
    <Field>
      <FieldLabel htmlFor={id} className={hideLabel ? "sr-only" : undefined}>{label}</FieldLabel>
      {/* Base UI 默认按 Esc 会清空全部已选，这里忽略，免得关下拉时把选好的丢掉 */}
      <Combobox multiple items={options.map((o) => o.value)} value={value} onValueChange={(next: string[], details) => details.reason !== "escape-key" && onChange(next)} itemToStringLabel={labelOf}>
        <ComboboxChips ref={anchor}>
          <ComboboxValue>
            {(selected: string[]) => (
              <>
                {selected.map((v) => <ComboboxChip key={v}>{labelOf(v)}</ComboboxChip>)}
                <ComboboxChipsInput id={id} placeholder={selected.length ? "" : options.length ? (placeholder ?? `选${label}，可以多选`) : `还没有可选的${label}`} />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>没有匹配的{label}</ComboboxEmpty>
          <ComboboxList>
            {(v: string) => (
              <ComboboxItem key={v} value={v} disabled={options.find((o) => o.value === v)?.disabled}>
                <span className="flex min-w-0 flex-col">
                  <span>{labelOf(v)}</span>
                  <span className="line-clamp-2 text-muted-foreground">{options.find((o) => o.value === v)?.hint}</span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {description && <FieldDescription>{description}</FieldDescription>}
      {notes?.map((note) => <FieldDescription key={note}>{note}</FieldDescription>)}
    </Field>
  )
}
