import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Ban, Minus, Pause, Play, Plus, Receipt, RotateCcw, Square, Trash2, UserRound } from 'lucide-react'
import { formatClock, formatDuration, formatMoney, formatRate, formatTime } from '@shared/format'
import type { TableOverview } from '@/lib/types'
import { useSettings } from '@/data/hooks'
import { Drawer } from '@/components/ui/Drawer'
import { Button, IconButton } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Modal'
import { useAuth } from '@/features/auth/AuthProvider'
import { ProductPicker } from '@/features/pos/ProductPicker'
import { StatusPill } from './TableCard'
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
  const busy = actions.pause.isPending || actions.resume.isPending || actions.end.isPending || actions.reopen.isPending
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
        aside={session && <StatusPill status={session.status} />}
        footer={
          session && (
            <div className="flex gap-2.5">
              {session.status === 'running' && (
                <Button variant="secondary" size="lg" className="flex-1" icon={<Pause className="size-4" />} loading={actions.pause.isPending} disabled={busy} onClick={() => actions.pause.mutate(session.id)}>
                  Pause
                </Button>
              )}
              {session.status === 'paused' && (
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
              <p className="label">{session.status === 'billing' ? 'Final time' : session.status === 'paused' ? 'Paused at' : 'Playing time'}</p>
              <p className="mt-3 figure text-[64px] leading-none text-forest-950">{formatClock(live.seconds)}</p>
              <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div>
                  <dt className="text-xs text-fg-4">Started</dt>
                  <dd className="font-semibold text-fg tabular">{formatTime(session.started_at, tz)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-4">Rate</dt>
                  <dd className="font-semibold text-fg tabular">{formatRate(session.rate_per_minute)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-4">Booking</dt>
                  <dd className="font-semibold text-fg">
                    {session.booked_seconds ? `${formatDuration(session.booked_seconds)} · ${formatMoney(session.booked_amount)}` : 'Open play'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-4">{live.remaining !== null ? (live.remaining >= 0 ? 'Remaining' : 'Over time') : 'Paused total'}</dt>
                  <dd className={live.remaining !== null && live.remaining < 0 ? 'font-semibold text-claret-600 tabular' : 'font-semibold text-fg tabular'}>
                    {live.remaining !== null ? formatClock(Math.abs(live.remaining)) : formatDuration(Math.floor(Number(session.paused_ms) / 1000))}
                  </dd>
                </div>
              </dl>
              {session.customer && (
                <div className="mt-5 flex items-center gap-2.5 rounded-xl bg-sunken/70 px-3.5 py-2.5 text-sm">
                  <UserRound className="size-4 text-fg-4" />
                  <span className="font-semibold text-fg">{session.customer.name}</span>
                  {session.customer.phone && <span className="text-fg-4 tabular">{session.customer.phone}</span>}
                </div>
              )}
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between">
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
                      className="flex items-center gap-3 rounded-xl bg-sunken/70 px-3.5 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-fg">{i.name}</p>
                        <p className="text-xs text-fg-4 tabular">{formatMoney(i.unit_price)} each</p>
                      </div>
                      <div className="flex items-center gap-0.5">
                        <IconButton size="sm" label="Decrease" tooltip={false} disabled={tabBusy} onClick={() => actions.setQty.mutate({ itemId: i.id, quantity: i.quantity - 1 })}>
                          <Minus className="size-3.5" />
                        </IconButton>
                        <span className="w-7 text-center text-sm font-bold tabular">{i.quantity}</span>
                        <IconButton size="sm" label="Increase" tooltip={false} disabled={tabBusy} onClick={() => actions.setQty.mutate({ itemId: i.id, quantity: i.quantity + 1 })}>
                          <Plus className="size-3.5" />
                        </IconButton>
                      </div>
                      <span className="w-20 text-right text-sm font-bold tabular">{formatMoney(i.unit_price * i.quantity)}</span>
                      <IconButton size="sm" variant="danger" label={`Remove ${i.name}`} disabled={tabBusy} onClick={() => actions.setQty.mutate({ itemId: i.id, quantity: 0 })}>
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
                className="flex items-center gap-2 text-xs font-semibold text-fg-4 transition-colors hover:text-claret-700"
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
