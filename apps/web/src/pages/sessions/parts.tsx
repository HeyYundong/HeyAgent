// 会话页几处共用的小块：处理面板里的一段（Part）、一块原文（Block）、文字链接、用 · 隔开的一行。
import { Fragment, type ReactNode } from "react"

import { HelpTip } from "@/components/shell/simple-page"
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from "@/components/ui/code-block"

/** 处理面板里的一段：小标题（说明放进「?」）+ 内容。面板本身是一张卡，里面不再套卡 */
export function Part({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="flex items-center gap-1 font-medium">
        {title}
        {description && <HelpTip>{description}</HelpTip>}
      </h3>
      {children}
    </section>
  )
}

export const TextLink = ({ to, children }: { to: string; children: ReactNode }) => <a href={to} className="underline underline-offset-4 hover:text-foreground">{children}</a>

/** 一块原文：要发的消息、订单、证据、diff */
export const Block = ({ title, children }: { title: string; children: ReactNode }) => (
  <CodeBlock size="sm">
    <CodeBlockHeader><CodeBlockTitle>{title}</CodeBlockTitle></CodeBlockHeader>
    <CodeBlockContent wrap>{children}</CodeBlockContent>
  </CodeBlock>
)

/** 几样东西用 · 隔开（空的跳过） */
export const dots = (...parts: ReactNode[]) => parts.filter(Boolean).map((part, index) => <Fragment key={index}>{index > 0 && " · "}{part}</Fragment>)
