// 导入后还要人做的事（imports.get 里算，只在已导入时有）：按库里现在的状态给 done，办完就打勾。
// login 登录网站；secret 填密钥；mcp_connect 连接 MCP 服务器；mcp_tools 把读到的工具选进任务；rule_confirm 翻译确认规则；
// try_run 试跑任务（能被派活的任务是「派一张试试」，派活第二期）。
import { count, eq, inArray } from "drizzle-orm"
import { compiledRuleSchema, type ImportFollowUp, type ImportPlan, type ImportResult } from "@heyagent/shared"

import { findSecret, type DbOrTx } from "../data/config/common.js"
import * as t from "../db/schema.js"
import { isLocalAddress } from "./organize.js"

const quoteList = (items: string[]) => items.map((item) => `「${item}」`).join("")

export async function computeFollowUps(db: DbOrTx, input: { status: string; plan: ImportPlan | null; result: ImportResult | null }): Promise<ImportFollowUp[]> {
  const { plan, result } = input
  if (input.status !== "imported" || !plan || !result) return []
  const out: ImportFollowUp[] = []
  const taskIds = result.tasks.map((each) => each.id)
  const tasks = taskIds.length
    ? await db
        .select({ id: t.tasks.id, title: t.tasks.title, enabled: t.tasks.enabled, browserProfileIds: t.tasks.browserProfileIds, dispatch: t.tasks.dispatch })
        .from(t.tasks)
        .where(inArray(t.tasks.id, taskIds))
    : []
  /** 方案里的任务 key → 现在还在的任务（人可能已经删了） */
  const taskOf = (key: string) => {
    const id = result.tasks.find((each) => each.key === key)?.id
    return tasks.find((task) => task.id === id)
  }

  // 登录：所选 Chrome（空 = 全部）里这个平台有账号了就算办完
  const logins = new Map<string, { name: string; platformId: string | null; tasks: typeof tasks }>()
  for (const planTask of plan.tasks) {
    const task = taskOf(planTask.key)
    if (!task) continue
    for (const login of planTask.logins) {
      if (!login.missing) continue
      const entry = logins.get(login.domain) ?? { name: login.name, platformId: login.platformId, tasks: [] }
      entry.tasks.push(task)
      logins.set(login.domain, entry)
    }
  }
  if (logins.size) {
    const [profiles, platforms, accounts] = await Promise.all([
      db.select({ id: t.browserProfiles.id, name: t.browserProfiles.name }).from(t.browserProfiles).orderBy(t.browserProfiles.position),
      db.select({ id: t.platforms.id, domains: t.platforms.domains }).from(t.platforms),
      db.select({ profileId: t.browserAccounts.profileId, platformId: t.browserAccounts.platformId }).from(t.browserAccounts),
    ])
    for (const [domain, entry] of logins) {
      // 导入时还没有这个平台的，看看现在有没有
      const platformId = entry.platformId ?? platforms.find((platform) => platform.domains.some((d) => domain === d || domain.endsWith(`.${d}`)))?.id
      const chosen = (task: (typeof tasks)[number]) => (task.browserProfileIds.length ? task.browserProfileIds : profiles.map((profile) => profile.id))
      const done = Boolean(platformId) && entry.tasks.every((task) => accounts.some((account) => account.platformId === platformId && chosen(task).includes(account.profileId)))
      const first = entry.tasks.flatMap(chosen)[0]
      out.push({
        key: `login:${domain}`,
        kind: "login",
        title: `登录 ${entry.name}`,
        description: `任务${quoteList(entry.tasks.map((task) => task.title))}要用 ${entry.name}（${domain}），所选的 Chrome 里还没有这个网站的账号。到「浏览器」页打开 Chrome 登录一次。`,
        done,
        link: first ? `#/browsers?id=${encodeURIComponent(first)}` : "#/browsers",
      })
    }
  }

  // 密钥：包里没有、人也没填的，有了全局密钥就算办完
  const toolNamesUsing = (name: string) => plan.secrets.find((secret) => secret.name === name)?.toolKeys.flatMap((key) => plan.tools.find((tool) => tool.key === key)?.name ?? []) ?? []
  for (const secret of result.secrets.filter((each) => each.how === "missing")) {
    const done = Boolean(await findSecret(db, { scope: "http_tool", refId: null, name: secret.name }))
    const users = toolNamesUsing(secret.name)
    out.push({
      key: `secret:${secret.name}`,
      kind: "secret",
      title: `填密钥 ${secret.name}`,
      description: `${users.length ? `工具${quoteList(users)}要用它，` : ""}包里没有值。到「工具」页的「密钥」里填上。`,
      done,
      link: "#/tools",
    })
  }

  // MCP 服务器：连上、读到工具算第一件；连上以后，方案里用它的任务都选上它的工具算第二件
  for (const created of result.tools.filter((each) => each.how === "created")) {
    const planTool = plan.tools.find((tool) => tool.key === created.key)
    if (planTool?.kind !== "mcp") continue
    const [server] = await db.select({ id: t.mcpServers.id, name: t.mcpServers.name, status: t.mcpServers.status, url: t.mcpServers.url }).from(t.mcpServers).where(eq(t.mcpServers.id, created.id))
    if (!server) continue
    const serverTools = (await db.select({ id: t.tools.id }).from(t.tools).where(eq(t.tools.serverId, server.id))).map((tool) => tool.id)
    const connected = server.status === "connected" && serverTools.length > 0
    out.push({
      key: `mcp_connect:${server.id}`,
      kind: "mcp_connect",
      title: `连接 MCP 服务器「${server.name}」`,
      description: `导入时还没连过。${server.url && isLocalAddress(server.url) ? `地址 ${server.url} 是原来那台机器上的，先改成真正的服务地址，再` : "到「工具」页打开它，"}点「连接并读取工具」，勾上要用的工具。`,
      done: connected,
      link: `#/tools?id=${encodeURIComponent(server.id)}`,
    })
    if (!connected) continue
    const using = plan.tasks.filter((task) => task.toolKeys.includes(created.key)).flatMap((task) => taskOf(task.key) ?? [])
    if (using.length === 0) continue
    const links = await db.select({ taskId: t.taskTools.taskId }).from(t.taskTools).where(inArray(t.taskTools.refId, serverTools))
    const done = using.every((task) => links.some((link) => link.taskId === task.id))
    out.push({
      key: `mcp_tools:${server.id}`,
      kind: "mcp_tools",
      title: `把「${server.name}」的工具选进任务`,
      description: `服务器连上了，有 ${serverTools.length} 个工具。任务${quoteList(using.map((task) => task.title))}原来用它，要把这些工具选进去。`,
      done,
      action: "attach_mcp_tools",
      serverId: server.id,
    })
  }

  // 规则：导入时没确认的（要用新工具、没翻译的），生效了就算办完
  for (const created of result.rules.filter((each) => each.how === "created" && !each.confirmed)) {
    const [rule] = await db.select({ id: t.rules.id, name: t.rules.name, compiled: t.rules.compiledTrigger }).from(t.rules).where(eq(t.rules.id, created.id))
    if (!rule) continue
    out.push({
      key: `rule_confirm:${rule.id}`,
      kind: "rule_confirm",
      title: `翻译并确认规则「${rule.name}」`,
      description: "导入时还不能翻译（要用到这次才导入的工具，或者翻译时出错了）。到「规则」页翻译，看过「系统理解为」后确认，才会生效。",
      done: compiledRuleSchema.safeParse(rule.compiled).success,
      link: `#/rules?id=${encodeURIComponent(rule.id)}`,
    })
  }

  // 试跑：每个导入的任务，有过运行就算办完
  for (const { key } of result.tasks) {
    const task = taskOf(key)
    if (!task) continue
    // 能被派活的任务：按定时 / 立即运行跑出来的没有参数，不知道办哪件，改成在任务详情「派一张试试」（链接带 dispatch=1 直接打开「派一张」），名下有过一张单就算办完
    if (task.dispatch) {
      const [[items], [sources]] = await Promise.all([
        db.select({ n: count() }).from(t.workItems).where(eq(t.workItems.taskId, task.id)),
        db.select({ n: count() }).from(t.taskDispatchSources).where(eq(t.taskDispatchSources.taskId, task.id)),
      ])
      out.push({
        key: `try_run:${task.id}`,
        kind: "try_run",
        title: `派一张试试「${task.title}」`,
        description: [
          "这个任务导入成了「可以被派活」。在任务详情里手动派一张，看看办得对不对。",
          (sources?.n ?? 0) === 0 ? "现在还没有任务派活给它（派活的任务没勾上，或者包里就没有），要的话在任务设置的「谁能派活给它」里加。" : "",
          task.enabled ? "" : "它导入时是停用的：单会先排着，启用后才开始办。",
        ].join(""),
        done: (items?.n ?? 0) > 0,
        link: `#/tasks?id=${encodeURIComponent(task.id)}&dispatch=1`,
        taskId: task.id,
      })
      continue
    }
    const [runs] = await db.select({ n: count() }).from(t.sessions).where(eq(t.sessions.taskId, task.id))
    const done = (runs?.n ?? 0) > 0
    // 停用的任务不能立即运行（engine 会拒绝）：先去任务页启用
    out.push(
      task.enabled || done
        ? { key: `try_run:${task.id}`, kind: "try_run", title: `试跑「${task.title}」`, description: "导入后先点「立即运行」跑一次，看看结果对不对。", done, action: "run_task", taskId: task.id }
        : {
            key: `try_run:${task.id}`,
            kind: "try_run",
            title: `试跑「${task.title}」`,
            description: "这个任务导入时是停用的（包里写了默认不自动执行）。先到任务页看一遍、启用，再点「立即运行」跑一次。",
            done,
            link: `#/tasks?id=${encodeURIComponent(task.id)}`,
            taskId: task.id,
          }
    )
  }
  return out
}
