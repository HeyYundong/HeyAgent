// 新建 / 编辑工具：新建时先选来源（MCP 服务器 / HTTP 接口），再填对应的表单。
// 编辑 MCP 工具 = 编辑它所在的服务器（工具清单由服务器提供）；编辑 HTTP 工具 = 改请求模板。
import * as React from "react"
import { ClipboardPasteIcon, KeyRoundIcon, PlugZapIcon, RefreshCwIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { fmtShort, riskLabel, type McpServer, type Risk, type SavedSecret, type Tool } from "@heyagent/shared"

import { parseCurl, placeholders } from "./curl"
import { DIALOG_TEXT as T, DISCOVER_SAMPLES, MORE_ON_SERVER, type Discovered } from "./data"
import { moveSecrets, snake, type Template, type Where } from "./secrets"

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
// 工具（带给模型看的完整说明）、MCP 服务器（环境变量每行「名字=••••」，只有名字）都直接用接口返回的类型
export type { Tool }
export type Server = McpServer

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))
const RISKS = (Object.keys(riskLabel) as Risk[]).map((r) => ({ value: r, label: riskLabel[r] }))
const toLines = (pairs: [string, string][]) => pairs.map(([k, v]) => `${k}: ${v}`).join("\n")

/** tool 不传就是新建；编辑 MCP 工具时同时传它所在的服务器和服务器上已加入的工具 */
/** saved：已经存在服务器上的密钥；onSaveHttp 的第二个参数是这次新填了值的密钥名 */
type ToolDialogProps = { tool?: Tool; server?: Server; serverTools: Tool[]; saved: Record<string, SavedSecret>; onSaveHttp: (tool: Tool, newSecrets: string[]) => void; onSaveMcp: (server: Server, tools: Tool[]) => void; onClose: () => void }

export function ToolDialog({ tool, server, serverTools, saved, onSaveHttp, onSaveMcp, onClose }: ToolDialogProps) {
  const [source, setSource] = React.useState(tool?.source === "http" ? "http" : "mcp")
  const title = !tool ? "新建工具" : source === "mcp" ? `编辑 MCP 服务器「${server?.name}」` : `编辑「${tool.name}」`
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{source === "mcp" ? T.mcpHint : T.httpHint}</DialogDescription>
        </DialogHeader>
        {!tool && (
          <FormField label="来源">
            <ToggleGroup variant="outline" spacing={0} value={[source]} onValueChange={(v) => v[0] && setSource(v[0] as string)}>
              <ToggleGroupItem value="mcp">MCP 服务器</ToggleGroupItem>
              <ToggleGroupItem value="http">HTTP 接口</ToggleGroupItem>
            </ToggleGroup>
          </FormField>
        )}
        {source === "mcp" ? <McpForm server={server} serverTools={serverTools} onSave={onSaveMcp} /> : <HttpForm tool={tool} saved={saved} onSave={onSaveHttp} />}
      </DialogContent>
    </Dialog>
  )
}

// ---------- MCP 服务器：连上后（模拟）列出服务器提供的工具，勾选要加入的 ----------
function McpForm({ server, serverTools, onSave }: { server?: Server; serverTools: Tool[]; onSave: ToolDialogProps["onSaveMcp"] }) {
  const [name, setName] = React.useState(server?.name ?? "")
  const [transport, setTransport] = React.useState<Server["transport"]>(server?.transport ?? "stdio")
  const [target, setTarget] = React.useState((transport === "http" ? server?.url : server?.command) ?? "")
  const [env, setEnv] = React.useState(server?.env ?? "")
  // 编辑时一打开就是「已连接」，可以直接改勾选；改了连接方式或命令要重新读取
  const [status, setStatus] = React.useState<"idle" | "loading" | "done">(server ? "done" : "idle")
  const [found, setFound] = React.useState<Discovered[]>(serverTools)
  const [picked, setPicked] = React.useState(serverTools.map((t) => t.id))
  const [submitted, setSubmitted] = React.useState(false)
  const stdio = transport === "stdio"
  const problems = {
    name: !name.trim() ? "给服务器起个名字，例如「飞书」" : undefined,
    target: !target.trim() ? (stdio ? "填启动命令" : "填服务地址") : undefined,
    tools: status !== "done" ? "先点「连接并读取工具」" : picked.length === 0 ? "至少勾一个工具" : undefined,
  }
  const errors: Partial<typeof problems> = submitted ? problems : {}
  const changed = () => status === "done" && setStatus("idle")

  function connect() {
    if (!target.trim()) return setSubmitted(true)
    setStatus("loading")
    window.setTimeout(() => {
      const text = `${name} ${target}`.toLowerCase()
      const next = server ? [...serverTools, ...(MORE_ON_SERVER[server.id] ?? [])] : (DISCOVER_SAMPLES.find((s) => text.includes(s.keyword)) ?? DISCOVER_SAMPLES[0]).tools
      setFound(next)
      setPicked((server ? serverTools : next).map((t) => t.id))
      setStatus("done")
    }, 900)
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    if (Object.values(problems).some(Boolean)) return
    const id = server?.id ?? `mcp-new-${Date.now()}`
    const value = target.trim()
    const next: Server = { note: "", ...server, id, name: name.trim(), transport, status: "connected", env: env.trim() || undefined, command: stdio ? value : undefined, url: stdio ? undefined : value }
    onSave(next, found.filter((t) => picked.includes(t.id)).map((t) => serverTools.find((old) => old.id === t.id) ?? { ...t, description: t.summary, source: "mcp", serverId: id }))
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FieldGroup>
        <FormField label="名称" htmlFor="mcp-name" error={errors.name}>
          <Input id="mcp-name" value={name} placeholder="例如：飞书" aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField label="连接方式" htmlFor="mcp-target" error={errors.target} hint={stdio ? T.stdioHint : T.mcpHttpHint}>
          <ToggleGroup variant="outline" spacing={0} value={[transport]} onValueChange={(v) => v[0] && (setTransport(v[0] as Server["transport"]), changed())}>
            <ToggleGroupItem value="stdio">stdio 命令</ToggleGroupItem>
            <ToggleGroupItem value="http">HTTP 地址</ToggleGroupItem>
          </ToggleGroup>
          <Input id="mcp-target" value={target} className="font-mono" placeholder={stdio ? T.stdioPlaceholder : T.mcpUrlPlaceholder} aria-invalid={!!errors.target} onChange={(e) => (setTarget(e.target.value), changed())} />
        </FormField>
        <FormField label="环境变量（可选）" htmlFor="mcp-env" hint={T.envHint}>
          <Textarea id="mcp-env" rows={2} value={env} className="font-mono" placeholder={T.envPlaceholder} onChange={(e) => setEnv(e.target.value)} />
        </FormField>
        <FormField label="服务器提供的工具" error={errors.tools} hint={status === "done" && `连上了，发现 ${found.length} 个工具。勾选要加入的，没勾的 agent 看不到。`}>
          <Button type="button" variant="outline" className="self-start" disabled={status === "loading"} onClick={connect}>
            {status === "loading" ? <Spinner data-icon="inline-start" /> : status === "done" ? <RefreshCwIcon data-icon="inline-start" /> : <PlugZapIcon data-icon="inline-start" />}
            {status === "loading" ? "正在连接…" : status === "done" ? "重新读取工具" : "连接并读取工具"}
          </Button>
          {status === "done" &&
            found.map((t) => (
              <Field key={t.id} orientation="horizontal">
                <Checkbox id={`mcp-${t.id}`} checked={picked.includes(t.id)} onCheckedChange={(on) => setPicked(on ? [...picked, t.id] : picked.filter((id) => id !== t.id))} />
                <FieldContent>
                  <FieldLabel htmlFor={`mcp-${t.id}`}>
                    {t.name} <span className="font-mono text-muted-foreground">{t.id}</span> {t.risk !== "read" && <Badge variant="outline">{riskLabel[t.risk]}</Badge>}
                  </FieldLabel>
                  <FieldDescription>{t.summary}</FieldDescription>
                </FieldContent>
              </Field>
            ))}
        </FormField>
      </FieldGroup>
      <Footer submit={server ? "保存" : status === "done" ? `加入 ${picked.length} 个工具` : "加入工具"} />
    </form>
  )
}

// ---------- HTTP 接口：粘贴一条 curl 就填好方法、URL、请求头、请求体（明文密钥自动挪进「密钥」），下面逐项可改 ----------
function HttpForm({ tool, saved, onSave }: { tool?: Tool; saved: Record<string, SavedSecret>; onSave: ToolDialogProps["onSaveHttp"] }) {
  const http = tool?.http
  const [curl, setCurl] = React.useState("")
  const [imported, setImported] = React.useState<{ ok: boolean; text: string }>()
  const [name, setName] = React.useState(tool?.name ?? "")
  const [description, setDescription] = React.useState(tool?.description ?? "")
  const [method, setMethod] = React.useState(http?.method ?? "GET")
  const [t, setT] = React.useState<Template>({ url: http?.url ?? "", headers: toLines(Object.entries(http?.headers ?? {})), body: http?.body ?? "" })
  const [values, setValues] = React.useState<Record<string, string>>({}) // 这次新填的密钥值，只在提交时交给服务器
  const [replacing, setReplacing] = React.useState<string[]>([]) // 点了「换一个」的已保存密钥
  const [risk, setRisk] = React.useState(tool?.risk ?? "read")
  const [submitted, setSubmitted] = React.useState(false)

  const { params, secrets } = placeholders(`${t.url} ${t.headers} ${t.body}`)
  const leaks = moveSecrets(t, secrets).moved
  const stored = (n: string) => saved[n] && !replacing.includes(n)
  const missing = secrets.filter((n) => !stored(n) && !values[n]?.trim())
  const leakIn = (where: Where, found = leaks.filter((l) => l.where === where)) =>
    found.length > 0 ? `有明文密钥（${found.map((l) => `${l.value.slice(0, 4)}…`).join("、")}），不能直接写在模板里。${T.leakHint}` : undefined
  const problems = {
    name: !name.trim() ? "给工具起个名字，例如「查物流报价」" : undefined,
    description: !description.trim() ? "写一两句话告诉模型什么时候用它" : undefined,
    url: !/^https?:\/\//.test(t.url.trim()) ? "URL 要以 http:// 或 https:// 开头" : undefined,
    secrets: missing.length > 0 ? `还没填值：${missing.join("、")}` : undefined,
  }
  const errors: Partial<typeof problems> = submitted ? problems : {}
  const edit = (field: keyof Template) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setT({ ...t, [field]: e.target.value })

  /** 把明文挪进「密钥」：模板里换成 {{名字}}，值放进对应的输入框 */
  function moveOut(next: Template, taken: string[]) {
    const result = moveSecrets(next, taken)
    setT(result.template)
    setValues((old) => ({ ...old, ...Object.fromEntries(result.moved.map((m) => [m.name, m.value])) }))
    return result.moved
  }

  function importCurl() {
    try {
      const parsed = parseCurl(curl)
      setMethod(METHODS.some((m) => m.value === parsed.method) ? (parsed.method as Method) : "POST")
      const moved = moveOut({ url: parsed.url, headers: toLines(parsed.headers), body: parsed.body }, [])
      const parts = [`方法 ${parsed.method}`, "URL", `${parsed.headers.length} 个请求头`, parsed.body && "请求体"].filter(Boolean)
      const note = moved.length > 0 ? `已把明文密钥挪到「密钥」里（${moved.map((m) => m.name).join("、")}），名字可以改。` : ""
      setImported({ ok: true, text: `已填好：${parts.join("、")}。${note}检查一下，再补上名称和说明。` })
      setCurl("") // 原命令里可能带着明文密钥，导入后清空
    } catch (error) {
      setImported({ ok: false, text: (error as Error).message })
    }
  }

  /** 改密钥名：模板里的 {{旧名}} 一起改掉 */
  function rename(old: string, raw: string) {
    const next = snake(raw)
    if (!next || next === old || secrets.includes(next)) return
    const swap = (text: string) => text.replaceAll(`{{${old}}}`, `{{${next}}}`)
    setT({ url: swap(t.url), headers: swap(t.headers), body: swap(t.body) })
    setValues({ ...values, [next]: values[old] ?? "" })
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    if (leaks.length > 0 || Object.values(problems).some(Boolean)) return
    const pairs = t.headers.split("\n").filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()])
    const spec = { method, url: t.url.trim(), headers: Object.fromEntries(pairs), body: t.body.trim() || undefined }
    const text = description.trim()
    const slug = t.url.split("?")[0].split("/").slice(3).filter((seg) => /^[\w-]+$/.test(seg)).pop() ?? "api" // …/v2/quotes → http.quotes
    const next: Tool = { id: tool?.id ?? `http.${slug}`, name: name.trim(), description: text, summary: text.split(/[。.]/)[0], source: "http", http: spec, risk }
    onSave(next, secrets.filter((n) => values[n]?.trim()))
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FieldGroup>
        <FormField label="从 cURL 导入（可选）" htmlFor="tool-curl" hint={imported?.ok && imported.text} error={imported?.ok ? undefined : imported?.text}>
          <InputGroup>
            <InputGroupTextarea id="tool-curl" rows={3} value={curl} placeholder={T.curlPlaceholder} className="font-mono" onChange={(e) => setCurl(e.target.value)} />
            <InputGroupAddon align="block-end">
              <InputGroupText>粘贴一条 curl 命令，自动填好下面的方法、URL、请求头和请求体</InputGroupText>
              <InputGroupButton variant="secondary" className="ml-auto" disabled={!curl.trim()} onClick={importCurl}>
                <ClipboardPasteIcon data-icon="inline-start" />
                导入
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </FormField>
        <FieldSeparator />
        <FormField label="名称" htmlFor="tool-name" error={errors.name}>
          <Input id="tool-name" value={name} placeholder="例如：查物流报价" aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormField label="给模型看的说明" htmlFor="tool-description" hint="模型只靠这段话判断什么时候用、怎么用。" error={errors.description}>
          <Textarea id="tool-description" rows={3} value={description} placeholder={T.descriptionPlaceholder} aria-invalid={!!errors.description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
        <FormField label="方法和 URL" htmlFor="tool-url" error={errors.url ?? leakIn("url")}>
          <div className="flex gap-2">
            <Picker label="方法" items={METHODS} value={method} onChange={(v) => setMethod(v as Method)} className="w-28 shrink-0" />
            <Input id="tool-url" value={t.url} className="font-mono" placeholder={T.urlPlaceholder} aria-invalid={!!(errors.url ?? leakIn("url"))} onChange={edit("url")} />
          </div>
        </FormField>
        <FormField label="请求头" htmlFor="tool-headers" hint="每行一个，写成「名字: 值」。" error={leakIn("headers")}>
          <Textarea id="tool-headers" rows={3} value={t.headers} className="font-mono" placeholder="Content-Type: application/json" aria-invalid={!!leakIn("headers")} onChange={edit("headers")} />
        </FormField>
        <FormField label="请求体模板" htmlFor="tool-body" hint={`${T.bodyHint}认出的参数：${params.join("、") || "无"}。`} error={leakIn("body")}>
          <Textarea id="tool-body" rows={5} value={t.body} className="font-mono" placeholder={T.bodyPlaceholder} aria-invalid={!!leakIn("body")} onChange={edit("body")} />
        </FormField>
        <FormField label="密钥" hint={T.secretsHint} error={errors.secrets}>
          {secrets.length === 0 && leaks.length === 0 && <p className="text-muted-foreground">模板里没有用到 {"{{名字}}"}，不需要密钥。</p>}
          {leaks.length > 0 && (
            <Button type="button" variant="outline" className="self-start" onClick={() => moveOut(t, secrets)}>
              <KeyRoundIcon data-icon="inline-start" />
              把 {leaks.length} 个明文密钥挪到这里
            </Button>
          )}
          {secrets.map((n) => (
            <div key={n} className="flex flex-wrap items-center gap-2">
              <Input aria-label="密钥名" defaultValue={n} className="w-56 font-mono" onBlur={(e) => rename(n, e.target.value)} />
              {stored(n) ? (
                <span className="flex items-center gap-2 text-muted-foreground">已保存 · {saved[n].by} {fmtShort(saved[n].at).slice(0, 5)}
                  <Button type="button" variant="ghost" size="xs" onClick={() => setReplacing([...replacing, n])}>换一个</Button></span>
              ) : (
                <Input type="password" aria-label={`${n} 的值`} value={values[n] ?? ""} placeholder="填真正的值" aria-invalid={!!errors.secrets && missing.includes(n)} className="min-w-0 flex-1" onChange={(e) => setValues({ ...values, [n]: e.target.value })} />
              )}
            </div>
          ))}
        </FormField>
        <FormField label="风险" hint="对外发送、涉及金钱的工具，建任务时最好配上审批规则。">
          <Picker label="风险" items={RISKS} value={risk} onChange={(v) => setRisk(v as Risk)} className="w-full" />
        </FormField>
      </FieldGroup>
      <Footer submit={tool ? "保存" : "接入这个接口"} />
    </form>
  )
}

// ---------- 小零件 ----------
/** 表单里的一项：标签 + 控件 + 说明 + 错误 */
function FormField(props: { label: string; htmlFor?: string; hint?: React.ReactNode; error?: string; children: React.ReactNode }) {
  return (
    <Field data-invalid={!!props.error}>
      <FieldLabel htmlFor={props.htmlFor}>{props.label}</FieldLabel>
      {props.children}
      {props.hint && <FieldDescription>{props.hint}</FieldDescription>}
      <FieldError>{props.error}</FieldError>
    </Field>
  )
}

/** 下拉选择的简写（Select 要传 items） */
function Picker(props: { label: string; items: { value: string; label: string }[]; value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <Select items={props.items} value={props.value} onValueChange={(v) => v && props.onChange(v)}>
      <SelectTrigger aria-label={props.label} className={props.className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {props.items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

function Footer({ submit }: { submit: string }) {
  return (
    <DialogFooter>
      <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
      <Button type="submit">{submit}</Button>
    </DialogFooter>
  )
}
