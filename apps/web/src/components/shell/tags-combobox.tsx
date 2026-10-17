// 多选标签：选中的显示成小标签，可以删；下拉里是已有的标签（带图数）。creatable 时输入新文字会多出一项「新建「xxx」」。
// 照 shadcn 官方 base 版的 Combobox Multiple 例子组合 registry 的 combobox（ComboboxChips + ComboboxChipsInput）。
import * as React from "react"
import { PlusIcon } from "lucide-react"
import { normalizeTags } from "@heyagent/shared"

import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox"

interface TagsComboboxProps {
  id?: string
  value: string[]
  onValueChange: (tags: string[]) => void
  /** 已有的标签（下拉里的选项），count 是用了它的图数 */
  options: { tag: string; count?: number }[]
  /** 能不能输入新标签 */
  creatable?: boolean
  placeholder?: string
  className?: string
  "aria-invalid"?: boolean
}

export function TagsCombobox({ id, value, onValueChange, options, creatable = false, placeholder, className, "aria-invalid": invalid }: TagsComboboxProps) {
  const anchor = useComboboxAnchor()
  const [query, setQuery] = React.useState("")
  const counts = React.useMemo(() => new Map(options.map((option) => [option.tag, option.count])), [options])
  const typed = query.trim()
  const items = React.useMemo(() => {
    const known = [...new Set([...options.map((option) => option.tag), ...value])]
    return creatable && typed && !known.includes(typed) ? [...known, typed] : known
  }, [options, value, creatable, typed])

  return (
    <Combobox<string, true>
      multiple
      autoHighlight
      items={items}
      value={value}
      onInputValueChange={setQuery}
      onValueChange={(next) => onValueChange(normalizeTags(next))}
    >
      <ComboboxChips ref={anchor} className={className}>
        <ComboboxValue>
          {(values: string[]) => (
            <React.Fragment>
              {values.map((tag) => (
                <ComboboxChip key={tag}>{tag}</ComboboxChip>
              ))}
              <ComboboxChipsInput id={id} placeholder={values.length ? undefined : placeholder} aria-invalid={invalid} />
            </React.Fragment>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>{creatable ? "输入文字可以新建标签" : "没有这个标签"}</ComboboxEmpty>
        <ComboboxList>
          {(tag: string) => (
            <ComboboxItem key={tag} value={tag}>
              {counts.has(tag) || value.includes(tag) ? (
                <>
                  {tag}
                  {counts.get(tag) !== undefined && <span className="ml-auto text-muted-foreground">{counts.get(tag)}</span>}
                </>
              ) : (
                <>
                  <PlusIcon />
                  新建「{tag}」
                </>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
