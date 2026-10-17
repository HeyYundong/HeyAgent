// 认出 URL、请求头、请求体里的明文密钥，换成 {{名字}}，值挪出来单独存在服务器上。
// 逻辑在 shared（config.ts 的 moveSecrets），服务端保存前用同一份检查，前后端说法一致。
export { moveSecrets, snakeName as snake } from "@heyagent/shared"
export type { MovedSecret as Moved, SecretTemplate as Template, SecretWhere as Where } from "@heyagent/shared"
