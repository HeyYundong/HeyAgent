import { useState } from "react"
import { CoinsIcon, CpuIcon, ServerIcon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { ItemGroup } from "@/components/ui/item"
import { href } from "@/lib/router"
import { allModels, findById, modelDefaults, modelFamily, modelProviders } from "./demo-data/prototype"

import { modelExample, modelRoles, price, type ModelRole } from "./demo-data/lessons"
import { Lesson, Step, TextLink, Tiles } from "./parts"

const providerOf = (modelId: string) => modelProviders.find((provider) => provider.models.some((model) => model.id === modelId))!
const modelOf = (id: string) => findById(allModels, id)!
const options = modelRoles.map((item) => ({ id: item.id, label: item.label }))
const tiles = modelRoles.map((item) => {
  const id = modelDefaults[item.id]
  return { id: item.id, title: item.label, badge: providerOf(id).id === "ollama" ? "Ollama" : "OpenRouter", text: `${modelOf(id).name} · ${modelFamily(id)}` }
})

export function ModelsLesson() {
  const [roleId, setRoleId] = useState<ModelRole>("verify")
  const role = modelRoles.find((item) => item.id === roleId) ?? modelRoles[0]
  const model = modelOf(modelDefaults[role.id])
  const provider = providerOf(model.id)
  const sample = modelExample(role.id)

  return (
    <Lesson
      title="模型：执行和验收用不同家"
      meta="模型从两家服务接进来：内网的 Ollama（本地免费）和 OpenRouter（按 token 付费）。规划、执行、三方验收各有一个默认模型；验收不许和执行用同一家：同一家的模型容易犯同样的错、认同自己的说法。模型页保存不了，新建任务也会拦。"
      choice={{ label: "选一个角色", value: role.id, options, onChange: setRoleId }}
    >
      <DetailSection title="三个角色的默认模型">
        <Tiles items={tiles} activeId={role.id} className="grid gap-1 sm:grid-cols-3" />
      </DetailSection>

      <DetailSection
        title={`${role.label}：${model.name}`}
        description={role.what}
        action={<TextLink to={href("models", { id: provider.id })}>去模型页 →</TextLink>}
      >
        <ItemGroup className="gap-1">
          <Step tone="run" icon={<ServerIcon />} title={`${provider.name} · ${modelFamily(model.id)} 家的模型`} text={`${model.note}；上下文 ${model.contextK}k`} />
          <Step tone="run" icon={<CoinsIcon />} title={price(model)} />
          <Step tone="log" icon={<CpuIcon />} title={`例子：${sample.title}`} text={sample.text} />
        </ItemGroup>
      </DetailSection>
    </Lesson>
  )
}
