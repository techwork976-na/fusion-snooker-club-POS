import { useQuery } from '@tanstack/react-query'
import { formatBusinessDate, formatHour, formatMoney } from '@shared/format'
import { toPaisa } from '@shared/billing'
import { cn } from '@/lib/cn'
import { getSalesByHour } from '@/data/api'
import { keys } from '@/data/hooks'
import { compactMoney, SERIES_COLORS, type BarDatum } from '@/components/charts/BarChart'
import { TrendChart } from '@/components/charts/TrendChart'
import { Skeleton } from '@/components/ui/Misc'
import { everyDay, hourRange, type TrendDay } from './salesTrendModel'

const TOTAL = [{ key: 'total', label: 'Sales', color: SERIES_COLORS.sales }]
const SPLIT = [
  { key: 'cash', label: 'Cash', color: SERIES_COLORS.cash },
  { key: 'bank', label: 'Bank transfer', color: SERIES_COLORS.bank }
]


/**
 * The sales curve of a period, the same smooth line for every date filter:
 * several days → one point per business day; a single day (Today, Yesterday,
 * one custom day) → one point per club hour, read from that day's invoices.
 * Hovering shows the total with its cash and bank parts.
 *
 * Hourly detail exists only while a day's invoices are kept (the daily ledger
 * is permanent, invoices are removed after the retention period). The hours
 * are compared with the day's permanent total before they are drawn, and any
 * shortfall is stated — partial detail is never shown as the whole day.
 */
export function SalesTrend({
  from,
  to,
  days,
  dayTotal,
  closedOnly,
  today,
  subject = 'Sales',
  className
}: {
  from: string
  to: string
  days: TrendDay[]
  /** The single day's permanent total from the same report (to check the hours against). */
  dayTotal: number
  /** Reports count closed counters only (final figures); History counts every counter. */
  closedOnly: boolean
  today?: string
  subject?: string
  className?: string
}) {
  const single = from === to
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label">{single ? `${subject} by hour` : `${subject} by day`}</span>
        <span className="text-xs text-fg-4">
          {single ? `${formatBusinessDate(from, { year: false })}, club time` : 'Hover a day'} · cash and bank in the tooltip
        </span>
      </div>
      {single ? (
        <HourlyTrend date={from} dayTotal={dayTotal} closedOnly={closedOnly} isToday={from === today} />
      ) : (
        <TrendChart
          className="mt-6"
          height={260}
          label={`${subject} by day`}
          series={TOTAL}
          tooltipSeries={SPLIT}
          data={everyDay(from, to, days).map<BarDatum>((d) => ({
            key: d.date,
            label: formatBusinessDate(d.date, { weekday: false, year: false }),
            title: formatBusinessDate(d.date),
            values: { total: d.cash + d.bank, cash: d.cash, bank: d.bank },
            note: d.note
          }))}
          formatValue={(v) => formatMoney(v)}
          formatAxis={compactMoney}
        />
      )}
    </div>
  )
}

function HourlyTrend({ date, dayTotal, closedOnly, isToday }: { date: string; dayTotal: number; closedOnly: boolean; isToday: boolean }) {
  const { data, isLoading, error } = useQuery({
    queryKey: keys.salesByHour(date, closedOnly),
    queryFn: () => getSalesByHour(date, closedOnly)
  })
  if (isLoading) return <Skeleton className="mt-6 h-[260px] rounded-2xl" />
  if (error || !data) return <p className="mt-6 flex h-[260px] items-center justify-center text-sm text-fg-4">The hour-by-hour detail could not be loaded.</p>

  const covered = toPaisa(data.covered_total)
  const total = toPaisa(dayTotal)
  const byHour = new Map(data.hours.map((h) => [h.hour, h]))
  const kept = `Invoices are kept for ${data.retention_days} day${data.retention_days === 1 ? '' : 's'}; the day's totals are permanent.`

  if (covered === 0 && total > 0) {
    return (
      <p className="mt-6 flex h-[260px] items-center justify-center px-6 text-center text-sm text-fg-4" data-testid="hourly-unavailable">
        Hour-by-hour detail is no longer available for this day. {kept}
      </p>
    )
  }
  return (
    <>
      <TrendChart
        className="mt-6"
        height={260}
        label="Sales by hour"
        series={TOTAL}
        tooltipSeries={SPLIT}
        emptyLabel={isToday ? 'No sales yet today' : 'No sales on this day'}
        data={hourRange(data, isToday).map<BarDatum>(({ hour: h, future }) => {
          const row = byHour.get(h)
          return {
            key: String(h),
            future,
            label: formatHour(h),
            title: `${formatHour(h, true)} – ${formatHour(h + 1, true)}`,
            values: { total: row?.total ?? 0, cash: row?.cash ?? 0, bank: row?.bank ?? 0 },
            note: row ? `${row.invoices} invoice${row.invoices === 1 ? '' : 's'}` : 'No invoices'
          }
        })}
        formatValue={(v) => formatMoney(v)}
        formatAxis={compactMoney}
      />
      {covered !== total && (
        <p className={cn('mt-3 text-xs text-fg-4')} data-testid="hourly-partial">
          These hours cover {formatMoney(covered / 100)} of the day's {formatMoney(total / 100)}. {kept}
        </p>
      )}
    </>
  )
}
