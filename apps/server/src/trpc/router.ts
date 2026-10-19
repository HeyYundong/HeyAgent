// tRPC 路由：页面要的数据都在这里（都要求登录）。「页面 → 接口 → 返回形状」见 docs/dev/m0-api.md。
// 每个查询都用 shared 里的 zod schema 校验输出，保证返回形状和契约一致。
// M1 P2：配置的写操作（mutation）加在各自的命名空间里，输入用 shared/config.ts 的 schema 校验，
// 权限用 can()，每次写都记 audit_events。具体逻辑在 data/config/*.ts，这里只做接线。
import { tracked, TRPCError } from "@trpc/server"
import { z } from "zod"
import {
  browserAccountInputSchema,
  browserAccountUpdateSchema,
  browserProfileInputSchema,
  browserProfileSchema,
  browserProfileUpdateSchema,
  changeEventSchema,
  changePasswordSchema,
  digestReviewInputSchema,
  digestSessionInputSchema,
  httpToolInputSchema,
  httpToolRestoreSchema,
  httpToolUpdateSchema,
  humanItemSchema,
  humanTodoSchema,
  mcpServerInputSchema,
  mcpServerSchema,
  mcpServerUpdateSchema,
  meSchema,
  memoryInputSchema,
  memorySchema,
  memoryUpdateSchema,
  modelDefaultsInputSchema,
  modelDefaultsSchema,
  modelProviderSchema,
  notifyChannelInputSchema,
  platformInputSchema,
  platformSchema,
  platformUpdateSchema,
  providerCheckSchema,
  providerInputSchema,
  providerUpdateSchema,
  reviewInputSchema,
  ruleCompileInputSchema,
  ruleCompileResultSchema,
  ruleConfirmInputSchema,
  ruleInputSchema,
  ruleRestoreSchema,
  ruleSchema,
  ruleUpdateSchema,
  savedSecretSchema,
  secretInputSchema,
  secretNameSchema,
  saveStepsFromSessionInputSchema,
  sessionDigestSchema,
  sessionRunSchema,
  sessionSummarySchema,
  settingsAgentInputSchema,
  settingsBrowserInputSchema,
  settingsDispatchInputSchema,
  settingsAssistantInputSchema,
  settingsLimitsInputSchema,
  settingsViewSchema,
  skillInputSchema,
  skillSchema,
  skillSetStatusSchema,
  skillUpdateSchema,
  staffSchema,
  taskInputSchema,
  taskMemoryAddSchema,
  taskMemoryDeleteSchema,
  taskMemoryEntrySchema,
  taskMemoryListSchema,
  taskMemoryUpdateSchema,
  taskSchema,
  taskSetEnabledSchema,
  taskStepSchema,
  taskUpdateSchema,
  todoInputSchema,
  todoUpdateSchema,
  toolSchema,
  userAccountSchema,
  userCreateSchema,
  userResetPasswordSchema,
  userSetDisabledSchema,
  userUpdateSchema,
} from "@heyagent/shared"

import * as browsers from "../data/config/browsers.js"
import type { WriteCtx } from "../data/config/common.js"
import * as memories from "../data/config/memories.js"
import * as models from "../data/config/models.js"
import * as rules from "../data/config/rules.js"
import * as settings from "../data/config/settings.js"
import * as skills from "../data/config/skills.js"
import * as taskMemory from "../data/config/task-memory.js"
import * as tasks from "../data/config/tasks.js"
import * as todos from "../data/config/todos.js"
import * as tools from "../data/config/tools.js"
import * as users from "../data/config/users.js"
import * as load from "../data/loaders.js"
import { protectedProcedure, router, type Context, type SessionUser } from "./init.js"
import { browserRouter } from "./browser-router.js"
import { engineRouter } from "./engine-router.js"
import { apiKeysRouter, galleryRouter } from "./gallery-router.js"
import { compareRouter } from "./compare-router.js"
import { workRouter } from "./work-router.js"
import { importsRouter } from "./imports-router.js"
import { assistantRouter } from "./assistant-router.js"

const idInput = z.object({ id: z.string().min(1) })

const notFound = (what: string, id: string) => new TRPCError({ code: "NOT_FOUND", message: `找不到${what} ${id}` })

type AuthedContext = Context & { user: SessionUser }

/** 写操作要的上下文：谁在做、库、主密钥 */
const w = (ctx: AuthedContext): WriteCtx => ({ db: ctx.db, actor: ctx.user, keyring: ctx.keyring })
/** 账号相关的写操作还要 better-auth 和请求头（它按 cookie 认人） */
const wa = (ctx: AuthedContext): users.AuthCtx => ({ ...w(ctx), auth: ctx.auth, headers: ctx.headers })

export const appRouter = router({
  me: router({
    /** 当前登录的人 + 侧边栏「待办」数字 */
    get: protectedProcedure.output(meSchema).query(async ({ ctx }) => {
      const me = await load.loadMe(ctx.db, ctx.user.id)
      if (!me) throw notFound("用户", ctx.user.id)
      return me
    }),
    /** 改自己的密码 */
    changePassword: protectedProcedure.input(changePasswordSchema).mutation(({ ctx, input }) => users.changeOwnPassword(wa(ctx), input)),
  }),

  users: router({
    /** 用户管理（只有主管）：带邮箱、是否停用 */
    list: protectedProcedure.output(z.array(userAccountSchema)).query(({ ctx }) => users.listUsers(w(ctx))),
    create: protectedProcedure.input(userCreateSchema).mutation(({ ctx, input }) => users.createUser(wa(ctx), input)),
    update: protectedProcedure.input(userUpdateSchema).mutation(({ ctx, input }) => users.updateUser(wa(ctx), input)),
    setDisabled: protectedProcedure.input(userSetDisabledSchema).mutation(({ ctx, input }) => users.setUserDisabled(wa(ctx), input)),
    resetPassword: protectedProcedure.input(userResetPasswordSchema).mutation(({ ctx, input }) => users.resetUserPassword(wa(ctx), input)),
  }),

  staff: router({
    /** 全部的人（原型 staff），用来显示名字 */
    list: protectedProcedure.output(z.array(staffSchema)).query(({ ctx }) => load.listStaff(ctx.db)),
  }),

  platforms: router({
    list: protectedProcedure.output(z.array(platformSchema)).query(({ ctx }) => load.listPlatforms(ctx.db)),
    create: protectedProcedure.input(platformInputSchema).mutation(({ ctx, input }) => browsers.createPlatform(w(ctx), input)),
    /** M2：改名字和域名 */
    update: protectedProcedure.input(platformUpdateSchema).mutation(({ ctx, input }) => browsers.updatePlatform(w(ctx), input)),
    delete: protectedProcedure.input(idInput).mutation(({ ctx, input }) => browsers.deletePlatform(w(ctx), input)),
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
    create: protectedProcedure.input(taskInputSchema).mutation(({ ctx, input }) => tasks.createTask(w(ctx), input)),
    update: protectedProcedure.input(taskUpdateSchema).mutation(({ ctx, input }) => tasks.updateTask(w(ctx), input)),
    setEnabled: protectedProcedure.input(taskSetEnabledSchema).mutation(({ ctx, input }) => tasks.setTaskEnabled(w(ctx), input)),
    /** 有运行记录的不能删，只能停用 */
    delete: protectedProcedure.input(idInput).mutation(({ ctx, input }) => tasks.deleteTask(w(ctx), input)),
    /** M3：把一次运行里 agent 写下的步骤（plan.set）存成任务的步骤（整体覆盖），负责人或主管 */
    saveStepsFromSession: protectedProcedure
      .input(saveStepsFromSessionInputSchema)
      .output(z.object({ id: z.string(), steps: z.array(taskStepSchema) }))
      .mutation(({ ctx, input }) => tasks.saveStepsFromSession(w(ctx), input)),
  }),

  /**
   * 任务记忆：每个任务自己的经验，每次运行开始时全部放进系统提示。负责人和主管能写、改、删；
   * 运行结束后可以让三方 AI 总结那次运行、提取候选（summarize），审核通过的记进来（review）
   */
  taskMemory: router({
    list: protectedProcedure.input(taskMemoryListSchema).output(z.array(taskMemoryEntrySchema)).query(({ ctx, input }) => load.listTaskMemory(ctx.db, input.taskId)),
    add: protectedProcedure.input(taskMemoryAddSchema).mutation(({ ctx, input }) => taskMemory.addTaskMemory(w(ctx), input)),
    update: protectedProcedure.input(taskMemoryUpdateSchema).mutation(({ ctx, input }) => taskMemory.updateTaskMemory(w(ctx), input)),
    delete: protectedProcedure.input(taskMemoryDeleteSchema).mutation(({ ctx, input }) => taskMemory.deleteTaskMemory(w(ctx), input)),
    /** 调三方模型（任务的验收模型或默认验收模型），只对已结束（完成或失败）的运行 */
    summarize: protectedProcedure.input(digestSessionInputSchema).output(sessionDigestSchema).mutation(({ ctx, input }) => taskMemory.summarizeSession(w(ctx), input)),
    review: protectedProcedure
      .input(digestReviewInputSchema)
      .output(z.object({ accepted: z.number().int(), rejected: z.number().int() }))
      .mutation(({ ctx, input }) => taskMemory.reviewDigest(w(ctx), input)),
  }),

  sessions: router({
    /** 全部 session（新的在前）的摘要：检查点、在等什么、验收，过程只有条数、最后一条等几样（不带过程，页面一直开着、实时刷新也不重）。可以按任务筛 */
    list: protectedProcedure
      .input(z.object({ taskId: z.string().optional() }).optional())
      .output(z.array(sessionSummarySchema))
      .query(({ ctx, input }) => load.listSessions(ctx.db, { taskId: input?.taskId })),
    /** 一个 session 的全部，带全部过程（工具的输入、输出）：运行详情里看过程时才取 */
    get: protectedProcedure
      .input(idInput)
      .output(sessionRunSchema)
      .query(async ({ ctx, input }) => {
        const run = await load.loadSession(ctx.db, input.id)
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
    /** 人加的待办：新建、修改、删除（保存后调引擎的 syncTodo） */
    create: protectedProcedure.input(todoInputSchema).mutation(({ ctx, input }) => todos.createTodo(w(ctx), input)),
    update: protectedProcedure.input(todoUpdateSchema).mutation(({ ctx, input }) => todos.updateTodo(w(ctx), input)),
    delete: protectedProcedure.input(idInput).mutation(({ ctx, input }) => todos.deleteTodo(w(ctx), input)),
  }),

  memories: router({
    /** 全部记忆（含已拒绝、已归档；页面自己只显示生效和待审核的） */
    list: protectedProcedure.output(z.array(memorySchema)).query(({ ctx }) => load.listMemories(ctx.db)),
    create: protectedProcedure.input(memoryInputSchema).mutation(({ ctx, input }) => memories.createMemory(w(ctx), input)),
    update: protectedProcedure.input(memoryUpdateSchema).mutation(({ ctx, input }) => memories.updateMemory(w(ctx), input)),
    /** agent 提议的记忆：审核人批准 / 拒绝（同时处理掉待办里那件事） */
    approve: protectedProcedure.input(idInput).mutation(({ ctx, input }) => memories.approveMemory(w(ctx), input)),
    reject: protectedProcedure.input(reviewInputSchema).mutation(({ ctx, input }) => memories.rejectMemory(w(ctx), input)),
    archive: protectedProcedure.input(idInput).mutation(({ ctx, input }) => memories.archiveMemory(w(ctx), input)),
    /** 被任务选用着的不能删 */
    delete: protectedProcedure.input(idInput).mutation(({ ctx, input }) => memories.deleteMemory(w(ctx), input)),
  }),

  skills: router({
    list: protectedProcedure.output(z.array(skillSchema)).query(({ ctx }) => load.listSkills(ctx.db)),
    create: protectedProcedure.input(skillInputSchema).mutation(({ ctx, input }) => skills.createSkill(w(ctx), input)),
    /** 每次保存出一个新版本（写进 skill_versions） */
    update: protectedProcedure.input(skillUpdateSchema).mutation(({ ctx, input }) => skills.updateSkill(w(ctx), input)),
    setStatus: protectedProcedure.input(skillSetStatusSchema).mutation(({ ctx, input }) => skills.setSkillStatus(w(ctx), input)),
    /** agent 提的修改建议：批准（合并成新一版）/ 拒绝。id 是技能 id */
    acceptSuggestion: protectedProcedure.input(idInput).mutation(({ ctx, input }) => skills.acceptSkillSuggestion(w(ctx), input)),
    rejectSuggestion: protectedProcedure.input(reviewInputSchema).mutation(({ ctx, input }) => skills.rejectSkillSuggestion(w(ctx), input)),
  }),

  rules: router({
    list: protectedProcedure.output(z.array(ruleSchema)).query(({ ctx }) => load.listRules(ctx.db)),
    create: protectedProcedure.input(ruleInputSchema).mutation(({ ctx, input }) => rules.createRule(w(ctx), input)),
    update: protectedProcedure.input(ruleUpdateSchema).mutation(({ ctx, input }) => rules.updateRule(w(ctx), input)),
    /** 被任务用着的不能删；返回删掉的规则，页面上「撤销」时交给 restore */
    delete: protectedProcedure.input(idInput).output(ruleSchema).mutation(({ ctx, input }) => rules.deleteRule(w(ctx), input)),
    restore: protectedProcedure.input(ruleRestoreSchema).mutation(({ ctx, input }) => rules.restoreRule(w(ctx), input)),
    /** M3：翻译（给 id：翻译这条规则现在的文字，存成待确认；只给文字：预览不存）。调模型，只有主管 */
    compile: protectedProcedure.input(ruleCompileInputSchema).output(ruleCompileResultSchema).mutation(({ ctx, input }) => rules.compileRule(w(ctx), input)),
    /** M3：确认「系统理解为……」，规则生效 */
    confirm: protectedProcedure
      .input(ruleConfirmInputSchema)
      .output(z.object({ id: z.string(), understood: z.string() }))
      .mutation(({ ctx, input }) => rules.confirmRule(w(ctx), input)),
  }),

  tools: router({
    /** 工具、MCP 服务器、已存的密钥（只有名字和谁存的） */
    list: protectedProcedure
      .output(z.object({ tools: z.array(toolSchema), mcpServers: z.array(mcpServerSchema), savedSecrets: z.record(z.string(), savedSecretSchema) }))
      .query(({ ctx }) => load.listTools(ctx.db)),
    // HTTP 接口：模板里有明文密钥就拒绝保存
    createHttp: protectedProcedure.input(httpToolInputSchema).mutation(({ ctx, input }) => tools.createHttpTool(w(ctx), input)),
    updateHttp: protectedProcedure.input(httpToolUpdateSchema).mutation(({ ctx, input }) => tools.updateHttpTool(w(ctx), input)),
    deleteHttp: protectedProcedure.input(idInput).output(toolSchema).mutation(({ ctx, input }) => tools.deleteHttpTool(w(ctx), input)),
    restoreHttp: protectedProcedure.input(httpToolRestoreSchema).mutation(({ ctx, input }) => tools.restoreHttpTool(w(ctx), input)),
    // 全局密钥（模板里的 {{名字}}）：值只进不出
    createSecret: protectedProcedure.input(secretInputSchema).mutation(({ ctx, input }) => tools.createSecret(w(ctx), input)),
    updateSecret: protectedProcedure.input(secretInputSchema).mutation(({ ctx, input }) => tools.updateSecretValue(w(ctx), input)),
    deleteSecret: protectedProcedure.input(z.object({ name: secretNameSchema })).mutation(({ ctx, input }) => tools.removeSecret(w(ctx), input)),
    // MCP 服务器：「连接并读取工具」走 engine.listMcpServerTools，勾选的工具通过 tools 字段传进来
    createMcpServer: protectedProcedure.input(mcpServerInputSchema).mutation(({ ctx, input }) => tools.createMcpServer(w(ctx), input)),
    updateMcpServer: protectedProcedure.input(mcpServerUpdateSchema).mutation(({ ctx, input }) => tools.updateMcpServer(w(ctx), input)),
    deleteMcpServer: protectedProcedure.input(idInput).mutation(({ ctx, input }) => tools.deleteMcpServer(w(ctx), input)),
  }),

  browsers: router({
    list: protectedProcedure.output(z.array(browserProfileSchema)).query(({ ctx }) => load.listBrowsers(ctx.db)),
    create: protectedProcedure.input(browserProfileInputSchema).mutation(({ ctx, input }) => browsers.createBrowserProfile(w(ctx), input)),
    update: protectedProcedure.input(browserProfileUpdateSchema).mutation(({ ctx, input }) => browsers.updateBrowserProfile(w(ctx), input)),
    delete: protectedProcedure.input(idInput).mutation(({ ctx, input }) => browsers.deleteBrowserProfile(w(ctx), input)),
    createAccount: protectedProcedure.input(browserAccountInputSchema).mutation(({ ctx, input }) => browsers.createBrowserAccount(w(ctx), input)),
    updateAccount: protectedProcedure.input(browserAccountUpdateSchema).mutation(({ ctx, input }) => browsers.updateBrowserAccount(w(ctx), input)),
    deleteAccount: protectedProcedure.input(idInput).mutation(({ ctx, input }) => browsers.deleteBrowserAccount(w(ctx), input)),
  }),

  models: router({
    overview: protectedProcedure
      .output(z.object({ providers: z.array(modelProviderSchema), defaults: modelDefaultsSchema }))
      .query(({ ctx }) => load.loadModels(ctx.db)),
    /** 加模型服务：先连一次（读模型列表、核对 key），连上了才存 */
    createProvider: protectedProcedure.input(providerInputSchema).mutation(({ ctx, input }) => models.createProvider(w(ctx), input)),
    updateProvider: protectedProcedure.input(providerUpdateSchema).mutation(({ ctx, input }) => models.updateProvider(w(ctx), input)),
    deleteProvider: protectedProcedure.input(idInput).mutation(({ ctx, input }) => models.deleteProvider(w(ctx), input)),
    testProvider: protectedProcedure.input(idInput).output(providerCheckSchema).mutation(({ ctx, input }) => models.testProvider(w(ctx), input)),
    /** 从服务的公开模型列表刷新（OpenRouter：GET /models，不用 key） */
    refreshProvider: protectedProcedure.input(idInput).output(providerCheckSchema).mutation(({ ctx, input }) => models.refreshProviderAsActor(w(ctx), input)),
    /** 三个角色的默认模型：验收不许和执行同一家 */
    setDefaults: protectedProcedure.input(modelDefaultsInputSchema).mutation(({ ctx, input }) => models.setModelDefaults(w(ctx), input)),
  }),

  settings: router({
    /** 全局设置（只有主管）：令牌只给尾号，渠道地址只给掩码 */
    get: protectedProcedure.output(settingsViewSchema).query(({ ctx }) => settings.getSettings(w(ctx))),
    updateLimits: protectedProcedure.input(settingsLimitsInputSchema).mutation(({ ctx, input }) => settings.updateLimits(w(ctx), input)),
    /** M2：浏览器设置（每个 worker 最多几个 Chrome、视觉判断、等人时 Chrome 保留多久） */
    updateBrowser: protectedProcedure.input(settingsBrowserInputSchema).mutation(({ ctx, input }) => settings.updateBrowserSettings(w(ctx), input)),
    /** M3：三方验收最多几轮、压缩上下文的 token 上限 */
    updateAgent: protectedProcedure.input(settingsAgentInputSchema).mutation(({ ctx, input }) => settings.updateAgentSettings(w(ctx), input)),
    /** 派活的四个上限（层数、一次运行最多派几张、一个任务每天最多被派几张、最多排队几张） */
    updateDispatch: protectedProcedure.input(settingsDispatchInputSchema).mutation(({ ctx, input }) => settings.updateDispatchSettings(w(ctx), input)),
    /** 右下角助手的两个上限（一次请求最多几步、最多花多少） */
    updateAssistant: protectedProcedure.input(settingsAssistantInputSchema).mutation(({ ctx, input }) => settings.updateAssistantSettings(w(ctx), input)),
    /** 生成新的外部事件令牌：原文只在这次返回 */
    regenerateEventToken: protectedProcedure.mutation(({ ctx }) => settings.regenerateEventToken(w(ctx))),
    clearEventToken: protectedProcedure.mutation(({ ctx }) => settings.clearEventToken(w(ctx))),
    saveChannel: protectedProcedure.input(notifyChannelInputSchema).mutation(({ ctx, input }) => settings.saveChannel(w(ctx), input)),
    deleteChannel: protectedProcedure.input(idInput).mutation(({ ctx, input }) => settings.deleteChannel(w(ctx), input)),
  }),

  /** 引擎相关（M1 包 P1）：立即运行、取消、处理要人办的事、附件和产物、通知等 */
  engine: engineRouter,

  /** 浏览器（M2）：打开 Chrome（关闭时保存登录状态）、远程画面相关 */
  browser: browserRouter,

  /** 图库：图片墙、找相似、按描述找、改文本和标签、删（传图和上传一张图来搜走 HTTP 接口 /api/gallery/*） */
  gallery: galleryRouter,

  /** API 密钥（只有主管）：外部系统调图库的 HTTP 接口和 MCP 用 */
  apiKeys: apiKeysRouter,

  /** 比物：两张图交给视觉模型按标准逐项打分（图片先走 /api/files 上传；外部系统用 /api/compare/* 和 MCP） */
  compare: compareRouter,
  /** 派活：派活单的列表、详情、名额数字，人派一张、改参数、重办、不办了（agent 用内置工具 work.dispatch） */
  work: workRouter,

  /** 导入（只有主管）：别的 agent 打的 zip 包，AI 读包整理成方案，确认后一次导入（上传 zip 走 HTTP 接口 /api/imports） */
  imports: importsRouter,

  /** 右下角助手：本人的对话列表、记录、删对话（发消息和应用改动走流式的 /api/assistant/*） */
  assistant: assistantRouter,

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
