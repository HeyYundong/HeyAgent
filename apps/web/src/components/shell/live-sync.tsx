// 实时推送：订阅 live.onChange（SSE），哪张表变了就让相关的查询失效、重新拉（对照表在 shared 的 liveQueriesByTable）。
// 一次操作常常连着推好几条：第一条到了 250 ms 后统一失效，中间来的并进这一批（不往后推，一直有推送也照样按时刷新）。
// agent 跑起来时运行相关的表一秒好几条（liveThrottledTables）：这些表两次失效之间至少隔 1 秒，页面不会一直在重新拉。
// "*"（断线太久补不齐、刚灌完种子数据）或不认识的表：全部重新拉。
import * as React from "react"
import { liveTargets, liveThrottledTables, type ChangeEvent } from "@heyagent/shared"
import { useSubscription } from "@trpc/tanstack-react-query"

import { queryClient, trpc } from "@/lib/trpc"

const BATCH_MS = 250
const THROTTLED_GAP_MS = 1000

type Batch = { all: boolean; paths: Set<string>; byId: Map<string, Set<string>> }
const emptyBatch = (): Batch => ({ all: false, paths: new Set(), byId: new Map() })

function invalidate(batch: Batch) {
  if (batch.all) {
    void queryClient.invalidateQueries()
    return
  }
  // tRPC 的查询键：[["sessions", "get"], { input: { id }, type: "query" }]，第一项是路由路径的数组
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const [path, options] = query.queryKey as [unknown, { input?: { id?: unknown } } | undefined]
      if (!Array.isArray(path)) return false
      const name = path.join(".")
      if (batch.paths.has(name)) return true
      const id = options?.input?.id
      return typeof id === "string" && Boolean(batch.byId.get(name)?.has(id))
    },
  })
}

/** 一条通道：第一条推送到了以后最晚 BATCH_MS 失效一次（和上一次至少隔 gap），中间来的并进这一批 */
function createLane(gap: number) {
  let batch = emptyBatch()
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0

  function flush() {
    timer = undefined
    last = Date.now()
    const current = batch
    batch = emptyBatch()
    invalidate(current)
  }

  return {
    push(change: ChangeEvent) {
      const targets = liveTargets(change)
      if (targets === null) batch.all = true
      else {
        targets.paths.forEach((path) => batch.paths.add(path))
        for (const { path, id } of targets.byId) batch.byId.set(path, (batch.byId.get(path) ?? new Set()).add(id))
      }
      if (timer === undefined) timer = setTimeout(flush, Math.max(BATCH_MS, last + gap - Date.now()))
    },
    dispose() {
      clearTimeout(timer)
    },
  }
}

function createInvalidator() {
  const fast = createLane(0)
  const throttled = createLane(THROTTLED_GAP_MS)
  return {
    push: (change: ChangeEvent) => (liveThrottledTables.has(change.table) ? throttled : fast).push(change),
    dispose() {
      fast.dispose()
      throttled.dispose()
    },
  }
}

export function LiveSync() {
  const [invalidator] = React.useState(createInvalidator)
  React.useEffect(() => () => invalidator.dispose(), [invalidator])

  useSubscription(
    trpc.live.onChange.subscriptionOptions(undefined, {
      onData: ({ data }) => invalidator.push(data),
    })
  )

  return null
}
