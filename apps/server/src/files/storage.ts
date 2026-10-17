// 文件存储：接口 + 本地磁盘实现（目录来自 HEYAGENT_FILES_DIR，容器里挂文件卷）。
// 库里 files 表只记元数据和 storage_path（相对路径），以后换对象存储只换这里。
import { createHash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, normalize, sep } from "node:path"

export interface FileStorage {
  put(path: string, data: Buffer): Promise<void>
  get(path: string): Promise<Buffer>
  remove(path: string): Promise<void>
}

export class LocalDiskStorage implements FileStorage {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  private resolve(path: string) {
    const full = normalize(join(this.root, path))
    // 防止 ../ 跳出目录
    if (!full.startsWith(normalize(this.root) + sep))
      throw new Error(`文件路径不对：${path}`)
    return full
  }

  async put(path: string, data: Buffer) {
    const full = this.resolve(path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, data, { mode: 0o600 })
  }

  async get(path: string) {
    return readFile(this.resolve(path))
  }

  async remove(path: string) {
    await rm(this.resolve(path), { force: true })
  }
}

export const sha256Hex = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex")
