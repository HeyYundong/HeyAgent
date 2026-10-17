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
    // eventsource-parser（ai 的依赖）也有 source 条件，指向它自己的 .ts 源码；交给 vite 转译，否则 Node 不肯剥 node_modules 里的类型
    server: {
      deps: {
        inline: [
          /eventsource-parser/,
          /@ai-sdk[\\/]/,
          /@openrouter[\\/]/,
          /node_modules[\\/]ai[\\/]/,
        ],
      },
    },
  },
})
