// worker：完整的 pg-boss（跑定时、维护、心跳检查）+ 各类任务的处理函数。worker.ts 和测试都用它。
import { PgBoss } from "pg-boss"
import { and, eq, isNotNull } from "drizzle-orm"

import { startControlServer, type ControlServer } from "../browser/control.js"
import { BrowserManager, setBrowserManager } from "../browser/manager.js"
import { recoverRunningComparisons, runComparison } from "../compare/run.js"
import { ensureDefaultStandard } from "../compare/service.js"
import { runImportRead } from "../imports/reader.js"
import type { Db } from "../db/client.js"
import { cleanupSessionSandbox, sweepSandboxDirs, sweepThrottled } from "../sandbox/code-run.js"
import * as t from "../db/schema.js"
import { onWorkNotify } from "./dispatch/notify.js"
import { pumpTask } from "./dispatch/pump.js"
import { sweepWork } from "./dispatch/sweep.js"
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
    async ([job]) => job && (await pumpTask(db, job.data.taskId))
  )
  await boss.work(QUEUES.workSweep, polling, async () => sweepWork(db))
  // 派活：单最终结束时叫醒等 work.done:<单号> 的运行（第二期）
  await boss.work<{ itemId: string }>(QUEUES.workNotify, polling, async ([job]) => job && (await onWorkNotify(db, job.data)))
  await boss.schedule(QUEUES.workSweep, "* * * * *", {}, { tz: SCHEDULE_TZ })

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
