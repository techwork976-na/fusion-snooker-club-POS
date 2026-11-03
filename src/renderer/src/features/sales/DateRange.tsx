import { addDays, startOfMonth } from '@shared/format'
import { inputClass } from '@/components/ui/Field'
import { Segmented } from '@/components/ui/Misc'
import { cn } from '@/lib/cn'

export type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom'

export interface Range {
  preset: Preset
  from: string
  to: string
}

export function rangeFor(preset: Exclude<Preset, 'custom'>, today: string): Range {
  switch (preset) {
    case 'today':
      return { preset, from: today, to: today }
    case 'yesterday':
      return { preset, from: addDays(today, -1), to: addDays(today, -1) }
    case '7d':
      return { preset, from: addDays(today, -6), to: today }
    case '30d':
      return { preset, from: addDays(today, -29), to: today }
    case 'month':
      return { preset, from: startOfMonth(today), to: today }
  }
}

/** Business-date range picker: presets plus a custom from/to. */
export function DateRangePicker({ value, onChange, today, layoutId }: { value: Range; onChange: (r: Range) => void; today: string; layoutId: string }) {
  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center gap-3">
      <Segmented
        layoutId={layoutId}
        value={value.preset}
        onChange={(p) => onChange(p === 'custom' ? { ...value, preset: 'custom' } : rangeFor(p, today))}
        options={[
          { value: 'today', label: 'Today' },
          { value: 'yesterday', label: 'Yesterday' },
          { value: '7d', label: '7 days' },
          { value: '30d', label: '30 days' },
          { value: 'month', label: 'This month' },
          { value: 'custom', label: 'Custom' }
        ]}
      />
      {value.preset === 'custom' && (
        <div className="flex w-full items-center gap-2 sm:w-auto">
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
        </div>
      )}
    </div>
  )
}
