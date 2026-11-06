// Business tool views registered under the keyed `tool.call.toolview` slot by
// wire tool name. dsh's ui-tool keeps the tree, pairing and lifecycle; this
// only draws one atomic call from its phase + block.
import { Tag, IconUserOutlineRegular, IconCheckCircleOutlineRegular, IconDeliverDocRegular, IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

function toolArgs(block) {
  const raw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? ''
  try { return JSON.parse(raw) } catch { return {} }
}
function toolResult(block) {
  if (!('kind' in block)) return null
  return (block.content ?? []).map(c => (c.type === 'text' ? c.text : '')).join('\n') || null
}

const TOOL_META = {
  ask_human: { icon: IconUserOutlineRegular, label: '要人办', card: true },
  checkpoint_mark: { icon: IconCheckCircleOutlineRegular, label: '检查点' },
  run_finish: { icon: IconDeliverDocRegular, label: '收尾', card: true },
}

export const HEYAGENT_TOOLVIEWS = Object.keys(TOOL_META)

export function HeyAgentToolRow({ phase, block, toolName }) {
  const meta = TOOL_META[toolName] ?? { icon: IconCodeOutlineRegular, label: toolName }
  const Icon = meta.icon
  const args = toolArgs(block)
  const result = toolResult(block)
  const running = phase !== 'result'
  const failed = !running && block.isError === true
  const desc = String(args.description ?? '')
  if (!meta.card) {
    return (
      <div className="ha-tr">
        <Icon size={14} />
        <span className="ha-tr-label">{meta.label}</span>
        <span className="ha-tr-dot" />
        <span className={'ha-tr-desc' + (running ? ' ha-tr-run' : '')}>{desc.replace(/^检查点\s*/, '')}</span>
        {!running && !failed ? <Tag tone="success">达成</Tag> : null}
      </div>
    )
  }
  const tone = running ? 'warning' : failed ? 'danger' : 'success'
  const state = toolName === 'ask_human'
    ? (running ? '等人处理' : failed ? '没处理' : '已处理')
    : (running ? '收尾中' : '办成 · 复核中')
  return (
    <div className="ha-tcard">
      <div className="ha-tcard-head">
        <Icon size={16} />
        <span className="ha-tr-label">{meta.label}</span>
        <span className="ha-tcard-title">{desc}</span>
        <Tag tone={tone}>{state}</Tag>
      </div>
      {toolName === 'ask_human' && args.question ? <div className="ha-tcard-q">{args.question}</div> : null}
      {toolName === 'run_finish' && args.summary ? <div className="ha-tcard-q">{args.summary}</div> : null}
      {result ? <div className="ha-tcard-r">{result}</div> : null}
      {toolName === 'ask_human' ? <div className="ha-tcard-meta">要人办 L-88 · 分给 采购组 · 浏览器 采购-1</div> : null}
    </div>
  )
}
