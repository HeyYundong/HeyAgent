// 实时推送：订阅 live.onChange（SSE），哪张表变了就让相关的查询失效、重新拉（对照表在 shared 的 liveQueriesByTable）。
// 一次操作常常连着推好几条，攒 250 ms 再统一失效。"*"（断线太久补不齐、刚灌完种子数据）或不认识的表：全部重新拉。
import * as React from "react"
import { queriesForTable } from "@heyagent/shared"
import { useSubscription } from "@trpc/tanstack-react-query"

import { queryClient, trpc } from "@/lib/trpc"

const BATCH_MS = 250

/** 把一小段时间里推来的表攒起来，到点一次性让对应的查询失效 */
function createInvalidator() {
  let all = false
  let paths = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  function flush() {
    const [everything, batch] = [all, paths]
    all = false
    paths = new Set()
    if (everything) {
      void queryClient.invalidateQueries()
      return
    }
    // tRPC 的查询键第一项是路由路径的数组，例如 ["sessions", "list"]
    void queryClient.invalidateQueries({
      predicate: (query) => {
        const path = query.queryKey[0]
        return Array.isArray(path) && batch.has(path.join("."))
      },
    })
  }

  return {
    push(table: string) {
      const list = queriesForTable(table)
      if (list === null) all = true
      else list.forEach((path) => paths.add(path))
      clearTimeout(timer)
      timer = setTimeout(flush, BATCH_MS)
    },
    dispose() {
      clearTimeout(timer)
    },
  }
}

export function LiveSync() {
  const [invalidator] = React.useState(createInvalidator)
  React.useEffect(() => () => invalidator.dispose(), [invalidator])

  useSubscription(
    trpc.live.onChange.subscriptionOptions(undefined, {
      onData: ({ data }) => invalidator.push(data.table),
    })
  )

  return null
}
