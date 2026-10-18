// 解压上传的 zip（yauzl：按需逐个读条目，不信头里写的大小）。
// 安全：文件数、解压后总大小（按实际写出的字节数算）都有上限；拒绝绝对路径和 ..；跳过软链接、目录条目、__MACOSX/、.DS_Store；
// 包里的压缩包不再解开（列进「没用上的文件」）。文件名没有 UTF-8 标志时依次试 UTF-8、GBK（Windows 中文系统打的包）、CP437。
import { createWriteStream } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { dirname, join, normalize, sep } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

import yauzl, { type Entry } from "yauzl"

import { importLimits, inSkippedDir, sizeText, type ImportLimits } from "./limits.js"

/** 读包失败、要原样告诉人的原因（不含任何密钥值） */
export class ImportReadError extends Error {}

export interface ExtractedFile {
  /** 给 AI 和人看的路径：所有文件都在同一个顶层目录下时去掉这一层 */
  path: string
  /** 磁盘上的位置（imports/<id>/files/ 下，按包里原来的路径） */
  diskPath: string
  size: number
}

export interface ExtractResult {
  files: ExtractedFile[]
  /** 解出来但没写出的（依赖和缓存目录、压缩包、软链接、加密的），直接进「没用上的文件」；size 是头里写的大小，只给人看 */
  skipped: { path: string; reason: string; size: number }[]
  totalBytes: number
}

export const SKIPPED_REASON = "依赖或缓存目录，跳过"

const ARCHIVE = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|jar|war|whl)$/i
const UNIX_TYPE_MASK = 0o170000
const UNIX_SYMLINK = 0o120000

const utf8 = new TextDecoder("utf-8", { fatal: true })
const gbk = new TextDecoder("gbk", { fatal: true })

/** 条目的文件名（decodeStrings 关掉了，自己按编码解） */
export function decodeEntryName(entry: Pick<Entry, "generalPurposeBitFlag" | "extraFields"> & { fileNameRaw: Buffer }): string {
  const raw = entry.fileNameRaw
  const flagged = (entry.generalPurposeBitFlag & 0x800) !== 0
  // 有 UTF-8 标志，或者带 Info-ZIP 的 Unicode 路径扩展字段：交给 yauzl 按规范解
  if (flagged || entry.extraFields.some((field) => field.id === 0x7075)) return yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, raw, entry.extraFields, false)
  // 没有标志：macOS 自带的压缩也是 UTF-8 但不打标志，先试 UTF-8（GBK 的中文几乎不会恰好是合法 UTF-8），再试 GBK，最后按规范的 CP437
  for (const decoder of [utf8, gbk]) {
    try {
      return decoder.decode(raw).replace(/\\/g, "/")
    } catch {
      // 不是这种编码，试下一种
    }
  }
  return yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, raw, [], false)
}

/** 包里的路径合不合法：不许绝对路径、不许 ..（防止写到解压目录外面） */
function badPath(name: string): string | undefined {
  if (/^[a-zA-Z]:/.test(name) || name.startsWith("/")) return `包里有绝对路径的文件（${name.slice(0, 100)}），为了安全不解压这个包`
  if (name.split("/").includes("..")) return `包里有带「..」的路径（${name.slice(0, 100)}），为了安全不解压这个包`
  if (name.includes("\0")) return "包里有文件名不合法的文件，为了安全不解压这个包"
  return undefined
}

const ignored = (name: string) => name.split("/").includes("__MACOSX") || /(^|\/)\.DS_Store$/.test(name) || /(^|\/)Thumbs\.db$/i.test(name)

/** 开头是不是 zip 的本地文件头 PK\x03\x04（不看扩展名） */
export const looksLikeZip = (data: Buffer) => data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04

/**
 * 解压到 dest（先清空）。超过上限、路径不合法、不是 zip 抛 ImportReadError（给人看的原因）。
 * 返回写出的文件（路径已去掉唯一的顶层目录）和跳过的条目
 */
export async function extractZip(data: Buffer, dest: string, limits: ImportLimits = importLimits): Promise<ExtractResult> {
  if (!looksLikeZip(data)) throw new ImportReadError("这不是 zip 包（开头不是 PK），请重新打包成 .zip 再上传")
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  const root = normalize(dest) + sep
  let zipfile: yauzl.ZipFile
  try {
    zipfile = await yauzl.fromBufferPromise(data, { lazyEntries: true, decodeStrings: false, validateEntrySizes: true })
  } catch (error) {
    throw new ImportReadError(`打不开这个 zip 包：${(error as Error).message.slice(0, 200)}`)
  }
  const written: { name: string; diskPath: string; size: number }[] = []
  const skipped: { name: string; reason: string; size: number }[] = []
  let total = 0
  let count = 0
  try {
    for await (const entry of zipfile.eachEntry()) {
      const name = decodeEntryName({ ...entry, fileNameRaw: entry.fileNameRaw ?? (entry.fileName as unknown as Buffer) })
      if (name.endsWith("/") || ignored(name)) continue
      const problem = badPath(name)
      if (problem) throw new ImportReadError(problem)
      count += 1
      if (count > limits.maxFiles) throw new ImportReadError(`包里的文件太多了：超过 ${limits.maxFiles} 个。只打包任务说明、技能、记忆、规则和工具配置，别把日志、缓存、依赖目录打进去`)
      const mode = (entry.externalFileAttributes >>> 16) & UNIX_TYPE_MASK
      if (mode === UNIX_SYMLINK) {
        skipped.push({ name, reason: "软链接，没有解开", size: entry.uncompressedSize })
        continue
      }
      // 依赖、缓存、构建产物目录：不解开（只记下有这些文件，列文件时标「跳过」）
      if (inSkippedDir(name)) {
        skipped.push({ name, reason: SKIPPED_REASON, size: entry.uncompressedSize })
        continue
      }
      if (ARCHIVE.test(name)) {
        skipped.push({ name, reason: "包里的压缩包，没有再解开", size: entry.uncompressedSize })
        continue
      }
      if (entry.isEncrypted() || !entry.canDecodeFileData()) {
        skipped.push({ name, reason: entry.isEncrypted() ? "加了密码，打不开" : "压缩方式不认识，打不开", size: entry.uncompressedSize })
        continue
      }
      const diskPath = normalize(join(dest, name))
      if (!diskPath.startsWith(root)) throw new ImportReadError(`包里有写到目录外面的路径（${name.slice(0, 100)}），为了安全不解压这个包`)
      await mkdir(dirname(diskPath), { recursive: true })
      let size = 0
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length
          total += chunk.length
          if (total > limits.maxUnpackedBytes)
            return callback(new ImportReadError(`解压后太大了：超过 ${sizeText(limits.maxUnpackedBytes)}。别把日志、数据库、依赖目录打进去`))
          callback(null, chunk)
        },
      })
      try {
        await pipeline(await zipfile.openReadStreamPromise(entry), counter, createWriteStream(diskPath, { mode: 0o600 }))
      } catch (error) {
        if (error instanceof ImportReadError) throw error
        throw new ImportReadError(`解压「${name.slice(0, 100)}」时出错，包可能坏了：${(error as Error).message.slice(0, 200)}`)
      }
      written.push({ name, diskPath, size })
    }
  } catch (error) {
    if (error instanceof ImportReadError) throw error
    throw new ImportReadError(`读 zip 包时出错，包可能坏了：${(error as Error).message.slice(0, 200)}`)
  } finally {
    if (zipfile.isOpen) zipfile.close()
  }
  // 所有文件都在同一个顶层目录下（常见的「右键压缩文件夹」）：给人和 AI 看的路径去掉这一层
  const names = [...written.map((file) => file.name), ...skipped.map((each) => each.name)]
  const first = names[0]?.split("/")[0]
  const strip = first && names.length > 0 && names.every((name) => name.includes("/") && name.split("/")[0] === first) ? `${first}/` : ""
  const display = (name: string) => (strip ? name.slice(strip.length) : name)
  return {
    files: written.map((file) => ({ path: display(file.name), diskPath: file.diskPath, size: file.size })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    skipped: skipped.map((each) => ({ path: display(each.name), reason: each.reason, size: each.size })),
    totalBytes: total,
  }
}
