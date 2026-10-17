import * as React from "react"
import {
  BookOpenIcon,
  BotIcon,
  BrainIcon,
  ChevronsUpDownIcon,
  CpuIcon,
  GlobeIcon,
  HistoryIcon,
  KanbanIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  LightbulbIcon,
  LogOutIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UsersIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { can } from "@heyagent/shared"

import { href, useRoute, type PageId } from "@/lib/router"
import { useMe } from "@/lib/session"

import { ChangePasswordDialog } from "./change-password-dialog"

interface NavItem {
  id: PageId
  title: string
  icon: LucideIcon
  /** 只有主管看得见 */
  adminOnly?: boolean
}

export const NAV_WORK: NavItem[] = [
  { id: "tasks", title: "任务", icon: LayoutGridIcon },
  { id: "todos", title: "待办", icon: KanbanIcon },
  { id: "sessions", title: "Session", icon: HistoryIcon },
]

export const NAV_CONFIG: NavItem[] = [
  { id: "memory", title: "记忆", icon: BrainIcon },
  { id: "skills", title: "技能", icon: BookOpenIcon },
  { id: "rules", title: "规则", icon: ShieldCheckIcon },
  { id: "tools", title: "工具", icon: WrenchIcon },
  { id: "browsers", title: "浏览器", icon: GlobeIcon },
  { id: "models", title: "模型", icon: CpuIcon },
  { id: "users", title: "用户", icon: UsersIcon, adminOnly: true },
  { id: "settings", title: "设置", icon: SettingsIcon, adminOnly: true },
]

export const NAV_LEARN: NavItem = { id: "learn", title: "看懂架构", icon: LightbulbIcon }

export const NAV_ALL: NavItem[] = [...NAV_WORK, ...NAV_CONFIG, NAV_LEARN]

export function AppSidebar({ onSignOut }: { onSignOut: () => void }) {
  const { page } = useRoute()
  const { user } = useMe()
  // 等我处理的事（侧边栏「待办」上的数字）：后端按登录的人算好，有变化时实时推送会让它重新拉
  const needsMe = user.needsMeCount
  const isAdmin = can(user, "user.manage", {})
  const [changingPassword, setChangingPassword] = React.useState(false)

  const renderItem = (item: NavItem, badge?: number) => (
    <SidebarMenuItem key={item.id}>
      <SidebarMenuButton isActive={page === item.id} tooltip={item.title} render={<a href={href(item.id)} />}>
        <item.icon />
        <span>{item.title}</span>
      </SidebarMenuButton>
      {!!badge && <SidebarMenuBadge>{badge}</SidebarMenuBadge>}
    </SidebarMenuItem>
  )

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<a href={href("tasks")} />}>
              <BrandMark />
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">HeyAgent</span>
                <span className="truncate text-xs text-muted-foreground">控制台</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>工作</SidebarGroupLabel>
          <SidebarMenu>{NAV_WORK.map((item) => renderItem(item, item.id === "todos" ? needsMe : undefined))}</SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>配置</SidebarGroupLabel>
          <SidebarMenu>{NAV_CONFIG.filter((item) => !item.adminOnly || isAdmin).map((item) => renderItem(item))}</SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>帮助</SidebarGroupLabel>
          <SidebarMenu>{renderItem(NAV_LEARN)}</SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuButton size="lg" aria-label="账号菜单" />}>
                <Avatar className="size-8">
                  <AvatarFallback>{user.name.slice(0, 1)}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-medium">{user.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{user.title}</span>
                </div>
                <ChevronsUpDownIcon className="ml-auto" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    {user.name}（{user.isAdmin ? "主管" : "员工"}）
                    <span className="block truncate font-normal">{user.email}</span>
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setChangingPassword(true)}>
                  <KeyRoundIcon />
                  修改密码
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onSignOut}>
                  <LogOutIcon />
                  退出
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
      <ChangePasswordDialog key={changingPassword ? "open" : "closed"} open={changingPassword} onOpenChange={setChangingPassword} />
    </Sidebar>
  )
}

/** 系统 logo：public/logo-64.png（由 logo.png 缩出来的）；图片加载失败时显示机器人图标 */
function BrandMark() {
  const [failed, setFailed] = React.useState(false)

  if (failed) {
    return (
      <div className="flex aspect-square size-8 items-center justify-center bg-sidebar-primary text-sidebar-primary-foreground">
        <BotIcon className="size-4" />
      </div>
    )
  }
  return <img src="./logo-64.png" alt="HeyAgent" className="aspect-square size-8 object-cover" onError={() => setFailed(true)} />
}
