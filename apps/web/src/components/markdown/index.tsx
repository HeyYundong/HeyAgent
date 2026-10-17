// Markdown 显示：技能的 SKILL.md、记忆内容、agent 的输出。
// 照 shadcn 官方推荐的做法：react-markdown（+ remark-gfm 支持表格、任务列表、删除线）渲染，外面套 Typeset 的样式（./typeset.css）。
// docs/ui-rules.md 第 8 节登记的例外（用户 2026-10-17 批准）。
// 安全：不渲染原始 HTML（react-markdown 默认就不渲染），链接一律新窗口打开并去掉 referrer。
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"

const components: Components = {
  a: ({ href, title, children }) => (
    <a href={href} title={title} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  // 宽表格横向滚动，不撑破外框（Typeset 文档里的 typeset-scroll）
  table: ({ children }) => (
    <div className="typeset-scroll">
      <table>{children}</table>
    </div>
  ),
}

export function MarkdownView({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("typeset typeset-lyra", className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </Markdown>
    </div>
  )
}
