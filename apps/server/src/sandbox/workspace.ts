// 每个 session 的沙箱目录（docs/dev/session-space.md 5.2），在 worker 本地（不在文件卷）：
//   workspace/  空间里 agent 写的文件的镜像，挂成沙箱的 /workspace（可写）
//   ro/<目录>/  附件、浏览器下载、截图、工具输出全文，只读挂到 /workspace/<目录>
//   home/       沙箱的 HOME：pip install --user、npm 缓存放这里，不同步回空间，这次运行里一直有效
//   code/       直接给的代码（只读挂到 /tmp/.code）
//   p/          出网代理的 unix socket
//   manifest.json  上次同步后每个文件的 id、sha256 和 stat：下次只拉变了的
// 跑之前把 workspace 变成和空间一模一样（多的删掉、缺的和变了的写进去），跑完对比前后，得出新建、改动、删掉的文件。
// 从不跟随符号链接（跳过并报告），设备、管道这类特殊文件不理。
import { createHash } from "node:crypto"
import { createReadStream, type Stats } from "node:fs"
import { lstat, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { normalizeSpacePath, RESERVED_SPACE_DIRS, SpacePathError, type SpaceEntry } from "../files/service.js"

/** 不同步、也不清理的目录名（任意一层）：装包和缓存，同步回去会塞满空间 */
export const IGNORED_DIR_NAMES = new Set(["node_modules", "__pycache__"])

export interface SessionDirs {
  root: string
  workspace: string
  ro: string
  home: string
  code: string
  proxy: string
  manifest: string
}

export function sessionDirs(base: string, sessionId: string): SessionDirs {
  // session id 本来就只有字母数字和横线；保险起见别的字符换掉，不让它跳出 base
  const name = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_"
  const root = join(base, name)
  return {
    root,
    workspace: join(root, "workspace"),
    ro: join(root, "ro"),
    home: join(root, "home"),
    code: join(root, "code"),
    proxy: join(root, "p"),
    manifest: join(root, "manifest.json"),
  }
}

/** 文件的 stat 指纹：内容变了这几个至少有一个会变（ctime 用户改不了） */
export interface StatPrint {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
}

export interface ManifestFile extends StatPrint {
  id: string
  sha256: string
}

export interface Manifest {
  /** workspace 里的文件（相对 /workspace 的路径） */
  files: Record<string, ManifestFile>
  /** ro 下的只读文件（完整路径，例如 attachments/报价.xlsx）：只记 id 和 sha256，内容只有我们写 */
  readonly: Record<string, { id: string; sha256: string }>
}

const printOf = (stats: Stats): StatPrint => ({ size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino })
export const samePrint = (a: StatPrint, b: StatPrint) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino

async function loadManifest(path: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Manifest
    return { files: parsed.files ?? {}, readonly: parsed.readonly ?? {} }
  } catch {
    return { files: {}, readonly: {} }
  }
}

export async function saveManifest(dirs: SessionDirs, manifest: Manifest) {
  await writeFile(dirs.manifest, JSON.stringify(manifest))
}

export interface ScanResult {
  /** 普通文件：相对路径 → stat 指纹 */
  files: Map<string, StatPrint>
  /** 没法同步的：符号链接、特殊文件、路径不合规矩的 */
  skipped: { path: string; reason: string }[]
}

/**
 * 扫一遍 workspace（不跟随符号链接）。顶层的保留目录（只读挂载点）和 node_modules / __pycache__ 不进结果。
 * 路径按空间的规矩检查（层数、长度……），不合规矩的放进 skipped
 */
export async function scanWorkspace(workspace: string): Promise<ScanResult> {
  const files = new Map<string, StatPrint>()
  const skipped: ScanResult["skipped"] = []
  const walk = async (dir: string, prefix: string) => {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    names.sort()
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name
      if (!prefix && (RESERVED_SPACE_DIRS as readonly string[]).includes(name)) continue
      const full = join(dir, name)
      let stats: Stats
      try {
        stats = await lstat(full)
      } catch {
        continue
      }
      if (stats.isSymbolicLink()) {
        skipped.push({ path: rel, reason: "是符号链接，不跟随" })
        continue
      }
      if (stats.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(name)) continue
        await walk(full, rel)
        continue
      }
      if (!stats.isFile()) {
        skipped.push({ path: rel, reason: "不是普通文件" })
        continue
      }
      try {
        if (normalizeSpacePath(rel) !== rel) throw new SpacePathError("路径不规范")
      } catch (error) {
        skipped.push({ path: rel, reason: (error as Error).message })
        continue
      }
      files.set(rel, printOf(stats))
    }
  }
  await walk(workspace, "")
  return { files, skipped }
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

/** 把一个路径上挡路的东西清掉：目标位置是目录就删掉；上层某一级是文件也删掉 */
async function clearWay(root: string, rel: string) {
  const parts = rel.split("/")
  let current = root
  for (let index = 0; index < parts.length - 1; index++) {
    current = join(current, parts[index]!)
    const stats = await lstat(current).catch(() => undefined)
    if (stats && !stats.isDirectory()) await rm(current, { force: true })
  }
  const target = join(root, rel)
  const stats = await lstat(target).catch(() => undefined)
  if (stats && (stats.isDirectory() || stats.isSymbolicLink())) await rm(target, { recursive: true, force: true })
}

export interface PreparedWorkspace {
  dirs: SessionDirs
  manifest: Manifest
  /** 跑之前 workspace 里每个文件（= 空间里 agent 写的文件）的指纹和 sha256 */
  before: Map<string, ManifestFile>
  /** 只读挂到 /workspace/<name> 的目录 */
  readonlyDirs: { host: string; name: string }[]
  /** 放不进去的空间文件（路径和只读目录撞了这类，极少见） */
  conflicts: string[]
}

/**
 * 跑之前：把 workspace 和 ro 变成和空间一模一样。只写缺的和变了的（按 manifest 里的 id、sha256 和 stat 判断），
 * 空间里没有的文件删掉（被 file.delete 删了的、上次没写回的），node_modules / __pycache__ 留着
 */
export async function prepareWorkspace(
  dirs: SessionDirs,
  entries: SpaceEntry[],
  read: (entry: SpaceEntry) => Promise<Buffer>
): Promise<PreparedWorkspace> {
  for (const dir of [dirs.workspace, dirs.home, dirs.code, dirs.proxy]) await mkdir(dir, { recursive: true })
  for (const name of RESERVED_SPACE_DIRS) {
    await mkdir(join(dirs.ro, name), { recursive: true })
    // 只读目录的挂载点
    await clearWay(dirs.workspace, name)
    await mkdir(join(dirs.workspace, name), { recursive: true })
  }
  const manifest = await loadManifest(dirs.manifest)
  const conflicts: string[] = []

  // agent 写的 → workspace
  const writable = new Map<string, SpaceEntry>()
  const readonly = new Map<string, SpaceEntry>()
  for (const entry of entries) {
    const top = entry.path.split("/")[0]!
    const reservedTop = (RESERVED_SPACE_DIRS as readonly string[]).includes(top)
    if (entry.writable && !reservedTop) writable.set(entry.path, entry)
    else if (!entry.writable && reservedTop && entry.path.includes("/")) readonly.set(entry.path, entry)
    else conflicts.push(entry.path)
  }
  const scan = await scanWorkspace(dirs.workspace)
  // 空间里没有的：删掉（符号链接、特殊文件也删）
  for (const path of scan.files.keys())
    if (!writable.has(path)) {
      await rm(join(dirs.workspace, path), { force: true })
      delete manifest.files[path]
    }
  for (const item of scan.skipped) await rm(join(dirs.workspace, item.path), { recursive: true, force: true })
  for (const path of Object.keys(manifest.files)) if (!writable.has(path)) delete manifest.files[path]

  const before = new Map<string, ManifestFile>()
  for (const [path, entry] of writable) {
    const known = manifest.files[path]
    const onDisk = scan.files.get(path)
    let file: ManifestFile
    if (known && onDisk && known.id === entry.row.id && known.sha256 === entry.row.sha256 && samePrint(known, onDisk)) {
      file = known
    } else {
      await clearWay(dirs.workspace, path)
      const full = join(dirs.workspace, path)
      await mkdir(dirname(full), { recursive: true })
      // 先删再写：代码可能把它改成了只读
      await rm(full, { force: true })
      await writeFile(full, await read(entry))
      // 修改时间设成这个文件在空间里的更新时间：ls -l 看得懂；而且和「现在」不同，代码之后改了它（哪怕大小不变、
      // 落在内核时间戳的同一个粗粒度刻度里）修改时间也一定会变
      await utimes(full, entry.row.updatedAt, entry.row.updatedAt)
      file = { id: entry.row.id, sha256: entry.row.sha256, ...printOf(await lstat(full)) }
    }
    manifest.files[path] = file
    before.set(path, file)
  }

  // 只读来源 → ro/<目录>/...
  const roScan = new Map<string, true>()
  for (const name of RESERVED_SPACE_DIRS) {
    const sub = await scanAll(join(dirs.ro, name), name)
    for (const path of sub) roScan.set(path, true)
  }
  for (const path of roScan.keys())
    if (!readonly.has(path)) {
      await rm(join(dirs.ro, path), { recursive: true, force: true })
      delete manifest.readonly[path]
    }
  for (const [path, entry] of readonly) {
    const known = manifest.readonly[path]
    if (known && roScan.has(path) && known.id === entry.row.id && known.sha256 === entry.row.sha256) continue
    await clearWay(dirs.ro, path)
    const full = join(dirs.ro, path)
    await mkdir(dirname(full), { recursive: true })
    await rm(full, { force: true })
    await writeFile(full, await read(entry), { mode: 0o444 })
    await utimes(full, entry.row.updatedAt, entry.row.updatedAt)
    manifest.readonly[path] = { id: entry.row.id, sha256: entry.row.sha256 }
  }
  for (const path of Object.keys(manifest.readonly)) if (!readonly.has(path)) delete manifest.readonly[path]
  await saveManifest(dirs, manifest)
  return {
    dirs,
    manifest,
    before,
    readonlyDirs: RESERVED_SPACE_DIRS.map((name) => ({ host: join(dirs.ro, name), name })),
    conflicts,
  }
}

/** ro 下的全部条目（文件、链接都算，只有我们写；拿来清理） */
async function scanAll(dir: string, prefix: string): Promise<string[]> {
  const out: string[] = []
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    const full = join(dir, name)
    const rel = `${prefix}/${name}`
    const stats = await lstat(full).catch(() => undefined)
    if (stats?.isDirectory()) out.push(...(await scanAll(full, rel)))
    else if (stats) out.push(rel)
  }
  return out
}

export interface WorkspaceChange {
  path: string
  kind: "create" | "update"
  size: number
  sha256: string
  print: StatPrint
}

export interface WorkspaceDiff {
  changes: WorkspaceChange[]
  deleted: string[]
  skipped: ScanResult["skipped"]
}

/**
 * 跑完：对比前后。stat 指纹没变的算没改；变了的再算 sha256，内容一样（只是被 touch 了）也算没改，只更新指纹。
 * 结果按路径排序（确定的）
 */
export async function diffWorkspace(prepared: PreparedWorkspace): Promise<WorkspaceDiff> {
  const { dirs, before, manifest } = prepared
  const scan = await scanWorkspace(dirs.workspace)
  const changes: WorkspaceChange[] = []
  const skipped = [...scan.skipped]
  for (const [path, print] of [...scan.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const old = before.get(path)
    if (old && samePrint(old, print)) continue
    let sha256: string
    try {
      sha256 = await sha256OfFile(join(dirs.workspace, path))
    } catch (error) {
      // 例如代码把权限改成了 000：不写回，也不当成删掉
      skipped.push({ path, reason: `读不了（${(error as NodeJS.ErrnoException).code ?? (error as Error).message}）` })
      if (old) scan.files.set(path, print)
      continue
    }
    if (old && old.sha256 === sha256) {
      manifest.files[path] = { ...old, ...print }
      continue
    }
    changes.push({ path, kind: old ? "update" : "create", size: print.size, sha256, print })
  }
  const deleted = [...before.keys()].filter((path) => !scan.files.has(path)).sort()
  return { changes, deleted, skipped }
}

/** session 结束：删掉它的沙箱目录 */
export async function removeSessionDirs(base: string, sessionId: string) {
  await rm(sessionDirs(base, sessionId).root, { recursive: true, force: true })
}
