import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Archive, CalendarRange, Users } from 'lucide-react'
import { addDays, formatBusinessDate, formatMoney, startOfMonth } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { HistoryDay, HistoryReport, Shift } from '@/lib/types'
import { getHistory } from '@/data/api'
import { keys, useBusinessDate, useSettings } from '@/data/hooks'
import { BarChart, compactMoney, HorizontalBarChart, Legend, SERIES_COLORS } from '@/components/charts/BarChart'
import { AnimatedMoney } from '@/components/motion/AnimatedNumber'
import { inputClass } from '@/components/ui/Field'
import { EmptyState, ErrorState, LoadingBlock, Page, PageHeader, Segmented } from '@/components/ui/Misc'
import { TransactionsPanel } from '@/features/sales/TransactionsPanel'
import { ShiftDetailDrawer, ShiftFigures, ShiftStatusPill, shiftTimes } from '@/features/shifts/ShiftParts'
import { CloseDayPanel } from './CloseDayPanel'

type Tab = 'overview' | 'shifts' | 'invoices' | 'close'
type Preset = 'today' | 'weekly' | 'monthly' | 'custom'
interface Range {
  preset: Preset
  from: string
  to: string
}

/** Weekly = the last 7 business days; Monthly = this calendar month so far. */
function presetRange(preset: Exclude<Preset, 'custom'>, today: string): Range {
  if (preset === 'today') return { preset, from: today, to: today }
  if (preset === 'weekly') return { preset, from: addDays(today, -6), to: today }
  return { preset, from: startOfMonth(today), to: today }
}

const SERIES = [
  { key: 'cash', label: 'Cash', color: SERIES_COLORS.cash },
  { key: 'bank', label: 'Bank transfer', color: SERIES_COLORS.bank }
]

export function HistoryPage() {
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab') as Tab | null
  const tab: Tab = requested && ['overview', 'shifts', 'invoices', 'close'].includes(requested) ? requested : 'overview'
  const { data: today } = useBusinessDate()
  const [range, setRange] = useState<Range | null>(null)
  useEffect(() => {
    if (today && !range) setRange(presetRange('today', today))
  }, [today, range])

  return (
    <Page>
      <PageHeader
        title="History"
        subtitle="Permanent business and staff accounting. Totals stay correct after old invoices are removed."
        actions={
          <Segmented
            layoutId="history-tab"
            value={tab}
            onChange={(t) => setParams(t === 'overview' ? {} : { tab: t })}
            options={[
              { value: 'overview', label: 'Overview' },
              { value: 'shifts', label: 'Shifts' },
              { value: 'invoices', label: 'Invoices' },
              { value: 'close', label: 'Close day' }
            ]}
          />
        }
      >
        {tab !== 'close' && today && range && <RangePicker value={range} onChange={setRange} today={today} />}
      </PageHeader>
      {!today || !range ? (
        <LoadingBlock />
      ) : tab === 'close' ? (
        <CloseDayPanel />
      ) : tab === 'invoices' ? (
        <TransactionsPanel range={{ preset: 'custom', from: range.from, to: range.to }} onRange={() => undefined} today={today} hideRange />
      ) : (
        <HistoryBody range={range} tab={tab} />
      )}
    </Page>
  )
}

function RangePicker({ value, onChange, today }: { value: Range; onChange: (r: Range) => void; today: string }) {
  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center gap-3" data-testid="history-range">
      <Segmented
        layoutId="history-range"
        value={value.preset}
        onChange={(p) => onChange(p === 'custom' ? { ...value, preset: 'custom' } : presetRange(p, today))}
        options={[
          { value: 'today', label: 'Today' },
          { value: 'weekly', label: 'Weekly' },
          { value: 'monthly', label: 'Monthly' },
          { value: 'custom', label: 'Custom' }
        ]}
      />
      {value.preset === 'custom' ? (
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <input
            type="date"
            aria-label="From"
            className={cn(inputClass, 'h-10 min-w-0 flex-1 sm:w-[150px] sm:flex-none')}
            value={value.from}
            max={value.to}
            onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })}
          />
          <span className="text-fg-4">–</span>
          <input
            type="date"
            aria-label="To"
            className={cn(inputClass, 'h-10 min-w-0 flex-1 sm:w-[150px] sm:flex-none')}
            value={value.to}
            min={value.from}
            max={today}
            onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })}
          />
        </div>
      ) : (
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-fg-3">
          <CalendarRange className="size-4 text-fg-4" />
          {formatBusinessDate(value.from)}
          {value.from !== value.to ? ` – ${formatBusinessDate(value.to)}` : ''}
        </span>
      )}
    </div>
  )
}

function HistoryBody({ range, tab }: { range: Range; tab: 'overview' | 'shifts' }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: keys.history(range.from, range.to),
    queryFn: () => getHistory(range.from, range.to)
  })
  const [detail, setDetail] = useState<string | null>(null)
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
  if (isLoading || !data) return <LoadingBlock />
  return (
    <>
      {tab === 'overview' ? <Overview data={data} range={range} onShift={setDetail} /> : <ShiftsTable shifts={data.shifts} onOpen={setDetail} />}
      <ShiftDetailDrawer shiftId={detail} onClose={() => setDetail(null)} />
    </>
  )
}

function Overview({ data, range, onShift }: { data: HistoryReport; range: Range; onShift: (id: string) => void }) {
  const t = data.totals
  return (
    <div className="space-y-6">
      <section className="card p-5 sm:p-8" data-testid="history-totals">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="label">Total sales</span>
            <AnimatedMoney
              value={t.total}
              duration={0.9}
              className="mt-5 block figure text-[clamp(38px,11vw,50px)] leading-[0.92] text-forest-950 sm:text-[clamp(50px,5.2vw,70px)]"
              data-testid="history-total"
            />
            <p className="mt-4 text-sm text-fg-3">
              {t.invoices} invoice{t.invoices === 1 ? '' : 's'}
              {t.discounts > 0 ? ` · ${formatMoney(t.discounts)} in discounts` : ''}
              {t.voided > 0 ? ` · ${t.voided} voided` : ''}
            </p>
          </div>
          {t.legacy > 0 && (
            <p className="flex max-w-sm items-start gap-2 rounded-2xl bg-sunken/70 px-4 py-3 text-xs text-fg-3">
              <Archive className="mt-0.5 size-3.5 shrink-0 text-brass-600" />
              Includes {formatMoney(t.legacy)} archived before staff accounting existed (no staff breakdown for that amount).
            </p>
          )}
        </div>
        <ShiftFigures figures={t} size="lg" className="mt-8 sm:mt-10" />
      </section>

      <div className="grid grid-cols-12 gap-6">
        <section className="card col-span-12 p-5 sm:p-7 xl:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="label">Daily sales</span>
            <Legend series={SERIES} />
          </div>
          <BarChart
            className="mt-6"
            height={260}
            series={SERIES}
            data={chartDays(range, data.days).map((d) => ({
              key: d.date,
              label: formatBusinessDate(d.date, { weekday: false, year: false }),
              title: formatBusinessDate(d.date),
              values: { cash: d.cash, bank: d.bank },
              note: `${d.invoices} invoices · expenses ${formatMoney(d.expenses)} · net ${formatMoney(d.net)}`
            }))}
            formatValue={(v) => formatMoney(v)}
            formatAxis={compactMoney}
          />
        </section>
        <section className="card col-span-12 p-5 sm:p-7 xl:col-span-5">
          <span className="label">Staff in this period</span>
          {data.by_staff.length === 0 ? (
            <EmptyState className="py-8" icon={<Users className="size-5" />} title="No staff activity" />
          ) : (
            <>
              <HorizontalBarChart
                className="mt-5"
                series={SERIES}
                data={data.by_staff.slice(0, 8).map((s) => ({
                  key: s.user_id,
                  label: s.name.length > 14 ? `${s.name.slice(0, 13)}…` : s.name,
                  title: s.name,
                  values: { cash: s.cash, bank: s.bank },
                  note: `Expenses ${formatMoney(s.expenses)} · net ${formatMoney(s.net)} · ${s.invoices} invoice${s.invoices === 1 ? '' : 's'}`
                }))}
                formatValue={(v) => formatMoney(v)}
                formatAxis={compactMoney}
              />
              <ul className="mt-5 divide-y divide-line" data-testid="history-staff">
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
            </>
          )}
        </section>
      </div>

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 pt-6 pb-4 sm:px-8 sm:pt-7">
          <span className="label">Shifts in this period</span>
          <span className="text-xs text-fg-4">Select a shift for its invoices and expenses</span>
        </div>
        <ShiftRows shifts={data.shifts.slice(0, 8)} onOpen={onShift} compact />
      </section>

      <section className="card overflow-hidden pt-3 pb-2">
        <table className="table-stack w-full text-sm">
          <thead>
            <tr className="thead-row">
              <th className="px-8 py-3.5">Business day</th>
              <th className="px-4 py-3.5 text-right">Cash</th>
              <th className="px-4 py-3.5 text-right">Bank</th>
              <th className="px-4 py-3.5 text-right">Total</th>
              <th className="px-4 py-3.5 text-right">Expenses</th>
              <th className="px-4 py-3.5 text-right">Net</th>
              <th className="px-4 py-3.5 text-right">Invoices</th>
              <th className="px-8 py-3.5">Day</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.days.length === 0 && (
              <tr>
                <td colSpan={8} className="px-6 py-8 text-center text-fg-4" data-stack="full">
                  No activity in this period.
                </td>
              </tr>
            )}
            {[...data.days].reverse().map((d) => (
              <tr key={d.date}>
                <td className="px-8 py-3.5 font-semibold text-fg" data-stack="top">{formatBusinessDate(d.date)}</td>
                <td className="px-4 py-3.5 text-right text-fg-2 tabular" data-label="Cash">{formatMoney(d.cash)}</td>
                <td className="px-4 py-3.5 text-right text-fg-2 tabular" data-label="Bank">{formatMoney(d.bank)}</td>
                <td className="px-4 py-3.5 text-right font-bold text-fg tabular" data-label="Total">{formatMoney(d.total)}</td>
                <td className="px-4 py-3.5 text-right text-fg-3 tabular" data-label="Expenses">{formatMoney(d.expenses)}</td>
                <td className="px-4 py-3.5 text-right font-semibold text-fg tabular" data-label="Net">{formatMoney(d.net)}</td>
                <td className="px-4 py-3.5 text-right text-fg-3 tabular" data-label="Invoices">{d.invoices}</td>
                <td className="px-8 py-3.5 text-xs" data-stack="top end">
                  {d.closed ? <span className="font-semibold text-sage-700">Closed</span> : <span className="text-fg-4">Not closed</span>}
                  {d.legacy > 0 && <span className="ml-2 text-fg-4">incl. archived</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}

function ShiftsTable({ shifts, onOpen }: { shifts: Shift[]; onOpen: (id: string) => void }) {
  return (
    <section className="card overflow-hidden py-2">
      {shifts.length === 0 ? (
        <EmptyState icon={<Users className="size-5" />} title="No shifts in this period" />
      ) : (
        <ShiftRows shifts={shifts} onOpen={onOpen} />
      )}
    </section>
  )
}

/** Staff-wise shift history; each row opens the shift's detail. */
function ShiftRows({ shifts, onOpen, compact }: { shifts: Shift[]; onOpen: (id: string) => void; compact?: boolean }) {
  const { data: settings } = useSettings()
  const tz = settings?.business_timezone
  if (shifts.length === 0) return <p className="px-5 pb-6 text-sm text-fg-4 sm:px-8">No shifts in this period.</p>
  return (
    <table className="table-stack w-full text-sm" data-testid="shift-table">
      <thead>
        <tr className="thead-row">
          <th className="px-8 py-3.5">Staff</th>
          <th className="px-4 py-3.5">Opened → closed</th>
          <th className="px-4 py-3.5">Status</th>
          <th className="px-4 py-3.5 text-right">Cash</th>
          <th className="px-4 py-3.5 text-right">Bank</th>
          {!compact && <th className="px-4 py-3.5 text-right">Snacks</th>}
          <th className="px-4 py-3.5 text-right">Total</th>
          <th className="px-4 py-3.5 text-right">Expenses</th>
          <th className="px-8 py-3.5 text-right">Net</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {shifts.map((s) => (
          <tr key={s.id} onClick={() => onOpen(s.id)} className="cursor-pointer transition-colors hover:bg-canvas/60">
            <td className="px-8 py-3.5" data-stack="top">
              <span className="block font-semibold text-fg">{s.staff_name}</span>
              <span className="block text-xs text-fg-4">
                {s.invoices} invoice{s.invoices === 1 ? '' : 's'}
                {s.imported ? ' · imported' : ''}
                {s.details_purged_at ? ' · invoices expired' : ''}
              </span>
            </td>
            <td className="px-4 py-3.5 text-fg-2 tabular" data-stack="full">{shiftTimes(s, tz)}</td>
            <td className="px-4 py-3.5" data-stack="top end">
              <ShiftStatusPill status={s.status} />
            </td>
            <td className="px-4 py-3.5 text-right text-fg-2 tabular" data-label="Cash">{formatMoney(s.cash)}</td>
            <td className="px-4 py-3.5 text-right text-fg-2 tabular" data-label="Bank">{formatMoney(s.bank)}</td>
            {!compact && <td className="px-4 py-3.5 text-right text-fg-3 tabular" data-label="Snacks">{formatMoney(s.snack)}</td>}
            <td className="px-4 py-3.5 text-right font-bold text-fg tabular" data-label="Total">{formatMoney(s.total)}</td>
            <td className="px-4 py-3.5 text-right text-fg-3 tabular" data-label="Expenses">{formatMoney(s.expenses)}</td>
            <td className="px-8 py-3.5 text-right font-semibold text-forest-950 tabular" data-label="Net">{formatMoney(s.net)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Every date in short ranges (zero days included) so gaps are visible. */
function chartDays(range: Range, days: HistoryDay[]): HistoryDay[] {
  const span = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1
  if (span > 62) return days
  const byDate = new Map(days.map((d) => [d.date, d]))
  return Array.from({ length: span }, (_, i) => {
    const date = addDays(range.from, i)
    return (
      byDate.get(date) ?? { date, cash: 0, bank: 0, total: 0, snack: 0, discounts: 0, expenses: 0, net: 0, invoices: 0, voided: 0, legacy: 0, closed: false }
    )
  })
}
