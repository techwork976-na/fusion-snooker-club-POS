import { formatBusinessDate, formatDateTime, formatMoney, formatTime } from '@shared/format'
import type { FinancialReport, ReportShift } from '@/lib/types'

/**
 * The report's content as plain rows. The Reports page and the exported PDF
 * are both built from this, so the PDF can never show different figures.
 */
export const BUSINESS_NAME = 'FUSION Gaming Lounge'

export interface SummaryLine {
  label: string
  value: number
  strong?: boolean
}

export function summaryLines(r: FinancialReport): SummaryLine[] {
  const f = r.final
  return [
    { label: 'Total sales', value: f.total, strong: true },
    { label: 'Cash', value: f.cash },
    { label: 'Bank transfer', value: f.bank },
    { label: 'Snack sales (part of total sales)', value: f.snack },
    { label: 'Discounts given', value: f.discounts },
    { label: 'Counter expenses', value: f.counter_expenses },
    { label: 'Business expenses', value: f.business_expenses },
    { label: 'Total expenses', value: f.expenses },
    { label: 'Net after expenses', value: f.net, strong: true }
  ]
}

export function periodText(r: Pick<FinancialReport, 'from' | 'to'>): string {
  return r.from === r.to ? formatBusinessDate(r.from) : `${formatBusinessDate(r.from)} – ${formatBusinessDate(r.to)}`
}

export function shiftWhen(s: ReportShift, timeZone?: string): string {
  const opened = formatDateTime(s.opened_at, timeZone)
  if (!s.closed_at) return `${opened} – open`
  return `${opened} – ${formatTime(s.closed_at, timeZone)}`
}

// Table amounts are plain rupee figures; the PDF states "Amounts in PKR" once.
export const STAFF_HEAD = ['Staff', 'Shifts', 'Cash', 'Bank', 'Total', 'Snacks', 'Expenses', 'Net', 'Invoices']
export const SHIFT_HEAD = ['Staff', 'Shift', 'Cash', 'Bank', 'Total', 'Snacks', 'Expenses', 'Net', 'Invoices']
const amount = (v: number) => formatMoney(v, false)

export function staffRows(r: FinancialReport): string[][] {
  return r.by_staff.map((s) => [
    s.name,
    String(s.shifts),
    amount(s.cash),
    amount(s.bank),
    amount(s.total),
    amount(s.snack),
    amount(s.expenses),
    amount(s.net),
    String(s.invoices)
  ])
}

/** "2 Nov, 02:00 PM – 10:30 PM" — compact enough for a printed table. */
function shiftWhenShort(s: ReportShift, timeZone?: string): string {
  const day = new Date(s.opened_at).toLocaleDateString('en-GB', { timeZone, day: 'numeric', month: 'short' })
  return `${day}, ${formatTime(s.opened_at, timeZone)} – ${s.closed_at ? formatTime(s.closed_at, timeZone) : 'open'}`
}

export function shiftRows(shifts: ReportShift[], timeZone?: string): string[][] {
  return shifts.map((s) => [
    s.staff_name,
    shiftWhenShort(s, timeZone) + (s.partial ? ' *' : ''),
    amount(s.cash),
    amount(s.bank),
    amount(s.total),
    amount(s.snack),
    amount(s.expenses),
    amount(s.net),
    String(s.invoices)
  ])
}

export interface ReportDocument {
  businessName: string
  title: string
  period: string
  generated: string
  summary: [string, string][]
  notes: string[]
  staff: string[][]
  closedShifts: string[][]
  live: { summary: [string, string][]; shifts: string[][] } | null
  fileName: string
}

export function buildReportDocument(r: FinancialReport, now = new Date()): ReportDocument {
  const notes: string[] = [
    'Final figures come from closed counter shifts. Open counters are listed separately and are provisional.'
  ]
  if (r.final.legacy > 0) notes.push(`Includes ${formatMoney(r.final.legacy)} archived before staff accounting existed (no staff breakdown).`)
  if (r.closed_shifts.some((s) => s.partial)) notes.push('* The shift also traded outside this period; only its figures within the period are shown.')
  return {
    businessName: BUSINESS_NAME,
    title: 'Financial report',
    period: periodText(r),
    generated: formatDateTime(now.toISOString(), r.timezone),
    summary: [
      ...summaryLines(r).map((l): [string, string] => [l.label, formatMoney(l.value)]),
      ['Closed shifts', String(r.final.shifts)],
      ['Invoices', String(r.final.invoices)]
    ],
    notes,
    staff: staffRows(r),
    closedShifts: shiftRows(r.closed_shifts, r.timezone),
    live:
      r.open_shifts.length > 0
        ? {
            summary: [
              ['Sales so far', formatMoney(r.live.total)],
              ['Cash', formatMoney(r.live.cash)],
              ['Bank transfer', formatMoney(r.live.bank)],
              ['Expenses so far', formatMoney(r.live.expenses)],
              ['Open counters', String(r.live.shifts)]
            ],
            shifts: shiftRows(r.open_shifts, r.timezone)
          }
        : null,
    fileName: `FUSION-report-${r.from}${r.from === r.to ? '' : `-to-${r.to}`}.pdf`
  }
}
