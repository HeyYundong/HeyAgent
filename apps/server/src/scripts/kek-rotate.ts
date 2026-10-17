// 主密钥（KEK）轮换和检查（docs/dev/release.md 第 3 节，运维步骤见 docs/ops.md「主密钥轮换」）。
// 信封加密见 lib/crypto.ts：数据用每行一把的 DEK 加密，DEK 再用 KEK 包起来。轮换只重新包 DEK，数据本身不动。
//
// 用法（开发机：pnpm --filter @heyagent/server kek:rotate <子命令>；容器里：node dist/scripts/kek-rotate.js <子命令>）：
//   （不带子命令）         开发机一步做完：KEK 文件追加一把新版本 + 库里所有密文用新版本重新包 DEK。跑完要重启 api 和 worker
//   status [--json] [--keyfile <文件>|-]
//                          列出 KEK 的版本和指纹、库里每张表的密文各用哪个版本，并逐行试解密。有解不开的退出码 1
//   add-key [--stdout]     追加一把新版本。默认直接改 HEYAGENT_KEK_FILE；--stdout 把新的完整 KEK 文件写到标准输出（服务器上用，见 ops.md）
//   rewrap [--dry-run]     把库里还在用旧版本的密文改用最新版本包 DEK（要先让 KEK 文件里有新版本）
//   prune [--stdout] [--yes]
//                          只留最新的一把（确认库里已经没有任何密文用旧版本才做）。直接改文件要加 --yes
//   verify-backup <kek-status.json>|-
//                          核对当前的 KEK 能不能解开某次备份（scripts/backup.sh 存的 kek-status.json）
//
// 任何输出都不含密钥本身：只有版本号和指纹（sha256 的前 16 位，从它推不出密钥）。
// --stdout 输出的是密钥文件，只能重定向到文件或管道，终端上直接跑会拒绝。
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

import pg from "pg"

import { env } from "../env.js"
import { decrypt, parseKeyring, rewrap, type Envelope, type Keyring } from "../lib/crypto.js"

/**
 * 库里所有存密文的表。AAD 是「表名:行 id:version」（见 lib/crypto.ts），所以要知道每张表用哪一列当 id。
 * 约定：密文列一律叫 enc（jsonb）、版本列叫 version。新加了存密文的表，必须登记在这里，
 * 否则 status 会报「未登记的密文表」并以退出码 1 结束，rewrap 和 prune 也会拒绝执行（免得删掉还在用的旧密钥）。
 */
export const ENCRYPTED_TABLES = [
  { table: "secrets", idColumn: "id" },
  { table: "browser_vaults", idColumn: "profile_id" },
] as const

type Queryable = Pick<pg.Pool, "query">

/** KEK 的指纹：用来核对「两边是不是同一把」，不暴露密钥 */
export function fingerprint(version: number, key: Buffer) {
  return createHash("sha256").update(`heyagent-kek:${version}:`).update(key).digest("hex").slice(0, 16)
}

export function describeKeyring(keyring: Keyring) {
  return {
    current: keyring.current,
    keys: [...keyring.keys.entries()].sort(([a], [b]) => a - b).map(([version, key]) => ({ version, fingerprint: fingerprint(version, key) })),
  }
}

export interface TableStatus {
  table: string
  rows: number
  /** KEK 版本 → 行数 */
  byKek: Record<string, number>
}

export interface ScanResult {
  keyring: ReturnType<typeof describeKeyring>
  tables: TableStatus[]
  /** 还在用旧版本 KEK 的行数 */
  stale: number
  /** 解不开的行（只有表名、id、版本和原因，没有内容） */
  failures: { table: string; id: string; kek: number; error: string }[]
  /** 有 enc 列、却没登记在 ENCRYPTED_TABLES 里的表 */
  unknownTables: string[]
}

interface EncRow {
  id: string
  version: number
  enc: Envelope
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

async function readRows(db: Queryable, table: string, idColumn: string, where = ""): Promise<EncRow[]> {
  const { rows } = await db.query<EncRow>(`select ${quote(idColumn)} as id, version, enc from ${quote(table)} ${where} order by 1`)
  return rows
}

export async function findUnknownTables(db: Queryable) {
  const { rows } = await db.query<{ table_name: string }>(
    "select table_name from information_schema.columns where table_schema = current_schema() and column_name = 'enc' and data_type = 'jsonb' order by 1"
  )
  const known = new Set<string>(ENCRYPTED_TABLES.map((each) => each.table))
  return rows.map((row) => row.table_name).filter((name) => !known.has(name))
}

/** 逐行试解密（解开就丢掉明文），统计每张表各版本的行数 */
export async function scan(db: Queryable, keyring: Keyring): Promise<ScanResult> {
  const result: ScanResult = { keyring: describeKeyring(keyring), tables: [], stale: 0, failures: [], unknownTables: await findUnknownTables(db) }
  for (const { table, idColumn } of ENCRYPTED_TABLES) {
    const rows = await readRows(db, table, idColumn)
    const status: TableStatus = { table, rows: rows.length, byKek: {} }
    for (const row of rows) {
      const kek = Number(row.enc?.kek)
      status.byKek[String(kek)] = (status.byKek[String(kek)] ?? 0) + 1
      // 比最新版本还新的（KEK 文件拿错了）算解不开，不算「旧版本」
      if (kek < keyring.current) result.stale++
      try {
        decrypt(keyring, row.enc, { table, id: row.id, version: row.version }).fill(0)
      } catch (error) {
        result.failures.push({ table, id: row.id, kek, error: (error as Error).message })
      }
    }
    result.tables.push(status)
  }
  return result
}

export interface RewrapResult {
  /** 改成最新版本的行数 */
  rewrapped: number
  /** 改的时候被别人同时改了、重新读过的次数 */
  retried: number
  /** 包不了的行（缺旧版本的 KEK 等），原样留着 */
  failures: ScanResult["failures"]
}

/**
 * 把还在用旧版本 KEK 的密文改用最新版本包 DEK。每行一个小事务，条件是「密文还是刚才读到的那份」：
 * 同时有人改了这一行（例如浏览器回写登录态），这一行就重读一遍再试，不会覆盖别人的新数据。
 * 不改 version、updated_at，也不发实时推送（内容没变）。
 */
export async function rewrapAll(pool: pg.Pool, keyring: Keyring, options: { dryRun?: boolean; maxPasses?: number } = {}): Promise<RewrapResult> {
  const unknown = await findUnknownTables(pool)
  if (unknown.length) throw new Error(`发现没登记的密文表：${unknown.join("、")}。先在 kek-rotate.ts 的 ENCRYPTED_TABLES 里登记`)
  const result: RewrapResult = { rewrapped: 0, retried: 0, failures: [] }
  const failed = new Set<string>()
  const client = await pool.connect()
  try {
    for (let pass = 0; pass < (options.maxPasses ?? 5); pass++) {
      let conflicts = 0
      for (const { table, idColumn } of ENCRYPTED_TABLES) {
        const rows = await readRows(client, table, idColumn, `where (enc->>'kek')::int <> ${Number(keyring.current)}`)
        for (const row of rows) {
          const key = `${table}:${row.id}`
          if (failed.has(key)) continue
          let next: Envelope
          try {
            next = rewrap(keyring, row.enc, { table, id: row.id, version: row.version })
          } catch (error) {
            failed.add(key)
            result.failures.push({ table, id: row.id, kek: Number(row.enc?.kek), error: (error as Error).message })
            continue
          }
          if (options.dryRun) {
            result.rewrapped++
            continue
          }
          await client.query("begin")
          try {
            await client.query("select set_config('heyagent.skip_notify', 'on', true)")
            const updated = await client.query(
              `update ${quote(table)} set enc = $1::jsonb where ${quote(idColumn)} = $2 and version = $3 and enc = $4::jsonb`,
              [JSON.stringify(next), row.id, row.version, JSON.stringify(row.enc)]
            )
            await client.query("commit")
            if (updated.rowCount === 1) result.rewrapped++
            else conflicts++
          } catch (error) {
            await client.query("rollback")
            throw error
          }
        }
      }
      result.retried += conflicts
      if (options.dryRun || conflicts === 0) break
    }
  } finally {
    client.release()
  }
  return result
}

/**
 * prune 之前的最后一道保险：在所有 jsonb 列里找长得像信封（有 kek、dek、ct）却用着旧版本的值。
 * 只有 prune 用（要扫全部 jsonb 列，表大了会慢）
 */
export async function findStrayEnvelopes(db: Queryable, current: number) {
  const { rows: columns } = await db.query<{ table_name: string; column_name: string }>(
    "select c.table_name, c.column_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name) where c.table_schema = current_schema() and c.data_type = 'jsonb' and t.table_type = 'BASE TABLE' order by 1, 2"
  )
  const found: string[] = []
  for (const { table_name, column_name } of columns) {
    const col = quote(column_name)
    const { rows } = await db.query(
      `select 1 from ${quote(table_name)} where jsonb_typeof(${col}) = 'object' and ${col} ? 'kek' and ${col} ? 'dek' and ${col} ? 'ct' and (${col}->>'kek') <> $1 limit 1`,
      [String(current)]
    )
    if (rows.length) found.push(`${table_name}.${column_name}`)
  }
  return found
}

/** KEK 文件追加一把新版本（版本号 = 现有最大 + 1），原有的行和注释都保留 */
export function appendKey(text: string, now = new Date()) {
  const keyring = parseKeyring(text)
  const version = keyring.current + 1
  const body = text.endsWith("\n") || text === "" ? text : `${text}\n`
  const line = `${version}:${randomBytes(32).toString("base64")}`
  return { version, text: `${body}# v${version} 加于 ${now.toISOString().slice(0, 10)}\n${line}\n` }
}

/** 只留最新的一把 */
export function pruneKeyfile(text: string) {
  const keyring = parseKeyring(text)
  const key = keyring.keys.get(keyring.current)!
  return {
    version: keyring.current,
    removed: [...keyring.keys.keys()].filter((version) => version !== keyring.current).sort((a, b) => a - b),
    text: `# HeyAgent 主密钥（KEK），只留 v${keyring.current}。丢了就解不开库里的密钥和登录态，离线保管\n${keyring.current}:${key.toString("base64")}\n`,
  }
}

/** 核对当前 KEK 能不能解开一次备份：备份里用到的每个版本，当前文件里都要有、而且指纹一样 */
export function checkBackupKeys(keyring: Keyring, backup: Pick<ScanResult, "keyring" | "tables">) {
  const mine = new Map(describeKeyring(keyring).keys.map((each) => [each.version, each.fingerprint]))
  const theirs = new Map(backup.keyring.keys.map((each) => [each.version, each.fingerprint]))
  const used = [...new Set(backup.tables.flatMap((table) => Object.keys(table.byKek).map(Number)))].sort((a, b) => a - b)
  const problems: string[] = []
  for (const version of used) {
    const want = theirs.get(version)
    const have = mine.get(version)
    if (!have) problems.push(`缺 KEK v${version}`)
    else if (want && want !== have) problems.push(`KEK v${version} 不是同一把（指纹 ${have}，备份时是 ${want}）`)
  }
  return { used, problems }
}

// ---------- 命令行 ----------

function readStdin() {
  return readFileSync(0, "utf8")
}

/** 先写临时文件再改名：写到一半断电也不会留下半个 KEK 文件。权限固定 600 */
function writeKeyfileInPlace(file: string, text: string) {
  parseKeyring(text)
  const tmp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  } catch (error) {
    // 改名失败时别把带密钥的临时文件留在那里
    rmSync(tmp, { force: true })
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
      throw new Error(`改不了 ${file}（${code}）。服务器上的 KEK 是 Podman secret，只读挂载：改用 --stdout，步骤见 docs/ops.md「主密钥轮换」`, { cause: error })
    }
    throw error
  }
}

function writeKeyfileToStdout(text: string) {
  if (process.stdout.isTTY) throw new Error("--stdout 输出的是密钥文件，不能直接打在终端上：重定向到文件（先 umask 077）或管道")
  process.stdout.write(text)
}

/**
 * 服务器上的 pod（deploy/quadlet/heyagent.yaml）不把 DATABASE_URL 放进容器配置（密码在 Podman secret 里），
 * 由启动命令现拼；podman exec 进来跑这个脚本时没有它，按同样的规则拼（两处要一起改）
 */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const file = process.env.HEYAGENT_DB_PASSWORD_FILE
  if (file) return `postgres://heyagent:${encodeURIComponent(readFileSync(file, "utf8").trim())}@127.0.0.1:5432/heyagent`
  return env.databaseUrl
}

function printStatus(result: ScanResult, file: string) {
  const log = (line = "") => console.log(line)
  log(`KEK 文件：${file}`)
  for (const { version, fingerprint: fp } of result.keyring.keys) {
    log(`  v${version}  指纹 ${fp}${version === result.keyring.current ? "  ← 最新，新数据用它" : ""}`)
  }
  log("库里的密文：")
  for (const table of result.tables) {
    const parts = Object.entries(table.byKek)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([version, n]) => `v${version} ${n} 行`)
    log(`  ${table.table.padEnd(16)} ${String(table.rows).padStart(5)} 行${parts.length ? `：${parts.join("，")}` : ""}`)
  }
  if (result.unknownTables.length) log(`✗ 有 enc 列但没登记的表：${result.unknownTables.join("、")}（先在 kek-rotate.ts 登记）`)
  if (result.failures.length) {
    log(`✗ ${result.failures.length} 行解不开：`)
    for (const each of result.failures.slice(0, 20)) log(`    ${each.table} ${each.id}（KEK v${each.kek}）：${each.error}`)
    if (result.failures.length > 20) log(`    ……还有 ${result.failures.length - 20} 行`)
  } else {
    log("✓ 全部能解开")
  }
  if (result.stale) log(`还有 ${result.stale} 行用的是旧版本，跑 rewrap 改成 v${result.keyring.current}`)
  else log(`✓ 全部用的是最新的 v${result.keyring.current}`)
}

function loadKeyfile(source: string | undefined) {
  if (source === "-") return { file: "（标准输入）", text: readStdin() }
  const file = source ?? env.kekFile
  return { file, text: readFileSync(file, "utf8") }
}

function argValue(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value) throw new Error(`${name} 后面要跟参数`)
  return value
}

async function withPool<T>(fn: (pool: pg.Pool) => Promise<T>) {
  const pool = new pg.Pool({ connectionString: databaseUrl(), max: 2 })
  try {
    return await fn(pool)
  } finally {
    await pool.end()
  }
}

export async function main(args: string[]): Promise<number> {
  const [command = "rotate", ...rest] = args
  const has = (flag: string) => rest.includes(flag)

  switch (command) {
    case "status": {
      const { file, text } = loadKeyfile(argValue(rest, "--keyfile"))
      const result = await withPool((pool) => scan(pool, parseKeyring(text)))
      if (has("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      else printStatus(result, file)
      return result.failures.length || result.unknownTables.length ? 1 : 0
    }

    case "add-key": {
      const file = env.kekFile
      const { version, text } = appendKey(readFileSync(file, "utf8"))
      if (has("--stdout")) {
        writeKeyfileToStdout(text)
        console.error(`已输出新的 KEK 文件（加了 v${version}，旧版本都还在）`)
      } else {
        writeKeyfileInPlace(file, text)
        console.log(`已在 ${file} 追加 KEK v${version}。接下来：重启 api 和 worker（它们启动时才读 KEK），再跑 rewrap`)
      }
      return 0
    }

    case "rewrap": {
      const { file, text } = loadKeyfile(argValue(rest, "--keyfile"))
      const keyring = parseKeyring(text)
      return withPool(async (pool) => {
        const dryRun = has("--dry-run")
        const result = await rewrapAll(pool, keyring, { dryRun })
        console.log(`${dryRun ? "（试运行，没有写库）要" : "已"}把 ${result.rewrapped} 行改用 KEK v${keyring.current} 包 DEK${result.retried ? `；${result.retried} 行改的时候被同时改了，重读后再处理` : ""}`)
        for (const each of result.failures) console.error(`  ✗ ${each.table} ${each.id}（KEK v${each.kek}）：${each.error}`)
        const after = await scan(pool, keyring)
        printStatus(after, file)
        return after.failures.length || after.unknownTables.length || result.failures.length ? 1 : 0
      })
    }

    case "prune": {
      const file = env.kekFile
      const text = readFileSync(file, "utf8")
      const keyring = parseKeyring(text)
      const problems = await withPool(async (pool) => {
        const result = await scan(pool, keyring)
        const list: string[] = []
        if (result.unknownTables.length) list.push(`有没登记的密文表：${result.unknownTables.join("、")}`)
        if (result.failures.length) list.push(`${result.failures.length} 行解不开`)
        if (result.stale) list.push(`还有 ${result.stale} 行用旧版本（先跑 rewrap）`)
        const stray = await findStrayEnvelopes(pool, keyring.current)
        if (stray.length) list.push(`这些列里还有旧版本的密文：${stray.join("、")}`)
        return list
      })
      if (problems.length) {
        console.error(`不能删旧密钥：\n  ${problems.join("\n  ")}`)
        return 1
      }
      const pruned = pruneKeyfile(text)
      if (!pruned.removed.length) {
        console.error(`KEK 文件里只有 v${pruned.version}，不用删`)
        return 0
      }
      if (has("--stdout")) {
        writeKeyfileToStdout(pruned.text)
        console.error(`已输出只留 v${pruned.version} 的 KEK 文件（去掉了 ${pruned.removed.map((v) => `v${v}`).join("、")}）`)
      } else {
        if (!has("--yes")) {
          console.error(`会从 ${file} 删掉 ${pruned.removed.map((v) => `v${v}`).join("、")}，只留 v${pruned.version}。用这些旧版本做的备份以后就要靠离线保存的旧密钥来恢复。确认就加 --yes 再跑一次`)
          return 1
        }
        writeKeyfileInPlace(file, pruned.text)
        console.error(`已从 ${file} 删掉 ${pruned.removed.map((v) => `v${v}`).join("、")}，只留 v${pruned.version}。重启 api 和 worker`)
      }
      return 0
    }

    case "verify-backup": {
      const source = rest[0]
      if (!source) throw new Error("用法：verify-backup <备份目录里的 kek-status.json>|-")
      const backup = JSON.parse(source === "-" ? readStdin() : readFileSync(source, "utf8")) as ScanResult
      const { used, problems } = checkBackupKeys(parseKeyring(readFileSync(env.kekFile, "utf8")), backup)
      if (problems.length) {
        console.error(`✗ 当前的 KEK 解不开这次备份：${problems.join("；")}`)
        return 1
      }
      console.log(`✓ 当前的 KEK 能解开这次备份（备份用到 ${used.length ? used.map((v) => `v${v}`).join("、") : "没有密文"}）`)
      return 0
    }

    case "rotate": {
      if (has("--dry-run")) throw new Error("一步轮换不支持 --dry-run：想先看看要改多少行，用 rewrap --dry-run")
      const file = env.kekFile
      const { version, text } = appendKey(readFileSync(file, "utf8"))
      writeKeyfileInPlace(file, text)
      console.log(`已在 ${file} 追加 KEK v${version}`)
      const code = await main(["rewrap", ...rest])
      console.log("别忘了：重启 api 和 worker（它们启动时才读 KEK 文件，不重启就解不开刚改过的密文）。旧版本等确认都换完、旧备份也过期了再用 prune 删")
      return code
    }

    default:
      console.error("用法：kek-rotate [status|add-key|rewrap|prune|verify-backup]，说明见 apps/server/src/scripts/kek-rotate.ts 开头")
      return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`)
    process.exitCode = 1
  }
}
