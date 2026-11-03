import { useState } from 'react'
import { History, LockKeyhole, MinusCircle, Undo2, Wallet } from 'lucide-react'
import { formatDateTime, formatDuration, formatMoney, formatTime } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { Shift } from '@/lib/types'
import * as api from '@/data/api'
import { accountingKeys, useAction, useMyCounter, useServerNow, useSettings } from '@/data/hooks'
import { AnimatedMoney } from '@/components/motion/AnimatedNumber'
import { Button, IconButton } from '@/components/ui/Button'
import { parseAmount, TextField } from '@/components/ui/Field'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { EmptyState, ErrorState, LoadingBlock, Page, PageHeader } from '@/components/ui/Misc'
import { useAuth } from '@/features/auth/AuthProvider'
import { ShiftDetailDrawer, ShiftFigures, ShiftStatusPill, shiftTimes } from '@/features/shifts/ShiftParts'

/** A staff member's own counter: open/close it, follow its figures, record expenses. */
export function MyCounterPage() {
  const { profile } = useAuth()
  const { data: settings } = useSettings()
  const tz = settings?.business_timezone
  const { data, isLoading, error, refetch } = useMyCounter()
  const open = useAction(api.openCounter, { invalidate: accountingKeys, success: 'Counter opened. Payments now go to your shift.' })
  const voidExpense = useAction(api.voidExpense, { invalidate: accountingKeys, success: 'Expense voided.' })
  const [expenseOpen, setExpenseOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)
  const shift = data?.shift ?? null

  return (
    <Page>
      <PageHeader
        eyebrow={profile?.floor_name ?? 'All floors'}
        title="My counter"
        subtitle={shift ? `${shiftTimes(shift, tz)} · your own sales and expenses only` : 'Open your counter to take payments and record expenses.'}
        actions={
          shift ? (
            <>
              <Button variant="secondary" icon={<MinusCircle className="size-4" />} onClick={() => setExpenseOpen(true)}>
                Add expense
              </Button>
              <Button variant="primary" icon={<LockKeyhole className="size-4" />} onClick={() => setCloseOpen(true)}>
                Close counter
              </Button>
            </>
          ) : (
            data && (
              <Button variant="primary" icon={<Wallet className="size-4" />} loading={open.isPending} onClick={() => open.mutate(undefined)}>
                Open counter
              </Button>
            )
          )
        }
      />

      {error ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-5">
          {shift ? (
            <CurrentShift shift={shift} />
          ) : (
            <section className="card flex flex-wrap items-center gap-6 p-6 sm:p-8" data-testid="counter-closed">
              <span className="flex size-14 items-center justify-center rounded-full bg-forest-50 text-forest-700">
                <Wallet className="size-6" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-display-tight text-[22px] text-forest-950">Your counter is closed</p>
                <p className="mt-1 max-w-xl text-sm text-fg-3">
                  When you open it, every payment you take and every expense you record is kept on your own shift. Closing it saves
                  the final figures for the owner.
                </p>
              </div>
              <Button variant="primary" size="lg" icon={<Wallet className="size-4" />} loading={open.isPending} onClick={() => open.mutate(undefined)}>
                Open counter
              </Button>
            </section>
          )}

          <div className="grid grid-cols-12 gap-5">
            {shift && (
              <section className="card col-span-12 p-5 sm:p-6 xl:col-span-6">
                <div className="flex items-center justify-between">
                  <span className="label">Expenses this shift</span>
                  <Button size="sm" variant="ghost" icon={<MinusCircle className="size-4" />} onClick={() => setExpenseOpen(true)}>
                    Add
                  </Button>
                </div>
                {data.expenses.length === 0 ? (
                  <p className="mt-4 text-sm text-fg-4">No expenses yet. Record cash you pay out of the counter here.</p>
                ) : (
                  <ul className="mt-3 divide-y divide-line">
                    {data.expenses.map((e) => (
                      <li key={e.id} className="flex items-center gap-3 py-2.5">
                        <span className={cn('min-w-0 flex-1', e.voided_at && 'text-fg-4 line-through')}>
                          <span className="block truncate text-sm font-semibold">{e.description}</span>
                          <span className="block text-xs text-fg-4">{formatTime(e.created_at, tz)}</span>
                        </span>
                        <span className={cn('text-sm font-bold tabular', e.voided_at ? 'text-fg-4 line-through' : 'text-claret-600')}>
                          −{formatMoney(e.amount)}
                        </span>
                        {!e.voided_at && (
                          <IconButton size="sm" variant="danger" label="Void expense" onClick={() => voidExpense.mutate(e.id)}>
                            <Undo2 className="size-4" />
                          </IconButton>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section className={cn('card col-span-12 p-5 sm:p-6', shift && 'xl:col-span-6')}>
              <span className="label">My recent shifts</span>
              {data.recent.length === 0 ? (
                <EmptyState className="py-8" icon={<History className="size-5" />} title="No closed shifts yet" />
              ) : (
                <ul className="mt-3 divide-y divide-line">
                  {data.recent.map((s) => (
                    <li key={s.id}>
                      <button onClick={() => setDetail(s.id)} className="flex w-full items-center gap-4 py-3 text-left hover:bg-forest-950/[0.02]">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-fg">{shiftTimes(s, tz)}</span>
                          <span className="block text-xs text-fg-4">
                            {s.invoices} invoice{s.invoices === 1 ? '' : 's'} · expenses {formatMoney(s.expenses)}
                          </span>
                        </span>
                        <span className="text-right">
                          <span className="block text-sm font-bold text-forest-950 tabular">{formatMoney(s.total)}</span>
                          <span className="block text-xs text-fg-4 tabular">net {formatMoney(s.net)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}

      <ExpenseDialog open={expenseOpen} onClose={() => setExpenseOpen(false)} />
      {shift && <CloseCounterDialog open={closeOpen} onOpenChange={setCloseOpen} shift={shift} onClosed={setDetail} />}
      <ShiftDetailDrawer shiftId={detail} onClose={() => setDetail(null)} />
    </Page>
  )
}

function CurrentShift({ shift }: { shift: Shift }) {
  const now = useServerNow()
  return (
    <section className="card p-5 sm:p-7" data-testid="my-counter">
      <div className="flex items-center justify-between">
        <span className="label">Current shift</span>
        <ShiftStatusPill status="open" />
      </div>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <AnimatedMoney
            value={shift.total}
            duration={0.9}
            className="block figure text-[clamp(40px,12vw,50px)] leading-[0.92] text-forest-950 sm:text-[clamp(50px,5.2vw,70px)]"
            data-testid="shift-total"
          />
          <p className="mt-4 text-sm text-fg-3">
            {shift.invoices} invoice{shift.invoices === 1 ? '' : 's'} · open for {formatDuration((now - Date.parse(shift.opened_at)) / 1000)}
            {shift.voided_count > 0 ? ` · ${shift.voided_count} voided` : ''}
          </p>
        </div>
        {shift.open_sessions > 0 && (
          <p className="rounded-full bg-brass-50 px-3 py-1.5 text-xs font-semibold text-brass-700">
            {shift.open_sessions} table session{shift.open_sessions === 1 ? '' : 's'} you started still open
          </p>
        )}
      </div>
      <ShiftFigures figures={shift} size="lg" className="mt-8 sm:mt-10" />
    </section>
  )
}

function ExpenseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [ref, setRef] = useState(() => crypto.randomUUID())
  const add = useAction(
    (a: { amount: number; description: string }) => api.addExpense(ref, a.amount, a.description),
    { invalidate: accountingKeys, success: 'Expense recorded.' }
  )
  const value = parseAmount(amount)
  const close = () => {
    setAmount('')
    setDescription('')
    setRef(crypto.randomUUID())
    onClose()
  }
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Add expense"
      description="Money paid out of your counter. It reduces your shift's net amount."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={add.isPending}
            disabled={!value || !description.trim()}
            onClick={() => add.mutate({ amount: value!, description: description.trim() }, { onSuccess: close })}
            data-testid="save-expense"
          >
            Save expense
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextField label="Amount" prefix="PKR" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus data-testid="expense-amount" />
        <TextField
          label="What was it for?"
          placeholder="e.g. Milk for tea, cleaning supplies"
          maxLength={120}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="expense-description"
        />
      </div>
    </Modal>
  )
}

function CloseCounterDialog({
  open,
  onOpenChange,
  shift,
  onClosed
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  shift: Shift
  onClosed: (shiftId: string) => void
}) {
  const close = useAction((handover: boolean) => api.closeCounter(null, handover), {
    invalidate: accountingKeys,
    success: 'Counter closed. Your shift summary is saved.'
  })
  const handover = shift.open_sessions > 0
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="primary"
      title="Close your counter?"
      confirmLabel="Close counter"
      description={<ShiftFigures figures={shift} className="rounded-xl bg-sunken p-4 sm:!grid-cols-3" />}
      requireAcknowledgement={
        handover
          ? `Hand over ${shift.open_sessions} table session(s) I started. They will be paid at whichever counter checks them out.`
          : undefined
      }
      onConfirm={async () => {
        const closed = await close.mutateAsync(handover)
        onClosed(closed.id)
      }}
    >
      <p className="text-[13px] text-fg-3">
        These figures become final. After closing you cannot take payments, void sales or change expenses on this shift.
        {' '}Opened {formatDateTime(shift.opened_at)}.
      </p>
    </ConfirmDialog>
  )
}
