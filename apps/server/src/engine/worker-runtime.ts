// worker：完整的 pg-boss（跑定时、维护、心跳检查）+ 各类任务的处理函数。worker.ts 和测试都用它。
import { PgBoss } from "pg-boss"
import { and, eq, isNotNull } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { runSession } from "./loop.js"
import {
  ensureQueues,
  QUEUES,
  registerBoss,
  runJobOptions,
  unregisterBoss,
} from "./queue.js"
import { onTaskCron, onTodoCron, onTodoFire, onTodoRemind } from "./schedule.js"
import { syncBuiltinTools } from "./tools/builtin-defs.js"
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
}

export interface EngineWorker {
  boss: PgBoss
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
    async stop() {
      stopping = true
      for (const controller of controllers) controller.abort()
      await boss.stop({ graceful: true, timeout: 20_000 })
      unregisterBoss(db)
    },
  }
}
