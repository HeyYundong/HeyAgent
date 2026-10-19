// 助手的流式接口（POST /api/assistant/chat、/api/assistant/apply）：返回 text/event-stream，每条 `data: <JSON>\n\n`。
// 不用 EventSource：它只能 GET、不能带 body。这里用 fetch 读 response.body，按空行切开，每条用 shared 的 schema 校验。
import { assistantStreamEventSchema, type AssistantApplyInput, type AssistantChatInput, type AssistantStreamEvent } from "@heyagent/shared"

export type StreamOutcome =
  /** 收到了 done */
  | { kind: "done" }
  /** 收到了 error 事件、接口不是 2xx、或者连不上 */
  | { kind: "error"; message: string; unauthorized?: boolean }
  /** 人点了「停止」 */
  | { kind: "aborted" }
  /** 流断了，没等到 done */
  | { kind: "cut" }

type Path = "/api/assistant/chat" | "/api/assistant/apply"
type Body<P extends Path> = P extends "/api/assistant/chat" ? AssistantChatInput : AssistantApplyInput

/** 发请求并把每个事件交给 onEvent；整个过程不抛异常，结果看返回值 */
export async function postAssistant<P extends Path>(path: P, body: Body<P>, signal: AbortSignal, onEvent: (event: AssistantStreamEvent) => void): Promise<StreamOutcome> {
  let response: Response
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    })
  } catch {
    return signal.aborted ? { kind: "aborted" } : { kind: "error", message: "连不上服务器，请检查网络" }
  }

  if (response.status === 401) return { kind: "error", message: "登录过期了，请重新登录", unauthorized: true }
  const isStream = response.headers.get("content-type")?.includes("text/event-stream")
  if (!response.ok || !isStream || !response.body) {
    return { kind: "error", message: await errorText(response) }
  }

  let outcome: StreamOutcome = { kind: "cut" }
  try {
    for await (const event of readEvents(response.body)) {
      onEvent(event)
      if (event.type === "done") outcome = { kind: "done" }
      if (event.type === "error") outcome = { kind: "error", message: event.message }
    }
  } catch {
    if (signal.aborted) return { kind: "aborted" }
    return outcome.kind === "cut" ? { kind: "cut" } : outcome
  }
  return outcome
}

/** 把 SSE 字节流切成一条条事件；不认识的（schema 校验不过的）跳过 */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AssistantStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      let cut = buffer.indexOf("\n\n")
      while (cut >= 0) {
        const event = parseBlock(buffer.slice(0, cut))
        buffer = buffer.slice(cut + 2)
        if (event) yield event
        cut = buffer.indexOf("\n\n")
      }
    }
    const last = parseBlock(buffer)
    if (last) yield last
  } finally {
    reader.releaseLock()
  }
}

function parseBlock(block: string): AssistantStreamEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
  if (!data) return null
  try {
    const parsed = assistantStreamEventSchema.safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** 不是事件流的回复：可能是 JSON 的 { message }、一条 error 事件，或者纯文字 */
async function errorText(response: Response): Promise<string> {
  const fallback = response.ok ? "服务器回的不是事件流" : `服务器出错了（${response.status}）`
  try {
    const text = (await response.text()).trim()
    if (!text) return fallback
    const event = parseBlock(text)
    if (event?.type === "error") return event.message
    try {
      const json = JSON.parse(text) as { message?: unknown; error?: unknown }
      const message = json.message ?? json.error
      if (typeof message === "string" && message) return message
    } catch {
      // 不是 JSON
    }
    return text.length <= 200 && !text.startsWith("<") ? text : fallback
  } catch {
    return fallback
  }
}
