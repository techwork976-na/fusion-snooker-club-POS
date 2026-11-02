import { useState } from 'react'
import { errorMessage } from '@/lib/errors'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/Field'
import { useToast } from '@/components/ui/Toast'
import { useAuth } from './AuthProvider'

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { verifyPassword, changePassword } = useAuth()
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setCurrent('')
    setNext('')
    setConfirm('')
    setError(null)
  }

  const submit = async () => {
    if (next.length < 8) return setError('The new password must be at least 8 characters.')
    if (next.length > 72) return setError('The new password must be at most 72 characters.')
    if (next !== confirm) return setError('The new passwords do not match.')
    if (next === current) return setError('Choose a password different from the current one.')
    setBusy(true)
    setError(null)
    try {
      await verifyPassword(current)
      await changePassword(next)
      toast.success('Password changed.')
      reset()
      onOpenChange(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (busy) return
        if (!o) reset()
        onOpenChange(o)
      }}
      size="sm"
      title="Change my password"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit} disabled={!current || !next || !confirm}>
            Change password
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
        <TextField label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
        <TextField label="New password" type="password" autoComplete="new-password" hint="At least 8 characters." value={next} onChange={(e) => setNext(e.target.value)} />
        <TextField label="Repeat new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
