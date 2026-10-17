import * as React from "react"
import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, FileTextIcon, HandIcon, PlayIcon } from "lucide-react"

import { DetailPanel } from "@/components/shell/simple-page"
import { Badge } from "@/components/ui/badge"
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "@/components/ui/code-block"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import type { StepTone } from "./demo-data/lessons"

interface ChoiceProps<T extends string> {
  label: string
  value: T
  options: { id: T; label: string }[]
  onChange: (id: T) => void
}

/** 一条演示：标题卡（标题、一句话、唯一的交互控件）+ 若干张分区卡 */
export function Lesson<T extends string>({ title, meta, choice, children }: {
  title: string
  meta: string
  /** 唯一的交互控件：一排单选按钮，放在标题卡里 */
  choice?: ChoiceProps<T>
  children: React.ReactNode
}) {
  return (
    <DetailPanel title={title} meta={meta} actions={choice && <Choice {...choice} />}>
      {children}
    </DetailPanel>
  )
}

function Choice<T extends string>({ label, value, options, onChange }: ChoiceProps<T>) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <ToggleGroup
        variant="outline"
        value={[value]}
        onValueChange={(next) => next[0] && onChange(next[0] as T)}
        className="flex-wrap"
        aria-label={label}
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.id} value={option.id}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

const toneIcon: Record<StepTone, React.ReactNode> = {
  pass: <CircleCheckIcon />,
  block: <CircleXIcon className="text-destructive" />,
  wait: <HandIcon />,
  log: <FileTextIcon />,
  skip: <CircleDashedIcon className="text-muted-foreground" />,
  run: <PlayIcon />,
}

/** 演示里的一行：图标 + 标题 + 一句话 + 结论徽章 */
export function Step({ tone, title, text, badge, icon }: {
  tone: StepTone
  /** 换掉默认图标 */
  icon?: React.ReactNode
  title: React.ReactNode
  text?: React.ReactNode
  /** 右侧结论徽章，不填就不显示 */
  badge?: string
}) {
  const strong = tone === "block" || tone === "wait"
  return (
    <Item size="xs" variant={tone === "skip" ? "default" : strong ? "outline" : "muted"}>
      <ItemMedia variant="icon">{icon ?? toneIcon[tone]}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-none">{title}</ItemTitle>
        {text && <ItemDescription className="line-clamp-none">{text}</ItemDescription>}
      </ItemContent>
      {badge && (
        <ItemActions>
          <Badge variant={tone === "block" ? "destructive" : strong ? "secondary" : "outline"}>{badge}</Badge>
        </ItemActions>
      )}
    </Item>
  )
}

/** 一段原文（模型看到的目录、说明书、请求），可以高亮其中一行 */
export function Code({ icon, title, lines, highlight }: { icon: React.ReactNode; title: string; lines: string[]; highlight?: number }) {
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>
          {icon}
          {title}
        </CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent wrap>
        {lines.map((line, index) => (
          <CodeBlockLine key={index} variant={index === highlight ? "highlighted" : "default"}>
            {line}
          </CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

/** 一排并列的小格子（看板五列、三个角色），选中的那格加框 */
export function Tiles({ items, activeId, className }: {
  items: { id: string; title: string; badge: string; text: string }[]
  activeId: string
  /** 栅格列数 */
  className: string
}) {
  return (
    <div className={className}>
      {items.map((item) => (
        <Item key={item.id} size="xs" variant={item.id === activeId ? "outline" : "muted"}>
          <ItemContent>
            <ItemTitle>
              {item.title}
              <Badge variant={item.id === activeId ? "default" : "outline"}>{item.badge}</Badge>
            </ItemTitle>
            <ItemDescription>{item.text}</ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </div>
  )
}

/** 正文里的链接 */
export function TextLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <a href={to} className="underline underline-offset-4">
      {children}
    </a>
  )
}
