import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { queryClient } from "@/lib/trpc"

// 默认暗色，浅色可选（顶栏按钮或 D 键切换，选择会记住）。
// 评审 / 截图用：?theme=dark 或 ?theme=light 指定主题
const themeParam = new URLSearchParams(window.location.search).get("theme")
if (themeParam === "dark" || themeParam === "light") {
  localStorage.setItem("theme", themeParam)
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="dark">
        <App />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
)
