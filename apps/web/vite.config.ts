import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defaultClientConditions, defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
    // @heyagent/shared 用 @heyagent/source 条件直接引用源码（和 tsconfig.app.json 的 customConditions 对应）。
    // 写了 conditions 会替换掉 Vite 的默认值，所以要把默认的条件接在后面
    conditions: ["@heyagent/source", ...defaultClientConditions],
  },
  // 开发服务器：监听所有网卡，内网其他电脑可以用 http://<本机IP>:5180 访问；/api 交给本机 3100 的 API。
  // ws: true：远程画面（GET /api/browser/view/:id）是 WebSocket，也要转过去
  // 并行开发时各包用自己的端口（docs/dev/m1.md）：WEB_PORT=5181 API_PORT=3102 pnpm --filter @heyagent/web dev
  server: {
    host: "0.0.0.0",
    port: Number(process.env.WEB_PORT ?? 5180),
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${process.env.API_PORT ?? 3100}`, changeOrigin: false, ws: true },
    },
  },
})
