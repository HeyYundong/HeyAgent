// 任务队列（pg-boss 12，和业务数据同一个 PostgreSQL，表在 pgboss schema 里）。
// - worker 进程：完整的 PgBoss（自己的连接池，跑定时、维护、心跳检查），并注册各类任务的处理函数（runtime-worker.ts）；
// - API 进程和其他调用方：第一次用到时，借 db 的连接池起一个只发任务的 PgBoss（不跑定时、不跑维护）。
// 两者都按 db 对象登记，engine/api.ts 的函数只拿到 db 也能发任务。
import { sql } from "drizzle-orm"
import {
  PgBoss,
  fromDrizzle,
  systemClock,
  type Clock,
  type SendOptions,
} from "pg-boss"
import type pg from "pg"

import type { Db } from "../db/client.js"

export const QUEUES = {
  /** 执行或继续一个 session；singletonKey = sessionId，同一个 session 同时只有一个在跑 */
  run: "session.run",
  /** 到点叫醒挂起的 session */
  wake: "session.wake",
  /** 兜底期限到了：只提醒负责人 */
  remind: "session.remind",
  /** 人加的待办到点（时间触发）；兜底期限到了提醒 */
  todoFire: "todo.fire",
  todoRemind: "todo.remind",
  /** cron：任务的定时运行、人加的 cron 待办。按对象 id 作为 schedule key */
  taskCron: "task.cron",
  todoCron: "todo.cron",
  /** 导入：读包（解压、挪密钥、读包 agent、整理方案）；singletonKey = 导入 id */
  importRead: "import.read",
  /** 比物：一次比对（两张图交给视觉模型）；singletonKey = 比对 id */
  compareRun: "compare.run",
  /** 派活：给一个被派任务领单（按名额开运行）；singletonKey = 任务 id，同一个任务同时最多一个在领、一个在排 */
  workPump: "work.pump",
  /** 派活：每分钟清扫（补写漏掉的结束、给有到点的排队单的任务发 work.pump） */
  workSweep: "work.sweep",
  /** 派活：单最终结束时叫醒等 work.done:<单号> 的运行（第二期）；参数是单号 */
  workNotify: "work.notify",
} as const

export const SCHEDULE_TZ = "Asia/Shanghai"

const num = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * session.run 的任务参数：
 * - 心跳：worker 被杀掉后，心跳停了，pg-boss 的检查发现后会把任务重试（交给活着的 worker 接着跑）；
 * - 单个任务最多 1 小时（引擎跑满 30 分钟就会主动交接）；
 * - 重试次数给够：引擎自己处理模型错误，只有进程崩溃才会走到 pg-boss 的重试。
 */
export function runJobOptions(sessionId: string): SendOptions {
  return {
    singletonKey: sessionId,
    heartbeatSeconds: Math.max(
      10,
      Math.round(num("HEYAGENT_RUN_HEARTBEAT_SECONDS", 30))
    ),
    expireInSeconds: 3600,
    retryLimit: 50,
    retryDelay: 2,
  }
}

/**
 * import.read 的任务参数：要心跳（worker 被杀掉后交给活着的 worker 从头读）；单个任务最多 60 分钟
 * （读包自己跑满 55 分钟就停，见 imports/limits.ts；大的包要读几十步）；进程崩溃才走 pg-boss 的重试，给两次
 */
export function importReadJobOptions(importId: string): SendOptions {
  return {
    singletonKey: importId,
    heartbeatSeconds: Math.max(10, Math.round(num("HEYAGENT_RUN_HEARTBEAT_SECONDS", 30))),
    expireInSeconds: 3600,
    retryLimit: 2,
    retryDelay: 5,
  }
}

/**
 * compare.run 的任务参数：一次比对正常十几秒，最多 5 分钟；要心跳（worker 被杀掉后交给活着的 worker 重比）；
 * 模型出错由 compare/run.ts 自己重试，只有进程崩溃才走 pg-boss 的重试，给两次
 */
export function compareRunJobOptions(comparisonId: string): SendOptions {
  return {
    singletonKey: comparisonId,
    heartbeatSeconds: Math.max(10, Math.round(num("HEYAGENT_RUN_HEARTBEAT_SECONDS", 30))),
    expireInSeconds: 300,
    retryLimit: 2,
    retryDelay: 5,
  }
}

/** work.pump 的任务参数：同一个任务的领单合并成一个（stately + singletonKey）；领单只是几条 SQL，出错重试几次 */
export function workPumpJobOptions(taskId: string): SendOptions {
  return { singletonKey: taskId, expireInSeconds: 300, retryLimit: 5, retryDelay: 5 }
}

/** work.notify 的任务参数：只是找等待、resume，出错重试几次（叫醒是幂等的） */
export function workNotifyJobOptions(): SendOptions {
  return { expireInSeconds: 300, retryLimit: 5, retryDelay: 5 }
}

const QUEUE_SETUP: { name: string; policy: "standard" | "stately" }[] = [
  { name: QUEUES.run, policy: "stately" },
  { name: QUEUES.wake, policy: "standard" },
  { name: QUEUES.remind, policy: "standard" },
  { name: QUEUES.todoFire, policy: "standard" },
  { name: QUEUES.todoRemind, policy: "standard" },
  { name: QUEUES.taskCron, policy: "standard" },
  { name: QUEUES.todoCron, policy: "standard" },
  { name: QUEUES.importRead, policy: "stately" },
  { name: QUEUES.compareRun, policy: "stately" },
  { name: QUEUES.workPump, policy: "stately" },
  { name: QUEUES.workSweep, policy: "standard" },
  { name: QUEUES.workNotify, policy: "standard" },
]

export async function ensureQueues(boss: PgBoss) {
  for (const queue of QUEUE_SETUP)
    await boss.createQueue(queue.name, {
      policy: queue.policy,
      retryLimit: 3,
      retryDelay: 5,
    })
}

const registry = new WeakMap<object, Promise<PgBoss>>()

/** worker 启动时登记自己的完整 PgBoss，之后这个 db 上的发任务都走它 */
export function registerBoss(db: Db, boss: PgBoss) {
  registry.set(db, Promise.resolve(boss))
}

export function unregisterBoss(db: Db) {
  registry.delete(db)
}

/** 这个 db 对应的 PgBoss；没有登记过就借 db 的连接池起一个只发任务的 */
export function bossFor(db: Db): Promise<PgBoss> {
  let boss = registry.get(db)
  if (!boss) {
    boss = startSenderBoss(db)
    registry.set(db, boss)
    boss.catch(() => registry.delete(db))
  }
  return boss
}

/** 只发任务的实例：它自己的定时器（刷新队列缓存等）不拖住进程退出，API 进程、测试、脚本关掉连接池就能退出 */
const unrefClock: Clock = {
  ...systemClock,
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref()
    return timer
  },
  setInterval: (fn, ms) => {
    const timer = setInterval(fn, ms)
    timer.unref()
    return timer
  },
}

async function startSenderBoss(db: Db) {
  const pool = (db as unknown as { $client: pg.Pool }).$client
  const boss = new PgBoss({
    db: {
      executeSql: async (text, values) => pool.query(text, values as unknown[]),
    },
    schedule: false,
    supervise: false,
    registerInstance: false,
    clock: unrefClock,
  })
  boss.on("error", (error) => console.error("[queue] pg-boss 出错", error))
  await boss.start()
  await ensureQueues(boss)
  return boss
}

/** API 进程启动时调用：先把发任务用的 pg-boss 起好（建 pgboss schema 和队列），不注册任何处理函数 */
export async function initEngineClient(db: Db) {
  await bossFor(db)
}

/** 停掉某个 db 上借池子起的发任务实例（测试、进程退出时） */
export async function stopSenderBoss(db: Db) {
  const boss = registry.get(db)
  registry.delete(db)
  if (boss)
    await (await boss).stop({ graceful: false, close: false }).catch(() => {})
}

/** 事务里发任务：和业务写入一起提交或一起回滚 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
export const txQueue = (tx: Tx) => ({ db: fromDrizzle(tx, sql) })

export async function sendInTx(
  db: Db,
  tx: Tx,
  name: string,
  data: object,
  options: SendOptions = {}
) {
  const boss = await bossFor(db)
  return boss.send(name, data, { ...options, ...txQueue(tx) })
}
