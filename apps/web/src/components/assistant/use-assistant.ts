// 助手面板的状态：当前是哪段对话、记录、正在进行的请求（发消息 / 应用改动），和停止。
// 对话记录平时来自 tRPC assistant.get 的缓存；请求进行中改用一份本地的「live」副本，流里的事件只改它，
// 结束后写回缓存。这样请求中途别处让查询重新拉（useAction 成功后会让全部查询失效），也不会冲掉正在接的文字。
import * as React from "react"
import { skipToken, useQuery } from "@tanstack/react-query"
import type { AssistantChat, AssistantChatSettings, AssistantEntry, AssistantPageContext, AssistantStreamEvent } from "@heyagent/shared"

import { SESSION_QUERY_KEY } from "@/lib/auth"
import { useRoute } from "@/lib/router"
import { isNotFound, queryClient, trpc } from "@/lib/trpc"

import { postAssistant, type StreamOutcome } from "./stream"

// ---------- localStorage（隐私窗口、禁用存储时会抛异常，读写都包起来） ----------

const CHAT_KEY = "heyagent.assistant.chat"
const OPEN_KEY = "heyagent.assistant.open"
const EXPANDED_KEY = "heyagent.assistant.expanded"

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // 存不了就算了：刷新后回到默认（收起、新对话）
  }
}

/** 记在 localStorage 里的开关，刷新后保持 */
function useStoredFlag(key: string) {
  const [value, setValueState] = React.useState(() => readStored(key) === "1")
  const setValue = React.useCallback(
    (next: boolean) => {
      setValueState(next)
      writeStored(key, next ? "1" : null)
    },
    [key]
  )
  return [value, setValue] as const
}

/** 面板开着还是收起 */
export const useStoredOpen = () => useStoredFlag(OPEN_KEY)
/** 面板放大了没有（宽屏才有） */
export const useStoredExpanded = () => useStoredFlag(EXPANDED_KEY)

// ---------- 记录的小工具 ----------

/** 发出去、服务器还没回 user 记录之前，先显示的那条 */
const LOCAL_USER_ID = "local-user"
let localSeq = 0
const localId = (prefix: string) => `local-${prefix}-${++localSeq}`
const now = () => new Date().toISOString()

function upsert(entries: AssistantEntry[], entry: AssistantEntry): AssistantEntry[] {
  const index = entries.findIndex((item) => item.id === entry.id)
  if (index < 0) return [...entries, entry]
  const next = entries.slice()
  next[index] = entry
  return next
}

/** 还在等确认的卡，人又发了新消息：服务器会把它记成过期，这里先改了，不用等 */
function expirePending(chat: AssistantChat): AssistantChat {
  if (!chat.pendingProposalId) return chat
  const id = chat.pendingProposalId
  return {
    ...chat,
    pendingProposalId: null,
    entries: chat.entries.map((entry) => (entry.kind === "proposal" && entry.proposal.id === id && entry.proposal.status === "pending" ? { ...entry, proposal: { ...entry.proposal, status: "expired" } } : entry)),
  }
}

/** 本对话的设置都跟默认走 */
export const FOLLOW_DEFAULTS: AssistantChatSettings = { modelId: null, maxSteps: null, maxCostUsd: null }

const emptyChat = (settings: AssistantChatSettings): AssistantChat => ({ id: "", title: "新对话", ...settings, costUsd: 0, updatedAt: now(), entries: [], pendingProposalId: null })

/** 人现在在哪一页、选中了哪一项（URL 里的参数），超长的不带 */
function pageContext(route: ReturnType<typeof useRoute>): AssistantPageContext {
  const params: Record<string, string> = {}
  for (const [key, value] of route.params.entries()) {
    if (value && value.length <= 200 && key.length <= 50) params[key] = value
  }
  return { page: route.page, params }
}

// ---------- hook ----------

export type SendResult = { ok: true } | { ok: false; restore: string }

export function useAssistant() {
  const [chatId, setChatIdState] = React.useState<string | null>(() => readStored(CHAT_KEY))
  /** 新对话还没发第一句时设的本对话设置：先存在这里，第一条消息时带上 */
  const [draftSettings, setDraftSettings] = React.useState<AssistantChatSettings | null>(null)
  const [busy, setBusy] = React.useState<null | "send" | "apply">(null)
  const [error, setError] = React.useState<string | null>(null)
  const [live, setLive] = React.useState<AssistantChat | null>(null)
  /** 换了一段对话（新对话、打开以前的）就加一：记录的滚动容器重新挂上 */
  const [viewKey, setViewKey] = React.useState(0)
  const liveRef = React.useRef<AssistantChat | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)

  const route = useRoute()
  // 详情抽屉是模态的，开着时点不了面板；关上抽屉 ?id 就没了。所以记着这一页上次带参数的地址：
  // 当前地址没参数、还在同一页时，用上次的，「这个任务」就是刚才看的那个
  const routeRef = React.useRef(route)
  React.useEffect(() => {
    const last = routeRef.current
    routeRef.current = route.page === last.page && route.params.size === 0 && last.params.size > 0 ? { ...route, params: last.params } : route
  }, [route])

  const setChatId = React.useCallback((id: string | null) => {
    setChatIdState(id)
    writeStored(CHAT_KEY, id)
  }, [])

  const chatQuery = useQuery({
    ...trpc.assistant.get.queryOptions(chatId ? { id: chatId } : skipToken),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  // 记着的对话已经没了（删了、超过 50 段被清掉）：回到新对话
  const lost = chatQuery.isError && isNotFound(chatQuery.error)
  React.useEffect(() => {
    if (lost && !liveRef.current) setChatId(null)
  }, [lost, setChatId])

  // 页面卸载时停掉还在进行的请求
  React.useEffect(() => () => abortRef.current?.abort(), [])

  const chat = live ?? (chatId ? (chatQuery.data ?? null) : null)

  function mutateLive(update: (chat: AssistantChat) => AssistantChat) {
    if (!liveRef.current) return
    liveRef.current = update(liveRef.current)
    setLive(liveRef.current)
  }

  function onEvent(event: AssistantStreamEvent) {
    switch (event.type) {
      case "chat":
        mutateLive((current) => ({ ...current, id: event.chatId, title: event.title }))
        // 新对话：先把缓存填上，换到这个 id 时不用再去拉一次
        if (liveRef.current && !queryClient.getQueryData(trpc.assistant.get.queryKey({ id: event.chatId }))) {
          queryClient.setQueryData(trpc.assistant.get.queryKey({ id: event.chatId }), liveRef.current)
        }
        setChatId(event.chatId)
        // 设置已经跟着新对话存到服务器了
        setDraftSettings(null)
        break
      case "entry":
        mutateLive((current) => {
          const entries = event.entry.kind === "user" ? current.entries.filter((entry) => entry.id !== LOCAL_USER_ID) : current.entries
          return { ...current, entries: upsert(entries, event.entry) }
        })
        break
      case "update":
        mutateLive((current) => ({ ...current, entries: upsert(current.entries, event.entry) }))
        break
      case "delta":
        mutateLive((current) => ({
          ...current,
          entries: current.entries.map((entry) => (entry.id === event.id && entry.kind === "assistant" ? { ...entry, text: entry.text + event.text } : entry)),
        }))
        break
      case "done":
        mutateLive((current) => ({ ...current, pendingProposalId: event.pendingProposalId, costUsd: current.costUsd + event.costUsd, updatedAt: now() }))
        break
      case "error":
        // 结果在 postAssistant 的返回值里处理
        break
    }
  }

  /** 请求结束：把 live 写回缓存，按结果补一句 */
  async function finish(outcome: StreamOutcome): Promise<SendResult> {
    let restore: string | null = null
    if (outcome.kind === "aborted") {
      mutateLive((current) => ({
        ...current,
        entries: [
          ...current.entries.map((entry) => (entry.kind === "tool" && entry.status === "running" ? { ...entry, status: "error" as const, detail: entry.detail ?? "已停止" } : entry)),
          { kind: "notice", id: localId("stop"), text: "已停止", tone: "info", at: now() },
        ],
      }))
    }
    if (outcome.kind === "error" || outcome.kind === "cut") {
      setError(outcome.kind === "cut" ? "连接断了，回复可能不完整。重新打开这段对话能看到已经存下的部分。" : outcome.message)
      if (outcome.kind === "error" && outcome.unauthorized) void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
    }
    const final = liveRef.current
    // 服务器没收下这条消息（没回 user 记录）：去掉先显示的那条，文字还给输入框
    const unsent = final?.entries.find((entry) => entry.id === LOCAL_USER_ID)
    if (unsent && unsent.kind === "user") restore = unsent.text
    if (final?.id) {
      const cleaned = unsent ? { ...final, entries: final.entries.filter((entry) => entry.id !== LOCAL_USER_ID) } : final
      const key = trpc.assistant.get.queryKey({ id: final.id })
      // 请求中途被别处触发的重新拉取（拿到的是半截的）先停掉，再写最终的
      await queryClient.cancelQueries({ queryKey: key })
      queryClient.setQueryData(key, cleaned)
      // 出错 / 断线：以服务器存下的为准再拉一次
      if (outcome.kind === "error" || outcome.kind === "cut") void queryClient.invalidateQueries({ queryKey: key })
    }
    liveRef.current = null
    setLive(null)
    abortRef.current = null
    setBusy(null)
    void queryClient.invalidateQueries({ queryKey: trpc.assistant.chats.queryKey() })
    return restore === null ? { ok: true } : { ok: false, restore }
  }

  function begin(kind: "send" | "apply", seed: AssistantChat) {
    setError(null)
    liveRef.current = seed
    setLive(seed)
    setBusy(kind)
    const controller = new AbortController()
    abortRef.current = controller
    return controller.signal
  }

  /** 发一条消息；没发出去时返回原文，输入框放回去 */
  async function send(text: string): Promise<SendResult> {
    const message = text.trim()
    if (!message || abortRef.current) return { ok: false, restore: text }
    const base = chat && chatId ? expirePending(chat) : emptyChat(draftSettings ?? FOLLOW_DEFAULTS)
    const signal = begin("send", { ...base, entries: [...base.entries, { kind: "user", id: LOCAL_USER_ID, text: message, at: now() }] })
    const outcome = await postAssistant(
      "/api/assistant/chat",
      { chatId: chatId ?? undefined, message, context: pageContext(routeRef.current), ...(!chatId && draftSettings ? { settings: draftSettings } : {}) },
      signal,
      onEvent
    )
    return finish(outcome)
  }

  /** 改动确认卡：应用 / 不要（可以带一句为什么） */
  async function decide(proposalId: string, accept: boolean, note?: string) {
    if (!chat || !chatId || abortRef.current) return
    const signal = begin("apply", chat)
    const outcome = await postAssistant("/api/assistant/apply", { proposalId, accept, note: note?.trim() || undefined, context: pageContext(routeRef.current) }, signal, onEvent)
    await finish(outcome)
  }

  function stop() {
    abortRef.current?.abort()
  }

  function newChat() {
    if (abortRef.current) return
    setChatId(null)
    setDraftSettings(null)
    setError(null)
    setViewKey((key) => key + 1)
  }

  function openChat(id: string) {
    if (abortRef.current) return
    setChatId(id)
    setDraftSettings(null)
    setError(null)
    setViewKey((key) => key + 1)
  }

  /** 删掉的是正开着的那段：回到新对话 */
  function forget(id: string) {
    queryClient.removeQueries({ queryKey: trpc.assistant.get.queryKey({ id }) })
    if (id === chatId) newChat()
  }

  return {
    chat,
    chatId,
    viewKey,
    /** 正在读一段以前的对话 */
    loading: !!chatId && !live && chatQuery.isPending,
    /** 读对话出错（不算「对话没了」） */
    loadError: !live && chatQuery.isError && !lost ? chatQuery.error : null,
    reload: () => void chatQuery.refetch(),
    busy,
    error,
    dismissError: () => setError(null),
    /** 本对话的设置（null 的项跟默认走）：已有的对话来自服务器，新对话来自还没发出去的 draftSettings */
    settings: chatId ? (chat ? { modelId: chat.modelId, maxSteps: chat.maxSteps, maxCostUsd: chat.maxCostUsd } : null) : (draftSettings ?? FOLLOW_DEFAULTS),
    /** 新对话发第一句之前改设置：先记在前端 */
    setDraftSettings,
    send,
    decide,
    stop,
    newChat,
    openChat,
    forget,
  }
}

export type AssistantState = ReturnType<typeof useAssistant>
