// 导入测试用的 zip：正常的包用 yazl 打；要造坏文件名（../、绝对路径）、软链接、没有 UTF-8 标志的 GBK 文件名时，用这里手写的最小 zip（不压缩）。
import yazl from "yazl"

/** 用 yazl 打一个 zip（文件名按 UTF-8，带标志） */
export async function makeZip(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new yazl.ZipFile()
  for (const [path, content] of Object.entries(files)) zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), path)
  zip.end()
  const chunks: Buffer[] = []
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(data: Buffer) {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface RawEntry {
  /** 文件名的原始字节（或字符串，按 UTF-8） */
  name: Buffer | string
  data?: Buffer | string
  /** 打上 UTF-8 标志 */
  utf8?: boolean
  /** Unix 文件类型和权限（软链接是 0o120777） */
  mode?: number
}

/** 手写的最小 zip（stored，不压缩），文件名字节、标志、文件类型都可以随便定 */
export function rawZip(entries: RawEntry[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name)
    const data = entry.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const crc = crc32(data)
    const flag = entry.utf8 ? 0x800 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flag, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, data)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE((3 << 8) | 20, 4) // 3 = Unix，外部属性的高 16 位是文件类型和权限
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(flag, 8)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(data.length, 20)
    record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)
    offset += 30 + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}
