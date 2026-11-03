import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Ban, Minus, Pause, Play, Plus, Receipt, RotateCcw, Square, Trash2, UserRound } from 'lucide-react'
import { formatClock, formatDuration, formatMoney, formatPricing, formatTime } from '@shared/format'
import { slotPrice } from '@shared/billing'
import type { TableOverview } from '@/lib/types'
import { useSettings } from '@/data/hooks'
import { Drawer } from '@/components/ui/Drawer'
import { Button, IconButton } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Modal'
import { useAuth } from '@/features/auth/AuthProvider'
import { ProductPicker } from '@/features/pos/ProductPicker'
import { StatusPill } from './TableCard'
import { durationLabel } from './DurationPicker'
import { useLive, useSessionActions } from './session'

/** Live session detail: timer, booking, tab items and every session action. */
export function SessionPanel({
  table,
  onClose,
  onCheckout
}: {
  table: TableOverview | null
  onClose: () => void
  onCheckout: (table: TableOverview) => void
}) {
  const session = table?.session ?? null
  const live = useLive(session)
  const actions = useSessionActions()
  const { can } = useAuth()
  const { data: settings } = useSettings()
  const [confirmCancel, setConfirmCancel] = useState(false)
  const tz = settings?.business_timezone
  const busy =
    actions.pause.isPending || actions.resume.isPending || actions.end.isPending || actions.reopen.isPending || actions.keepPlaying.isPending || actions.extend.isPending
  const hourly = session?.pricing_mode === 'hourly_special30' && session.hourly_rate != null && session.special_30_rate != null
  const extend = (minutes: number) => session && actions.extend.mutate({ id: session.id, minutes, fromBookedSeconds: session.booked_seconds! })
  const timeUp = live?.timeUp ?? false
  const tabBusy = actions.addItem.isPending || actions.setQty.isPending

  const end = () => {
    if (!session || !table) return
    actions.end.mutate(session.id, { onSuccess: () => onCheckout(table) })
  }

  return (
    <>
      <Drawer
        open={Boolean(table && session)}
        onOpenChange={(o) => !o && onClose()}
        title={table?.name}
        subtitle={table ? `${table.category_name} · ${table.floor_name}` : undefined}
        aside={session && <StatusPill status={session.status} timeUp={timeUp} />}
        footer={
          session && (
            <div className="flex flex-wrap gap-2.5">
              {timeUp && hourly && (
                <Button variant="secondary" size="lg" className="flex-1" icon={<Plus className="size-4" />} loading={actions.extend.isPending} disabled={busy} onClick={() => extend(30)}>
                  Extend 30 min
                </Button>
              )}
              {timeUp && !hourly && (
                <Button variant="secondary" size="lg" className="flex-1" icon={<Play className="size-4" />} loading={actions.keepPlaying.isPending} disabled={busy} onClick={() => actions.keepPlaying.mutate(session.id)}>
                  Continue playing
                </Button>
              )}
              {session.status === 'running' && !timeUp && (
                <Button variant="secondary" size="lg" className="flex-1" icon={<Pause className="size-4" />} loading={actions.pause.isPending} disabled={busy} onClick={() => actions.pause.mutate(session.id)}>
                  Pause
                </Button>
              )}
              {session.status === 'paused' && !timeUp && (
                <Button variant="primary" size="lg" className="flex-1" icon={<Play className="size-4" />} loading={actions.resume.isPending} disabled={busy} onClick={() => actions.resume.mutate(session.id)}>
                  Resume
                </Button>
              )}
              {(session.status === 'running' || session.status === 'paused') && (
                <Button variant={session.status === 'paused' ? 'secondary' : 'primary'} size="lg" className="flex-[1.4]" icon={<Square className="size-3.5" />} loading={actions.end.isPending} disabled={busy} onClick={end} data-testid="end-session">
                  End &amp; checkout
                </Button>
              )}
              {session.status === 'billing' && (
                <>
                  <Button variant="secondary" size="lg" icon={<RotateCcw className="size-4" />} loading={actions.reopen.isPending} disabled={busy} onClick={() => actions.reopen.mutate(session.id)}>
                    Reopen
                  </Button>
                  <Button variant="brass" size="lg" className="flex-1" icon={<Receipt className="size-4" />} onClick={() => table && onCheckout(table)}>
                    Checkout · {formatMoney(live?.total ?? 0)}
                  </Button>
                </>
              )}
            </div>
          )
        }
      >
        {session && live && (
          <div className="space-y-6">
            <section>
              <p className="label">{timeUp ? "Time's up" : session.status === 'billing' ? 'Final time' : session.status === 'paused' ? 'Paused at' : 'Playing time'}</p>
              <p className="mt-3 figure text-[52px] leading-none text-forest-950 sm:text-[64px]">{formatClock(live.seconds)}</p>
              <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div>
                  <dt className="text-xs text-fg-4">Started</dt>
                  <dd className="font-semibold text-fg tabular">{formatTime(session.started_at, tz)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-4">Rate</dt>
                  <dd className="font-semibold text-fg tabular">{formatPricing(session)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-4">Booking</dt>
                  <dd className="font-semibold text-fg">
                    {session.booked_seconds ? `${formatDuration(session.booked_seconds)} · ${formatMoney(session.booked_amount)}` : 'Open play'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-4">{live.extraSeconds !== null ? 'Extra time' : live.remaining !== null ? 'Remaining' : 'Paused total'}</dt>
                  <dd className={timeUp ? 'font-semibold text-claret-600 tabular' : 'font-semibold text-fg tabular'}>
                    {live.extraSeconds !== null
                      ? `+${formatClock(live.extraSeconds)}`
                      : live.remaining !== null
                        ? formatClock(live.remaining)
                        : formatDuration(Math.floor(Number(session.paused_ms) / 1000))}
                  </dd>
                </div>
              </dl>
              {timeUp && (
                <p className="mt-5 rounded-xl bg-claret-50 px-3.5 py-3 text-sm text-claret-800">
                  The booking is used up. Billing has stopped at the booked amount ({formatMoney(session.booked_amount)}).{' '}
                  {hourly
                    ? 'End the session, or extend it — the whole time is then re-priced.'
                    : 'End the session, or continue playing — extra time is then billed per minute from that moment.'}
                </p>
              )}
              {hourly && (session.status === 'running' || session.status === 'paused') && (
                <div className="mt-5" data-testid="extend-session">
                  <p className="text-xs font-semibold text-fg-3">Extend — the whole time is re-priced</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {[30, 60, 90, 120].map((m) => {
                      const total = session.booked_seconds! / 60 + m
                      return (
                        <button
                          type="button"
                          key={m}
                          disabled={busy || total > 1440}
                          onClick={() => extend(m)}
                          className="rounded-xl bg-sunken/80 px-3.5 py-2 text-left transition-colors hover:bg-sunken disabled:opacity-45 max-sm:min-w-[calc(50%-4px)] max-sm:flex-1"
                          data-testid={`extend-${m}`}
                        >
                          <span className="block text-[13px] font-bold text-fg">+{durationLabel(m)}</span>
                          <span className="block text-[11px] text-fg-4 tabular">
                            {durationLabel(total)} · {formatMoney(slotPrice(total, Number(session.hourly_rate), Number(session.special_30_rate)))}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {session.customer && (
                <div className="mt-5 flex items-center gap-2.5 rounded-xl bg-sunken/70 px-3.5 py-2.5 text-sm">
                  <UserRound className="size-4 text-fg-4" />
                  <span className="font-semibold text-fg">{session.customer.name}</span>
                  {session.customer.phone && <span className="text-fg-4 tabular">{session.customer.phone}</span>}
                </div>
              )}
            </section>

            <section>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <h3 className="text-sm font-bold text-fg">Tab</h3>
                <span className="text-xs text-fg-4">Stock is taken when an item is served.</span>
              </div>
              <ProductPicker onPick={(p) => actions.addItem.mutate({ sessionId: session.id, productId: p.id })} busy={tabBusy} />
              <ul className="mt-3 space-y-2">
                <AnimatePresence initial={false}>
                  {session.items.map((i) => (
                    <motion.li
                      key={i.id}
                      layout
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, height: 0 }}
                      className="flex items-center gap-3 rounded-xl bg-sunken/70 px-3.5 py-2.5 max-sm:flex-wrap max-sm:gap-y-2"
                    >
                      <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-6rem)]">
                        <p className="truncate text-sm font-semibold text-fg">{i.name}</p>
                        <p className="text-xs text-fg-4 tabular">{formatMoney(i.unit_price)} each</p>
                      </div>
                      <div className="flex items-center gap-0.5 max-sm:order-2 max-sm:rounded-xl max-sm:bg-surface max-sm:shadow-[var(--shadow-control)]">
                        <IconButton size="sm" label="Decrease" tooltip={false} disabled={tabBusy} onClick={() => actions.setQty.mutate({ itemId: i.id, quantity: i.quantity - 1 })}>
                          <Minus className="size-3.5" />
                        </IconButton>
                        <span className="w-7 text-center text-sm font-bold tabular">{i.quantity}</span>
                        <IconButton size="sm" label="Increase" tooltip={false} disabled={tabBusy} onClick={() => actions.setQty.mutate({ itemId: i.id, quantity: i.quantity + 1 })}>
                          <Plus className="size-3.5" />
                        </IconButton>
                      </div>
                      <span className="w-20 text-right text-sm font-bold tabular max-sm:order-1">{formatMoney(i.unit_price * i.quantity)}</span>
                      <IconButton size="sm" variant="danger" label={`Remove ${i.name}`} className="max-sm:order-3 max-sm:ml-auto" disabled={tabBusy} onClick={() => actions.setQty.mutate({ itemId: i.id, quantity: 0 })}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </section>

            <section className="rounded-2xl bg-sunken/70 p-5 text-sm">
              <div className="flex justify-between text-fg-3">
                <span>Table charge {session.status === 'billing' ? '' : '(so far)'}</span>
                <span className="tabular text-fg">{formatMoney(live.tableCharge)}</span>
              </div>
              <div className="mt-2 flex justify-between text-fg-3">
                <span>Tab</span>
                <span className="tabular text-fg">{formatMoney(live.itemsTotal)}</span>
              </div>
              <div className="mt-4 flex items-end justify-between border-t border-forest-950/[0.07] pt-4">
                <span className="label">Running total</span>
                <span className="figure text-[30px] leading-none text-forest-950">{formatMoney(live.total)}</span>
              </div>
            </section>

            {can('cancel_session') && (
              <button
                onClick={() => setConfirmCancel(true)}
                className="flex items-center gap-2 text-xs font-semibold text-fg-4 transition-colors hover:text-claret-700 max-md:min-h-10"
              >
                <Ban className="size-3.5" /> Cancel session without charge
              </button>
            )}
          </div>
        )}
      </Drawer>
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this session?"
        confirmLabel="Cancel session"
        description={`${table?.name ?? 'The table'} becomes available and nothing is charged. Items on the tab go back into stock. The session stays on record as cancelled.`}
        onConfirm={async () => {
          if (!session) return
          await actions.cancel.mutateAsync(session.id)
          onClose()
        }}
      />
    </>
  )
}
