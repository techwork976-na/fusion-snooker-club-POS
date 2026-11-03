import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarCheck2, CheckCircle2, ShieldCheck } from 'lucide-react'
import { formatBusinessDate, formatDateTime, formatMoney } from '@shared/format'
import { errorMessage } from '@/lib/errors'
import type { OpenBusinessDay } from '@/lib/types'
import { closeBusinessDay, listDailySummaries, listOpenBusinessDays } from '@/data/api'
import { accountingKeys, keys, useAction, useBusinessDate, useSettings } from '@/data/hooks'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Modal'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Misc'
import { Tooltip } from '@/components/ui/Tooltip'

/**
 * Closing a business day finalises its summary (Cash, Bank, Total, Expenses,
 * Net). Nothing is deleted: detailed invoices are removed only by the
 * automatic retention policy in Settings.
 */
export function CloseDayPanel() {
  const { data: today } = useBusinessDate()
  const { data: settings } = useSettings()
  const tz = settings?.business_timezone
  const open = useQuery({ queryKey: keys.openDays, queryFn: listOpenBusinessDays })
  const closed = useQuery({ queryKey: keys.summaries, queryFn: () => listDailySummaries(30) })
  const [target, setTarget] = useState<OpenBusinessDay | null>(null)
  const close = useAction(closeBusinessDay, {
    invalidate: [...accountingKeys, keys.summaries],
    success: (r) => `${formatBusinessDate(r.business_date)} closed. Its summary is saved.`
  })

  return (
    <div className="grid grid-cols-12 gap-5">
      <div className="col-span-12 space-y-5 xl:col-span-8">
        <section className="card flex items-start gap-4 p-5 sm:p-6">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-forest-50 text-forest-700">
            <ShieldCheck className="size-5" />
          </span>
          <div className="text-sm text-fg-2">
            <p className="font-bold text-fg">Closing a day keeps everything</p>
            <p className="mt-1 leading-relaxed">
              It saves the day's final Cash, Bank, Total, Expenses and Net, after every counter that traded that day is closed.
              No sales, shifts or expenses are deleted. Old invoice details are removed automatically after{' '}
              {settings?.sales_retention_days ?? 30} day(s) (Settings → Data retention); their totals stay here for good.
            </p>
          </div>
        </section>

        <section className="card overflow-hidden">
          <div className="px-5 pt-5 pb-3 sm:px-6">
            <span className="label">Days to close</span>
          </div>
          {open.error ? (
            <div className="p-6">
              <ErrorState message={errorMessage(open.error)} onRetry={() => void open.refetch()} />
            </div>
          ) : open.isLoading ? (
            <LoadingBlock />
          ) : !open.data?.length ? (
            <EmptyState className="py-10" icon={<CheckCircle2 className="size-5" />} title="Every day is closed" description="New activity will appear here." />
          ) : (
            <table className="table-stack w-full text-sm" data-testid="days-to-close">
              <thead>
                <tr className="thead-row">
                  <th className="px-6 py-3 font-semibold">Business day</th>
                  <th className="px-4 py-3 text-right font-semibold">Invoices</th>
                  <th className="px-4 py-3 text-right font-semibold">Cash</th>
                  <th className="px-4 py-3 text-right font-semibold">Bank</th>
                  <th className="px-4 py-3 text-right font-semibold">Total</th>
                  <th className="px-4 py-3 text-right font-semibold">Expenses</th>
                  <th className="w-36 px-6 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {open.data.map((d) => {
                  const blocked = Number(d.open_counters) > 0
                  return (
                    <tr key={d.business_date}>
                      <td className="px-6 py-3" data-stack="title">
                        <span className="block font-semibold text-fg">
                          {formatBusinessDate(d.business_date)}
                          {d.business_date === today && <span className="ml-2 rounded-full bg-forest-50 px-2 py-0.5 text-[11px] font-bold text-forest-700">Today</span>}
                        </span>
                        <span className="block text-xs text-fg-4">
                          {blocked
                            ? `${d.open_counters} counter${Number(d.open_counters) === 1 ? '' : 's'} still open`
                            : d.changed_since_close
                              ? 'Changed since it was closed — close again to update'
                              : 'Not closed yet'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-fg-3 tabular" data-label="Invoices">{d.invoice_count}</td>
                      <td className="px-4 py-3 text-right text-fg-2 tabular" data-label="Cash">{formatMoney(d.total_cash)}</td>
                      <td className="px-4 py-3 text-right text-fg-2 tabular" data-label="Bank">{formatMoney(d.total_bank)}</td>
                      <td className="px-4 py-3 text-right font-bold text-fg tabular" data-label="Total">{formatMoney(d.total_sales)}</td>
                      <td className="px-4 py-3 text-right text-fg-3 tabular" data-label="Expenses">{formatMoney(d.expenses)}</td>
                      <td className="px-6 py-2 text-right" data-stack="full">
                        {blocked ? (
                          <Tooltip content="Every counter that traded this day must be closed first">
                            <span>
                              <Button size="sm" variant="secondary" disabled>
                                Close day
                              </Button>
                            </span>
                          </Tooltip>
                        ) : (
                          <Button size="sm" variant="primary" icon={<CalendarCheck2 className="size-3.5" />} onClick={() => setTarget(d)}>
                            Close day
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card col-span-12 self-start p-5 sm:p-6 xl:col-span-4">
        <span className="label">Recently closed</span>
        {closed.isLoading ? (
          <LoadingBlock />
        ) : !(closed.data ?? []).filter((s) => s.closed_at).length ? (
          <p className="mt-4 text-sm text-fg-4">No days have been closed yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line" data-testid="closed-days">
            {(closed.data ?? [])
              .filter((s) => s.closed_at)
              .map((s) => (
                <li key={s.id} className="py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-semibold text-fg">{formatBusinessDate(s.business_date)}</span>
                    <span className="text-sm font-bold text-forest-950 tabular">{formatMoney(s.total_sales)}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-fg-4 tabular">
                    Cash {formatMoney(s.total_cash)} · Bank {formatMoney(s.total_bank)} · Expenses {formatMoney(s.expenses)} · Net{' '}
                    {formatMoney(Number(s.total_sales) - Number(s.expenses))}
                  </p>
                  <p className="text-[11px] text-fg-5">Closed {formatDateTime(s.closed_at!, tz)}</p>
                </li>
              ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        tone="primary"
        title={`Close ${target ? formatBusinessDate(target.business_date) : ''}?`}
        confirmLabel="Close day"
        description={
          target && (
            <>
              This saves the final summary — <strong className="text-fg">{formatMoney(target.total_sales)}</strong> in sales (
              {formatMoney(target.total_cash)} cash, {formatMoney(target.total_bank)} bank) and {formatMoney(target.expenses)} in
              expenses. Nothing is deleted.
            </>
          )
        }
        onConfirm={async () => {
          if (target) await close.mutateAsync(target.business_date)
        }}
      />
    </div>
  )
}
