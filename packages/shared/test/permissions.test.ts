import { describe, expect, it } from "vitest"

import { can } from "../src/index.js"

const lin = { id: "u-lin", isAdmin: true }
const wang = { id: "u-wang", isAdmin: false }

describe("can：员工能看全部，只能操作自己负责的或分给自己的；主管全部能操作", () => {
  it("主管什么都能做", () => {
    expect(can(lin, "task.manage", { ownerId: "u-wang" })).toBe(true)
    expect(can(lin, "humanItem.resolve", { assigneeId: "u-emily" })).toBe(true)
    expect(can(lin, "config.manage", {})).toBe(true)
    expect(can(lin, "task.create", {})).toBe(true)
  })
  it("员工能看全部", () => {
    expect(can(wang, "view", {})).toBe(true)
  })
  it("员工只能操作自己负责的任务", () => {
    expect(can(wang, "task.manage", { ownerId: "u-wang" })).toBe(true)
    expect(can(wang, "task.manage", { ownerId: "u-li" })).toBe(false)
    expect(can(wang, "session.resume", { taskOwnerId: "u-wang" })).toBe(true)
    expect(can(wang, "session.resume", { taskOwnerId: "u-li" })).toBe(false)
  })
  it("员工只能处理分给自己的事", () => {
    expect(can(wang, "humanItem.resolve", { assigneeId: "u-wang" })).toBe(true)
    expect(can(wang, "humanItem.resolve", { assigneeId: "u-emily" })).toBe(false)
  })
  it("待办：自己的任务才能加；加的人和任务负责人能立即执行；只有加的人能改删", () => {
    expect(can(wang, "todo.create", { taskOwnerId: "u-wang" })).toBe(true)
    expect(can(wang, "todo.create", { taskOwnerId: "u-li" })).toBe(false)
    expect(can(wang, "todo.run", { createdById: "u-emily", taskOwnerId: "u-wang" })).toBe(true)
    expect(can(wang, "todo.run", { createdById: "u-wang", taskOwnerId: "u-li" })).toBe(true)
    expect(can(wang, "todo.run", { createdById: "u-emily", taskOwnerId: "u-li" })).toBe(false)
    expect(can(wang, "todo.manage", { createdById: "u-emily" })).toBe(false)
  })
  it("只有主管能做的：新建任务、改配置；浏览器登录大家都能用", () => {
    expect(can(wang, "task.create", {})).toBe(false)
    expect(can(wang, "config.manage", {})).toBe(false)
    expect(can(wang, "browser.login", {})).toBe(true)
  })
})
