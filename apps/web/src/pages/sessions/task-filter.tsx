// 按任务筛 session：下拉里是全部任务（新建的在前），可以按任务名 / 编号搜。会话列表在服务端翻页，前端没有全部 session，所以不写每个任务跑了几次。
// 第一项「全部任务」= 不筛。基于 @/components/ui/combobox（Base UI），和 model-combobox 同一写法。
import * as React from "react"
import { findById, type TaskDef } from "@heyagent/shared"

import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox"

interface Option {
  /** 任务编号；"all" = 全部任务 */
  value: string
  label: string
}

interface TaskFilterProps {
  value: string
  onValueChange: (value: string) => void
  tasks: TaskDef[]
}

const sameOption = (a: Option, b: Option) => a.value === b.value

export function TaskFilter({ value, onValueChange, tasks }: TaskFilterProps) {
  const options = React.useMemo(() => {
    const each = tasks.toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((task) => ({ value: task.id, label: task.title }))
    return [{ value: "all", label: "全部任务" }, ...each]
  }, [tasks])
  // 地址里带的任务删了也显示出来（名字写编号），让人知道筛的是哪个
  const selected = options.find((option) => option.value === value) ?? { value, label: findById(tasks, value)?.title ?? value }

  return (
    <Combobox<Option>
      items={options}
      value={selected}
      isItemEqualToValue={sameOption}
      itemToStringLabel={(option) => option.label}
      autoHighlight
      filter={(option, query) => {
        const text = query.trim().toLowerCase()
        return !text || option.label.toLowerCase().includes(text) || option.value.toLowerCase().includes(text)
      }}
      onValueChange={(option) => onValueChange(option?.value ?? "all")}
    >
      <ComboboxInput className="w-full sm:w-56" placeholder="搜任务名或编号" aria-label="按任务筛选" showClear={value !== "all"} />
      {/* 任务名很长：下拉比输入框宽一些（窄屏不超过屏幕） */}
      <ComboboxContent className="w-96">
        <ComboboxEmpty>没有匹配的任务</ComboboxEmpty>
        <ComboboxList>
          {(option: Option) => (
            <ComboboxItem key={option.value} value={option}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{option.label}</span>
                {option.value !== "all" && <span className="truncate text-muted-foreground">{option.value}</span>}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
