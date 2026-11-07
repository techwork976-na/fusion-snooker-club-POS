import { formatBusinessDate, formatDateTime, formatMoney, formatTime, paymentLabel } from '@shared/format'
import type { ShiftDetail } from '../../lib/types'
import { BUSINESS_NAME } from './reportModel'

/**
 * A counter shift's closing as plain rows — the PDF a staff member sends the
 * owner at night (and an admin can export for any shift). Built from the same
 * shift detail the app shows, so the PDF can never show different figures.
 */
export interface ShiftDocument {
  businessName: string
  title: string
  staffName: string
  /** "05 Nov 2026, 06:02 PM – 11:48 PM" (or "… – open now"). */
  period: string
  generated: string
  open: boolean
  summary: [string, string][]
  notes: string[]
  /** Business day, cash, bank, total, snacks, expenses, invoices — only when the shift spans days. */
  days: string[][]
  expenses: string[][]
  /** Null when the account may not see invoice details. */
  invoices: string[][] | null
  fileName: string
}

export const SHIFT_DAY_HEAD = ['Business day', 'Cash', 'Bank', 'Total', 'Snacks', 'Expenses', 'Invoices']
export const SHIFT_EXPENSE_HEAD = ['Time', 'Description', 'Amount', '']
export const SHIFT_INVOICE_HEAD = ['Receipt', 'Time', 'Table', 'Payment', 'Discount', 'Total']

const amount = (v: number) => formatMoney(v, false)

/** "05 Nov 2026, 06:02 PM – 11:48 PM"; the closing date is repeated only when the shift crossed midnight. */
export function shiftPeriod(s: Pick<ShiftDetail, 'opened_at' | 'closed_at'>, timeZone?: string): string {
  const opened = formatDateTime(s.opened_at, timeZone)
  if (!s.closed_at) return `${opened} – open now`
  const sameDay =
    new Date(s.opened_at).toLocaleDateString('en-GB', { timeZone }) === new Date(s.closed_at).toLocaleDateString('en-GB', { timeZone })
  return `${opened} – ${sameDay ? formatTime(s.closed_at, timeZone) : formatDateTime(s.closed_at, timeZone)}`
}

function payment(inv: ShiftDetail['invoice_list'][number]): string {
  if (inv.payment_method === 'split' && inv.split_cash_amount != null) {
    return `Cash ${amount(inv.split_cash_amount)} + Bank ${amount(Number(inv.final_amount) - Number(inv.split_cash_amount))}`
  }
  return paymentLabel(inv.payment_method)
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'staff'

export function buildShiftDocument(
  s: ShiftDetail,
  opts: { timeZone?: string; clubName?: string | null; now?: Date } = {}
): ShiftDocument {
  const { timeZone } = opts
  const open = s.status === 'open'
  const notes: string[] = []
  if (open) notes.push('This counter is still open: the figures are provisional until it is closed.')
  if (!open && s.closed_by_self === false && s.closed_by_name) notes.push(`Closed by ${s.closed_by_name}.`)
  if (s.voided_count > 0) notes.push(`${s.voided_count} invoice${s.voided_count === 1 ? '' : 's'} voided (${formatMoney(s.voided_amount)}), not counted in the totals.`)
  if (s.expense_list.some((e) => e.voided_at)) notes.push('Voided expenses are listed but not counted.')
  if (s.handover_sessions > 0) notes.push(`${s.handover_sessions} table session(s) were handed over at closing and are paid at another counter.`)
  if (s.imported) notes.push('Imported from before counter shifts existed: the times are the first and last sale.')
  if (!s.invoices_visible) notes.push('Invoice details are not included for this account.')
  else if (s.retained_invoices < s.invoices) {
    notes.push(
      `${s.invoices - s.retained_invoices} older invoice(s) have expired under the ${s.retention_days}-day retention policy; the totals above are permanent and complete.`
    )
  }

  const title = open ? 'Counter shift (open)' : 'Counter closing'
  return {
    businessName: opts.clubName?.trim() || BUSINESS_NAME,
    title: `${title} — ${s.staff_name}`,
    staffName: s.staff_name,
    period: shiftPeriod(s, timeZone),
    generated: formatDateTime((opts.now ?? new Date()).toISOString(), timeZone),
    open,
    summary: [
      ['Total sales', formatMoney(s.total)],
      ['Cash', formatMoney(s.cash)],
      ['Bank transfer', formatMoney(s.bank)],
      ['Snack sales (part of total sales)', formatMoney(s.snack)],
      ['Discounts given', formatMoney(s.discounts)],
      ['Expenses', formatMoney(s.expenses)],
      ['Net after expenses', formatMoney(s.net)],
      ['Invoices', String(s.invoices)]
    ],
    notes,
    days:
      s.days.length > 1
        ? s.days.map((d) => [formatBusinessDate(d.business_date), amount(d.cash), amount(d.bank), amount(d.total), amount(d.snack), amount(d.expenses), String(d.invoices)])
        : [],
    expenses: s.expense_list.map((e) => [formatTime(e.created_at, timeZone), e.description, amount(e.amount), e.voided_at ? 'Voided' : '']),
    invoices: s.invoices_visible
      ? s.invoice_list.map((inv) => [
          `#${inv.receipt_no}`,
          formatTime(inv.created_at, timeZone),
          inv.table_name ?? 'Counter sale',
          payment(inv),
          Number(inv.discount) > 0 ? amount(inv.discount) : '—',
          amount(inv.final_amount)
        ])
      : null,
    fileName: `FUSION-${open ? 'shift' : 'closing'}-${slug(s.staff_name)}-${s.business_date}.pdf`
  }
}
