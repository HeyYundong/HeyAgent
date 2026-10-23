import { defineConfig } from "vitest/config"

// 浏览器提速的真模型基准（花钱）：只用 scripts/speed-bench.sh 在 worker 镜像的容器里跑
export default defineConfig({
  resolve: { conditions: ["@heyagent/source"] },
  ssr: { resolve: { conditions: ["@heyagent/source"] } },
  test: {
    include: ["test-browser/speed/**/*.bench.ts"],
    fileParallelism: false,
    testTimeout: 40 * 60_000,
    hookTimeout: 180_000,
  },
})
