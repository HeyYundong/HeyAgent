// 引擎相关的接口（M1 包 P1 负责）：立即运行、取消、立即继续、处理要人办的事、附件和产物、通知、触发事件等。
// 挂在 appRouter 的 engine 下（router.ts 已经挂好，P1 不用改 router.ts）。
import { router } from "./init.js"

export const engineRouter = router({})
