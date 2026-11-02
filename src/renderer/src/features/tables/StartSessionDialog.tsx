import { useEffect, useState } from 'react'
import { Clock3, Coins, Infinity as InfinityIcon } from 'lucide-react'
import { amountForBookedMinutes, describePolicy, secondsForAmount } from '@shared/billing'
import { formatDuration, formatMoney, formatRate } from '@shared/format'
import { cn } from '@/lib/cn'
import type { TableOverview } from '@/lib/types'
import { useBillingPolicy } from '@/data/hooks'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { parseAmount, parseIntStrict, TextField } from '@/components/ui/Field'
import { CustomerField, emptyCustomer, type CustomerValue } from '@/features/pos/CustomerField'
import { useSessionActions } from './session'

type Mode = 'open' | 'minutes' | 'amount'

const MINUTE_CHIPS = [30, 45, 60, 90, 120]
const AMOUNT_CHIPS = [200, 300, 500, 1000]

export function StartSessionDialog({ table, onClose }: { table: TableOverview | null; onClose: () => void }) {
  const { start } = useSessionActions()
  const policy = useBillingPolicy()
  const [mode, setMode] = useState<Mode>('open')
  const [minutesText, setMinutesText] = useState('60')
  const [amountText, setAmountText] = useState('')
  const [customer, setCustomer] = useState<CustomerValue>(emptyCustomer)

  useEffect(() => {
    if (table) {
      setMode('open')
      setMinutesText('60')
      setAmountText('')
      setCustomer(emptyCustomer)
    }
  }, [table])

  const rate = table?.rate_per_minute ?? 0
  const minutes = parseIntStrict(minutesText)
  const amount = parseAmount(amountText)
  const minutesValid = minutes !== null && minutes >= 1 && minutes <= 1440
  const amountSeconds = amount ? secondsForAmount(amount, rate) : 0
  const amountValid = amount !== null && amount > 0 && amountSeconds >= 60

  const preview =
    mode === 'minutes'
      ? minutesValid
        ? `${formatDuration(minutes! * 60)} for ${formatMoney(amountForBookedMinutes(minutes!, rate))}`
        : 'Enter 1–1440 minutes'
      : mode === 'amount'
        ? amountValid
          ? `${formatMoney(amount)} buys ${formatDuration(amountSeconds)} of play`
          : amount
            ? 'Amount is less than one minute of play'
            : 'Enter the amount received'
        : `Billed as played at ${formatRate(rate)}`

  const canSubmit = mode === 'open' || (mode === 'minutes' ? minutesValid : amountValid)

  const submit = () => {
    if (!table || !canSubmit) return
    start.mutate(
      {
        tableId: table.id,
        booking: mode === 'open' ? { kind: 'open' } : mode === 'minutes' ? { kind: 'minutes', minutes: minutes! } : { kind: 'amount', amount: amount! },
        customer: { id: customer.id, name: customer.name.trim() || null, phone: customer.phone.trim() || null }
      },
      { onSuccess: onClose }
    )
  }

  const tabs: { value: Mode; label: string; icon: typeof Clock3 }[] = [
    { value: 'open', label: 'Open play', icon: InfinityIcon },
    { value: 'minutes', label: 'Fixed time', icon: Clock3 },
    { value: 'amount', label: 'Fixed amount', icon: Coins }
  ]

  return (
    <Modal
      open={table !== null}
      onOpenChange={(o) => !o && !start.isPending && onClose()}
      title={`Start ${table?.name ?? ''}`}
      description={`${table?.category_name} · ${table?.floor_name} · ${formatRate(rate)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={start.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={start.isPending} disabled={!canSubmit} data-testid="confirm-start">
            Start session
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="grid grid-cols-3 gap-2">
          {tabs.map((t) => (
            <button
              type="button"
              key={t.value}
              onClick={() => setMode(t.value)}
              className={cn(
                'flex flex-col items-start gap-2 rounded-xl border px-3.5 py-3 text-left transition-colors',
                mode === t.value ? 'border-transparent bg-surface text-forest-950 shadow-[var(--shadow-control)] ring-2 ring-forest-700' : 'border-transparent bg-sunken/70 text-fg-3 hover:bg-sunken'
              )}
            >
              <t.icon className={cn('size-[18px]', mode === t.value ? 'text-forest-700' : 'text-fg-4')} />
              <span className="text-sm font-bold">{t.label}</span>
            </button>
          ))}
        </div>

        {mode === 'minutes' && (
          <div className="space-y-2.5">
            <TextField label="Minutes" inputMode="numeric" value={minutesText} onChange={(e) => setMinutesText(e.target.value)} suffix="min" autoFocus />
            <div className="flex flex-wrap gap-2">
              {MINUTE_CHIPS.map((m) => (
                <button
                  type="button"
                  key={m}
                  onClick={() => setMinutesText(String(m))}
                  className={cn('h-8 rounded-lg border px-3 text-xs font-bold transition-colors', minutes === m ? 'border-transparent bg-forest-950 text-cream' : 'border-transparent bg-sunken/80 text-fg-3 hover:text-fg')}
                >
                  {m >= 60 ? `${m / 60} h${m % 60 ? ` ${m % 60}` : ''}` : `${m} min`}
                </button>
              ))}
            </div>
          </div>
        )}
        {mode === 'amount' && (
          <div className="space-y-2.5">
            <TextField label="Amount received" prefix="PKR" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} autoFocus />
            <div className="flex flex-wrap gap-2">
              {AMOUNT_CHIPS.map((a) => (
                <button
                  type="button"
                  key={a}
                  onClick={() => setAmountText(String(a))}
                  className={cn('h-8 rounded-lg border px-3 text-xs font-bold transition-colors', amount === a ? 'border-transparent bg-forest-950 text-cream' : 'border-transparent bg-sunken/80 text-fg-3 hover:text-fg')}
                >
                  {formatMoney(a)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-xl bg-sunken/70 px-4 py-3">
          <p className="text-sm font-bold text-fg">{preview}</p>
          {policy && (
            <p className="mt-1 text-xs text-fg-4">
              {mode === 'open' ? describePolicy(policy) : 'Leaving early still pays the booking; extra time is billed at the per-minute rate.'}
            </p>
          )}
        </div>

        <CustomerField value={customer} onChange={setCustomer} />
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
