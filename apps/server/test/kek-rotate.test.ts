// 主密钥轮换（src/scripts/kek-rotate.ts）：在灌了演示数据的测试库上加新版本、重新包 DEK、删旧版本，
// 中间每一步都核对「全部能解开、数据本身没重新加密、并发改过的行不会被覆盖」。
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createDb } from "../src/db/client.js"
import { decryptText, encrypt, newKekLine, parseKeyring, type Envelope } from "../src/lib/crypto.js"
import {
  appendKey,
  checkBackupKeys,
  describeKeyring,
  ENCRYPTED_TABLES,
  findStrayEnvelopes,
  findUnknownTables,
  main,
  pruneKeyfile,
  rewrapAll,
  scan,
  type ScanResult,
} from "../src/scripts/kek-rotate.js"
import { seedDemo } from "../src/seed/seed.js"
import { PASSWORD, resetTestDatabase, testDatabaseUrl } from "./helpers.js"

const url = testDatabaseUrl()
const v1Text = `# 测试用 KEK\n${newKekLine(1)}\n`
const v1 = parseKeyring(v1Text)
// 整个文件共用同一把 v2（appendKey 每次都生成新的随机密钥）
const v2Text = appendKey(v1Text).text
const { db, pool } = createDb(url, 4)

async function envelopes() {
  const out: { table: string; id: string; version: number; enc: Envelope }[] = []
  for (const { table, idColumn } of ENCRYPTED_TABLES) {
    const { rows } = await pool.query(`select "${idColumn}" as id, version, enc from "${table}" order by 1`)
    out.push(...rows.map((row) => ({ table, ...row })))
  }
  return out
}

beforeAll(async () => {
  await resetTestDatabase(url)
  await seedDemo(db, v1, { password: PASSWORD })
})
afterAll(async () => {
  await pool.end()
})

describe("KEK 文件", () => {
  it("appendKey 追加下一个版本，原有的行和注释都在", () => {
    const { version, text } = appendKey(v1Text, new Date("2026-10-17T03:00:00Z"))
    expect(version).toBe(2)
    expect(text.startsWith(v1Text)).toBe(true)
    expect(text).toContain("# v2 加于 2026-10-17")
    const both = parseKeyring(text)
    expect(both.current).toBe(2)
    expect(both.keys.get(1)!.equals(v1.keys.get(1)!)).toBe(true)
    // 没有结尾换行的文件也能接上
    expect(parseKeyring(appendKey(v1Text.trimEnd()).text).keys.size).toBe(2)
  })

  it("pruneKeyfile 只留最新的一把", () => {
    const { text } = appendKey(v1Text)
    const pruned = pruneKeyfile(text)
    expect(pruned.version).toBe(2)
    expect(pruned.removed).toEqual([1])
    const only = parseKeyring(pruned.text)
    expect([...only.keys.keys()]).toEqual([2])
    expect(only.keys.get(2)!.equals(parseKeyring(text).keys.get(2)!)).toBe(true)
  })

  it("指纹不含密钥本身，版本或密钥不同指纹就不同", () => {
    const desc = describeKeyring(parseKeyring(appendKey(v1Text).text))
    expect(desc.keys.map((each) => each.version)).toEqual([1, 2])
    expect(desc.keys[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(desc.keys[0]!.fingerprint).not.toBe(desc.keys[1]!.fingerprint)
    expect(JSON.stringify(desc)).not.toContain(v1.keys.get(1)!.toString("base64"))
    expect(describeKeyring(parseKeyring(newKekLine(1))).keys[0]!.fingerprint).not.toBe(desc.keys[0]!.fingerprint)
  })
})

describe("扫描和重新包 DEK", () => {
  const both = parseKeyring(v2Text)
  const onlyV2 = parseKeyring(pruneKeyfile(v2Text).text)

  it("演示数据里两张表都有密文，全部能用 v1 解开", async () => {
    const result = await scan(pool, v1)
    expect(result.unknownTables).toEqual([])
    expect(result.failures).toEqual([])
    expect(result.stale).toBe(0)
    for (const table of result.tables) expect(table.rows).toBeGreaterThan(0)
    expect(result.tables.map((table) => table.table)).toEqual(["secrets", "browser_vaults"])
  })

  it("加了 v2 以后：旧密文都还能解，算作「旧版本」；只有 v2 时全部解不开", async () => {
    const total = (await envelopes()).length
    const withBoth = await scan(pool, both)
    expect(withBoth.failures).toEqual([])
    expect(withBoth.stale).toBe(total)
    const withV2 = await scan(pool, onlyV2)
    expect(withV2.failures).toHaveLength(total)
    expect(withV2.failures[0]!.error).toMatch(/KEK v1/)
  })

  it("prune 前的保险：能在 jsonb 列里找到旧版本的密文", async () => {
    expect((await findStrayEnvelopes(pool, 2)).sort()).toEqual(["browser_vaults.enc", "secrets.enc"])
  })

  it("rewrap 只换 DEK 的包装：数据密文、version、updated_at 都不变；同时被改过的行重读后再包，不覆盖别人的新数据", async () => {
    const before = await envelopes()
    const { rows: [stamp] } = await pool.query("select updated_at from secrets order by id limit 1")

    // 模拟「rewrap 读完之后、写之前，浏览器回写了一次登录态」（回写的进程还没重启，用的是旧的 v1）
    const vault = before.find((each) => each.table === "browser_vaults")!
    const racer = new pg.Pool({ connectionString: url, max: 1 })
    let raced = false
    const wrapped = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect()
        const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>
        ;(client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
          if (!raced && typeof args[0] === "string" && args[0].startsWith('update "browser_vaults"')) {
            raced = true
            const next = vault.version + 1
            const enc = encrypt(v1, JSON.stringify({ cookies: [], origins: [], raced: true }), { table: "browser_vaults", id: vault.id, version: next })
            await racer.query("update browser_vaults set version = $1, enc = $2::jsonb where profile_id = $3", [next, JSON.stringify(enc), vault.id])
          }
          return original(...args)
        }
        return client
      },
    } as unknown as pg.Pool

    const result = await rewrapAll(wrapped, both)
    await racer.end()
    expect(raced).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.retried).toBe(1)
    expect(result.rewrapped).toBe(before.length)

    const after = await envelopes()
    for (const row of after) expect(row.enc.kek).toBe(2)
    // 没被并发改过的行：数据密文、iv、tag 一字不差，version 不变
    for (const old of before.filter((each) => each !== vault)) {
      const now = after.find((each) => each.table === old.table && each.id === old.id)!
      expect(now.version).toBe(old.version)
      expect([now.enc.ct, now.enc.iv, now.enc.tag]).toEqual([old.enc.ct, old.enc.iv, old.enc.tag])
      expect(now.enc.dek).not.toBe(old.enc.dek)
    }
    // 被并发改过的那行保留了对方写的新内容
    const raced2 = after.find((each) => each.table === "browser_vaults" && each.id === vault.id)!
    expect(raced2.version).toBe(vault.version + 1)
    expect(JSON.parse(decryptText(onlyV2, raced2.enc, { table: "browser_vaults", id: vault.id, version: raced2.version })).raced).toBe(true)

    const { rows: [stamp2] } = await pool.query("select updated_at from secrets order by id limit 1")
    expect(stamp2.updated_at).toEqual(stamp.updated_at)

    // 只留 v2 也全部能解开，旧版本的密文一条都不剩
    const final = await scan(pool, onlyV2)
    expect(final.failures).toEqual([])
    expect(final.stale).toBe(0)
    expect(await findStrayEnvelopes(pool, 2)).toEqual([])
  })

  it("再跑一次 rewrap 什么都不改；--dry-run 不写库", async () => {
    expect((await rewrapAll(pool, both)).rewrapped).toBe(0)
    const v3 = parseKeyring(appendKey(v2Text).text)
    const before = await envelopes()
    const dry = await rewrapAll(pool, v3, { dryRun: true })
    expect(dry.rewrapped).toBe(before.length)
    expect(await envelopes()).toEqual(before)
  })

  it("缺 KEK 的行报出来、原样留着，不影响其他行", async () => {
    const [row] = await envelopes()
    const v9 = parseKeyring(newKekLine(9))
    const orphan = encrypt(v9, "x", { table: row!.table, id: row!.id, version: row!.version })
    const idColumn = ENCRYPTED_TABLES.find((each) => each.table === row!.table)!.idColumn
    await pool.query(`update "${row!.table}" set enc = $1::jsonb where "${idColumn}" = $2`, [JSON.stringify(orphan), row!.id])
    const v3 = parseKeyring(appendKey(v2Text).text)
    const result = await rewrapAll(pool, v3, { dryRun: true })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatchObject({ table: row!.table, id: row!.id, kek: 9 })
    expect((await scan(pool, v3)).failures).toHaveLength(1)
    // 还原成能解开的（后面的用例要用）
    await pool.query(`update "${row!.table}" set enc = $1::jsonb where "${idColumn}" = $2`, [JSON.stringify(row!.enc), row!.id])
  })

  it("有 enc 列却没登记的表：扫描报出来，rewrap 拒绝执行", async () => {
    await pool.query("create table kek_probe (id text primary key, version int not null, enc jsonb not null)")
    try {
      expect(await findUnknownTables(pool)).toEqual(["kek_probe"])
      expect((await scan(pool, both)).unknownTables).toEqual(["kek_probe"])
      await expect(rewrapAll(pool, both)).rejects.toThrow(/kek_probe/)
    } finally {
      await pool.query("drop table kek_probe")
    }
  })
})

describe("备份的密钥核对", () => {
  const backup: Pick<ScanResult, "keyring" | "tables"> = {
    keyring: describeKeyring(parseKeyring(v2Text)),
    tables: [
      { table: "secrets", rows: 3, byKek: { "1": 1, "2": 2 } },
      { table: "browser_vaults", rows: 0, byKek: {} },
    ],
  }

  it("同一套 KEK 能解开", () => {
    expect(checkBackupKeys(parseKeyring(v2Text), backup)).toEqual({ used: [1, 2], problems: [] })
  })

  it("缺版本、或者同一版本却不是同一把，都报出来", () => {
    expect(checkBackupKeys(parseKeyring(pruneKeyfile(v2Text).text), backup).problems).toEqual(["缺 KEK v1"])
    const other = parseKeyring(`${v1Text}${newKekLine(2)}\n`)
    expect(checkBackupKeys(other, backup).problems).toEqual([expect.stringMatching(/^KEK v2 不是同一把/)])
  })
})

describe("命令行（开发机的 pnpm kek:rotate）", () => {
  it("一步轮换：KEK 文件加一把、库里全部改用新版本；prune 要 --yes 才删旧版本", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heyagent-kek-cli-"))
    const file = join(dir, "kek")
    // 库里现在是 v2（上面的用例换过），文件从同一套 v1 + v2 开始
    const start = v2Text
    writeFileSync(file, start, { mode: 0o600 })
    const saved = { DATABASE_URL: process.env.DATABASE_URL, HEYAGENT_KEK_FILE: process.env.HEYAGENT_KEK_FILE }
    process.env.DATABASE_URL = url
    process.env.HEYAGENT_KEK_FILE = file
    try {
      expect(await main(["status"])).toBe(0)
      expect(await main([])).toBe(0)
      const rotated = readFileSync(file, "utf8")
      expect(rotated.startsWith(start)).toBe(true)
      expect(parseKeyring(rotated).current).toBe(3)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      for (const row of await envelopes()) expect(row.enc.kek).toBe(3)

      expect(await main(["prune"])).toBe(1)
      expect(readFileSync(file, "utf8")).toBe(rotated)
      expect(await main(["prune", "--yes"])).toBe(0)
      expect([...parseKeyring(readFileSync(file, "utf8")).keys.keys()]).toEqual([3])
      expect(await main(["status"])).toBe(0)

      const backupFile = join(dir, "kek-status.json")
      writeFileSync(backupFile, JSON.stringify(await scan(pool, parseKeyring(rotated))))
      expect(await main(["verify-backup", backupFile])).toBe(0)
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
