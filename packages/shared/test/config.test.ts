import { describe, expect, it } from "vitest"

import { applySkillDiff, can, cronText, hasPlainSecret, isValidCron, moveSecrets, nextCronRun, secretNameSchema, taskInputSchema, templatePlaceholders } from "../src/index.js"

describe("明文密钥识别", () => {
  it("请求头、URL 参数、JSON 里的密钥都能认出来，换成 {{名字}}", () => {
    const { template, moved } = moveSecrets({
      url: "https://api.shipping.example/v1/rates?api_key=abcd1234efgh",
      headers: "Authorization: Bearer sk_live_abcdefgh12345678\nContent-Type: application/json",
      body: '{"token": "plain-token-value", "weight": "{weight}"}',
    })
    expect(moved.map((m) => m.where).sort()).toEqual(["body", "headers", "url"])
    expect(template.url).toBe("https://api.shipping.example/v1/rates?api_key={{SHIPPING_API_KEY}}")
    expect(template.headers).toContain("Authorization: Bearer {{SHIPPING_TOKEN}}")
    expect(template.body).toContain('"weight": "{weight}"')
    expect(templatePlaceholders(template.body).params).toEqual(["weight"])
  })

  it("已经写成 {{名字}} 的不算明文", () => {
    expect(moveSecrets({ url: "https://a.example/x", headers: "Authorization: Bearer {{A_TOKEN}}", body: "" }).moved).toEqual([])
    expect(hasPlainSecret("npx -y files-mcp --root /data")).toBe(false)
    expect(hasPlainSecret("npx files-mcp --token sk_live_abcdefgh12345678")).toBe(true)
  })

  it("密钥名：大写加下划线，NOTIFY_ 留给通知渠道", () => {
    expect(secretNameSchema.safeParse("API_TOKEN").success).toBe(true)
    expect(secretNameSchema.safeParse("api_token").success).toBe(false)
    expect(secretNameSchema.safeParse("NOTIFY_X_URL").success).toBe(false)
  })
})

describe("cron", () => {
  it("按上海时间算下一次", () => {
    // 2026-10-16 是周五；周一 09:00（上海）= 周一 01:00 UTC
    expect(nextCronRun("0 9 * * 1", new Date("2026-10-16T08:00:00Z"))).toBe("2026-10-19T01:00:00.000Z")
    expect(isValidCron("0 9 * * *")).toBe(true)
    expect(isValidCron("every day")).toBe(false)
    expect(isValidCron("0 9 * *")).toBe(false)
  })
})

describe("技能修改建议的合并", () => {
  const body = "## 步骤\n1. 第一步\n2. 第二步\n\n## 常见坑\n- 旧的坑"
  it("只给改动的几段也能合并", () => {
    const merged = applySkillDiff(body, [
      { variant: "default", text: "2. 第二步" },
      { variant: "added", text: "3. 第三步" },
      { variant: "removed", text: "- 旧的坑" },
      { variant: "added", text: "- 新的坑" },
    ])
    expect(merged).toBe("## 步骤\n1. 第一步\n2. 第二步\n3. 第三步\n\n## 常见坑\n- 新的坑")
  })
  it("对不上（技能后来被改过）返回 null", () => {
    expect(applySkillDiff(body, [{ variant: "removed", text: "不存在的一行" }])).toBeNull()
  })
})

describe("输入校验", () => {
  it("任务的目标必填，步骤可以不写；复核模型必填", () => {
    const base = { title: "x", goal: "y", steps: [], schedule: null, reviewModelId: "m/review" }
    expect(taskInputSchema.safeParse({ ...base, goal: "" }).success).toBe(false)
    expect(taskInputSchema.safeParse(base).success).toBe(true)
    expect(taskInputSchema.safeParse({ ...base, schedule: { cron: "bad", text: "" } }).success).toBe(false)
    const missing = taskInputSchema.safeParse({ ...base, reviewModelId: undefined })
    expect(missing.success).toBe(false)
    expect(missing.error?.issues[0]?.message).toBe("选一个复核模型")
    expect(taskInputSchema.safeParse({ ...base, reviewModelId: "  " }).error?.issues[0]?.message).toBe("选一个复核模型")
  })
})

describe("新加的权限", () => {
  it("用户管理、全局设置只有主管能做", () => {
    expect(can({ id: "a", isAdmin: true }, "user.manage", {})).toBe(true)
    expect(can({ id: "b", isAdmin: false }, "user.manage", {})).toBe(false)
    expect(can({ id: "b", isAdmin: false }, "settings.manage", {})).toBe(false)
  })
})

describe("cronText", () => {
  it("translates common schedules", () => {
    expect(cronText("0 10 * * 1-5")).toBe("每个工作日 10:00")
    expect(cronText("0 9 * * *")).toBe("每天 09:00")
    expect(cronText("* 9-11,13-17 * * 1-5")).toBe("每个工作日 09:00–12:00、13:00–18:00 每分钟")
    expect(cronText("*/5 9-17 * * *")).toBe("每天 09:00–18:00 每 5 分钟")
    expect(cronText("*/30 * * * *")).toBe("每 30 分钟")
    expect(cronText("bad")).toBeNull()
  })
})
