// 导入的 tRPC 接口（只有主管能用）。上传 zip 走 HTTP：POST /api/imports（imports/routes.ts），返回一条导入记录。
// 输入、输出都用 shared/imports.ts 的 schema 校验；具体逻辑在 imports/*.ts，这里只做接线。
import {
  importAttachMcpToolsInputSchema,
  importCompileRuleInputSchema,
  importDetailSchema,
  importRecordSchema,
  importRereadInputSchema,
  importSavePlanInputSchema,
  importSetSecretInputSchema,
  planRuleSchema,
} from "@heyagent/shared"
import { z } from "zod"

import { commitImport } from "../imports/commit.js"
import {
  abandonImport,
  attachMcpTools,
  compileImportRule,
  getImport,
  listImports,
  rereadImport,
  saveImportPlan,
  setImportSecret,
  stopImport,
} from "../imports/service.js"
import { undoImport } from "../imports/undo.js"
import { protectedProcedure, router, type Context, type SessionUser } from "./init.js"

const idInput = z.object({ id: z.string().min(1) })

type AuthedContext = Context & { user: SessionUser }
const w = (ctx: AuthedContext) => ({ db: ctx.db, actor: ctx.user, keyring: ctx.keyring })

export const importsRouter = router({
  /** 左边的导入记录，新的在前 */
  list: protectedProcedure.output(z.array(importRecordSchema)).query(({ ctx }) => listImports(w(ctx))),
  /** 一次导入的全部：读包过程、方案、确认到哪一步、导入结果、还要人做的事 */
  get: protectedProcedure
    .input(idInput)
    .output(importDetailSchema)
    .query(({ ctx, input }) => getImport(w(ctx), input.id)),
  /** 确认时的改动（方案、步骤）随时存 */
  savePlan: protectedProcedure.input(importSavePlanInputSchema).mutation(({ ctx, input }) => saveImportPlan(w(ctx), input)),
  /** 确认时填密钥的值（只进不出） */
  setSecret: protectedProcedure.input(importSetSecretInputSchema).mutation(({ ctx, input }) => setImportSecret(w(ctx), input)),
  /** 改过文字的新规则重新翻译，结果写回方案 */
  compileRule: protectedProcedure
    .input(importCompileRuleInputSchema)
    .output(planRuleSchema)
    .mutation(({ ctx, input }) => compileImportRule(w(ctx), input)),
  /** 导入：按方案一次建好；返回更新后的导入记录 */
  commit: protectedProcedure
    .input(idInput)
    .output(importDetailSchema)
    .mutation(async ({ ctx, input }) => {
      await commitImport(w(ctx), input.id)
      return getImport(w(ctx), input.id)
    }),
  /** 撤销这次导入：删掉新建的（跑过的任务只停用），用的已有配置不动 */
  undo: protectedProcedure
    .input(idInput)
    .output(importDetailSchema)
    .mutation(async ({ ctx, input }) => {
      await undoImport(w(ctx), input.id)
      return getImport(w(ctx), input.id)
    }),
  /** 放弃（还没导入的）：删掉记录、上传的包和挪出来的密钥 */
  abandon: protectedProcedure.input(idInput).mutation(({ ctx, input }) => abandonImport(w(ctx), input.id)),
  /** 停止读包 */
  stop: protectedProcedure.input(idInput).mutation(({ ctx, input }) => stopImport(w(ctx), input.id)),
  /** 重新读包（方案作废），可以换模型、补一句说明 */
  reread: protectedProcedure.input(importRereadInputSchema).mutation(({ ctx, input }) => rereadImport(w(ctx), input)),
  /** 导入后：把 MCP 服务器读到的工具选进方案里用它的任务 */
  attachMcpTools: protectedProcedure.input(importAttachMcpToolsInputSchema).mutation(({ ctx, input }) => attachMcpTools(w(ctx), input)),
})
