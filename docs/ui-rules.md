# HeyAgent UI 规则

> **强规则：所有页面必须使用本项目 shadcn 预设（`buKEvLs`，即 `base-lyra` 风格）的组件库组件，保持统一的设计风格。只有在组件库中确实没有对应组件时，才允许编写自定义组件，并且必须走下文的「例外流程」。**

适用范围：HeyAgent Web 控制台的所有页面与组件。本文档中的数值均在 2026-10-16 用 shadcn CLI 4.21.5 实测得到（在临时目录里实际 scaffold 了一遍，并读取了 CLI 源码与 ui.shadcn.com 的 registry）。CLI 或 registry 升级后，以 `npx shadcn@latest info` 和 `npx shadcn@latest search @shadcn` 的输出为准。

---

## 1. 预设规格

初始化命令（按 ui.shadcn.com/create 页面 JS 中「Get Code」的命令拼接逻辑推出；URL 中没有 `base` 参数，即使用默认 base，因此不带 `--base`）：

```bash
npx shadcn@latest init --preset buKEvLs --template vite
# 实测与下面这条等价，生成 style = base-lyra：
# npx shadcn@latest create --template vite --preset buKEvLs --name <name> --no-monorepo -y
```

禁止传入 `--base radix` / `--base aria`，或执行 `shadcn apply` 切换到其他预设，除非用户明确要求。

| 项 | 实际值 | 来源 / 验证方式 |
|---|---|---|
| 预设代码 | `buKEvLs`（预设版本 `b`） | URL；`shadcn info` 回显 `code buKEvLs` |
| 组件底层（base） | `base`，即 **Base UI**（`@base-ui/react` ^1.9.0） | 预设码本身不含 base 信息；URL 没有 `base` 参数时，网站的 `DEFAULT_CONFIG.base = "base"`；CLI 对预设码默认也用 `base`；`components.json` 的 `style: "base-lyra"`；`shadcn info` 显示 `base base` |
| 风格（style） | `lyra`。官方描述："Boxy and sharp. For mono fonts." | 用 CLI 自带的 `decodePreset("buKEvLs")` 解码；`components.json` |
| 基础色（baseColor） | `neutral` | 解码结果；`components.json` 的 `tailwind.baseColor` |
| 主题色（theme） | `red`。浅色模式 `--primary: oklch(0.505 0.213 27.518)`，暗色模式 `oklch(0.444 0.177 26.899)` | 解码结果；`src/index.css` |
| 图表色（chartColor） | `neutral`，即 `--chart-1..5` 全部是灰阶 | 解码结果；`src/index.css` |
| 图标库 | `lucide`（`lucide-react` ^1.58.0） | 解码结果；`components.json`；`package.json` |
| 正文字体 | `inter`，来自 `@fontsource-variable/inter` ^5.3.0，定义为 `--font-sans: 'Inter Variable', sans-serif` | 解码结果；`src/index.css` |
| 标题字体 | `inherit`，即 `--font-heading: var(--font-sans)` | 解码结果；`src/index.css` |
| 圆角（radius） | 预设码里是 `large`，CSS 中生成 `--radius: 0.875rem`。**但 lyra 组件源码写死了 `rounded-none`，所以实际视觉是直角**；圆形元素（avatar、switch 等）用 `rounded-full`。网站对 lyra/sera 风格会把 radius 显示并锁定为 `none` | 解码结果；`src/index.css`；抽查 registry 源码（`rounded-none` 出现 47 次，`rounded-full` 11 次）；网站 JS |
| 菜单强调（menuAccent） | `subtle` | 解码结果；`components.json` |
| 菜单配色（menuColor） | `default` | 解码结果；`components.json` |
| RTL | `false` | `components.json` |
| 按钮手型光标（pointer） | 未启用 | URL 中没有 `pointer` 参数；网站 `DEFAULT_CONFIG.pointer = false` |
| CSS 变量 | `true` | CLI 默认值 |
| 模板 | Vite：React ^19.3、Tailwind CSS v4（`@tailwindcss/vite`）、TypeScript ~6.0、Vite ^8、路径别名 `@/` 指向 `src/` | 生成的 `package.json`、`vite.config.ts` |
| 暗色模式 | 在 `<html>` 上加 `.dark` 类；`@custom-variant dark (&:is(.dark *))`；由 `src/components/theme-provider.tsx` 提供 `ThemeProvider` 和 `useTheme`（默认跟随 `system`，存储键为 `theme`，按 `d` 键切换） | 生成的文件 |
| `cn` 工具 | `cn` 包 ^0.4.0（shadcn-ui/cn），由 `src/lib/utils.ts` 重新导出 | 生成的文件 |

**主题 token**（`src/index.css` 的 `:root` 与 `.dark`，通过 `@theme inline` 映射为 Tailwind 类名）：
`background` `foreground` `card` `card-foreground` `popover` `popover-foreground` `primary` `primary-foreground` `secondary` `secondary-foreground` `muted` `muted-foreground` `accent` `accent-foreground` `destructive` `border` `input` `ring` `chart-1`…`chart-5` `sidebar` `sidebar-foreground` `sidebar-primary` `sidebar-primary-foreground` `sidebar-accent` `sidebar-accent-foreground` `sidebar-border` `sidebar-ring`；圆角 `radius-sm`…`radius-4xl`；字体 `font-sans` `font-heading`。

使用这些 token 时要注意：

- **没有** `success`、`warning`、`info` 语义色，也没有 `destructive-foreground`。
- `primary`（red）和 `destructive` 色相相同，都是红色。所以不能只靠颜色区分危险操作，必须用 `variant="destructive"`、`AlertDialog` 二次确认和明确的文案。
- `--chart-1..5` 都是灰阶，多系列图表只能靠灰度深浅来区分。
- Inter 不含中文字形，中文会回退到系统的 `sans-serif` 字体。这是预期行为，不要为此另外引入字体。
- 预设没有配置等宽字体，`font-mono` 使用 Tailwind 默认的等宽字体栈。

---

## 2. 组件清单（base-lyra registry，共 65 个 `registry:ui`）

添加方式统一为 `npx shadcn@latest add <add 名>`，可以一次添加多个。组件安装到 `src/components/ui/`，从 `@/components/ui/<name>` 导入。

### 2.1 布局 / 导航（13）

| 组件 | 用途 | add 名 |
|---|---|---|
| Sidebar | 可折叠的应用侧边栏，在移动端变为 Sheet（附带 `use-mobile` hook） | `sidebar` |
| Breadcrumb | 层级路径导航 | `breadcrumb` |
| Navigation Menu | 顶部导航链接，可带下拉 | `navigation-menu` |
| Menubar | 桌面应用式常驻菜单栏 | `menubar` |
| Tabs | 标签页切换（变体：`default` / `line`） | `tabs` |
| Pagination | 分页 | `pagination` |
| Separator | 分隔线 | `separator` |
| Scroll Area | 自定义样式的滚动区域 | `scroll-area` |
| Resizable | 可拖拽调整尺寸的分栏面板 | `resizable` |
| Accordion | 手风琴折叠区 | `accordion` |
| Collapsible | 单个展开 / 收起面板 | `collapsible` |
| Aspect Ratio | 固定宽高比容器 | `aspect-ratio` |
| Direction | 文本方向 Provider（RTL 用，本项目一般用不到） | `direction` |

### 2.2 表单 / 输入（19）

| 组件 | 用途 | add 名 |
|---|---|---|
| Field | 组合标签、控件、说明和错误信息，**所有表单项都用它** | `field` |
| Label | 无障碍标签 | `label` |
| Input | 单行输入 | `input` |
| Input Group | 带前后缀、按钮、Textarea 的输入组合 | `input-group` |
| Textarea | 多行输入 | `textarea` |
| Input OTP | 验证码输入 | `input-otp` |
| Checkbox | 复选框 | `checkbox` |
| Radio Group | 单选组 | `radio-group` |
| Switch | 开关 | `switch` |
| Slider | 滑块 | `slider` |
| Select | 下拉选择 | `select` |
| Native Select | 原生 `<select>` 的统一样式版本 | `native-select` |
| Combobox | 可搜索、自动补全的选择器 | `combobox` |
| Calendar | 日期 / 日期范围选择（react-day-picker） | `calendar` |
| Button | 按钮（变体：`default` `outline` `secondary` `ghost` `destructive` `link`；尺寸：`xs` `sm` `default` `lg` `icon*`） | `button` |
| Button Group | 按钮组 | `button-group` |
| Toggle | 两态按钮 | `toggle` |
| Toggle Group | 两态按钮组 | `toggle-group` |
| Form | **空条目，没有任何文件**。表单请用 `field` 搭配表单库，见 §3 | ~~`form`~~ |

### 2.3 数据展示（9）

| 组件 | 用途 | add 名 |
|---|---|---|
| Card | 卡片容器（Header / Title / Description / Action / Content / Footer） | `card` |
| Table | 基础表格 | `table` |
| Chart | 基于 Recharts 3.8.0 的图表容器、Tooltip、Legend | `chart` |
| Badge | 标签和状态徽章（变体：`default` `secondary` `destructive` `outline` `ghost` `link`） | `badge` |
| Avatar | 头像 | `avatar` |
| Item | 通用列表项：媒体、标题、描述、操作（变体：`default` `outline` `muted`） | `item` |
| Kbd | 快捷键显示 | `kbd` |
| Carousel | 轮播（Embla） | `carousel` |
| Code Block | 代码、终端输出、diff 展示，带行号和复制按钮（使用 shiki 高亮，附带 `use-highlighted-code` hook） | `code-block` |

### 2.4 反馈 / 状态（7）

| 组件 | 用途 | add 名 |
|---|---|---|
| Alert | 页内提示条 | `alert` |
| Toast | **首选的通知组件**（Base UI Toast）：根部挂 `<Toaster />`，调用 `toast.add({ title, description, type })`；`type` 支持 success / info / warning / error / loading，另有 `toast.promise` | `toast` |
| Sonner | 旧的 toast 实现，**不使用**：它依赖 `next-themes`，不会跟随本项目的 `ThemeProvider`；而且 base 版 Sonner 文档页已经重定向到 Toast | ~~`sonner`~~ |
| Progress | 进度条 | `progress` |
| Spinner | 加载指示 | `spinner` |
| Skeleton | 骨架屏 | `skeleton` |
| Empty | 空状态 | `empty` |

### 2.5 浮层 / 菜单（10）

| 组件 | 用途 | add 名 |
|---|---|---|
| Dialog | 模态对话框 | `dialog` |
| Alert Dialog | 需要用户明确响应的确认框 | `alert-dialog` |
| Sheet | 侧滑面板 | `sheet` |
| Drawer | 底部抽屉（移动端友好） | `drawer` |
| Popover | 弹出层 | `popover` |
| Hover Card | 悬停预览卡片 | `hover-card` |
| Tooltip | 提示 | `tooltip` |
| Dropdown Menu | 按钮触发的操作菜单 | `dropdown-menu` |
| Context Menu | 右键菜单 | `context-menu` |
| Command | 命令面板 / 搜索（cmdk），适合做 ⌘K | `command` |

### 2.6 AI / 对话（7）

| 组件 | 用途 | add 名 |
|---|---|---|
| Trace | 推理、工具调用、步骤的行式记录。`TraceLine` 支持 `status="running" \| "error" \| "pending"`，可以用 `TraceCollapsible` 折叠或嵌套 | `trace` |
| Message | 对话中的一条消息，可带头像、头部、尾部，可设置左右对齐 | `message` |
| Bubble | 消息气泡（变体：`default` `secondary` `muted` `tinted` `outline` `ghost` `destructive`），支持分组和表情回应 | `bubble` |
| Message Scroller | 聊天滚动容器：跟随流式输出、加载历史时不跳动、跳转到指定消息 | `message-scroller` |
| Attachment | 文件或图片附件，带元数据、上传状态和操作（变体：`icon` / `image`） | `attachment` |
| Marker | 对话中的行内状态、系统提示或带标签的分隔（变体：`default` `separator` `border`） | `marker` |
| Questionnaire | 多步问卷：单选、多选、自由输入、可跳过 | `questionnaire` |

另有 hooks `use-mobile` 和 `use-highlighted-code`，以及 lib `utils`，它们会作为依赖自动安装。`shadcn/tailwind.css` 自带工具类 `no-scrollbar`、`scroll-fade*`、`shimmer`，可以直接使用。

### 2.7 Blocks（区块，30 个 `registry:block`）

| 区块 | 说明 | add 名 |
|---|---|---|
| Dashboard | 侧边栏 + 图表 + 数据表的后台页（依赖 `@tanstack/react-table`、`@dnd-kit/*`、`zod`，并且会引入 `sonner`，引入时要按 §2.4 换成 `toast`） | `dashboard-01` |
| Sidebar ×16 | 01 按分组导航 / 02 可折叠分组 / 03 子菜单 / 04 浮动 / 05 可折叠子菜单 / 06 子菜单为下拉 / **07 折叠成图标** / 08 内嵌加二级导航 / 09 嵌套侧栏 / 10 放在 Popover 中 / **11 可折叠文件树** / 12 带日历 / 13 放在 Dialog 中 / 14 右侧 / 15 左右双栏 / **16 带吸顶 header** | `sidebar-01` … `sidebar-16` |
| Login ×5 | 01 简单表单 / 02 双栏带封面 / 03 muted 背景 / 04 表单加图片 / 05 仅邮箱 | `login-01` … `login-05` |
| Signup ×5 | 与 Login 对应的注册页 | `signup-01` … `signup-05` |
| Preview ×3 | create 页面用的预览区块，**不要用于项目** | `preview` `preview-02` `preview-03` |

区块的注意事项：区块里的 `page.tsx` 目标路径是 Next.js 的 `app/...`，在 Vite 项目中会被跳过，只有 `src/components/*.tsx`（如 `app-sidebar.tsx`、`nav-main.tsx`）会被写入，页面需要接到自己的路由里。添加区块前先跑 `--dry-run`：实测区块可能要求覆盖已有的 `ui/*` 文件，确认差异后再决定是否覆盖。

### 2.8 Charts

base-lyra 的 registry 中**没有** `chart-*` 图表区块（`chart-area-default` 等返回 404，只有旧的 `new-york-v4` 风格提供，**不得混用其他风格**）。图表一律这样做：用 `chart` 组件（`ChartContainer` / `ChartTooltip` / `ChartLegend`）加 Recharts 原语，在业务组件里组合，参考 ui.shadcn.com/charts 与 `npx shadcn@latest docs chart`。颜色只能用 `var(--chart-1)` … `var(--chart-5)`。

### 2.9 只有文档、没有 registry 条目的官方 Pattern

下面这些在官网文档里有，但**不能 `add`**，需要复制官方代码，因此一律按「例外流程」处理（见 §6）：

- Data Table（`table` + `@tanstack/react-table`）
- Date Picker（`popover` + `calendar`）
- Forms 指南（React Hook Form / TanStack Form / Formisch，配合 `field`）
- Typeset / Typography（渲染 Markdown 的 CSS 文件）
- **AI Elements Patterns**（`/docs/ai-elements/base/<name>`，每页都有 `.md` 版本）：`chain-of-thought` `chat` `checkpoint` `confirmation` `context` `file-tree` `inline-citation` `message` `model-selector` `plan` `prompt-input` `queue` `reasoning` `sources` `stack-trace` `subagent` `suggestion` `task` `terminal` `test-results` `tool`。它们都由上面的 registry 组件（trace、code-block、item、input-group 等）组合而成。

---

## 3. 页面组装方式

1. **先查后加**：
   ```bash
   npx shadcn@latest search @shadcn -q <关键词>     # 搜索组件、区块、hook
   npx shadcn@latest view @shadcn/<name>            # 查看源码与依赖
   npx shadcn@latest docs <name>                    # 文档、示例、Base UI API 链接
   npx shadcn@latest add <name...>                  # 添加；区块先加 --dry-run
   npx shadcn@latest info                           # 确认 style 仍为 base-lyra、preset 仍为 buKEvLs
   ```
2. **导入约定**：
   - UI 组件：`import { Button } from "@/components/ui/button"`
   - 工具函数：`import { cn } from "@/lib/utils"`
   - 图标：`import { PlayIcon } from "lucide-react"`（与生成代码一致，用 `XxxIcon` 命名）
   - 主题：`import { useTheme } from "@/components/theme-provider"`
3. **Base UI 的组合方式**：用 `render` prop，**不是** Radix 的 `asChild`。例如 `<DialogTrigger render={<Button variant="outline" />}>打开</DialogTrigger>`。不要在页面里直接 import `@base-ui/react`，一律通过 `@/components/ui/*` 使用。
4. **按钮内图标**：在图标上加 `data-icon="inline-start"` 或 `"inline-end"`，组件会自动调整内边距和图标尺寸，不要手写 `size-*` 或 `mr-*`。
5. **表单**：UI 一律用 `Field` 系列（`Field` `FieldLabel` `FieldDescription` `FieldError` `FieldGroup` `FieldSet` `FieldLegend`）。表单状态库按官方 `/docs/forms` 选用 React Hook Form 或 TanStack Form，引入时需用户确认。不要 `add form`。
6. **暗色模式**：`ThemeProvider` 已包在 `main.tsx` 中。主题切换 UI 用 `useTheme().setTheme("light" | "dark" | "system")` 搭配 `DropdownMenu` 或 `ToggleGroup`。只用 token 就会自动适配暗色，**不要**写 `dark:bg-zinc-900` 这类代码。
7. **更新组件**：执行 `npx shadcn@latest add <name> --diff`，确认差异后再 `--overwrite`，不要手改。
8. **给 Agent 用的 MCP 和 Skill（可选）**：
   - `npx shadcn@latest mcp init --client claude` 会写入 `.mcp.json`，内容为 `{"mcpServers":{"shadcn":{"command":"npx","args":["shadcn@latest","mcp"]}}}`。提供的工具有：`get_project_registries`、`list_items_in_registries`、`search_items_in_registries`、`view_items_in_registries`、`get_item_examples_from_registries`、`get_add_command_for_items`、`get_audit_checklist`。
   - 官方 skill 的安装命令是 `npx skills add shadcn/ui`（文档写法为 `pnpm dlx skills add shadcn/ui`）。

---

## 4. 常见需求 → 用哪个组件

「例外」列为 **是** 的需求，registry 中没有现成组件，必须先走 §6 例外流程。

| 需求 | 用这些 registry 组件 / 区块 | 例外 |
|---|---|---|
| 侧边栏导航 | `sidebar` + 区块 `sidebar-07`（折叠为图标）或 `sidebar-16`（吸顶 header）；顶部用 `breadcrumb`；全局搜索用 `command` + `kbd` | 否 |
| 任务列表 | `table` + `badge`（状态）+ `dropdown-menu`（行操作）+ `checkbox`（多选）+ `pagination`；筛选栏用 `input-group` `select` `toggle-group` | 否 |
| 任务列表需要排序、过滤、列显隐、虚拟滚动 | 官方 Data Table Pattern（需引入 `@tanstack/react-table`），或从 `dashboard-01` 区块的 `data-table.tsx` 起步 | **是**（新依赖加通用封装） |
| 任务详情 | `card` `tabs`（概览 / 步骤 / 日志 / 产物）`item` `badge` `separator`；侧滑详情用 `sheet`；三栏布局用 `resizable` | 否 |
| 子任务树（planner 拆解出的层级） | registry 没有 Tree 组件。浅层结构可以用 `trace` + `TraceCollapsible` 嵌套，或 `collapsible` 嵌套；参考 Pattern `subagent` / `file-tree` 和区块 `sidebar-11` | **是**（通用树组件） |
| 任务拆解的 DAG / 流程图 | 没有对应组件（官方建议用 React Flow 搭配 `card` `button-group`） | **是** |
| 步骤时间线 / 执行进度 | `trace`（`TraceLine status` 加 `TraceIcon`、`TraceTitle`、`TraceDescription`）；整体进度用 `progress` | 否；如果要落地 Pattern `plan` / `task` / `queue` 则为**是** |
| 执行日志 / 工具调用输出 | `code-block`（终端输出、行号、复制、diff）+ `scroll-area`；工具调用用 `trace` 包裹 `code-block` | 否；Pattern `terminal` / `tool` / `stack-trace` 的落地为**是** |
| 大量实时流式日志（需要虚拟化或跟随滚动） | 没有对应组件（`message-scroller` 只面向对话） | **是** |
| 对话式任务输入 | `input-group`（`InputGroupTextarea` + `InputGroupButton`）+ `attachment` + `dropdown-menu`；对话流用 `message` `bubble` `message-scroller` `marker` | 否；Pattern `prompt-input` / `chat` 的落地为**是** |
| Agent 输出的 Markdown 渲染 | 没有 registry 组件（官方方案是 Typeset CSS 加 Markdown 渲染库） | **是** |
| 状态徽章（pending / running / success / failed / 待审批） | `badge` 的变体 + `spinner`（running）+ lucide 图标 + 文字。建议的映射：running → `secondary` 加 `Spinner`；success → `outline` 加 `CircleCheckIcon`；failed → `destructive`；待审批 → `default`；pending / 已取消 → `ghost` 或 `outline` | 否；如果需要绿色、黄色等语义色，属于新增 token，为**是** |
| 模型选择器 | 固定列表用 `select`，可搜索用 `combobox`，菜单式用 `dropdown-menu` | 否；Pattern `model-selector` 的落地为**是** |
| 人工审批对话框（human-in-the-loop） | 阻断式确认用 `alert-dialog`；需要填写意见或修改参数时用 `dialog` + `field`；危险操作按钮用 `variant="destructive"`；结构化提问用 `questionnaire` | 否；内联审批卡 Pattern `confirmation` 的落地为**是** |
| 通知 / Toast | `toast`（根部挂 `<Toaster />`，调用 `toast.add` / `toast.promise`）；页内常驻提示用 `alert` | 否 |
| 通知中心（历史列表加未读数） | `popover` 或 `sheet` + `item` + `badge` + `scroll-area` 组合 | 否 |
| 截图查看器 | 缩略图用 `attachment`（`image` 变体）或 `aspect-ratio`；大图用 `dialog`；多张截图用 `carousel`；超长截图用 `scroll-area` | 否 |
| 截图缩放、平移、标注 | 没有对应组件 | **是** |
| 设置表单 | `field` + `input` / `select` / `switch` / `radio-group` / `slider` / `textarea`；分区用 `tabs` 或 `sidebar`；保存反馈用 `toast` | 否（表单库需用户确认） |
| 日期 / 时间范围筛选 | `popover` + `calendar` | 否；封装成通用 DatePicker 则为**是** |
| 空状态 | `empty`（`EmptyMedia variant="icon"` 加 lucide 图标、`EmptyTitle`、`EmptyDescription`、`EmptyContent` 放操作按钮） | 否 |
| 加载状态 | 首屏用 `skeleton`，侧边栏用 `SidebarMenuSkeleton`，局部用 `spinner`，按钮内用 `Spinner` + `data-icon`，确定进度用 `progress`，运行中的步骤用 `trace` 的 `status="running"`（自带 shimmer） | 否 |
| 上下文 / Token 用量提示 | `hover-card` + `progress` | 否；Pattern `context` 的落地为**是** |
| 统计卡片 / 图表 | `card` + `chart`（灰阶 `--chart-*`） | 否；如需彩色图表，要改预设的 chartColor，需用户决定 |

---

## 5. 样式规则

1. **只用主题 token**：颜色类只能是 §1 列出的 token，如 `bg-background` `text-muted-foreground` `border-border` `bg-primary/10`（token 加透明度修饰可以用）。
   - **禁止** hex、`rgb()`、`hsl()`、`oklch()` 字面量。
   - **禁止** Tailwind 调色板色，如 `bg-red-500` `text-gray-600` `bg-white` `text-black`。
   - **禁止**在 `style={{}}` 中写颜色或尺寸。
2. **禁止任意值**：不写 `text-[#333]`、`p-[13px]`、`w-[317px]`、`text-[13px]` 这类代码，间距、尺寸、字号只用 Tailwind 标准刻度（`p-4` `gap-2` `h-8` `text-sm` 等）。唯一的例外是组件 API 本身要求的 CSS 变量引用，例如 chart config 中的 `color: "var(--chart-1)"`。生成的 `components/ui/*` 内部用了任意值，那是库的实现细节，不能当作先例。
3. **不覆盖组件外观**：传给组件的 `className` 只用于布局（宽度、栅格位置、外边距、flex 等），不要覆盖颜色、圆角、高度、字号。尺寸和外观用 `variant` / `size` 等 props 调整。
4. **保持 lyra 的直角风格**：页面代码中不要加 `rounded-*`（`rounded-full` 只用于头像、圆点这类圆形元素，与库保持一致），也不要依赖 `--radius`。不要零散地加 `shadow-*`、`cursor-pointer` 等改变风格的类。
5. **禁止其他 UI 库**：MUI、Ant Design、Chakra、Mantine、Element、Arco、Semi、TDesign、Bootstrap、Headless UI、NextUI / HeroUI、DaisyUI、直接使用 Radix 或 React Aria、styled-components / emotion 等 CSS-in-JS。也不得混用其他 shadcn 风格（如 `new-york-v4`、`radix-*`）的组件代码。
6. **图标只用 `lucide-react`**，字体只用预设的 Inter（`font-sans` / `font-heading`）。不要引入其他图标库、Google Fonts 或 webfont。
7. **不手改 `src/components/ui/*`**：这些文件归 CLI 管理，更新用 `add <name> --diff` 加 `--overwrite`。需要新外观时，先组合现有组件和 variant；如果确实需要改 ui 文件或新增 variant，算作例外，按 §6 处理。
8. **定制靠组合**：用现有组件的子组件（如 `CardHeader`、`CardAction`、`ItemMedia`）、`render` prop 和 variant 来组合。组合 registry 组件形成的业务组件（如 `TaskTable`、`ApprovalDialog`）放在 `src/components/<feature>/`，这是正常用法，不算自定义组件。

---

## 6. 例外流程（registry 中没有对应组件时）

以下情况必须走此流程：

- 需要 registry 中没有的 UI 能力（树、流程图、缩放查看、日志虚拟滚动、Markdown 渲染等）；
- 要把 §2.9 的官方 Pattern 落地成组件；
- 要引入新的 UI 相关 npm 依赖；
- 要新增或修改主题 token；
- 要改动 `components/ui/*`。

流程如下：

1. **确认确实没有**：执行 `npx shadcn@latest search @shadcn -q <关键词>`（换 2～3 个同义词），再核对 §2 清单和 ui.shadcn.com/docs/components、AI Elements 列表。
2. **先告知用户，等用户确认后再动手**：说明要做什么、为什么 registry 不够用、打算基于哪些 shadcn 组件或 Pattern、需要哪些新依赖。
3. **实现**：放在 `src/components/<name>/`（**不放进 `ui/`**）。只用 `@/components/ui/*`、主题 token 和 `lucide-react` 来组合，遵守 §5 全部规则。如果官方有对应 Pattern，必须以官方 base 版本的代码为基础。
4. **登记**：在本文末尾的「自定义组件清单」中追加一行。

---

## 7. 完成前检查清单（每个页面）

- [ ] 页面上的 UI 全部来自 `@/components/ui/*`、registry 区块或「自定义组件清单」中已登记的组件。
- [ ] 新组件都是用 `npx shadcn@latest add` 加入的，`src/components/ui/*` 没有手工改动。
- [ ] 没有硬编码颜色、调色板色和任意值。逐条确认下面命令的命中项（在 `src` 下执行，排除 `ui/`）：
  ```bash
  grep -rnE --include='*.tsx' --include='*.ts' --exclude-dir=ui -e '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(' src
  grep -rnE --include='*.tsx' --exclude-dir=ui -e '\b(bg|text|border|ring|fill|stroke|from|via|to|outline|divide|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)\b' src
  grep -rnE --include='*.tsx' --exclude-dir=ui -e '-\[[^]]+\]' src   # 命中的 data-[...] 等变体选择器属正常，只看任意值
  grep -nE -e '"(@mui|antd|@ant-design|@chakra-ui|@mantine|@radix-ui|react-aria|@headlessui|@nextui-org|@heroui|bootstrap|daisyui|styled-components|@emotion)' package.json
  ```
- [ ] 没有新增 `rounded-*`（`rounded-full` 除外），没有 `style={{}}` 颜色或尺寸，图标只来自 `lucide-react`，没有引入新字体。
- [ ] 浅色和暗色两种主题都看过（按 `d` 切换）。
- [ ] 加载、空、错误三种状态都处理了（Skeleton/Spinner、Empty、Alert/toast）。
- [ ] 危险或不可逆操作用了 `AlertDialog` 加 `variant="destructive"`，并有明确文案，没有只靠红色提示。
- [ ] 表单项都用 `Field` 包裹，有 label 和错误提示；Dialog / Sheet 都有标题；键盘可以操作到所有交互元素。
- [ ] 窄屏下检查过（Sidebar 会自动变为 Sheet）。
- [ ] `npm run lint` 和 `npm run build` 通过。注意：模板自带的 `npm run typecheck`（`tsc --noEmit`）对根 tsconfig 不检查任何文件，实测查不出类型错误，要以 `build` 中的 `tsc -b` 为准。
- [ ] 如果用了例外组件，已经告知用户并登记到下表。

---

## 8. 自定义组件清单

（初始为空。按 §6 流程，每新增一个自定义组件、新 token 或 ui 改动，追加一行。）

| 组件 / 改动 | 路径 | 原因（registry 缺什么） | 基于的 shadcn 组件 / 官方 Pattern | 新依赖 | 用户确认日期 |
|---|---|---|---|---|---|
| 表单：React Hook Form + zod resolver，配合 shadcn `Field` | `apps/web/src` 下各表单 | registry 没有表单状态库（`form` 是空条目），官方 `/docs/forms` 推荐用表单库 | 官方 Forms 指南（React Hook Form）+ `field` | `react-hook-form` 7.90.0、`@hookform/resolvers` 5.9.1 | 2026-10-17 |
| Markdown 显示（技能 SKILL.md、记忆、agent 输出） | `apps/web/src/components/markdown/`（`MarkdownView` + `typeset.css`） | registry 没有 Markdown 渲染组件 | 官方 Typeset（2026-10-17 从 ui.shadcn.com/typeset.css 原样复制，在 `src/index.css` 里 Tailwind 之后引入）。只改两处：`<mark>` 的写死黄色换成主题色；加预设 `.typeset-lyra`（直角、把 `--color-*` 接到本项目 token、等宽字体用 Tailwind 默认栈） | `react-markdown` 10.1.0、`remark-gfm` 4.0.1 | 2026-10-17 |
| 表单的实际用法（M1 P2 落地） | 各配置页的弹窗（`pages/*/…-dialog.tsx`）、`components/shell/change-password-dialog.tsx`、首次设置管理员 `components/setup-form.tsx`（2026-10-17 加，和登录页同一个 `login-01` 布局） | 同上「表单」一行 | React Hook Form `useForm` + `zodResolver`（schema 在 `@heyagent/shared` 的 `config.ts`，前后端共用）+ `Field` / `FieldError errors={[…]}`；非原生控件用 `Controller` | 无（沿用上一行） | 2026-10-17 |
| 可搜索的单选模型下拉 `ModelCombobox` | `apps/web/src/components/shell/model-combobox.tsx` | 模型服务刷新后有几百个模型，`select` 不能搜索 | 只组合 registry 的 `combobox`（`Combobox` + `ComboboxInput` + `ComboboxList`），和已有的 `creatable-combobox.tsx` 同一写法，不算新 UI 能力，登记备查 | 无 | 2026-10-17（先做后报） |
| 远程画面 `RemoteView` / `RemoteViewDialog`（M2-B）：看、操作服务器上的 Chrome | `apps/web/src/components/remote-view/`（`index.tsx` 组件、`use-remote-view.ts` WebSocket 连接、`input.ts` 输入换算、`remote-view-dialog.tsx` 弹窗） | registry 没有远程桌面 / 画面类组件。要画 JPEG 帧、把鼠标键盘换算成页面坐标发回去、接住输入法 | 画面用原生 `<canvas>`；其余全部是 registry 组件：工具栏 `Button` + `InputGroup`（地址栏；连接状态是右端 `InputGroupAddon` 里的图标加文字，2026-10-18 从 `Badge` 改过来，用户嫌 Badge 比地址栏矮）+ `Tooltip`，标签页 `Tabs`（`line` 变体，这次 `npx shadcn@latest add tabs` 新加，没有改动），网页弹框 `AlertDialog` + `Input`，加载 `Spinner`，断开 `Empty`，外层 `Dialog`。两处要说明的写法：① 一个看不见的原生 `<textarea>`（`size-px opacity-0`）接键盘和输入法，点画面时在事件里用 `el.style.left/top` 把它挪到点的位置，让输入法候选框出现在那里（只是定位一个 1px 的隐藏元素，不是样式，JSX 里没有 `style={{}}`）；② 画布上加了 `data-page-width/height`（页面视口尺寸），给自动化测试算点击位置；③ 空白页（about:blank）时画面中间的提示是一个 `div`（`border bg-background`，`pointer-events-none` 不挡鼠标，2026-10-18 加）；④ 弹窗能缩成小窗（2026-10-19 用户要求）：小窗是 registry 的 `Card`（`size="sm"`，`fixed top-4 right-4 z-50`，portal 到 body），标题栏 `CardHeader` 加 `cursor-move` 按住拖动，位置也是在 ref 上改 `left/top`，拖不出窗口；`RemoteView` 只渲染一份，portal 进一个固定的 div，切换时只挪这个 div，连接不断；小窗里加 `compact` 不显示说明文字；弹窗、小窗都由挂在 `App.tsx` 根部的 `RemoteViewHost` 渲染（`store.ts` 按 browserId 登记），打开它的抽屉关了小窗还在 | 无 | 2026-10-17（先做后报） |
| 「登录」类要人办的事里的截图 | `apps/web/src/pages/todos/human-browser.tsx` | 只是一张图，registry 的 `attachment` 是缩略图尺寸，看不清验证码页 | 原生 `<img>` 套在链接里（点开看原图），只用 `border` 和 `w-full` | 无 | 2026-10-17（先做后报） |
| 全局滚动条样式 | `apps/web/src/index.css`（`@layer base` 里的 `scrollbar-width` / `scrollbar-color`，Safari 用 `::-webkit-scrollbar`） | 预设没有统一滚动条，各浏览器、各区域样子不一 | 只用主题 token（`--muted-foreground` 加透明度、`--spacing`），不新增 token；`no-scrollbar` 照样隐藏 | 无 | 2026-10-18（用户要求） |
| 区块说明改成「?」提示 | `apps/web/src/components/shell/simple-page.tsx`（`HelpTip`、`DetailSection` 的 `description`） | 用户要求区块标题下不放子标题，说明放进标题旁「?」的悬停提示 | 只组合 registry 的 `tooltip` + `button`（`ghost` / `icon-xs`）+ lucide `CircleHelpIcon` | 无 | 2026-10-18（用户要求） |
| 文件缩略图和查看弹窗 | `apps/web/src/components/files/index.tsx`（`FileList`、`FileViewer`） | 图片要缩略图、点了看大图；文本点了看内容 | 只组合 registry 的 `attachment`（`image` 变体、`vertical`、`AttachmentTrigger`）+ `dialog` + `code-block`，Markdown 用已登记的 `MarkdownView`。看大图时左右切换同一组图片（2026-10-18 用户要求）：图片两边各一个 `Button`（`secondary` / `icon`，lucide `ChevronLeft/RightIcon`，`absolute` 定位），键盘 ← → 也能切，底部显示「第 n / m 张」 | 无 | 2026-10-18（用户要求） |
| agent 的虚拟光标 `AgentCursor` | `apps/web/src/components/remote-view/agent-cursor.tsx`（挂在 `RemoteView` 的画面上） | registry 没有光标类组件。看 agent 操作浏览器时画面上没有鼠标，要显示 agent 的鼠标在哪、点了哪、在做什么 | 箭头是 lucide `MousePointer2Icon`（`fill-primary stroke-primary-foreground`），动作说明是 registry 的 `Badge`，点击的波纹是 `rounded-full bg-primary/50 animate-ping`（圆形元素）。位置和远程画面的输入框一样，在 ref 上改 `left/top`（百分比），JSX 里没有 `style={{}}`；移动用 `transition-all duration-200` | 无 | 2026-10-18（用户确认方案） |
| 多选标签 `TagsCombobox` | `apps/web/src/components/shell/tags-combobox.tsx` | registry 的 combobox 只有组件，没有「多选 + 可新建」的现成组合 | 照官方 base 版 Combobox Multiple 例子组合 `Combobox` + `ComboboxChips` + `ComboboxChip` + `ComboboxChipsInput`，多一项「新建「xxx」」（同 `creatable-combobox.tsx` 的写法） | 无 | 2026-10-17（先做后报） |
| 图库页：图片墙、拖拽 / 粘贴、上传区 | `apps/web/src/pages/gallery/`（`index.tsx` 图片墙和工具栏、`image-sheet.tsx` 抽屉、`upload-dialog.tsx`、`edit-dialog.tsx`） | registry 没有图片墙和拖拽上传区 | 图片墙：原生 `<button>` 里放 `AspectRatio` + `<img>`（`object-cover`），相似度用 `Badge`；上传区：原生 `<button>`（`border border-dashed`）+ 隐藏的 `<input type=file>`，上传进度用 `Attachment` 的 `state`；拖进页面时的遮罩用 `bg-background/80`；其余是 `Sheet` `Dialog` `AlertDialog` `Field` `Textarea` `InputGroup` `CodeBlock` `Empty` `Skeleton`。只用主题 token，没有新依赖 | 无 | 2026-10-17（先做后报） |
| 导入页：上传区、上传进度、向导吸底按钮栏 | `apps/web/src/pages/imports/`（`upload-dialog.tsx` 上传区，`wizard.tsx` 底栏，`lib/imports.ts` 上传） | registry 没有拖拽上传区和吸底操作栏；100 MB 的包要看到上传进度 | 上传区和图库一样：原生 `<button>`（`border border-dashed`）+ 隐藏的 `<input type=file>`，选好后换成 `Attachment`（`state` 显示上传中 / 出错，描述里写百分比；进度用 `XMLHttpRequest` 的 `upload.onprogress`）。七步向导的底栏是一个 `div`（`sticky bottom-0 border-t bg-background`）里放 `Button`，步骤条是 `Tabs`（`line` 变体）。其余全是 registry 组件：`Card` `Item` `Checkbox` `Select` `Badge` `Alert` `Trace` `CodeBlock` `Collapsible` `DropdownMenu` `Dialog` `AlertDialog` `Field` `InputGroup`；改任务的弹窗复用 `pages/tasks/task-dialog.tsx` 的 `StepEditor` `BrowserFields` `MultiPick`。只用主题 token，没有新依赖 | 无 | 2026-10-18（用户确认的设计稿） |
| 比物页：两张图的放图位置、图片缩略图、从图库选、看大图 | `apps/web/src/pages/compare/`（`new-dialog.tsx` 放图位置和从图库选，`index.tsx` 详情里的两张图和看大图） | registry 没有拖拽 / 粘贴放图的位置和图片墙 | 放图位置和图库上传区同一写法：空着时是一个 `div`（`border border-dashed`，里面有「上传」「从图库选」「填网址」三个 `Button`，所以不能用 `<button>` 套）接拖放，加隐藏的 `<input type=file>`；`Ctrl+V` 在弹窗打开时挂 `window` 的 `paste`；选好后是 `AspectRatio` + `<img>`（`object-cover`），上传中盖一层 `bg-background/60` + `Spinner`，右上角 `Button`（`secondary` / `icon-xs`）换一张；填网址用 `InputGroup`。从图库选：小 `Dialog` 里 `InputGroup` 搜索 + 原生 `<button>` 里放 `AspectRatio` + `<img>` 的图片墙（和图库页的格子一样）。详情的两张图同样是原生 `<button>` + `AspectRatio` + `<img>`，看大图是 `Dialog` + 左右 `Button`（和 `components/files` 的看大图同一写法，← → 切换两张）。各项分的一行用 `flex` + `w-24` / `w-10`，没照原型用 `grid-cols-[6rem_1fr_2.5rem]`（任意值）。其余是 `Select` `Field` `Textarea` `Input` `Progress` `Trace` `Item` `Badge` `Alert` `AlertDialog` `Collapsible` `DropdownMenu` `Empty` `Skeleton`。只用主题 token，没有新依赖 | 无 | 2026-10-18（用户确认的设计稿） |
| 会话页的「任务」筛选 `TaskFilter` | `apps/web/src/pages/sessions/task-filter.tsx` | 任务可能很多，`select` 不能搜索 | 只组合 registry 的 `combobox`（`Combobox` + `ComboboxInput` + `ComboboxList`），和 `model-combobox.tsx` 同一写法；第一项「全部任务」= 不筛，选了某个任务时输入框右边有 × 清空；任务名长，`ComboboxContent` 加 `w-96`（布局宽度，窄屏由组件自带的 `max-w` 限住）。不算新 UI 能力，登记备查 | 无 | 2026-10-19（先做后报） |
| 表格文件预览 `SheetView` / `SheetTable`（xlsx、xls、csv 等）和「不能预览」 | `apps/web/src/components/files/index.tsx` | registry 没有表格文件（Excel）预览；以前非文本文件点不开，csv 按文本显示 | 只组合 registry 的 `table`（列名 A、B、C 做表头，第一列是行号，格子 `max-w-xs truncate` + `title` 看全文）+ `tabs`（`line` 变体，一个工作表一个标签）+ `empty`（空表、其他不能预览的文件「不能预览，请下载」）+ `alert`（读不了）+ `spinner`；数据来自服务器解析的 `GET /api/files/:id/sheet`（每个工作表前 200 行），前端不引入 Excel 库。只用主题 token，没有新依赖 | 无 | 2026-10-19（先做后报） |
| 右下角助手的浮动面板 `AssistantWidget` | `apps/web/src/components/assistant/`（`index.tsx` 按钮、面板、输入框，`transcript.tsx` 记录，`proposal-card.tsx` 改动确认卡，`history.tsx` 以前的对话，`use-assistant.ts` 状态，`stream.ts` 读 SSE） | registry 没有「浮动面板」：要固定在右下角、不挡整页、能边看页面边说 | 宽屏：`Card`（`size="sm"`）加 `fixed right-4 bottom-4 z-50 h-160 max-h-11/12 w-96`；圆按钮是 `Button`（`icon-lg`）加同样的 `fixed` 定位和 `rounded-full`（圆形元素）。两者都加了 `shadow-lg`（和 `Sheet` 自带的阴影一样，浮在页面上要有层次）。窄屏改用 `Sheet side="bottom"`，加 `data-[side=bottom]:h-dvh` 撑满全屏。只是定位，不改组件外观。里面全是 registry 组件：`message-scroller`（这次 `npx shadcn@latest add message-scroller` 新加，没有改动；随它装了 `@shadcn/react` 0.3.1，锁成精确版本）`Message` `Bubble` `Trace` `CodeBlock` `Item` `Card` `Badge` `Marker` `Alert` `Empty` `InputGroup` `Popover` `AlertDialog` `Tooltip` `Skeleton` `Spinner`，模型用已登记的 `ModelCombobox`，回答用已登记的 `MarkdownView`。「以前的对话」用 `Popover` 而不是说明里写的 `DropdownMenu`：每一行要有「打开」和「删除」两个按钮，菜单项里不能再套按钮 | `@shadcn/react` 0.3.1（`message-scroller` 的依赖） | 2026-10-19（先做后报） |
| 助手发图、发文件、记录里的图和文件 | `apps/web/src/components/assistant/`（`composer-images.tsx` 输入框上要发的图、文件和上传，`index.tsx` 加附件按钮、粘贴、拖放，`transcript.tsx` 记录里的缩略图和文件卡） | registry 没有「输入框带图片附件」的现成组合，也没有拖放区 | 加附件（2026-10-20 从「加图片」改过来，收图片和文本、PDF、Word 文件）：输入框左下 `InputGroupButton`（`ghost` / `icon-sm`，lucide `PaperclipIcon`）+ `Tooltip`，要发的文件和图排在同一个 `AttachmentGroup` 里，文件是 `Attachment`（`sm`，`icon` 媒体，lucide `FileTextIcon`）；记录里人发的文件是 `Attachment`（`sm`，图标用 `components/files` 的 `fileTypeIcon`，PDF、Word 也是 `FileTextIcon`），文本点了用 `FileViewer` 看内容，PDF、Word 的 `AttachmentTrigger` 用 `render` 换成 `<a download>` 直接下载。其余和原来发图一样：点了打开隐藏的原生 `<input type=file>`（`className="hidden"`，和导入页、比物页一样）；在输入框里粘贴（只有图没有文字时才当图片，带文字的照常粘贴文字）；拖到面板上任何地方（`Card` / `SheetContent` 上挂 `onDragOver` / `onDrop`，只是事件，不改外观；拖着时输入框上方用 `InputGroupText` 说「松开就加上」）。要发的图放在 `InputGroupAddon align="block-start"` 里，用 `AttachmentGroup` + `Attachment`（`sm`，`image` 媒体，`state` 显示上传中 / 出错，`AttachmentAction` 移除），格式不对、超过张数的提示是一行 `text-destructive` 的字。记录里人发的图、助手看过的图是 `Attachment`（`vertical`，只有 `image` 媒体 + `AttachmentTrigger`；工具行下面的小图加 `w-16`），点了用已登记的 `FileViewer` 看大图、← → 切换。只用主题 token，没有新依赖 | 无 | 2026-10-20（先做后报） |
| 确认卡的差异对比 `FieldDiff`（改前、改后像 Git diff 一样逐句、逐词对比） | `apps/web/src/components/assistant/field-diff.tsx`（在 `proposal-card.tsx` 里用），算法 `apps/web/src/lib/text-diff.ts`；新 token 在 `apps/web/src/index.css` | registry 的 `code-block` 只有整行 diff（自己的配色），没有句子 / 词语级的高亮，也没有绿色；预设没有「新增 / 删除」的语义色 | 每行是 `div`（`flex`，左边 `w-4` 一栏写 `+` / `-`，`whitespace-pre-wrap`），删的 `bg-diff-removed/40`、加的 `bg-diff-added/40`，改了的句子里删的词是 `<del>`（`bg-diff-removed`，带删除线）、加的词是 `<ins>`（`bg-diff-added`），没改的 `text-muted-foreground`，读屏有 `sr-only` 的「删除：」「新增：」。没改的长段收起来：`Button`（`ghost` / `xs`，lucide `ChevronsUpDownIcon`）「还有 N 句没改，展开」，另有「看全文 / 只看改动」。任务步骤逐条对比、保留编号，「第 3 步 改了」「新增第 4 步」「删掉原第 5 步」用 `Badge`（`secondary`）。宽屏有「左右对照」：`Dialog`（`sm:max-w-5xl`、`max-h-11/12`，内容区 `overflow-y-auto`）里两列 `grid grid-cols-2`「修改前 / 修改后」，没有对应行的一边是 `bg-muted` 空格。新 token：`--diff-added` / `--diff-removed`（`:root` 和 `.dark` 各一对，`@theme inline` 映射成 `--color-diff-added` / `--color-diff-removed`），只给差异对比用 | `diff`（jsdiff）8.0.4（自带类型） | 2026-10-20（用户要求） |
| 运行结果徽章 `OutcomeBadge`、运行详情的「结果」区块和「改结果」弹窗 | `apps/web/src/components/shell/outcome-badge.tsx`（会话列表、运行详情、派活页、看板共用）、`apps/web/src/pages/tasks/run-outcome.tsx` | registry 没有现成的「结果」徽章；改结果要单选四种结果 | 只组合 registry 的 `badge`（按第 4 节映射：办成 `outline` + `CircleCheckIcon`、部分办成 `secondary` + `CircleDotIcon`、没办成 `destructive` + `CircleXIcon`、没核实 `outline` + `CircleHelpIcon`）+ `tooltip`（悬停看原因，徽章 `tabIndex=0` 键盘也能看）；复核报告是 `collapsible` + `button`（`ghost`）+ 原生 `<dl>`；改结果是 `dialog` + `field` + `radio-group`（这次 `npx shadcn@latest add radio-group` 新加，没有改动）+ `textarea`，React Hook Form + `zodResolver(setOutcomeInputSchema)`。会话表格里整行是链接，结果徽章加 `relative z-10` 浮在链接上面才能悬停 | 无 | 2026-10-20（先做后报） |
| 提示（Toast）盖在侧滑面板、弹窗上面 | `apps/web/src/components/ui/toast.tsx`（`ToastViewport` 的 `z-50` 改成 `z-100`，只改这一处） | 提示和 `Sheet` / `Dialog` / `AlertDialog` 都是 `z-50`，面板的 portal 在页面里更靠后，在面板里操作后弹的提示被面板挡住、看不见。2026-10-20 用 `npx shadcn@latest add toast --diff` 查过，官方新版没有改 | 官方 `toast`（Base UI Toast） | 无 | 2026-10-20（用户要求修） |

2026-10-17 用户另外同意：开发中遇到 registry 确实没有的组件，可以先按第 6 节用现有组件组合实现、登记在上表，事后告诉用户（「先做后报」）。
