// 【只给开发用，不是产品功能】把一台已经装好 Windows 和两个服务的虚拟机磁盘导入成一个「做好了」的模板（docs/dev/desktop-vm.md 第 9 节）。
// 开发机只有机械盘，真装一次 Windows 要 2 小时；为了实测「从模板建桌面」，拿验证用虚拟机的磁盘转成 qcow2 当现成的模板。
// 原磁盘只读挂进一次性的 qemu-img 容器，不改、不挪。正式环境里模板只能在「桌面」页做（系统自动装）。
//
// 用法（在 apps/server 下）：
//   HEYAGENT_PODMAN_SOCKET=/run/user/1000/heyagent-podman.sock HEYAGENT_DESKTOP_STORAGE_ROOTS=/mnt/toshiba/heyagent-desktops-dev \
//   npx tsx --conditions=@heyagent/source src/scripts/dev-import-desktop-template.ts \
//     --source-dir /mnt/toshiba/heyagent-spike/storage --disk data.img --key-file /mnt/toshiba/heyagent-spike/mcp_key \
//     --storage /mnt/toshiba/heyagent-desktops-dev --name 验证用模板 [--memory 4] [--cpus 4] [--disk-gb 64]
import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { asc, count, eq } from "drizzle-orm"

import { putSecret } from "../data/config/common.js"
import { createDb } from "../db/client.js"
import * as t from "../db/schema.js"
import { containerNameOf, diskOf, vmConfig, vmDirOf, vmUrls } from "../desktop/vm/config.js"
import { copyStateFiles } from "../desktop/vm/lifecycle.js"
import { PodmanClient } from "../desktop/vm/podman.js"
import { env } from "../env.js"
import { loadKeyring } from "../lib/crypto.js"

const { values } = parseArgs({
  options: {
    "source-dir": { type: "string" },
    disk: { type: "string", default: "data.img" },
    "key-file": { type: "string" },
    storage: { type: "string" },
    name: { type: "string", default: "导入的模板" },
    memory: { type: "string", default: "4" },
    cpus: { type: "string", default: "4" },
    "disk-gb": { type: "string", default: "64" },
  },
})
const sourceDir = values["source-dir"]
const keyFile = values["key-file"]
const storage = values.storage
if (!sourceDir || !keyFile || !storage) throw new Error("要 --source-dir、--key-file、--storage")
if (!vmConfig.storageRoots.includes(storage)) throw new Error(`--storage 要在 HEYAGENT_DESKTOP_STORAGE_ROOTS 里（现在：${vmConfig.storageRoots.join(",") || "空"}）`)
if (!vmConfig.podmanSocket) throw new Error("要 HEYAGENT_PODMAN_SOCKET")
const source = join(sourceDir, values.disk!)
const format = source.endsWith(".qcow2") ? "qcow2" : "raw"
if (!(await stat(source)).isFile()) throw new Error(`没有 ${source}`)
const key = (await readFile(keyFile, "utf8")).trim()
if (key.length < 16) throw new Error("密钥太短")

const { db, pool } = createDb(env.databaseUrl, 2)
const keyring = loadKeyring(env.kekFile)
const podman = new PodmanClient(vmConfig.podmanSocket)
try {
  await podman.ping()
  const [admin] = await db.select({ id: t.users.id }).from(t.users).where(eq(t.users.role, "admin")).orderBy(asc(t.users.createdAt)).limit(1)
  if (!admin) throw new Error("库里还没有主管账号（先 pnpm db:seed）")
  const id = `dk-import-${randomBytes(3).toString("hex")}`
  const dir = vmDirOf(storage, id)
  await mkdir(dir, { recursive: true })
  const started = Date.now()
  console.log(`转换 ${source}（${format}）→ ${diskOf(dir)}（qcow2）……机械盘上要几分钟`)
  await podman.ensureImage(vmConfig.image)
  await podman.runOnce(
    {
      name: `heyagent-${id}-import`,
      image: vmConfig.image,
      entrypoint: ["qemu-img"],
      command: ["convert", "-f", format, "-O", "qcow2", source, diskOf(dir)],
      mounts: [
        { source: sourceDir, destination: sourceDir, readOnly: true },
        { source: dir, destination: dir },
      ],
    },
    3 * 60 * 60_000
  )
  console.log(`转换完成：${Math.round((Date.now() - started) / 1000)} 秒`)
  console.log(`复制状态文件：${(await copyStateFiles(sourceDir, dir)).join("、")}`)
  await chmod(diskOf(dir), 0o444)

  const [mcpPort, agentPort] = await (async () => {
    const [low, high] = vmConfig.portRange
    const used = new Set((await db.select({ a: t.desktopVms.mcpPort, b: t.desktopVms.agentPort }).from(t.desktopVms)).flatMap((row) => [row.a, row.b]))
    const free: number[] = []
    for (let port = low; port <= high && free.length < 2; port++) if (!used.has(port)) free.push(port)
    return free as [number, number]
  })()
  await db.transaction(async (tx) => {
    const [last] = await tx.select({ n: count() }).from(t.desktops)
    await tx.insert(t.desktops).values({ id, kind: "template", name: values.name!, description: "开发用：从验证虚拟机导入", ...vmUrls(mcpPort, agentPort), createdById: admin.id, position: last?.n ?? 0 })
    const keySecretId = await putSecret(tx, keyring, { scope: "desktop", refId: id, name: "key" }, key, admin.id, 0)
    // 导入的磁盘里 Windows 的密码不知道（自动登录用不到），存一个占位的
    const vmPasswordSecretId = await putSecret(tx, keyring, { scope: "desktop", refId: id, name: "vmPassword" }, `Ha-${randomBytes(12).toString("hex")}`, admin.id, 0)
    await tx.update(t.desktops).set({ keySecretId }).where(eq(t.desktops.id, id))
    await tx.insert(t.desktopVms).values({
      desktopId: id,
      storagePath: storage,
      dir,
      container: containerNameOf(id),
      state: "ready",
      desired: "stopped",
      installedAt: new Date(),
      memoryGb: Number(values.memory),
      cpus: Number(values.cpus),
      diskGb: Number(values["disk-gb"]),
      mcpPort,
      agentPort,
      vmPasswordSecretId,
    })
  })
  console.log(`导入好了：模板 ${id}（${dir}）`)
} finally {
  await pool.end()
}
