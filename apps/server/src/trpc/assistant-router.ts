// 右下角助手的 tRPC 接口：本人的对话列表、一段对话的记录、删对话。发消息和应用改动是流式的，走 HTTP（/api/assistant/*，assistant/routes.ts）。
// 每个人只看得到自己的对话：别人的对话一律当作不存在（NOT_FOUND）。
import { assistantChatSchema, assistantChatSummarySchema } from "@heyagent/shared"
import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { deleteChat, getChat, listChats } from "../assistant/store.js"
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
})
