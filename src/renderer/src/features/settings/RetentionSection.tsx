import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Database, Play } from 'lucide-react'
import { formatBusinessDate, formatDateTime } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { RetentionDays, Settings } from '@/lib/types'
import * as api from '@/data/api'
import { accountingKeys, keys, useAction, useSettings } from '@/data/hooks'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Modal'
import { ErrorState, LoadingBlock, Segmented } from '@/components/ui/Misc'

const PERIODS: { value: '1' | '7' | '30'; label: string; detail: string }[] = [
  { value: '1', label: 'Daily', detail: 'Keep detailed invoices for 1 day' },
  { value: '7', label: 'Weekly', detail: 'Keep detailed invoices for 7 days' },
  { value: '30', label: 'Monthly', detail: 'Keep detailed invoices for 30 days' }
]

const mb = (bytes: number | null) => (bytes == null ? '—' : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

/**
 * Sales-detail retention. The cleanup runs on the database server (pg_cron),
 * never in this app; this screen only chooses the period and shows the log.
 */
export function RetentionSection({ settings }: { settings: Settings }) {
  const { data: tz } = useSettings()
  const [period, setPeriod] = useState<'1' | '7' | '30'>(String(settings.sales_retention_days) as '1' | '7' | '30')
  const [confirmRun, setConfirmRun] = useState(false)
  const status = useQuery({ queryKey: keys.retention, queryFn: api.getRetentionStatus })
  const save = useAction((days: RetentionDays) => api.updateSettings({ sales_retention_days: days }), {
    invalidate: [keys.settings, keys.retention],
    success: 'Retention period saved.'
  })
  const run = useAction(api.runRetention, {
    invalidate: [...accountingKeys, keys.retention],
    success: (r) =>
      r.status === 'success'
        ? `Cleanup finished: ${r.sales_deleted} invoice(s) removed.`
        : r.status === 'skipped'
          ? 'Another cleanup was already running.'
          : `Cleanup failed: ${r.message ?? 'unknown error'}`
  })
  const s = status.data
  const zone = tz?.business_timezone

  return (
    <div className="max-w-3xl space-y-6">
      <section className="card">
        <div className="px-8 pt-7 pb-2">
          <h2 className="font-display-tight text-[24px] text-forest-950">Data retention</h2>
          <p className="mt-1 text-sm text-fg-3">
            Keeps the database small by automatically removing old invoice details. Every total stays — shift summaries, daily
            figures, staff history, expenses and customer statistics are permanent.
          </p>
        </div>
        <div className="space-y-5 px-8 py-5">
          <div className="flex flex-wrap items-center gap-4">
            <Segmented layoutId="retention-period" value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p.value, label: p.label }))} />
            <span className="text-sm text-fg-3">{PERIODS.find((p) => p.value === period)?.detail}</span>
          </div>
          <div className="grid grid-cols-2 gap-4 text-[13px]">
            <div className="rounded-2xl bg-sunken/70 px-4 py-3.5">
              <p className="font-bold text-fg">Removed after the period</p>
              <p className="mt-1 text-fg-3">Individual invoices and their item lines, once their counter shift is closed.</p>
            </div>
            <div className="rounded-2xl bg-sunken/70 px-4 py-3.5">
              <p className="font-bold text-fg">Never removed</p>
              <p className="mt-1 text-fg-3">
                Staff, customers and their statistics, counter shifts and their times, expenses, daily summaries and all
                Cash / Bank / Total / Net figures.
              </p>
            </div>
          </div>
        </div>
        <div className="flex justify-end rounded-b-[var(--radius-card)] bg-canvas/50 px-8 py-4">
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={Number(period) === settings.sales_retention_days}
            onClick={() => save.mutate(Number(period) as RetentionDays)}
          >
            Save
          </Button>
        </div>
      </section>

      <section className="card px-6 py-5" data-testid="retention-status">
        {status.error ? (
          <ErrorState message={errorMessage(status.error)} onRetry={() => void status.refetch()} />
        ) : status.isLoading || !s ? (
          <LoadingBlock />
        ) : (
          <div className="space-y-5">
            <div
              className={cn(
                'flex items-start gap-3 rounded-xl px-4 py-3 text-sm',
                s.scheduled ? 'bg-sage-50 text-sage-800' : 'bg-brass-50 text-brass-800'
              )}
            >
              {s.scheduled ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
              <p>
                {s.scheduled
                  ? 'Automatic cleanup runs every hour on the database server — it does not need this app to be open.'
                  : 'Automatic cleanup is not scheduled on the server yet. Enable the pg_cron extension in Supabase and run the schedule step in the README. Until then you can run it below.'}
              </p>
            </div>

            <dl className="grid grid-cols-3 gap-x-6 gap-y-4 text-sm">
              <Fact label="Current period" value={`${s.retention_days} day${s.retention_days === 1 ? '' : 's'}`} />
              <Fact label="Removes invoices dated before" value={formatBusinessDate(s.cutoff_date)} />
              <Fact
                label="Last successful cleanup"
                value={s.last_success ? formatDateTime(s.last_success.started_at, zone) : 'Not yet'}
                sub={s.last_success ? `${s.last_success.sales_deleted} invoice(s) removed` : undefined}
              />
              <Fact label="Eligible right now" value={`${s.eligible_sales} invoice${s.eligible_sales === 1 ? '' : 's'}`} sub={`${s.eligible_items} item line(s)`} />
              <Fact
                label="Kept for open counters"
                value={String(s.waiting_on_open_shifts)}
                sub="removed after the counter closes"
              />
              <Fact
                label="Invoices kept"
                value={String(s.retained_sales)}
                sub={s.oldest_invoice_date ? `oldest ${formatBusinessDate(s.oldest_invoice_date)}` : undefined}
              />
              <Fact label="Database size" value={mb(s.database_bytes)} sub={`invoice details ${mb(s.detail_bytes)}`} />
            </dl>

            <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
              <p className="max-w-lg text-xs text-fg-4">
                Removed rows free their space for new data straight away; PostgreSQL reuses it rather than shrinking the
                database file at once, so the size shown may only drop after routine maintenance.
              </p>
              <Button variant="secondary" icon={<Play className="size-4" />} disabled={s.eligible_sales === 0} onClick={() => setConfirmRun(true)}>
                Run cleanup now
              </Button>
            </div>

            <div>
              <p className="label">Recent cleanups</p>
              {s.recent_runs.length === 0 ? (
                <p className="mt-2 text-sm text-fg-4">No cleanup has run yet.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line text-sm">
                  {s.recent_runs.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-4 py-2">
                      <span className="flex items-center gap-2">
                        <Database className="size-3.5 text-fg-4" />
                        <span className="text-fg-2">{formatDateTime(r.started_at, zone)}</span>
                        <span className="text-xs text-fg-4">{r.source === 'schedule' ? 'automatic' : 'manual'}</span>
                      </span>
                      <span
                        className={cn(
                          'text-xs font-semibold',
                          r.status === 'success' ? 'text-sage-700' : r.status === 'failed' ? 'text-claret-700' : 'text-fg-4'
                        )}
                      >
                        {r.status === 'success' ? `${r.sales_deleted} removed` : r.status}
                        {r.status === 'failed' && r.message ? ` — ${r.message}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmRun}
        onOpenChange={setConfirmRun}
        title="Run the cleanup now?"
        confirmLabel="Remove old invoices"
        description={
          s && (
            <>
              This removes <strong className="text-fg">{s.eligible_sales}</strong> invoice(s) dated before{' '}
              {formatBusinessDate(s.cutoff_date)} from closed counter shifts. Their totals stay in History.
            </>
          )
        }
        onConfirm={async () => {
          await run.mutateAsync(undefined)
        }}
      />
    </div>
  )
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-fg-4">{label}</dt>
      <dd className="mt-0.5 font-bold text-fg">{value}</dd>
      {sub && <dd className="text-xs text-fg-4">{sub}</dd>}
    </div>
  )
}
