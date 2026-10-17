// tRPC 路由：页面要的数据都在这里（m0 全部只读、都要求登录）。「页面 → 接口 → 返回形状」见 docs/dev/m0-api.md。
// 每个接口都用 shared 里的 zod schema 校验输出，保证返回形状和契约一致。
import { tracked, TRPCError } from "@trpc/server"
import { z } from "zod"
import {
  browserProfileSchema,
  changeEventSchema,
  humanItemSchema,
  humanTodoSchema,
  mcpServerSchema,
  meSchema,
  memorySchema,
  modelDefaultsSchema,
  modelProviderSchema,
  platformSchema,
  ruleSchema,
  savedSecretSchema,
  sessionRunSchema,
  skillSchema,
  staffSchema,
  taskSchema,
  toolSchema,
} from "@heyagent/shared"

import * as load from "../data/loaders.js"
import { protectedProcedure, router } from "./init.js"
import { engineRouter } from "./engine-router.js"

const idInput = z.object({ id: z.string().min(1) })

const notFound = (what: string, id: string) => new TRPCError({ code: "NOT_FOUND", message: `找不到${what} ${id}` })

export const appRouter = router({
  me: router({
    /** 当前登录的人 + 侧边栏「待办」数字 */
    get: protectedProcedure.output(meSchema).query(async ({ ctx }) => {
      const me = await load.loadMe(ctx.db, ctx.user.id)
      if (!me) throw notFound("用户", ctx.user.id)
      return me
    }),
  }),

  staff: router({
    /** 全部的人（原型 staff），用来显示名字 */
    list: protectedProcedure.output(z.array(staffSchema)).query(({ ctx }) => load.listStaff(ctx.db)),
  }),

  platforms: router({
    list: protectedProcedure.output(z.array(platformSchema)).query(({ ctx }) => load.listPlatforms(ctx.db)),
  }),

  tasks: router({
    list: protectedProcedure.output(z.array(taskSchema)).query(({ ctx }) => load.listTasks(ctx.db)),
    get: protectedProcedure
      .input(idInput)
      .output(taskSchema)
      .query(async ({ ctx, input }) => {
        const [task] = await load.listTasks(ctx.db, [input.id])
        if (!task) throw notFound("任务", input.id)
        return task
      }),
  }),

  sessions: router({
    /** 全部 session（新的在前），带检查点、全部过程、在等什么、验收。可以按任务筛 */
    list: protectedProcedure
      .input(z.object({ taskId: z.string().optional() }).optional())
      .output(z.array(sessionRunSchema))
      .query(({ ctx, input }) => load.listSessions(ctx.db, { taskId: input?.taskId })),
    get: protectedProcedure
      .input(idInput)
      .output(sessionRunSchema)
      .query(async ({ ctx, input }) => {
        const [run] = await load.listSessions(ctx.db, { ids: [input.id] })
        if (!run) throw notFound("session", input.id)
        return run
      }),
  }),

  todos: router({
    /** 看板要的「要人办的事」（还没处理的）和「人加的待办」；运行卡用 sessions.list + shared 的 boardCards 拼 */
    board: protectedProcedure
      .output(z.object({ humanItems: z.array(humanItemSchema), humanTodos: z.array(humanTodoSchema) }))
      .query(async ({ ctx }) => {
        const [humanItems, humanTodos] = await Promise.all([load.listOpenHumanItems(ctx.db), load.listActiveTodos(ctx.db)])
        return { humanItems, humanTodos }
      }),
  }),

  memories: router({
    /** 全部记忆（含已拒绝、已归档；页面自己只显示生效和待审核的） */
    list: protectedProcedure.output(z.array(memorySchema)).query(({ ctx }) => load.listMemories(ctx.db)),
  }),

  skills: router({
    list: protectedProcedure.output(z.array(skillSchema)).query(({ ctx }) => load.listSkills(ctx.db)),
  }),

  rules: router({
    list: protectedProcedure.output(z.array(ruleSchema)).query(({ ctx }) => load.listRules(ctx.db)),
  }),

  tools: router({
    /** 工具、MCP 服务器、已存的密钥（只有名字和谁存的） */
    list: protectedProcedure
      .output(z.object({ tools: z.array(toolSchema), mcpServers: z.array(mcpServerSchema), savedSecrets: z.record(z.string(), savedSecretSchema) }))
      .query(({ ctx }) => load.listTools(ctx.db)),
  }),

  browsers: router({
    list: protectedProcedure.output(z.array(browserProfileSchema)).query(({ ctx }) => load.listBrowsers(ctx.db)),
  }),

  models: router({
    overview: protectedProcedure
      .output(z.object({ providers: z.array(modelProviderSchema), defaults: modelDefaultsSchema }))
      .query(({ ctx }) => load.loadModels(ctx.db)),
  }),

  /** 引擎相关（M1 包 P1）：立即运行、取消、处理要人办的事、附件和产物、通知等 */
  engine: engineRouter,

  live: router({
    /**
     * 实时推送（SSE）：哪张表的哪一行变了。tracked(id) 支持断线续传：
     * 客户端（httpSubscriptionLink）重连时自动带上最后收到的 id，服务端补发漏掉的。
     */
    onChange: protectedProcedure
      .input(z.object({ lastEventId: z.string().nullish() }).optional())
      .subscription(async function* ({ ctx, input, signal }) {
        for await (const item of ctx.hub.subscribe(input?.lastEventId, signal)) {
          yield tracked(item.id, changeEventSchema.parse(item.change))
        }
      }),
  }),
})

export type AppRouter = typeof appRouter
