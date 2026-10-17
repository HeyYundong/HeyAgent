import { describe, expect, it } from "vitest"

import { decryptText, encrypt, mask, newKekLine, parseKeyring, rewrap } from "../src/lib/crypto.js"

const keyring = parseKeyring(`# 注释行\n${newKekLine(1)}\n`)
const parts = { table: "secrets", id: "sec-1", version: 1 }

describe("信封加密", () => {
  it("能解回原文，每次密文都不同", () => {
    const a = encrypt(keyring, "sk-or-v1-secret-value", parts)
    const b = encrypt(keyring, "sk-or-v1-secret-value", parts)
    expect(decryptText(keyring, a, parts)).toBe("sk-or-v1-secret-value")
    expect(a.ct).not.toBe(b.ct)
    expect(a.dek).not.toBe(b.dek)
    expect(JSON.stringify(a)).not.toContain("secret-value")
  })

  it("换了行 id 解不开", () => {
    const envelope = encrypt(keyring, "value", parts)
    expect(() => decryptText(keyring, envelope, { ...parts, id: "sec-2" })).toThrow()
  })

  it("改了版本号解不开", () => {
    const envelope = encrypt(keyring, "value", parts)
    expect(() => decryptText(keyring, envelope, { ...parts, version: 2 })).toThrow()
  })

  it("换了表名解不开", () => {
    const envelope = encrypt(keyring, "value", parts)
    expect(() => decryptText(keyring, envelope, { ...parts, table: "browser_vaults" })).toThrow()
  })

  it("KEK 不对解不开", () => {
    const envelope = encrypt(keyring, "value", parts)
    const other = parseKeyring(newKekLine(1))
    expect(() => decryptText(other, envelope, parts)).toThrow()
  })

  it("密文被改过解不开", () => {
    const envelope = encrypt(keyring, "value", parts)
    const ct = Buffer.from(envelope.ct, "base64")
    ct[0] = ct[0]! ^ 1
    expect(() => decryptText(keyring, { ...envelope, ct: ct.toString("base64") }, parts)).toThrow()
  })

  it("KEK 轮换：加了新版本后旧数据还能解，rewrap 后改用新版本、去掉旧 KEK 也能解", () => {
    const envelope = encrypt(keyring, "value", parts)
    const v1 = keyring.keys.get(1)!.toString("base64")
    const both = parseKeyring(`1:${v1}\n${newKekLine(2)}`)
    expect(both.current).toBe(2)
    expect(decryptText(both, envelope, parts)).toBe("value")
    const rewrapped = rewrap(both, envelope, parts)
    expect(rewrapped.kek).toBe(2)
    expect(rewrapped.ct).toBe(envelope.ct)
    const onlyV2 = parseKeyring(`2:${both.keys.get(2)!.toString("base64")}`)
    expect(decryptText(onlyV2, rewrapped, parts)).toBe("value")
    expect(() => decryptText(onlyV2, envelope, parts)).toThrow(/KEK v1/)
  })

  it("KEK 文件格式不对时报错", () => {
    expect(() => parseKeyring("")).toThrow()
    expect(() => parseKeyring("1:abc")).toThrow(/32 字节/)
    expect(() => parseKeyring("not a key")).toThrow()
  })

  it("掩码只留开头和结尾", () => {
    expect(mask("sk-or-v1-0000demo0000demo3f2a", 9)).toBe("sk-or-v1-••••••••3f2a")
    expect(mask("short")).toBe("••••••••")
  })
})
