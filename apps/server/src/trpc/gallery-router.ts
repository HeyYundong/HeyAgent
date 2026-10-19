// 图库（控制台页面用）和 API 密钥（设置页用）的 tRPC 接口。传图、上传一张图来搜在 HTTP 接口（gallery/routes.ts），这里只有不带文件的。
import {
  apiKeyCreatedSchema,
  apiKeyCreateSchema,
  apiKeySchema,
  galleryEmbeddingSchema,
  galleryImageSchema,
  galleryListInputSchema,
  galleryPageSchema,
  galleryStatsSchema,
  galleryTagCountSchema,
  galleryUpdateSchema,
} from "@heyagent/shared"
import { z } from "zod"

import * as apiKeys from "../data/config/api-keys.js"
import { GalleryError } from "../gallery/errors.js"
import { deleteImage, deleteImages, galleryStats, galleryTags, getImage, imageEmbedding, searchImages, updateImage, type GalleryActor } from "../gallery/service.js"
import { protectedProcedure, router, type Context, type SessionUser } from "./init.js"

const idInput = z.object({ id: z.string().min(1) })
/** 图片墙上一次最多删多少张 */
const idsInput = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) })

type AuthedContext = Context & { user: SessionUser }

const actorOf = (ctx: AuthedContext): GalleryActor => ({ user: ctx.user, via: "web" })

/** 图库的错误换成 tRPC 的错误码（message 原样给页面看） */
async function translate<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof GalleryError) throw error.toTRPC()
    throw error
  }
}

export const galleryRouter = router({
  /** 满屏图片墙：按上传时间倒序翻页；similarTo（找相似）或 query（按描述找）时按相似度排 */
  list: protectedProcedure
    .input(galleryListInputSchema)
    .output(galleryPageSchema)
    .query(({ ctx, input }) =>
      translate(() => {
        const { similarTo, ...rest } = input
        return searchImages(ctx.db, { ...rest, image: similarTo ? { imageId: similarTo } : undefined })
      })
    ),
  get: protectedProcedure
    .input(idInput)
    .output(galleryImageSchema)
    .query(({ ctx, input }) => translate(() => getImage(ctx.db, input.id))),
  /** 抽屉最下面的向量（1024 个数，只在点开一张图时取，不放进 get 和列表） */
  embedding: protectedProcedure
    .input(idInput)
    .output(galleryEmbeddingSchema.nullable())
    .query(({ ctx, input }) => translate(() => imageEmbedding(ctx.db, input.id))),
  stats: protectedProcedure.output(galleryStatsSchema).query(({ ctx }) => galleryStats(ctx.db)),
  tags: protectedProcedure.output(z.array(galleryTagCountSchema)).query(({ ctx }) => galleryTags(ctx.db)),
  update: protectedProcedure
    .input(galleryUpdateSchema)
    .output(galleryImageSchema)
    .mutation(({ ctx, input }) => translate(() => updateImage(ctx.db, actorOf(ctx), input))),
  delete: protectedProcedure.input(idInput).mutation(({ ctx, input }) => translate(() => deleteImage(ctx.db, actorOf(ctx), input.id))),
  /** 图片墙上选中的一起删；有一张没权限就整批不删 */
  deleteMany: protectedProcedure.input(idsInput).mutation(({ ctx, input }) => translate(() => deleteImages(ctx.db, actorOf(ctx), input.ids))),
})

const w = (ctx: AuthedContext) => ({ db: ctx.db, actor: ctx.user, keyring: ctx.keyring })

export const apiKeysRouter = router({
  /** 只有主管：名字、尾号、谁建的、最近用过的时间 */
  list: protectedProcedure.output(z.array(apiKeySchema)).query(({ ctx }) => apiKeys.listApiKeys(w(ctx))),
  /** 原文只在这次返回 */
  create: protectedProcedure.input(apiKeyCreateSchema).output(apiKeyCreatedSchema).mutation(({ ctx, input }) => apiKeys.createApiKey(w(ctx), input)),
  delete: protectedProcedure.input(idInput).mutation(({ ctx, input }) => apiKeys.deleteApiKey(w(ctx), input)),
})
