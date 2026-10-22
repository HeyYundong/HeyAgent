// Windows-MCP 0.8.8 的「控制权」：它发现有人在动键鼠（远程画面里、或者坐在那台电脑前）后的一小段时间里拒绝 agent 的调用，
// 工具结果是 isError + 一段 JSON（windows_mcp/tools/control_notifications.py 的 _blocked）：
//   {"code": "USER_CONTROL", "status": {"state": "user", "generation": 4, "wait_seconds": 2.72}}
// code（windows_mcp/desktop/control.py）：
// - USER_CONTROL：人在操作，wait_seconds 秒后（人停手 10 秒）交还；
// - TAKEOVER_PENDING：人刚动了一下，正在判断要不要交给人（约 0.3 秒）；
// - PHYSICAL_INPUT_HELD：有键或鼠标键按着没松；
// - CONTROL_UNAVAILABLE：暂时拿不到控制权（指示器出问题等）；
// - CONTROL_PREEMPTED：做到一半被人抢走，status.executed_steps 是已经做了几步（做了的不能当没做过重来）。
// desktop.* 调 MCP 时遇到这些就等一会儿重试（等 wait_seconds 再多一点，总共最多约 15 秒），还不行才报错。

export const CONTROL_CODES = ["USER_CONTROL", "TAKEOVER_PENDING", "PHYSICAL_INPUT_HELD", "CONTROL_UNAVAILABLE", "CONTROL_PREEMPTED"] as const
export type ControlCode = (typeof CONTROL_CODES)[number]

export interface ControlBlock {
  code: ControlCode
  state?: string
  waitSeconds: number
  /** CONTROL_PREEMPTED 时已经做了几步 */
  executedSteps: number
}

/** 等多久重试：总共最多 maxWaitMs；每次等 wait_seconds 再加 marginMs，最少 minDelayMs。测试里可以改小 */
export const desktopControlRetry = { maxWaitMs: 15_000, marginMs: 300, minDelayMs: 300 }

/** 从工具结果（或报错信息）里认出控制权被拒；不是就返回 undefined */
export function parseControlBlock(text: string): ControlBlock | undefined {
  if (!/"code"\s*:\s*"(USER_CONTROL|TAKEOVER_PENDING|PHYSICAL_INPUT_HELD|CONTROL_UNAVAILABLE|CONTROL_PREEMPTED)"/.test(text)) return undefined
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  try {
    const body = JSON.parse(text.slice(start, end + 1)) as { code?: unknown; status?: { state?: unknown; wait_seconds?: unknown; executed_steps?: unknown } }
    if (!CONTROL_CODES.includes(body.code as ControlCode)) return undefined
    const wait = Number(body.status?.wait_seconds)
    const steps = Number(body.status?.executed_steps)
    return {
      code: body.code as ControlCode,
      ...(typeof body.status?.state === "string" ? { state: body.status.state } : {}),
      waitSeconds: Number.isFinite(wait) && wait > 0 ? wait : 0,
      executedSteps: Number.isFinite(steps) && steps > 0 ? steps : 0,
    }
  } catch {
    return undefined
  }
}

/** 能不能重试：做到一半被抢走的（已经做了几步）不重试，免得点两次、输两遍 */
export const retryable = (block: ControlBlock) => !(block.code === "CONTROL_PREEMPTED" && block.executedSteps > 0)

/** 这次等多久（毫秒） */
export const retryDelayMs = (block: ControlBlock) => Math.max(desktopControlRetry.minDelayMs, Math.round(block.waitSeconds * 1000) + desktopControlRetry.marginMs)

export const HUMAN_BUSY_TEXT = "有人正在操作这台桌面（远程画面里），等人停手再试"
