import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Archive, CircleDot, FileDown, Users } from 'lucide-react'
import { addDays, daysBetween, formatBusinessDate, formatMoney } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { FinancialReport, ReportShift } from '@/lib/types'
import { getFinancialReport } from '@/data/api'
import { keys, useBusinessDate } from '@/data/hooks'
import { SERIES_COLORS } from '@/components/charts/BarChart'
import { AnimatedMoney } from '@/components/motion/AnimatedNumber'
import { Button } from '@/components/ui/Button'
import { Delta, EmptyState, ErrorState, LoadingBlock, Page, PageHeader } from '@/components/ui/Misc'
import { useToast } from '@/components/ui/Toast'
import { ShiftDetailDrawer } from '@/features/shifts/ShiftParts'
import { PeriodPicker, periodError, periodFor, type Period } from './PeriodPicker'
import { buildReportDocument, shiftWhen } from './reportModel'
import { exportReportPdf } from './reportPdf'
import { SalesTrend } from './SalesTrend'


/** The same number of business days immediately before a period — what its total is compared with. */
function previousOf(from: string, to: string) {
  const days = daysBetween(from, to) + 1
  return { from: addDays(from, -days), to: addDays(from, -1), days }
}

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
  // The total of the equal stretch just before, for the change arrow (closed shifts both sides).
  const prev = period && !invalid ? previousOf(period.from, period.to) : null
  const { data: prevData } = useQuery({
    queryKey: keys.financialReport(prev?.from ?? '', prev?.to ?? ''),
    queryFn: () => getFinancialReport(prev!.from, prev!.to),
    enabled: Boolean(prev),
    retry: false
  })
  const toast = useToast()
  const [exporting, setExporting] = useState(false)
  const current = data && period && data.from === period.from && data.to === period.to ? data : null
  const comparison =
    current && prev && prevData && prevData.from === prev.from && prevData.to === prev.to && prevData.final.total > 0
      ? {
          change: (current.final.total - prevData.final.total) / prevData.final.total,
          against: prev.days === 1 ? `vs ${formatBusinessDate(prev.from, { year: false })}` : `vs previous ${prev.days} days`
        }
      : null

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
        eyebrow="Financial statement"
        title="Reports"
        subtitle="The result of a period, ready to export: final sales from closed counters, every expense (counter and business) and the profit after them. Counters still open are shown apart until they close."
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
        <ReportBody data={data} stale={!current} comparison={comparison} today={today} />
      )}
    </Page>
  )
}

function Figure({ label, value, strong, hint, testId, swatch }: { label: string; value: number; strong?: boolean; hint?: string[] | string; testId?: string; swatch?: string }) {
  return (
    <div data-testid={testId}>
      <p className="label flex items-center gap-2">
        {swatch && <span className="h-[3px] w-3 rounded-full" style={{ background: swatch }} />}
        {label}
      </p>
      <p className={cn('mt-3 figure-display leading-none', strong ? 'text-[28px] text-forest-950' : 'text-[24px] text-fg')}>{formatMoney(value)}</p>
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

function ReportBody({
  data,
  stale,
  comparison,
  today
}: {
  data: FinancialReport
  stale: boolean
  comparison: { change: number; against: string } | null
  today?: string
}) {
  const f = data.final
  const [detail, setDetail] = useState<string | null>(null)
  const empty = f.shifts === 0 && f.legacy === 0 && f.business_expenses === 0 && data.open_shifts.length === 0
  return (
    <div className={cn('space-y-6 transition-opacity duration-200', stale && 'opacity-60')}>
      <section className="card p-5 sm:p-8" data-testid="report-totals">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <span className="label">Total sales</span>
            <AnimatedMoney
              value={f.total}
              duration={0.8}
              className="mt-5 block figure-display text-[clamp(42px,12vw,50px)] leading-[0.9] text-forest-950 sm:text-[clamp(50px,5vw,72px)]"
              data-testid="report-total"
            />
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-fg-3">
              {comparison && <Delta change={comparison.change} against={comparison.against} />}
              <span>
                {f.shifts} closed shift{f.shifts === 1 ? '' : 's'} · {f.invoices} invoice{f.invoices === 1 ? '' : 's'}
                {f.voided > 0 ? ` · ${f.voided} voided` : ''}
              </span>
            </div>
          </div>
          <div className="sm:text-right">
            <p className="label">Net after expenses</p>
            <p className={cn('mt-3 figure-display text-[30px] leading-none sm:text-[38px]', f.net < 0 ? 'text-claret-700' : 'text-baize-700')} data-testid="report-net">
              {formatMoney(f.net)}
            </p>
          </div>
        </div>
        <div className="mt-8 grid grid-cols-2 gap-y-6 border-t border-line pt-7 sm:mt-10 md:grid-cols-3 xl:grid-cols-5 [&>*]:border-l [&>*]:border-line [&>*]:pl-5">
          <Figure label="Cash" value={f.cash} testId="report-cash" swatch={SERIES_COLORS.cash} />
          <Figure label="Bank transfer" value={f.bank} testId="report-bank" swatch={SERIES_COLORS.bank} />
          <Figure label="Snack sales" value={f.snack} hint="Part of total sales" testId="report-snack" />
          <Figure label="Discounts" value={f.discounts} />
          <Figure
            label="Expenses"
            value={f.expenses}
            hint={[`Counter ${formatMoney(f.counter_expenses)}`, `Business ${formatMoney(f.business_expenses)}`]}
            testId="report-expenses"
          />
        </div>
        <p className="mt-7 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-4 text-xs text-fg-4" data-testid="report-scope">
          Final figures: closed counters only. Expenses include business expenses.
          <Link to="/history" className="font-semibold text-brass-700 underline-offset-4 hover:underline">
            Day-by-day records, shifts and invoices: History →
          </Link>
        </p>
        {f.legacy > 0 && (
          <p className="mt-4 flex max-w-xl items-start gap-2 rounded-2xl bg-sunken/70 px-4 py-3 text-xs text-fg-3">
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
              <SalesTrend
                from={data.from}
                to={data.to}
                today={today}
                closedOnly
                subject="Final sales"
                dayTotal={f.total}
                days={data.days.map((d) => ({ date: d.date, cash: d.cash, bank: d.bank, note: `Expenses ${formatMoney(d.expenses)} · net ${formatMoney(d.net)}` }))}
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
                        <span className="figure-display text-[21px] text-forest-950">{formatMoney(s.total)}</span>
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
              <span className="label">Closed shifts in this statement</span>
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
          <p className="mt-3 figure-display text-[32px] leading-none text-fg" data-testid="report-live-total">
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
