import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    include: ["test/**/*.test.ts"],
    // 测试共用一个真实的测试库（heyagent_test），不能并行
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
