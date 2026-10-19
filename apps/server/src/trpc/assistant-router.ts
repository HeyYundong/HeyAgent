// 右下角助手的 tRPC 接口：本人的对话列表、一段对话的记录、删对话、改本对话的设置、默认值。发消息和应用改动是流式的，走 HTTP（/api/assistant/*，assistant/routes.ts）。
// 每个人只看得到自己的对话：别人的对话一律当作不存在（NOT_FOUND）。
import { assistantChatSchema, assistantChatSummarySchema, assistantDefaultsSchema, assistantUpdateSettingsInputSchema } from "@heyagent/shared"
import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { modelProblem, loadAssistantDefaults } from "../assistant/settings.js"
import { deleteChat, getChat, listChats, updateChatSettings } from "../assistant/store.js"
import { protectedProcedure, router } from "./init.js"

const notFound = (id: string) => new TRPCError({ code: "NOT_FOUND", message: `找不到对话 ${id}` })

export const assistantRouter = router({
  /** 本人最近的对话（最多 ASSISTANT_MAX_CHATS 段），新的在前 */
  chats: protectedProcedure.output(z.array(assistantChatSummarySchema)).query(({ ctx }) => listChats(ctx.db, ctx.user.id)),
  /** 一段对话：面板上显示的记录（由消息历史和改动确认卡拼出来）；不是本人的回 NOT_FOUND */
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .output(assistantChatSchema)
    .query(async ({ ctx, input }) => {
      const chat = await getChat(ctx.db, ctx.user.id, input.id)
      if (!chat) throw notFound(input.id)
      return chat
    }),
  delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }): Promise<{ id: string }> => {
    if (!(await deleteChat(ctx.db, ctx.user.id, input.id))) throw notFound(input.id)
    return { id: input.id }
  }),
  /** 本对话的设置（模型、上限；null = 跟默认走），整份替换；只能改自己的对话。下一次请求起生效 */
  updateSettings: protectedProcedure
    .input(assistantUpdateSettingsInputSchema)
    .output(assistantChatSummarySchema)
    .mutation(async ({ ctx, input }) => {
      const { id, ...settings } = input
      const problem = settings.modelId ? await modelProblem(ctx.db, settings.modelId) : undefined
      if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem })
      const chat = await updateChatSettings(ctx.db, ctx.user.id, id, settings)
      if (!chat) throw notFound(id)
      return chat
    }),
  /** 本对话没单独设时实际会用的模型和上限；任何登录的人都能读 */
  defaults: protectedProcedure.output(assistantDefaultsSchema).query(({ ctx }) => loadAssistantDefaults(ctx.db)),
})
