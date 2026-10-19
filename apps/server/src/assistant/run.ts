// 助手一轮怎么跑（docs/dev/copilot.md 第 4 节、9.3 节）：
// - 一步调一次模型（AI SDK streamText，一次一步，文字边出边发给前端）；查的工具由这里执行，结果交回模型接着跑；
// - 这一步里有改的工具调用：不执行，校验、查权限后存成一张改动确认卡，这一轮停下，等人点「应用」或「不要」；
// - 人处理卡（apply）：应用就按顺序一项项执行（每项单独成败），结果交回模型接着跑；不要就告诉模型人没同意；
// - 有卡没处理又发了新消息：卡过期，它的调用回 { expired: true }，再接上新消息；
// - 一次请求（发一条消息或处理一张卡之后）最多 maxSteps 步、maxCostUsd 美元（设置页能改），到了停下发提示；
// - 断线（浏览器中止请求）就停掉模型调用，已经存下的照常保留。
// 每条 ModelMessage 原样存进 assistant_messages；面板上的记录由 store.ts 拼出来，和这里发出去的一致。
import { setTimeout as sleep } from "node:timers/promises"

import type { AssistantApplyInput, AssistantChange, AssistantChatInput, AssistantEntry, AssistantPageContext, AssistantStreamEvent } from "@heyagent/shared"
import { jsonSchema, streamText, tool, zodSchema, type ModelMessage, type ToolResultPart, type ToolSet } from "ai"
import { and, eq, sql } from "drizzle-orm"

import { readAssistantSettings } from "../data/config/settings.js"
import { runAsAssistant } from "../data/config/common.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { costOf, isRetryable, ModelConfigError, providerOptionsFor, resolveModel, type ResolvedModel } from "../engine/model.js"
import { runtime } from "../engine/runtime.js"
import type { Keyring } from "../lib/crypto.js"
import { systemPrompt } from "./prompt.js"
import {
  appendToolResults,
  chatTitle,
  createChat,
  entryIdOf,
  expireProposals,
  historyForModel,
  insertMessages,
  loadChat,
  loadMessages,
  newId,
  nextSeq,
  pendingProposals,
  proposalEntry,
  toolDetail,
  toolEntryId,
  trimChats,
  type ChatRow,
  type NoticeMessage,
  type ProposalRow,
} from "./store.js"
import { collectMissing } from "./describe.js"
import { errorText, parseToolInput, ToolError, TOOLS, type ToolCtx } from "./tools.js"

export interface AssistantActor {
  id: string
  name: string
  isAdmin: boolean
}

export interface RunDeps {
  db: Db
  actor: AssistantActor
  keyring: () => Keyring
  /** 浏览器断开时 abort：停掉模型调用 */
  signal: AbortSignal
  emit: (event: AssistantStreamEvent) => void
}

/** 给人看的错误（卡不是你的、已经处理过、对话不存在……）：路由把它作为 error 事件发出去 */
export class AssistantError extends Error {}
class Aborted extends Error {}
/** 模型调用失败（重试完还不行）：发一条 error 提示，这次请求结束 */
class ModelFailed extends Error {}

/** 一段对话同一时间只跑一个请求（seq 递增、卡的处理都靠这个），第二个直接告诉人等一下 */
const busy = new Set<string>()

async function withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(chatId)) throw new AssistantError("上一条还在处理，等它说完再发")
  busy.add(chatId)
  try {
    return await fn()
  } finally {
    busy.delete(chatId)
  }
}

/** 给模型的单个工具输出最多多少字：列表很长时截断，让它带 query 再查 */
const OUTPUT_MAX = 20_000
const clipOutput = (text: string) => (text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX)}…（太长了，截断了；带 query 筛一下再查）` : text)

const textResult = (toolCallId: string, toolName: string, value: string, isError = false): ToolResultPart => ({
  type: "tool-result",
  toolCallId,
  toolName,
  output: isError ? { type: "error-text", value } : { type: "text", value },
})

/**
 * 给模型的工具定义：都不带 execute（查的由这里执行，改的进卡）。
 * 输入的 JSON Schema 由 zod 生成，但不让 AI SDK 校验：SDK 校验会把 schema 的默认值填进去，
 * update_* 就分不清模型给了哪些字段（会把没给的数组改成空的）。校验在 parseToolInput 里做
 */
const MODEL_TOOLS: ToolSet = Object.fromEntries(
  Object.entries(TOOLS).map(([name, def]) => {
    const schema = zodSchema(def.input as Parameters<typeof zodSchema>[0])
    return [name, tool({ description: def.description, inputSchema: jsonSchema(() => schema.jsonSchema) })]
  })
)

/** 用哪个模型：这次临时换的 → 对话上次用的 → 「规划」默认模型；要是库里有的聊天模型 */
async function pickModel(db: Db, requested: string | undefined, previous: string | null): Promise<{ modelId: string } | { error: string }> {
  const usable = async (id: string) => {
    const [model] = await db.select({ id: t.models.id, kind: t.models.kind }).from(t.models).where(eq(t.models.id, id))
    if (!model) return `模型 ${id} 不存在（可能刷新模型列表后下架了），换一个`
    if (model.kind !== "chat") return `${id} 是 embedding 模型，不能对话，换一个`
    return undefined
  }
  if (requested?.trim()) {
    const problem = await usable(requested.trim())
    return problem ? { error: problem } : { modelId: requested.trim() }
  }
  // 对话上次用的模型下架了：回到 plan 默认模型
  if (previous && !(await usable(previous))) return { modelId: previous }
  const [plan] = await db.select({ modelId: t.modelDefaults.modelId }).from(t.modelDefaults).where(eq(t.modelDefaults.role, "plan"))
  if (!plan) return { error: "还没有配模型，先到模型页设 plan 默认模型" }
  const problem = await usable(plan.modelId)
  return problem ? { error: `plan 默认模型用不了：${problem}` } : { modelId: plan.modelId }
}

interface Loop {
  deps: RunDeps
  chat: ChatRow
  context?: AssistantPageContext
  /** 这次请求花的钱 */
  spent: number
  /** 下一条消息的 seq */
  seq: number
}

const now = () => new Date().toISOString()

async function notice(loop: Loop, text: string, tone: NoticeMessage["tone"] = "info") {
  const seq = loop.seq++
  await insertMessages(loop.deps.db, loop.chat.id, [{ seq, role: "notice", message: { text, tone } satisfies NoticeMessage }])
  loop.deps.emit({ type: "entry", entry: { kind: "notice", id: entryIdOf(seq), text, tone, at: now() } })
}

/** 这次请求结束：对话累加花费、记下用的模型、updated_at 往前挪；发 done */
async function finish(loop: Loop, modelId: string | null, pendingProposalId: string | null) {
  await loop.deps.db
    .update(t.assistantChats)
    .set({ costUsd: sql`${t.assistantChats.costUsd} + ${loop.spent}`, updatedAt: new Date(), ...(modelId ? { modelId } : {}) })
    .where(eq(t.assistantChats.id, loop.chat.id))
  loop.deps.emit({ type: "done", costUsd: loop.spent, pendingProposalId })
}

interface StepCall {
  toolCallId: string
  toolName: string
  input: unknown
  invalid?: boolean
  error?: unknown
}

interface StepResult {
  assistant?: ModelMessage
  calls: StepCall[]
  costUsd: number
}

/**
 * 调一步模型（流式）：文字片段边出边发 delta，查的工具一出现就发一条 running 的 tool 记录。
 * 出错时，还没发出任何东西、错误值得重试的，按退避重试（同 imports/reader.ts 的 callWithRetry）
 */
async function modelStep(loop: Loop, resolved: ResolvedModel, system: string, messages: ModelMessage[]): Promise<StepResult> {
  const { emit, signal } = loop.deps
  for (let attempt = 0; ; attempt++) {
    let emitted = false
    let textEntry: Extract<AssistantEntry, { kind: "assistant" }> | undefined
    let newBlock = false
    const calls: StepCall[] = []
    let costUsd = 0
    try {
      const result = streamText({
        model: resolved.model,
        instructions: system,
        messages,
        tools: MODEL_TOOLS,
        providerOptions: providerOptionsFor(resolved, messages),
        maxRetries: 0,
        abortSignal: signal,
        // 错误在下面的流里处理，不要 SDK 再往控制台打一遍
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "text-start") newBlock = true
        else if (part.type === "text-delta") {
          if (!part.text) continue
          emitted = true
          if (!textEntry) {
            textEntry = { kind: "assistant", id: entryIdOf(loop.seq), text: "", at: now() }
            emit({ type: "entry", entry: textEntry })
          } else if (newBlock && textEntry.text) emit({ type: "delta", id: textEntry.id, text: "\n\n" })
          newBlock = false
          textEntry.text += part.text
          emit({ type: "delta", id: textEntry.id, text: part.text })
        } else if (part.type === "tool-call") {
          const call = part as unknown as StepCall
          calls.push({ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input, invalid: call.invalid, error: call.error })
          if (TOOLS[call.toolName]?.kind === "read") {
            emitted = true
            emit({ type: "entry", entry: { kind: "tool", id: toolEntryId(call.toolCallId), tool: call.toolName, label: TOOLS[call.toolName]!.label(objectOf(call.input)), status: "running", at: now() } })
          }
        } else if (part.type === "finish-step") {
          costUsd += costOf(resolved, part.usage, part.providerMetadata).costUsd
        } else if (part.type === "error") {
          throw part.error
        } else if (part.type === "abort") {
          throw new Aborted()
        }
      }
      const response = await result.responseMessages
      const assistant = response.find((message) => message.role === "assistant") as ModelMessage | undefined
      return { assistant, calls, costUsd }
    } catch (error) {
      if (signal.aborted || error instanceof Aborted) throw new Aborted()
      const retryable = isRetryable(error)
      if (!emitted && retryable && attempt < runtime.modelRetries) {
        await sleep(runtime.modelRetryBaseMs * 2 ** attempt)
        continue
      }
      const message = errorText(error).slice(0, 300)
      throw new ModelFailed(retryable && !emitted ? `模型调用失败（已重试 ${runtime.modelRetries} 次）：${message}` : `模型调用失败：${message}`)
    }
  }
}

const objectOf = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {})

/** 执行一步里的工具调用：查的直接查；改的校验、查权限后进卡；进不了卡的错误交回模型 */
async function handleCalls(loop: Loop, calls: StepCall[]) {
  const { emit } = loop.deps
  const ctx: ToolCtx = { db: loop.deps.db, actor: { id: loop.deps.actor.id, isAdmin: loop.deps.actor.isAdmin }, keyring: loop.deps.keyring }
  const outputs: ToolResultPart[] = []
  const changes: AssistantChange[] = []
  const proposalCalls: ProposalRow["calls"] = []

  // 查的：按顺序执行，跑完把 running 的那条改成 done / error
  for (const call of calls) {
    const def = TOOLS[call.toolName]
    if (def?.kind !== "read") continue
    let text: string
    let isError = false
    const parsed = call.invalid ? ({ ok: false, error: `参数不对：${errorText(call.error)}` } as const) : parseToolInput(def, call.input)
    if (!parsed.ok) {
      text = parsed.error
      isError = true
    } else {
      try {
        text = clipOutput(JSON.stringify(await def.run(ctx, parsed.input as never)))
      } catch (error) {
        text = errorText(error)
        isError = true
      }
    }
    outputs.push(textResult(call.toolCallId, call.toolName, text, isError))
    emit({ type: "update", entry: { kind: "tool", id: toolEntryId(call.toolCallId), tool: call.toolName, label: def.label(objectOf(call.input)), status: isError ? "error" : "done", detail: toolDetail(call.input, text), at: now() } })
  }

  // 改的（和不认识的）：能进卡的进卡，进不了的一条 error 记录 + 错误交回模型
  for (const call of calls) {
    const def = TOOLS[call.toolName]
    if (def?.kind === "read") continue
    let problem: string | undefined
    if (!def) problem = `没有叫 ${call.toolName} 的工具`
    else if (call.invalid) problem = `参数不对：${errorText(call.error)}`
    else {
      const parsed = parseToolInput(def, call.input)
      if (!parsed.ok) problem = parsed.error
      else {
        try {
          const { value: prepared, missing } = await collectMissing(() => def.prepare(ctx, parsed.input as never, parsed.given))
          loop.spent += prepared.costUsd ?? 0
          if (missing.length > 0) throw new ToolError(`找不到：${missing.join("、")}。先用 list_* 查到正确的编号再调`)
          changes.push({ callId: call.toolCallId, tool: call.toolName, title: prepared.title, fields: prepared.fields, destructive: Boolean(def.destructive) })
          proposalCalls.push({ callId: call.toolCallId, tool: call.toolName, input: call.input, ...(prepared.prepared !== undefined ? { prepared: prepared.prepared } : {}) })
        } catch (error) {
          problem = errorText(error)
        }
      }
    }
    if (problem === undefined) continue
    outputs.push(textResult(call.toolCallId, call.toolName, problem, true))
    emit({ type: "entry", entry: { kind: "tool", id: toolEntryId(call.toolCallId), tool: call.toolName, label: def ? def.label(objectOf(call.input)) : call.toolName, status: "error", detail: toolDetail(call.input, problem), at: now() } })
  }
  return { outputs, changes, proposalCalls }
}

/**
 * 跑模型直到：模型不再调工具（说完了）、出了一张卡、到了步数或花费上限、出错、断线。
 * 返回等确认的卡的 id
 */
async function runLoop(loop: Loop, modelId: string): Promise<string | null> {
  const { db, signal } = loop.deps
  const settings = await readAssistantSettings(db)
  let resolved: ResolvedModel
  try {
    resolved = await resolveModel(db, modelId)
  } catch (error) {
    await notice(loop, error instanceof ModelConfigError ? error.message : `模型用不了：${errorText(error).slice(0, 300)}`, "error")
    return null
  }
  const system = await systemPrompt(db, { actor: loop.deps.actor, context: loop.context })
  const messages = historyForModel(await loadMessages(db, loop.chat.id))

  for (let step = 0; ; step++) {
    if (signal.aborted) throw new Aborted()
    const result = await modelStep(loop, resolved, system, messages)
    loop.spent += result.costUsd
    if (signal.aborted) throw new Aborted()
    if (!result.assistant) return null
    const { outputs, changes, proposalCalls } = await handleCalls(loop, result.calls)

    // 这一步存成 assistant + tool 两条消息；有卡就一起存，同一个事务
    const assistantSeq = loop.seq
    const proposalId = changes.length ? newId("ap") : null
    let createdAt = new Date()
    await db.transaction(async (tx) => {
      const rows = [{ seq: assistantSeq, role: "assistant", message: result.assistant as unknown }]
      if (outputs.length) rows.push({ seq: assistantSeq + 1, role: "tool", message: { role: "tool", content: outputs } })
      await insertMessages(tx, loop.chat.id, rows)
      if (proposalId) {
        const [row] = await tx.insert(t.assistantProposals).values({ id: proposalId, chatId: loop.chat.id, afterSeq: assistantSeq, calls: proposalCalls, changes }).returning({ createdAt: t.assistantProposals.createdAt })
        createdAt = row!.createdAt
      }
    })
    loop.seq += outputs.length ? 2 : 1
    messages.push(result.assistant)
    if (outputs.length) messages.push({ role: "tool", content: outputs })

    if (proposalId) {
      loop.deps.emit({ type: "entry", entry: proposalEntry({ id: proposalId, status: "pending", changes, createdAt }) })
      return proposalId
    }
    // 没调工具：说完了
    if (result.calls.length === 0) return null
    if (loop.spent >= settings.maxCostUsd) {
      await notice(loop, `这次已经花了 $${loop.spent.toFixed(4)}，到上限（$${settings.maxCostUsd}）停下了，要继续就再说一句`)
      return null
    }
    if (step + 1 >= settings.maxSteps) {
      await notice(loop, `这次已经调了 ${settings.maxSteps} 步模型，到上限停下了，要继续就再说一句`)
      return null
    }
  }
}

/** 跑 runLoop，收尾（存花费、发 done）；断线不发 done，模型出错发一条 error 提示 */
async function runAndFinish(loop: Loop, modelId: string) {
  let pending: string | null = null
  try {
    pending = await runLoop(loop, modelId)
  } catch (error) {
    if (error instanceof Aborted) {
      // 浏览器断开了：已经存下的照常保留，花掉的钱照样记上
      await loop.deps.db
        .update(t.assistantChats)
        .set({ costUsd: sql`${t.assistantChats.costUsd} + ${loop.spent}`, updatedAt: new Date() })
        .where(eq(t.assistantChats.id, loop.chat.id))
      return
    }
    if (!(error instanceof ModelFailed)) throw error
    await notice(loop, error.message, "error")
  }
  await finish(loop, modelId, pending)
}

/** 卡上的调用全部回一个同样的结果（不要 / 过期） */
const sameResult = (proposal: ProposalRow, value: Record<string, unknown>): ToolResultPart[] =>
  proposal.calls.map((call) => textResult(call.callId, call.tool, JSON.stringify(value)))

// ---------- 发消息 ----------

export async function runChat(deps: RunDeps, input: AssistantChatInput) {
  const { db, actor, emit } = deps
  let chat: ChatRow
  if (input.chatId) {
    const found = await loadChat(db, input.chatId, actor.id)
    if (!found) throw new AssistantError("找不到这段对话（可能已经删了），开一段新对话吧")
    chat = found
  } else {
    chat = await createChat(db, { userId: actor.id, title: chatTitle(input.message), modelId: null })
    await trimChats(db, actor.id)
  }
  await withChatLock(chat.id, async () => {
    emit({ type: "chat", chatId: chat.id, title: chat.title })
    // 没处理的卡过期：它的调用都回 expired，接在那条 assistant 消息后面，再接新消息
    const expired = await pendingProposals(db, chat.id)
    for (const proposal of expired) {
      await db.transaction(async (tx) => {
        await expireProposals(tx, [proposal.id])
        await appendToolResults(tx, chat.id, proposal.afterSeq, sameResult(proposal, { expired: true, message: "人没有处理这张确认卡，又说了新的话，这些改动没有执行" }))
      })
    }
    const loop: Loop = { deps, chat, context: input.context, spent: 0, seq: await nextSeq(db, chat.id) }
    const userSeq = loop.seq++
    await insertMessages(db, chat.id, [{ seq: userSeq, role: "user", message: { role: "user", content: input.message } }])
    emit({ type: "entry", entry: { kind: "user", id: entryIdOf(userSeq), text: input.message, at: now() } })
    for (const proposal of expired) emit({ type: "update", entry: proposalEntry({ ...proposal, status: "expired" }) })

    const model = await pickModel(db, input.modelId, chat.modelId)
    if ("error" in model) {
      await notice(loop, model.error, "error")
      await finish(loop, null, null)
      return
    }
    await runAndFinish(loop, model.modelId)
  })
}

// ---------- 处理卡 ----------

export async function runApply(deps: RunDeps, input: AssistantApplyInput) {
  const { db, actor, emit } = deps
  const [found] = await db
    .select({ proposal: t.assistantProposals, chat: t.assistantChats })
    .from(t.assistantProposals)
    .innerJoin(t.assistantChats, eq(t.assistantChats.id, t.assistantProposals.chatId))
    .where(and(eq(t.assistantProposals.id, input.proposalId), eq(t.assistantChats.userId, actor.id)))
  if (!found) throw new AssistantError("找不到这张确认卡")
  const { chat } = found
  await withChatLock(chat.id, async () => {
    // 抢着改状态：同一张卡点两次，只有一次生效
    const [proposal] = await db
      .update(t.assistantProposals)
      .set({ status: input.accept ? "applied" : "rejected", decidedAt: new Date() })
      .where(and(eq(t.assistantProposals.id, input.proposalId), eq(t.assistantProposals.status, "pending")))
      .returning()
    if (!proposal) throw new AssistantError(found.proposal.status === "expired" ? "这张确认卡已经过期了（后来又说了新的话），没有执行" : "这张确认卡已经处理过了")
    emit({ type: "chat", chatId: chat.id, title: chat.title })

    let results: ToolResultPart[]
    if (input.accept) {
      const ctx: ToolCtx = { db, actor: { id: actor.id, isAdmin: actor.isAdmin }, keyring: deps.keyring }
      const changes = proposal.changes.map((change) => ({ ...change }))
      results = []
      // 按顺序一项项执行，每项单独成败：一项失败不回滚别的（各自在自己的事务里）
      for (const [index, call] of proposal.calls.entries()) {
        const def = TOOLS[call.tool]
        let result: NonNullable<AssistantChange["result"]>
        let output: string
        try {
          if (!def || def.kind !== "write") throw new Error(`没有叫 ${call.tool} 的改动`)
          const parsed = parseToolInput(def, call.input)
          if (!parsed.ok) throw new Error(parsed.error)
          // 审计里记上 via: "assistant"
          const applied = await runAsAssistant(chat.id, () => def.apply(ctx, parsed.input as never, parsed.given, call.prepared))
          result = { ok: true, message: applied.message, ...(applied.link ? { link: applied.link } : {}) }
          output = JSON.stringify({ ok: true, message: applied.message, ...applied.output })
          results.push(textResult(call.callId, call.tool, output))
        } catch (error) {
          result = { ok: false, message: errorText(error) }
          results.push(textResult(call.callId, call.tool, `没做成：${result.message}`, true))
        }
        const at = changes.findIndex((change) => change.callId === call.callId)
        changes[at >= 0 ? at : index] = { ...changes[at >= 0 ? at : index]!, result }
        await db.update(t.assistantProposals).set({ changes }).where(eq(t.assistantProposals.id, proposal.id))
        emit({ type: "update", entry: proposalEntry({ ...proposal, changes }) })
      }
    } else {
      results = sameResult(proposal, { rejected: true, note: input.note || "人没有说为什么" })
      emit({ type: "update", entry: proposalEntry(proposal) })
    }
    await appendToolResults(db, chat.id, proposal.afterSeq, results)

    const loop: Loop = { deps, chat, context: input.context, spent: 0, seq: await nextSeq(db, chat.id) }
    const model = await pickModel(db, undefined, chat.modelId)
    if ("error" in model) {
      await notice(loop, model.error, "error")
      await finish(loop, null, null)
      return
    }
    await runAndFinish(loop, model.modelId)
  })
}
