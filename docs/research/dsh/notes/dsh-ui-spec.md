# dsh Web UI spec (for the HeyAgent clickable prototype)

Source studied: `dsh/repo` (read-only). Paths below are relative to `packages/client/` unless they start with `docs/`.
Tags: **[source]** read in code/CSS/locale; **[docs]** stated in a README/doc; **[inferred]** my reading of screenshots or a reasonable guess.
The values are what a prototype needs to look like dsh. When a value comes from a token, the token name is given so the prototype can define the same CSS variables.

Screenshots used: `ui-settings-account/src/client/assets/onboarding-welcome-zh{,-dark}.webp` (shell + hero, macOS desktop chrome), `docs/user/guide/providers-models-page.zh.png` and `providers-custom-form.zh.png` (settings dialog). The prototype should copy the **plain Web** layout: no traffic lights and no macOS vibrancy.

---

## 0. TL;DR for the prototype builder

- Three columns in a CSS grid: **left sidebar** (default 280px, 264–420px resizable, 56px icon rail when collapsed), **center** (min 400px), **right sidebar** (a "track": first open at 45% of the viewport, 300px to 70%, hidden by default). Below 768px the left sidebar becomes a modal drawer. [source `ui-layout/src/client/columns.ts`]
- The visual language is quiet, neutral and slightly bluish-grey, with **black ink for primary buttons** and **DeepSeek blue `rgb(65,118,230)` only for accents**: the send button, links, selected tab underline, focus ring and active folder. [source `ui-theme/src/styles/design-platform.css`]
- Hairlines are **0.5px**. Floating surfaces use **no border**, only `box-shadow` elevation with a 0.5px stroke inside the shadow. Corners use a radius scale of 4/8/12/16/20/28 with a `superellipse(1.5)` corner shape. [docs `docs/ui-radius.md`, `docs/web-styling.md`]
- Font: the system stack (PingFang SC / Microsoft YaHei ...). Body text is **14px/22**; chat text is **14px/24**. Montserrat is used only for brand text. [source `ui-theme/src/styles/base.css`]
- Icons are dsh's own 16×16 outline set: 1px "regular" and 1.3px "medium" strokes, painted with `currentColor`. It is **not lucide**. The SVG paths are in `ui-primitives/src/icons/artwork.ts` and can be copied directly. If lucide is used as a stand-in, set `stroke-width≈1.3` at 16px. [source]
- Dark mode is set with `body[data-ds-dark-theme]`. All colors come from `--dsw-alias-*` tokens, so redefining the tokens switches the theme. [source]
- Each plugin can contribute: a sidebar panel row plus a main page, a right-sidebar tab type, a settings section, a Plugins-page card, chat node renderers, a tool-call view, composer slots, `/` commands, `@`-style trigger sources, and session-row decorations (§6). **ui-schedule** (automation tasks) uses almost all of these at once and is the reference example.

---

## 1. Shell layout

### 1.1 Frame (ui-layout `AppFrame`)
- `.frame`: `display:grid; grid-template-rows: minmax(0,1fr) auto; height:100%; background: var(--dsw-alias-bg-base)`. The columns are `${sidebar}px minmax(${rightbar?400:0}px,1fr) minmax(0, ${rightbarMax}px)`. Row 2 is the optional full-width `shell.bottom` slot, empty by default. [source `AppFrame.module.css`, `AppFrame.tsx`]
- Column constants [source `columns.ts`]: `CENTER_MIN=400`, `SIDEBAR_MIN=264`, `SIDEBAR_MAX=420`, `SIDEBAR_DEFAULT=280`, `SIDEBAR_COLLAPSED=56` (24px icon column plus 16px padding each side), `SIDEBAR_DRAWER_BREAKPOINT=768`, `SIDEBAR_AUTO_COLLAPSE=1024`, `RIGHTBAR_MIN=300`, `RIGHTBAR_MAX_RATIO=0.7`, `RIGHTBAR_DEFAULT_RATIO=0.45`.
- When space runs short, the right panel shrinks to 300px first. It then closes. Only after that does the center go below 400px. Opening the right panel collapses a manually expanded left sidebar when the viewport is below 1024px. [docs ui-layout README]
- `.sidebarCol { background: var(--dsw-specific-sidebar-fill); border-right: 0.5px solid var(--dsw-alias-border-l3) }`. The center column has the base background. [source]
- Resize handles are invisible 8px hit strips centred on column borders (`cursor: col-resize`, z 11). There is no visible pill. [source]
- Collapse and expand animate `grid-template-columns` over `0.3s cubic-bezier(.4,0,.2,1)` (`--ds-transition-duration-slow`, `--ds-ease-in-out`). Dragging has no transition. [source]
- Drawer mode (<768px): the sidebar is absolutely positioned, `z-index:71`, and slides in with `translateX(-100%→0)` over 0.3s. The mask is `var(--dsw-alias-bg-mask-1)` (rgba 0,0,0,.24 light / .5 dark), `z 70`, and fades. Clicking the mask closes the drawer. [source]
- Overlays: `shell.overlay` covers the frame at `z-index 20` and is used by toasts and notices. Modals sit at z 1000 and menus/tooltips in portals at z 1100. [source]
- Shortcut: `Mod+B` toggles the left sidebar. [docs]

### 1.2 Left sidebar (ui-sidebar + ui-workspace + ui-settings-general/account)
Top to bottom, expanded state [source `ui-sidebar/src/client/SidebarRoot.module.css`]:
1. **Root**: `padding: 6px 8px; font-size:14px; color: label-primary`. Local variables: `--dsh-sidebar-inline-padding:8px`, `--dsh-sidebar-row-padding:12px`, `--dsh-sidebar-label-gap:6px`, `--dsh-sidebar-paint-inset:3px`. Hover fills are inset 3px from the column edges using transparent `border-inline` with `background-clip: padding-box`.
2. **Logo row**: height 60px, `padding: 8px 0 8px 8px`, `justify-content: flex-end`, gap 8. It holds the **brand** (flex 1; mark plus name, gap 5px, 24px high; name `18px/24px 600, letter-spacing .04em`) and, on the right, the **collapse toggle** (28×28 icon button, R8, `label-secondary`, hover `interactive-bg-hover`, `panel-left-outline` icon). Clicking the brand starts a new session; it has no hover chrome. The official brand is the whale mark plus the "deepseek" wordmark plus a black "HARNESS" tag (screenshot). HeyAgent replaces it through the `sidebar.brand.mark` and `sidebar.brand.name` slots. [source/docs]
3. **New session button "新会话"**: 38px high, `padding 8px 12px`, `margin 0 4px`, `border: 0.5px solid var(--dsw-alias-border-l3)`, R12 (`--dsw-radius-md`), `background: var(--dsw-alias-button-elevated-fill)` (white in light, bluish-750 `rgb(67,69,74)` in dark), `14px/22 500`, centred `new-chat-outline` icon plus label with gap 6. Hover uses `button-floating-hover` (`rgb(241,243,245)` light). On hover or focus the shortcut fades in as grey text at the right. [source]
4. **Scroll region** (`margin-top:4px`, flex 1). It contains:
   - **Panel list** (global pages registered by plugins): rows 32px min, `padding: 5px 9px`, R12, gap 2px between rows, icon plus label with gap 6, `line-height:22px`. The selected row (`.panelEntryActive`) gets `background: var(--dsw-alias-interactive-bg-hover)` (rgba(38,49,72,.06)), the same fill as hover. The list has `margin-bottom:8px`. Shipped rows are **插件** (order 0, id `plugins`) and **自动化任务** (order 10, id `schedules`), plus an optional **更多** row that opens a 288px menu. [source/docs]
   - **Workspace browser** (ui-workspace). The section header is a toolbar 36px high with `padding-left:12px` and text `label-tertiary` "**工作区**". On the right are 28×28 icon buttons: search (`search-outline`), view options (`sliders-two-outline`) and add workspace (`project-add-outline`), with gap 4. Search expands the field over 180ms. [source `WorkspaceBrowser.module.css`, screenshot]
   - **Workspace row**: 32px, R12, folder icon in a 16×20 slot (`folder-open`/`folder-close`; the folder turns `state-business-primary` blue when it contains the current session), name `14px/20`. On hover the folder becomes a chevron (rotates 90° when open, 150ms) and row actions appear (… menu and + new session, gap 13). [source `rows/Rows.module.css`]
   - **Session row**: 32px, R12, `padding-inline-start: 9px (+indent)`. Leading 16×20 status slot: idle = empty, running = spinner, waiting = amber dot, done-unviewed = green dot. Title `14px/20` with ellipsis; on hover it marquee-scrolls with 12px edge fades. Trailing relative time `10px/16 label-tertiary` ("刚刚", "9分钟", "4天"). Selected or hover fill is `interactive-bg-hover`. On hover the time is replaced by the actions (pin and … More). A pinned row shows a pin glyph in `label-caption`. Archived rows render in `label-caption`. A pending interaction replaces the time with a compact label: **待审批 / 计划待审 / 待回答** with an amber dot. [source/docs]
   - Each workspace shows its first 5 sessions; "展开其余 {n} 个会话" adds 5 at a time and "收起" resets. [docs/locale]
   - A 24px bottom fade gradient sits above the footer (`transparent → sidebar-fill`). [source]
   - Scrollbars in the sidebar are hidden unless the pointer is inside, and linger 2s after it leaves. [docs]
5. **Footer**: the account launcher row (signed in: 44px, 24px circular avatar, gap 8, account name) plus the settings trigger. The settings trigger is 42px high, R12, `14px/22`, with hover fill. The screenshot shows a person icon plus "DeepSeek". The account menu contains **设置 / 意见反馈**. [source `ui-settings-general/.../SettingsRoot.module.css`, docs ui-settings-account]

**Collapsed rail (56px)** [source]: root `padding: 18px 10px 6px`. Everything becomes a 36×36 R12 icon button stacked with 12px gaps: the brand mark (hovering it reveals the expand icon), new session (no border or fill), the panel icons (tooltip shows the label), and the settings/avatar button (36×36). The content fades out over 150ms and the rail controls slide in (`translateX(49px)→0`, 150ms).

### 1.3 Center: main panel switching
- The center renders the root-scoped keyed slot `main`. The key `conversation` is reserved for the chat. Plugins register other keys, and `ctx.layout.selectPanel(id)` switches to them; `selectPanel(null)` returns to the conversation without changing the current session. Selecting an unregistered id throws. The selected sidebar row is highlighted through `usePanelInfo().activePanelId`. [source `ui-layout/src/client/service.ts`, `AppFrame.tsx`]
- Entry pages (plugins, automation) use their own page chrome (§5.3). The conversation owns its own header.

### 1.4 Conversation header (ui-conversation `ConversationRoot.module.css`)
- `.header`: grid `auto | 1fr`, `min-height:76px` when view tabs exist (otherwise one 40px row), `padding: 10px 28px 0 20px`, `border-bottom: 0.5px solid border-l3`. [source]
- Title row is 30px. It contains the **breadcrumb** (crumbs `14px/20`, `padding 4px 8px`, R12, `label-tertiary`; the current crumb is `500 label-primary`; the separator "/" is `label-caption`; max 220px each), then header actions, then `headerUtilities` (gap 8, margin-left 20; holds the subagent control, background-jobs control, schedule clock and "…" More). A `headerCorner` at the far right holds the **right-sidebar opener** (a mirrored panel icon, compact button) while the right panel is closed. While the left sidebar is collapsed, `headerLeading` holds its reopen button. [source/docs]
- **View tabs row** (shown only with two or more views): `margin-top:10px; padding-left:8px; gap 32px`. A tab is `13px/16 500 label-tertiary`. The active tab is `state-business-primary` blue with a 2px blue underline that sits over the header rule. Shipped views are **对话** (chat, order 0) and **轨迹** (trajectory, order 10, hidden unless the "Coding Tools" setting is on). A "More conversation views" 22px button follows. [source]
- A blank session (hero) keeps only a 40px header row: the corner and leading controls, with no title, tabs or border. [source/docs]

### 1.5 Home / empty state ("hero")
[source `skeleton/HeroShell.module.css`, `InputBar.module.css`, locale; screenshot]
- Vertically and horizontally centred stack; the stack width is the composer card width (see 4.1), `gap 12px`, page padding `0 24px`.
- **Headline**: whale mark (it "swims" on hover: a 1.6s rotate/translate animation) plus "**探索未至之境**" plus a "**预览版**" badge. Headline text is `26px/32px 500 label-primary`, column-gap 10. The badge is a mono pill (`font-family: code`, `12px/18 500`, `padding 1px 7px 0`, radius 999, `background: state-business-tertiary` (deepseek-100 `rgb(228,237,253)` light / deepseek-800 dark), `color: label-primary-bluish`) aligned to the top of the title. HeyAgent should change this text.
- **Workspace picker row** (above the card, `padding-left:8px`): a button with folder icon, "默认工作区" and a caption-coloured chevron. It is `13px/20 500`, min-height 28, `padding 0 8px`, R8, hover fill, max-width 360px. An agent-preset selector can sit at the right (`conversation.hero.agentPreset`).
- **Composer card** in hero mode: input min-height 52px and a two-line placeholder "**描述你想要构建的内容, / 调用指令, @ 文件或对话**". The dock under the card is hidden while empty.
- With no workspace chosen, the card becomes a pick target with a 1px dashed `border-l4` outline that turns blue on hover. Placeholder: "选择一个工作区开始". [source]

### 1.6 Right sidebar (ui-sidebar-right + ui-dockkit)
[docs ui-sidebar-right README, source `dockkit.module.css`, locale]
- One docking surface per session. It is hidden by default and opened from the header corner button. The panel has **no header row**: its top edge is the pane's **tab strip** (28px tabs, `padding: 10px 6px 0 10px`, gap 4). The left border is `0.5px border-l4` and the background is `bg-base`, the same ground as the conversation, not a raised card.
- **Tab chip**: 28px high, 80–170px wide, `padding 0 10px`, R8, `13px` (`label-secondary`). The active chip has `color label-primary; background var(--dsw-alias-markdown-tag)` (bluish-75 `rgb(241,243,245)` light / bluish-850 dark). A 20×20 close "×" appears at the top-right on hover or when active, and the title fades with a mask. After the chips come a "+" add-tab button (28×28, R8), a split button, and in the top-right pane fullscreen/exit and collapse buttons.
- Panes: at most 2, side by side, divider ratio 20–80%. Tabs can float out as floating panels.
- **Guide tab "开始"**: a centred compass plus one R20 card per registered tab type (icon, title, description). Shipped types: **工作区文件** ("浏览会话工作区的文件"), **终端** ("在会话工作区运行命令"), **浏览器** ("浏览网页"), plus document preview, the plan file, the automation task detail, and others. "**更多工具**" is a card that opens a menu.
- Presentations: `push` (normal) or fullscreen. Below 768px it opens fullscreen automatically.
- Revealing a tab that is already visible flashes a glow around the pane (~600ms, accent colour).

### 1.7 Responsive summary
- ≥1024px: everything as above.
- 768–1023px: the sidebar auto-collapses to the 56px rail.
- <768px: the sidebar becomes a drawer; the right panel goes fullscreen; settings fill the viewport; page side padding becomes 20px; the composer uses 16px text on coarse pointers. [source/docs]

---

## 2. Design tokens (actual values)
All are declared on `body`, and dark-mode values on `body[data-ds-dark-theme]`. [source `ui-theme/src/styles/design-platform.css`, `gradient-shadow-text.css`, `base.css`]

### 2.1 Static palette used by the aliases (the same in both themes)
`neutral-bluish-`: 00 #FFFFFF · 50 rgb(249,250,251) · 55 rgb(245,247,250) · 60 rgb(245,246,247) · 75 rgb(241,243,245) · 90 rgb(237,240,244) · 100 rgb(235,238,242) · 150 rgb(233,236,242) · 200 rgb(225,229,238) · 300 rgb(207,211,214) · 310 rgb(202,210,219) · 400 rgb(173,178,184) · 500 rgb(151,157,166) · 600 rgb(129,133,140) · 700 rgb(97,102,107) · 750 rgb(67,69,74) · 800 rgb(53,54,56) · 850 rgb(44,44,46) · 875 rgb(35,35,36) · 900 rgb(27,27,28) · 950 rgb(21,21,23) · 1000 rgb(15,17,21).
`deepseek-`: 50 rgb(237,243,254) · 100 rgb(228,237,253) · 200 rgb(211,226,255) · 300 rgb(183,200,254) · 400 rgb(122,170,255) · 450 rgb(86,134,254) · **500 rgb(65,118,230)** (brand blue) · 600 rgb(72,104,178) · 800 rgb(52,65,91) · 900 rgb(40,49,66).
Others: green-500 rgb(34,197,94), green-400 rgb(78,209,126), green-100 rgb(230,250,237), green-900 rgb(35,60,44); red-600 rgb(236,19,19), red-400 rgb(242,90,90), red-100 rgb(254,226,226); amber-500 rgb(245,158,11), amber-400 rgb(247,173,49), amber-600 rgb(221,134,41), amber-100 rgb(254,245,231), amber-900 rgb(39,36,31); violet-600 rgb(124,58,237), violet-400 rgb(167,139,250); neutral-200 rgb(229,229,229), 300 rgb(212,212,212), 550 rgb(101,103,107), 600 rgb(84,85,87), 700 rgb(60,60,61), 800 rgb(41,41,41).

### 2.2 Semantic aliases (light → dark)
| Token | Light | Dark |
|---|---|---|
| `--dsw-alias-bg-base` (page, conversation, right panel) | #FFFFFF | bluish-950 rgb(21,21,23) |
| `--dsw-specific-sidebar-fill` | bluish-50 rgb(249,250,251) | bluish-900 rgb(27,27,28) |
| `--dsw-alias-bg-layer-1` / `-2` / `-3` | white / white / white | 875 rgb(35,35,36) / 850 rgb(44,44,46) / 800 rgb(53,54,56) |
| `--dsw-alias-bg-module-platform` (segmented track, neutral tag) | bluish-60 | bluish-800 |
| `--dsw-specific-input-major` (composer card, question/approval card) | white | bluish-850 |
| `--dsw-specific-bubble` (user message bubble) | deepseek-50 rgb(237,243,254) | bluish-850 |
| `--dsw-specific-selector` (composer "+" circle) | bluish-60 | bluish-800 |
| `--dsw-specific-sidebar-nav-item-active` (settings nav selected) | bluish-100 rgb(235,238,242) | bluish-750 |
| `--dsw-alias-label-primary` | bluish-1000 rgb(15,17,21) | bluish-50 |
| `--dsw-alias-label-secondary` | bluish-700 rgb(97,102,107) | bluish-300 |
| `--dsw-alias-label-tertiary` | bluish-600 rgb(129,133,140) | bluish-400 |
| `--dsw-alias-label-caption` (placeholders, chevrons) | bluish-400 rgb(173,178,184) | bluish-600 |
| `--dsw-alias-label-dimmed` | bluish-200 | bluish-750 |
| `--dsw-alias-label-primary-foreground` (text on primary buttons) | white | bluish-1000 |
| `--dsw-alias-border-l1/l2/l3/l4` | rgba(0,0,0,.04/.10/.12/.16) | rgba(255,255,255,.06/.12/.16/.20) |
| `--dsw-alias-interactive-bg-hover` | rgba(38,49,72,.06) | rgba(255,255,255,.08) |
| `--dsw-alias-interactive-bg-active` | rgba(38,49,72,.10) | rgba(255,255,255,.14) |
| `--dsw-alias-interactive-bg-hover-solid` | bluish-75 | bluish-800 |
| `--dsw-alias-interactive-bg-hover-danger` | rgba(236,19,19,.05) | rgba(242,90,90,.15) |
| `--dsw-alias-button-primary-fill` (= brand-primary, **black/white ink**) | bluish-1000 | bluish-50 |
| `--dsw-alias-button-primary-hover` | bluish-750 | bluish-100 |
| `--dsw-alias-button-info-fill` (send button) / hover | deepseek-500 / deepseek-400 | deepseek-400 / deepseek-500 |
| `--dsw-alias-button-elevated-fill` (new session) | white | bluish-750 |
| `--dsw-alias-button-floating-fill` / `-hover` | white / bluish-75 | bluish-850 / bluish-800 |
| `--dsw-alias-state-business-primary` (accent blue, focus ring) | deepseek-500 | deepseek-400 |
| `--dsw-alias-state-business-tertiary` | deepseek-100 | deepseek-800 |
| `--dsw-alias-link` | deepseek-500 | deepseek-400 |
| `--dsw-alias-state-success-primary` | green-500 | green-500 |
| `--dsw-alias-state-error-primary` | red-600 rgb(236,19,19) | red-400 |
| `--dsw-alias-state-warn-primary` / `-label` / `-tertiary` | amber-500 / amber-600 / amber-100 | amber-500 / amber-600 / amber-900 |
| `--dsw-alias-state-idle-primary` | neutral-300 | neutral-600 |
| `--dsw-alias-label-deep-diving` (running "深度求索中" text) | mix(deepseek-500 70%, blue-950) | mix(deepseek-450 55%, bluish-400) |
| `--dsw-alias-markdown-code-block` | bluish-50 | bluish-900 |
| `--dsw-alias-markdown-inline-code` | neutral-50 | neutral-800 |
| `--dsw-alias-markdown-tag` (active dock tab) | bluish-75 | bluish-850 |
| `--dsw-alias-tooltip-bg` (text always white) | bluish-850 rgb(44,44,46) | bluish-750 |
| `--dsw-alias-toast-bg` / `-label` | bluish-800 / white | bluish-750 / white |
| `--dsw-menu-surface-fill` (+ `--dsw-menu-backdrop-filter: blur(40px) saturate(150%)`) | rgba(252,253,254,.7) | rgba(48,49,54,.64) |
| `--dsw-alias-bg-mask-1` (modal mask, no blur) | rgba(0,0,0,.24) | rgba(0,0,0,.5) |
| `--dsw-alias-scrollbar-bg-l1` / `-hover-l1` | neutral-200 / neutral-300 | neutral-700 / neutral-600 |
| `--dsw-alias-switch-thumb` (off state) | white | bluish-400 |
| `--dsw-alias-settings-card-fill` / `-stroke` | = bg-layer-2 / border-l4 | same aliases |
| `--dsw-alias-file-diff-added-bg` / `-deleted-bg` | rgb(230,244,231) / rgb(252,230,226) | rgb(31,49,36) / rgb(60,31,27) |
| `--dsw-alias-code-diff-added` / `-deleted` | green-500 8% / red-600 8% | green 12% / red-400 12% |

Note: the settings screenshot shows provider cards as **light grey with no visible stroke** (~#F4F5F7). Current tokens resolve the card fill to white with a 0.5px rgba(0,0,0,.16) stroke inside a white dialog. The screenshot appears to be older. **Follow the tokens** [inferred].

### 2.3 Typography [source `base.css`, `gradient-shadow-text.css`]
- `--dsw-font-family`: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif`.
- Code: `'SF Mono','JetBrains Mono','Fira Code',Consolas,'Liberation Mono',Menlo,Courier,'PingFang SC','Microsoft YaHei'`. Brand: `'Montserrat'` (bundled at weights 300/400/500).
- The scale is written as `--dsw-font-<name>`, weight size/line-height: `xl-24` 600 24/32 · `l-20` 500 20/28 (page H1) · `m-18` 500 16/28 · `base-16` 16/24 · `base-strong-16` 500 16/24 (dialog titles) · `s-14` 14/22 (default UI) · `s-strong-14` 500 14/22 · `xs-13` 13/20 (menus, chips, tabs) · `xs-strong-13` · `xxs-12` 12/18 (hints) · `xxxs-11` 11/14 (tags).
- Markdown (chat content, base size 14 adjustable 10–22): h1 700 21/30 · h2 700 19/28 · h3 700 18/26 · h4 600 14/24 · body 14/**24** · strong 600 · table 13/22 (head 500) · small 12/20 · inline code 12/19 code font · code block **11/19** (setting 10–16).
- Weights in use: 400, 500, 600 and 700. Figma's 510 is rendered as 500.

### 2.4 Radius [docs `docs/ui-radius.md`, source `base.css`]
`--dsw-radius-xs 4px` (keycaps, tiny tags) · `-sm 8px` (H20–28 controls: small buttons, icon buttons, compact menu items, tooltips) · `-md 12px` (H32–40: buttons, inputs, selects, nav rows, menu items) · `-lg 16px` (large groups, code blocks, diffs, menus' outer edge, toasts, tool IO cards) · `-xl 20px` (independent cards: settings cards, message bubble, guide cards, approval/question cards) · `--dsw-radius-panel 28px` (composer, dialogs, settings panel). Circles and pills use `50%` or `999px` with `corner-shape: round`. Every other corner uses `corner-shape: superellipse(1.5)` where the browser supports it.
Nested rule: standard menu = outer R16, 4px padding, R12 items. Compact menu = R12, 4px padding, R8 items. SegmentedControl = R12, 4px inset, R8 segments. SegmentedTabs = R16, 4px inset, R12 segments.

### 2.5 Elevation / shadows [source `gradient-shadow-text.css`]
- `--dsw-elevation-stroke: 0 0 0 0.5px var(--dsw-elevation-stroke-color)`. The stroke colour defaults to `border-l4`; menus rebind it to `border-l1` and the composer to `border-l2`.
- `--dsw-elevation-panel`: stroke, `0 3px 8px rgba(0,0,0,.03)`, `0 0 16px rgba(0,0,0,.02)` (todo dock, question card).
- `--dsw-elevation-prominent`: stroke, `0 3px 8px rgba(0,0,0,.04)`, `0 0 20px rgba(0,0,0,.05)` (menus, dialogs, settings panel).
- `--dsw-elevation-soft`: stroke, `0 4px 16px rgba(0,0,0,.03)`, `0 0 24px rgba(0,0,0,.03)` (composer card).
- `--dsw-shadow-lv2: 0 4px 12px rgba(0,0,0,.02), 0 2px 8px rgba(0,0,0,.04)` (approval card) · `--dsw-shadow-lv3: 0 0 1px rgba(0,0,0,.2), 0 0 4px rgba(0,0,0,.02), 0 12px 32px rgba(0,0,0,.08)` (toast).
- Rule: elevated surfaces use `border:0` plus an elevation shadow. Flat items (buttons, inputs, cards, dividers) use a **0.5px** neutral border. Dashed affordances and state-coloured borders use 1px.

### 2.6 Motion
`--ds-ease-in-out: cubic-bezier(0.4,0,0.2,1)`; durations `--ds-transition-duration-fast .1s`, `--ds-transition-duration .2s`, `--ds-transition-duration-slow .3s`. Typical uses: hover colour 100ms, tooltip fade-in 150ms, modal fade 200ms, column collapse 300ms, segmented indicator 160–180ms, toast in 160ms with a 3s hold then a 1s fade. Hover styles apply only under `@media (hover:hover)`. Everything respects `prefers-reduced-motion`. [source]

### 2.7 Focus, scrollbars, spacing
- Focus ring: `outline: 2px solid var(--dsw-alias-state-business-primary)`. It is drawn inside (`outline-offset:-2px`) for row-like controls. It appears only for keyboard modality (`html[data-input-modality='pointer']` hides it). [source `focus.css`]
- Scrollbar: 5px wide, transparent track, `border-radius 999`, thumb `scrollbar-bg-l1`, and `-l2` on elevated surfaces. Firefox uses `scrollbar-width: thin`. [source `scrollbar.css`]
- Spacing: there is no spacing token. The common numbers are 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 48 px. Page gutters are `clamp(24px, 4vw, 48px)` and page content is max 960px. [source]

---

## 3. Component inventory (ui-primitives and shared patterns)
Every control lives in `ui-primitives/src/*.tsx` and `*.module.css`. [source]

| Component | Key visuals |
|---|---|
| **Button** | Base: `inline-flex; gap 4; border:none; R12; 14px/22; padding 0 14px`. Sizes: `md` H36 R12; `sm` H28 R8 `12px/18 padding 0 10px`. Variants: **primary** (`button-primary-fill` = black ink in light, near-white in dark; text `label-primary-foreground`; hover `button-primary-hover`), **ghost** (transparent; hover `interactive-bg-hover`; active `-active`), **outline** (inset 0.5px `border-l3` shadow; hover fill), **toolbar** (rgba(84,85,87,.5) over media). Disabled: `opacity .4; cursor:not-allowed`. A 16px icon slot goes before the label. Screenshot pattern: "保存" is primary (black pill-ish R12) and "取消" is outline. |
| **Danger text button** | Transparent, `state-error-primary` text, hover `interactive-bg-hover-danger` (ModelsSection `.dangerButton`). |
| **Icon button** | 28×28, R8, `label-secondary`, hover `interactive-bg-hover`. In the collapsed rail: 36×36 R12. |
| **Input** (`Input`) | `.wrap` H32, `padding 0 8px`, gap 6, `0.5px solid border-l4`, R12, `bg-layer-1`; focus-within border becomes `state-business-primary`; 16px leading icon in `label-tertiary`; text 14/22; placeholder `label-dimmed`. Settings-form input: H34, `padding 0 12px`, R12, `bg-layer-3`, 13px; `aria-invalid` gives an error-red border. The screenshot's API key field is ~44px high (the modal input `.modalInput` is H44, R16, `padding 7px 14px`). |
| **Select (native look)** | Composer `.select`: H28, `padding 0 20px 0 8px`, R8, transparent, 13px/20 500 `label-secondary`, 12px chevron at right 4px, hover fill. Settings select (screenshot "OpenAI Chat Completions"): input-like box with a chevron. |
| **Menu / MenuSurface** | Container: `padding 4px`, R16, no border, `elevation-prominent` with stroke `border-l1`, material `--dsw-menu-surface-fill` plus `backdrop-filter: blur(40px) saturate(150%)`; min-width 144, max 360; opens 4px below the anchor. **Item**: min-h 34, `padding 6px 8px`, gap 6, R12, `13px/20`, 14px icon in `--dsw-alias-menu-icon`, hover/focus `interactive-bg-hover`, checkmark at right, shortcut keys 11px caption. **Danger item** uses the error colour and danger hover. **Group label** `11px/15 label-tertiary padding 6px 8px`. **Separator** 0.5px `border-l2`, margin `3px 8px`. **Compact** variant: item H24, `11px/17`, R8. **Submenu** opens to the right with a 10px gap. Fade in/out. |
| **Tooltip** | Bubble `padding 3px 7px`, R8, `bg tooltip-bg`, white `13px/20`, max-width 50vw, fades in over 150ms, optional shortcut keycaps (`tooltip-key-bg`). Placed bottom, top, left or right. |
| **Modal** | Fixed overlay z 1000, padding ≥24px. Mask `bg-mask-1` with no blur. Dialog `width min(380px,100%)`, R28, `bg-layer-2`, `elevation-prominent`, `gap 20`, padding-bottom 24. Header `padding 22px 14px 12px 24px`; title `16px/24 500`; close is a 28×28 R8 ×. Description 14/22 primary, `padding 0 24px`. Footer right-aligned, gap 8 (actions min-width 72). A warning variant adds an amber triangle icon before the title. Fade in 200ms. |
| **Switch** | 36×20 track, padding 2, radius 999. Off: `border-l3`. On: `brand-primary` (**black** in light, white-ish in dark). 16px round thumb moving 16px over 120ms. |
| **Checkbox** | Native 16px with `accent-color: brand-primary`; label 14/20, gap 6. |
| **SegmentedControl** | Track `padding 4; gap 2; R12; bg interactive-bg-hover`. Indicator `bg-layer-1`, R8, `elevation-soft`, slides over 160ms. Segments H28, `padding 0 16`, `13px/20 500 label-secondary` (selected: primary). |
| **SegmentedTabs** (screenshot "第三方模型提供商 / 自定义模型 API") | Track R16, inset 4, `bg-module-platform`. Indicator R12 with `0.5px border-l3` and `bg-layer-3`. Tabs H34 (sm: H30, inset 2), 14px/20; selected is 600 primary. |
| **Tag** | Pill radius 999, `padding 1px 8px`, `11px/17 500`. Tones: outline (0.5px l4, tertiary), solid (primary bg, inverted text), neutral (`bg-module-platform`, secondary), quiet, success/info/warning/danger (the colour at 10–12% as background, the colour as text). Settings uses a small square tag: `.rowTag` `padding 1px 6px; 0.5px border-l3; R4; 11px/16`. |
| **Pill** | H24, `padding 0 8`, radius 999, `12px/18 label-secondary`, `bg-layer-2`; active state uses `button-ghost-active-fill` with a 1px inset border. |
| **StateDot** | Dot is `currentColor` at 60% of its box. States: done = green, warning = amber, error = red, idle = neutral-300. **Running** is a spinner ring (stroke 2, 25%-opacity track, arc dash animation over 1.5s, `label-tertiary`). |
| **Toast** | Fixed at top 40px, centred; `padding 12px 16px; R16; bg toast-bg; white 14/22; shadow-lv3`; optional leading icon (warn amber / success green) and inline action links in `deepseek-400`; auto-fades after 3s. |
| **DisclosureRow** (generic collapsible process row: thinking, tools, context, compaction) | Row height 24px; `label-tertiary` (hover `label-secondary`); 16px leading icon that swaps to a chevron on hover; title `13px/24`; then a 2×2px dot separator (`label-caption`, margin 0 8) and a summary `13px` with ellipsis. Expanded body is indented `padding-left: 22px`. |
| **HoverCard**, **QuotePreview**, **ImageLightbox**, **CodeCard**, **DiffBlock**, **TerminalBlock**, **SearchBlock**, **WebBlock**, **ReadBlock**, **JsonTree**, **markdown/CodeBlock** | Content renderers. Code blocks use R16, `markdown-code-block` fill, `0.5px border-l1`, code font 11/19, and shiki colours (`ui-theme/src/styles/shiki.css`; e.g. keyword #d6336c, string #2f9e44, function #6741d9 in light). |
| **Settings card** (provider, preset, plugin) | `R20; 0.5px solid settings-card-stroke; bg settings-card-fill; padding 12px 14px; gap 12`. Head: name `14/22 500`, small id tag, 8px credential dot (green or red), actions at the right (H28 buttons). |
| **Settings form field** (`settings-form/fields`) | Field `padding 12px 0`, fields separated by 0.5px `border-l2`; label `13px 500`; help "?" 24×24 button; hint 12px tertiary; save button `padding 5px 14px; R12; 13px; bg label-primary; color bg-layer-3`. |
| **Dashed add tile** | Screenshot "+ 添加模型提供商": full width, ~56px, 1px dashed `border-l3`, R20, centred "+" plus label 16px. Also "模型选择器中将不显示任何模型…" as a dashed empty box. [inferred from screenshot and the radius rules] |
| **Empty state** | Centred glyph over text; `padding 48px 20px`; 14px; `label-tertiary`. The schedule page uses a 110px illustration plus an action button. [source] |
| **Skeleton** | `bg-skeleton` rgba(0,0,0,.04) / rgba(255,255,255,.08) with an opacity pulse. |
| **Icons** | Own set, 16×16 viewBox, `fill:none`, stroke `currentColor` at 1 (regular) or 1.3 (medium). They are rendered as `<svg><use href="#dsw-icon-<glyph>-<weight>"/></svg>` from a hidden sprite. Glyph list: agent-preset, alarm-clock, api, apps-add, archive(-check/-off), branch, browse, check(-circle), chevron-down/left/right/up, chevrons-up-down, clock, close(-circle), code, compact, compare-split, context-injection, copy, cordis-plugin, dark/light/followsystem, database, deliver-doc, (dis)like, download, drag-handle, edit, ellipsis, enhance, flat-list, folder-open/close, fullscreen, gauge, globe, goal, info, inspect, layers, link, list-pen, loading, microphone, new-chat, nowrap/wrap, panel-left, paperclip, paper-plane, pause, personalization, pin(-fill), plan, play, plugin-pinwheel, plus, project-add, question, queue, refresh, right-up, save, search, send, settings, share, shield, skill, sliders-two, sparkle, stop-fill, think, trash, tree-corner, triangle-right-fill, unarchive, user(s), warning(-triangle), workspace-tree. The whale ("fish") logo is `ui-primitives/src/FishLogo.tsx`. |

---

## 4. Chat / conversation

### 4.1 Geometry
- Transcript column width `--dsh-chat-content-width` defaults to `clamp(680px, 64% of column, 920px)`. The user can drag it via invisible gutter handles (min 640, stored in localStorage `dsh.conversation.contentWidth`). The composer card max width is the content width plus 32px. [source `ConversationWidthControls.tsx`]
- Scroll area `padding: 16px (side clearance 16 + 16)`. Flow item gap is 4px by default, 12px around the response group, 16px for turn-process rows, and 44px between turns. [source `ui-chat/.../ChatView.module.css`]
- The composer seat is `position: sticky; bottom:0; z 9` with a background gradient (transparent → `bg-base` over 36px), so the transcript fades under it. A "回到底部" floating button is 34×34 circular, `button-floating-fill` plus elevation, 16px above the composer. [source]

### 4.2 Composer (ui-conversation `InputBar.module.css`)
- **Card**: `R28 (--dsw-radius-panel)`, `background: var(--dsw-specific-input-major)`, `border:0`, `box-shadow: var(--dsw-elevation-soft)` with stroke `border-l2`, `padding-top 8px`, `gap 12`. Text is the content font size (14) with line-height 24. Max height of the text before scrolling is 336px (14 lines).
- **Editor**: contenteditable (Lexical), `padding 4px 8px 0 14px`, min-height 36 (52 in the hero), caret blue. Placeholder `label-caption`, single line with ellipsis (two lines in the hero).
  - Placeholders: default "**发消息或创建任务, / 调用指令, @ 文件或对话**"; hero "**描述你想要构建的内容, / 调用指令, @ 文件或对话**"; "选择一个工作区开始"; "会话不可用". (The marketing screenshot's "给 DeepSeek 发送消息" is outdated.)
- **Bottom row**: `padding 2px 8px 6px; gap 12; justify-content: space-between`, wraps when narrow. From left:
  - **+ button**: 28×28 circle, `bg --dsw-specific-selector`, `plus-outline` icon, hover `interactive-bg-hover-solid`. Opens the `/` menu with sections "添加" (文件, 目标, 计划, 反馈) and "指令" (压缩, 权限, 模型, 下载日志). aria label "添加文件或调用指令".
  - **Permission chip** (slot `conversation.input.permission`): `shield-outline` 14px icon plus "**工作区内修改**" plus a chevron. Trigger H28, `padding 0 4px 0 8px`, R8, `13px/20 500 label-secondary`, hover fill. Options: **仅可查看 / 工作区内修改 / 完全权限**. Choosing 完全权限 opens a confirm dialog "确认启用完全权限？" with a checkbox "我已了解风险，并愿意继续" and buttons "取消" / "启用完全权限".
  - Plan chip "计划" appears when plan mode is on (slot `conversation.input.plan`).
  - Right group: **Model selector** (slot `conversation.input.model`): label "DeepSeek-V4.1-Flash" in `13px/20 400 label-secondary` plus the effort "High" in `label-caption` plus a chevron. Trigger H28, max 360px, R8. The menu is a MenuSurface 240–420px wide, max-h 360, with a search field "搜索模型…", sections "模型" and "推理等级". When the row is narrow, the text collapses to an icon.
  - Optional `conversation.input.activity` control.
  - **Send**: 34×34 circle, `background: var(--dsw-alias-button-info-fill)` (deepseek-500 light / -400 dark), white up-arrow glyph, `translateY(-2px)`. Disabled (empty draft): `opacity .4`. Sending: an 800ms spinning arc. While running with an empty draft the seat becomes **Stop** (`stop-fill`). Labels: 发送消息 / 停止生成 / 排队发送 / 插话发送.
- **Dock under the card** (`.dock`, min-height 22): StatsPills (`12px label-tertiary`; "{turns} 轮 {steps} 步", "缓存命中 {percent}%", tok/s) plus the **context meter** (a ring plus a percentage; clicking shows "上下文已用" with 系统提示词 / 工具定义 / 对话消息).
- **Docks above the card**: the Todo dock "任务" (`{done}/{total} 已完成`; R16 frosted menu material, `elevation-panel`, inset narrower than the card) and the **QueueDock** ("{n} 条排队消息" with edit, remove and 插话发送 per row).
- Drag-and-drop overlay text: "文件或图片拖动到此处即可添加".
- Keys: Enter sends; Shift+Enter inserts a newline; Cmd/Ctrl+Enter uses the complementary queue/steer mode; Esc Esc stops the run.
- Takeovers: approvals, user questions and plan review replace the composer card through the `conversation.composer` chain (§4.6–4.7).

### 4.3 Messages
- **User message**: right-aligned bubble. `background --dsw-specific-bubble` (pale blue rgb(237,243,254) light / bluish-850 dark), **R20**, `padding 10px 16px`, 14/22, `pre-wrap`; max width `min(70.2% of content width, 82%)`. Images and files stack above it, right-aligned (file card 240×64, R16, 0.5px l2 border). An actions row (copy) shows on hover. [source `UserMessageBubble.module.css`, `MessageItem.module.css`]
- **Assistant text**: no bubble, full column width, markdown 14/24 `label-primary`; block gap 16px. Wide tables bleed into the gutters. Links use `--dsw-alias-link` at 500 weight, with no underline at rest and a dotted underline on hover. [source]
- **Message actions** (after the final answer, `margin-top 16`): 28×28 R8 icon buttons in `label-tertiary` with hover fill. They are: copy ("复制" / "复制成功"), branch ("在新对话中分支"), like/dislike (ui-message-feedback), and the time. They show on hover for older turns. [source `MessageIconActions.module.css`]
- **"已停止" tag** after a stopped answer: 11px/18, R8, hover-fill background. Errors: red "本轮运行失败" title (600) plus a grey message; "已达到输出 token 上限" in amber. [source]

### 4.4 Process rows: thinking, tools, turn summary
- **Thinking**: a DisclosureRow titled "**思考**". While streaming, the summary shows a one-line live preview with a right fade mask. Expanded, the body is indented 22px in the compact markdown style (tertiary). [source `ReasoningRow.module.css`, locale]
- **Turn process header** (folds the whole turn's work once the answer is done): full width, 33px high, `border-bottom 0.5px l2`, `label-tertiary` 14px, a chevron that rotates 180°. The label combines e.g. "已完成，用时 1分20秒 · 12 次工具调用 · 3 条消息" or "已思考". Live step titles read 正在读取文件 / 正在运行命令 / 正在搜索代码 / … and settled ones read 已读取文件 / 执行了命令 / 修改了文件 / … [source `TurnProcessNodeView.module.css`, locale]
- **Tool call row** (ui-tool `ToolRow`): a DisclosureRow with the tool icon, a title (`13px/24`, 400), the dot separator and a summary (path or description, ellipsis). File paths are dotted-underlined links. Write/edit rows add diff stats `+N` green / `-N` red in code font. Running rows have a left-to-right **shimmer** sweep. Error rows show the summary in `state-error-primary`; stopped rows use `state-warn-label`. Shipped tool titles include 读取 / 写入 / 编辑 / 运行命令 / 搜索文件内容 / 查找文件 / 网页搜索 / 网页获取 / 创建子智能体 / 工具调用 · <name> (generic). [source `ToolRow.module.css`, locale]
  - Expanded body (indented 4px): an **IO card** (R16, `markdown-code-block` fill, 0.5px l1 border, 11/16 code font; a grid with "输入" / "输出" labels in caption colour; sections max-h 150 scroll), a terminal card (max output 224px), a diff block, search results and so on. The body scroll caps at 260px. A floating "查看" (inspect) pill (11px, radius 999, 0.5px l3 border) appears on hover.
  - A non-zero exit shows a neutral capsule with a red dot ("退出码 1").
- **Running indicator**: below the turn, a hairline divider, then the **running whale tail** (an animated 14px whale-tail glyph, static SVG fallback) plus shimmer text "**深度求索中**" / "深度求索中，用时 {duration} ···". Colour `--dsw-alias-label-deep-diving`, font 12px (content size − 2) / 22, tabular numbers. [source `RunningStatus.tsx`, `ChatView.module.css`]
- Other rows: "上下文已压缩" (compaction, expandable), "正在重试模型请求（n/m）· Ns" (retry), "系统提示词", "上下文注入", trigger notices (收到执行请求 / 自动化任务 / 子智能体已完成任务…).

### 4.5 Plan, goal, todo, deliverables, jobs, subagents
- **Plan** (ui-plan): composer chip "计划" (tooltip "计划模式已开启 — 点击关闭（/plan off）"). A plan preview card in the turn tail ("计划 · Markdown", 打开 / 查看全文) opens a right-sidebar tab. A plan awaiting review takes over the composer with the header "**计划待审**" and buttons **同意执行 / 拒绝 / 要求修改**. Session row label: 计划待审. [locale]
- **Goal** (ui-goal): a composer dock showing "进行中的目标 / 已暂停的目标 / 受阻的目标" with actions 编辑目标 / 暂停目标 / 恢复目标 / 清除目标. The hint text in the input is "输入目标，智能体将持续执行". [locale/docs]
- **Todo**: the dock above the composer (see 4.2); rows use idle, spinner and done markers for 待处理 / 进行中 / 已完成.
- **Deliverables** (ui-deliverables): an end-of-turn card "**已编辑 {count} 个文件**" listing files with `+N/-N`; "在侧边栏查看本轮改动" opens a review tab "第 {turn} 轮改动" (split/unified diff). Delivered-file cards ("交付文件", "在侧边栏预览") are R16 with a 40px R10 icon tile. [locale, ui-radius doc]
- **Background jobs** (ui-jobs): a header utility "{count} 个后台任务" opening a menu with sections **进行中** / **已结束 {count}** / 清空. Rows show a ticking duration, kind and status (运行中 / 已完成 / 已取消 / 已失败) and expand to live output. [locale/docs]
- **Subagents** (ui-subagent): a header switcher "{count} 个子智能体(，正在运行)" opening a tree menu titled "子智能体" with progress counts (n 已完成 / n 进行中), duration and tokens. A child opens as a navigable conversation (breadcrumb lineage), "在侧边栏打开" or "在浮窗中打开". Creation tool rows show "创建子智能体" plus the description.
- **Agent team** (ui-agent-team): a Team switch and shared tasks below the subagent tree.

### 4.6 Approval prompt (ui-approval `ApprovalPanel.module.css`)
It replaces the composer (`conversation.composer` chain). Card: `max-width = content width; 1px solid state-warn-secondary (amber); R20; bg input-major; shadow-lv2`. Top strip `padding 10px 16px; bg state-warn-tertiary; amber 13px/18` reads "**等待审批**". Body `padding 12px 16px`: headline `15px/24 500` (e.g. "工具 {toolName} 请求越权执行") plus the command in code font 13px tertiary. Action row right-aligned, gap 8: **拒绝** (outline; hover turns red-tinted), **允许** / **允许一次**, **始终允许** (primary when offered). Enter allows; Esc rejects. [source/locale]

### 4.7 User questions (ui-user-questions)
A composer takeover card: `max-width content width; max-h min(60vh,520px); R20; bg input-major; elevation-panel`. Header `padding 20px 16px 0 24px` with the title `16px/22 500` and nav buttons (上一题 / 下一题 / 收起问题卡片 / 放弃整组问题). Options list `padding 4px 12px`: each option is min-h 40, R12, `padding 8px 12px 8px 8px`, label `14px/24 500`, a "推荐" tag, and a free-text field "输入你的答案". Footer `margin-top 12`: a countdown "{seconds} 秒后继续工作" / "会一直等你回答" plus **跳过** / **下一题** / 提交. In the transcript the tool row reads "提问 · 等待回答" with a "回答" button to reopen. [source/locale]

### 4.8 Streaming behaviour [docs/source]
- Assistant deltas render progressively at animation-frame cadence. The list follows the tail until the user scrolls up; then "回到底部" appears. Older history loads with "加载更早" and "载入历史…".
- When a turn finishes, the process rows fold under the turn-process header (default: "回答结束后"; configurable). A right-side turn navigator lists turns ("第 {turn} 轮").
- A send is pending until the Host accepts it: the composer goes read-only and the send button spins. Queued messages appear in the QueueDock.

---

## 5. Settings dialog and management pages

### 5.1 Settings dialog (ui-settings-general `SettingsRoot.module.css`, screenshot)
- Overlay z 1000, mask `bg-mask-1`. **Panel 800×min(800, viewport−2×24)**, R28, `bg-layer-2`, `elevation-prominent`. Grid areas `'title header' / 'nav options'`, columns **188px | 1fr**.
- Nav title "**设置**" `16px/24 500`, `padding 22px 12px 8px 24px`.
- Nav list `padding 10px 12px`, gap 4. Nav cell **40px**, `padding 9px 16px 9px 12px`, R12, 16px icon plus label 14/22 with gap 8; hover fill; **active `bg --dsw-specific-sidebar-nav-item-active`** (bluish-100).
- Header (54px, `padding 20px 14px 8px 10px`): right-aligned actions (e.g. outline "打开配置文件") and a 28×28 close ×.
- Options area `padding 0 24px 24px`, scrolls. Section content max-width 720px: title `16px/24 500`, intro `14px/22 label-tertiary`, then cards with gap 8–12.
- Section order (`settings.section` order): **账号与余额** (-10) · **通用设置** (0) · **模型** (10) · **内置插件** (15) · **Agent 预设** (20). General holds rows registered into `settings.general.item`: language, permission default, appearance (light/dark/system cubes), font size, chat display preferences ("工作步骤展示" 简洁/标准/详细/完全展开, "网页链接默认打开方式", "繁忙时的发送行为"), and the Coding Tools switch.
- Below 768px the panel is fullscreen with a horizontal scrolling nav strip (cells min 108px).
- Shortcut: Mod+Alt+, (Web) / Mod+, (desktop).

### 5.2 Patterns inside settings pages
- Card list: settings card material (R20, 0.5px l4 stroke, layer-2 fill, `padding 12px 14px`). A collapsible "> 自定义设置" disclosure. Footer buttons H36 "取消" (outline) and "保存" (primary black), right-aligned.
- Add tile: dashed full-width "+ 添加模型提供商".
- SegmentedTabs at the top of sub-forms. Form fields: label 13–14px 500 above the control, hint 12–14px tertiary below.
- Agent preset page: groups "内置" / "自定义", cards with name plus description (clamped to 4 lines), "设为新任务默认" and "查看配置", and a "新任务默认" badge. Names: 标准模式, PTC 模式, 极简模式, 创造模式.
- Built-in plugins: a SegmentedTabs strip of `settings.plugins.tab` pages (inventory "全部").

### 5.3 Main-panel "management page" pattern (automation tasks, plugins)
[source `ui-schedule/src/client/TaskManagerPage.module.css`, `ui-plugin-manager/src/client/PluginManagerPage.module.css`]
- Page `bg-base`, 14px with line-height 1.6. The scroll container uses `scrollbar-gutter: stable` and a 9px scrollbar.
- Content `max-width 960px; margin 0 auto; padding 0 clamp(24px,4vw,48px) 48px` (20px on mobile).
- **Heading row**: `padding-top 28px; margin-bottom 24px`, wraps. H1 `20px/28 500`. Actions on the right: H32 buttons, `13px/20`, R16 (pill-like). The primary is a **split button**: "创建" plus a 32×32 arrow that opens a menu (在会话中创建 / 手动创建).
- **Filter tabs**: H28, `padding 0 10`, radius 14, `14px/22 label-tertiary`; the active one has `bg interactive-bg-hover` and primary text ("全部 / 已开启 / 已暂停 / 已结束").
- **Search field**: H36, `padding 0 10`, `0.5px border-l3`, R12, a 14px search icon, placeholder caption colour, focus border blue, a 28px clear button, plus a 36×36 "…" more button.
- **List rows**: `padding 8px; gap 12; R12`, a 16×20 glyph, title (line-height 23), summary/metadata `13px/21` tertiary ("下次计划时间：…"); selected or hover fill. Rows are separated by 2px gaps (no dividers). Plugins rows use `padding 12px 2px; border-bottom 0.5px l2` inside R20 cards, with a section title `14px/20 500`.
- **Detail**: selecting a task opens a detail pane or a right-sidebar tab with tabs (规则 / 任务运行记录) and actions 立即执行 / 暂停任务 / 恢复任务 / 删除.
- **Empty state**: illustration plus "还没有自动化任务，在会话中创建的任务会显示在这里" plus "新建自动化任务".
- Plugins page: title "插件", subtitle "安装、启用和配置插件" with an ⓘ info tooltip; header actions "刷新" and the split button "添加插件"; tabs "已安装" / Discover (SegmentedTabs, 34px); sections "内置插件配置" (cards contributed through `plugins.item`), "实验性插件" (+ 更多), "已安装插件". Bundle rows have an icon, title, description, a status tag (运行中 / 异常 / 实验性) and a Switch.

---

## 6. Plugin extension surfaces (how a HeyAgent plugin adds UI)

General mechanics [docs `packages/client/AGENTS.md`, `docs/subsystems/conversation.md`]:
- A client plugin is a package with `dsh.client` in `package.json` (`platform:'web'`) that exports `./client` with `apply(ctx)` and `inject` (a list of services).
- Everything goes through `ctx.slots.inject(<slot>, () => ctx.slots.register({ name, key|id, order?, label?, locale?, store?, inject? }, Component))`. `inject` waits for the slot's owner. Components receive props only (no ctx).
- Strings are registered via `ctx.locale.register(NS, { zh, en, … })` and read with `t`. Product strings must not be hard-coded.
- Styling uses CSS Modules with `--dsw-alias-*` tokens only. No Tailwind or component library.
- Slot kinds: `single`, `list` (id + order), `keyed` (key), `chain` (select function, priority).

| Want | API / slot | Example package |
|---|---|---|
| **(a) Sidebar row + main page** | `ctx.slots.register({ name:'sidebar.panellist', id: PANEL_ID, order, label: () => t('panel') }, IconComponent)` (the icon receives `size`) **plus** `ctx.slots.register({ name:'main', key: PANEL_ID, store?, inject? }, PageComponent)`. Navigate with `ctx.layout.selectPanel(PANEL_ID)` / `selectPanel(null)`. Optional `sidebar.panellist.actions` adds rows to the sidebar "更多" menu. | `ui-schedule/src/client/index.ts` (id `schedules`, order 10, `TaskManagerIcon` + `TaskManagerPage`); `ui-plugin-manager` (id `plugins`, order 0) |
| **(b) Right-sidebar tab** | 1. `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?: [{id,title,description,icon}], keepMounted?, multiple? })`. 2. Body: `ctx.slots.register({ name:'sidebar.right.pane.tab', key: definition.id }, Body)` (reads `useTabInfo()` → `{sidebar, panel, tab}`). 3. Optional title: `sidebar.right.pane.tab.title`. Open with `ctx.sidebarRight.openTab(kind, { params })` or `openResource('dsh-resource://…')`. Guide cards: `guide` entries or the `sidebar.right.tab.guide.entry` slot. Tab menu items: `sidebar.right.tab.menu.item`. | `ui-schedule` (task detail tab), `ui-plan` (plan file tab), `ui-sidebar-browser`, `ui-sidebar-terminal`, `ui-sidebar-files`, `ui-sidebar-documentpreview` |
| **(c) Settings** | Whole section: `settings.section` (`id`, `order`, `label`; icon via `settings.section.icon` with the same id). A row inside General: `settings.general.item` (id, order). A tab inside "内置插件": `settings.plugins.tab`. A card on the Plugins page: `plugins.item` (ui-plugin-manager slot). Persisted values come from `ctx.configForms.get(entryId)` / `whileServed([...ns], register)`. Onboarding step: `settings.onboarding`. | `ui-settings-models` (section `models`), `ui-agent-preset` (section `agent-presets`), `ui-theme` (general items `appearance`, `font-size`), `ui-chat` (general items `transcript-view`, `link-opening`), `ui-settings-web-search` (`plugins.item` id `web-search`), `ui-settings-plugin-inventory` (`settings.plugins.tab`) |
| **(d) Chat node for custom events** | `ctx.uiConversation.events.register(definition: ConversationNodeDefinition)` (`kind`, `target:'chat'`, `match(event)`, `start`, `update`, `buildViewNode`, optional `groupTree: 'exchange'\|'input'\|'turn'\|'process'`, `exclusive`) **plus** `ctx.slots.register({ name:'conversation.chat.node', key: kind }, NodeView)`. Turn-tail cards (below the final answer): `conversation.chat.turnTail` (id, order). Custom **tool-call** view: `ctx.slots.register({ name:'tool.call.toolview', key:'<wire tool name>' }, Row)`; props are `ToolCallOwnerProps` (`phase` preparing/start/result, `block`, `openFile`, `inspect`). Reuse the primitives `DisclosureRow` and `ToolRow` for the look. | docs `docs/subsystems/conversation.md` (review-job example); `ui-goal` (chat node + user-text node); `ui-schedule` (`scheduleTurnDefinition` + turnTail `schedule-created`); `ui-skill` (toolview `skill`); `ui-deliverables` |
| **(e) Composer controls, `/` commands, `@` triggers** | Slots: `conversation.input.dock` (above/below the card, e.g. the goal dock), `conversation.input.permission`, `conversation.input.model`, `conversation.input.plan`, `conversation.input.attachments`, `conversation.input.overlay`, `conversation.input.activity` (one control between model and send; can expand), `conversation.composer.bar` / `.dock`, `conversation.hero.agentPreset`. Takeover of the whole composer while a request is pending: the chain `conversation.composer` with `select(owner) => matched\|null`. Slash commands: `ctx.commandUi.register({ … popupSelect \| action, label, description, icon })` or `ctx.commandUi.decorate(...)` on a Host command. Arbitrary trigger character: `ctx.get('inputTriggers').registerSource({ trigger:'@'\|'/'\|…, … })`. | `ui-goal` (input dock), `ui-plan`, `ui-permission-presets`, `ui-model-selection`, `ui-approval` (composer chain), `ui-user-questions` (composer chain), `ui-message-feedback` (`commandUi.decorate`), `ui-reference` (`@` source), `ui-skill` (`/` skill source) |
| **(f) Session list decorations** | `sidebar.session.row.leading` (a small mark shown only when the row is idle), `sidebar.session.row.hover` (hover-card content), `sidebar.workspaces.session.row.action` (row quick action), `sidebar.workspaces.session.menu.item` (the "…" / right-click menu), `sidebar.toggle.badge` (badge on the collapsed sidebar toggle), `contextMenu.content` / `contextMenu.icon`. | `ui-schedule` (`SessionScheduleMark` clock on leading, `SessionScheduleHover`), `ui-open-in-app`, `ui-settings-general` (update dot) |
| Header controls | `conversation.session.header.utilities` (id, order; e.g. the schedule clock at order −5), `conversation.session.header.actions`, `.corner`, `.lineage`, `.views.actions`; extra transcript views: `conversation.view` (id, order, label; e.g. "轨迹"). | `ui-schedule`, `ui-jobs`, `ui-subagent`, `ui-trajectory` |
| Global overlays / toasts | `shell.overlay` (id), `shell.bottom`, `workspace.toast`. | `ui-schedule` delete toast |
| Branding | `sidebar.brand.mark`, `sidebar.brand.name` (and the hero mark). A replacement package occupies these slots. | `ui-brand-official` |
| Theme override | `ctx.theme` register(themeId, alias-token overrides, icon replacements). | docs ui-theme README |

---

## 7. Exact zh-CN strings (commonly visible)
[source locale files; a key path is shown where useful]

**Shell / sidebar**: 新会话 · 新建会话 · 打开侧边栏 · 收起侧边栏 · 更多 · 从左侧栏取消固定 · 工作区 · 会话 · 默认工作区 · 未分组 · 未命名 · 添加工作区 · 添加工作区… · 视图选项 · 分组方式 (按工作区 / 按工作区树 / 单列表) · 排序方式 (手动排序 / 最近更新) · 筛选会话 (隐藏已归档 / 全部对话（显示已归档） / 仅显示已归档) · 搜索会话名称 · 无匹配会话 · 展开其余 {n} 个会话 · 收起 · 暂无会话 · 暂无已归档会话 · 查看其他会话 · Session menu: 置顶会话 / 取消置顶 / 重命名 / 分叉会话 / 复制 Session ID / 归档会话 / 取消归档 · Toasts: 会话已归档，可 撤销 或 筛选已归档会话 · Status: 进行中 / 空闲 / 等待审批 / 计划待审 / 等待回答 / 已完成 · Compact: 待审批 / 计划待审 / 待回答 · Times: 刚刚 / {n}分钟 / {n}小时 / {n}天 / {n}个月 / {n}年 · 删除工作区 · 停止并归档此会话？ · 停止并归档.
**Panels**: 插件 · 自动化任务 · 设置 · 意见反馈 · 账号与余额.
**Hero**: 探索未至之境 · 预览版 · 选择工作区 · 选择一个工作区开始.
**Composer**: 发消息或创建任务, / 调用指令, @ 文件或对话 · 描述你想要构建的内容, / 调用指令, @ 文件或对话 · 添加文件或调用指令 · 发送消息 · 停止生成 · 正在发送消息 · 排队发送 · 插话发送 · 文件 · 上传中… · 上传失败，点击重试 · 上下文已用 · 系统提示词 / 工具定义 / 对话消息 · 仅可查看 / 工作区内修改 / 完全权限 · 请选择模型 · 搜索模型… · 模型 · 推理等级 · Menu sections 添加 (文件 / 目标 / 计划 / 反馈) and 指令 (压缩 / 权限 / 模型 / 下载日志) · 文件与文件夹 / 子智能体 / 对话 (@ menu sections) · {n} 条排队消息 · 发送中….
**Chat**: 对话 · 轨迹 · 思考 · 已思考 · 已完成，用时 · 处理失败 · {count} 次工具调用 · 深度求索中 · 深度求索中，用时 {duration} ··· · 回到底部 · 加载更早 · 载入历史… · 已停止 · 在新对话中分支 · 复制 / 复制成功 · 本轮运行失败 · 已达到输出 token 上限 · 上下文已压缩 · 正在压缩… · 正在重试模型请求 · 运行中 / 失败 / 已停止 · 输入 / 输出 / 查看 · 正在分析请求 · 正在读取文件 · 正在运行命令 · 正在调用工具 · 已读取文件 · 修改了文件 · 执行了命令 · 本轮用量 · 会话统计 · {turns} 轮 {steps} 步 · 缓存命中 {percent}%.
**Interactions**: 等待审批 · 拒绝 · 允许 · 允许一次 · 始终允许 · 工具 {toolName} 请求越权执行 · 计划待审 · 同意执行 · 要求修改 · 提问 · 等待回答 · 回答 · 跳过 · 下一题 · 上一题 · 输入你的答案 · 推荐 · {seconds} 秒后继续工作 · 会一直等你回答 · 任务 · 已完成 / 进行中 / 待处理 · 进行中的目标 · 编辑目标 / 暂停目标 / 恢复目标 / 清除目标 · 已编辑 {count} 个文件 · 在侧边栏查看本轮改动 · 交付文件 · {count} 个后台任务 · {count} 个子智能体.
**Right sidebar**: 开始 · 更多工具 · 新标签页 · 分栏 · 全屏 / 退出全屏 · 打开右侧边栏 · 收起右侧边栏 · 关闭 / 关闭其他标签页 / 关闭右侧标签页 · 工作区文件 · 终端 · 新建终端 · 浏览器 · 输入 HTTP(S) 地址 · 空面板.
**Settings**: 设置 · 打开配置文件 · 通用设置 · 模型 · 内置插件 · Agent 预设 · 账号与余额 · 填入各提供商的 API 密钥即可使用其模型。 · API 密钥 · 输入 API 密钥 · 自定义设置 · 添加模型提供商 · 取消 · 保存 · 第三方模型提供商 · 自定义模型 API · 获取可用模型 · 添加模型 · 创建提供商 · 设为新任务默认 · 查看配置 · 新任务默认 · 标准模式 / PTC 模式 / 极简模式 / 创造模式.
**Pages**: 自动化任务 · 创建 · 在会话中创建 · 手动创建 · 搜索自动化任务 · 全部 / 已开启 / 已暂停 / 已结束 · 下次计划时间： · 立即执行 · 暂停任务 · 恢复任务 · 新建自动化任务 · 还没有自动化任务，在会话中创建的任务会显示在这里 · 插件 · 安装、启用和配置插件 · 添加插件 · 刷新 · 已安装 · 内置插件配置 · 实验性插件 · 已安装插件 · 卸载 · 运行中 / 异常 / 实验性 · 还没有安装任何插件。
**Common**: 确定 · 取消 · 关闭 · 重试 · 加载中… · 加载失败 · 提交 · 正在提交… · 下一步 · 上一步 · 删除 · 编辑 · 保存 · 搜索 · 更多 · 展开 · 收起 · 返回.

---

## 8. Prototype checklist (implementation hints) [inferred]
1. Define all of §2 as CSS variables on `body` and `body[data-dark]`. Default to the light theme and add a toggle.
2. Build the grid shell: 280 / 1fr / 0. The left column background is `sidebar-fill` with a 0.5px divider. Click the panel toggle to switch to the 56px rail with a 300ms transition.
3. Sidebar content: brand row, the "新会话" button, panel rows (插件, 自动化任务, plus HeyAgent plugin rows such as 任务 / 技能 / 记忆 — each switching the `main` page), the "工作区" header with three icon buttons, workspace groups with session rows (status dot and time), and the account footer.
4. Main area states: hero (centred composer), active conversation (header with breadcrumb and 对话/轨迹 tabs, transcript, sticky composer), and management pages (§5.3).
5. The right sidebar opens from the header corner as a 45%-width column with a tab strip (开始 guide cards → files/terminal/browser/plugin tabs).
6. Settings modal: 800px, 188px nav, sections as cards.
7. Use dsh's icon SVGs from `ui-primitives/src/icons/artwork.ts` (copy the path strings) to stay faithful.
