import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ShieldCheck, UserRound } from 'lucide-react'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { listSwitchTargets } from '@/data/api'
import { keys } from '@/data/hooks'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/Field'
import { LoadingBlock } from '@/components/ui/Misc'
import { useToast } from '@/components/ui/Toast'
import { useAuth } from './AuthProvider'

/**
 * Admin → Staff: pick a staff account and enter that account's password.
 * Staff → Admin: enter the Admin master password.
 * Each switch is a real sign-in with Supabase Auth; the database decides what
 * the new account may do.
 */
export function SwitchPortalDialog({
  open,
  onOpenChange,
  target
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  target: 'admin' | 'staff'
}) {
  const { signIn } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const { data: targets, isLoading } = useQuery({
    queryKey: keys.switchTargets,
    queryFn: listSwitchTargets,
    enabled: open
  })
  const options = (targets ?? []).filter((t) => t.role === target)

  useEffect(() => {
    if (!open) {
      setPassword('')
      setError(null)
      setSelected(null)
    }
  }, [open])
  useEffect(() => {
    if (open && !selected && options.length === 1) setSelected(options[0]!.username)
  }, [open, selected, options])

  const submit = async () => {
    if (!selected) return setError(target === 'staff' ? 'Choose a staff member.' : 'Choose the admin account.')
    setBusy(true)
    setError(null)
    try {
      const p = await signIn(selected, password)
      onOpenChange(false)
      navigate('/')
      toast.success(target === 'admin' ? 'Admin portal unlocked.' : `Switched to ${p.full_name}.`)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      size="sm"
      title={target === 'admin' ? 'Switch to Admin portal' : 'Switch to Staff portal'}
      description={
        target === 'admin'
          ? 'Enter the Admin master password to continue.'
          : 'Choose who is taking over this terminal. They confirm with their own password.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit} disabled={!password || !selected}>
            {target === 'admin' ? 'Unlock Admin' : 'Switch'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {isLoading ? (
          <LoadingBlock className="py-6" />
        ) : options.length === 0 ? (
          <p className="text-sm text-fg-3">
            {target === 'staff' ? 'There are no active staff accounts yet. Add them under Staff.' : 'No active admin account was found.'}
          </p>
        ) : options.length > 1 || target === 'staff' ? (
          <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto pr-1">
            {options.map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => setSelected(t.username)}
                className={cn(
                  'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
                  selected === t.username
                    ? 'border-transparent bg-surface shadow-[var(--shadow-control)] ring-2 ring-forest-700'
                    : 'border-transparent bg-sunken/70 hover:bg-sunken'
                )}
              >
                {t.role === 'admin' ? <ShieldCheck className="size-4 text-brass-600" /> : <UserRound className="size-4 text-fg-3" />}
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-fg">{t.full_name}</span>
                  <span className="block truncate text-xs text-fg-4">@{t.username}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <TextField
          label={target === 'admin' ? 'Admin master password' : 'Password'}
          type="password"
          autoFocus
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
        />
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
