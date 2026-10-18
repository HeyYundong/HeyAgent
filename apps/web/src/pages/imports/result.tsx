// 导入记录的另外几种状态：读包中、没读成、已导入、已撤销。
import * as React from "react"
import {
  CircleCheckIcon,
  GlobeIcon,
  KeyRoundIcon,
  PlayIcon,
  PlugZapIcon,
  RotateCwIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  Undo2Icon,
  WrenchIcon,
} from "lucide-react"
import type { ImportDetail, ImportFollowUp, ImportPlan, ImportResult } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"

import { useStaffName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href, type PageId } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { baseName, money, ReadLog, taskTitle } from "./parts"
import { SummaryRows, taskEnabled, type SummaryRow } from "./wizard"

/** 读包中：一步一行，正在做的那行有流光 */
export function ReadingView({ detail }: { detail: ImportDetail }) {
  return (
    <DetailSection title="AI 正在读" description="AI 只读、只整理，不会建任何东西。读完会通知你来确认。">
      <div className="flex flex-col gap-4">
        <ReadLog steps={detail.readLog} />
        <p className="text-xs text-muted-foreground">一般 1～3 分钟，可以先去干别的。到现在花了 {money(detail.costUsd)}。</p>
      </div>
    </DetailSection>
  )
}

export function FailedView({ detail, onRetry }: { detail: ImportDetail; onRetry: () => void }) {
  return (
    <>
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>没读成</AlertTitle>
        <AlertDescription>
          <p>{detail.error ?? "读包出错了。"}</p>
          <p>让原 agent 照「打包说明」重新打一个包再上传；或者换个模型、补一句说明再读一次。</p>
        </AlertDescription>
      </Alert>
      <DetailSection title="读包过程">
        <div className="flex flex-col gap-4">
          <ReadLog steps={detail.readLog} />
          <Button variant="outline" size="sm" className="self-start" onClick={onRetry}>
            <RotateCwIcon data-icon="inline-start" />
            再读一次
          </Button>
        </div>
      </DetailSection>
    </>
  )
}

/** 已撤销：删了什么、留下了什么和为什么 */
export function UndoneView({ detail }: { detail: ImportDetail }) {
  const undo = detail.result?.undo
  return (
    <Alert>
      <Undo2Icon />
      <AlertTitle>这次导入已经撤销</AlertTitle>
      <AlertDescription>
        {undo ? (
          <>
            <p>{undo.deleted.length ? `删掉了：${undo.deleted.join("、")}。` : "没有要删的。"}用的已有配置没动。</p>
            {undo.kept.length > 0 && (
              <ul className="flex flex-col gap-1">
                {undo.kept.map((kept, index) => (
                  <li key={index}>
                    留下了{kept.what}：{kept.reason}
                  </li>
                ))}
              </ul>
            )}
            <p>原包还留着，可以下载。</p>
          </>
        ) : (
          <p>新建的任务、技能、记忆、规则、工具和密钥都删掉了；用的已有配置没动。原包还留着，可以下载。</p>
        )}
      </AlertDescription>
    </Alert>
  )
}

// ---------- 已导入 ----------

const FOLLOW_UP: Record<ImportFollowUp["kind"], { icon: React.ReactNode; label: string }> = {
  login: { icon: <GlobeIcon />, label: "去登录" },
  secret: { icon: <KeyRoundIcon />, label: "去填" },
  mcp_connect: { icon: <PlugZapIcon />, label: "去连接" },
  mcp_tools: { icon: <WrenchIcon />, label: "选进任务" },
  rule_confirm: { icon: <ShieldCheckIcon />, label: "去确认" },
  try_run: { icon: <PlayIcon />, label: "立即运行" },
}

/** 已导入：还要人做的事（每件带直达按钮，办完打勾）、导入了什么、读包过程 */
export function ImportedView({ detail }: { detail: ImportDetail }) {
  const todos = detail.followUps
  const left = todos.filter((todo) => !todo.done).length
  const firstTask = detail.result?.tasks[0]?.id

  return (
    <>
      <DetailSection title={todos.length ? `还要你做的（${left}）` : "还要你做的"} description="导入时办不了的事。办完自动打勾。">
        {left === 0 ? (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <CircleCheckIcon className="size-4" />
            都办好了。
            {firstTask && (
              <a className="underline underline-offset-4 hover:text-foreground" href={href("tasks", { id: firstTask })}>
                去看任务
              </a>
            )}
          </p>
        ) : (
          <ItemGroup className="gap-2">
            {todos.map((todo) => (
              <FollowUpRow key={todo.key} importId={detail.id} todo={todo} />
            ))}
          </ItemGroup>
        )}
      </DetailSection>
      {detail.plan && detail.result && (
        <DetailSection title="导入了什么" description="每一项都记着来自这次导入。撤销导入会删掉新建的这些；用已有的不受影响。">
          <ImportedSummary plan={detail.plan} result={detail.result} />
        </DetailSection>
      )}
      <DetailSection title="读包过程">
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
            <ScrollTextIcon data-icon="inline-start" />
            展开看 AI 读了哪些文件（{detail.readLog.length} 步，花费 {money(detail.costUsd)}）
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <ReadLog steps={detail.readLog} />
          </CollapsibleContent>
        </Collapsible>
      </DetailSection>
    </>
  )
}

function FollowUpRow({ importId, todo }: { importId: string; todo: ImportFollowUp }) {
  const runNow = useAction(trpc.engine.runNow.mutationOptions(), { success: ({ sessionId }) => `开始运行了（${sessionId}），在「待办」看板和任务详情里能看到`, errorTitle: "没能开始运行" })
  const attach = useAction(trpc.imports.attachMcpTools.mutationOptions(), { success: "工具选进任务了", errorTitle: "工具没选进任务" })
  const meta = FOLLOW_UP[todo.kind]
  const pending = runNow.isPending || attach.isPending
  const run = todo.action === "run_task"

  let button: React.ReactNode = null
  if (todo.action === "run_task" && todo.taskId) {
    const taskId = todo.taskId
    button = (
      <Button size="sm" disabled={pending} onClick={() => runNow.mutate({ taskId })}>
        {pending ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
        {meta.label}
      </Button>
    )
  } else if (todo.action === "attach_mcp_tools" && todo.serverId) {
    const serverId = todo.serverId
    button = (
      <Button variant="outline" size="sm" disabled={pending} onClick={() => attach.mutate({ id: importId, serverId })}>
        {pending && <Spinner data-icon="inline-start" />}
        {meta.label}
      </Button>
    )
  } else if (todo.link) {
    // 只有链接：去那一页办。停用的任务试跑前要先到任务页启用
    button = (
      <Button variant="outline" size="sm" nativeButton={false} render={<a href={todo.link} />}>
        {todo.kind === "try_run" ? "去任务页启用" : meta.label}
      </Button>
    )
  }

  return (
    <Item variant={todo.done ? "muted" : "outline"} size="xs">
      <ItemMedia variant="icon">{todo.done ? <CircleCheckIcon /> : meta.icon}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-none">{todo.title}</ItemTitle>
        <ItemDescription className="line-clamp-none">{todo.done ? (run ? "已经跑过了" : "已办好") : todo.description}</ItemDescription>
      </ItemContent>
      {!todo.done && button && <ItemActions>{button}</ItemActions>}
    </Item>
  )
}

const LINK = "text-foreground underline underline-offset-4 hover:text-muted-foreground"

/** 一串链接：「A」、「B」 */
function Links({ items, page }: { items: { id: string; label: string }[]; page: PageId }) {
  return (
    <>
      {items.map((item, index) => (
        <React.Fragment key={item.id + index}>
          {index > 0 && "、"}
          <a className={LINK} href={href(page, { id: item.id })}>
            {item.label}
          </a>
        </React.Fragment>
      ))}
    </>
  )
}

/** 一行里的几段：「新建并发布：A、B；用已有的：C」 */
function Parts({ parts }: { parts: [string, React.ReactNode | null][] }) {
  const shown = parts.filter(([, node]) => node !== null)
  if (!shown.length) return <>无</>
  return (
    <>
      {shown.map(([label, node], index) => (
        <React.Fragment key={label}>
          {index > 0 && "；"}
          {label}：{node}
        </React.Fragment>
      ))}
    </>
  )
}

/** 导入了什么：按导入结果，每类一行，建出来的都能点过去 */
function ImportedSummary({ plan, result }: { plan: ImportPlan; result: ImportResult }) {
  const staffName = useStaffName()
  const nameOf = (list: { key: string; name?: string; title?: string }[], key: string) => {
    const item = list.find((each) => each.key === key)
    return item?.name ?? item?.title ?? key
  }
  const linksOr = <T extends { key: string; id: string }>(list: T[], page: PageId, label: (item: T) => string) =>
    list.length ? <Links page={page} items={list.map((item) => ({ id: item.id, label: label(item) }))} /> : null
  const skillName = (item: { key: string }) => nameOf(plan.skills, item.key)
  const ruleName = (item: { key: string }) => nameOf(plan.rules, item.key)
  const toolName = (item: { key: string }) => nameOf(plan.tools, item.key)

  const rows: SummaryRow[] = [
    {
      key: "tasks",
      title: `任务 ${result.tasks.length} 个`,
      description: result.tasks.length
        ? result.tasks
            .map((created) => plan.tasks.find((task) => task.key === created.key))
            .map((task, index) =>
              task ? `「${task.title}」（${task.schedule ? task.schedule.text : "按需"}，负责人 ${staffName(task.ownerId)}${taskEnabled(task) ? "" : "，导入时建成了停用"}）` : result.tasks[index]!.id
            )
            .join("、")
        : "没建任务，只导入了配置",
    },
    {
      key: "skills",
      title: `技能 ${result.skills.length} 个`,
      description: (
        <Parts
          parts={[
            ["新建并发布", linksOr(result.skills.filter((s) => s.how === "created"), "skills", skillName)],
            ["更新成新一版", linksOr(result.skills.filter((s) => s.how === "new_version"), "skills", (s) => `${skillName(s)}${s.fromVersion ? `（原来是第 ${s.fromVersion} 版）` : ""}`)],
            ["用已有的", linksOr(result.skills.filter((s) => s.how === "reused"), "skills", skillName)],
          ]}
        />
      ),
    },
    {
      key: "memories",
      title: `记忆 ${result.memories.length + result.taskMemories.length} 条`,
      description: (
        <>
          任务记忆 {result.taskMemories.length} 条，共用记忆 {result.memories.length} 条
          {result.memories.length > 0 && (
            <>
              （<Links page="memory" items={result.memories.map((memory) => ({ id: memory.id, label: memory.id }))} />）
            </>
          )}
        </>
      ),
    },
    {
      key: "rules",
      title: `规则 ${result.rules.length} 条`,
      description: (
        <Parts
          parts={[
            ["新建并生效", linksOr(result.rules.filter((r) => r.how === "created" && r.confirmed), "rules", ruleName)],
            ["新建，还要到「规则」页确认", linksOr(result.rules.filter((r) => r.how === "created" && !r.confirmed), "rules", ruleName)],
            ["用已有的", linksOr(result.rules.filter((r) => r.how === "reused"), "rules", ruleName)],
          ]}
        />
      ),
    },
    {
      key: "tools",
      title: `工具 ${result.tools.length} 个`,
      description: (
        <Parts
          parts={[
            ["新建", linksOr(result.tools.filter((t) => t.how === "created"), "tools", toolName)],
            ["用已有的", linksOr(result.tools.filter((t) => t.how === "reused"), "tools", toolName)],
          ]}
        />
      ),
    },
  ]
  if (result.secrets.length)
    rows.push({
      key: "secrets",
      title: `密钥 ${result.secrets.length} 个`,
      description: result.secrets.map((s) => (s.how === "missing" ? `${s.name}（没填，导入后补）` : s.how === "reused" ? `${s.name}（用已有的）` : s.name)).join("、"),
    })
  if (result.files.length)
    rows.push({
      key: "files",
      title: `附件 ${result.files.length} 个`,
      description: result.files.map((file) => `${baseName(file.path)} → 「${result.tasks.find((task) => task.id === file.taskId) ? taskTitle(plan, result.tasks.find((task) => task.id === file.taskId)!.key) : file.taskId}」`).join("、"),
    })

  return (
    <div className="flex flex-col gap-3">
      {result.tasks.length > 0 && (
        <p className="text-muted-foreground">
          新建的任务：
          <Links page="tasks" items={result.tasks.map((task) => ({ id: task.id, label: `${task.id}「${taskTitle(plan, task.key)}」` }))} />
        </p>
      )}
      <SummaryRows rows={rows} />
    </div>
  )
}
