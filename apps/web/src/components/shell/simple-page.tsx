import * as React from "react"
import {
  ArrowLeftIcon,
  CircleHelpIcon,
  MousePointerClickIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { href, setParams } from "@/lib/router"

// v2 统一页面骨架：所有页面都是「标题 + 左边列表 + 右边详情」。
// 页面只往里填内容，不自己发明布局。

// ---------- 页面标题 ----------

interface SimpleHeaderProps {
  title: string
  /** 标题下面的一句话 */
  description: string
  /** 「这是什么？」跳到「看懂架构」页的哪一条（不填就不显示） */
  learnId?: string
  /** 右上角唯一的操作（例如「新建」），只给主管 */
  action?: React.ReactNode
}

export function SimpleHeader({ title, description, learnId, action }: SimpleHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold">{title}</h1>
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          {description}
          {learnId && (
            <a
              href={href("learn", { id: learnId })}
              className="inline-flex items-center gap-1 underline-offset-4 hover:text-foreground hover:underline"
            >
              <CircleHelpIcon className="size-3.5" />
              这是什么？
            </a>
          )}
        </p>
      </div>
      {action}
    </div>
  )
}

// ---------- 页面外框：按查询状态显示加载 / 空 / 出错 ----------

/** 页面要等的一个查询（TanStack Query 的 useQuery 结果） */
export interface FrameQuery {
  isPending: boolean
  isError: boolean
  refetch: () => unknown
}

interface PageFrameProps {
  header: React.ReactNode
  /** 这页要等的查询：有一个还在加载就显示骨架屏，有一个出错就显示出错提示 */
  queries: FrameQuery[]
  /** 数据拿到了但没有内容：显示 empty */
  isEmpty?: boolean
  /** 空状态时显示什么（用 EmptyState） */
  empty: React.ReactNode
  /** 加载中的骨架样式：左边列表右边详情（默认）/ 卡片墙 / 表格 */
  skeleton?: "list" | "grid" | "table"
  children: React.ReactNode
}

export function PageFrame({ header, queries, isEmpty = false, empty, skeleton = "list", children }: PageFrameProps) {
  const failed = queries.filter((query) => query.isError)
  const loading = failed.length === 0 && queries.some((query) => query.isPending)
  const state = failed.length > 0 ? "error" : loading ? "loading" : isEmpty ? "empty" : "normal"
  // 「重试」只重新查出错的那几个
  const retry = () => failed.forEach((query) => void query.refetch())

  return (
    <div className="flex flex-1 flex-col gap-6">
      {header}
      {state === "loading" && skeleton === "list" && (
        <MasterDetail hasSelection={false} list={<ListSkeleton />} detail={<DetailSkeleton />} />
      )}
      {state === "loading" && skeleton === "grid" && <GridSkeleton />}
      {state === "loading" && skeleton === "table" && <TableSkeleton />}
      {state === "error" && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>网络不稳定，没拿到数据。agent 本身不受影响。</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={retry}>
              <RotateCwIcon data-icon="inline-start" />
              重试
            </Button>
          </AlertAction>
        </Alert>
      )}
      {state === "empty" && empty}
      {state === "normal" && children}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}

// ---------- 左边列表 + 右边详情 ----------

interface MasterDetailProps {
  list: React.ReactNode
  /** 选中后的详情；没选中时传 null，会显示提示 */
  detail: React.ReactNode | null
  /** 是否选中了某一条（窄屏下决定显示列表还是详情） */
  hasSelection: boolean
  /** 没选中时右边的提示 */
  emptyHint?: string
}

export function MasterDetail({
  list,
  detail,
  hasSelection,
  emptyHint = "从左边选一条查看详情",
}: MasterDetailProps) {
  return (
    <div className="flex flex-1 items-start gap-4">
      <div
        className={cn(
          "flex w-full shrink-0 flex-col gap-4 md:w-80 lg:w-96",
          hasSelection && "hidden md:flex"
        )}
      >
        {list}
      </div>
      <div className={cn("min-w-0 flex-1 flex-col gap-2", hasSelection ? "flex" : "hidden md:flex")}>
        {hasSelection && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start md:hidden"
            onClick={() => setParams({ id: null })}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            返回列表
          </Button>
        )}
        {detail ?? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MousePointerClickIcon />
              </EmptyMedia>
              <EmptyDescription>{emptyHint}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  )
}

// ---------- 列表 ----------

/** 一组列表项，可带一个小标题（例如按范围、岗位、阶段分组） */
export function PickGroup({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="px-1 text-xs text-muted-foreground">{label}</span>}
      <ItemGroup className="gap-1">{children}</ItemGroup>
    </div>
  )
}

interface PickItemProps {
  /** 点击后去哪（一般是 href(当前页, { id })） */
  to: string
  selected: boolean
  title: React.ReactNode
  /** 第二行，只放一句话 */
  description?: React.ReactNode
  /** 右侧最多一个徽章 */
  badge?: React.ReactNode
}

export function PickItem({ to, selected, title, description, badge }: PickItemProps) {
  return (
    <Item
      size="sm"
      variant={selected ? "outline" : "muted"}
      aria-current={selected ? "true" : undefined}
      render={<a href={to} />}
    >
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-1">{title}</ItemTitle>
        {description && <ItemDescription className="line-clamp-1">{description}</ItemDescription>}
      </ItemContent>
      {badge && <ItemActions>{badge}</ItemActions>}
    </Item>
  )
}

// ---------- 详情 ----------
// 详情 = 一张标题卡 + 若干张分区卡（DetailSection），每个内容区域一张卡，互相分开。

interface DetailPanelProps {
  title: React.ReactNode
  /** 标题旁的状态徽章，最多两个 */
  badges?: React.ReactNode
  /** 标题下一行灰字（来源、负责人等） */
  meta?: React.ReactNode
  /** 右上角操作：最多一个主按钮 + 一个次按钮；员工视角不传 */
  actions?: React.ReactNode
  /** 分区卡：一般是若干个 DetailSection */
  children: React.ReactNode
}

export function DetailPanel({ title, badges, meta, actions, children }: DetailPanelProps) {
  return (
    <div className="flex w-full flex-col gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-heading text-base font-semibold">{title}</h2>
              {badges}
            </div>
            {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </CardContent>
      </Card>
      {children}
    </div>
  )
}

/** 标题旁的「?」：鼠标放上去（或键盘聚焦）显示这一块是干嘛的。说明不写成标题下的子标题（用户 2026-10-18 定的） */
export function HelpTip({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-xs" aria-label="说明" />}>
        <CircleHelpIcon />
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  )
}

/** 详情里的一个内容区域：单独一张卡，标题在上。一个详情最多 4 张 */
export function DetailSection({
  title,
  description,
  action,
  children,
}: {
  title: string
  /** 这一块是干嘛的（可选）：显示成标题旁的「?」，鼠标放上去才看到 */
  description?: React.ReactNode
  /** 卡片右上角的小操作（可选） */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-1">
          {title}
          {description && <HelpTip>{description}</HelpTip>}
        </CardTitle>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="text-sm">{children}</CardContent>
    </Card>
  )
}

// ---------- 加载骨架 ----------

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  )
}

function GridSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-48 w-full" />
      ))}
    </div>
  )
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-8 w-full" />
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  )
}
