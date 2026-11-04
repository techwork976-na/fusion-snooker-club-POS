import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock3, Crown, Repeat, Users, Wallet } from 'lucide-react'
import { formatDateTime, formatDuration, formatMoney } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { CustomerRanking, RankingMetric } from '@/lib/types'
import { getCustomerRankings } from '@/data/api'
import { keys, useSettings } from '@/data/hooks'
import { EmptyState, ErrorState, LoadingBlock, Segmented } from '@/components/ui/Misc'

const METRICS: { value: RankingMetric; label: string }[] = [
  { value: 'visits', label: 'Most visits' },
  { value: 'play_time', label: 'Most playing time' },
  { value: 'spending', label: 'Highest spending' }
]

const headline = (metric: RankingMetric, r: CustomerRanking) =>
  metric === 'visits'
    ? `${r.visits} visit${r.visits === 1 ? '' : 's'}`
    : metric === 'play_time'
      ? formatDuration(r.play_seconds)
      : formatMoney(r.spent)

/**
 * Regular and valuable customers. Statistics are kept permanently per visit
 * day, so rankings stay correct after old invoices are removed.
 */
export function CustomerRankingsView() {
  const { data: settings } = useSettings()
  const tz = settings?.business_timezone
  const [metric, setMetric] = useState<RankingMetric>('visits')
  const { data, isLoading, error, refetch } = useQuery({ queryKey: keys.rankings(metric), queryFn: () => getCustomerRankings(metric, 50) })

  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
  if (isLoading || !data) return <LoadingBlock />
  const top = data.rows.slice(0, 3)

  return (
    <div className="space-y-5" data-testid="customer-rankings">
      {/* One ledger strip, three counts — divided by hairlines, not boxed separately. */}
      <div className="card grid grid-cols-1 divide-line px-5 py-2 max-sm:divide-y sm:grid-cols-3 sm:divide-x sm:px-0 sm:py-6">
        <SummaryTile icon={<Users className="size-3.5" />} label="Customer profiles" value={data.summary.customers} />
        <SummaryTile icon={<Wallet className="size-3.5" />} label="Have visited" value={data.summary.with_visits} />
        <SummaryTile icon={<Repeat className="size-3.5" />} label="Came back more than once" value={data.summary.repeat} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented layoutId="ranking-metric" value={metric} onChange={setMetric} options={METRICS} />
        <p className="text-xs text-fg-4">A visit is a business day with at least one paid bill. Customers are matched by phone number.</p>
      </div>

      {data.rows.length === 0 ? (
        <div className="card">
          <EmptyState icon={<Crown className="size-5" />} title="No visits recorded yet" description="Rankings fill in as customers with a phone number pay their bills." />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {top.map((r) => (
              <div key={r.id} className={cn('card p-5 sm:p-6', r.rank === 1 && 'bg-brass-50')}>
                <div className="flex items-center justify-between">
                  <span className={cn('flex size-9 items-center justify-center rounded-full text-sm font-bold', r.rank === 1 ? 'bg-forest-950 text-cream' : 'bg-sunken text-fg-2')}>
                    {r.rank}
                  </span>
                  {r.rank === 1 && <Crown className="size-5 text-brass-600" />}
                </div>
                <p className="mt-4 truncate font-display-tight text-[24px] leading-tight text-forest-950">{r.name}</p>
                <p className="text-sm text-fg-4 tabular">{r.phone ?? 'No phone'}</p>
                <p className="mt-4 figure-display text-[30px] text-forest-950">{headline(metric, r)}</p>
                <p className="mt-1 text-xs text-fg-4">
                  {r.visits} visits · {formatDuration(r.play_seconds)} played · {formatMoney(r.spent)} spent
                </p>
              </div>
            ))}
          </div>

          <div className="card overflow-hidden">
            <table className="table-stack w-full text-sm">
              <thead>
                <tr className="thead-row">
                  <th className="w-16 px-5 py-3 font-semibold">Rank</th>
                  <th className="px-5 py-3 font-semibold">Customer</th>
                  <th className="px-5 py-3 text-right font-semibold">Visits</th>
                  <th className="px-5 py-3 text-right font-semibold">Playing time</th>
                  <th className="px-5 py-3 text-right font-semibold">Spending</th>
                  <th className="px-5 py-3 font-semibold">Last visit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-5 py-3 font-bold text-fg-2 tabular" data-label="Rank">{r.rank}</td>
                    <td className="px-5 py-3" data-stack="top">
                      <span className="block font-bold text-fg">{r.name}</span>
                      <span className="block text-xs text-fg-4 tabular">{r.phone ?? '—'}</span>
                    </td>
                    <td className={cn('px-5 py-3 text-right tabular', metric === 'visits' ? 'font-bold text-forest-950' : 'text-fg-2')} data-label="Visits">{r.visits}</td>
                    <td className={cn('px-5 py-3 text-right tabular', metric === 'play_time' ? 'font-bold text-forest-950' : 'text-fg-2')} data-label="Playing time">
                      {formatDuration(r.play_seconds)}
                    </td>
                    <td className={cn('px-5 py-3 text-right tabular', metric === 'spending' ? 'font-bold text-forest-950' : 'text-fg-2')} data-label="Spending">
                      {formatMoney(r.spent)}
                    </td>
                    <td className="px-5 py-3 text-fg-3" data-label="Last visit">
                      <Clock3 className="mr-1.5 inline size-3.5 text-fg-4" />
                      {formatDateTime(r.last_visit_at, tz)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function SummaryTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="py-4 sm:px-7 sm:py-0">
      <span className="label flex items-center gap-2">
        <span className="text-lake-600">{icon}</span>
        {label}
      </span>
      <span className="mt-3 block figure-display text-[34px] leading-none text-forest-950">{value}</span>
    </div>
  )
}
