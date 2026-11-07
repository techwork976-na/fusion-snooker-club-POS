/**
 * A staff member's counter closing as a PDF (My sales → Export PDF, and the
 * shift panel). Built from the shift detail the app shows; renders a real PDF
 * and reads it back.
 */
import { describe, expect, it } from 'vitest'
import { buildShiftDocument } from '../../src/renderer/src/features/reports/shiftReportModel'
import { renderShiftPdf } from '../../src/renderer/src/features/reports/reportPdf'
import type { ShiftDetail } from '../../src/renderer/src/lib/types'

const tz = 'Asia/Karachi'
const closed: ShiftDetail = {
  id: 's1',
  user_id: 'u1',
  staff_name: 'Ali Raza',
  status: 'closed',
  business_date: '2026-11-05',
  opened_at: '2026-11-05T13:00:00Z', // 6:00 PM in Karachi
  closed_at: '2026-11-05T18:45:00Z', // 11:45 PM
  closed_by_name: 'Ali Raza',
  closed_by_self: true,
  cash: 1_310,
  bank: 1_000,
  snack: 540,
  discounts: 10,
  total: 2_310,
  expenses: 150,
  net: 2_160,
  invoices: 3,
  voided_count: 1,
  voided_amount: 100,
  handover_sessions: 0,
  imported: false,
  details_purged_at: null,
  open_sessions: 0,
  retained_invoices: 3,
  days: [{ business_date: '2026-11-05', cash: 1_310, bank: 1_000, snack: 540, expenses: 150, invoices: 3, total: 2_310 }],
  expense_list: [
    { id: 'e1', amount: 150, description: 'Milk for tea', created_at: '2026-11-05T15:10:00Z', voided_at: null },
    { id: 'e2', amount: 80, description: 'Entered twice', created_at: '2026-11-05T15:12:00Z', voided_at: '2026-11-05T15:13:00Z' }
  ],
  invoices_visible: true,
  retention_days: 30,
  invoice_list: [
    invoice({ receipt_no: 101, table_name: 'Snooker 1', payment_method: 'cash', final_amount: 770, discount: 10 }),
    invoice({ receipt_no: 102, table_name: null, payment_method: 'bank_transfer', final_amount: 540 }),
    invoice({ receipt_no: 103, table_name: 'PS5 Lounge', payment_method: 'split', split_cash_amount: 600, final_amount: 1_000 })
  ]
}

function invoice(over: Partial<ShiftDetail['invoice_list'][number]>): ShiftDetail['invoice_list'][number] {
  return {
    id: `i${over.receipt_no}`,
    receipt_no: 0,
    created_at: '2026-11-05T16:00:00Z',
    business_date: '2026-11-05',
    table_name: null,
    customer_name: null,
    customer_phone: null,
    payment_method: 'cash',
    split_cash_amount: null,
    session_seconds: null,
    rate_per_minute: null,
    standard_rate_per_minute: null,
    standard_base_amount: null,
    base_amount: 0,
    products_subtotal: 0,
    discount: 0,
    final_amount: 0,
    items: [],
    ...over
  }
}

const now = new Date('2026-11-05T18:50:00Z')
const text = async (s: ShiftDetail) => Buffer.from((await renderShiftPdf(buildShiftDocument(s, { timeZone: tz, now }))).output('arraybuffer')).toString('latin1')

describe('counter closing PDF', () => {
  it('carries the shift figures exactly as the app shows them', () => {
    const doc = buildShiftDocument(closed, { timeZone: tz, now })
    expect(doc.title).toBe('Counter closing — Ali Raza')
    expect(doc.period).toBe('05 Nov 2026, 06:00 PM – 11:45 PM')
    expect(doc.summary).toEqual([
      ['Total sales', 'PKR 2,310'],
      ['Cash', 'PKR 1,310'],
      ['Bank transfer', 'PKR 1,000'],
      ['Snack sales (part of total sales)', 'PKR 540'],
      ['Discounts given', 'PKR 10'],
      ['Expenses', 'PKR 150'],
      ['Net after expenses', 'PKR 2,160'],
      ['Invoices', '3']
    ])
    expect(doc.fileName).toBe('FUSION-closing-ali-raza-2026-11-05.pdf')
  })

  it('lists expenses (voided ones marked, not counted) and invoices with split payments in both parts', () => {
    const doc = buildShiftDocument(closed, { timeZone: tz, now })
    expect(doc.expenses).toEqual([
      ['08:10 PM', 'Milk for tea', '150', ''],
      ['08:12 PM', 'Entered twice', '80', 'Voided']
    ])
    expect(doc.invoices).toEqual([
      ['#101', '09:00 PM', 'Snooker 1', 'Cash', '10', '770'],
      ['#102', '09:00 PM', 'Counter sale', 'Bank Transfer', '—', '540'],
      ['#103', '09:00 PM', 'PS5 Lounge', 'Cash 600 + Bank 400', '—', '1,000']
    ])
    expect(doc.notes).toEqual(['1 invoice voided (PKR 100), not counted in the totals.', 'Voided expenses are listed but not counted.'])
    expect(doc.days).toEqual([]) // a one-day shift needs no day table
  })

  it('marks an open shift as provisional', () => {
    const open = { ...closed, status: 'open' as const, closed_at: null, closed_by_name: null, closed_by_self: null }
    const doc = buildShiftDocument(open, { timeZone: tz, now })
    expect(doc.title).toBe('Counter shift (open) — Ali Raza')
    expect(doc.period).toBe('05 Nov 2026, 06:00 PM – open now')
    expect(doc.notes[0]).toBe('This counter is still open: the figures are provisional until it is closed.')
    expect(doc.fileName).toBe('FUSION-shift-ali-raza-2026-11-05.pdf')
  })

  it('respects what the account may see and says when old invoices have expired', () => {
    expect(buildShiftDocument({ ...closed, invoices_visible: false, invoice_list: [] }, { timeZone: tz, now })).toMatchObject({
      invoices: null,
      notes: expect.arrayContaining(['Invoice details are not included for this account.'])
    })
    const expired = buildShiftDocument({ ...closed, retained_invoices: 1, invoice_list: closed.invoice_list.slice(0, 1) }, { timeZone: tz, now })
    expect(expired.notes).toContain('2 older invoice(s) have expired under the 30-day retention policy; the totals above are permanent and complete.')
    expect(buildShiftDocument({ ...closed, closed_by_self: false, closed_by_name: 'Owner' }, { timeZone: tz, now }).notes).toContain('Closed by Owner.')
  })

  it('shows a shift that crossed into another business day, day by day', () => {
    const doc = buildShiftDocument(
      {
        ...closed,
        closed_at: '2026-11-06T02:30:00Z',
        days: [
          { business_date: '2026-11-05', cash: 1_000, bank: 500, snack: 300, expenses: 150, invoices: 2, total: 1_500 },
          { business_date: '2026-11-06', cash: 310, bank: 500, snack: 240, expenses: 0, invoices: 1, total: 810 }
        ]
      },
      { timeZone: tz, now }
    )
    expect(doc.period).toBe('05 Nov 2026, 06:00 PM – 06 Nov 2026, 07:30 AM')
    expect(doc.days).toEqual([
      ['Thu, 5 Nov 2026', '1,000', '500', '1,500', '300', '150', '2'],
      ['Fri, 6 Nov 2026', '310', '500', '810', '240', '0', '1']
    ])
  })

  it('renders a real PDF with the same figures', async () => {
    const pdf = await text(closed)
    expect(pdf.startsWith('%PDF-')).toBe(true)
    for (const t of ['FUSION Gaming Lounge', 'Counter closing', 'Ali Raza', 'Shift totals', 'PKR 2,310', 'PKR 2,160', 'Milk for tea', 'Voided', '#103', 'Cash 600 + Bank 400', 'Page 1 of 1']) {
      expect(pdf, t).toContain(t)
    }
    expect(await text({ ...closed, invoices_visible: false, invoice_list: [] })).not.toContain('#101')
  })
})
