import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Clock3, FileX2, ReceiptText } from 'lucide-react'
import { formatBusinessDate, formatDateTime, formatDuration, formatMoney, formatRate, formatTime, paymentLabel, splitLabel } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { Shift } from '@/lib/types'
import { getShiftDetail } from '@/data/api'
import { keys, useSettings } from '@/data/hooks'
import { SERIES_COLORS } from '@/components/charts/BarChart'
import { AnimatedNumber } from '@/components/motion/AnimatedNumber'
import { Drawer } from '@/components/ui/Drawer'
import { ErrorState, LoadingBlock } from '@/components/ui/Misc'

export function ShiftStatusPill({ status }: { status: Shift['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold',
        status === 'open' ? 'bg-sage-100 text-forest-800' : 'bg-forest-950/[0.05] text-fg-3'
      )}
    >
      <span className={cn('size-1.5 rounded-full', status === 'open' ? 'bg-forest-600' : 'bg-fg-5')} />
      {status === 'open' ? 'Open' : 'Closed'}
    </span>
  )
}

/** "Sat 1 Nov, 07:15 PM → 11:40 PM" (dates repeated only when the shift crosses midnight). */
export function shiftTimes(shift: Pick<Shift, 'opened_at' | 'closed_at'>, tz?: string): string {
  const opened = formatDateTime(shift.opened_at, tz)
  if (!shift.closed_at) return `Opened ${opened}`
  const sameDay =
    new Date(shift.opened_at).toLocaleDateString('en-GB', { timeZone: tz }) ===
    new Date(shift.closed_at).toLocaleDateString('en-GB', { timeZone: tz })
  return `${opened} → ${sameDay ? formatTime(shift.closed_at, tz) : formatDateTime(shift.closed_at, tz)}`
}

type Figures = Pick<Shift, 'cash' | 'bank' | 'total' | 'snack' | 'expenses' | 'net'>

/** Cash and bank on a deep forest panel: the same hues, lightened to read on the dark. */
const ON_DARK = { cash: '#aebb9f', bank: '#d4bb84' }

/** The six accounting figures, in the same order everywhere (`tone="dark"` on a forest hero panel). */
export function ShiftFigures({
  figures,
  size = 'md',
  className,
  tone = 'light'
}: {
  figures: Figures
  size?: 'md' | 'lg'
  className?: string
  tone?: 'light' | 'dark'
}) {
  const dark = tone === 'dark'
  const items: { label: string; value: number; color?: string; hint?: string; strong?: boolean; negative?: boolean }[] = [
    { label: 'Cash', value: figures.cash, color: dark ? ON_DARK.cash : SERIES_COLORS.cash },
    { label: 'Bank transfer', value: figures.bank, color: dark ? ON_DARK.bank : SERIES_COLORS.bank },
    { label: 'Total sales', value: figures.total, strong: true },
    { label: 'Snack sales', value: figures.snack, hint: 'included above' },
    { label: 'Expenses', value: figures.expenses, negative: true },
    { label: 'Net', value: figures.net, strong: true, hint: 'after expenses' }
  ]
  return (
    <div className={cn('grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3 sm:gap-x-6 sm:gap-y-5 xl:grid-cols-6', className)}>
      {items.map((f) => (
        <div key={f.label} className="min-w-0">
          <p className={cn('flex items-center gap-1.5 text-xs font-semibold', dark ? 'text-side-muted' : 'text-fg-3')}>
            {f.color && <span className="size-2 rounded-full" style={{ background: f.color }} />}
            {f.label}
          </p>
          <AnimatedNumber
            value={f.value}
            format={(n) => `${f.negative && n > 0 ? '−' : ''}${formatMoney(n)}`}
            className={cn(
              'mt-2 block figure leading-none sm:whitespace-nowrap',
              size === 'lg' ? 'text-[clamp(19px,6.2vw,24px)] sm:text-[28px]' : 'text-[clamp(17px,5.4vw,19px)] sm:text-[21px]',
              dark
                ? f.strong
                  ? 'text-cream'
                  : f.negative && f.value > 0
                    ? 'text-claret-300'
                    : 'text-side-fg'
                : f.strong
                  ? 'text-forest-950'
                  : f.negative && f.value > 0
                    ? 'text-claret-600'
                    : 'text-fg-2'
            )}
          />
          {f.hint && <p className={cn('mt-1 text-[11px]', dark ? 'text-side-muted/80' : 'text-fg-4')}>{f.hint}</p>}
        </div>
      ))}
    </div>
  )
}

/** Full detail of one shift: figures, expenses and (while retained) invoices. */
export function ShiftDetailDrawer({ shiftId, onClose }: { shiftId: string | null; onClose: () => void }) {
  const { data: settings } = useSettings()
  const tz = settings?.business_timezone
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: keys.shift(shiftId ?? ''),
    queryFn: () => getShiftDetail(shiftId!),
    enabled: Boolean(shiftId)
  })

  return (
    <Drawer
      open={shiftId !== null}
      onOpenChange={(o) => !o && onClose()}
      title={data ? data.staff_name : 'Shift'}
      subtitle={data ? shiftTimes(data, tz) : undefined}
      aside={data && <ShiftStatusPill status={data.status} />}
    >
      {error ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-6" data-testid="shift-detail">
          <ShiftFigures figures={data} className="sm:!grid-cols-3" />

          <ul className="space-y-1.5 rounded-xl bg-sunken px-4 py-3 text-[13px] text-fg-2">
            <li className="flex items-center gap-2">
              <Clock3 className="size-3.5 text-fg-4" />
              {data.closed_at
                ? `Open for ${formatDuration((Date.parse(data.closed_at) - Date.parse(data.opened_at)) / 1000)}`
                : 'Counter is open now'}
              {data.closed_at && data.closed_by_self === false && data.closed_by_name ? ` · closed by ${data.closed_by_name}` : ''}
            </li>
            <li>
              {data.invoices} invoice{data.invoices === 1 ? '' : 's'}
              {data.discounts > 0 ? ` · ${formatMoney(data.discounts)} in discounts` : ''}
              {data.voided_count > 0 ? ` · ${data.voided_count} voided (${formatMoney(data.voided_amount)})` : ''}
            </li>
            {data.handover_sessions > 0 && <li>{data.handover_sessions} table session(s) handed over at closing</li>}
            {data.imported && <li className="text-fg-4">Imported from before counter shifts existed — times are the first and last sale.</li>}
          </ul>

          {data.days.length > 1 && (
            <section>
              <h3 className="label">By business day</h3>
              <ul className="mt-2 divide-y divide-line text-sm">
                {data.days.map((d) => (
                  <li key={d.business_date} className="flex justify-between py-2">
                    <span className="text-fg-2">{formatBusinessDate(d.business_date)}</span>
                    <span className="font-semibold text-fg tabular">{formatMoney(d.total)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="label">Expenses</h3>
            {data.expense_list.length === 0 ? (
              <p className="mt-2 text-sm text-fg-4">No expenses recorded.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line text-sm">
                {data.expense_list.map((e) => (
                  <li key={e.id} className={cn('flex items-center justify-between gap-3 py-2', e.voided_at && 'text-fg-4 line-through')}>
                    <span className="min-w-0 truncate">
                      {e.description}
                      <span className="ml-2 text-xs text-fg-4 no-underline">{formatTime(e.created_at, tz)}</span>
                    </span>
                    <span className="shrink-0 font-semibold tabular">{formatMoney(e.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="label">Invoices</h3>
            {!data.invoices_visible ? (
              <p className="mt-2 text-sm text-fg-4">Your account does not include invoice details.</p>
            ) : data.invoice_list.length === 0 && data.invoices > 0 ? (
              <div className="mt-2 flex items-start gap-3 rounded-xl bg-sunken/70 px-4 py-3 text-sm text-fg-2">
                <FileX2 className="mt-0.5 size-4 shrink-0 text-brass-600" />
                <p>
                  Detailed invoices for this shift have expired under the {data.retention_days}-day retention policy. The shift
                  figures above are permanent and remain correct.
                </p>
              </div>
            ) : data.invoice_list.length === 0 ? (
              <p className="mt-2 text-sm text-fg-4">No invoices in this shift.</p>
            ) : (
              <>
                {data.details_purged_at && data.retained_invoices < data.invoices && (
                  <p className="mt-2 text-xs text-fg-4">
                    {data.invoices - data.retained_invoices} older invoice(s) have expired under the retention policy.
                  </p>
                )}
                <ul className="mt-2 divide-y divide-line">
                  {data.invoice_list.map((inv) => (
                    <InvoiceRow key={inv.id} invoice={inv} tz={tz} />
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      )}
    </Drawer>
  )
}

function InvoiceRow({ invoice, tz }: { invoice: import('@/lib/types').ShiftInvoice; tz?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <li>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 py-2.5 text-left">
        <ReceiptText className="size-4 shrink-0 text-fg-4" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-fg">
            #{invoice.receipt_no} · {invoice.table_name ?? 'Counter sale'}
          </span>
          <span className="block truncate text-xs text-fg-4">
            {formatTime(invoice.created_at, tz)} ·{' '}
            {invoice.payment_method === 'split' && invoice.split_cash_amount != null
              ? splitLabel(invoice.final_amount, invoice.split_cash_amount)
              : paymentLabel(invoice.payment_method)}
            {invoice.customer_name ? ` · ${invoice.customer_name}` : ''}
          </span>
        </span>
        <span className="shrink-0 text-sm font-bold text-forest-950 tabular">{formatMoney(invoice.final_amount)}</span>
        <ChevronDown className={cn('size-4 shrink-0 text-fg-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mb-3 rounded-xl bg-sunken px-4 py-3 text-[13px]">
          {invoice.session_seconds != null && (
            <>
              <p className="flex justify-between text-fg-2">
                <span>
                  Table time ({formatDuration(invoice.session_seconds)}
                  {invoice.rate_per_minute != null && ` @ ${formatRate(invoice.rate_per_minute)}`})
                  {invoice.standard_rate_per_minute != null && <span className="ml-1.5 text-xs font-semibold text-brass-700">custom rate</span>}
                </span>
                <span className="tabular">{formatMoney(invoice.base_amount)}</span>
              </p>
              {invoice.standard_rate_per_minute != null && invoice.standard_base_amount != null && (
                <p className="text-xs text-fg-4">
                  Standard {formatMoney(invoice.standard_base_amount)} at {formatRate(invoice.standard_rate_per_minute)}
                </p>
              )}
            </>
          )}
          {invoice.items.map((i) => (
            <p key={i.name} className="flex justify-between text-fg-2">
              <span>
                {i.name} × {i.quantity} <span className="text-fg-4">@ {formatMoney(i.unit_price)}</span>
              </span>
              <span className="tabular">{formatMoney(i.line_total)}</span>
            </p>
          ))}
          {invoice.discount > 0 && (
            <p className="flex justify-between text-brass-700">
              <span>Discount</span>
              <span className="tabular">−{formatMoney(invoice.discount)}</span>
            </p>
          )}
          {invoice.customer_phone && <p className="mt-1 text-xs text-fg-4">Phone {invoice.customer_phone}</p>}
        </div>
      )}
    </li>
  )
}
