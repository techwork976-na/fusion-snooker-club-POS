import { CalendarDays, Clock3 } from 'lucide-react'
import { formatBusinessDate, formatTime } from '@shared/format'
import { useBusinessDate, useServerNow, useSettings } from '@/data/hooks'
import { WindowControls } from './WindowControls'

function ClubClock() {
  const now = useServerNow()
  const { data: settings } = useSettings()
  return (
    <span className="flex items-center gap-1.5 tabular">
      <Clock3 className="size-3.5 text-fg-4" />
      {formatTime(new Date(now), settings?.business_timezone)}
    </span>
  )
}

/** Slim, draggable strip above the content: business day, club clock, window controls. */
export function TopBar() {
  const { data: businessDate } = useBusinessDate()
  return (
    <header className="drag-region relative z-30 flex h-12 shrink-0 items-center justify-between pl-5 md:pl-8 xl:pl-10">
      <div className="flex items-center gap-5 text-[12.5px] font-semibold text-fg-3">
        {businessDate && (
          <span className="flex items-center gap-1.5">
            <CalendarDays className="size-3.5 text-fg-4" />
            Business day · {formatBusinessDate(businessDate)}
          </span>
        )}
        <ClubClock />
      </div>
      <div className="h-full">
        <WindowControls />
      </div>
    </header>
  )
}

/** Minimal bar used before sign-in: drag area and window controls. */
export function BareTitleBar({ tone }: { tone?: 'light' | 'dark' }) {
  return (
    <header className="drag-region absolute inset-x-0 top-0 z-40 flex h-11 items-center justify-end">
      <div className="h-full">
        <WindowControls tone={tone} />
      </div>
    </header>
  )
}
