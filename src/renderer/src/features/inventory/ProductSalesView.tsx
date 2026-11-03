import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Info, PackageSearch } from 'lucide-react'
import { formatBusinessDate, formatMoney } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { ProductSalesReport } from '@/lib/types'
import { getProductSales } from '@/data/api'
import { keys, useBusinessDate } from '@/data/hooks'
import { BarChart, compactMoney, HorizontalBarChart, SERIES_COLORS } from '@/components/charts/BarChart'
import { AnimatedMoney } from '@/components/motion/AnimatedNumber'
import { EmptyState, ErrorState, LoadingBlock, Page, PageHeader } from '@/components/ui/Misc'
import { PeriodPicker, periodError, periodFor, type Period } from '@/features/reports/PeriodPicker'

// Profit is part of net sales, so the chart shows net sales alone and names
// the day's profit in the tooltip (stacking them would overstate the day).
const SERIES = [{ key: 'net_revenue', label: 'Net sales', color: SERIES_COLORS.cash }]

/** Admin view: which products sold in a period, and the gross profit they made. */
export function ProductSalesView({ tabs }: { tabs: ReactNode }) {
  const { data: today } = useBusinessDate()
  const [period, setPeriod] = useState<Period | null>(null)
  useEffect(() => {
    if (today && !period) setPeriod(periodFor('month', today))
  }, [today, period])
  const invalid = today && period ? periodError(period, today) : null
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: keys.productSales(period?.from ?? '', period?.to ?? ''),
    queryFn: () => getProductSales(period!.from, period!.to),
    enabled: Boolean(period) && !invalid,
    placeholderData: (prev) => prev
  })
  return (
    <Page>
      <PageHeader title="Inventory" subtitle="Product sales and gross profit from actual sales, at the cost recorded when each item was sold." actions={tabs}>
        {today && period && <PeriodPicker value={period} onChange={setPeriod} today={today} layoutId="product-period" />}
      </PageHeader>
      {invalid ? (
        <EmptyState title="Choose a valid period" description={invalid} />
      ) : error ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <LoadingBlock />
      ) : (
        <SalesBody data={data} />
      )}
    </Page>
  )
}

function SalesBody({ data }: { data: ProductSalesReport }) {
  const t = data.totals
  if (data.products.length === 0) {
    return (
      <section className="card">
        <EmptyState icon={<PackageSearch className="size-5" />} title="No products sold in this period" description={trackingNote(data)} />
      </section>
    )
  }
  const notes = [trackingNote(data), uncostedNote(data)].filter(Boolean)
  return (
    <div className="space-y-6">
      <section className="card p-5 sm:p-8" data-testid="product-totals">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <span className="label">Net product sales</span>
            <AnimatedMoney value={t.net_revenue} duration={0.8} className="mt-5 block figure text-[clamp(38px,11vw,44px)] leading-[0.92] text-forest-950 sm:text-[clamp(44px,4.6vw,60px)]" data-testid="product-net" />
            <p className="mt-4 text-sm text-fg-3">
              {t.quantity} unit{t.quantity === 1 ? '' : 's'} of {t.products} product{t.products === 1 ? '' : 's'} · {formatMoney(t.revenue)} at selling price
              {t.discount > 0 ? ` − ${formatMoney(t.discount)} share of discounts` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-4 sm:gap-10">
            <div>
              <p className="label">Cost of goods sold</p>
              <p className="mt-2.5 figure text-[24px] leading-none text-fg" data-testid="product-cogs">
                {formatMoney(t.cost)}
              </p>
            </div>
            <div>
              <p className="label">Gross profit</p>
              <p className={cn('mt-2.5 figure text-[30px] leading-none', t.gross_profit < 0 ? 'text-claret-700' : 'text-forest-800')} data-testid="product-profit">
                {formatMoney(t.gross_profit)}
              </p>
            </div>
          </div>
        </div>
        <p className="mt-7 flex items-start gap-2 text-xs leading-relaxed text-fg-3">
          <Info className="mt-0.5 size-3.5 shrink-0 text-fg-4" />
          Gross profit = product sales after their share of discounts, minus the cost price recorded at each sale. Table time is not product revenue, and business
          expenses are not deducted here (see Reports for net business figures).
        </p>
        {notes.length > 0 && (
          <div className="mt-4 space-y-2 rounded-2xl bg-brass-50 px-4 py-3 text-xs text-brass-800" data-testid="product-notes">
            {notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-12 gap-6">
        <section className="card col-span-12 p-5 sm:p-7 xl:col-span-7">
          <span className="label">Net product sales by day</span>
          <BarChart
            className="mt-6"
            height={240}
            series={SERIES}
            data={data.days.map((d) => ({
              key: d.date,
              label: formatBusinessDate(d.date, { weekday: false, year: false }),
              title: formatBusinessDate(d.date),
              values: { net_revenue: d.net_revenue },
              note: `${d.quantity} unit${d.quantity === 1 ? '' : 's'} sold · gross profit ${formatMoney(d.gross_profit)}`
            }))}
            formatValue={(v) => formatMoney(v)}
            formatAxis={compactMoney}
          />
        </section>
        <section className="card col-span-12 p-5 sm:p-7 xl:col-span-5">
          <span className="label">Best sellers by net sales</span>
          <HorizontalBarChart
            className="mt-5"
            series={[{ key: 'net', label: 'Net sales', color: SERIES_COLORS.total }]}
            data={data.products.slice(0, 8).map((p) => ({
              key: p.product_key,
              label: p.name.length > 14 ? `${p.name.slice(0, 13)}…` : p.name,
              title: p.name,
              values: { net: p.net_revenue },
              note: `${p.quantity} sold${p.gross_profit !== null ? ` · profit ${formatMoney(p.gross_profit)}` : ''}`
            }))}
            formatValue={(v) => formatMoney(v)}
            formatAxis={compactMoney}
          />
        </section>
      </div>

      <section className="card overflow-hidden pt-3 pb-2" data-testid="product-sales-table">
        <div className="overflow-x-auto">
          <table className="table-stack w-full min-w-[980px] text-sm">
            <thead>
              <tr className="thead-row">
                <th className="px-8 py-3.5">Product</th>
                <th className="px-4 py-3.5 text-right">Sold</th>
                <th className="px-4 py-3.5 text-right">Avg. selling price</th>
                <th className="px-4 py-3.5 text-right">Avg. cost price</th>
                <th className="px-4 py-3.5 text-right">Sales</th>
                <th className="px-4 py-3.5 text-right">Discounts</th>
                <th className="px-4 py-3.5 text-right">Net sales</th>
                <th className="px-4 py-3.5 text-right">Cost of goods</th>
                <th className="px-4 py-3.5 text-right">Gross profit</th>
                <th className="px-8 py-3.5 text-right">Margin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.products.map((p) => (
                <tr key={p.product_key} data-testid={`product-row-${p.name}`}>
                  <td className="px-8 py-3.5" data-stack="title">
                    <span className="font-semibold text-fg">{p.name}</span>
                    {p.category && <span className="ml-2 text-xs text-fg-4">{p.category}</span>}
                  </td>
                  <td className="px-4 py-3.5 text-right text-fg tabular" data-label="Sold">{p.quantity}</td>
                  <td className="px-4 py-3.5 text-right text-fg-3 tabular" data-label="Avg. selling price">{formatMoney(p.avg_price)}</td>
                  <td className="px-4 py-3.5 text-right text-fg-3 tabular" data-label="Avg. cost price">{p.avg_cost === null ? '—' : formatMoney(p.avg_cost)}</td>
                  <td className="px-4 py-3.5 text-right text-fg-2 tabular" data-label="Sales">{formatMoney(p.revenue)}</td>
                  <td className="px-4 py-3.5 text-right text-fg-3 tabular" data-label="Discounts">{formatMoney(p.discount)}</td>
                  <td className="px-4 py-3.5 text-right font-semibold text-fg tabular" data-label="Net sales">{formatMoney(p.net_revenue)}</td>
                  <td className="px-4 py-3.5 text-right text-fg-3 tabular" data-label="Cost of goods">{p.costed_quantity === 0 ? '—' : formatMoney(p.cost)}</td>
                  <td className={cn('px-4 py-3.5 text-right font-bold tabular', (p.gross_profit ?? 0) < 0 ? 'text-claret-700' : 'text-forest-800')} data-label="Gross profit">
                    {p.gross_profit === null ? '—' : formatMoney(p.gross_profit)}
                    {p.gross_profit !== null && p.uncosted_quantity > 0 && <span className="ml-1 text-fg-4">*</span>}
                  </td>
                  <td className="px-8 py-3.5 text-right text-fg-3 tabular" data-label="Margin">{p.margin === null ? '—' : `${p.margin}%`}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-line-strong/70">
              <tr className="font-bold text-fg">
                <td className="px-8 py-3.5" data-stack="title">Total</td>
                <td className="px-4 py-3.5 text-right tabular" data-label="Sold">{t.quantity}</td>
                <td className="px-4 py-3.5" />
                <td className="px-4 py-3.5" />
                <td className="px-4 py-3.5 text-right tabular" data-label="Sales">{formatMoney(t.revenue)}</td>
                <td className="px-4 py-3.5 text-right tabular" data-label="Discounts">{formatMoney(t.discount)}</td>
                <td className="px-4 py-3.5 text-right tabular" data-label="Net sales">{formatMoney(t.net_revenue)}</td>
                <td className="px-4 py-3.5 text-right tabular" data-label="Cost of goods">{formatMoney(t.cost)}</td>
                <td className="px-4 py-3.5 text-right text-forest-800 tabular" data-testid="product-profit-total" data-label="Gross profit">
                  {formatMoney(t.gross_profit)}
                </td>
                <td className="px-8 py-3.5" />
              </tr>
            </tfoot>
          </table>
        </div>
        {t.uncosted_quantity > 0 && (
          <p className="px-5 py-4 text-xs text-fg-4 sm:px-8">* Profit counts only the units whose cost price was recorded when they were sold.</p>
        )}
      </section>
    </div>
  )
}

function trackingNote(d: ProductSalesReport): string {
  if (!d.tracking_since) return 'Product sales are recorded from the first sale after this feature was installed.'
  if (d.tracking_since > d.from) return `Product-level sales are recorded from ${formatBusinessDate(d.tracking_since)}, when product tracking began.`
  return ''
}

function uncostedNote(d: ProductSalesReport): string {
  const n = d.totals.uncosted_quantity
  if (n === 0) return ''
  return `${n} unit${n === 1 ? ' was' : 's were'} sold before cost prices were recorded with each sale (${formatMoney(d.totals.net_revenue - d.totals.costed_net_revenue)} in net sales). They are included in sales but not in cost or profit — FUSION does not guess past cost prices.`
}
