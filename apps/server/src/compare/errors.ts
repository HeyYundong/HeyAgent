// 比图的报错和图库是同一个类：读图片引用（gallery/images.ts 的 loadImageRef、checkSize）抛的错能原样传出去，
// HTTP 接口、MCP、tRPC、agent 工具各自翻译（状态码 / isError / TRPCError），message 都是给人看的中文。
export { GalleryError as CompareError } from "../gallery/errors.js"
