// 用户页（主管专用）：左边按主管 / 员工分组的列表，右边选中用户的详情。
// 操作：新建用户、编辑（名字 / 职位 / 角色）、重置密码、停用（二次确认）/ 启用。
// 停用 = 登录不了，已登录的会话立刻失效；随时可以启用。不能停用自己（后端也会拒绝）。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { KeyRoundIcon, PencilIcon, PlusIcon, ShieldOffIcon, UserCheckIcon, UserXIcon, UsersIcon } from "lucide-react"
import { can, findById, fmtDateTime, type UserAccount } from "@heyagent/shared"

import { DetailPanel, DetailSection, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent } from "@/components/ui/alert-dialog"
import { AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

import { useAction } from "@/lib/mutations"
import { href, useRoute } from "@/lib/router"
import { trpc } from "@/lib/trpc"
import { useMe } from "@/lib/session"

import { CreateUserDialog, EditUserDialog, ResetPasswordDialog, ROLE_HINT, ROLE_LABEL } from "./user-dialogs"

const DESCRIPTION = "谁能登录这个系统。主管能管理用户、设置和所有配置，员工只管自己的任务和事。"

export default function UsersPage() {
  const { user } = useMe()
  if (!can(user, "user.manage", {})) {
    return (
      <div className="flex flex-1 flex-col gap-6">
        <SimpleHeader title="用户" description={DESCRIPTION} />
        <EmptyState icon={<ShieldOffIcon />} title="只有主管能管理用户" description="要加人、改角色或重置密码，请找主管。改自己的密码在左下角用户菜单里。" />
      </div>
    )
  }
  return <UsersManager meId={user.id} />
}

function UsersManager({ meId }: { meId: string }) {
  const { params } = useRoute()
  const usersQuery = useQuery(trpc.users.list.queryOptions())
  const list = usersQuery.data ?? []
  const [dialog, setDialog] = React.useState<"new" | "edit" | "password" | "disable" | null>(null)

  const selected = findById(list, params.get("id"))
  const isSelf = selected?.id === meId
  const admins = list.filter((each) => each.isAdmin)
  const staff = list.filter((each) => !each.isAdmin)

  const setDisabled = useAction(trpc.users.setDisabled.mutationOptions(), {
    success: (_data, vars) => (vars.disabled ? `已停用「${selected?.name ?? ""}」` : `已启用「${selected?.name ?? ""}」，现在可以登录了`),
  })

  async function disable() {
    if (!selected) return
    if (await setDisabled.submit({ id: selected.id, disabled: true })) setDialog(null)
  }

  const newButton = (
    <Button onClick={() => setDialog("new")}>
      <PlusIcon data-icon="inline-start" />
      新建用户
    </Button>
  )

  return (
    <>
      <PageFrame
        queries={[usersQuery]}
        isEmpty={list.length === 0}
        header={<SimpleHeader title="用户" description={DESCRIPTION} action={list.length > 0 && newButton} />}
        empty={<EmptyState icon={<UsersIcon />} title="还没有用户" description="点下面新建第一个账号，建好后把邮箱和初始密码告诉本人。" action={newButton} />}
      >
        <MasterDetail
          hasSelection={!!selected}
          list={
            <>
              {admins.length > 0 && (
                <PickGroup label={`主管 · ${admins.length} 人`}>
                  {admins.map((each) => (
                    <UserPick key={each.id} account={each} selected={each.id === selected?.id} isSelf={each.id === meId} />
                  ))}
                </PickGroup>
              )}
              {staff.length > 0 && (
                <PickGroup label={`员工 · ${staff.length} 人`}>
                  {staff.map((each) => (
                    <UserPick key={each.id} account={each} selected={each.id === selected?.id} isSelf={each.id === meId} />
                  ))}
                </PickGroup>
              )}
            </>
          }
          detail={
            selected && (
              <DetailPanel
                title={selected.name}
                badges={
                  <>
                    <Badge variant={selected.isAdmin ? "default" : "outline"}>{selected.isAdmin ? "主管" : "员工"}</Badge>
                    {selected.disabled ? <Badge variant="destructive">已停用</Badge> : isSelf && <Badge variant="ghost">你自己</Badge>}
                  </>
                }
                meta={selected.email}
                actions={
                  <>
                    <Button variant="outline" onClick={() => setDialog("edit")}>
                      <PencilIcon data-icon="inline-start" />
                      编辑
                    </Button>
                    <Button variant="outline" onClick={() => setDialog("password")}>
                      <KeyRoundIcon data-icon="inline-start" />
                      重置密码
                    </Button>
                  </>
                }
              >
                <DetailSection title="基本信息">
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                    <InfoRow label="名字">{selected.name}</InfoRow>
                    <InfoRow label="邮箱（登录用）">{selected.email}</InfoRow>
                    <InfoRow label="职位">{selected.title || <span className="text-muted-foreground">没填</span>}</InfoRow>
                    <InfoRow label="角色">
                      {ROLE_LABEL[selected.isAdmin ? "admin" : "user"]}
                      <span className="block text-xs text-muted-foreground">{ROLE_HINT[selected.isAdmin ? "admin" : "user"]}</span>
                    </InfoRow>
                    <InfoRow label="创建时间">{fmtDateTime(selected.createdAt)}</InfoRow>
                  </dl>
                </DetailSection>

                <DetailSection
                  title="账号状态"
                  description={
                    selected.disabled
                      ? "已停用：登录不了。启用后用原来的密码就能登录。"
                      : isSelf
                        ? "正常。不能停用自己，要停用请另一位主管来操作。"
                        : "正常，可以登录。停用后登录不了，已登录的会话立刻失效，随时可以再启用。"
                  }
                  action={
                    selected.disabled ? (
                      <Button
                        size="sm"
                        disabled={setDisabled.isPending}
                        onClick={() => setDisabled.mutate({ id: selected.id, disabled: false })}
                      >
                        {setDisabled.isPending ? <Spinner data-icon="inline-start" /> : <UserCheckIcon data-icon="inline-start" />}
                        启用
                      </Button>
                    ) : (
                      !isSelf && (
                        <Button size="sm" variant="outline" onClick={() => setDialog("disable")}>
                          <UserXIcon data-icon="inline-start" />
                          停用
                        </Button>
                      )
                    )
                  }
                >
                  <p>{selected.disabled ? "已停用" : "正常"}</p>
                </DetailSection>
              </DetailPanel>
            )
          }
        />
      </PageFrame>
      {dialog === "new" && <CreateUserDialog onClose={() => setDialog(null)} />}
      {dialog === "edit" && selected && <EditUserDialog user={selected} isSelf={isSelf} onClose={() => setDialog(null)} />}
      {dialog === "password" && selected && <ResetPasswordDialog user={selected} isSelf={isSelf} onClose={() => setDialog(null)} />}

      <AlertDialog open={dialog === "disable"} onOpenChange={(open) => !open && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>停用「{selected?.name}」的账号？</AlertDialogTitle>
            <AlertDialogDescription>
              停用后他就登录不了了，已经登录的设备会立刻退出。他负责的任务和事不会删除。随时可以在这里再启用，启用后用原来的密码登录。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不停用</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={setDisabled.isPending} onClick={disable}>
              {setDisabled.isPending && <Spinner data-icon="inline-start" />}
              停用账号
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function UserPick({ account, selected, isSelf }: { account: UserAccount; selected: boolean; isSelf: boolean }) {
  return (
    <PickItem
      to={href("users", { id: account.id })}
      selected={selected}
      title={isSelf ? `${account.name}（你）` : account.name}
      description={account.title ? `${account.title} · ${account.email}` : account.email}
      badge={account.disabled && <Badge variant="outline">已停用</Badge>}
    />
  )
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all">{children}</dd>
    </div>
  )
}
