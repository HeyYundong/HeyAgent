// 信封加密（方案第 3 节）：每条数据一把随机 DEK，用 AES-256-GCM 加密；DEK 再用主密钥 KEK 包起来。
// - AAD 绑定「表名:行id:版本号」：密文被挪到别的行、或者版本号对不上，都解不开；
// - KEK 带版本号，可以轮换：新数据用最新的 KEK，旧数据用 rewrap 只重新包 DEK，不用重新加密数据。
// KEK 文件（HEYAGENT_KEK_FILE，开发时由 scripts/dev-kek.sh 生成在 .dev/kek，服务器上是 Podman secret）：
//   每行一把「版本号:base64(32 字节)」，# 开头是注释；版本号最大的那把用来加密新数据。
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"

const ALGORITHM = "aes-256-gcm"
const IV_BYTES = 12
const KEY_BYTES = 32

/** 存进库里的密文（jsonb）。二进制都用 base64 */
export interface Envelope {
  /** 信封格式版本 */
  v: 1
  /** 包 DEK 用的 KEK 版本 */
  kek: number
  /** 被 KEK 包起来的 DEK：iv(12) | tag(16) | 密文(32) */
  dek: string
  iv: string
  tag: string
  ct: string
}

/** 这份密文属于哪张表的哪一行、第几版 */
export interface AadParts {
  table: string
  id: string
  version: number
}

export interface Keyring {
  current: number
  keys: Map<number, Buffer>
}

export function parseKeyring(text: string): Keyring {
  const keys = new Map<number, Buffer>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(\d+):([A-Za-z0-9+/=]+)$/.exec(line)
    if (!match) throw new Error("KEK 文件格式不对：每行应该是「版本号:base64」")
    const version = Number(match[1])
    const key = Buffer.from(match[2]!, "base64")
    if (key.length !== KEY_BYTES) throw new Error(`KEK v${version} 不是 32 字节`)
    if (keys.has(version)) throw new Error(`KEK v${version} 重复`)
    keys.set(version, key)
  }
  if (keys.size === 0) throw new Error("KEK 文件里没有密钥")
  return { current: Math.max(...keys.keys()), keys }
}

export function loadKeyring(file: string): Keyring {
  return parseKeyring(readFileSync(file, "utf8"))
}

/** 生成一把新的 KEK 行（dev-kek.sh 用 openssl 做同样的事；测试里也用它） */
export const newKekLine = (version: number) => `${version}:${randomBytes(KEY_BYTES).toString("base64")}`

const aadOf = ({ table, id, version }: AadParts) => Buffer.from(`${table}:${id}:${version}`, "utf8")

function seal(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(aad)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { iv, tag: cipher.getAuthTag(), ct }
}

function open(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aad: Buffer) {
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

// DEK 的 AAD 也绑定同一行和 KEK 版本：DEK 不能被挪去解别的行
const dekAad = (parts: AadParts, kekVersion: number) => Buffer.concat([aadOf(parts), Buffer.from(`:kek${kekVersion}`)])

function wrapDek(keyring: Keyring, dek: Buffer, parts: AadParts, kekVersion = keyring.current) {
  const kek = keyring.keys.get(kekVersion)
  if (!kek) throw new Error(`没有 KEK v${kekVersion}`)
  const { iv, tag, ct } = seal(kek, dek, dekAad(parts, kekVersion))
  return Buffer.concat([iv, tag, ct]).toString("base64")
}

function unwrapDek(keyring: Keyring, envelope: Envelope, parts: AadParts) {
  const kek = keyring.keys.get(envelope.kek)
  if (!kek) throw new Error(`没有 KEK v${envelope.kek}，解不开`)
  const raw = Buffer.from(envelope.dek, "base64")
  return open(kek, raw.subarray(0, IV_BYTES), raw.subarray(IV_BYTES, IV_BYTES + 16), raw.subarray(IV_BYTES + 16), dekAad(parts, envelope.kek))
}

export function encrypt(keyring: Keyring, plaintext: string | Buffer, parts: AadParts): Envelope {
  const dek = randomBytes(KEY_BYTES)
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext
  const { iv, tag, ct } = seal(dek, data, aadOf(parts))
  const envelope: Envelope = {
    v: 1,
    kek: keyring.current,
    dek: wrapDek(keyring, dek, parts),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  }
  dek.fill(0)
  return envelope
}

/** 解密；行 id、版本号、KEK 任何一样不对都会抛错（GCM 认证失败） */
export function decrypt(keyring: Keyring, envelope: Envelope, parts: AadParts): Buffer {
  if (envelope.v !== 1) throw new Error(`不认识的信封格式 v${envelope.v}`)
  const dek = unwrapDek(keyring, envelope, parts)
  try {
    return open(dek, Buffer.from(envelope.iv, "base64"), Buffer.from(envelope.tag, "base64"), Buffer.from(envelope.ct, "base64"), aadOf(parts))
  } finally {
    dek.fill(0)
  }
}

export const decryptText = (keyring: Keyring, envelope: Envelope, parts: AadParts) => decrypt(keyring, envelope, parts).toString("utf8")

/** KEK 轮换：用最新的 KEK 重新包 DEK，数据本身不动 */
export function rewrap(keyring: Keyring, envelope: Envelope, parts: AadParts): Envelope {
  if (envelope.kek === keyring.current) return envelope
  const dek = unwrapDek(keyring, envelope, parts)
  try {
    return { ...envelope, kek: keyring.current, dek: wrapDek(keyring, dek, parts) }
  } finally {
    dek.fill(0)
  }
}

/** 掩码：保留开头 keepStart 个、结尾 4 个字符，例如 sk-or-v1-••••••••3f2a。太短的全部遮住 */
export function mask(value: string, keepStart = 6): string {
  if (value.length <= keepStart + 4 + 4) return "••••••••"
  return `${value.slice(0, keepStart)}••••••••${value.slice(-4)}`
}
