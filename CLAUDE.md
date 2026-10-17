# HeyAgent

公司内部的智能 agent 系统：用户定义任务，高级模型拆解任务并分配给子 agent（浏览器 / 电脑自动化 / API），完成繁琐的内部工作。

## UI 强规则

所有页面必须只用 shadcn 预设 `buKEvLs`（`base-lyra` 风格，Vite 模板）的组件，保持统一设计风格。只有组件库里确实没有的组件才允许自己写，并且必须先告知用户、走例外流程。完整规则、组件清单和检查清单见：

@docs/ui-rules.md

## 开发约定

正式代码的仓库结构、工具和版本、端口、容器等约定见 `docs/dev/conventions.md`。容器只用 Podman，不用 Docker。产品方案见 `docs/v1-plan.md`，当前里程碑的开发说明在 `docs/dev/`。
