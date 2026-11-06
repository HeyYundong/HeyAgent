// HeyAgent mock panels rendered inside dsh's main panel, built from dsh's own
// ui-primitives (Button, Tag, SegmentedTabs, StateDot, icons) and --dsw-* tokens.
import { useState } from 'react'
import {
  Button, Tag, SegmentedTabs, StateDot,
  IconCheckCircleOutlineRegular, IconGlobeOutlineRegular, IconUserOutlineRegular, IconQuestionOutlineRegular,
  IconShieldOutlineRegular, IconWarningOutlineRegular, IconChecklistOutlineRegular, IconPlayOutlineRegular,
  IconPlusOutlineRegular, IconSearchOutlineRegular, IconCodeOutlineRegular, IconClockOutlineRegular,
  IconGoalOutlineRegular, IconSkillOutlineRegular, IconDeliverDocRegular, IconDataOutlineRegular,
  IconEditOutlineRegular, IconRefreshOutlineRegular, IconFullscreenOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { INBOX, TASKS, BROWSERS, DESKTOPS } from './data.js'

const KIND_ICON = {
  approval: IconShieldOutlineRegular, login: IconUserOutlineRegular, captcha: IconWarningOutlineRegular,
  question: IconQuestionOutlineRegular, verify: IconChecklistOutlineRegular,
}

function PanelFrame({ title, help, actions, children }) {
  return (
    <div className="ha-page">
      <div className="ha-head">
        <h1>{title}<span className="ha-help" title={help}>?</span></h1>
        <div className="ha-actions">{actions}<Button variant="outline" size="sm" className="ha-pillbtn">助手</Button></div>
      </div>
      <div className="ha-body">{children}</div>
    </div>
  )
}

function Chips({ items, value, onChange }) {
  return (
    <div className="ha-chips">
      {items.map(([v, label]) => (
        <button key={v} type="button" className={'ha-chip' + (v === value ? ' ha-chip-on' : '')} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  )
}

function Search({ placeholder }) {
  return (
    <label className="ha-search"><IconSearchOutlineRegular size={14} /><input placeholder={placeholder} /></label>
  )
}

function Fields({ rows }) {
  return (
    <dl className="ha-dl">
      {rows.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
    </dl>
  )
}

function Section({ title, icon: Icon, children, extra }) {
  return (
    <section className="ha-card">
      <div className="ha-card-head">{Icon ? <Icon size={16} /> : null}<span>{title}</span>{extra}</div>
      {children}
    </section>
  )
}

// ─────────────────────────────── 要人办 ───────────────────────────────

export function InboxPage({ onOpenRun, onOpenRemote }) {
  const [tab, setTab] = useState('pending')
  const [sel, setSel] = useState('A-1043')
  const rows = INBOX.filter(i => (tab === 'pending' ? i.state === 'pending' : tab === 'done' ? i.state === 'done' : false))
  const item = INBOX.find(i => i.id === sel) ?? rows[0]
  return (
    <PanelFrame title="要人办" help="挡住运行、要人来办的事：审批、登录、验证码、回答、验收待定。">
      <div className="ha-split">
        <div className="ha-list">
          <Chips value={tab} onChange={setTab} items={[['pending', '待处理 5'], ['done', '已处理'], ['notice', '通知 2']]} />
          <Search placeholder="搜索运行号、任务、内容" />
          {tab === 'notice' ? (
            <div className="ha-rows">
              <div className="ha-row"><span className="ha-glyph"><StateDot state="done" /></span><div><div className="ha-row-title">R-1106-2 每日比价 已办成</div><div className="ha-meta">AI 复核通过 · 8:52</div></div></div>
              <div className="ha-row"><span className="ha-glyph"><StateDot state="error" /></span><div><div className="ha-row-title">R-1105-9 竞品价格监控 没办成</div><div className="ha-meta">拼多多改版，3 个链接读不到 · 昨天</div></div></div>
            </div>
          ) : (
            <div className="ha-rows">
              {rows.map(i => {
                const Icon = KIND_ICON[i.kind]
                return (
                  <button key={i.id} type="button" className={'ha-row' + (item?.id === i.id ? ' ha-row-on' : '')} onClick={() => setSel(i.id)}>
                    <span className="ha-glyph"><Icon size={16} /></span>
                    <div className="ha-row-main">
                      <div className="ha-row-title">{i.title}</div>
                      <div className="ha-meta">{i.kindLabel} · {i.run} {i.task} · {i.age}</div>
                    </div>
                    {i.state === 'pending' ? <Tag tone="warning">{i.kindLabel}</Tag> : <Tag tone="success">已处理</Tag>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        {item && tab !== 'notice' ? (
          <div className="ha-detail">
            <div className="ha-detail-head">
              <div>
                <div className="ha-detail-title">{item.title}</div>
                <div className="ha-meta">{item.id} · 分给 {item.who} · {item.age}前</div>
              </div>
              <Button variant="ghost" size="sm" onClick={onOpenRun} icon={<IconPlayOutlineRegular size={14} />}>打开运行 {item.run}</Button>
            </div>
            <p className="ha-lead">{item.summary}</p>
            {item.browser ? (
              <div className="ha-shot-wrap"><FakeBrowser compact login={item.kind === 'login'} captcha={item.kind === 'captcha'} /></div>
            ) : null}
            <Fields rows={item.fields} />
            {item.kind === 'question' ? <textarea className="ha-textarea" placeholder="写给 agent 的回答…" defaultValue="按含税 13% 核，报价单另列不含税价。" /> : null}
            {item.result ? <Tag tone="success">{item.result}</Tag> : null}
            <div className="ha-btnrow">
              {item.actions.map((a, idx) => (
                <Button key={a} variant={idx === 0 ? 'primary' : 'outline'} onClick={a === '接手浏览器' ? onOpenRemote : a === '打开运行' ? onOpenRun : undefined}>{a}</Button>
              ))}
            </div>
          </div>
        ) : <div className="ha-detail ha-empty">选一件事看详情</div>}
      </div>
    </PanelFrame>
  )
}

// ─────────────────────────────── 任务 ───────────────────────────────

export function TasksPage({ onNewRun }) {
  const [sel, setSel] = useState('T-12')
  const [filter, setFilter] = useState('all')
  const [tab, setTab] = useState('structure')
  const rows = TASKS.filter(t => filter === 'all' || (filter === 'mine' ? t.owner === '张伟' : !t.enabled))
  const t = TASKS.find(x => x.id === sel) ?? rows[0]
  return (
    <PanelFrame title="任务" help="任务 = 一份配置：目标、步骤、检查点、工具、规则、交付物、什么时候跑。每次执行是一次运行。"
      actions={<Button variant="primary" size="sm" className="ha-pillbtn" icon={<IconPlusOutlineRegular size={14} />}>新建任务</Button>}>
      <div className="ha-split">
        <div className="ha-list">
          <Chips value={filter} onChange={setFilter} items={[['all', '全部'], ['mine', '我负责的'], ['off', '已停用']]} />
          <Search placeholder="搜索任务" />
          <div className="ha-rows">
            {rows.map(x => (
              <button key={x.id} type="button" className={'ha-row' + (t?.id === x.id ? ' ha-row-on' : '')} onClick={() => setSel(x.id)}>
                <span className="ha-glyph"><IconChecklistOutlineRegular size={16} /></span>
                <div className="ha-row-main">
                  <div className="ha-row-title">{x.name}</div>
                  <div className="ha-meta">{x.category} · {x.owner} · {x.schedule}</div>
                </div>
                {x.enabled ? <Tag tone="success">启用</Tag> : <Tag tone="neutral">停用</Tag>}
              </button>
            ))}
          </div>
        </div>
        {t ? (
          <div className="ha-detail">
            <div className="ha-detail-head">
              <div>
                <div className="ha-detail-title">{t.name} <span className="ha-meta">{t.id}</span></div>
                <div className="ha-meta">负责人 {t.owner} · {t.schedule} · 下次 {t.next} · {t.runs}</div>
              </div>
              <div className="ha-btnrow ha-tight">
                <Button variant="outline" size="sm" icon={<IconEditOutlineRegular size={14} />}>编辑</Button>
                <Button variant="primary" size="sm" onClick={onNewRun} icon={<IconPlayOutlineRegular size={14} />}>新运行</Button>
              </div>
            </div>
            <SegmentedTabs size="sm" label="任务详情" value={tab} onChange={setTab} className="ha-tabs" items={[
              { value: 'structure', label: '结构图', id: 'ha-t-s', panelId: 'ha-p-s' },
              { value: 'runs', label: '运行', id: 'ha-t-r', panelId: 'ha-p-r' },
              { value: 'when', label: '什么时候跑', id: 'ha-t-w', panelId: 'ha-p-w' },
              { value: 'memory', label: '任务记忆', id: 'ha-t-m', panelId: 'ha-p-m' },
            ]} />
            {tab === 'structure' ? <TaskStructure t={t} /> : null}
            {tab === 'runs' ? (
              <div className="ha-rows">
                {[['R-1106-3', 'warning', '等人处理 · 待批准', '3 分钟前'], ['R-1106-2', 'done', '办成 · AI 复核通过', '8:52'], ['R-1105-1', 'done', '办成', '昨天'], ['R-1104-1', 'error', '没办成 · 1688 改版', '周二']].map(([id, st, label, when]) => (
                  <div key={id} className="ha-row"><span className="ha-glyph"><StateDot state={st} /></span><div className="ha-row-main"><div className="ha-row-title">{id} 每日比价</div><div className="ha-meta">{label}</div></div><span className="ha-meta">{when}</span></div>
                ))}
              </div>
            ) : null}
            {tab === 'when' ? <Fields rows={[['定时', t.schedule], ['下次', t.next], ['派活', '可以被「新品上架检查」派活'], ['外部事件', 'POST /api/events · price.alert']]} /> : null}
            {tab === 'memory' ? (t.memory.length ? <ul className="ha-ul">{t.memory.map(m => <li key={m}>{m}</li>)}</ul> : <div className="ha-empty">还没有任务记忆</div>) : null}
          </div>
        ) : null}
      </div>
    </PanelFrame>
  )
}

function TaskStructure({ t }) {
  return (
    <div className="ha-structure">
      <Section title="目标" icon={IconGoalOutlineRegular}><p className="ha-p">{t.goal}</p></Section>
      <div className="ha-loop">
        <div className="ha-loop-label">agent 循环 · {t.model}</div>
        <div className="ha-grid2">
          <Section title={`步骤 ${t.steps.length}`} icon={IconChecklistOutlineRegular}><ol className="ha-ol">{t.steps.map(s => <li key={s}>{s}</li>)}</ol></Section>
          <Section title={`检查点 ${t.checkpoints.length}`} icon={IconCheckCircleOutlineRegular}><ol className="ha-ol">{t.checkpoints.map(s => <li key={s}>{s}</li>)}</ol></Section>
          <Section title="工具" icon={IconCodeOutlineRegular}><div className="ha-tags">{t.tools.map(s => <Tag key={s} tone="outline">{s}</Tag>)}</div></Section>
          <Section title="规则" icon={IconShieldOutlineRegular}>{t.rules.length ? <ul className="ha-ul">{t.rules.map(s => <li key={s}>{s}</li>)}</ul> : <span className="ha-meta">没有</span>}</Section>
        </div>
      </div>
      <Section title="交付物" icon={IconDeliverDocRegular}><div className="ha-tags">{t.deliverables.map(s => <Tag key={s} tone="info">{s}</Tag>)}</div></Section>
      <Section title="技能 / 记忆" icon={IconSkillOutlineRegular}><div className="ha-tags"><Tag tone="neutral">采购比价 SKILL.md</Tag><Tag tone="neutral">1688 操作要点</Tag><Tag tone="neutral">任务记忆 {t.memory.length}</Tag></div></Section>
    </div>
  )
}

// ─────────────────────────────── 浏览器 ───────────────────────────────

export function BrowsersPage({ onOpenRemote }) {
  const [sel, setSel] = useState('b1')
  const b = BROWSERS.find(x => x.id === sel)
  const tone = s => (s === 'human' ? 'warning' : s === 'running' ? 'info' : 'outline')
  return (
    <PanelFrame title="浏览器" help="服务器上的 Chrome 配置：代理、平台账号、保险箱；运行占用时可以看画面、接手。"
      actions={<Button variant="primary" size="sm" className="ha-pillbtn" icon={<IconPlusOutlineRegular size={14} />}>新建 Chrome</Button>}>
      <div className="ha-split">
        <div className="ha-list">
          <Search placeholder="搜索 Chrome 配置" />
          <div className="ha-rows">
            {BROWSERS.map(x => (
              <button key={x.id} type="button" className={'ha-row' + (x.id === sel ? ' ha-row-on' : '')} onClick={() => setSel(x.id)}>
                <span className="ha-glyph"><IconGlobeOutlineRegular size={16} /></span>
                <div className="ha-row-main"><div className="ha-row-title">{x.name}</div><div className="ha-meta">{x.proxy} · {x.accounts.length} 个账号</div></div>
                <Tag tone={tone(x.state)}>{x.stateLabel.split(' · ')[0]}</Tag>
              </button>
            ))}
          </div>
        </div>
        <div className="ha-detail">
          <div className="ha-detail-head">
            <div><div className="ha-detail-title">{b.name}</div><div className="ha-meta">{b.stateLabel}</div></div>
            <div className="ha-btnrow ha-tight">
              <Button variant="outline" size="sm">打开 Chrome</Button>
              <Button variant="primary" size="sm" onClick={onOpenRemote} icon={<IconFullscreenOutlineRegular size={14} />}>看画面</Button>
            </div>
          </div>
          <div className="ha-shot-wrap"><FakeBrowser compact login={b.id === 'b1'} captcha={b.id === 'b2'} /></div>
          <Section title="平台和账号" icon={IconUserOutlineRegular}>
            <div className="ha-rows">
              {b.accounts.map(([p, a, s]) => (
                <div key={p} className="ha-row ha-row-flat"><div className="ha-row-main"><div className="ha-row-title">{p} · {a}</div></div>
                  {s === '已登录' ? <Tag tone="success">已登录</Tag> : <><Tag tone="warning">{s}</Tag><Button variant="outline" size="sm">立刻登录</Button></>}
                </div>
              ))}
            </div>
          </Section>
          <Fields rows={[['代理', b.proxy], ['占用', b.run ?? '—'], ['验证码时保留', '15 分钟'], ['历史', '今天 4 次运行 · 1 次要人登录']]} />
        </div>
      </div>
    </PanelFrame>
  )
}

// ─────────────────────────────── 桌面 ───────────────────────────────

export function DesktopsPage({ onOpenRemote }) {
  const [sel, setSel] = useState('d1')
  const d = DESKTOPS.find(x => x.id === sel)
  const tone = s => ({ on: 'success', ready: 'success', idle: 'outline', off: 'neutral', wait: 'warning' }[s])
  return (
    <PanelFrame title="桌面" help="Windows 电脑：手动登记的、HeyAgent 开的虚拟机，和做虚拟机用的模板。"
      actions={<><Button variant="outline" size="sm" className="ha-pillbtn">做模板</Button><Button variant="primary" size="sm" className="ha-pillbtn" icon={<IconPlusOutlineRegular size={14} />}>新建桌面</Button></>}>
      <div className="ha-split">
        <div className="ha-list">
          {['桌面', '模板'].map(g => (
            <div key={g}>
              <div className="ha-group">{g}</div>
              <div className="ha-rows">
                {DESKTOPS.filter(x => x.group === g).map(x => (
                  <button key={x.id} type="button" className={'ha-row' + (x.id === sel ? ' ha-row-on' : '')} onClick={() => setSel(x.id)}>
                    <span className="ha-glyph"><IconChecklistOutlineRegular size={16} /></span>
                    <div className="ha-row-main"><div className="ha-row-title">{x.name}</div><div className="ha-meta">{x.kind} · {x.detail}</div></div>
                    <Tag tone={tone(x.state)}>{x.stateLabel}</Tag>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="ha-detail">
          <div className="ha-detail-head">
            <div><div className="ha-detail-title">{d.name}</div><div className="ha-meta">{d.kind} · {d.stateLabel}{d.run ? ` · 运行 ${d.run}` : ''}</div></div>
            <Button variant="primary" size="sm" onClick={onOpenRemote}>看画面</Button>
          </div>
          <Section title="这台虚拟机" icon={IconChecklistOutlineRegular}>
            <Fields rows={[['配置', d.detail], ['系统', 'Windows 11 专业版 24H2'], ['连接', 'RDP 正常 · 自动化服务正常']]} />
            <div className="ha-btnrow"><Button variant="primary" size="sm">开机</Button><Button variant="outline" size="sm">关机</Button><Button variant="outline" size="sm">重启</Button><Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={14} />}>重置</Button></div>
          </Section>
        </div>
      </div>
    </PanelFrame>
  )
}

// ─────────────────────── remote view placeholder ───────────────────────

export function FakeBrowser({ compact, login, captcha }) {
  return (
    <div className={'ha-fb' + (compact ? ' ha-fb-compact' : '')}>
      <div className="ha-fb-bar">
        <span className="ha-fb-dots"><i /><i /><i /></span>
        <span className="ha-fb-url">{login ? 'https://login.1688.com/member/signin.htm' : captcha ? 'https://mobile.yangkeduo.com/verify' : 'https://s.1688.com/selloffer/offer_search.htm?keywords=不锈钢保温杯'}</span>
      </div>
      <div className="ha-fb-page">
        {login ? (
          <div className="ha-fb-login"><div className="ha-fb-logo">1688</div><div className="ha-fb-input">buyer01</div><div className="ha-fb-input">••••••••</div><div className="ha-fb-btn">登录</div></div>
        ) : captcha ? (
          <div className="ha-fb-login"><div className="ha-fb-logo">安全验证</div><div className="ha-fb-slider"><span /></div><div className="ha-meta">向右拖动滑块</div></div>
        ) : (
          <div className="ha-fb-grid">
            {['¥9.20 · 义乌乐享杯业', '¥8.65 · 永康华美', '¥10.40 · 浙江顺发', '¥7.90 · 金华铭途', '¥11.20 · 台州恒泰', '¥9.80 · 宁波优品'].map(s => (
              <div key={s} className="ha-fb-item"><div className="ha-fb-img" /><div className="ha-fb-cap">{s}</div></div>
            ))}
          </div>
        )}
        <div className="ha-fb-cursor"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 1l11 6-5 1.5L6 14z" fill="currentColor" /></svg><span>agent 在做：{login ? '等人登录' : captcha ? '等人过验证码' : '读价格'}</span></div>
      </div>
    </div>
  )
}

export function RemoteViewTab() {
  const [mode, setMode] = useState('watch')
  return (
    <div className="ha-rv">
      <div className="ha-rv-banner"><IconWarningOutlineRegular size={14} /><span>等人处理：1688 要登录（要人办 L-88）</span><Button variant="primary" size="sm">已处理好了</Button></div>
      <div className="ha-rv-tools">
        <SegmentedTabs size="sm" label="画面模式" value={mode} onChange={setMode} items={[
          { value: 'watch', label: '只看', id: 'ha-rv-w', panelId: 'ha-rv-p' },
          { value: 'control', label: '我来操作', id: 'ha-rv-c', panelId: 'ha-rv-p' },
        ]} />
        <span className="ha-meta">采购-1 · R-1106-3 · 已连接</span>
      </div>
      <FakeBrowser login />
    </div>
  )
}

export function RunHeaderBadge({ onOpenRemote }) {
  return (
    <span className="ha-hdr">
      <Tag tone="warning">等人处理 · 待批准</Tag>
      <span className="ha-meta">检查点 2/3</span>
      <Button variant="ghost" size="sm" onClick={onOpenRemote} icon={<IconGlobeOutlineRegular size={14} />}>浏览器画面</Button>
    </span>
  )
}

export function TabGuideIcon() {
  return <IconGlobeOutlineRegular size={24} />
}

export { IconClockOutlineRegular }
