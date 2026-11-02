const moneyFormatter = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2, minimumFractionDigits: 0 })

/** "PKR 1,250" — whole rupees show without decimals, paisa amounts keep two. */
export function formatMoney(value: number | string | null | undefined, withCurrency = true): string {
  const n = Number(value ?? 0)
  const text = Number.isInteger(n) ? moneyFormatter.format(n) : n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return withCurrency ? `PKR ${text}` : text
}

/**
 * A rate per minute: "PKR 10/min", "PKR 7.50/min", "PKR 6.6667/min" (rates
 * keep up to four decimals, so an exact conversion is never hidden).
 */
export function formatRate(value: number | string | null | undefined, withCurrency = true): string {
  const n = Number(value ?? 0)
  const text = Number.isInteger(n)
    ? moneyFormatter.format(n)
    : n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
  return `${withCurrency ? 'PKR ' : ''}${text}/min`
}

/** 3725 → "1:02:05", 125 → "2:05". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

/** 3725 → "1 h 2 min", 59 → "59 s". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s < 60) return `${s} s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

export function paymentLabel(method: string): string {
  return method === 'bank_transfer' ? 'Bank Transfer' : method === 'cash' ? 'Cash' : method
}

/**
 * "07:15 PM". FUSION shows every time of day in 12-hour form. (Newer ICU
 * versions put a narrow no-break space before AM/PM; it is normalised.)
 */
export function formatTime(iso: string | Date, timeZone?: string): string {
  return new Date(iso)
    .toLocaleTimeString('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: true })
    .replace(/[  ]/g, ' ')
}

/** "31 Oct 2026, 07:15 PM" */
export function formatDateTime(iso: string, timeZone?: string): string {
  const d = new Date(iso)
  const date = d.toLocaleDateString('en-GB', { timeZone, day: '2-digit', month: 'short', year: 'numeric' })
  return `${date}, ${formatTime(d, timeZone)}`
}

/** An hour of the day (0–23) for charts and settings: "6 PM", or "06:00 PM" with minutes. */
export function formatHour(hour: number, withMinutes = false): string {
  const h = ((hour % 24) + 24) % 24
  const period = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return withMinutes ? `${String(h12).padStart(2, '0')}:00 ${period}` : `${h12} ${period}`
}

export type Period = 'AM' | 'PM'

/** "19:30" → { hour: 7, minute: 30, period: 'PM' } (for 12-hour time pickers). */
export function toClockParts(time: string): { hour: number; minute: number; period: Period } {
  const [h, m] = time.split(':').map(Number)
  const hh = ((h ?? 0) % 24 + 24) % 24
  return { hour: hh % 12 === 0 ? 12 : hh % 12, minute: m ?? 0, period: hh < 12 ? 'AM' : 'PM' }
}

/** (7, 30, 'PM') → "19:30" — the value stored; 12 AM is midnight, 12 PM is noon. */
export function fromClockParts(hour: number, minute: number, period: Period): string {
  const h = (hour % 12) + (period === 'PM' ? 12 : 0)
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** "2026-10-31" → "Sat 31 Oct 2026" (date-only values are not shifted by timezone). */
export function formatBusinessDate(date: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1))
  return dt.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    weekday: opts.weekday === false ? undefined : 'short',
    day: 'numeric',
    month: 'short',
    year: opts.year === false ? undefined : 'numeric'
  })
}

/** Adds days to a "YYYY-MM-DD" business date (calendar arithmetic, no timezone). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, (d ?? 1) + days))
  return dt.toISOString().slice(0, 10)
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`
}

/** The Monday of the week containing a business date (YYYY-MM-DD). */
export function startOfWeek(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const weekday = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)).getUTCDay() // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7))
}

/** Whole days from `from` to `to` (both YYYY-MM-DD), e.g. 0 for the same day. */
export function daysBetween(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y!, (m ?? 1) - 1, d ?? 1)
  }
  return Math.round((ms(to) - ms(from)) / 86_400_000)
}
