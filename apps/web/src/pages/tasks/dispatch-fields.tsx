// 「被派活」一组：任务弹窗（新建 / 编辑任务）和导入向导的「修改要导入的任务」共用（派活第二期，docs/dev/dispatch-p2.md 1.7、4.1 节）。
// 开关「可以被派活」→ 每件事带的参数、要交回的结果（run-outcome 6.1）、同时最多几个在跑、谁能派活给它、没办成自动重试和间隔。
// 两边都是 React Hook Form + TaskInput；「谁能派活给它」的选项由外面传：任务弹窗里是系统里的其他任务，导入向导里是方案里的其他任务（值是方案里的 key）。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useFieldArray, useWatch, type Control, type FieldErrors, type UseFormRegister } from "react-hook-form"
import { PlusIcon, XIcon } from "lucide-react"
import { taskInputSchema, WORK_RETRY_DELAY_DEFAULT, type TaskDispatch, type TaskInput } from "@heyagent/shared"

import { HelpTip } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

import { MultiPick, type Option } from "./multi-pick"

/** 10 →「10 分钟」，120 →「2 小时」 */
export function delayText(minutes: number) {
  return minutes >= 60 ? `${minutes / 60} 小时` : `${minutes} 分钟`
}

export type RetryFields = Pick<TaskDispatch, "retries" | "retryDelayMinutes">

/**
 * 从任务 / 导入方案的 dispatch 里取自动重试的两项。shared 的 TaskDef.dispatch、planTaskSchema.dispatch 现在还没声明这两项
 * （接口返回的 jsonb 里有），所以按字段读，不靠类型。
 */
export function retriesOf(dispatch: object | null | undefined): RetryFields {
  const raw = (dispatch ?? {}) as Record<string, unknown>
  const num = (value: unknown) => (typeof value === "number" ? value : undefined)
  return { retries: num(raw.retries), retryDelayMinutes: num(raw.retryDelayMinutes) }
}

/** 「没办成自动重试 2 次（隔 10 分钟）」/「没办成不自动重试」 */
export function retryText(dispatch: object) {
  const { retries, retryDelayMinutes } = retriesOf(dispatch)
  return retries ? `没办成自动重试 ${retries} 次（隔 ${delayText(retryDelayMinutes ?? WORK_RETRY_DELAY_DEFAULT)}）` : "没办成不自动重试"
}

const MAX_RUNNING_ITEMS = Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 个` }))
const RETRY_ITEMS = [{ value: "0", label: "不重试" }, ...Array.from({ length: 5 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 次` }))]
const DELAY_ITEMS = [1, 5, 10, 30, 60, 120, 360, 1440].map((minutes) => ({ value: String(minutes), label: delayText(minutes) }))
const NEW_PARAM = { name: "", description: "", required: false, dedupe: false }
const NEW_RESULT = { name: "", description: "", required: true }
const FIRST_DRAFT = { params: [{ name: "", description: "", required: true, dedupe: true }], results: [], maxRunning: 1 }

/**
 * shared 的 taskInputSchema 之外再查一条：打开了「可以被派活」就至少写一个参数（和别的错误一起显示）。
 * 自动重试两项没选过时，下拉的 Controller 会把它们放成 null，schema 只认数字或不写，这里先当作不写
 * （不然报的错在页面上没地方显示，点创建一声不响）。
 */
const zodTaskResolver = zodResolver(taskInputSchema)
export const taskResolver: typeof zodTaskResolver = async (input, context, options) => {
  const values = input.dispatch
    ? { ...input, dispatch: { ...input.dispatch, retries: input.dispatch.retries ?? undefined, retryDelayMinutes: input.dispatch.retryDelayMinutes ?? undefined } }
    : input
  const result = await zodTaskResolver(values, context, options)
  if (values.dispatch && values.dispatch.params.length === 0) {
    return { values: {}, errors: { ...result.errors, dispatch: { type: "custom", message: "至少写一个参数：每件事要带什么（例如单号）" } } }
  }
  return result
}

/** 被派活的一个参数：参数名 + 说明 + 必填 + 去重 + 删除（写法照步骤编辑器） */
function ParamEditor({ id, index, control, register, error, onRemove }: { id: string; index: number; control: Control<TaskInput>; register: UseFormRegister<TaskInput>; error?: string; onRemove: () => void }) {
  return (
    <Field data-invalid={!!error}>
      <div className="flex flex-col gap-2 border-l-2 pl-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 gap-2">
          <Input className="w-28 shrink-0" aria-label={`参数 ${index + 1} 的名字`} aria-invalid={!!error} placeholder="例如：单号" {...register(`dispatch.params.${index}.name`)} />
          <Input className="min-w-0 flex-1" aria-label={`参数 ${index + 1} 的说明`} placeholder="给派活的 agent 看：填什么" {...register(`dispatch.params.${index}.description`)} />
        </div>
        <div className="flex items-center gap-4">
          {(["required", "dedupe"] as const).map((key) => (
            <Controller
              key={key}
              control={control}
              name={`dispatch.params.${index}.${key}`}
              render={({ field }) => (
                <Field orientation="horizontal" className="w-auto">
                  <Checkbox id={`${id}-${index}-${key}`} checked={!!field.value} onCheckedChange={(on) => field.onChange(Boolean(on))} />
                  <FieldLabel htmlFor={`${id}-${index}-${key}`} className="font-normal">{key === "required" ? "必填" : "去重"}</FieldLabel>
                </Field>
              )}
            />
          ))}
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`删除参数 ${index + 1}`} onClick={onRemove}><XIcon /></Button>
        </div>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

/** 一个 Select 选数字（名额、重试次数、间隔） */
function NumberSelect({ id, items, value, onChange }: { id: string; items: { value: string; label: string }[]; value: number; onChange: (value: number) => void }) {
  return (
    <Select items={items} value={String(value)} onValueChange={(v) => v && onChange(Number(v))}>
      <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/**
 * id：表单里各控件 id 的前缀；fromOptions：「谁能派活给它」的选项；fromNote：选项下面的一行说明（例如导入时只能选包里的任务）。
 * 表单的 dispatchFrom 存的就是 fromOptions 的值（任务 id，或导入方案里的 key）。
 */
/**
 * 「每件事带的参数」。字段数组单独放一个组件、只在打开「可以被派活」时挂上：
 * useFieldArray 一挂上，提交时 dispatch 就会从 null 变成 { params: [] }，没打开也报「至少写一个参数」，而这个错误在关着时看不到，表单就一声不响地提交不了。
 */
function DispatchParams({ id, control, register, errors }: {
  id: string
  control: Control<TaskInput>
  register: UseFormRegister<TaskInput>
  errors: FieldErrors<TaskInput>
}) {
  const params = useFieldArray({ control, name: "dispatch.params" })
  const rootError = errors.dispatch?.message ?? errors.dispatch?.params?.message ?? errors.dispatch?.params?.root?.message
  const paramError = (index: number) => errors.dispatch?.params?.[index]?.name?.message ?? errors.dispatch?.params?.[index]?.description?.message
  return (
    <Field data-invalid={!!rootError}>
      <FieldLabel className="flex items-center gap-1">
        每件事带的参数
        <HelpTip>派活的 agent 按这里填，缺必填的当场被拒。标了「去重」的参数用来判断是不是同一件事：同一个值只办一次；一个都不标时，派活的 agent 要自己给每件事一个编号。</HelpTip>
      </FieldLabel>
      <div className="flex flex-col gap-3">
        {params.fields.map((param, index) => (
          <ParamEditor key={param.id} id={`${id}-param`} index={index} control={control} register={register} error={paramError(index)} onRemove={() => params.remove(index)} />
        ))}
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => params.append(NEW_PARAM)}>
          <PlusIcon data-icon="inline-start" />加一个参数
        </Button>
      </div>
      {rootError && <FieldError>{rootError}</FieldError>}
    </Field>
  )
}

/** 要交回的一个结果：结果名 + 说明 + 必填 + 删除（写法照参数） */
function ResultEditor({ id, index, control, register, error, onRemove }: { id: string; index: number; control: Control<TaskInput>; register: UseFormRegister<TaskInput>; error?: string; onRemove: () => void }) {
  return (
    <Field data-invalid={!!error}>
      <div className="flex flex-col gap-2 border-l-2 pl-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 gap-2">
          <Input className="w-28 shrink-0" aria-label={`结果 ${index + 1} 的名字`} aria-invalid={!!error} placeholder="例如：价格" {...register(`dispatch.results.${index}.name`)} />
          <Input className="min-w-0 flex-1" aria-label={`结果 ${index + 1} 的说明`} placeholder="给办事的 agent 看：交什么" {...register(`dispatch.results.${index}.description`)} />
        </div>
        <div className="flex items-center gap-4">
          <Controller
            control={control}
            name={`dispatch.results.${index}.required`}
            render={({ field }) => (
              <Field orientation="horizontal" className="w-auto">
                <Checkbox id={`${id}-${index}-required`} checked={!!field.value} onCheckedChange={(on) => field.onChange(Boolean(on))} />
                <FieldLabel htmlFor={`${id}-${index}-required`} className="font-normal">必填</FieldLabel>
              </Field>
            )}
          />
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`删除结果 ${index + 1}`} onClick={onRemove}><XIcon /></Button>
        </div>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}

/** 「要交回的结果」：可以一个都不写（不要求交）。和参数一样，只在打开「可以被派活」时挂上 */
function DispatchResults({ id, control, register, errors }: {
  id: string
  control: Control<TaskInput>
  register: UseFormRegister<TaskInput>
  errors: FieldErrors<TaskInput>
}) {
  const results = useFieldArray({ control, name: "dispatch.results" })
  const rootError = errors.dispatch?.results?.message ?? errors.dispatch?.results?.root?.message
  const resultError = (index: number) => errors.dispatch?.results?.[index]?.name?.message ?? errors.dispatch?.results?.[index]?.description?.message
  return (
    <Field data-invalid={!!rootError}>
      <FieldLabel className="flex items-center gap-1">
        要交回的结果
        <HelpTip>办事的 agent 用「报结果」把这些交回派活单。必填的没交，这张单记没办成（缺要交回的结果），不自动重试。可以一个都不写：不要求交。</HelpTip>
      </FieldLabel>
      <div className="flex flex-col gap-3">
        {results.fields.map((result, index) => (
          <ResultEditor key={result.id} id={`${id}-result`} index={index} control={control} register={register} error={resultError(index)} onRemove={() => results.remove(index)} />
        ))}
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => results.append(NEW_RESULT)}>
          <PlusIcon data-icon="inline-start" />加一个结果
        </Button>
      </div>
      {rootError && <FieldError>{rootError}</FieldError>}
    </Field>
  )
}

export function DispatchFields({ id, control, register, errors, fromOptions, fromNote, hideResults = false }: {
  id: string
  control: Control<TaskInput>
  register: UseFormRegister<TaskInput>
  errors: FieldErrors<TaskInput>
  fromOptions: Option[]
  fromNote?: string
  /** 导入方案里的任务还不能声明要交回的结果，导入时不显示这一项 */
  hideResults?: boolean
}) {
  const dispatch = useWatch({ control, name: "dispatch" })
  // 关掉再打开，刚才写的参数还在
  const draft = React.useRef<NonNullable<TaskInput["dispatch"]>>(dispatch ?? FIRST_DRAFT)
  return (
    <FieldSet>
      <FieldLegend variant="label" className="flex items-center gap-1">
        被派活
        <HelpTip>打开后，别的任务可以把一件件事派给它办，一件事开一次运行；人也能在派活页手动派。</HelpTip>
      </FieldLegend>
      <Controller
        control={control}
        name="dispatch"
        render={({ field }) => (
          <Field orientation="horizontal">
            <Switch id={`${id}-on`} checked={!!field.value} onCheckedChange={(on) => {
              if (!on && field.value) draft.current = field.value
              field.onChange(on ? draft.current : null)
            }} />
            <FieldLabel htmlFor={`${id}-on`}>可以被派活</FieldLabel>
          </Field>
        )}
      />
      {dispatch && (
        <>
          <DispatchParams id={id} control={control} register={register} errors={errors} />
          {!hideResults && <DispatchResults id={id} control={control} register={register} errors={errors} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${id}-max-running`} className="flex items-center gap-1">
                同时最多几个在跑
                <HelpTip>执行中、验收中、等浏览器的运行占名额；agent 自己挂起等待、等人处理的不占，空出来的位子给下一张单。最好不超过要用的账号能同时登录几个。</HelpTip>
              </FieldLabel>
              <Controller control={control} name="dispatch.maxRunning" render={({ field }) => <NumberSelect id={`${id}-max-running`} items={MAX_RUNNING_ITEMS} value={field.value ?? 1} onChange={field.onChange} />} />
            </Field>
            <Controller
              control={control}
              name="dispatchFrom"
              render={({ field }) => (
                <MultiPick id={`${id}-from`} label="谁能派活给它" placeholder="选任务；不选就只能人派" options={fromOptions} value={field.value ?? []} onChange={field.onChange} description={fromNote} />
              )}
            />
            <Field>
              <FieldLabel htmlFor={`${id}-retries`} className="flex items-center gap-1">
                没办成自动重试
                <HelpTip>只对运行出错重试（模型调用失败、程序出错、验收判失败等）；人取消的、选了不继续的、没办成或者只办成一部分的（agent 报的、检查点、复核判的）不重试。会对外发消息的任务慎用：重试可能重复发。</HelpTip>
              </FieldLabel>
              <Controller control={control} name="dispatch.retries" render={({ field }) => <NumberSelect id={`${id}-retries`} items={RETRY_ITEMS} value={field.value ?? 0} onChange={field.onChange} />} />
            </Field>
            {!!dispatch.retries && (
              <Field>
                <FieldLabel htmlFor={`${id}-retry-delay`} className="flex items-center gap-1">
                  间隔
                  <HelpTip>没办成以后隔多久再排进队里。中间的失败不通知负责人，重试都用完还没办成才通知一次。</HelpTip>
                </FieldLabel>
                <Controller
                  control={control}
                  name="dispatch.retryDelayMinutes"
                  render={({ field }) => <NumberSelect id={`${id}-retry-delay`} items={DELAY_ITEMS} value={field.value ?? WORK_RETRY_DELAY_DEFAULT} onChange={field.onChange} />}
                />
              </Field>
            )}
          </div>
        </>
      )}
    </FieldSet>
  )
}
