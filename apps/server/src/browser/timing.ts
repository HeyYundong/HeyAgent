// 浏览器动作的分段用时（docs/dev/browser-speed.md D）：网关每做完一个浏览器动作记一条（MCP 调用、扫页面、检测验证码 / 登录页、
// 跳转后存档截图、页面概况、自动关弹窗），进程里留最近的 500 条，测试和基准拿来看时间花在哪。
// 环境变量 HEYAGENT_BROWSER_TIMING=1 时同时打到日志里（排查线上慢的时候开）。

export interface BrowserTiming {
  at: number
  sessionId: string
  toolId: string
  /** 网关里这次调用的总用时（含规则钩子、落库） */
  totalMs: number
  /** 各段用时（毫秒） */
  phases: Record<string, number>
}

const MAX = 500
const timings: BrowserTiming[] = []

export function recordBrowserTiming(entry: BrowserTiming) {
  timings.push(entry)
  if (timings.length > MAX) timings.splice(0, timings.length - MAX)
  if (process.env.HEYAGENT_BROWSER_TIMING === "1")
    console.info(`[browser] ${entry.sessionId} ${entry.toolId} ${entry.totalMs}ms ${Object.entries(entry.phases).map(([phase, ms]) => `${phase}=${ms}`).join(" ")}`)
}

/** 取走记下的（不给 sessionId 就全部取走） */
export function takeBrowserTimings(sessionId?: string): BrowserTiming[] {
  const out: BrowserTiming[] = []
  for (let index = timings.length - 1; index >= 0; index--) {
    if (sessionId && timings[index]!.sessionId !== sessionId) continue
    out.unshift(...timings.splice(index, 1))
  }
  return out
}

/** 分段计时：await time("mcp", () => …) 记下这一段花了多久（同名的累加） */
export function phaseTimer() {
  const phases: Record<string, number> = {}
  return {
    phases,
    async time<T>(phase: string, work: () => Promise<T>): Promise<T> {
      const started = Date.now()
      try {
        return await work()
      } finally {
        phases[phase] = (phases[phase] ?? 0) + Date.now() - started
      }
    },
  }
}
