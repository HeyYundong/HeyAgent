// HeyAgent mock — host-side dsh plugin (plain ESM, no imports from dsh).
//
// 1. Registers mock HeyAgent run tools on ctx.tools (canned results).
// 2. Gates one call through `tools/pre-execute` → deny with an approval-pending
//    message (what HeyAgent's approval rules would do).
// 3. Starts a tiny OpenAI-compatible Chat Completions server on 127.0.0.1:3481
//    that streams a scripted "planner" run (reasoning + tool calls + report).
//    dsh's own llm-pi-ai adapter talks to it as a custom provider
//    (`heyagent-mock`, see ../../home/cordis.patch.yml), so the conversation
//    the user sees is a real dsh session rendered by dsh's real chat UI.
import http from 'node:http'

export const name = 'heyagent-mock-host'
export const inject = ['tools']

const MOCK_PORT = Number(process.env.HEYAGENT_MOCK_PORT ?? 3481)

const text = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const descParam = { type: 'string', description: 'One short line shown to the user: what this call does.' }

/** Mock HeyAgent tools: name → [description, extra params, canned result]. */
const TOOLS = {
  browser_open: ['Open a URL in the run\'s Chrome (HeyAgent browser sub-agent).', { url: { type: 'string' } },
    '已打开 https://s.1688.com/selloffer/offer_search.htm?keywords=不锈钢保温杯 （浏览器：采购-1，账号 buyer01）'],
  browser_snapshot: ['Read the current page as an accessibility snapshot.', {},
    [
      '页面：1688 搜索「不锈钢保温杯 500ml」 · 共 4,812 条',
      '- [e12] 义乌乐享杯业  ¥9.20  起订 300  回头率 41%  48h 发货',
      '- [e18] 永康华美保温器皿  ¥8.65  起订 1000  回头率 37%',
      '- [e23] 浙江顺发日用品  ¥10.40  起订 100  回头率 52%  支持定制 logo',
      '- [e31] 金华铭途工贸  ¥7.90  起订 2000  回头率 18%',
      '（另有 16 条，已按「价格 × 起订量 × 回头率」排序取前 4）',
    ].join('\n')],
  checkpoint_mark: ['Mark a task checkpoint as reached (HeyAgent run checkpoints).', { checkpoint: { type: 'string' } },
    '已记录检查点。'],
  browser_click: ['Click an element by ref.', { ref: { type: 'string' }, action: { type: 'string' } },
    '已点击。'],
  ask_human: ['Hand a step to a person (login / captcha / question). Waits until done.', { kind: { type: 'string' }, question: { type: 'string' } },
    '张伟 在「要人办」接手了浏览器，已登录 1688（用时 1 分 12 秒）。现在可以看供应商联系方式了。'],
  sheet_write: ['Write rows to a spreadsheet deliverable in the run space.', { file: { type: 'string' } },
    '已写入 比价表-2026-11-06.xlsx（4 行，空间 /deliverables/）'],
  run_finish: ['Finish the run with an outcome for AI review.', { outcome: { type: 'string', enum: ['achieved', 'not_achieved'] }, summary: { type: 'string' } },
    '运行已收尾：结果「办成」，已交给 AI 复核（预计 1 分钟）。'],
}

export function apply(ctx) {
  for (const [toolName, [description, params, result]] of Object.entries(TOOLS)) {
    ctx.tools.register({
      name: toolName,
      description,
      parameters: { type: 'object', properties: { description: descParam, ...params }, required: ['description'] },
      output: text,
      async execute() {
        await new Promise(r => setTimeout(r, 600))
        return result
      },
    })
  }

  // HeyAgent approval rule: sending an inquiry to a supplier needs a manager.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const call = exec?.call ?? exec
    const toolName = call?.name ?? exec?.name ?? exec?.toolName
    if (toolName === 'browser_click') {
      return {
        kind: 'deny',
        reason: '需要审批：规则「对外发询价要主管批准」拦下了这一步。已在「要人办」建了一件事（A-1043，等 张伟 批），批准后运行从这里继续；在此之前不要再点「发送询价」。',
      }
    }
    return next()
  })

  ctx.effect(() => {
    const server = http.createServer((req, res) => handle(req, res).catch(err => {
      console.error('[heyagent-mock] error', err)
      try { res.statusCode = 500; res.end(String(err)) } catch {}
    }))
    server.listen(MOCK_PORT, '127.0.0.1', () => console.log(`[heyagent-mock] mock OpenAI server on 127.0.0.1:${MOCK_PORT}`))
    return () => server.close()
  }, 'heyagent mock llm server')
}

// ───────────────────────── mock OpenAI server ─────────────────────────

const STEPS = [
  {
    think: '任务「每日比价」：在 1688 找 500ml 不锈钢保温杯，比价格、起订量、回头率，挑 3 家发询价，最后交一张比价表。先按任务说明打开搜索页。',
    say: '好的，我按「每日比价」的步骤来：先去 1688 搜索，再比价、发询价，最后交比价表。',
    call: ['browser_open', { description: '打开 1688 搜索「不锈钢保温杯 500ml」', url: 'https://s.1688.com/selloffer/offer_search.htm?keywords=不锈钢保温杯' }],
  },
  {
    think: '页面打开了。读一下页面结构，拿前 20 个商品的价格、起订量和回头率。',
    call: ['browser_snapshot', { description: '看页面：前 20 个商品的价格、起订量、回头率' }],
  },
  {
    think: '义乌乐享（¥9.20/300 起）、浙江顺发（¥10.40/100 起，可定制）、永康华美（¥8.65/1000 起）综合最好；金华铭途太便宜且回头率低，排除。检查点 1「找到至少 3 家候选」达成。',
    call: ['checkpoint_mark', { description: '检查点 1/3：找到 3 家候选供应商', checkpoint: '找到至少 3 家候选供应商' }],
  },
  {
    think: '给第一家发询价：点「发送询价」。',
    call: ['browser_click', { description: '给「义乌乐享杯业」发询价单', ref: 'e12-inquiry', action: 'submit_inquiry' }],
  },
  {
    think: '发询价被审批规则拦下了，已经在要人办里等张伟批。不能再点发送。先做不需要审批的事：看供应商联系方式——但 1688 要登录才显示，需要人来登录。',
    say: '「发询价」要主管批准，我已经停下这一步，等审批。先去拿供应商联系方式——这一步需要登录，交给人处理。',
    call: ['ask_human', { description: '请人登录 1688（要人办 · 接手浏览器）', kind: 'login', question: '1688 要求登录后才能看联系方式，请在「要人办」里打开远程画面登录 buyer01。' }],
  },
  {
    think: '登录好了，联系方式拿到。检查点 2 达成。把结果写进比价表。',
    call: ['checkpoint_mark', { description: '检查点 2/3：拿到 3 家联系方式', checkpoint: '拿到候选供应商的联系方式' }],
  },
  {
    call: ['sheet_write', { description: '写比价表（交付物）', file: '比价表-2026-11-06.xlsx' }],
  },
  {
    think: '比价表交了，询价等审批后会继续。按任务要求收尾，交给 AI 复核。',
    call: ['run_finish', { description: '收尾：办成，交 AI 复核', outcome: 'achieved', summary: '找到 3 家候选并完成比价表；询价单 A-1043 等主管审批后自动发送。' }],
  },
  {
    think: '写最终报告。',
    say: [
      '## 运行报告 · 每日比价 R-1106-3',
      '',
      '**结果：办成**（等 AI 复核）　**检查点 3/3**　**用时 6 分 41 秒**',
      '',
      '| 供应商 | 单价 | 起订量 | 回头率 | 备注 |',
      '|---|---|---|---|---|',
      '| 义乌乐享杯业 | ¥9.20 | 300 | 41% | 48 小时发货，**推荐** |',
      '| 浙江顺发日用品 | ¥10.40 | 100 | 52% | 可定制 logo |',
      '| 永康华美保温器皿 | ¥8.65 | 1000 | 37% | 起订量偏大 |',
      '',
      '- 交付物：`比价表-2026-11-06.xlsx`（运行空间 /deliverables/）',
      '- 要人办过的事：登录 1688（张伟，1 分 12 秒）',
      '- **还在等：** 询价单 A-1043 等 张伟 审批，批准后自动发给 义乌乐享杯业',
      '- 记忆候选：「顺发支持 100 起订的定制款」——请在收尾卡里确认是否记住',
    ].join('\n'),
  },
]

function genericReply(userText) {
  return {
    think: '这不是一个任务指令，按普通对话回答。',
    say: `（HeyAgent 模拟模型）收到：「${userText.slice(0, 80)}」。\n\n这是一个脚本化的模拟模型，只会演示一次固定的运行。试试发：**跑一次每日比价**。`,
  }
}

async function handle(req, res) {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'heyagent-planner', object: 'model', owned_by: 'heyagent' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.statusCode = 404; res.end('not found'); return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  const messages = body.messages ?? []
  // Find the user message that started the scripted run (the run continues
  // through tool results, which are role:'tool').
  // dsh adds its own user-role context messages (e.g. "Time sampled while
  // preparing turn …"); only a real human message restarts the script.
  const isHuman = m => m.role === 'user' && !/^\s*(Time sampled|Current runtime context|<)/.test(contentText(m.content))
  let runStart = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isHuman(messages[i]) && /比价/.test(contentText(messages[i].content))) { runStart = i; break }
  }
  if (process.env.HEYAGENT_MOCK_DUMP) {
    console.log('[heyagent-mock] messages:', JSON.stringify(messages.map(m => [m.role, contentText(m.content).slice(0, 60), (m.tool_calls ?? []).map(c => c.function?.name)])))
  }
  let step
  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    // Auxiliary request (e.g. title generation): answer plainly.
    step = { say: /比价/.test(raw) ? '每日比价 · 不锈钢保温杯' : 'HeyAgent 对话' }
  } else if (runStart >= 0 && !messages.slice(runStart + 1).some(isHuman)) {
    const done = messages.slice(runStart + 1).filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0).length
    step = STEPS[Math.min(done, STEPS.length - 1)]
  } else {
    const human = [...messages].reverse().find(isHuman)
    step = genericReply(human ? contentText(human.content) : '')
  }
  console.log(`[heyagent-mock] request: ${messages.length} msgs, tools=${body.tools?.length ?? 0} → ${step.call?.[0] ?? 'text'}`)
  await streamStep(res, body, step)
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : p.text ?? '')).join('')
  return ''
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function pieces(s, n = 6) {
  const out = []
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n))
  return out
}

async function streamStep(res, body, step) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const id = `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const model = body.model ?? 'heyagent-planner'
  const send = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`)
  send({ role: 'assistant', content: '' })
  if (step.think) {
    for (const p of pieces(step.think)) { send({ reasoning_content: p }); await sleep(25) }
  }
  if (step.say) {
    for (const p of pieces(step.say, 8)) { send({ content: p }); await sleep(18) }
  }
  if (step.call) {
    const [name, args] = step.call
    const callId = `call_${name}_${Math.random().toString(36).slice(2, 10)}`
    send({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }] })
    for (const p of pieces(JSON.stringify(args), 12)) { send({ tool_calls: [{ index: 0, function: { arguments: p } }] }); await sleep(15) }
    send({}, 'tool_calls')
  } else {
    send({}, 'stop')
  }
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: 3200, completion_tokens: 180, total_tokens: 3380 } })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}
