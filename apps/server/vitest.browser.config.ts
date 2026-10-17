import { defineConfig } from "vitest/config"

// 真浏览器的测试（要有界面的 Chrome、Xvfb、gost）：只在 worker 镜像的容器里跑，用 scripts/browser-test.sh。
// 开发机上的 pnpm test 不包括这些（vitest.config.ts 只收 test/）。
export default defineConfig({
  resolve: { conditions: ["@heyagent/source"] },
  ssr: { resolve: { conditions: ["@heyagent/source"] } },
  test: {
    include: ["test-browser/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
