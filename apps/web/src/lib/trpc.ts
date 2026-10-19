// 和后端的连接：tRPC 客户端 + TanStack Query。查询走 httpBatchLink，实时推送（订阅）走 SSE（httpSubscriptionLink）。
// 始终同源访问 /api：开发时由 Vite 代理到 3100，整套 pod 里由 Caddy 转给 api，cookie 自动带上。
import type { AppRouter } from "@heyagent/server/trpc"
import { QueryCache, QueryClient } from "@tanstack/react-query"
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink, TRPCClientError } from "@trpc/client"
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query"

import { SESSION_QUERY_KEY } from "@/lib/auth"

const TRPC_URL = "/api/trpc"

/** 接口回了 401（没登录、会话过期） */
export function isUnauthorized(error: unknown) {
  return error instanceof TRPCClientError && error.data?.code === "UNAUTHORIZED"
}

/** 接口回了 404（例如对话已经删了） */
export function isNotFound(error: unknown) {
  return error instanceof TRPCClientError && error.data?.code === "NOT_FOUND"
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // 查询发现会话过期（401）时，重新取一次登录状态：拿到 null，外壳就换成登录页
    onError: (error) => {
      if (isUnauthorized(error)) void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
    },
  }),
  defaultOptions: {
    queries: {
      // 有实时推送负责「数据变了就重新拉」，这里不用频繁地自己去查
      staleTime: 30_000,
      retry: (failureCount, error) => !isUnauthorized(error) && !isNotFound(error) && failureCount < 2,
    },
  },
})

export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      condition: (op) => op.type === "subscription",
      true: httpSubscriptionLink({ url: TRPC_URL }),
      false: httpBatchLink({ url: TRPC_URL }),
    }),
  ],
})

/** 页面里这样用：useQuery(trpc.tasks.list.queryOptions()) */
export const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient })
