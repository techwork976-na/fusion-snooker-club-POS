import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, DatabaseBackup, Download, TriangleAlert } from 'lucide-react'
import { formatDateTime } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { BusinessResetResult } from '@/lib/types'
import * as api from '@/data/api'
import { useSettings } from '@/data/hooks'
import { Button } from '@/components/ui/Button'
import { Checkbox, TextField } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { LoadingBlock } from '@/components/ui/Misc'
import { useToast } from '@/components/ui/Toast'
import { useAuth } from '@/features/auth/AuthProvider'

export const RESET_PHRASE = 'RESET BUSINESS DATA'

/** What a reset removes, in the words staff use (database counts → labels). */
const REMOVED: [key: string, label: string][] = [
  ['sessions', 'Table sessions (including any in play)'],
  ['bookings', 'Pre-bookings'],
  ['sales', 'Invoices — table and snack sales'],
  ['sale_items', 'Invoice lines'],
  ['counter_shifts', 'Counter shifts (including any open counter)'],
  ['shift_daily_totals', 'Shift accounting records'],
  ['expenses', 'Expenses (counter and business)'],
  ['daily_summaries', 'Closed days'],
  ['product_sales_daily', 'Product sales history'],
  ['customers', 'Customers'],
  ['customer_visits', 'Customer visit history'],
  ['retention_runs', 'Cleanup log']
]

const KEPT = [
  'Admin and staff logins, roles and permissions',
  'Floors, tables, categories and their prices',
  'Products, prices and cost prices',
  'Settings, business timezone and data retention',
  'The scheduled 7-day / monthly cleanup'
]

type Step = 'review' | 'password' | 'backup' | 'confirm' | 'done'

/** Settings → Data management: reset all business data (admin, password, optional backup, typed confirmation). */
export function DataManagementSection() {
  const { data: settings } = useSettings()
  const summary = useQuery({ queryKey: ['business-data-summary'], queryFn: api.getBusinessDataSummary })
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-5">
      <section className="card max-w-3xl" data-testid="data-management">
        <div className="px-5 pt-6 pb-2 sm:px-8 sm:pt-7">
          <h2 className="font-display-tight text-[24px] text-forest-950">Reset business data</h2>
          <p className="mt-1 text-sm text-fg-3">
            Start the business records from zero — for example before handing FUSION to a club, or to begin a new period. Accounts, tables, prices
            and products stay. This is separate from the automatic data retention, and never runs on its own.
          </p>
        </div>
        <div className="px-5 py-5 sm:px-8">
          {summary.isLoading || !summary.data ? (
            <LoadingBlock className="py-6" />
          ) : (
            <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-sm sm:grid-cols-3 sm:gap-x-8">
              {[
                ['Table sessions', summary.data.counts.sessions],
                ['Invoices', summary.data.counts.sales],
                ['Counter shifts', summary.data.counts.counter_shifts],
                ['Expenses', summary.data.counts.expenses],
                ['Customers', summary.data.counts.customers],
                ['Pre-bookings', summary.data.counts.bookings]
              ].map(([label, n]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-fg-3">{label}</dt>
                  <dd className="font-semibold text-fg tabular">{n}</dd>
                </div>
              ))}
            </dl>
          )}
          {summary.data?.last_reset_at && (
            <p className="mt-5 text-xs text-fg-4" data-testid="last-reset">
              Last reset {formatDateTime(summary.data.last_reset_at, settings?.business_timezone)}
              {summary.data.last_reset_by ? ` by ${summary.data.last_reset_by}` : ''}.
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2.5 rounded-b-[var(--radius-card)] bg-canvas/50 px-5 py-4 sm:px-8">
          <Button variant="danger" icon={<TriangleAlert className="size-4" />} onClick={() => setOpen(true)} data-testid="open-reset">
            Reset business data…
          </Button>
        </div>
      </section>
      <ResetDialog open={open} onClose={() => setOpen(false)} />
    </div>
  )
}

/** "2 tables are in play and 1 counter is open", naming only what is open. */
function openNow(c: Record<string, number> | undefined): string | null {
  const sessions = c?.open_sessions ?? 0
  const counters = c?.open_counters ?? 0
  const parts = [
    sessions > 0 ? `${sessions} table${sessions === 1 ? ' is' : 's are'} in play` : null,
    counters > 0 ? `${counters} counter${counters === 1 ? ' is' : 's are'} open` : null
  ].filter(Boolean)
  return parts.length ? parts.join(' and ') : null
}

function download(data: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function backupFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `FUSION-business-data-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.json`
}

function ResetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { verifyPassword } = useAuth()
  const summary = useQuery({ queryKey: ['business-data-summary'], queryFn: api.getBusinessDataSummary, enabled: open })
  const [step, setStep] = useState<Step>('review')
  const [resetStock, setResetStock] = useState(false)
  const [password, setPassword] = useState('')
  const [phrase, setPhrase] = useState('')
  const [backupFile, setBackupFile] = useState<string | null>(null)
  const [busy, setBusy] = useState<'password' | 'backup' | 'reset' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BusinessResetResult | null>(null)

  const close = () => {
    if (busy === 'reset') return
    onClose()
    // Forget the password and every choice once the dialog has closed.
    setTimeout(() => {
      setStep('review')
      setResetStock(false)
      setPassword('')
      setPhrase('')
      setBackupFile(null)
      setBusy(null)
      setError(null)
      setResult(null)
    }, 250)
  }

  const checkPassword = async () => {
    setBusy('password')
    setError(null)
    try {
      await verifyPassword(password)
      setStep('backup')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const exportBackup = async () => {
    setBusy('backup')
    setError(null)
    try {
      const data = await api.exportBusinessData(password)
      const name = backupFileName()
      download(data, name)
      setBackupFile(name)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const runReset = async () => {
    setBusy('reset')
    setError(null)
    try {
      const r = await api.resetBusinessData({ password, confirmation: phrase, resetStock })
      setResult(r)
      setStep('done')
      setPassword('')
      // Every screen shows the fresh state at once.
      await qc.invalidateQueries()
      toast.success('Business data reset.')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const counts = summary.data?.counts
  const removedRows = (c: Record<string, number> | undefined) =>
    REMOVED.map(([key, label]) => (
      <li key={key} className="flex justify-between gap-3 py-1">
        <span className="text-fg-2">{label}</span>
        <span className="font-semibold text-fg tabular">{c ? c[key] ?? 0 : '…'}</span>
      </li>
    ))

  const footer =
    step === 'done' ? (
      <Button variant="primary" onClick={close} data-testid="reset-done">
        Done
      </Button>
    ) : (
      <>
        <Button variant="ghost" onClick={close} disabled={busy === 'reset'} data-testid="reset-cancel">
          Cancel
        </Button>
        {step === 'review' && (
          <Button variant="primary" onClick={() => setStep('password')} data-testid="reset-continue">
            Continue
          </Button>
        )}
        {step === 'password' && (
          <Button variant="primary" loading={busy === 'password'} disabled={!password} onClick={() => void checkPassword()} data-testid="reset-continue">
            Continue
          </Button>
        )}
        {step === 'backup' && (
          <Button variant={backupFile ? 'primary' : 'secondary'} disabled={busy !== null} onClick={() => setStep('confirm')} data-testid="reset-skip-backup">
            {backupFile ? 'Continue' : 'Skip backup & continue'}
          </Button>
        )}
        {step === 'confirm' && (
          <Button
            variant="danger"
            className="bg-claret-600 text-white hover:bg-claret-700"
            loading={busy === 'reset'}
            disabled={phrase !== RESET_PHRASE}
            onClick={() => void runReset()}
            data-testid="reset-confirm"
          >
            Reset business data
          </Button>
        )}
      </>
    )

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && close()}
      dismissible={busy !== 'reset'}
      size="md"
      title={step === 'done' ? 'Business data reset' : 'Reset business data'}
      description={
        step === 'review'
          ? 'Permanently deletes the business records below. This cannot be undone.'
          : step === 'password'
            ? 'Enter your password to continue.'
            : step === 'backup'
              ? 'Optional: download a copy of the records before they are deleted.'
              : step === 'confirm'
                ? 'Last step. Nothing has been deleted yet.'
                : undefined
      }
      footer={footer}
    >
      <div className="space-y-5" data-testid={`reset-step-${step}`}>
        {step === 'review' && (
          <>
            <div>
              <p className="text-xs font-semibold tracking-wide text-claret-700 uppercase">Deleted for good</p>
              <ul className="mt-2 divide-y divide-line text-sm">{removedRows(counts)}</ul>
              <p className="mt-2 text-xs text-fg-4">Receipt numbers start again at 1 and every product's units-sold count goes back to zero.</p>
              {openNow(counts) && (
                <p className="mt-3 rounded-xl bg-claret-50 px-3.5 py-2.5 text-sm text-claret-800">{openNow(counts)} right now — cleared too.</p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold tracking-wide text-forest-700 uppercase">Kept</p>
              <ul className="mt-2 space-y-1 text-sm text-fg-2">
                {KEPT.map((k) => (
                  <li key={k} className="flex items-start gap-2">
                    <CircleCheck className="mt-0.5 size-4 shrink-0 text-forest-700" /> {k}
                  </li>
                ))}
                <li className="flex items-start gap-2">
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-forest-700" /> Product stock quantities (unless you choose below)
                </li>
              </ul>
            </div>
            <Checkbox
              checked={resetStock}
              onChange={setResetStock}
              label="Also set every product's stock to zero"
              description="Leave this off to keep the stock you have counted."
            />
          </>
        )}

        {step === 'password' && (
          <TextField
            label="Your password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={error}
            data-testid="reset-password"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && password) void checkPassword()
            }}
          />
        )}

        {step === 'backup' && (
          <>
            <div className="rounded-2xl bg-sunken/70 px-5 py-4">
              <p className="text-sm text-fg-2">
                The backup is a file with every record listed on the first step, saved on this computer. It is not required — choose
                <span className="font-semibold"> Skip backup &amp; continue</span> if you do not need it.
              </p>
              <Button className="mt-4" icon={<Download className="size-4" />} loading={busy === 'backup'} onClick={() => void exportBackup()} data-testid="reset-export">
                Export backup
              </Button>
              {backupFile && (
                <p className="mt-3 flex items-center gap-2 text-sm font-semibold text-forest-800" data-testid="reset-backup-done">
                  <DatabaseBackup className="size-4" /> Saved as {backupFile}
                </p>
              )}
            </div>
            {error && <p className="text-sm text-claret-700">{error}</p>}
          </>
        )}

        {step === 'confirm' && (
          <>
            <p className="text-sm text-fg-2">
              {backupFile ? `Backup saved as ${backupFile}. ` : 'No backup was made. '}
              {resetStock ? 'Product stock will be set to zero.' : 'Product stock will be kept.'}
            </p>
            <TextField
              label={`Type ${RESET_PHRASE} to confirm`}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              error={error}
              data-testid="reset-phrase"
            />
          </>
        )}

        {step === 'done' && result && (
          <div data-testid="reset-summary">
            <p className="flex items-center gap-2 text-sm font-semibold text-forest-800">
              <CircleCheck className="size-4" /> All business data was reset{result.stock_reset ? ', and product stock set to zero' : ''}.
            </p>
            <p className="mt-3 text-xs font-semibold tracking-wide text-fg-4 uppercase">Removed</p>
            <ul className={cn('mt-2 divide-y divide-line text-sm')}>{removedRows(result.removed)}</ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
