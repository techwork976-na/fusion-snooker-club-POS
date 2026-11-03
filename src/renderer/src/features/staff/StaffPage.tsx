import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { KeyRound, Pencil, ShieldCheck, Trash2, UserPlus, UserRound, UserX, UserCheck } from 'lucide-react'
import { PERMISSIONS, USERNAME_PATTERN, type Permission } from '@shared/constants'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { AppUser, Role } from '@/lib/types'
import { createUser, deleteUser, listUsers, setUserActive, setUserPassword, updateUser } from '@/data/api'
import { keys, useAction, useFloors } from '@/data/hooks'
import { Button, IconButton } from '@/components/ui/Button'
import { Checkbox, Select, TextField } from '@/components/ui/Field'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { ErrorState, LoadingBlock, Page, PageHeader } from '@/components/ui/Misc'
import { useToast } from '@/components/ui/Toast'
import { useAuth } from '@/features/auth/AuthProvider'

export function StaffPage() {
  const { profile } = useAuth()
  const toast = useToast()
  const { data: users, isLoading, error, refetch } = useQuery({ queryKey: keys.users, queryFn: listUsers })
  const { data: floors } = useFloors()
  const [editing, setEditing] = useState<AppUser | 'new' | null>(null)
  const [resetting, setResetting] = useState<AppUser | null>(null)
  const [toggling, setToggling] = useState<AppUser | null>(null)
  const [deleting, setDeleting] = useState<AppUser | null>(null)
  const remove = useAction((id: string) => deleteUser(id), { invalidate: [keys.users, keys.switchTargets], success: 'Account deleted.' })
  const toggle = useAction((a: { id: string; active: boolean }) => setUserActive(a.id, a.active), {
    invalidate: [keys.users, keys.switchTargets],
    success: (r) => (r.user.is_active ? `${r.user.full_name} can sign in again.` : `${r.user.full_name} has been deactivated.`)
  })
  const floorName = (id: number | null) => (id === null ? 'All floors' : floors?.find((f) => f.id === id)?.name ?? '—')

  return (
    <Page>
      <PageHeader
        title="Staff"
        subtitle="Accounts, floors and what each person may do. Every rule is enforced by the database."
        actions={
          <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setEditing('new')}>
            Add staff
          </Button>
        }
      />
      {error ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <LoadingBlock />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-4">
          {(users ?? []).map((u) => (
            <article key={u.id} className={cn('card flex flex-col p-5', !u.is_active && 'opacity-60')}>
              <div className="flex items-start gap-3.5">
                <span
                  className={cn(
                    'flex size-11 shrink-0 items-center justify-center rounded-xl',
                    u.role === 'admin' ? 'bg-brass-100 text-brass-800' : 'bg-sage-100 text-sage-800'
                  )}
                >
                  {u.role === 'admin' ? <ShieldCheck className="size-5" /> : <UserRound className="size-5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-bold text-fg">
                    {u.full_name}
                    {u.id === profile?.id && <span className="ml-2 text-xs font-semibold text-fg-4">(you)</span>}
                  </p>
                  <p className="text-xs text-fg-4">
                    @{u.username} · {u.role === 'admin' ? 'Administrator' : floorName(u.floor_id)}
                  </p>
                </div>
                {!u.is_active && <span className="rounded-full bg-claret-500/12 px-2 py-0.5 text-[11px] font-bold text-claret-700">Inactive</span>}
              </div>
              <div className="mt-4 flex min-h-7 flex-wrap gap-1.5">
                {u.role === 'admin' ? (
                  <span className="text-xs text-fg-4">Full access</span>
                ) : u.permissions.length === 0 ? (
                  <span className="text-xs text-fg-4">Tables and checkout only</span>
                ) : (
                  u.permissions.map((p) => (
                    <span key={p} className="rounded-md bg-sunken/70 px-2 py-0.5 text-[11px] font-semibold text-fg-2">
                      {PERMISSIONS.find((x) => x.key === p)?.label ?? p}
                    </span>
                  ))
                )}
              </div>
              <div className="mt-5 flex flex-wrap gap-1">
                <IconButton size="sm" label="Edit" onClick={() => setEditing(u)}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton size="sm" label="Reset password" onClick={() => setResetting(u)}>
                  <KeyRound className="size-4" />
                </IconButton>
                {u.id !== profile?.id && (
                  <IconButton
                    size="sm"
                    variant={u.is_active ? 'danger' : 'ghost'}
                    label={u.is_active ? 'Deactivate' : 'Activate'}
                    onClick={() => (u.is_active ? setToggling(u) : toggle.mutate({ id: u.id, active: true }))}
                  >
                    {u.is_active ? <UserX className="size-4" /> : <UserCheck className="size-4" />}
                  </IconButton>
                )}
                {u.id !== profile?.id && (
                  <IconButton size="sm" variant="danger" label="Delete account" onClick={() => setDeleting(u)}>
                    <Trash2 className="size-4" />
                  </IconButton>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.full_name ?? ''}'s account?`}
        confirmLabel="Delete for good"
        description="Only an account that has never sold, opened a counter, run a session or made a booking can be deleted. Accounts with history can only be deactivated, so reports keep their name."
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id)
        }}
      />
      <UserDialog user={editing} onClose={() => setEditing(null)} />
      <PasswordDialog
        user={resetting}
        onClose={() => setResetting(null)}
        onDone={(u) => toast.success(`Password changed for ${u.full_name}.`)}
      />
      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(o) => !o && setToggling(null)}
        title={`Deactivate ${toggling?.full_name ?? ''}?`}
        confirmLabel="Deactivate"
        description="They are signed out of the database immediately and cannot sign in until reactivated. Their past sales and shifts stay attributed to them."
        onConfirm={async () => {
          if (toggling) {
            const r = await toggle.mutateAsync({ id: toggling.id, active: false })
            if (r.warning) toast.info(r.warning)
          }
        }}
      />
    </Page>
  )
}

function UserDialog({ user, onClose }: { user: AppUser | 'new' | null; onClose: () => void }) {
  const isNew = user === 'new'
  const { data: floors } = useFloors()
  const [username, setUsername] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [floor, setFloor] = useState<string>('all')
  const [perms, setPerms] = useState<Permission[]>([])
  const [password, setPassword] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const save = useAction(
    async () => {
      const floorId = role === 'admin' || floor === 'all' ? null : Number(floor)
      if (isNew) {
        return (await createUser({ username: username.trim().toLowerCase(), full_name: fullName.trim(), role, floor_id: floorId, permissions: perms, password })).user
      }
      return updateUser({ id: (user as AppUser).id, full_name: fullName.trim(), role, floor_id: floorId, permissions: perms })
    },
    { invalidate: [keys.users, keys.switchTargets], success: (u) => `${u.full_name} saved.` }
  )

  useEffect(() => {
    if (!user) return
    setSubmitted(false)
    setPassword('')
    if (user === 'new') {
      setUsername('')
      setFullName('')
      setRole('staff')
      setFloor('all')
      setPerms(['view_own_sales'])
    } else {
      setUsername(user.username)
      setFullName(user.full_name)
      setRole(user.role)
      setFloor(user.floor_id === null ? 'all' : String(user.floor_id))
      setPerms(user.permissions)
    }
  }, [user])

  const errors = {
    username: isNew && !USERNAME_PATTERN.test(username.trim().toLowerCase()) ? '3–32 lowercase letters, digits, dot, dash or underscore.' : null,
    fullName: !fullName.trim() ? 'Name is required.' : null,
    password: isNew && (password.length < 8 || password.length > 72) ? 'At least 8 characters.' : null
  }
  const valid = Object.values(errors).every((e) => !e)
  const submit = () => {
    setSubmitted(true)
    if (valid) save.mutate(undefined, { onSuccess: onClose })
  }
  const show = (e: string | null) => (submitted ? e : null)

  return (
    <Modal
      open={user !== null}
      onOpenChange={(o) => !o && !save.isPending && onClose()}
      size="lg"
      title={isNew ? 'Add staff account' : `Edit ${(user as AppUser | null)?.full_name ?? ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={save.isPending}>
            {isNew ? 'Create account' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <TextField label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} error={show(errors.fullName)} autoFocus />
        <TextField
          label="Username"
          value={username}
          disabled={!isNew}
          onChange={(e) => setUsername(e.target.value)}
          error={show(errors.username)}
          hint={isNew ? 'Used to sign in.' : 'Usernames cannot be changed.'}
          spellCheck={false}
        />
        <Select
          label="Role"
          value={role}
          onChange={setRole}
          options={[
            { value: 'staff', label: 'Staff', hint: 'Floor operations' },
            { value: 'admin', label: 'Administrator', hint: 'Everything, including finances' }
          ]}
        />
        {role === 'staff' ? (
          <Select
            label="Assigned floor"
            value={floor}
            onChange={setFloor}
            options={[{ value: 'all', label: 'All floors' }, ...(floors ?? []).map((f) => ({ value: String(f.id), label: f.name }))]}
          />
        ) : (
          <div className="max-sm:hidden" />
        )}
        {isNew && (
          <TextField
            containerClassName="sm:col-span-2"
            label="Password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={show(errors.password)}
            hint="Share it privately; they can change it from their account menu."
          />
        )}
        {role === 'staff' && (
          <div className="mt-1 rounded-2xl bg-sunken/70 p-4 sm:col-span-2">
            <p className="mb-3 text-[13px] font-semibold text-fg-2">Permissions</p>
            <div className="grid grid-cols-1 gap-x-6 gap-y-3.5 sm:grid-cols-2">
              {PERMISSIONS.map((p) => (
                <Checkbox
                  key={p.key}
                  checked={perms.includes(p.key)}
                  onChange={(on) => setPerms((list) => (on ? [...list, p.key] : list.filter((x) => x !== p.key)))}
                  label={p.label}
                  description={p.description}
                />
              ))}
            </div>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

function PasswordDialog({ user, onClose, onDone }: { user: AppUser | null; onClose: () => void; onDone: (u: AppUser) => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setPassword('')
    setConfirm('')
    setError(null)
  }, [user])
  const submit = async () => {
    if (!user) return
    if (password.length < 8 || password.length > 72) return setError('Use 8–72 characters.')
    if (password !== confirm) return setError('The passwords do not match.')
    setBusy(true)
    try {
      await setUserPassword(user.id, password)
      onDone(user)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={user !== null}
      onOpenChange={(o) => !o && !busy && onClose()}
      size="sm"
      title={`Reset password · ${user?.full_name ?? ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            Set password
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <TextField label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        <TextField label="Repeat password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
