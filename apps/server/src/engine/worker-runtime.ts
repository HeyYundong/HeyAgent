// worker：完整的 pg-boss（跑定时、维护、心跳检查）+ 各类任务的处理函数。worker.ts 和测试都用它。
import { PgBoss } from "pg-boss"
import { and, eq, isNotNull } from "drizzle-orm"

import { startControlServer, type ControlServer } from "../browser/control.js"
import { BrowserManager, setBrowserManager } from "../browser/manager.js"
import { recoverRunningComparisons, runComparison } from "../compare/run.js"
import { ensureDefaultStandard } from "../compare/service.js"
import { DESKTOP_SWEEP_MS, sweepDesktops } from "../desktop/leases.js"
import { vmConfig } from "../desktop/vm/config.js"
import { runVmJob, sweepVms, vmHealthTick } from "../desktop/vm/lifecycle.js"
import { runImportRead } from "../imports/reader.js"
import { handleCompileJob } from "../routine/compile.js"
import { sweepRoutines } from "../routine/sweep.js"
import type { Db } from "../db/client.js"
import { cleanupSessionSandbox, sweepSandboxDirs, sweepThrottled } from "../sandbox/code-run.js"
import * as t from "../db/schema.js"
import { notifyBudgetOnce } from "./dispatch/budget.js"
import { onWorkNotify } from "./dispatch/notify.js"
import { pumpTask } from "./dispatch/pump.js"
import { sweepWork } from "./dispatch/sweep.js"
import { onSubagentNotify } from "./subagents/notify.js"
import { pumpSubagents } from "./subagents/pump.js"
import { runSession } from "./loop.js"
import {
  ensureQueues,
  QUEUES,
  registerBoss,
  SCHEDULE_TZ,
  runJobOptions,
  unregisterBoss,
} from "./queue.js"
import { onTaskCron, onTodoCron, onTodoFire, onTodoRemind } from "./schedule.js"
import { syncBuiltinTools } from "./tools/builtin-defs.js"
import { getKeyring } from "./runtime.js"
import { onRemind, onWake } from "./waits.js"

export interface EngineWorkerOptions {
  databaseUrl: string
  db: Db
  /** 同时跑几个 session */
  concurrency?: number
  /** 多久查一次新任务（秒） */
  pollingIntervalSeconds?: number
  /** pg-boss 的心跳检查、过期检查多久一次（秒）：worker 被杀掉后多快被发现 */
  superviseIntervalSeconds?: number
  /** cron 多久检查一次（秒） */
  cronWorkerIntervalSeconds?: number
  instanceName?: string
  /**
   * 浏览器（M2）：内部控制接口的端口（只绑 127.0.0.1，API 用它打开 Chrome、转发远程画面）。
   * 默认 HEYAGENT_BROWSER_CONTROL_PORT 或 3190；0 = 随机端口（测试用）；false = 不开浏览器管理
   */
  browserControlPort?: number | false
  /** 桌面巡查的间隔（毫秒）。默认 HEYAGENT_DESKTOP_SWEEP_MS 或 30 秒；false = 不开定时巡查（测试里自己调 sweepDesktops，免得和断言抢） */
  desktopSweepMs?: number | false
  /**
   * 系统开的桌面的对账间隔（毫秒），开机中的健康检查另有 5 秒的定时器。默认 HEYAGENT_DESKTOP_VM_SWEEP_MS 或 30 秒；
   * false = 不开这两个定时器（测试里自己调 sweepVms / vmHealthTick）。desktop.vm 任务照常处理
   */
  desktopVmSweepMs?: number | false
}

export interface EngineWorker {
  boss: PgBoss
  browser?: BrowserManager
  stop(): Promise<void>
}

const log = (...args: unknown[]) => console.log("[worker]", ...args)

export async function startEngineWorker(
  options: EngineWorkerOptions
): Promise<EngineWorker> {
  const { db } = options
  const supervise = options.superviseIntervalSeconds ?? 30
  const boss = new PgBoss({
    connectionString: options.databaseUrl,
    max: 5,
    superviseIntervalSeconds: supervise,
    monitorIntervalSeconds: supervise,
    ...(options.cronWorkerIntervalSeconds
      ? {
          cronWorkerIntervalSeconds: options.cronWorkerIntervalSeconds,
          cronMonitorIntervalSeconds: options.cronWorkerIntervalSeconds,
        }
      : {}),
    instanceName: options.instanceName ?? "worker",
  })
  boss.on("error", (error) => console.error("[worker] pg-boss 出错", error))
  await boss.start()
  await ensureQueues(boss)
  registerBoss(db, boss)
  await syncBuiltinTools(db)
  // 运行代码的沙箱目录：已经结束（或者不存在）的 session 的删掉（worker 重启后在跑、在等的留着）
  await sweepSandboxDirs(db).catch((error) => console.warn("[worker] 清理沙箱目录出错", error))
  await ensureDefaultStandard(db).catch((error) => console.warn("[worker] 没建好默认的比对标准", error))

  // 浏览器管理：登记 worker、开内部控制接口（远程画面、打开 Chrome）
  let browser: BrowserManager | undefined
  let control: ControlServer | undefined
  if (options.browserControlPort !== false) {
    browser = new BrowserManager({ db, keyring: getKeyring })
    const envPort = Number(process.env.HEYAGENT_BROWSER_CONTROL_PORT)
    const port =
      options.browserControlPort ??
      (Number.isInteger(envPort) && envPort >= 0 ? envPort : 3190)
    control = await startControlServer(browser, { port })
    await browser.start(control.url)
    setBrowserManager(browser)
    log(`浏览器内部控制接口：${control.url}`)
  }

  // 桌面：过期没续的占用、保留时间到了的放掉，叫醒等桌面的（docs/dev/desktop.md 第 3 节）。不依赖浏览器管理
  const desktopSweep =
    options.desktopSweepMs === false
      ? undefined
      : setInterval(() => {
          void sweepDesktops(db).catch((error) => console.warn("[worker] 桌面巡查出错", error))
        }, options.desktopSweepMs ?? DESKTOP_SWEEP_MS)
  desktopSweep?.unref()

  // 系统开的桌面（docs/dev/desktop-vm.md 第 1 节）：对账、开机中的查 /health。只在配了 Podman 时有事做
  let vmSweep: NodeJS.Timeout | undefined
  let vmHealth: NodeJS.Timeout | undefined
  if (options.desktopVmSweepMs !== false) {
    let healthBusy = false
    vmSweep = setInterval(() => {
      void sweepVms(db).catch((error) => console.warn("[worker] 虚拟机对账出错", error))
    }, options.desktopVmSweepMs ?? vmConfig.sweepMs)
    vmHealth = setInterval(() => {
      if (healthBusy) return
      healthBusy = true
      void vmHealthTick(db)
        .catch((error) => console.warn("[worker] 虚拟机健康检查出错", error))
        .finally(() => (healthBusy = false))
    }, vmConfig.healthMs)
    vmSweep.unref()
    vmHealth.unref()
  }

  let stopping = false
  const controllers = new Set<AbortController>()
  const polling = {
    pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2,
  }

  await boss.work<{ sessionId: string }>(
    QUEUES.run,
    { ...polling, localConcurrency: options.concurrency ?? 4 },
    async ([job]) => {
      if (!job) return
      const controller = new AbortController()
      controllers.add(controller)
      const signal = AbortSignal.any([controller.signal, job.signal])
      try {
        const outcome = await runSession(db, job.data.sessionId, { signal })
        if (outcome === "stopped" && stopping) {
          // 进程要退出了：session 还在执行中就交给下一个 worker 接着跑
          const [session] = await db
            .select({ status: t.sessions.status })
            .from(t.sessions)
            .where(eq(t.sessions.id, job.data.sessionId))
          if (session?.status === "running")
            await boss.send(
              QUEUES.run,
              { sessionId: job.data.sessionId },
              runJobOptions(job.data.sessionId)
            )
        }
        return { outcome }
      } finally {
        controllers.delete(controller)
        // 运行结束了就删掉它的沙箱目录（运行代码用的；挂起、交接的留着）
        await cleanupSessionSandbox(db, job.data.sessionId).catch((error) =>
          console.warn("[worker] 删沙箱目录出错", error)
        )
        // 验收中、被别处取消的这类，过后由定期清理收掉（最多每小时一次）
        void sweepThrottled(db)
      }
    }
  )
  await boss.work<{ sessionId: string; waitId: number }>(
    QUEUES.wake,
    polling,
    async ([job]) => job && { resumed: await onWake(db, job.data) }
  )
  await boss.work<{ waitId: number }>(
    QUEUES.remind,
    polling,
    async ([job]) => job && { reminded: await onRemind(db, job.data) }
  )
  await boss.work<{ todoId: string; at: string }>(
    QUEUES.todoFire,
    polling,
    async ([job]) => job && { result: await onTodoFire(db, job.data) }
  )
  await boss.work<{ todoId: string; version: string }>(
    QUEUES.todoRemind,
    polling,
    async ([job]) => job && { reminded: await onTodoRemind(db, job.data) }
  )
  await boss.work<{ taskId: string }>(
    QUEUES.taskCron,
    polling,
    async ([job]) => job && { sessionId: await onTaskCron(db, job.data) }
  )
  await boss.work<{ todoId: string }>(
    QUEUES.todoCron,
    polling,
    async ([job]) => job && { result: await onTodoCron(db, job.data) }
  )
  // 导入：读包。worker 要退出时读到一半的抛错，让 pg-boss 交给下一个 worker 从头读
  await boss.work<{ importId: string }>(
    QUEUES.importRead,
    { ...polling, localConcurrency: 2 },
    async ([job]) => {
      if (!job) return
      const controller = new AbortController()
      controllers.add(controller)
      try {
        const outcome = await runImportRead(db, job.data.importId, {
          signal: AbortSignal.any([controller.signal, job.signal]),
        })
        if (outcome === "interrupted")
          throw new Error("读包被打断（worker 退出），交给下一个 worker 从头读")
        return { outcome }
      } finally {
        controllers.delete(controller)
      }
    }
  )

  // 比物：一次比对。worker 要退出时比到一半的抛错，让 pg-boss 交给下一个 worker 重比
  await boss.work<{ comparisonId: string }>(
    QUEUES.compareRun,
    { ...polling, localConcurrency: 4 },
    async ([job]) => {
      if (!job) return
      const controller = new AbortController()
      controllers.add(controller)
      try {
        return await runComparison(db, job.data.comparisonId, {
          signal: AbortSignal.any([controller.signal, job.signal]),
        })
      } finally {
        controllers.delete(controller)
      }
    }
  )
  // 派活：领单（同一个任务的合并成一个）、每分钟清扫（pg-boss 的 schedule，按队列名覆盖，多个 worker 只注册一份）
  await boss.work<{ taskId: string }>(
    QUEUES.workPump,
    { ...polling, localConcurrency: 2 },
    async ([job]) => {
      if (!job) return
      const result = await pumpTask(db, job.data.taskId)
      // 第三期：今天的花费到了上限，没开新运行：领单的事务已经提交，当天第一次就通知负责人（通知失败不让 work.pump 重试）
      if (result.budgetHit)
        await notifyBudgetOnce(db, job.data.taskId, result.budgetHit).catch((error) => console.warn(`[work] ${job.data.taskId} 花费上限的通知没发出去`, error))
      return result
    }
  )
  await boss.work(QUEUES.workSweep, polling, async () => sweepWork(db))
  // 派活：单最终结束时叫醒等 work.done:<单号> 的运行（第二期）
  await boss.work<{ itemId: string }>(QUEUES.workNotify, polling, async ([job]) => job && (await onWorkNotify(db, job.data)))
  await boss.schedule(QUEUES.workSweep, "* * * * *", {}, { tz: SCHEDULE_TZ })
  // 子 agent（docs/dev/sub-agents.md 6.2、7.2）：按名额放行排队的子运行（全系统一个）；子运行结束后看要不要叫醒父运行。清扫并在 work.sweep 里
  await boss.work(QUEUES.subagentPump, polling, async () => pumpSubagents(db))
  await boss.work<{ parentSessionId: string }>(QUEUES.subagentNotify, polling, async ([job]) => job && (await onSubagentNotify(db, job.data)))
  // 固化（docs/dev/solidify.md 5.6）：一版脚本往下走一步。同一版排着的只留一个（stately + singletonKey = 版本 id，队列在 QUEUE_SETUP 里建）
  await boss.work<{ versionId: string }>(QUEUES.routineCompile, { ...polling, localConcurrency: 2 }, async ([job]) => {
    if (job) await handleCompileJob(db, job.data)
  })
  // 固化的清扫（docs/dev/solidify.md 17.3）：每 5 分钟补发漏发、丢了的 routine.compile（写法同派活的清扫）
  await boss.work(QUEUES.routineSweep, polling, async () => {
    await sweepRoutines(db)
  })
  await boss.schedule(QUEUES.routineSweep, "*/5 * * * *", {}, { tz: SCHEDULE_TZ })
  // 系统开的桌面：一台一个操作（同一台排着的只留一个）。几台可以同时做（关机要等 2 分钟）
  await boss.work<{ desktopId: string }>(QUEUES.desktopVm, { ...polling, localConcurrency: 4 }, async ([job]) => job && (await runVmJob(db, job.data.desktopId)))
  if (options.desktopVmSweepMs !== false) await sweepVms(db).catch((error) => console.warn("[worker] 虚拟机对账出错", error))

  const comparisons = await recoverRunningComparisons(db, (name, data, options) => boss.send(name, data, options))
  if (comparisons) log(`有 ${comparisons} 条比对中的比物，已排队继续`)

  // 兜底：还标着「执行中」的 session 都排一次（同一个 session 只会排一个；被杀掉的 worker 手里那个，心跳过期后也会被重试）
  const running = await db
    .select({ id: t.sessions.id })
    .from(t.sessions)
    .where(
      and(eq(t.sessions.status, "running"), isNotNull(t.sessions.snapshot))
    )
  for (const session of running)
    await boss.send(
      QUEUES.run,
      { sessionId: session.id },
      runJobOptions(session.id)
    )
  if (running.length) log(`有 ${running.length} 个执行中的 session，已排队继续`)

  return {
    boss,
    browser,
    async stop() {
      stopping = true
      clearInterval(desktopSweep)
      clearInterval(vmSweep)
      clearInterval(vmHealth)
      for (const controller of controllers) controller.abort()
      await boss.stop({ graceful: true, timeout: 20_000 })
      // 运行都停了以后：剩下的 Chrome（等人处理保留着的、打开 Chrome的）写回或直接关掉
      await browser?.stop()
      await control?.close()
      setBrowserManager(undefined)
      unregisterBoss(db)
    },
  }
}
