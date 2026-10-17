// 改一张图的标签和文本（JSON 对象）。表单：React Hook Form + shared 的 galleryFormSchema；文本在表单里是一段 JSON 文字，提交时转成对象。
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { galleryFormSchema, galleryFormText, type GalleryForm, type GalleryImage, type GalleryTagCount } from "@heyagent/shared"

import { TagsCombobox } from "@/components/shell/tags-combobox"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

export function EditDialog({ image, tagOptions, onClose }: { image: GalleryImage; tagOptions: GalleryTagCount[]; onClose: () => void }) {
  const form = useForm<GalleryForm>({
    resolver: zodResolver(galleryFormSchema),
    defaultValues: { tags: image.tags, text: Object.keys(image.text).length ? JSON.stringify(image.text, null, 2) : "" },
  })
  const { errors } = form.formState
  const update = useAction(trpc.gallery.update.mutationOptions(), { success: "已保存" })

  const submit = form.handleSubmit(async (values) => {
    if (await update.submit({ id: image.id, tags: values.tags, text: galleryFormText(values.text) })) onClose()
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>编辑 {image.id}</DialogTitle>
            <DialogDescription>标签和文本整体替换成下面写的。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={Boolean(errors.tags)}>
              <FieldLabel htmlFor="gallery-edit-tags">标签</FieldLabel>
              <Controller
                control={form.control}
                name="tags"
                render={({ field }) => (
                  <TagsCombobox id="gallery-edit-tags" creatable value={field.value} onValueChange={field.onChange} options={tagOptions} placeholder="选已有的，或输入新标签" aria-invalid={Boolean(errors.tags)} />
                )}
              />
              <FieldError errors={[errors.tags]} />
            </Field>
            <Field data-invalid={Boolean(errors.text)}>
              <FieldLabel htmlFor="gallery-edit-text">文本（JSON 对象）</FieldLabel>
              <Textarea id="gallery-edit-text" className="min-h-48 font-mono" spellCheck={false} placeholder='{"名称": "…"}' aria-invalid={Boolean(errors.text)} {...form.register("text")} />
              {errors.text ? <FieldError errors={[errors.text]} /> : <FieldDescription>可以空着。要是一个 JSON 对象（用 {"{ }"} 包起来）。</FieldDescription>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending && <Spinner data-icon="inline-start" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
