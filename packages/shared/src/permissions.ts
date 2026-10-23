// 权限（已定）：员工能看全部，只能操作自己负责的或分给自己的；主管全部能操作。
// 有几样只有主管能做（原型里只给主管显示按钮）：新建任务、改配置（记忆 / 技能 / 规则 / 工具 / 浏览器 / 模型）。
// 前后端共用：页面按它决定显示不显示按钮，后端按它决定接不接受请求（M1 起有写操作）。

export interface Actor {
  id: string
  isAdmin: boolean
}

/** 每种操作要什么样的资源信息 */
export interface ActionResources {
  /** 看任何东西：员工也能看全部 */
  view: Record<string, never>
  /** 新建任务（原型只有主管有「新建任务」） */
  "task.create": Record<string, never>
  /** 启用 / 停用、立即运行、编辑、把探索出的步骤存为任务步骤 */
  "task.manage": { ownerId: string }
  /** 让挂起的 session 立即继续 */
  "session.resume": { taskOwnerId: string }
  /** 处理要人办的事：审批、验收争议、登录、记忆审核、技能修改 */
  "humanItem.resolve": { assigneeId: string }
  /** 给某个任务加一条待办（只能给自己负责的任务加） */
  "todo.create": { taskOwnerId: string }
  /** 待办的「立即执行」：加这条的人、任务负责人 */
  "todo.run": { createdById: string; taskOwnerId: string }
  /** 编辑、删除待办：加这条的人 */
  "todo.manage": { createdById: string }
  /** 在远程画面里登录、过验证码（主管和员工都能用） */
  "browser.login": Record<string, never>
  /** 改配置：记忆、技能、规则、工具、Chrome、账号并发上限、模型服务、默认模型 */
  "config.manage": Record<string, never>
  /** 用户管理：建账号、改角色、停用、重置密码（只有主管） */
  "user.manage": Record<string, never>
  /** 全局设置：花费上限、步数、兜底天数、外部事件令牌、通知渠道、API 密钥（只有主管） */
  "settings.manage": Record<string, never>
  /** 往图库里传图（所有人） */
  "gallery.upload": Record<string, never>
  /** 改图库里一张图的文本和标签、删掉它：上传的人（API 密钥传的算密钥的创建人） */
  "gallery.manage": { createdById: string }
  /** 比物：发起一次比对（所有人） */
  "compare.create": Record<string, never>
  /** 删除一条比对记录：发起的人（API 密钥发起的算密钥的创建人）；比对标准是配置，用 config.manage */
  "compare.manage": { createdById: string }
  /** 从模板新建系统开的桌面（所有人；模板、存放位置的设置是 config.manage） */
  "desktop.create": Record<string, never>
  /** 系统开的桌面开机、关机、重启、重置、删除、改名：建的人 */
  "desktop.manage": { createdById: string }
  /** 派活单的重办、不办了、改参数：被派任务的负责人（人手动派一张用被派任务的 task.manage） */
  "work.manage": { taskOwnerId: string }
}

export type Action = keyof ActionResources

export function can<A extends Action>(user: Actor, action: A, resource: ActionResources[A]): boolean {
  if (user.isAdmin) return true
  switch (action) {
    case "view":
    case "browser.login":
    case "gallery.upload":
    case "compare.create":
    case "desktop.create":
      return true
    case "task.create":
    case "config.manage":
    case "user.manage":
    case "settings.manage":
      return false
    case "task.manage":
      return (resource as ActionResources["task.manage"]).ownerId === user.id
    case "session.resume":
      return (resource as ActionResources["session.resume"]).taskOwnerId === user.id
    case "humanItem.resolve":
      return (resource as ActionResources["humanItem.resolve"]).assigneeId === user.id
    case "todo.create":
      return (resource as ActionResources["todo.create"]).taskOwnerId === user.id
    case "todo.run": {
      const todo = resource as ActionResources["todo.run"]
      return todo.createdById === user.id || todo.taskOwnerId === user.id
    }
    case "todo.manage":
      return (resource as ActionResources["todo.manage"]).createdById === user.id
    case "gallery.manage":
      return (resource as ActionResources["gallery.manage"]).createdById === user.id
    case "compare.manage":
      return (resource as ActionResources["compare.manage"]).createdById === user.id
    case "desktop.manage":
      return (resource as ActionResources["desktop.manage"]).createdById === user.id
    case "work.manage":
      return (resource as ActionResources["work.manage"]).taskOwnerId === user.id
    default:
      // 新加的操作忘了写规则时，员工默认不能做
      return false
  }
}
