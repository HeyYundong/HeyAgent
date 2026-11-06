// heyagent-ui — browser half of the HeyAgent mock (a dsh client plugin).
//
// Everything goes through dsh's public extension points:
//   sidebar.brand.mark / sidebar.brand.name / conversation.hero.brand.mark  (branding)
//   sidebar.panellist + main[<id>]                                           (global panels)
//   ctx.sidebarRightTabs + sidebar.right.pane.tab                             (right-sidebar tab)
//   conversation.session.header.utilities                                    (run header badge)
import {
  IconWarningOutlineRegular, IconChecklistOutlineRegular, IconGlobeOutlineRegular, IconCodeOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { InboxPage, TasksPage, BrowsersPage, DesktopsPage, RemoteViewTab, RunHeaderBadge, TabGuideIcon } from './pages.jsx'
import { HeyAgentToolRow, HEYAGENT_TOOLVIEWS } from './toolviews.jsx'
import css from './styles.css'
import logoB64 from './logo.b64'

const LOGO = `data:image/png;base64,${logoB64.trim()}`
const REMOTE_ID = 'heyagent-ui/remote-view'
const REMOTE_KIND = 'heyagentRemoteView'

export const inject = ['slots', 'layout', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace']

function GoatMark({ size }) {
  return <img src={LOGO} width={size ?? 24} height={size ?? 24} alt="" className="ha-goat" />
}
function HeroMark() {
  return <img src={LOGO} width={40} height={40} alt="" className="ha-goat-hero" />
}
function BrandName() {
  return <span className="ha-brandname">HeyAgent</span>
}

const iconOf = Icon => function PanelIcon({ size }) { return <Icon size={size} /> }
function InboxIcon({ size }) {
  return <span className="ha-panelicon"><IconWarningOutlineRegular size={size} /><i className="ha-badge">5</i></span>
}

export function apply(ctx) {
  // Plugin-owned stylesheet (tokens only): mount on apply, remove on unload.
  ctx.effect(() => {
    const el = document.createElement('style')
    el.dataset.heyagent = 'ui'
    el.textContent = css
    document.head.appendChild(el)
    return () => el.remove()
  }, 'heyagent-ui: styles')

  // ── Branding (single slots; negative priority shadows the shipped occupant).
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark', priority: -10 }, GoatMark))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', priority: -10 }, BrandName))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: -10 }, HeroMark))

  // ── Right-sidebar tab type: the run's browser remote view (placeholder).
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: REMOTE_ID, kind: REMOTE_KIND, priority: 'extension',
    title: () => '浏览器画面',
    guide: [{ id: 'remote', order: 5, title: () => '浏览器画面', description: () => '看这次运行的 Chrome，等人处理时接手', icon: TabGuideIcon }],
  }), 'heyagent-ui: remote view tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: REMOTE_ID }, RemoteViewTab))

  const openRemote = () => { try { ctx.sidebarRight.openTab(REMOTE_KIND, {}) } catch (e) { console.warn('[heyagent-ui] openTab', e) } }
  const openRun = () => ctx.layout.selectPanel(null)
  const newRun = () => {
    ctx.layout.selectPanel(null)
    try { ctx.uiWorkspace.startSession(undefined, { prompt: '跑一次每日比价：不锈钢保温杯 500ml', whenDraftExists: 'append' }) } catch (e) { console.warn(e) }
  }

  // ── Run header: status badge + remote-view opener.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'heyagent-run-status', order: -20,
    inject: () => ({ onOpenRemote: openRemote }),
  }, RunHeaderBadge))

  // ── Business tool rows in the chat (keyed by wire tool name).
  for (const key of HEYAGENT_TOOLVIEWS) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, HeyAgentToolRow))
  }

  // ── Global panels: sidebar row + main page per panel.
  const panels = [
    ['heyagent-inbox', '要人办', 1, InboxIcon, InboxPage, { onOpenRun: openRun, onOpenRemote: () => { openRun(); setTimeout(openRemote, 300) } }],
    ['heyagent-tasks', '任务', 2, iconOf(IconChecklistOutlineRegular), TasksPage, { onNewRun: newRun }],
    ['heyagent-browsers', '浏览器', 4, iconOf(IconGlobeOutlineRegular), BrowsersPage, { onOpenRemote: () => { openRun(); setTimeout(openRemote, 300) } }],
    ['heyagent-desktops', '桌面', 5, iconOf(IconCodeOutlineRegular), DesktopsPage, { onOpenRemote: () => {} }],
  ]
  for (const [id, label, order, Icon, Page, injected] of panels) {
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id, inject: () => injected }, Page))
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id, order: -100 + order, label: () => label }, Icon))
  }
}
