// 运行详情的「记忆」区块（docs/dev/memory-retrieval.md 6.2 节）：这次给了 agent 哪些记忆。
// 手选的在前、自动挑的在后（带相似度），最下面一行写挑选情况；任务记忆只写条数。数据来自 sessions.get 的 memoryUse（摘要里没有），取到前不显示。
// 相似度写成 0.78，不写百分比（同图库：只看排序，不能按「78% 像」理解）。
import type { AutoMemorySnapshot, RunMemoryUse, RunStatus } from "@heyagent/shared"
import { isRunEnded } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import { Badge } from "@/components/ui/badge"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { href } from "@/lib/router"

const score = (value: number) => value.toFixed(2)

/** 标题：开着自动挑选时分开写「手选 2 · 自动挑 3」，没开就是「2 条」 */
function sectionTitle(use: RunMemoryUse) {
  const autoCount = use.items.filter((item) => item.auto).length
  const manualCount = use.items.length - autoCount
  return use.auto ? `记忆 · 手选 ${manualCount} · 自动挑 ${autoCount}` : `记忆 · ${manualCount} 条`
}

/** 最下面一行的挑选情况（文案照第 5.3 节的过程标题和原因） */
function AutoStatusLine({ auto, picked, status }: { auto: AutoMemorySnapshot; picked: number; status: RunStatus }) {
  const notReady = auto.notReady ? `；还有 ${auto.notReady} 条没算好，这次没参与` : ""
  const scope = [
    auto.candidates !== undefined && `参与挑选 ${auto.candidates} 条`,
    auto.minScore !== undefined && `门槛 ${score(auto.minScore)}`,
  ].filter(Boolean).join("，")
  if (auto.status === "pending") {
    if (isRunEnded(status)) return <p className="text-muted-foreground">运行结束前没来得及自动挑记忆。</p>
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner />
        挑选中
      </p>
    )
  }
  if (auto.status === "done") {
    if (picked > 0) return <p className="text-muted-foreground">{scope}{notReady}。</p>
    // 一条都没够门槛：后端在 reason 里写最像的一条（有的话）
    const detail = [scope, auto.reason].filter(Boolean).join("，")
    return <p className="text-muted-foreground">没有够像的记忆{detail ? `（${detail}）` : ""}{notReady}。</p>
  }
  if (auto.status === "skipped") return <p className="text-muted-foreground">没自动挑记忆{auto.reason ? `：${auto.reason}` : ""}。</p>
  return <p className="text-muted-foreground">自动挑记忆没做成{auto.reason ? `：${auto.reason}` : ""}。这次只用手选的记忆。</p>
}

export function RunMemorySection({ use, status }: { use?: RunMemoryUse; status: RunStatus }) {
  // 没取到详情、或者没有任何记忆也没开自动挑选的，不显示
  if (!use || (use.items.length === 0 && !use.auto)) return null
  const picked = use.items.filter((item) => item.auto).length
  return (
    <DetailSection
      title={sectionTitle(use)}
      description="手选的是任务里选上的记忆，agent 必须遵守；自动挑的是运行开始时按这次要办的事从记忆库里挑的，agent 觉得和这次的事无关可以不用。相似度只用来排先后，不是百分比。"
    >
      <div className="flex flex-col gap-3">
        {use.items.length > 0 && (
          <ItemGroup className="gap-2">
            {use.items.map((item) => (
              <Item key={item.id} variant="outline" size="sm" render={<a href={href("memory", { id: item.id })} />}>
                <ItemContent className="min-w-0">
                  <ItemTitle className="line-clamp-2">{item.content}</ItemTitle>
                  <ItemDescription>{item.id} · {item.appliesTo}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  {item.auto ? <Badge variant="secondary">自动 · {score(item.auto.score)}</Badge> : <Badge variant="outline">手选</Badge>}
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
        {use.auto && <AutoStatusLine auto={use.auto} picked={picked} status={status} />}
        {use.taskMemoryCount > 0 && <p className="text-muted-foreground">另有任务记忆 {use.taskMemoryCount} 条，全部给了 agent。</p>}
      </div>
    </DetailSection>
  )
}
