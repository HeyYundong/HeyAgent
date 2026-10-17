// 选 Chrome 的时区（可搜索）：选项是浏览器认识的全部 IANA 时区（Intl.supportedValuesOf），右边带现在的 UTC 偏移。
// 基于 @/components/ui/combobox（Base UI）。
import * as React from "react"

import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox"

interface Zone {
  value: string
  /** 例如 GMT+8；拿不到时空着 */
  offset: string
}

function offsetOf(zone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? ""
  } catch {
    return ""
  }
}

function allZones(): Zone[] {
  let names: string[] = []
  try {
    names = Intl.supportedValuesOf("timeZone")
  } catch {
    // 很老的浏览器没有 supportedValuesOf：只能搜到当前选中的那个
  }
  return names.map((value) => ({ value, offset: offsetOf(value) }))
}

const sameZone = (a: Zone, b: Zone) => a.value === b.value

interface TimeZoneComboboxProps {
  id?: string
  value: string
  onValueChange: (value: string) => void
  "aria-invalid"?: boolean
}

export function TimeZoneCombobox({ id, value, onValueChange, "aria-invalid": invalid }: TimeZoneComboboxProps) {
  const zones = React.useMemo(() => allZones(), [])
  // 存着的时区不在列表里（例如 UTC 在有的浏览器里不列出来）也要显示、能选回去
  const selected = value ? (zones.find((zone) => zone.value === value) ?? { value, offset: offsetOf(value) }) : null
  const items = selected && !zones.some((zone) => zone.value === selected.value) ? [selected, ...zones] : zones
  return (
    <Combobox<Zone>
      items={items}
      value={selected}
      isItemEqualToValue={sameZone}
      itemToStringLabel={(zone) => zone.value}
      autoHighlight
      filter={(zone, query) => {
        const text = query.trim().toLowerCase().replace(/\s+/g, "_")
        return !text || zone.value.toLowerCase().includes(text) || zone.offset.toLowerCase().includes(text)
      }}
      onValueChange={(zone) => zone && onValueChange(zone.value)}
    >
      <ComboboxInput id={id} className="w-full" placeholder="搜城市，例如 London、New_York" aria-invalid={invalid} />
      <ComboboxContent>
        <ComboboxEmpty>没有这个时区，换个城市名搜</ComboboxEmpty>
        <ComboboxList>
          {(zone: Zone) => (
            <ComboboxItem key={zone.value} value={zone}>
              <span className="flex min-w-0 flex-1 justify-between gap-2">
                <span className="truncate">{zone.value}</span>
                <span className="text-muted-foreground">{zone.offset}</span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
