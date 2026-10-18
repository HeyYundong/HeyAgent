// 解压出来的包：文件清单（manifest.json）、分层列目录、扫技能、按需读「挪过密钥的文字」、把没用上的文件按目录收拢。
// 大的包（上万个文件、几百 MB，大半是原 agent 框架自己的源码）不能一次全吐给 AI：列目录默认只列两层，文件多的目录折叠成一行，
// 依赖和缓存目录标「跳过」；技能由代码扫出来列给 AI，AI 决定导哪些，正文由代码从文件取。
import { open, readFile } from "node:fs/promises"

import { decodeText, headLooksText } from "./decode.js"
import { importLimits, SKIPPED_DIRS, sizeText } from "./limits.js"
import { redactText, replaceKnownValues, type SecretCollector } from "./redact.js"

/** 包里的一个文件（解压后记在 manifest.json 里） */
export interface PackageFile {
  /** 给 AI 和人看的路径（去掉了唯一的顶层目录） */
  path: string
  /** 磁盘上的原文件；没解开的（skipped）为空 */
  diskPath: string
  size: number
  /** 是文字（给 AI 读的是挪过密钥的版本）；false = 二进制、太大或没解开 */
  text: boolean
  /** 是文字但太大，没给 AI 读 */
  tooLarge?: boolean
  /** 没解开的原因（依赖或缓存目录、压缩包、软链接……） */
  skipped?: string
}

export interface SkillInfo {
  path: string
  /** 技能所在目录（「」= 根目录） */
  dir: string
  name: string
  description: string
  /** 正文字数（去掉开头的元数据） */
  bodyChars: number
  /** references/ 下的文本文件 */
  references: string[]
  /** 目录里其他文本文件（不含 references/、scripts/） */
  others: string[]
  /** scripts/ 下的文件 */
  scripts: string[]
}

/** 一个目录下直接的子项超过这么多，列目录时折叠成一行 */
const FOLD = 40
/** list_skills 一次最多列多少个技能（再多就先按目录给个数） */
const SKILLS_PER_LIST = 150
/** 一次列目录最多多少行 */
const MAX_LINES = 400

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const under = (path: string, dir: string) => (dir ? path.startsWith(`${dir}/`) : true)
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** SKILL.md 开头 --- 之间的 YAML 元数据（只认顶层的「键: 值」，值可以是引号串或 | > 多行块） */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  const lines = match[1]!.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]!)
    if (!kv) continue
    const key = kv[1]!
    let value = kv[2]!.trim()
    if (/^[|>][-+]?$/.test(value) || value === "") {
      const folded = value.startsWith(">")
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === "")) block.push(lines[++i]!.trim())
      value = block.join(folded || value === "" ? " " : "\n").trim()
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
    meta[key] = value
  }
  return { meta, body: text.slice(match[0].length).replace(/^\s*\n/, "") }
}

/** 一个 Markdown 文件的标题：第一个 # 标题，没有就用文件名 */
export function markdownTitle(path: string, text: string) {
  const heading = /^#{1,3}\s+(.+)$/m.exec(text)?.[1]?.trim()
  return (heading || baseOf(path).replace(/\.[^.]+$/, "")).slice(0, 60)
}

interface DirNode {
  dirs: Set<string>
  files: PackageFile[]
  /** 这个目录下（含子目录）一共多少个文件、多大 */
  count: number
  size: number
}

export class ImportPackage {
  readonly byPath: Map<string, PackageFile>
  private readonly tree = new Map<string, DirNode>()
  private readonly cache = new Map<string, string>()

  readonly files: PackageFile[]
  readonly collector: SecretCollector

  constructor(files: PackageFile[], collector: SecretCollector) {
    this.files = files
    this.collector = collector
    this.byPath = new Map(files.map((file) => [file.path, file]))
    const node = (dir: string) => {
      let found = this.tree.get(dir)
      if (!found) {
        found = { dirs: new Set(), files: [], count: 0, size: 0 }
        this.tree.set(dir, found)
      }
      return found
    }
    node("")
    for (const file of files) {
      node(dirOf(file.path)).files.push(file)
      // 每一层上级目录都算上这个文件，并记下子目录
      let dir = dirOf(file.path)
      for (;;) {
        const current = node(dir)
        current.count += 1
        current.size += file.size
        if (!dir) break
        const parent = dirOf(dir)
        node(parent).dirs.add(baseOf(dir))
        dir = parent
      }
    }
  }

  /** 挪过密钥的文字（再把已知的原值全文替换一遍）；不是文字返回 undefined。密钥在读包开始时已经全部扫过，这里起的名字和那时一样 */
  async text(path: string): Promise<string | undefined> {
    const file = this.byPath.get(path)
    if (!file?.text || !file.diskPath) return undefined
    const cached = this.cache.get(path)
    if (cached !== undefined) return cached
    const raw = decodeText(await readFile(file.diskPath))
    if (raw === undefined) return undefined
    const text = replaceKnownValues(redactText(path, raw, this.collector), this.collector.found)
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(path, text)
    return text
  }

  hasDir(dir: string) {
    return this.tree.has(dir)
  }

  private kind(file: PackageFile) {
    if (file.skipped) return `没解开：${file.skipped}`
    return file.text ? "文字" : file.tooLarge ? "文字但太大（不能读）" : "二进制"
  }

  /** 分层列目录：默认从根目录列两层；文件多的目录折叠成一行，依赖和缓存目录标「跳过」 */
  listFiles(dir = "", depth = 2): string {
    const start = dir.replace(/^\.?\/+|\/+$/g, "")
    const root = this.tree.get(start)
    if (!root) return `包里没有目录「${dir}」`
    const lines: string[] = [`${start ? `${start}/` : "（根目录）"}：${root.count} 个文件，${sizeText(root.size)}`]
    let truncated = false
    const push = (line: string) => {
      if (lines.length >= MAX_LINES) truncated = true
      else lines.push(line)
    }
    const walk = (current: string, level: number, indent: string) => {
      const node = this.tree.get(current)!
      for (const name of [...node.dirs].sort(byName)) {
        const full = current ? `${current}/${name}` : name
        const child = this.tree.get(full)!
        const stat = `${child.count} 个文件，${sizeText(child.size)}`
        if (SKIPPED_DIRS.has(name)) {
          push(`${indent}- ${name}/ （跳过：依赖或缓存目录，${stat}）`)
          continue
        }
        const children = child.dirs.size + child.files.length
        if (level > 1 && children <= FOLD) {
          push(`${indent}- ${name}/ （${stat}）`)
          walk(full, level - 1, `${indent}  `)
        } else push(`${indent}- ${name}/ （${stat}${level > 1 ? `；内容多，要看就 list_files dir="${full}"` : ""}）`)
      }
      const files = [...node.files].sort((a, b) => byName(a.path, b.path))
      // 要列的目录本身文件就很多：列前面一部分
      const shown = current === start ? files.slice(0, 200) : files
      for (const file of shown) push(`${indent}- ${baseOf(file.path)} · ${sizeText(file.size)} · ${this.kind(file)}`)
      if (shown.length < files.length) push(`${indent}- ……还有 ${files.length - shown.length} 个文件没列`)
    }
    walk(start, Math.max(1, Math.min(depth || 2, 6)), "")
    if (truncated) lines.push(`（太多了，只列了前 ${MAX_LINES} 行；用 dir 参数看子目录）`)
    return lines.join("\n")
  }

  /** 扫出包里所有的 SKILL.md（不分大小写），读元数据 */
  async skills(): Promise<SkillInfo[]> {
    const skillFiles = this.files.filter((file) => file.text && baseOf(file.path).toLowerCase() === "skill.md")
    const skillDirs = new Set(skillFiles.map((file) => dirOf(file.path)))
    // 每个文件归到离它最近的技能目录（嵌套的技能各管各的）
    const ownFiles = new Map<string, PackageFile[]>()
    for (const each of this.files) {
      for (let dir = dirOf(each.path); ; dir = dirOf(dir)) {
        if (skillDirs.has(dir)) {
          const list = ownFiles.get(dir)
          if (list) list.push(each)
          else ownFiles.set(dir, [each])
          break
        }
        if (!dir) break
      }
    }
    const out: SkillInfo[] = []
    for (const file of skillFiles.sort((a, b) => byName(a.path, b.path))) {
      const text = (await this.text(file.path)) ?? ""
      const { meta, body } = parseFrontMatter(text)
      const dir = dirOf(file.path)
      const own = (ownFiles.get(dir) ?? []).filter((each) => each !== file)
      const rel = (path: string) => (dir ? path.slice(dir.length + 1) : path)
      out.push({
        path: file.path,
        dir,
        name: (meta.name || baseOf(dir) || "技能").slice(0, 100),
        description: (meta.description ?? "").slice(0, 300),
        bodyChars: body.length,
        references: own.filter((each) => each.text && rel(each.path).startsWith("references/")).map((each) => each.path),
        others: own.filter((each) => each.text && !rel(each.path).startsWith("references/") && !rel(each.path).startsWith("scripts/")).map((each) => each.path),
        scripts: own.filter((each) => rel(each.path).startsWith("scripts/")).map((each) => each.path),
      })
    }
    return out
  }

  /**
   * list_skills 给 AI 的文字：dir 下（空 = 全部）的技能一行一个；太多时（原 agent 框架的源码里常带几百个）
   * 先按目录给个数，让 AI 带 dir 再看
   */
  async skillsText(dir = ""): Promise<string> {
    const start = dir.replace(/^\.?\/+|\/+$/g, "")
    const skills = (await this.skills()).filter((skill) => under(skill.path, start))
    if (skills.length === 0) return start ? `「${start}」下没有 SKILL.md` : "包里没有 SKILL.md"
    if (skills.length > SKILLS_PER_LIST) {
      // 从浅往深找第一层能分开的目录
      let depth = start ? start.split("/").length + 1 : 1
      let groups = new Map<string, number>()
      for (; depth < 12; depth++) {
        groups = new Map()
        for (const skill of skills) {
          const key = skill.path.split("/").slice(0, depth).join("/")
          groups.set(key, (groups.get(key) ?? 0) + 1)
        }
        if (groups.size > 1) break
      }
      return [
        `${start ? `「${start}」下` : "包里"}一共 ${skills.length} 个 SKILL.md，太多了，先按目录列个数。要看哪个目录就 list_skills dir="那个目录"：`,
        ...[...groups.entries()].sort((a, b) => byName(a[0], b[0])).map(([key, n]) => `- ${key}${this.byPath.has(key) ? "" : "/"} （${n} 个）`),
      ].join("\n")
    }
    const lines = skills.map((skill) => {
      const extra = [
        skill.references.length ? `references/ 下 ${skill.references.length} 个参考` : "",
        skill.others.length ? `另有 ${skill.others.length} 个文本文件` : "",
        skill.scripts.length ? `scripts/ 下 ${skill.scripts.length} 个脚本` : "",
      ].filter(Boolean)
      const description = skill.description.length > 100 ? `${skill.description.slice(0, 100)}…` : skill.description
      return `- ${skill.path} · 名字：${skill.name} · 说明：${description || "（没写）"} · 正文 ${skill.bodyChars} 字${extra.length ? ` · ${extra.join("，")}` : ""}`
    })
    return [`${start ? `「${start}」下` : ""}共 ${skills.length} 个技能（正文由系统从文件取，方案里写 path 就行）：`, ...lines].join("\n")
  }

  /**
   * AI 写的一行「没用上的文件」提到了哪些路径（目录或文件）。一行可以用「、」「，」连起好几个，
   * 后面的常常省掉上级目录（「skills/apple/、creative/、mlops/」）：包里没有这个路径、补上第一个的上级目录就有的，按补上的算
   */
  unusedPaths(line: string): string[] {
    // 去掉结尾的「（N 个文件）」「……」「等」，可能叠着写，去到不变为止
    const clean = (piece: string) => {
      let out = piece.trim()
      for (let before = ""; before !== out; ) {
        before = out
        out = out.replace(/[（(][^（）()]*[)）]$/, "").replace(/(……|\.\.\.|…|等[^/]*)$/, "").trim()
      }
      return out.replace(/^\.?\/+/, "")
    }
    const exists = (path: string) => this.byPath.has(path) || this.tree.has(path.replace(/\/+$/, ""))
    const out: string[] = []
    let parent = ""
    for (const [index, raw] of line.split(/[、，,；;]/).entries()) {
      const piece = clean(raw)
      if (!piece) continue
      const resolved = !exists(piece) && parent && exists(parent + piece) ? parent + piece : piece
      if (index === 0) {
        const dir = dirOf(resolved.replace(/\/+$/, ""))
        parent = dir ? `${dir}/` : ""
      }
      out.push(resolved)
    }
    return out
  }

  /** 这些「没用上的文件」的行有没有提到 path（本身，或者它所在的目录） */
  unusedCovers(lines: { path: string }[], path: string): boolean {
    return lines.some((line) => this.unusedPaths(line.path).some((prefix) => prefix === path || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)))
  }

  /**
   * 没用上的文件按目录收拢：一个目录下的文件全都没用上就写成一行「目录/（N 个文件）」，
   * 否则往下分；同一层零散的文件太多也合成一行。covered 判断一个文件有没有着落
   */
  groupUnused(covered: (path: string) => boolean): { path: string; reason: string }[] {
    const out: { path: string; reason: string }[] = []
    const allUncovered = new Map<string, boolean>()
    const check = (dir: string): boolean => {
      const node = this.tree.get(dir)!
      let all = node.files.every((file) => !covered(file.path))
      for (const name of node.dirs) if (!check(dir ? `${dir}/${name}` : name)) all = false
      allUncovered.set(dir, all)
      return all
    }
    check("")
    const reasonOf = (files: PackageFile[]) => {
      const reasons = new Set(files.map((file) => file.skipped ?? "AI 没用到"))
      return reasons.size === 1 ? [...reasons][0]! : "AI 没用到"
    }
    const filesUnder = (dir: string) => this.files.filter((file) => under(file.path, dir))
    const emit = (dir: string) => {
      const node = this.tree.get(dir)!
      for (const name of [...node.dirs].sort(byName)) {
        const full = dir ? `${dir}/${name}` : name
        if (allUncovered.get(full)) {
          const files = filesUnder(full)
          out.push(files.length === 1 ? { path: files[0]!.path, reason: reasonOf(files) } : { path: `${full}/（${files.length} 个文件）`, reason: reasonOf(files) })
        } else emit(full)
      }
      const loose = node.files.filter((file) => !covered(file.path))
      if (loose.length > 20) out.push({ path: `${dir ? `${dir}/` : ""}下另外 ${loose.length} 个文件`, reason: reasonOf(loose) })
      else for (const file of loose) out.push({ path: file.path, reason: reasonOf([file]) })
    }
    emit("")
    return out
  }
}

/** 解压后逐个看是不是文字（太大的不读） */
export async function classify(file: { path: string; diskPath: string; size: number }): Promise<{ entry: PackageFile; content?: string }> {
  if (file.size > importLimits.maxTextFileBytes) {
    // 太大：看开头像不像文字，只为了列文件时说清楚
    const handle = await open(file.diskPath)
    const head = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(head, 0, head.length, 0).finally(() => handle.close())
    const looksText = headLooksText(head.subarray(0, bytesRead))
    return { entry: { ...file, text: false, ...(looksText ? { tooLarge: true } : {}) } }
  }
  const content = decodeText(await readFile(file.diskPath))
  return { entry: { ...file, text: content !== undefined }, content }
}

