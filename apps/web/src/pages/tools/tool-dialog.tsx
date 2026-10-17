// 新建 / 编辑工具：新建时先选来源（MCP 服务器 / HTTP 接口），再填对应的表单。
// 编辑 MCP 工具 = 编辑它所在的服务器（工具清单由服务器提供）；编辑 HTTP 工具 = 改请求模板。
// 表单：React Hook Form + shared 的 httpToolFormSchema / mcpServerFormSchema。明文密钥前端先拦、后端再拦。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch } from "react-hook-form"
import { ClipboardPasteIcon, KeyRoundIcon, PlugZapIcon } from "lucide-react"
import {
  fmtShort,
  hasPlainSecret,
  httpToolFormSchema,
  KEEP_SECRET_MASK,
  mcpServerFormSchema,
  riskLabel,
  type HttpToolForm,
  type McpServer,
  type McpServerForm,
  type Risk,
  type SavedSecret,
  type Tool,
} from "@heyagent/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from "@/components/ui/input-group"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { parseCurl, placeholders } from "./curl"
import { DIALOG_TEXT as T } from "./data"
import { moveSecrets, snake, type Template, type Where } from "./secrets"

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
// 工具（带给模型看的完整说明）、MCP 服务器（环境变量每行「名字=••••」，只有名字）都直接用接口返回的类型
export type { Tool }
export type Server = McpServer

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))
const RISKS = (Object.keys(riskLabel) as Risk[]).map((r) => ({ value: r, label: riskLabel[r] }))
const toLines = (pairs: [string, string][]) => pairs.map(([k, v]) => `${k}: ${v}`).join("\n")

/** tool 不传、server 也不传就是新建；编辑 MCP 工具或服务器时传 server（和它已加入的工具） */
type ToolDialogProps = { tool?: Tool; server?: Server; serverTools: Tool[]; saved: Record<string, SavedSecret>; onClose: () => void }

export function ToolDialog({ tool, server, serverTools, saved, onClose }: ToolDialogProps) {
  const editing = Boolean(tool || server)
  const [source, setSource] = React.useState(tool?.source === "http" ? "http" : server || tool?.source === "mcp" ? "mcp" : "http")
  const title = !editing ? "新建工具" : source === "mcp" ? `编辑 MCP 服务器「${server?.name}」` : `编辑「${tool?.name}」`
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{source === "mcp" ? T.mcpHint : T.httpHint}</DialogDescription>
        </DialogHeader>
        {!editing && (
          <Field>
            <FieldLabel>来源</FieldLabel>
            <ToggleGroup variant="outline" spacing={0} value={[source]} onValueChange={(v) => v[0] && setSource(v[0] as string)}>
              <ToggleGroupItem value="http">HTTP 接口</ToggleGroupItem>
              <ToggleGroupItem value="mcp">MCP 服务器</ToggleGroupItem>
            </ToggleGroup>
          </Field>
        )}
        {source === "mcp" ? <McpForm server={server} serverTools={serverTools} onDone={onClose} /> : <HttpForm tool={tool} saved={saved} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

// ---------- MCP 服务器：命令或地址 + 环境变量 / 请求头（值加密存）。「连接并读取工具」由 P3 接引擎后可用 ----------

/** 「名字=值」多行文字 → 接口的 env；值是 •••• 表示保留已存的 */
function parseEnv(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf("=")
      const name = (at < 0 ? line : line.slice(0, at)).trim()
      const value = at < 0 ? "" : line.slice(at + 1).trim()
      return { name, value: value && value !== KEEP_SECRET_MASK ? value : undefined }
    })
}

function McpForm({ server, serverTools, onDone }: { server?: Server; serverTools: Tool[]; onDone: () => void }) {
  const form = useForm<McpServerForm>({
    resolver: zodResolver(mcpServerFormSchema),
    defaultValues: { name: server?.name ?? "", transport: server?.transport ?? "stdio", target: (server?.transport === "http" ? server.url : server?.command) ?? "", note: server?.note ?? "", env: server?.env ?? "" },
  })
  const { errors } = form.formState
  const transport = useWatch({ control: form.control, name: "transport" })
  const stdio = transport === "stdio"
  const create = useAction(trpc.tools.createMcpServer.mutationOptions(), { success: "服务器存好了。连上以后在这里读取工具、勾选要加入的" })
  const update = useAction(trpc.tools.updateMcpServer.mutationOptions(), { success: "服务器已保存" })
  const pending = create.isPending || update.isPending

  const submit = form.handleSubmit(async (values) => {
    if (hasPlainSecret(values.target)) {
      form.setError("target", { message: `${stdio ? "启动命令" : "地址"}里有明文密钥，放进${stdio ? "环境变量" : "请求头"}，或者写成 {{名字}}` })
      return
    }
    const env = parseEnv(values.env)
    const known = new Set((server?.env ?? "").split("\n").map((line) => line.split("=")[0]!.trim()).filter(Boolean))
    const missing = env.filter((each) => !each.value && !(server && server.transport === values.transport && known.has(each.name)))
    if (missing.length) {
      form.setError("env", { message: `填 ${missing.map((each) => each.name).join("、")} 的值（写成「名字=值」）` })
      return
    }
    const input = { name: values.name, transport: values.transport, ...(stdio ? { command: values.target } : { url: values.target }), note: values.note ?? "", env }
    if (server) {
      if (await update.submit({ ...input, id: server.id })) onDone()
      return
    }
    const created = await create.submit(input)
    if (created) {
      onDone()
      navigate("tools", { id: created.id })
    }
  })

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FieldGroup>
        <Field data-invalid={!!errors.name}>
          <FieldLabel htmlFor="mcp-name">名称</FieldLabel>
          <Input id="mcp-name" placeholder="例如：共享盘" aria-invalid={!!errors.name} {...form.register("name")} />
          <FieldError errors={[errors.name]} />
        </Field>
        <Field data-invalid={!!errors.target}>
          <FieldLabel htmlFor="mcp-target">连接方式</FieldLabel>
          <Controller
            control={form.control}
            name="transport"
            render={({ field }) => (
              <ToggleGroup variant="outline" spacing={0} value={[field.value]} onValueChange={(v) => v[0] && field.onChange(v[0])}>
                <ToggleGroupItem value="stdio">stdio 命令</ToggleGroupItem>
                <ToggleGroupItem value="http">HTTP 地址</ToggleGroupItem>
              </ToggleGroup>
            )}
          />
          <Input id="mcp-target" className="font-mono" placeholder={stdio ? T.stdioPlaceholder : T.mcpUrlPlaceholder} aria-invalid={!!errors.target} {...form.register("target")} />
          <FieldDescription>{stdio ? T.stdioHint : T.mcpHttpHint}</FieldDescription>
          <FieldError errors={[errors.target]} />
        </Field>
        <Field data-invalid={!!errors.env}>
          <FieldLabel htmlFor="mcp-env">{stdio ? "环境变量（可选）" : "请求头（可选）"}</FieldLabel>
          <Textarea id="mcp-env" rows={3} className="font-mono" placeholder={stdio ? T.envPlaceholder : "Authorization=Bearer {{API_TOKEN}}"} aria-invalid={!!errors.env} {...form.register("env")} />
          <FieldDescription>
            每行一个「名字=值」。值只加密存在服务器上，页面和模型都看不到；也可以写 {"{{名字}}"} 引用「密钥」里存好的值。
            {server ? `已存的显示成 ${KEEP_SECRET_MASK}，不改就留着。` : ""}
          </FieldDescription>
          <FieldError errors={[errors.env]} />
        </Field>
        <Field>
          <FieldLabel htmlFor="mcp-note">备注（可选）</FieldLabel>
          <Input id="mcp-note" placeholder="例如：只读权限" {...form.register("note")} />
        </Field>
        <Field>
          <FieldLabel>服务器提供的工具</FieldLabel>
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => toast.add({ title: "连接并读取工具：下一步接通", description: "接上引擎后，这里会真的连到服务器，列出它提供的工具让你勾选。现在先把服务器存好。", type: "info" })}
          >
            <PlugZapIcon data-icon="inline-start" />
            连接并读取工具
          </Button>
          {serverTools.length > 0 ? (
            <ItemGroup className="gap-1">
              {serverTools.map((t) => (
                <Item key={t.id} size="xs" variant="muted">
                  <ItemContent>
                    <ItemTitle>{t.name} <span className="font-mono text-muted-foreground">{t.id}</span> {t.risk !== "read" && <Badge variant="outline">{riskLabel[t.risk]}</Badge>}</ItemTitle>
                    <ItemDescription>{t.summary}</ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          ) : (
            <FieldDescription>还没读取过工具。存好服务器后，连上就能读出它提供的工具。</FieldDescription>
          )}
        </Field>
      </FieldGroup>
      <Footer submit={server ? "保存" : "存好服务器"} pending={pending} />
    </form>
  )
}

// ---------- HTTP 接口：粘贴一条 curl 就填好方法、URL、请求头、请求体（明文密钥自动挪进「密钥」），下面逐项可改 ----------

function HttpForm({ tool, saved, onDone }: { tool?: Tool; saved: Record<string, SavedSecret>; onDone: () => void }) {
  const http = tool?.http
  const form = useForm<HttpToolForm>({
    resolver: zodResolver(httpToolFormSchema),
    defaultValues: {
      name: tool?.name ?? "",
      description: tool?.description ?? "",
      method: http?.method ?? "GET",
      url: http?.url ?? "",
      headers: toLines(Object.entries(http?.headers ?? {})),
      body: http?.body ?? "",
      risk: tool?.risk ?? "read",
      secrets: {},
    },
  })
  const { errors } = form.formState
  const [curl, setCurl] = React.useState("")
  const [imported, setImported] = React.useState<{ ok: boolean; text: string }>()
  const [replacing, setReplacing] = React.useState<string[]>([]) // 点了「换一个」的已保存密钥
  const [url, headers, body, values] = useWatch({ control: form.control, name: ["url", "headers", "body", "secrets"] })
  const t: Template = { url: url ?? "", headers: headers ?? "", body: body ?? "" }
  const { params, secrets } = placeholders(`${t.url} ${t.headers} ${t.body}`)
  const leaks = moveSecrets(t, secrets).moved
  const stored = (n: string) => saved[n] && !replacing.includes(n)
  const missing = secrets.filter((n) => !stored(n) && !values?.[n]?.trim())
  const leakIn = (where: Where, found = leaks.filter((l) => l.where === where)) =>
    found.length > 0 ? `有明文密钥（${found.map((l) => `${l.value.slice(0, 4)}…`).join("、")}），不能直接写在模板里。${T.leakHint}` : undefined
  const create = useAction(trpc.tools.createHttp.mutationOptions(), { success: "接口接好了。建任务时在「用哪些 → 工具」里选上它" })
  const update = useAction(trpc.tools.updateHttp.mutationOptions(), { success: "工具已保存" })
  const pending = create.isPending || update.isPending

  /** 把明文挪进「密钥」：模板里换成 {{名字}}，值放进对应的输入框 */
  function moveOut(next: Template, taken: string[]) {
    const result = moveSecrets(next, taken)
    form.setValue("url", result.template.url)
    form.setValue("headers", result.template.headers)
    form.setValue("body", result.template.body)
    form.setValue("secrets", { ...form.getValues("secrets"), ...Object.fromEntries(result.moved.map((m) => [m.name, m.value])) })
    return result.moved
  }

  function importCurl() {
    try {
      const parsed = parseCurl(curl)
      form.setValue("method", METHODS.some((m) => m.value === parsed.method) ? (parsed.method as Method) : "POST")
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
    form.setValue("url", swap(t.url))
    form.setValue("headers", swap(t.headers))
    form.setValue("body", swap(t.body))
    const current = form.getValues("secrets")
    form.setValue("secrets", { ...current, [next]: current[old] ?? "" })
  }

  const submit = form.handleSubmit(async (v) => {
    if (leaks.length > 0) return
    if (missing.length > 0) {
      form.setError("secrets", { message: `还没填值：${missing.join("、")}` })
      return
    }
    const pairs = v.headers.split("\n").filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()] as const)
    // 只交这次新填了值、模板里还在用的密钥
    const newSecrets = Object.fromEntries(secrets.filter((n) => v.secrets[n]?.trim()).map((n) => [n, v.secrets[n]!.trim()]))
    const input = { name: v.name, description: v.description, http: { method: v.method, url: v.url, headers: Object.fromEntries(pairs), body: v.body.trim() || undefined }, risk: v.risk, secrets: newSecrets }
    if (tool) {
      if (await update.submit({ ...input, id: tool.id })) onDone()
      return
    }
    const created = await create.submit(input)
    if (created) {
      onDone()
      navigate("tools", { id: created.id })
    }
  })

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FieldGroup>
        <Field data-invalid={imported?.ok === false}>
          <FieldLabel htmlFor="tool-curl">从 cURL 导入（可选）</FieldLabel>
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
          {imported?.ok && <FieldDescription>{imported.text}</FieldDescription>}
          {imported?.ok === false && <FieldError>{imported.text}</FieldError>}
        </Field>
        <FieldSeparator />
        <Field data-invalid={!!errors.name}>
          <FieldLabel htmlFor="tool-name">名称</FieldLabel>
          <Input id="tool-name" placeholder="例如：查物流报价" aria-invalid={!!errors.name} {...form.register("name")} />
          <FieldError errors={[errors.name]} />
        </Field>
        <Field data-invalid={!!errors.description}>
          <FieldLabel htmlFor="tool-description">给模型看的说明</FieldLabel>
          <Textarea id="tool-description" rows={3} placeholder={T.descriptionPlaceholder} aria-invalid={!!errors.description} {...form.register("description")} />
          <FieldDescription>模型只靠这段话判断什么时候用、怎么用。</FieldDescription>
          <FieldError errors={[errors.description]} />
        </Field>
        <Field data-invalid={!!(errors.url ?? leakIn("url"))}>
          <FieldLabel htmlFor="tool-url">方法和 URL</FieldLabel>
          <div className="flex gap-2">
            <Controller control={form.control} name="method" render={({ field }) => <Picker label="方法" items={METHODS} value={field.value} onChange={field.onChange} className="w-28 shrink-0" />} />
            <Input id="tool-url" className="font-mono" placeholder={T.urlPlaceholder} aria-invalid={!!(errors.url ?? leakIn("url"))} {...form.register("url")} />
          </div>
          <FieldError>{errors.url?.message ?? leakIn("url")}</FieldError>
        </Field>
        <Field data-invalid={!!leakIn("headers")}>
          <FieldLabel htmlFor="tool-headers">请求头</FieldLabel>
          <Textarea id="tool-headers" rows={3} className="font-mono" placeholder="Content-Type: application/json" aria-invalid={!!leakIn("headers")} {...form.register("headers")} />
          <FieldDescription>每行一个，写成「名字: 值」。</FieldDescription>
          <FieldError>{leakIn("headers")}</FieldError>
        </Field>
        <Field data-invalid={!!leakIn("body")}>
          <FieldLabel htmlFor="tool-body">请求体模板</FieldLabel>
          <Textarea id="tool-body" rows={5} className="font-mono" placeholder={T.bodyPlaceholder} aria-invalid={!!leakIn("body")} {...form.register("body")} />
          <FieldDescription>{`${T.bodyHint}认出的参数：${params.join("、") || "无"}。`}</FieldDescription>
          <FieldError>{leakIn("body")}</FieldError>
        </Field>
        <Field data-invalid={!!errors.secrets}>
          <FieldLabel>密钥</FieldLabel>
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
                <span className="flex items-center gap-2 text-muted-foreground">
                  已保存 · {saved[n]!.by} {fmtShort(saved[n]!.at).slice(0, 5)}
                  <Button type="button" variant="ghost" size="xs" onClick={() => setReplacing([...replacing, n])}>换一个</Button>
                </span>
              ) : (
                <Input
                  type="password"
                  aria-label={`${n} 的值`}
                  value={values?.[n] ?? ""}
                  placeholder="填真正的值"
                  aria-invalid={!!errors.secrets && missing.includes(n)}
                  className="min-w-0 flex-1"
                  onChange={(e) => form.setValue("secrets", { ...form.getValues("secrets"), [n]: e.target.value })}
                />
              )}
            </div>
          ))}
          <FieldDescription>{T.secretsHint}</FieldDescription>
          <FieldError errors={[errors.secrets as { message?: string } | undefined]} />
        </Field>
        <Field>
          <FieldLabel>风险</FieldLabel>
          <Controller control={form.control} name="risk" render={({ field }) => <Picker label="风险" items={RISKS} value={field.value} onChange={field.onChange} className="w-full" />} />
          <FieldDescription>对外发送、涉及金钱的工具，建任务时最好配上审批规则。</FieldDescription>
        </Field>
      </FieldGroup>
      <Footer submit={tool ? "保存" : "接入这个接口"} pending={pending} />
    </form>
  )
}

// ---------- 小零件 ----------

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

function Footer({ submit, pending }: { submit: string; pending: boolean }) {
  return (
    <DialogFooter>
      <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
      <Button type="submit" disabled={pending}>
        {pending && <Spinner data-icon="inline-start" />}
        {submit}
      </Button>
    </DialogFooter>
  )
}
