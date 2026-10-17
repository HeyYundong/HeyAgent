import { Suspense, lazy } from "react"
import { useQuery } from "@tanstack/react-query"
import { RotateCwIcon, TriangleAlertIcon } from "lucide-react"

import { LoginForm } from "@/components/login-form"
import { AppSidebar } from "@/components/shell/app-sidebar"
import { LiveSync } from "@/components/shell/live-sync"
import { SiteHeader, ThemeToggle } from "@/components/shell/site-header"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Spinner } from "@/components/ui/spinner"
import { Toaster } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import { getSession, SESSION_QUERY_KEY, signOut } from "@/lib/auth"
import { useRoute, type PageId } from "@/lib/router"
import { SessionProvider } from "@/lib/session"
import { isUnauthorized, queryClient, trpc } from "@/lib/trpc"

// 按页面懒加载：某个页面出错不会拖垮整个控制台
const PAGES: Record<PageId, React.LazyExoticComponent<() => React.ReactNode>> = {
  tasks: lazy(() => import("@/pages/tasks")),
  todos: lazy(() => import("@/pages/todos")),
  sessions: lazy(() => import("@/pages/sessions")),
  memory: lazy(() => import("@/pages/memory")),
  skills: lazy(() => import("@/pages/skills")),
  rules: lazy(() => import("@/pages/rules")),
  tools: lazy(() => import("@/pages/tools")),
  browsers: lazy(() => import("@/pages/browsers")),
  models: lazy(() => import("@/pages/models")),
  learn: lazy(() => import("@/pages/learn")),
}

export function App() {
  return (
    <TooltipProvider>
      <Toaster>
        <AuthGate />
      </Toaster>
    </TooltipProvider>
  )
}

/** 先问后端「登录了没有」：没登录就显示登录页，不管当前在哪个页面；登录后回到原来的页面 */
function AuthGate() {
  const session = useQuery({ queryKey: SESSION_QUERY_KEY, queryFn: getSession, staleTime: Infinity })
  const me = useQuery({ ...trpc.me.get.queryOptions(), enabled: Boolean(session.data) })

  if (session.data === null || (me.isError && isUnauthorized(me.error))) {
    return <LoginPage onSignedIn={() => void queryClient.resetQueries()} />
  }
  if (session.data && me.data) {
    return (
      <SessionProvider me={me.data}>
        <LiveSync />
        <Shell />
      </SessionProvider>
    )
  }
  if (session.isError || me.isError) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Alert variant="destructive" className="max-w-md">
          <TriangleAlertIcon />
          <AlertTitle>连不上服务器</AlertTitle>
          <AlertDescription>没拿到登录信息，可能是网络或服务暂时不可用。</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void (session.isError ? session.refetch() : me.refetch())}>
              <RotateCwIcon data-icon="inline-start" />
              重试
            </Button>
          </AlertAction>
        </Alert>
      </div>
    )
  }
  return (
    <div className="flex min-h-svh items-center justify-center">
      <Spinner />
    </div>
  )
}

async function handleSignOut() {
  await signOut()
  // 登录状态变成 null，外壳换成登录页；再清掉上一个人看过的全部数据
  await queryClient.resetQueries({ queryKey: SESSION_QUERY_KEY })
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_QUERY_KEY[0] })
}

function Shell() {
  const { page } = useRoute()
  const Page = PAGES[page]

  return (
    <SidebarProvider>
      <AppSidebar onSignOut={() => void handleSignOut()} />
      <SidebarInset className="min-w-0">
        <SiteHeader />
        <div className="flex flex-1 flex-col p-4 md:p-6">
          <Suspense fallback={<Spinner />}>
            <Page key={page} />
          </Suspense>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

/** 登录页（区块 login-01 的页面布局），右上角保留主题开关 */
function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  return (
    <div className="relative flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="absolute top-3 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <LoginForm onSignedIn={onSignedIn} />
      </div>
    </div>
  )
}

export default App
