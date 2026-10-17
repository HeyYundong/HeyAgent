// 实时推送的数据源：一条专用连接 LISTEN heyagent_changes（库里的触发器在业务表变化时 NOTIFY，内容 { table, id }）。
// 每条变化编一个 id（启动号:序号），最近的留在内存里：前端断线重连时带上最后收到的 id，从这里补发；
// 补不齐（API 重启过、或者断太久）就发一条 { table: "*" }，让前端全部重新拉。
import { EventEmitter, on } from "node:events"
import { randomBytes } from "node:crypto"

import pg from "pg"
import { LIVE_CHANNEL, changeEventSchema, type ChangeEvent } from "@heyagent/shared"

export interface TrackedChange {
  id: string
  change: ChangeEvent
}

const BUFFER_SIZE = 1000

export class ChangeHub {
  private readonly bootId = randomBytes(4).toString("hex")
  private counter = 0
  private buffer: { n: number; change: ChangeEvent }[] = []
  private readonly emitter = new EventEmitter()
  private client: pg.Client | undefined
  private stopped = false
  private retryTimer: NodeJS.Timeout | undefined

  private readonly databaseUrl: string

  constructor(databaseUrl: string) {
    this.databaseUrl = databaseUrl
    this.emitter.setMaxListeners(0)
  }

  async start() {
    this.stopped = false
    await this.connect()
  }

  private async connect() {
    const client = new pg.Client({ connectionString: this.databaseUrl })
    client.on("notification", (message) => {
      if (message.channel !== LIVE_CHANNEL || !message.payload) return
      try {
        this.publish(changeEventSchema.parse(JSON.parse(message.payload)))
      } catch (error) {
        console.warn("[live] 收到认不出的通知", message.payload, error)
      }
    })
    client.on("error", (error) => {
      console.warn("[live] LISTEN 连接出错，稍后重连", error.message)
      this.scheduleReconnect()
    })
    client.on("end", () => this.scheduleReconnect())
    try {
      await client.connect()
      await client.query(`LISTEN ${LIVE_CHANNEL}`)
      this.client = client
    } catch (error) {
      client.removeAllListeners("end")
      await client.end().catch(() => {})
      if (this.stopped) return
      console.warn("[live] 连不上数据库，稍后重连", (error as Error).message)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.retryTimer) return
    this.client = undefined
    // 断线期间可能漏了通知，重连后让前端全部重新拉
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = undefined
      await this.connect()
      if (this.client) this.publish({ table: "*", id: null })
    }, 2000)
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    const client = this.client
    this.client = undefined
    if (client) {
      client.removeAllListeners("end")
      await client.end().catch(() => {})
    }
  }

  /** 也给测试和本进程内的写操作用：直接推一条 */
  publish(change: ChangeEvent) {
    const n = ++this.counter
    this.buffer.push({ n, change })
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift()
    this.emitter.emit("change", { id: this.idOf(n), change } satisfies TrackedChange)
  }

  private idOf(n: number) {
    return `${this.bootId}:${n}`
  }

  get latestId() {
    return this.idOf(this.counter)
  }

  /** lastEventId 之后漏掉的变化；补不齐返回 null */
  missedSince(lastEventId: string): TrackedChange[] | null {
    const [boot, raw] = lastEventId.split(":")
    const last = Number(raw)
    if (boot !== this.bootId || !Number.isInteger(last) || last > this.counter) return null
    const oldest = this.buffer[0]?.n ?? this.counter + 1
    if (last + 1 < oldest) return null
    return this.buffer.filter((item) => item.n > last).map((item) => ({ id: this.idOf(item.n), change: item.change }))
  }

  /**
   * 订阅：先补发 lastEventId 之后漏掉的，再推新的。先开始监听再补发，中间来的不会丢；按序号去重。
   */
  async *subscribe(lastEventId: string | null | undefined, signal: AbortSignal | undefined): AsyncGenerator<TrackedChange> {
    const live = on(this.emitter, "change", { signal }) as AsyncIterableIterator<[TrackedChange]>
    let sent = 0
    const numberOf = (id: string) => Number(id.split(":")[1])
    if (lastEventId) {
      const missed = this.missedSince(lastEventId)
      if (missed === null) {
        sent = this.counter
        yield { id: this.latestId, change: { table: "*", id: null } }
      } else {
        for (const item of missed) {
          sent = numberOf(item.id)
          yield item
        }
      }
    }
    try {
      for await (const [item] of live) {
        if (numberOf(item.id) <= sent) continue
        sent = numberOf(item.id)
        yield item
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") throw error
    }
  }
}
