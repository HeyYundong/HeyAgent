// 系统开的桌面（docs/dev/desktop-vm.md）：HeyAgent 在本机用 Podman + KVM 开 Windows 虚拟机，运营只点「新建桌面」、扫码登录软件。
// - 模板（kind = template）：管理员做一次。系统自动装好 Windows 和两个服务，管理员在画面里装好常用软件，点「做成模板」后只读；
// - 桌面（kind = vm）：从做好的模板复制（qcow2 写时复制，几秒），开机后自动登记，地址和密钥都由系统管；
// - 手动登记的（kind = manual）：原来那种，填地址和密钥，给实体电脑用。
// 存放位置只能从部署时配置的目录（HEYAGENT_DESKTOP_STORAGE_ROOTS）里选，系统识别是 SSD 还是 HDD。
import { z } from "zod"

const text = (message: string, max: number) => z.string({ error: message }).trim().min(1, message).max(max, `最多 ${max} 个字`)

export const desktopKindSchema = z.enum(["manual", "vm", "template"])
export type DesktopKind = z.infer<typeof desktopKindSchema>

/**
 * 虚拟机的状态（系统开的桌面和模板才有）：
 * - creating：在复制磁盘、建容器；installing：模板在自动装 Windows（SSD 约 1 小时）；
 * - starting：开机中，等两个服务连得上；running：开着、服务连得上；
 * - setup：模板装好了，开着等管理员装软件（点「做成模板」）；ready：模板做好了（关机、只读，可以拿来建桌面）；
 * - stopping / stopped：关机中 / 关着；error：出错（error 字段写原因，可以重试开机或删掉）；deleting：删除中
 */
export const desktopVmStateSchema = z.enum(["creating", "installing", "starting", "running", "setup", "ready", "stopping", "stopped", "error", "deleting"])
export type DesktopVmState = z.infer<typeof desktopVmStateSchema>

/** 盘的类型：系统按 Linux 的 rotational 标记识别；虚拟机、RAID 上可能不准，管理员可以在设置里手动改 */
export const diskKindSchema = z.enum(["ssd", "hdd", "unknown"])
export type DiskKind = z.infer<typeof diskKindSchema>

/** 一个可选的存放位置 */
export const desktopStorageSchema = z.object({
  path: z.string(),
  kind: diskKindSchema,
  /** 管理员手动标过（覆盖了自动识别） */
  kindOverridden: z.boolean(),
  freeGb: z.number(),
  totalGb: z.number(),
  /** 是不是默认位置（设置里选的） */
  isDefault: z.boolean(),
  /** 不能用的原因（目录不存在、没有写权限、空间不够……）；能用 = 没有 */
  problem: z.string().optional(),
})
export type DesktopStorage = z.infer<typeof desktopStorageSchema>

/** 本机资源：新建、开机前检查，页面上也显示 */
export const desktopHostSchema = z.object({
  /** 能不能开虚拟机（Podman 连得上、有 KVM）；不能时 problem 写原因，页面只给「登记已有电脑」 */
  available: z.boolean(),
  problem: z.string().optional(),
  memoryGb: z.number(),
  cpus: z.number(),
  /** 开着的虚拟机占用的内存（按每台配置的内存算） */
  usedMemoryGb: z.number(),
  runningVms: z.number(),
  storages: z.array(desktopStorageSchema),
})
export type DesktopHost = z.infer<typeof desktopHostSchema>

/** desktopSchema.vm：系统开的桌面和模板才有 */
export const desktopVmInfoSchema = z.object({
  state: desktopVmStateSchema,
  /** 出错的原因、正在做什么（例如「正在安装 Windows，已经 23 分钟」） */
  message: z.string().optional(),
  storagePath: z.string(),
  diskKind: diskKindSchema,
  memoryGb: z.number(),
  cpus: z.number(),
  /** 桌面：从哪个模板建的 */
  templateId: z.string().optional(),
  templateName: z.string().optional(),
  /** 模板：有几台桌面是用它建的（有就不能删） */
  usedBy: z.number().optional(),
  /** 磁盘现在实际占了多少 */
  diskUsedGb: z.number().optional(),
  stateSince: z.string(),
})
export type DesktopVmInfo = z.infer<typeof desktopVmInfoSchema>

const memoryGb = z.number().int().min(2, "至少 2 GB").max(64, "最多 64 GB")
const cpus = z.number().int().min(1, "至少 1 核").max(16, "最多 16 核")

/** 做模板（管理员） */
export const desktopTemplateCreateSchema = z.object({
  name: text("起个名字，例如「标准办公模板」", 100),
  description: z.string().trim().max(1000, "最多 1000 个字").default(""),
  storagePath: z.string().min(1, "选一个存放位置"),
  /** 系统盘大小 */
  diskGb: z.number().int().min(40, "至少 40 GB").max(500, "最多 500 GB").default(64),
  memoryGb: memoryGb.default(6),
  cpus: cpus.default(4),
})
export type DesktopTemplateCreate = z.input<typeof desktopTemplateCreateSchema>

/** 从模板新建桌面（运营也能用：见 permissions 的 desktop.create） */
export const desktopVmCreateSchema = z.object({
  name: text("起个名字，例如「运营 1 号」", 100),
  /** 给 agent 看的说明：装了哪些软件、登的哪个账号 */
  description: z.string().trim().max(1000, "最多 1000 个字").default(""),
  templateId: z.string().min(1, "选一个模板"),
  /** 不填 = 设置里的默认位置 */
  storagePath: z.string().optional(),
  /** 不填 = 和模板一样 */
  memoryGb: memoryGb.optional(),
  cpus: cpus.optional(),
})
export type DesktopVmCreate = z.input<typeof desktopVmCreateSchema>

/** 对虚拟机的操作 */
export const desktopVmActionSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["start", "stop", "restart", "reset", "seal"]),
  /** 正被运行占着时也要做（会打断那个运行，页面要二次确认） */
  force: z.boolean().optional(),
})
export type DesktopVmAction = z.infer<typeof desktopVmActionSchema>

/** 设置：默认存放位置、手动标的盘类型 */
export const desktopStorageSettingsSchema = z.object({
  defaultPath: z.string().optional(),
  /** 路径 → 手动标的类型；去掉 = 恢复自动识别 */
  kindOverrides: z.record(z.string(), z.enum(["ssd", "hdd"])),
})
export type DesktopStorageSettings = z.infer<typeof desktopStorageSettingsSchema>

/** 新建桌面、模板时至少要剩这么多空间 */
export const DESKTOP_MIN_FREE_GB = 40
