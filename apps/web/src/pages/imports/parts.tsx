// 导入页几处共用的小部件：状态徽章、读包过程、方案的统计、向导有哪几步、打包说明
import { CircleCheckIcon, CircleXIcon } from "lucide-react"
import { BROWSER_TOOL_ID, planMemoryIncluded, type ImportPlan, type ImportReadStep, type ImportStatus, type ImportStep, type PlanTask } from "@heyagent/shared"

import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"

export const money = (usd: number) => `$${usd.toFixed(2)}`

/** 「3 秒」「1 分 12 秒」 */
export function took(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分${seconds % 60 ? ` ${seconds % 60} 秒` : ""}`
}

/** 列表和详情标题旁的状态：不只靠颜色，文字和图标都不一样 */
export function StatusBadge({ status }: { status: ImportStatus }) {
  if (status === "reading")
    return (
      <Badge variant="secondary">
        <Spinner data-icon="inline-start" />
        读包中
      </Badge>
    )
  if (status === "review") return <Badge>待确认</Badge>
  if (status === "imported")
    return (
      <Badge variant="outline">
        <CircleCheckIcon data-icon="inline-start" />
        已导入
      </Badge>
    )
  if (status === "undone") return <Badge variant="ghost">已撤销</Badge>
  return <Badge variant="destructive">没读成</Badge>
}

/** AI 读包的过程：一行一步，正在做的那行有流光 */
export function ReadLog({ steps }: { steps: ImportReadStep[] }) {
  if (steps.length === 0) return <p className="text-muted-foreground">还没开始，马上就读。</p>
  return (
    <Trace>
      {steps.map((step, index) => (
        <div key={index}>
          <TraceLine status={step.status === "done" ? undefined : step.status}>
            <TraceIcon>{step.status === "running" ? <Spinner /> : step.status === "error" ? <CircleXIcon /> : <CircleCheckIcon />}</TraceIcon>
            <TraceTitle>{step.title}</TraceTitle>
            {step.ms !== undefined && step.status !== "running" && <TraceDescription>{took(step.ms)}</TraceDescription>}
          </TraceLine>
        </div>
      ))}
    </Trace>
  )
}

// ---------- 向导的步骤 ----------

export const STEP_LABEL: Record<ImportStep, string> = {
  overview: "总览",
  tasks: "任务",
  skills: "技能",
  memories: "记忆",
  rules: "规则",
  tools: "工具",
  confirm: "确认导入",
}

/** 这个方案有哪几步：没有内容的步骤跳过 */
export function stepsOf(plan: ImportPlan): ImportStep[] {
  const steps: ImportStep[] = ["overview"]
  if (plan.tasks.length) steps.push("tasks")
  if (plan.skills.length) steps.push("skills")
  if (plan.memories.length) steps.push("memories")
  if (plan.rules.length) steps.push("rules")
  if (plan.tools.length || plan.secrets.length) steps.push("tools")
  steps.push("confirm")
  return steps
}

// ---------- 方案的统计 ----------

export const memoryOn = (plan: ImportPlan, memory: ImportPlan["memories"][number]) => planMemoryIncluded(plan, memory)

/** 方案里各类导入几项（只算勾上的） */
export function planCounts(plan: ImportPlan) {
  const on = <T extends { include: boolean }>(list: T[]) => list.filter((item) => item.include)
  const memories = plan.memories.filter((memory) => memoryOn(plan, memory))
  const rules = on(plan.rules).filter((rule) => rule.kind !== "unsupported")
  const tools = on(plan.tools)
  const tasks = on(plan.tasks)
  return {
    tasks: tasks.length,
    skills: on(plan.skills).length,
    skillsNew: on(plan.skills).filter((skill) => skill.resolution !== "use_existing").length,
    memories: memories.length,
    sharedMemories: memories.filter((memory) => memory.target.kind === "shared").length,
    taskMemories: memories.filter((memory) => memory.target.kind === "task").length,
    rules: rules.length,
    rulesNew: rules.filter((rule) => rule.kind === "new").length,
    tools: tools.length,
    toolsNew: tools.filter((tool) => tool.kind === "http" || tool.kind === "mcp").length,
    attachments: tasks.reduce((sum, task) => sum + task.attachments.length, 0),
    /** 一项都没勾：不能导入 */
    nothing:
      tasks.length + on(plan.skills).length + memories.length + rules.filter((rule) => rule.kind === "new").length + tools.filter((tool) => tool.kind === "http" || tool.kind === "mcp").length === 0,
  }
}

export const taskTitle = (plan: ImportPlan, key: string) => plan.tasks.find((task) => task.key === key)?.title ?? key
export const toolTitle = (plan: ImportPlan, key: string) => plan.tools.find((tool) => tool.key === key)?.name ?? key

/** 任务选了「浏览器」工具（方案里的内置工具 browser） */
export const taskUsesBrowser = (plan: ImportPlan, task: PlanTask) =>
  task.toolKeys.some((key) => plan.tools.some((tool) => tool.key === key && tool.include && tool.refId === BROWSER_TOOL_ID))

/** 包内路径只显示文件名 */
export const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? path

/** 「logins 里缺的平台」：所选 Chrome 里还没有这个平台的账号 */
export const missingLogins = (task: PlanTask) => task.logins.filter((login) => login.missing)

// ---------- 打包说明 ----------

/** 让原 agent 打包时发给它的话（「打包说明」里一键复制） */
export const PACK_PROMPT = `请把你现在负责的工作整理成一个 zip 包，我要迁移到另一个 agent 平台：

1. 每个任务一个文件：tasks/<任务名>.md。写清楚：要做什么、做到什么算完成、
   大概的步骤、多久跑一次（定时的写 cron）、要登录哪些网站、产出什么文件。
2. 每个技能一个文件夹：skills/<技能名>/SKILL.md，开头写「什么时候用」；
   参考资料放在同一个文件夹里。
3. 你记住的经验、偏好写进 memory/ 下的 .md，一条一段，注明是哪个任务的。
4. 必须遵守的规矩写进 rules.md，每条写「什么情况下」和「怎么办」。
5. 用到的接口、MCP 配置原样放进 config/。密钥可以留着（导入时会自动挪走），
   不想给就删掉，导入后再填。
6. 模板、表格这类附件放进 files/。

日志、缓存、依赖包、数据库不要放进来。`
