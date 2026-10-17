// 当前登录的人（tRPC me.get）。外壳拿到 me 以后才渲染页面，所以页面里的 useMe() 总有值。
// 替代原型 lib/demo.tsx 的 useDemo()：user、isAdmin 的含义不变，只是来自登录而不是演示开关。
import * as React from "react"
import type { Me } from "@heyagent/shared"

interface SessionValue {
  user: Me
  isAdmin: boolean
}

const SessionContext = React.createContext<SessionValue | undefined>(undefined)

export function SessionProvider({ me, children }: { me: Me; children: React.ReactNode }) {
  const value = React.useMemo(() => ({ user: me, isAdmin: me.isAdmin }), [me])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useMe() {
  const context = React.useContext(SessionContext)
  if (!context) throw new Error("useMe 必须在登录后的外壳里使用")
  return context
}
