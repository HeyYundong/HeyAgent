// 技能的正文由代码从文件取（不让模型抄写几万字）：方案里的技能写了 path 的，读那个文件、去掉开头的元数据当正文，
// 名字、说明没写就取元数据。同目录 references/ 下的文本文件：正文加起来不超过 5 万字就合并进正文（记进 merged），
// 超了就每个参考文件单独做一个技能「<技能名> · <文件标题>」（同岗位、同分组，用到主技能的任务也选上它们），主技能正文末尾列出这些技能名。
// scripts/ 下的脚本不导入，进「没用上的文件」。
import type { ImportPlan, PlanSkill } from "@heyagent/shared"

import { markdownTitle, parseFrontMatter, type ImportPackage } from "./package.js"

/** 技能正文的上限（同 planSkillSchema.body） */
const BODY_MAX = 50_000

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** 把写了 path 的技能补上正文、名字、说明，按需要拆出参考资料技能。会改 plan */
export async function fillSkillBodies(plan: ImportPlan, skillPaths: Map<string, string>, pkg: ImportPackage): Promise<void> {
  const infos = new Map((await pkg.skills()).map((info) => [info.path, info]))
  const keys = new Set([...plan.tasks, ...plan.skills, ...plan.memories, ...plan.rules, ...plan.tools].map((item) => item.key))
  const out: PlanSkill[] = []
  for (const skill of plan.skills) {
    out.push(skill)
    const path = skillPaths.get(skill.key)
    if (!path) continue
    const text = (await pkg.text(path)) ?? ""
    const { meta, body } = parseFrontMatter(text)
    const info = infos.get(path)
    skill.name = (skill.name.trim() || meta.name?.trim() || baseOf(dirOf(path)) || baseOf(path).replace(/\.[^.]+$/, "")).slice(0, 100)
    skill.description = (skill.description.trim() || meta.description?.trim() || skill.name).slice(0, 300)
    // 正文就是从这个文件取的：来源写文件路径（AI 写的「在哪看到要导入它」不算来源，「没用上的文件」也按它判断）
    skill.source = path
    let main = body.trim()
    if (main.length > BODY_MAX) {
      plan.warnings.push({ kind: "other", title: `技能「${skill.name.slice(0, 40)}」的正文截断了`, text: `${path} 有 ${main.length} 字，技能正文最多 ${BODY_MAX} 字，后面的没导入。` })
      main = main.slice(0, BODY_MAX)
    }
    const references: { path: string; title: string; text: string }[] = []
    for (const ref of info?.references ?? []) {
      const refText = (await pkg.text(ref))?.trim()
      if (refText) references.push({ path: ref, title: markdownTitle(ref, refText), text: refText })
    }
    const total = main.length + references.reduce((sum, ref) => sum + ref.text.length + ref.title.length + 20, 0)
    if (references.length && total <= BODY_MAX) {
      main += references.map((ref) => `\n\n---\n\n## 参考：${ref.title}\n\n${ref.text}`).join("")
      skill.merged = [...new Set([...skill.merged, ...references.map((ref) => ref.path)])].slice(0, 50)
    } else if (references.length) {
      // 太长了：每个参考文件单独做一个技能
      const extra: PlanSkill[] = []
      references.forEach((ref, index) => {
        let key = `${skill.key}-r${index + 1}`
        for (let n = 2; keys.has(key); n++) key = `${skill.key}-r${index + 1}-${n}`
        keys.add(key)
        extra.push({
          key: key.slice(0, 40),
          include: skill.include,
          ...(skill.group ? { group: skill.group } : {}),
          name: `${skill.name} · ${ref.title}`.slice(0, 100),
          dept: skill.dept,
          description: `「${skill.name}」的参考资料：${ref.title}`.slice(0, 300),
          body: ref.text.slice(0, BODY_MAX),
          toolKeys: [],
          source: ref.path.slice(0, 500),
          merged: [],
          resolution: "new",
        })
      })
      const list = `\n\n## 参考资料（太长，另外导入成了单独的技能）\n${extra.map((each) => `- ${each.name}`).join("\n")}`
      main = (main + list).slice(0, BODY_MAX)
      out.push(...extra)
      // 用到主技能的任务也选上这些参考技能
      for (const task of plan.tasks) {
        if (task.skillKeys.includes(skill.key)) task.skillKeys = [...task.skillKeys, ...extra.map((each) => each.key)].slice(0, 200)
      }
    }
    skill.body = main
    // AI 已经把这个目录（或它的上级）列进了「没用上的文件」就不重复
    if (info?.scripts.length && !info.scripts.every((path) => pkg.unusedCovers(plan.unused, path))) plan.unused.push({ path: `${info.dir ? `${info.dir}/` : ""}scripts/（${info.scripts.length} 个文件）`.slice(0, 500), reason: "平台不运行脚本" })
  }
  plan.skills = out.slice(0, 1000)
  plan.unused = plan.unused.slice(0, 500)
  plan.warnings = plan.warnings.slice(0, 50)
}
