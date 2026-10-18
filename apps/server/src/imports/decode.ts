// 包里的文件是不是文字：没有 NUL 字节，按 UTF-8 解得开（不行再试 GBK，Windows 中文系统写的文件）
const utf8 = new TextDecoder("utf-8", { fatal: true })
const gbk = new TextDecoder("gbk", { fatal: true })

/** 是文字就返回内容（去掉 BOM），二进制返回 undefined */
export function decodeText(data: Buffer): string | undefined {
  if (data.subarray(0, 8192).includes(0)) return undefined
  for (const decoder of [utf8, gbk]) {
    try {
      return decoder.decode(data).replace(/^\uFEFF/, "")
    } catch {
      // 换一种编码试
    }
  }
  return undefined
}

/** 只看开头一段（太大的文件用）：截断处可能切开一个多字节字符，去掉最后几个字节再判断 */
export function headLooksText(head: Buffer): boolean {
  if (head.includes(0)) return false
  for (let cut = 0; cut < 4 && cut < head.length; cut++) if (decodeText(head.subarray(0, head.length - cut)) !== undefined) return true
  return false
}
