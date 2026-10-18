// 导入的纯逻辑：解压的安全检查、挪明文密钥、按行对比。不连数据库。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { ImportPlan } from "@heyagent/shared"

import { afterEach, describe, expect, it } from "vitest"

import { lineDiff } from "../src/imports/diff.js"
import { configureImports, importLimits } from "../src/imports/limits.js"
import { ImportPackage, parseFrontMatter, type PackageFile } from "../src/imports/package.js"
import { fillSkillBodies } from "../src/imports/skills.js"
import { isPlaceholder, keyStrength, redactText, replaceKnownValues, SecretCollector, secretNameFrom } from "../src/imports/redact.js"
import { extractZip, ImportReadError } from "../src/imports/zip.js"
import { makeZip, rawZip } from "./import-helpers.js"

const dest = () => join(mkdtempSync(join(tmpdir(), "heyagent-unzip-")), "files")
const saved = { ...importLimits }
afterEach(() => configureImports(saved))

describe("解压", () => {
  it("挡掉 ../ 和绝对路径", async () => {
    await expect(extractZip(rawZip([{ name: "a/../../evil.txt", data: "x" }]), dest())).rejects.toThrow(/\.\./)
    await expect(extractZip(rawZip([{ name: "/etc/evil.txt", data: "x" }]), dest())).rejects.toThrow(/绝对路径/)
    await expect(extractZip(rawZip([{ name: "C:/evil.txt", data: "x" }]), dest())).rejects.toThrow(/绝对路径/)
    await expect(extractZip(rawZip([{ name: "a\\..\\..\\evil.txt", data: "x" }]), dest())).rejects.toThrow(/\.\./)
  })

  it("跳过软链接、目录条目、__MACOSX、.DS_Store；包里的压缩包不解开；只有一个顶层目录时去掉这一层", async () => {
    const out = dest()
    const zip = rawZip([
      { name: "pkg/", mode: 0o040755 },
      { name: "pkg/README.md", data: "hello" },
      { name: "pkg/docs/a.md", data: "a" },
      { name: "pkg/link", data: "/etc/passwd", mode: 0o120777 },
      { name: "pkg/old.zip", data: "PK" },
      { name: "__MACOSX/pkg/._README.md", data: "junk" },
      { name: "pkg/.DS_Store", data: "junk" },
    ])
    const result = await extractZip(zip, out)
    expect(result.files.map((file) => file.path)).toEqual(["README.md", "docs/a.md"])
    expect(result.skipped.map(({ path, reason }) => ({ path, reason }))).toEqual([
      { path: "link", reason: "软链接，没有解开" },
      { path: "old.zip", reason: "包里的压缩包，没有再解开" },
    ])
    expect(readFileSync(join(out, "pkg/README.md"), "utf8")).toBe("hello")
  })

  it("依赖、缓存目录不解开，标「跳过」", async () => {
    const out = dest()
    const result = await extractZip(await makeZip({ "app/README.md": "x", "app/node_modules/pkg/index.js": "y", "app/lib/__pycache__/a.pyc": "z" }), out)
    expect(result.files.map((file) => file.path)).toEqual(["README.md"])
    expect(result.skipped.map((each) => each.path).sort()).toEqual(["lib/__pycache__/a.pyc", "node_modules/pkg/index.js"])
    expect(result.skipped[0]!.reason).toBe("依赖或缓存目录，跳过")
  })

  it("文件太多、解压后太大都挡掉（按实际写出的字节算）", async () => {
    configureImports({ maxFiles: 3 })
    await expect(extractZip(await makeZip({ a: "1", b: "2", c: "3", d: "4" }), dest())).rejects.toThrow(/文件太多/)
    configureImports({ maxFiles: 100, maxUnpackedBytes: 1024 * 1024 })
    // 2 MB 的 0 压缩以后很小
    const bomb = await makeZip({ "big.bin": Buffer.alloc(2 * 1024 * 1024) })
    expect(bomb.length).toBeLessThan(100 * 1024)
    await expect(extractZip(bomb, dest())).rejects.toThrow(/解压后太大/)
    await expect(extractZip(Buffer.from("not a zip"), dest())).rejects.toBeInstanceOf(ImportReadError)
  })

  it("没有 UTF-8 标志的文件名：GBK（Windows 中文系统打的包）、UTF-8（macOS）都认得", async () => {
    const gbkName = Buffer.concat([Buffer.from("docs/"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from(".md")]) // 中文
    const result = await extractZip(rawZip([{ name: gbkName, data: "x" }, { name: Buffer.from("docs/说明.md"), data: "y" }]), dest())
    expect(result.files.map((file) => file.path).sort()).toEqual(["中文.md", "说明.md"].sort())
  })
})

describe("挪走明文密钥", () => {
  it(".env、JSON、YAML、cURL、带密码的网址、PEM 都挪走，换成 {{名字}}；同一个值只起一个名字", () => {
    const collector = new SecretCollector()
    const env = redactText(
      "config/.env",
      ["OPENAI_API_KEY=sk-test-abcdefghijklmnop1234", "APP_ID=cli_abc123def456", "BASE_URL=https://api.example.com", "PORT=8080", 'APP_SECRET="s3cr3t-value-0001"'].join("\n"),
      collector
    )
    expect(env).toContain("OPENAI_API_KEY={{OPENAI_API_KEY}}")
    expect(env).toContain("APP_ID={{APP_ID}}")
    expect(env).toContain('APP_SECRET="{{APP_SECRET}}"')
    expect(env).toContain("BASE_URL=https://api.example.com")
    expect(env).toContain("PORT=8080")

    const json = redactText("config.json", '{\n  "password": "hunter2-very-secret",\n  "author": "someone",\n  "max_tokens": 4096\n}', collector)
    expect(json).toContain('"password": "{{PASSWORD}}"')
    expect(json).toContain('"author": "someone"')

    const yaml = redactText("tools.yaml", "weather:\n  url: https://api.weather.example/v1/today?city={city}&apikey=wk-4455667788aabb\n  headers:\n    X-Api-Key: hdr-1122334455667788\n  token_type: bearer", collector)
    expect(yaml).toContain("apikey={{APIKEY}}")
    expect(yaml).toContain("X-Api-Key: {{X_API_KEY}}")
    expect(yaml).toContain("token_type: bearer")

    const curl = redactText("README.md", 'curl -H "Authorization: Bearer tok-abcdef1234567890" -u admin:p4ss-word-9 https://api.example.com/v1/items', collector)
    expect(curl).toContain('"Authorization: Bearer {{AUTH_TOKEN}}"')
    expect(curl).toContain("-u admin:{{ADMIN_PASSWORD}}")

    const url = redactText("notes.md", "数据库在 postgres://admin:pa55word-xyz@db.internal.example:5432/app", collector)
    expect(url).toContain("postgres://admin:{{INTERNAL_PASSWORD}}@db.internal.example")

    const pem = "line1\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdef\n-----END RSA PRIVATE KEY-----\nline6"
    const redactedPem = redactText("keys/deploy.pem", pem, collector)
    expect(redactedPem.split("\n")).toHaveLength(pem.split("\n").length)
    expect(redactedPem).toContain("{{PRIVATE_KEY}}")
    expect(redactedPem).not.toContain("MIIEow")

    // 同一个值在别处（没有键名）出现：全文替换时换成同一个名字
    const again = redactText("other.md", "备用：sk-test-abcdefghijklmnop1234", collector)
    expect(again).toContain("{{OPENAI_API_KEY}}")
    const loose = replaceKnownValues("那个密码是 hunter2-very-secret 别忘了", collector.found)
    expect(loose).toBe("那个密码是 {{PASSWORD}} 别忘了")
    expect(collector.found.map((each) => each.name).sort()).toEqual(
      ["ADMIN_PASSWORD", "APIKEY", "APP_ID", "APP_SECRET", "AUTH_TOKEN", "INTERNAL_PASSWORD", "OPENAI_API_KEY", "PASSWORD", "PRIVATE_KEY", "X_API_KEY"].sort()
    )
    // 位置给人看，不含值
    for (const each of collector.found) expect(each.where).not.toContain(each.value)
    expect(collector.found.find((each) => each.name === "APP_SECRET")?.where).toBe("config/.env 第 5 行")
  })

  it("名字合规矩、重名加 _2；占位符和开关不当密钥", () => {
    expect(secretNameFrom("apiKey")).toBe("API_KEY")
    expect(secretNameFrom("1password")).toBe("K_1PASSWORD")
    expect(secretNameFrom("NOTIFY_HOOK")).toBe("K_NOTIFY_HOOK")
    const collector = new SecretCollector()
    expect(collector.slot("token", "aaaa-1111-bbbb", "x")).toBe("TOKEN")
    expect(collector.slot("token", "cccc-2222-dddd", "x")).toBe("TOKEN_2")
    expect(collector.slot("other", "aaaa-1111-bbbb", "x")).toBe("TOKEN")
    for (const value of ["{{X}}", "${API_KEY}", "<your key>", "xxxx", "true", "12345", "your_api_key", "Bearer {{X}}"]) expect(isPlaceholder(value)).toBe(true)
    expect(keyStrength("public_key")).toBeUndefined()
    expect(keyStrength("client_secret")).toBe("strong")
    expect(keyStrength("session_key")).toBe("weak")
    // 看最后一个词：界面文案的键、编号不算
    expect(keyStrength("secret_title")).toBeUndefined()
    expect(keyStrength("pad_token_id")).toBeUndefined()
    expect(keyStrength("x-api-key")).toBe("strong")
    const collector2 = new SecretCollector()
    expect(redactText("locales/en.yaml", 'password_hint: "Enter your password here"\nsecret_title: Secret', collector2)).toBe('password_hint: "Enter your password here"\nsecret_title: Secret')
    expect(collector2.found).toHaveLength(0)
  })
})

describe("挪密钥：误报的形状不挪，真密钥照样挪", () => {
  it("带空白、中文、反引号、竖线、尖括号、{参数}、$变量、$(命令)、正则片段、太短的值，开关和分词器的键名：都不挪", () => {
    const collector = new SecretCollector()
    const text = [
      "| 请求头 | `X-API-Key: <密钥>` + `Content-Type: application/json` |",
      "X-API-Key: 在后台的设置页里生成一个新的密钥，然后把它填进环境变量，不要写进代码 abc",
      'password: "please change this"',
      'api_key: "`echo hello-world`"',
      "token: abc|def|ghi|jkl",
      "secret: <your-secret-here>",
      "api_key: {app_token}",
      "token: ${API_TOKEN_VALUE}",
      "token: $(cat /run/secrets/x)",
      'secret: "[A-Za-z0-9]*:abc"',
      'api_key: "]*:abcdefgh"',
      'token: "True,"',
      "token: None,",
      "token: Bordered",
      "password: 秘密口令abc123",
      "ALLOW_CREDENTIALS: abcdef123456",
      "enable_auth_token: abcdef123456",
      'eos_token: "</s>"',
      'pad_token: "padtoken123"',
      "Authorization: Bearer 短",
      "Cookie: 登录后在浏览器里复制",
      "Cookie: session=abc123...",
      "secret: my-super-secret-value",
      "ssh_key: ~/.ssh/id_ed25519",
      "auth_token: abcdef-ghijk-lmnop-…",
      "代理：http://user:pass@proxy.example.com:8080",
      "正则：https?://([^:]+):([^@]+)@host",
    ].join("\n")
    expect(redactText("docs/guide.md", text, collector)).toBe(text)
    // .env 的模板里是示例值：只按键名认（MODE 这种普通键不挪）
    const template = "MODE=production-like-value1\nAPI_KEY=\n"
    expect(redactText("config/.env.example", template, collector)).toBe(template)
    expect(collector.found).toEqual([])
  })

  it(".env 里键名像密钥的口令（几个小写单词）也挪；普通键的普通值不挪", () => {
    const collector = new SecretCollector()
    const out = redactText(".env", ["DB_PASSWORD=correct-horse-battery", "NODE_ENV=production", "LOG_LEVEL=debug", "ADMIN_TOKEN=abc", "SECRET_KEY=${FROM_VAULT}"].join("\n"), collector)
    expect(out).toBe(["DB_PASSWORD={{DB_PASSWORD}}", "NODE_ENV=production", "LOG_LEVEL=debug", "ADMIN_TOKEN=abc", "SECRET_KEY=${FROM_VAULT}"].join("\n"))
    expect(collector.found.map((each) => each.value)).toEqual(["correct-horse-battery"])
  })

  it("sk-…、ghp_…、Bearer 长串、.env 的值、JSON 的 api_key、cURL -H、Markdown 里的真密钥、Cookie、带密码的网址、PEM：照样挪", () => {
    const collector = new SecretCollector()
    const out = redactText(
      "README.md",
      [
        "OpenAI：sk-proj-abcdefghijklmnop123456",
        "GitHub：ghp_abcdefghijklmnopqrstuvwxyz0123",
        'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefgh" https://api.example.com',
        '{"api_key": "a8f3k2m9q7x1z5c4"}',
        "| 请求头 | `X-API-Key: k9d8s7f6g5h4` |",
        "Cookie: sid=abc123def456; theme=dark",
        "仓库：https://bot:pa55@git.example.com/repo",
        "-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
        "-----END PRIVATE KEY-----",
      ].join("\n"),
      collector
    )
    expect(out).toBe(
      [
        "OpenAI：{{TOKEN}}",
        "GitHub：{{TOKEN_2}}",
        'curl -H "Authorization: Bearer {{AUTH_TOKEN}}" https://api.example.com',
        '{"api_key": "{{API_KEY}}"}',
        "| 请求头 | `X-API-Key: {{X_API_KEY}}` |",
        "Cookie: {{COOKIE}}",
        "仓库：https://bot:{{EXAMPLE_PASSWORD}}@git.example.com/repo",
        "{{PRIVATE_KEY}}",
        "",
        "",
      ].join("\n")
    )
    const env = redactText("config/.env", "DB_PASS=abc123\nNAME=\nHOST=db\nMODE=production\n", collector)
    expect(env).toBe("DB_PASS={{DB_PASS}}\nNAME=\nHOST=db\nMODE=production\n")
  })
})

describe("按行对比", () => {
  it("最长公共子序列：没变的、删掉的、加上的", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([
      { variant: "default", text: "a" },
      { variant: "removed", text: "b" },
      { variant: "default", text: "c" },
      { variant: "added", text: "d" },
    ])
  })
})

describe("大的包：分层列目录、扫技能、技能正文从文件取", () => {
  /** 在临时目录里摆好文件，造一个 ImportPackage */
  function makePackage(files: Record<string, string>, skipped: string[] = []) {
    const root = mkdtempSync(join(tmpdir(), "heyagent-pkg-"))
    const entries: PackageFile[] = Object.entries(files).map(([path, content]) => {
      const diskPath = join(root, path)
      mkdirSync(dirname(diskPath), { recursive: true })
      writeFileSync(diskPath, content)
      return { path, diskPath, size: Buffer.byteLength(content), text: true }
    })
    for (const path of skipped) entries.push({ path, diskPath: "", size: 10, text: false, skipped: "依赖或缓存目录，跳过" })
    return new ImportPackage(entries, new SecretCollector())
  }

  it("列目录：默认两层，文件多的目录折叠成一行，依赖目录标「跳过」；带 dir 再看", () => {
    const files: Record<string, string> = { "README.md": "x", "docs/a.md": "a", "docs/sub/b.md": "b" }
    for (let n = 0; n < 50; n++) files[`big/f${n}.txt`] = "1"
    const pkg = makePackage(files, ["node_modules/x/index.js"])
    const root = pkg.listFiles()
    expect(root).toContain("（根目录）：54 个文件")
    expect(root).toContain('- big/ （50 个文件，50 字节；内容多，要看就 list_files dir="big"）')
    expect(root).toContain("- node_modules/ （跳过：依赖或缓存目录，1 个文件，10 字节）")
    expect(root).toContain("  - sub/ （1 个文件，1 字节）")
    expect(root).not.toContain("b.md")
    expect(root).toContain("- README.md · 1 字节 · 文字")
    expect(pkg.listFiles("big").split("\n")).toHaveLength(51)
    expect(pkg.listFiles("nope")).toBe("包里没有目录「nope」")
  })

  it("扫技能：解析元数据（含多行块），技能太多先按目录给个数", async () => {
    expect(parseFrontMatter("---\nname: a\ndescription: >\n  第一行\n  第二行\nother: 'q'\n---\n正文").meta).toEqual({ name: "a", description: "第一行 第二行", other: "q" })
    const files: Record<string, string> = {}
    for (let n = 0; n < 160; n++) files[`${n < 80 ? "own" : "vendor"}/s${n}/SKILL.md`] = `---\nname: s${n}\ndescription: 第 ${n} 个\n---\n正文`
    files["own/s0/references/r.md"] = "# 参考"
    files["own/s0/scripts/run.sh"] = "echo"
    const pkg = makePackage(files)
    const summary = await pkg.skillsText()
    expect(summary).toContain("一共 160 个 SKILL.md")
    expect(summary).toContain("- own/ （80 个）")
    expect(summary).toContain("- vendor/ （80 个）")
    const own = await pkg.skillsText("own")
    expect(own.split("\n")).toHaveLength(81)
    expect(own).toContain("- own/s0/SKILL.md · 名字：s0 · 说明：第 0 个 · 正文 2 字 · references/ 下 1 个参考，scripts/ 下 1 个脚本")
  })

  it("技能正文：参考资料不超过 5 万字合进正文，超了每个单独做技能；脚本进没用上的文件", async () => {
    const pkg = makePackage({
      "small/SKILL.md": "---\nname: 小技能\ndescription: 小\n---\n# 小\n正文",
      "small/references/a.md": "# 甲\n内容甲",
      "big/SKILL.md": "---\nname: 大技能\n---\n# 大\n正文",
      "big/references/one.md": `# 第一份\n${"一".repeat(30_000)}`,
      "big/references/two.md": `# 第二份\n${"二".repeat(30_000)}`,
      "big/scripts/run.py": "print(1)",
    })
    const skill = (key: string) => ({ key, include: true, group: "业务", name: "", dept: "通用", description: "", body: "", toolKeys: [], source: "", merged: [], resolution: "new" as const })
    const plan = { v: 1 as const, name: "x", summary: "", warnings: [], tasks: [{ key: "t1", skillKeys: ["s2"] }], skills: [skill("s1"), skill("s2")], memories: [], rules: [], tools: [], secrets: [], unused: [] } as unknown as ImportPlan
    await fillSkillBodies(plan, new Map([["s1", "small/SKILL.md"], ["s2", "big/SKILL.md"]]), pkg)
    const [s1, s2, r1, r2] = plan.skills
    expect(s1).toMatchObject({ name: "小技能", description: "小", merged: ["small/references/a.md"], source: "small/SKILL.md" })
    expect(s1!.body).toBe("# 小\n正文\n\n---\n\n## 参考：甲\n\n# 甲\n内容甲")
    expect(s2).toMatchObject({ name: "大技能", description: "大技能", merged: [] })
    expect(s2!.body).toContain("- 大技能 · 第一份\n- 大技能 · 第二份")
    expect(r1).toMatchObject({ key: "s2-r1", name: "大技能 · 第一份", group: "业务", dept: "通用", source: "big/references/one.md" })
    expect(r2!.body.length).toBeGreaterThan(30_000)
    expect(plan.tasks[0]!.skillKeys).toEqual(["s2", "s2-r1", "s2-r2"])
    expect(plan.unused).toEqual([{ path: "big/scripts/（1 个文件）", reason: "平台不运行脚本" }])
  })

  it("AI 列过的没用上的文件：「、」连起的一行按第一个的上级目录补全；脚本目录列过就不再加", async () => {
    const pkg = makePackage({ "skills/apple/a/SKILL.md": "x", "skills/creative/b.md": "y", "skills/mlops/c.md": "z", "logs/1.log": "1", "tool/SKILL.md": "---\nname: t\n---\n正文", "tool/scripts/run.sh": "echo" })
    expect(pkg.unusedPaths("skills/apple/、creative/、mlops/（3 个文件）……")).toEqual(["skills/apple/", "skills/creative/", "skills/mlops/"])
    expect(pkg.unusedPaths("logs/（1 个文件）")).toEqual(["logs/"])
    expect(pkg.unusedCovers([{ path: "skills/apple/、creative/" }], "skills/creative/b.md")).toBe(true)
    expect(pkg.unusedCovers([{ path: "skills/apple/、creative/" }], "skills/mlops/c.md")).toBe(false)
    const plan = { v: 1 as const, name: "x", summary: "", warnings: [], tasks: [], skills: [{ key: "s1", include: true, name: "", dept: "通用", description: "", body: "", toolKeys: [], source: "", merged: [], resolution: "new" as const }], memories: [], rules: [], tools: [], secrets: [], unused: [{ path: "tool/scripts/", reason: "脚本" }] } as unknown as ImportPlan
    await fillSkillBodies(plan, new Map([["s1", "tool/SKILL.md"]]), pkg)
    expect(plan.unused).toEqual([{ path: "tool/scripts/", reason: "脚本" }])
  })

  it("没用上的文件按目录收拢", () => {
    const files: Record<string, string> = { "keep/a.md": "a", "keep/b.md": "b", "README.md": "r" }
    for (let n = 0; n < 30; n++) files[`vendor/deep/f${n}.py`] = "x"
    const pkg = makePackage(files, ["node_modules/a.js", "node_modules/b.js"])
    expect(pkg.groupUnused((path) => path === "keep/a.md" || path === "README.md")).toEqual([
      { path: "keep/b.md", reason: "AI 没用到" },
      { path: "node_modules/（2 个文件）", reason: "依赖或缓存目录，跳过" },
      { path: "vendor/（30 个文件）", reason: "AI 没用到" },
    ])
  })
})
