import { defineConfig } from "vitest/config"

// @heyagent/shared 的 exports 里 @heyagent/source 条件指向 src/index.ts：测试直接用 shared 的源码，不用先构建。
// 条件名带作用域，不会和第三方包自己的 source 条件（例如 eventsource-parser 指向它的 .ts 源码）撞上
export default defineConfig({
  resolve: { conditions: ["@heyagent/source"] },
  ssr: { resolve: { conditions: ["@heyagent/source"] } },
  test: {
    include: ["test/**/*.test.ts"],
    // 测试共用一个真实的测试库（heyagent_test），不能并行
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
