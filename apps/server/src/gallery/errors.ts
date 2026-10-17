// 图库的报错：同一个错在 HTTP 接口、MCP、tRPC、agent 工具里各自翻译（状态码 / isError / TRPCError），message 都是给人看的中文。
import { TRPCError } from "@trpc/server"

export type GalleryErrorCode = "bad_request" | "not_found" | "forbidden" | "too_large" | "unavailable" | "upstream"

const HTTP_STATUS: Record<GalleryErrorCode, 400 | 403 | 404 | 413 | 502 | 503> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  too_large: 413,
  upstream: 502,
  unavailable: 503,
}

const TRPC_CODE: Record<GalleryErrorCode, TRPCError["code"]> = {
  bad_request: "BAD_REQUEST",
  forbidden: "FORBIDDEN",
  not_found: "NOT_FOUND",
  too_large: "PAYLOAD_TOO_LARGE",
  upstream: "BAD_GATEWAY",
  unavailable: "PRECONDITION_FAILED",
}

export class GalleryError extends Error {
  readonly code: GalleryErrorCode

  constructor(code: GalleryErrorCode, message: string) {
    super(message)
    this.code = code
  }

  get status() {
    return HTTP_STATUS[this.code]
  }

  toTRPC() {
    return new TRPCError({ code: TRPC_CODE[this.code], message: this.message })
  }
}
