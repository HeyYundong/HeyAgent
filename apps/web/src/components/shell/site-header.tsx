import { MoonIcon, SunIcon } from "lucide-react"

import { NAV_ALL } from "@/components/shell/app-sidebar"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useRoute } from "@/lib/router"

export function SiteHeader() {
  const { page } = useRoute()
  const current = NAV_ALL.find((item) => item.id === page)

  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger />
      <Separator orientation="vertical" className="my-3" />
      <span className="text-sm font-medium">{current?.title}</span>
      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
      </div>
    </header>
  )
}

/** 浅色 / 暗色切换。默认暗色；也可以按 d 键切换 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const isDark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  const label = isDark ? "切换到浅色" : "切换到暗色"

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={() => setTheme(isDark ? "light" : "dark")}
          />
        }
      >
        {isDark ? <SunIcon /> : <MoonIcon />}
      </TooltipTrigger>
      <TooltipContent>{label}（快捷键 D）</TooltipContent>
    </Tooltip>
  )
}
