import { CalendarRange } from 'lucide-react'
import { addDays, daysBetween, formatBusinessDate, startOfMonth, startOfWeek } from '@shared/format'
import { inputClass } from '@/components/ui/Field'
import { Segmented } from '@/components/ui/Misc'
import { cn } from '@/lib/cn'

export type PeriodPreset = 'today' | 'yesterday' | 'week' | 'month' | 'custom'

export interface Period {
  preset: PeriodPreset
  from: string
  to: string
}

/** The database accepts at most this many days after `from`. */
export const MAX_PERIOD_DAYS = 366

/**
 * Presets count in business days (the club's timezone and day-start hour),
 * relative to the server's business date — never the computer's clock.
 * Week = Monday to today; Month = the 1st to today.
 */
export function periodFor(preset: Exclude<PeriodPreset, 'custom'>, today: string): Period {
  switch (preset) {
    case 'today':
      return { preset, from: today, to: today }
    case 'yesterday':
      return { preset, from: addDays(today, -1), to: addDays(today, -1) }
    case 'week':
      return { preset, from: startOfWeek(today), to: today }
    case 'month':
      return { preset, from: startOfMonth(today), to: today }
  }
}

export function periodError(p: Period, today: string): string | null {
  if (p.from > p.to) return 'The start date must be on or before the end date.'
  if (p.to > today) return 'The end date cannot be in the future.'
  if (daysBetween(p.from, p.to) > MAX_PERIOD_DAYS) return 'Choose a period of up to one year.'
  return null
}

export function periodLabel(p: Period): string {
  return p.from === p.to ? formatBusinessDate(p.from) : `${formatBusinessDate(p.from)} – ${formatBusinessDate(p.to)}`
}

export function PeriodPicker({
  value,
  onChange,
  today,
  layoutId,
  labels = {}
}: {
  value: Period
  onChange: (p: Period) => void
  today: string
  layoutId: string
  /** Other wording for a preset (e.g. "Weekly"); the dates stay the same. */
  labels?: Partial<Record<PeriodPreset, string>>
}) {
  const error = periodError(value, today)
  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center gap-3" data-testid="period-picker">
      <Segmented
        layoutId={layoutId}
        value={value.preset}
        onChange={(p) => onChange(p === 'custom' ? { ...value, preset: 'custom' } : periodFor(p, today))}
        options={[
          { value: 'today', label: 'Today' },
          { value: 'yesterday', label: 'Yesterday' },
          { value: 'week', label: labels.week ?? 'Week' },
          { value: 'month', label: labels.month ?? 'Month' },
          { value: 'custom', label: 'Custom' }
        ]}
      />
      {value.preset === 'custom' ? (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <input
            type="date"
            aria-label="From"
            className={cn(inputClass, 'h-10 min-w-0 flex-1 sm:w-[150px] sm:flex-none')}
            value={value.from}
            max={value.to}
            onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })}
          />
          <span className="text-fg-4">–</span>
          <input
            type="date"
            aria-label="To"
            className={cn(inputClass, 'h-10 min-w-0 flex-1 sm:w-[150px] sm:flex-none')}
            value={value.to}
            min={value.from}
            max={today}
            onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })}
          />
          {error && <span className="text-xs font-semibold text-claret-700 max-sm:basis-full">{error}</span>}
        </div>
      ) : (
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-fg-3" data-testid="period-label">
          <CalendarRange className="size-4 text-fg-4" />
          {periodLabel(value)}
        </span>
      )}
    </div>
  )
}
