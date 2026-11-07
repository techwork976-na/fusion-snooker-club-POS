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
 * Signs another account in on this device — once, with its password. From
 * then on it is one click away in the account menu (no password, no time
 * limit) until "Log out of all accounts". A real Supabase sign-in: the
 * database decides what the account may do.
 */
export function AddAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { signIn, accounts } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const { data: targets, isLoading } = useQuery({ queryKey: keys.switchTargets, queryFn: listSwitchTargets, enabled: open })
  // Accounts already on this device are switched to from the menu instead.
  const options = (targets ?? []).filter((t) => !accounts.some((a) => a.userId === t.id))
  const username = selected ?? typed.trim()

  useEffect(() => {
    if (!open) {
      setPassword('')
      setError(null)
      setSelected(null)
      setTyped('')
    }
  }, [open])

  const submit = async () => {
    if (!username) return setError('Choose an account or type its username.')
    setBusy(true)
    setError(null)
    try {
      const p = await signIn(username, password)
      onOpenChange(false)
      navigate('/')
      toast.success(`Signed in as ${p.full_name}. Switch with one click from now on.`)
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
      title="Add an account"
      description="Sign in once with the account's password. It then stays on this device — one click to switch — until you log out of all accounts."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit} disabled={!password || !username} data-testid="add-account-submit">
            Sign in &amp; switch
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
        ) : (
          options.length > 0 && (
            <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto pr-1">
              {options.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  onClick={() => {
                    setSelected(t.username)
                    setTyped('')
                  }}
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
          )
        )}
        <TextField
          label={options.length > 0 ? 'Or another username' : 'Username'}
          autoComplete="off"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value)
            setSelected(null)
          }}
          data-testid="add-account-username"
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
          data-testid="add-account-password"
        />
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
