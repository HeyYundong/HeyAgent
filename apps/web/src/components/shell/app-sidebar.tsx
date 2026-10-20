import * as React from "react"
import {
  BookOpenIcon,
  BrainIcon,
  ChevronsUpDownIcon,
  CpuIcon,
  GlobeIcon,
  HistoryIcon,
  ImagesIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  LightbulbIcon,
  LogOutIcon,
  PackageOpenIcon,
  ScanEyeIcon,
  SendIcon,
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
}

export const NAV_WORK: NavItem[] = [
  { id: "tasks", title: "任务", icon: LayoutGridIcon },
  { id: "sessions", title: "会话", icon: HistoryIcon },
  /** 派活（docs/dev/dispatch.md 第 9.2 节） */
  { id: "work", title: "派活", icon: SendIcon },
]

/** agent 干活时用的东西：图片、浏览器 */
export const NAV_RESOURCES: NavItem[] = [
  { id: "gallery", title: "图库", icon: ImagesIcon },
  { id: "compare", title: "比物", icon: ScanEyeIcon },
  { id: "browsers", title: "浏览器", icon: GlobeIcon },
]

export const NAV_CONFIG: NavItem[] = [
  { id: "memory", title: "记忆", icon: BrainIcon },
  { id: "skills", title: "技能", icon: BookOpenIcon },
  { id: "rules", title: "规则", icon: ShieldCheckIcon },
  { id: "tools", title: "工具", icon: WrenchIcon },
  { id: "models", title: "模型", icon: CpuIcon },
]

/** 只有主管看得见，员工那里整组不显示 */
export const NAV_ADMIN: NavItem[] = [
  { id: "users", title: "用户", icon: UsersIcon },
  { id: "settings", title: "设置", icon: SettingsIcon },
  { id: "imports", title: "导入", icon: PackageOpenIcon },
]

export const NAV_LEARN: NavItem = { id: "learn", title: "看懂架构", icon: LightbulbIcon }

export const NAV_ALL: NavItem[] = [...NAV_WORK, ...NAV_RESOURCES, ...NAV_CONFIG, ...NAV_ADMIN, NAV_LEARN]

export function AppSidebar({ onSignOut }: { onSignOut: () => void }) {
  const { page } = useRoute()
  const { user } = useMe()
  // 等我处理的事（侧边栏「会话」上的数字，点进去是「等人处理」）：后端按登录的人算好，有变化时实时推送会让它重新拉
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
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>工作</SidebarGroupLabel>
          <SidebarMenu>{NAV_WORK.map((item) => renderItem(item, item.id === "sessions" ? needsMe : undefined))}</SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>资源</SidebarGroupLabel>
          <SidebarMenu>{NAV_RESOURCES.map((item) => renderItem(item))}</SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>配置</SidebarGroupLabel>
          <SidebarMenu>{NAV_CONFIG.map((item) => renderItem(item))}</SidebarMenu>
        </SidebarGroup>
        {isAdmin && (
          <SidebarGroup>
            <SidebarGroupLabel>管理</SidebarGroupLabel>
            <SidebarMenu>{NAV_ADMIN.map((item) => renderItem(item))}</SidebarMenu>
          </SidebarGroup>
        )}
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
