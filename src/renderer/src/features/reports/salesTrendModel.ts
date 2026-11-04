import { addDays } from '@shared/format'
import type { SalesByHour } from '../../lib/types'

export interface TrendDay {
  date: string
  cash: number
  bank: number
  /** Extra tooltip line (expenses, net, invoices …). */
  note?: string
}

/** Every date of a period up to two months (quiet days as zero, so gaps show); longer periods as reported. */
export function everyDay(from: string, to: string, days: TrendDay[]): TrendDay[] {
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
  if (span > 62) return days
  const byDate = new Map(days.map((d) => [d.date, d]))
  return Array.from({ length: span }, (_, i) => {
    const date = addDays(from, i)
    return byDate.get(date) ?? { date, cash: 0, bank: 0, note: 'No sales' }
  })
}

/** The hour of the day in the club's time zone, in business-day order (0 = the day's first hour). */
function position(hour: number, dayStart: number) {
  return (hour - dayStart + 24) % 24
}

export interface HourSlot {
  hour: number
  /** Today, an hour still to come: on the axis so the chart keeps its shape, but holds no value. */
  future: boolean
}

/**
 * The club hours to draw for one business day: the trading hours with a quiet
 * hour either side, at least six, never past the day's last hour. Today they
 * run up to the current hour; early in the day the next hours are added as
 * empty slots still to come (never as zero sales).
 */
export function hourRange(data: Pick<SalesByHour, 'hours' | 'day_start_hour' | 'timezone'>, isToday: boolean, nowMs = Date.now()): HourSlot[] {
  const start = data.day_start_hour
  const traded = data.hours.map((h) => position(h.hour, start))
  // (A sale stamped in a later hour than this computer's clock still shows.)
  const nowPos = isToday
    ? Math.max(
        position(Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: data.timezone }).format(new Date(nowMs))), start),
        ...traded
      )
    : null
  let first = traded.length ? Math.max(0, Math.min(...traded) - 1) : Math.max(0, (nowPos ?? 23) - 5)
  let last = nowPos ?? (traded.length ? Math.min(23, Math.max(...traded) + 1) : 23)
  // Widen to six hours: earlier hours first (today: they have passed), alternating on a past day
  // so lone trading hours sit in the middle; today only when no earlier hour is left, later ones to come.
  for (let earlier = true; last - first < 5; earlier = nowPos !== null || !earlier) {
    if (earlier && first > 0) first--
    else if (last < 23) last++
    else if (first > 0) first--
    else break
  }
  return Array.from({ length: last - first + 1 }, (_, i) => ({ hour: (first + i + start) % 24, future: nowPos !== null && first + i > nowPos }))
}
