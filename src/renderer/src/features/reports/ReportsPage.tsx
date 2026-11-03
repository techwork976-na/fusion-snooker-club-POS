import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Archive, CircleDot, FileDown, Users } from 'lucide-react'
import { formatBusinessDate, formatMoney } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { FinancialReport, ReportShift } from '@/lib/types'
import { getFinancialReport } from '@/data/api'
import { keys, useBusinessDate } from '@/data/hooks'
import { BarChart, compactMoney, Legend, SERIES_COLORS } from '@/components/charts/BarChart'
import { AnimatedMoney } from '@/components/motion/AnimatedNumber'
import { Button } from '@/components/ui/Button'
import { EmptyState, ErrorState, LoadingBlock, Page, PageHeader } from '@/components/ui/Misc'
import { useToast } from '@/components/ui/Toast'
import { ShiftDetailDrawer } from '@/features/shifts/ShiftParts'
import { PeriodPicker, periodError, periodFor, type Period } from './PeriodPicker'
import { buildReportDocument, shiftWhen } from './reportModel'
import { exportReportPdf } from './reportPdf'

const SERIES = [
  { key: 'cash', label: 'Cash', color: SERIES_COLORS.cash },
  { key: 'bank', label: 'Bank transfer', color: SERIES_COLORS.bank }
]

export function ReportsPage() {
  const { data: today } = useBusinessDate()
  const [period, setPeriod] = useState<Period | null>(null)
  useEffect(() => {
    if (today && !period) setPeriod(periodFor('today', today))
  }, [today, period])
  const invalid = today && period ? periodError(period, today) : null
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: keys.financialReport(period?.from ?? '', period?.to ?? ''),
    queryFn: () => getFinancialReport(period!.from, period!.to),
    enabled: Boolean(period) && !invalid,
    placeholderData: (prev) => prev
  })
  const toast = useToast()
  const [exporting, setExporting] = useState(false)
  const current = data && period && data.from === period.from && data.to === period.to ? data : null

  const exportPdf = async () => {
    if (!current) return
    setExporting(true)
    try {
      await exportReportPdf(buildReportDocument(current))
      toast.success('Report exported as PDF.')
    } catch (e) {
      toast.error(`Could not create the PDF: ${errorMessage(e)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <Page>
      <PageHeader
        title="Reports"
        subtitle="Financial summary for a period. Final figures come from closed counters; open counters are shown separately."
        actions={
          <Button variant="primary" icon={<FileDown className="size-4" />} onClick={exportPdf} loading={exporting} disabled={!current || isFetching} data-testid="export-pdf">
            Export PDF
          </Button>
        }
      >
        {today && period && <PeriodPicker value={period} onChange={setPeriod} today={today} layoutId="report-period" />}
      </PageHeader>
      {invalid ? (
        <EmptyState title="Choose a valid period" description={invalid} />
      ) : error ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <LoadingBlock />
      ) : (
        <ReportBody data={data} stale={!current} />
      )}
    </Page>
  )
}

function Figure({ label, value, strong, hint, testId }: { label: string; value: number; strong?: boolean; hint?: string[] | string; testId?: string }) {
  return (
    <div data-testid={testId}>
      <p className="label">{label}</p>
      <p className={cn('mt-2.5 figure leading-none', strong ? 'text-[26px] text-forest-950' : 'text-[22px] text-fg')}>{formatMoney(value)}</p>
      {hint && (
        <div className="mt-1.5 space-y-0.5 text-xs whitespace-nowrap text-fg-4">
          {[hint].flat().map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </div>
  )
}

function ReportBody({ data, stale }: { data: FinancialReport; stale: boolean }) {
  const f = data.final
  const [detail, setDetail] = useState<string | null>(null)
  const empty = f.shifts === 0 && f.legacy === 0 && f.business_expenses === 0 && data.open_shifts.length === 0
  return (
    <div className={cn('space-y-6 transition-opacity duration-200', stale && 'opacity-60')}>
      <section className="card p-5 sm:p-8" data-testid="report-totals">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <span className="label">Total sales</span>
            <AnimatedMoney value={f.total} duration={0.8} className="mt-5 block figure text-[clamp(38px,11vw,46px)] leading-[0.92] text-forest-950 sm:text-[clamp(46px,5vw,64px)]" data-testid="report-total" />
            <p className="mt-4 text-sm text-fg-3">
              {f.shifts} closed shift{f.shifts === 1 ? '' : 's'} · {f.invoices} invoice{f.invoices === 1 ? '' : 's'}
              {f.voided > 0 ? ` · ${f.voided} voided` : ''}
            </p>
          </div>
          <div className="sm:text-right">
            <p className="label">Net after expenses</p>
            <p className={cn('mt-2.5 figure text-[28px] leading-none sm:text-[34px]', f.net < 0 ? 'text-claret-700' : 'text-forest-800')} data-testid="report-net">
              {formatMoney(f.net)}
            </p>
          </div>
        </div>
        <div className="mt-8 grid grid-cols-2 gap-x-5 gap-y-6 sm:mt-10 sm:gap-x-8 sm:gap-y-7 md:grid-cols-3 xl:grid-cols-5">
          <Figure label="Cash" value={f.cash} testId="report-cash" />
          <Figure label="Bank transfer" value={f.bank} testId="report-bank" />
          <Figure label="Snack sales" value={f.snack} hint="Part of total sales" testId="report-snack" />
          <Figure label="Discounts" value={f.discounts} />
          <Figure
            label="Expenses"
            value={f.expenses}
            hint={[`Counter ${formatMoney(f.counter_expenses)}`, `Business ${formatMoney(f.business_expenses)}`]}
            testId="report-expenses"
          />
        </div>
        {f.legacy > 0 && (
          <p className="mt-7 flex max-w-xl items-start gap-2 rounded-2xl bg-sunken/70 px-4 py-3 text-xs text-fg-3">
            <Archive className="mt-0.5 size-3.5 shrink-0 text-brass-600" />
            Includes {formatMoney(f.legacy)} archived before staff accounting existed (no staff breakdown for that amount).
          </p>
        )}
      </section>

      {data.open_shifts.length > 0 && <LiveSection data={data} onOpen={setDetail} />}

      {empty ? (
        <section className="card">
          <EmptyState icon={<Users className="size-5" />} title="No closed shifts in this period" description="Figures appear here once a counter is closed." />
        </section>
      ) : (
        <>
          <div className="grid grid-cols-12 gap-6">
            <section className="card col-span-12 p-5 sm:p-7 xl:col-span-7">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="label">Sales by day</span>
                <Legend series={SERIES} />
              </div>
              <BarChart
                className="mt-6"
                height={250}
                series={SERIES}
                data={data.days.map((d) => ({
                  key: d.date,
                  label: formatBusinessDate(d.date, { weekday: false, year: false }),
                  title: formatBusinessDate(d.date),
                  values: { cash: d.cash, bank: d.bank },
                  note: `Expenses ${formatMoney(d.expenses)} · net ${formatMoney(d.net)}`
                }))}
                formatValue={(v) => formatMoney(v)}
                formatAxis={compactMoney}
              />
            </section>
            <section className="card col-span-12 p-5 sm:p-7 xl:col-span-5" data-testid="report-staff">
              <span className="label">Staff (closed shifts)</span>
              {data.by_staff.length === 0 ? (
                <EmptyState className="py-8" icon={<Users className="size-5" />} title="No closed shifts" />
              ) : (
                <ul className="mt-4 divide-y divide-line">
                  {data.by_staff.map((s) => (
                    <li key={s.user_id} className="py-3.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-sm font-bold text-fg">{s.name}</span>
                        <span className="figure text-[19px] text-forest-950">{formatMoney(s.total)}</span>
                      </div>
                      <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-fg-4 tabular">
                        <span>Cash {formatMoney(s.cash)}</span>
                        <span>Bank {formatMoney(s.bank)}</span>
                        <span>Snacks {formatMoney(s.snack)}</span>
                        <span>Expenses {formatMoney(s.expenses)}</span>
                        <span className="font-semibold text-fg-2">Net {formatMoney(s.net)}</span>
                        <span>
                          {s.shifts} shift{s.shifts === 1 ? '' : 's'} · {s.invoices} invoice{s.invoices === 1 ? '' : 's'}
                        </span>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="card overflow-hidden" data-testid="report-shifts">
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-6 pb-3 sm:px-8 sm:pt-7">
              <span className="label">Closed shifts</span>
              <span className="text-xs text-fg-4">Select a shift to see its invoices and expenses</span>
            </div>
            <ShiftTable shifts={data.closed_shifts} timeZone={data.timezone} onOpen={setDetail} />
            {data.closed_shifts.some((s) => s.partial) && (
              <p className="px-5 pb-5 text-xs text-fg-4 sm:px-8">* This shift also traded outside the period; only its figures within the period are shown.</p>
            )}
          </section>
        </>
      )}
      <ShiftDetailDrawer shiftId={detail} onClose={() => setDetail(null)} />
    </div>
  )
}

function LiveSection({ data, onOpen }: { data: FinancialReport; onOpen: (id: string) => void }) {
  const l = data.live
  return (
    <section className="card overflow-hidden bg-brass-50/60" data-testid="report-live">
      <div className="flex flex-wrap items-end justify-between gap-6 px-5 pt-6 sm:px-8 sm:pt-7">
        <div>
          <p className="label flex items-center gap-2 !text-brass-800">
            <CircleDot className="size-3.5" /> Open counters · live, not final
          </p>
          <p className="mt-3 figure text-[30px] leading-none text-fg" data-testid="report-live-total">
            {formatMoney(l.total)}
          </p>
          <p className="mt-2 text-xs text-fg-3">
            {l.shifts} counter{l.shifts === 1 ? '' : 's'} still open · {l.invoices} invoice{l.invoices === 1 ? '' : 's'} so far. These figures change until each counter is closed and are not included above.
          </p>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-4 sm:gap-8 sm:text-right">
          <Figure label="Cash" value={l.cash} />
          <Figure label="Bank" value={l.bank} />
          <Figure label="Expenses" value={l.expenses} />
        </div>
      </div>
      <div className="mt-4">
        <ShiftTable shifts={data.open_shifts} timeZone={data.timezone} onOpen={onOpen} />
      </div>
    </section>
  )
}

function ShiftTable({ shifts, timeZone, onOpen }: { shifts: ReportShift[]; timeZone: string; onOpen: (id: string) => void }) {
  if (shifts.length === 0) return <p className="px-5 pb-6 text-sm text-fg-4 sm:px-8">No shifts in this period.</p>
  return (
    <div className="overflow-x-auto">
      <table className="table-stack w-full min-w-[860px] text-sm">
        <thead>
          <tr className="thead-row">
            <th className="px-8 py-3">Staff</th>
            <th className="px-4 py-3">Shift</th>
            <th className="px-4 py-3 text-right">Cash</th>
            <th className="px-4 py-3 text-right">Bank</th>
            <th className="px-4 py-3 text-right">Total</th>
            <th className="px-4 py-3 text-right">Snacks</th>
            <th className="px-4 py-3 text-right">Expenses</th>
            <th className="px-4 py-3 text-right">Net</th>
            <th className="px-8 py-3 text-right">Invoices</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {shifts.map((s) => (
            <tr key={s.id} className="cursor-pointer transition-colors hover:bg-canvas/60" onClick={() => onOpen(s.id)} data-testid={`report-shift-${s.id}`}>
              <td className="px-8 py-3.5 font-semibold text-fg" data-stack="top">{s.staff_name}</td>
              <td className="px-4 py-3.5 text-fg-3" data-stack="full">
                {shiftWhen(s, timeZone)}
                {s.partial && ' *'}
              </td>
              <td className="px-4 py-3.5 text-right text-fg-2 tabular" data-label="Cash">{formatMoney(s.cash)}</td>
              <td className="px-4 py-3.5 text-right text-fg-2 tabular" data-label="Bank">{formatMoney(s.bank)}</td>
              <td className="px-4 py-3.5 text-right font-bold text-fg tabular" data-label="Total">{formatMoney(s.total)}</td>
              <td className="px-4 py-3.5 text-right text-fg-3 tabular" data-label="Snacks">{formatMoney(s.snack)}</td>
              <td className="px-4 py-3.5 text-right text-fg-3 tabular" data-label="Expenses">{formatMoney(s.expenses)}</td>
              <td className="px-4 py-3.5 text-right font-semibold text-fg tabular" data-label="Net">{formatMoney(s.net)}</td>
              <td className="px-8 py-3.5 text-right text-fg-3 tabular" data-label="Invoices">{s.invoices}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
