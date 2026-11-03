import { memo } from 'react'
import { motion } from 'framer-motion'
import { Pause, Play, Plus, Receipt, Square } from 'lucide-react'
import { formatClock, formatMoney, formatPricing } from '@shared/format'
import { cn } from '@/lib/cn'
import type { TableOverview } from '@/lib/types'
import { Button } from '@/components/ui/Button'
import { statusMeta, timeUpMeta, useLive } from './session'

export function StatusPill({ status, timeUp = false }: { status: keyof typeof statusMeta; timeUp?: boolean }) {
  const m = timeUp ? timeUpMeta : statusMeta[status]
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide', m.pill)}>
      <span className={cn('size-1.5 rounded-full', status === 'billing' ? 'bg-surface/80' : m.dot)} />
      {m.label}
    </span>
  )
}

interface Props {
  table: TableOverview
  onOpen: (table: TableOverview) => void
  onStart: (table: TableOverview) => void
  onCheckout: (table: TableOverview) => void
  onPause: (sessionId: string) => void
  onResume: (sessionId: string) => void
  onEnd: (table: TableOverview) => void
  /** A used-up per-minute booking: keep playing (extra time billed from now). */
  onContinue: (sessionId: string) => void
  /** A table priced by the hour: add 30 minutes (the whole time is re-priced). */
  onExtend: (sessionId: string, fromBookedSeconds: number) => void
  busy: boolean
}

/**
 * One table on the floor, set in type alone: the category and floor in small
 * capitals, the table's name in the display serif, and the live clock and
 * charge as the largest figures. Tables in play are lifted off the page; free
 * tables sit lighter and quieter, so the floor reads at a glance. No artwork —
 * the same card serves snooker, pool, table tennis and consoles.
 */
export const TableCard = memo(function TableCard({ table, onOpen, onStart, onCheckout, onPause, onResume, onEnd, onContinue, onExtend, busy }: Props) {
  const session = table.session
  const status = session?.status ?? 'available'
  const live = useLive(session)
  const timeUp = live?.timeUp ?? false
  const meta = timeUp ? timeUpMeta : statusMeta[status]
  // Bookings count down and stop at 0:00; open play (and play continued past a
  // booking) counts up. Nothing ever shows negative time.
  const countdown = live?.remaining != null && live.extraSeconds === null && status !== 'billing'
  const bookedProgress =
    live && session?.booked_seconds ? Math.min(1, live.seconds / session.booked_seconds) : null

  return (
    <motion.article
      whileHover={{ y: -3 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        'relative flex min-h-[256px] cursor-pointer flex-col rounded-[var(--radius-card)] p-6 transition-[background-color,box-shadow] duration-200',
        session
          ? 'bg-surface shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-raised)]'
          : 'bg-surface/55 hover:bg-surface hover:shadow-[var(--shadow-card)]',
        timeUp && 'ring-2 ring-claret-500/45'
      )}
      onClick={() => (session ? onOpen(table) : onStart(table))}
      data-testid={`table-card-${table.name}`}
    >
      <header>
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-[11px] font-semibold tracking-[0.14em] text-fg-4 uppercase">
            {table.category_name}
            <span className="mx-1.5 text-fg-5">·</span>
            {table.floor_name}
          </p>
          <StatusPill status={status} timeUp={timeUp} />
        </div>
        <h3 className="mt-4 truncate font-display-tight text-[28px] leading-[1.05] text-forest-950">{table.name}</h3>
        <p className="mt-1.5 text-[13px] font-medium text-fg-3 tabular">{formatPricing(session ?? table)}</p>
      </header>

      <div className="mt-auto pt-7">
        {session && live ? (
          <>
            <div className="flex items-end justify-between gap-3">
              <span className={cn('figure text-[44px] leading-[0.9]', meta.text)} data-testid="table-timer">
                {countdown ? formatClock(live.remaining!) : formatClock(live.seconds)}
              </span>
              <span className="text-right">
                <span className="block figure text-[19px] leading-tight text-forest-950">{formatMoney(live.total)}</span>
                <span className="block text-[11px] font-medium text-fg-4">
                  {live.itemsCount > 0 ? `incl. ${live.itemsCount} item${live.itemsCount > 1 ? 's' : ''}` : 'table charge'}
                </span>
              </span>
            </div>
            {bookedProgress !== null && (
              <div className="mt-4">
                <div className="h-[3px] overflow-hidden rounded-full bg-forest-950/[0.07]">
                  <div
                    className={cn('h-full rounded-full transition-[width] duration-1000', timeUp ? 'bg-claret-500' : 'bg-forest-700')}
                    style={{ width: `${bookedProgress * 100}%` }}
                  />
                </div>
                <p className={cn('mt-2 text-[11px] font-semibold', timeUp ? 'text-claret-600' : 'text-fg-4')} data-testid="booking-status">
                  {timeUp
                    ? "Time's up · billing stopped at the booked amount"
                    : live.extraSeconds !== null
                      ? `Booking complete · +${formatClock(live.extraSeconds)} extra, billed per minute`
                      : status === 'billing'
                        ? 'Booking'
                        : `left of ${formatClock(session.booked_seconds!)} booked`}
                </p>
              </div>
            )}
          </>
        ) : (
          <p className="text-[15px] font-medium text-fg-4">Ready to play</p>
        )}

        <div className="mt-5 flex gap-2" onClick={(e) => e.stopPropagation()}>
          {!session && (
            <Button variant="primary" className="flex-1" icon={<Play className="size-4" />} onClick={() => onStart(table)}>
              Start
            </Button>
          )}
          {timeUp && (
            <>
              {session!.pricing_mode === 'hourly_special30' ? (
                <Button variant="secondary" className="flex-1" icon={<Plus className="size-4" />} disabled={busy} onClick={() => onExtend(session!.id, session!.booked_seconds!)} data-testid="table-extend">
                  30 min
                </Button>
              ) : (
                <Button variant="secondary" className="flex-1" icon={<Play className="size-4" />} disabled={busy} onClick={() => onContinue(session!.id)} data-testid="table-continue">
                  Continue
                </Button>
              )}
              <Button variant="primary" className="flex-1" icon={<Square className="size-3.5" />} disabled={busy} onClick={() => onEnd(table)}>
                End
              </Button>
            </>
          )}
          {status === 'running' && !timeUp && (
            <>
              <Button variant="secondary" className="flex-1" icon={<Pause className="size-4" />} disabled={busy} onClick={() => onPause(session!.id)}>
                Pause
              </Button>
              <Button variant="secondary" aria-label="Add items" icon={<Plus className="size-4" />} onClick={() => onOpen(table)} />
              <Button variant="primary" className="flex-1" icon={<Square className="size-3.5" />} disabled={busy} onClick={() => onEnd(table)}>
                End
              </Button>
            </>
          )}
          {status === 'paused' && !timeUp && (
            <>
              <Button variant="primary" className="flex-1" icon={<Play className="size-4" />} disabled={busy} onClick={() => onResume(session!.id)}>
                Resume
              </Button>
              <Button variant="secondary" className="flex-1" icon={<Square className="size-3.5" />} disabled={busy} onClick={() => onEnd(table)}>
                End
              </Button>
            </>
          )}
          {status === 'billing' && (
            <Button variant="brass" className="flex-1" icon={<Receipt className="size-4" />} onClick={() => onCheckout(table)}>
              Checkout · {formatMoney(live?.total ?? 0)}
            </Button>
          )}
        </div>
      </div>
    </motion.article>
  )
})
