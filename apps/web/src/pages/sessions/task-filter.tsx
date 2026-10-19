// 按任务筛 session：下拉里是出现过 session 的任务（最近跑过的在前），可以按任务名 / 编号搜。
// 第一项「全部任务」= 不筛。基于 @/components/ui/combobox（Base UI），和 model-combobox 同一写法。
import * as React from "react"
import { findById, type SessionRun, type TaskDef } from "@heyagent/shared"

import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox"

interface Option {
  /** 任务编号；"all" = 全部任务 */
  value: string
  label: string
  count: number
}

interface TaskFilterProps {
  value: string
  onValueChange: (value: string) => void
  /** 全部 session（已排好序），从里面数出有哪些任务、各跑了几次 */
  runs: SessionRun[]
  tasks: TaskDef[]
}

const sameOption = (a: Option, b: Option) => a.value === b.value

export function TaskFilter({ value, onValueChange, runs, tasks }: TaskFilterProps) {
  const options = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const run of runs) counts.set(run.taskId, (counts.get(run.taskId) ?? 0) + 1)
    // 任务删了的 session 也能筛，名字就写编号
    const each = [...counts].map(([id, count]) => ({ value: id, label: findById(tasks, id)?.title ?? id, count }))
    return [{ value: "all", label: "全部任务", count: runs.length }, ...each]
  }, [runs, tasks])
  // 地址里带的任务没有 session 时也显示出来，让人知道筛的是哪个
  const selected = options.find((option) => option.value === value) ?? { value, label: findById(tasks, value)?.title ?? value, count: 0 }

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
                <span className="truncate tabular-nums text-muted-foreground">
                  {option.value === "all" ? `${option.count} 个 session` : `${option.value} · ${option.count} 个 session`}
                </span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
