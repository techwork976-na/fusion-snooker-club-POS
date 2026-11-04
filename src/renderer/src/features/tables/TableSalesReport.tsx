import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Archive, LayoutGrid } from 'lucide-react'
import { formatBusinessDate, formatMoney } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { TableSalesReport as Report } from '@/lib/types'
import { getTableSales } from '@/data/api'
import { keys, useBusinessDate } from '@/data/hooks'
import { HorizontalBarChart, Legend, SERIES_COLORS, compactMoney } from '@/components/charts/BarChart'
import { AnimatedMoney } from '@/components/motion/AnimatedNumber'
import { EmptyState, ErrorState, LoadingBlock, Page, PageHeader } from '@/components/ui/Misc'
import { PeriodPicker, periodError, periodFor, periodLabel, type Period } from '@/features/reports/PeriodPicker'

const SERIES = [
  { key: 'cash', label: 'Cash', color: SERIES_COLORS.cash },
  { key: 'bank', label: 'Bank transfer', color: SERIES_COLORS.bank }
]

/**
 * Table Sales Report (admin): what each table took in a period — table time
 * plus snacks put on its tab, after discounts — from the paid invoices
 * themselves. Snack-only sales are not table sales. Invoices removed by the
 * retention policy are no longer counted.
 */
export function TableSalesReport({ tabs }: { tabs: ReactNode }) {
  const { data: today } = useBusinessDate()
  const [period, setPeriod] = useState<Period | null>(null)
  useEffect(() => {
    if (today && !period) setPeriod(periodFor('today', today))
  }, [today, period])
  const invalid = today && period ? periodError(period, today) : null
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: keys.tableSales(period?.from ?? '', period?.to ?? ''),
    queryFn: () => getTableSales(period!.from, period!.to),
    enabled: Boolean(period) && !invalid,
    placeholderData: (prev) => prev
  })
  return (
    <Page>
      <PageHeader title="Tables" subtitle="Table Sales Report — what each table took, from its paid invoices." actions={tabs}>
        {today && period && (
          <PeriodPicker value={period} onChange={setPeriod} today={today} layoutId="table-sales-period" labels={{ week: 'Weekly', month: 'Monthly' }} />
        )}
      </PageHeader>
      {invalid ? (
        <EmptyState title="Choose a valid period" description={invalid} />
      ) : error ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : isLoading || !data || !period ? (
        <LoadingBlock />
      ) : (
        <ReportBody data={data} period={period} stale={data.from !== period.from || data.to !== period.to} />
      )}
    </Page>
  )
}

function ReportBody({ data, period, stale }: { data: Report; period: Period; stale: boolean }) {
  const t = data.totals
  const played = data.tables.filter((r) => r.sessions > 0)
  const mayMissOld = period.from < data.retention_cutoff
  return (
    <div className={cn('space-y-6 transition-opacity duration-200', stale && 'opacity-60')}>
      <section className="card p-5 sm:p-8" data-testid="table-sales-totals">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <span className="label">Table sales · {periodLabel(period)}</span>
            <AnimatedMoney value={t.total} duration={0.8} className="mt-5 block figure-display text-[clamp(42px,12vw,48px)] leading-[0.92] text-forest-950 sm:text-[clamp(48px,4.8vw,66px)]" data-testid="table-sales-total" />
            <p className="mt-4 text-sm text-fg-3">
              {t.sessions} paid session{t.sessions === 1 ? '' : 's'} on {played.length} table{played.length === 1 ? '' : 's'}
              {t.snacks > 0 ? ` · includes ${formatMoney(t.snacks)} of snacks on tabs` : ''}
              {t.discounts > 0 ? ` · after ${formatMoney(t.discounts)} in discounts` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-4 sm:gap-10">
            <div>
              <p className="label">Cash</p>
              <p className="mt-2.5 figure-display text-[26px] leading-none text-fg" data-testid="table-sales-cash">
                {formatMoney(t.cash)}
              </p>
            </div>
            <div>
              <p className="label">Bank transfer</p>
              <p className="mt-2.5 figure-display text-[26px] leading-none text-fg" data-testid="table-sales-bank">
                {formatMoney(t.bank)}
              </p>
            </div>
          </div>
        </div>
        <p className={cn('mt-7 flex items-start gap-2 rounded-2xl px-4 py-3 text-xs', mayMissOld ? 'bg-brass-50 text-brass-800' : 'bg-sunken/70 text-fg-3')}>
          <Archive className="mt-0.5 size-3.5 shrink-0" />
          Invoices are kept for {data.retention_days} day{data.retention_days === 1 ? '' : 's'} after their counter closes (Settings → Data retention); older
          table sales are removed with them and are not counted here.
          {mayMissOld ? ` Sales before ${formatBusinessDate(data.retention_cutoff)} may already be removed.` : ''} Snacks sold without a table are not table sales.
        </p>
      </section>

      {played.length === 0 ? (
        <section className="card">
          <EmptyState icon={<LayoutGrid className="size-5" />} title="No paid table sessions in this period" />
        </section>
      ) : (
        <section className="card p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="label">By table</span>
            <Legend series={SERIES} />
          </div>
          <HorizontalBarChart
            className="mt-5"
            series={SERIES}
            data={played.map((r) => ({
              key: r.table_id,
              label: r.name.length > 14 ? `${r.name.slice(0, 13)}…` : r.name,
              title: r.name,
              values: { cash: r.cash, bank: r.bank },
              note: `${r.sessions} session${r.sessions === 1 ? '' : 's'}${r.snacks > 0 ? ` · snacks on tab ${formatMoney(r.snacks)}` : ''}`
            }))}
            formatValue={(v) => formatMoney(v)}
            formatAxis={compactMoney}
          />
        </section>
      )}

      <section className="card overflow-hidden pt-3 pb-2" data-testid="table-sales-list">
        <div className="overflow-x-auto">
          <table className="table-stack w-full min-w-[760px] text-sm">
            <thead>
              <tr className="thead-row">
                <th className="px-8 py-3.5">Table</th>
                <th className="px-4 py-3.5 text-right">Sessions</th>
                <th className="px-4 py-3.5 text-right">Cash</th>
                <th className="px-4 py-3.5 text-right">Bank transfer</th>
                <th className="px-4 py-3.5 text-right">Snacks on tab</th>
                <th className="px-8 py-3.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.tables.map((r) => (
                <tr key={r.table_id} className={cn(r.sessions === 0 && 'text-fg-4')} data-testid={`table-sales-row-${r.name}`}>
                  <td className="px-8 py-3.5" data-stack="title">
                    <span className={cn('font-semibold', r.sessions === 0 ? 'text-fg-4' : 'text-fg')}>{r.name}</span>
                    <span className="ml-2 text-xs text-fg-4">
                      {r.category_name} · {r.floor_name}
                      {r.active ? '' : ' · removed'}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-right tabular" data-label="Sessions">{r.sessions}</td>
                  <td className="px-4 py-3.5 text-right tabular" data-label="Cash">{formatMoney(r.cash)}</td>
                  <td className="px-4 py-3.5 text-right tabular" data-label="Bank transfer">{formatMoney(r.bank)}</td>
                  <td className="px-4 py-3.5 text-right tabular" data-label="Snacks on tab">{formatMoney(r.snacks)}</td>
                  <td className={cn('px-8 py-3.5 text-right font-bold tabular', r.sessions > 0 && 'text-fg')} data-label="Total">{formatMoney(r.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-line-strong/70">
              <tr className="font-bold text-fg">
                <td className="px-8 py-3.5" data-stack="title">Total</td>
                <td className="px-4 py-3.5 text-right tabular" data-label="Sessions">{t.sessions}</td>
                <td className="px-4 py-3.5 text-right tabular" data-label="Cash">{formatMoney(t.cash)}</td>
                <td className="px-4 py-3.5 text-right tabular" data-label="Bank transfer">{formatMoney(t.bank)}</td>
                <td className="px-4 py-3.5 text-right tabular" data-label="Snacks on tab">{formatMoney(t.snacks)}</td>
                <td className="px-8 py-3.5 text-right tabular" data-label="Total">{formatMoney(t.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </div>
  )
}
