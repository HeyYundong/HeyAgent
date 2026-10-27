import { defineConfig } from "vitest/config"

// 真模型基准（花钱）：浏览器提速、固化，只用 scripts/speed-bench.sh 在 worker 镜像的容器里跑
export default defineConfig({
  resolve: { conditions: ["@heyagent/source"] },
  ssr: { resolve: { conditions: ["@heyagent/source"] } },
  test: {
    // SPEED_FILE 选跑哪个基准：speed（浏览器提速，默认）/ routine（固化，docs/dev/solidify.md）
    include: [`test-browser/speed/${process.env.SPEED_FILE ?? "speed"}.bench.ts`],
    fileParallelism: false,
    testTimeout: 40 * 60_000,
    hookTimeout: 180_000,
  },
})
