import { Minus, Plus } from 'lucide-react'
import { MAX_BOOKED_MINUTES, SLOT_STEP_MINUTES, slotPrice } from '@shared/billing'
import { formatDuration, formatMoney } from '@shared/format'
import { cn } from '@/lib/cn'
import { IconButton } from '@/components/ui/Button'

const CHIPS = [30, 60, 90, 120, 150, 180]

/** "1.5 h" style labels for the duration chips. */
export function durationLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : `${minutes / 60} h`
}

/** How a price was worked out: "30-minute price" or "1.5 h × PKR 600". */
export function slotPriceNote(minutes: number, hourlyRate: number): string {
  return minutes === SLOT_STEP_MINUTES ? 'Special 30-minute price' : `${durationLabel(minutes)} × ${formatMoney(hourlyRate)}/hour`
}

/**
 * Duration for a table priced by the hour: 30-minute steps, with the price
 * shown before anything is confirmed.
 */
export function DurationPicker({
  minutes,
  onChange,
  hourlyRate,
  special30,
  min = SLOT_STEP_MINUTES
}: {
  minutes: number
  onChange: (minutes: number) => void
  hourlyRate: number
  special30: number
  /** Smallest selectable duration. */
  min?: number
}) {
  const price = slotPrice(minutes, hourlyRate, special30)
  return (
    <div className="space-y-3" data-testid="duration-picker">
      <div className="flex flex-wrap gap-2">
        {CHIPS.filter((m) => m >= min).map((m) => (
          <button
            type="button"
            key={m}
            onClick={() => onChange(m)}
            className={cn(
              'h-9 rounded-lg px-3.5 text-[13px] font-bold transition-colors',
              minutes === m ? 'bg-forest-950 text-cream' : 'bg-sunken/80 text-fg-3 hover:text-fg'
            )}
            data-testid={`duration-${m}`}
          >
            {durationLabel(m)}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-4 rounded-xl bg-sunken/70 px-4 py-3">
        <div className="flex items-center gap-1 rounded-xl bg-surface shadow-[var(--shadow-control)]">
          <IconButton label="30 minutes less" size="sm" tooltip={false} disabled={minutes <= min} onClick={() => onChange(Math.max(min, minutes - SLOT_STEP_MINUTES))}>
            <Minus className="size-3.5" />
          </IconButton>
          <span className="min-w-[78px] text-center text-sm font-bold text-fg tabular" data-testid="duration-value">
            {formatDuration(minutes * 60)}
          </span>
          <IconButton
            label="30 minutes more"
            size="sm"
            tooltip={false}
            disabled={minutes + SLOT_STEP_MINUTES > MAX_BOOKED_MINUTES}
            onClick={() => onChange(minutes + SLOT_STEP_MINUTES)}
          >
            <Plus className="size-3.5" />
          </IconButton>
        </div>
        <div className="text-right">
          <p className="figure text-[22px] leading-none text-forest-950" data-testid="duration-price">
            {formatMoney(price)}
          </p>
          <p className="mt-1 text-xs text-fg-4">{slotPriceNote(minutes, hourlyRate)}</p>
        </div>
      </div>
    </div>
  )
}
