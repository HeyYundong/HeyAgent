// 待办页留在前端的界面选项：加待办时「什么时候」的几种写法、常用 cron（docs/dev/m0-api.md 2.6）。
// 能等的事件不写在代码里（平台通用）：选项来自数据里已经在等的事件，也可以直接输入新的。
// 处理「要人办的事」时要看的几段话（原型的 humanDetails）已经合并进接口返回的 HumanItem.detail。

import type { Trigger } from "@heyagent/shared"

/** cron 输入框下面的几个常用写法，点一下就填上 */
export const cronPresets = ["0 9 * * *", "0 10 * * 1-5", "0 */2 * * *", "30 17 * * 5"]

/** 加待办时「什么时候」的四种写法 */
export const MODES: { value: Trigger["kind"]; label: string; hint: string }[] = [
  { value: "time", label: "定时一次", hint: "到这个时间做一次。" },
  { value: "cron", label: "周期（cron）", hint: "按 cron 表达式反复做：分 时 日 月 周，用空格隔开。" },
  { value: "event", label: "等事件", hint: "事件发生就做；最多等几天（下面选），到期还没等到就提醒负责人。" },
  { value: "time_or_event", label: "先到先继续", hint: "事件先发生就马上做，最晚到点也会做。适合「等回复，但明天必须跟进」。" },
]
