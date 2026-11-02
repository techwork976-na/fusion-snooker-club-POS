/**
 * The Reports page and its PDF are built from one model, so every figure in
 * the PDF is the figure on screen. Renders a real PDF and reads it back.
 */
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildReportDocument, summaryLines } from '../../src/renderer/src/features/reports/reportModel'
import { renderReportPdf } from '../../src/renderer/src/features/reports/reportPdf'
import { formatMoney } from '@shared/format'
import type { FinancialReport } from '../../src/renderer/src/lib/types'

const shift = (over: Partial<FinancialReport['closed_shifts'][number]>) => ({
  id: 'x',
  staff_name: 'Ali Raza',
  status: 'closed' as const,
  business_date: '2026-11-02',
  opened_at: '2026-11-02T09:00:00Z',
  closed_at: '2026-11-02T17:30:00Z',
  imported: false,
  cash: 12_500,
  bank: 4_250,
  total: 16_750,
  snack: 3_100,
  discounts: 200,
  expenses: 600,
  net: 16_150,
  invoices: 31,
  voided: 1,
  partial: false,
  ...over
})

const report: FinancialReport = {
  from: '2026-11-01',
  to: '2026-11-02',
  generated_at: '2026-11-02T18:00:00Z',
  club_name: 'FUSION',
  timezone: 'Asia/Karachi',
  final: {
    cash: 20_000,
    bank: 6_250,
    total: 26_250,
    snack: 5_400,
    discounts: 350,
    counter_expenses: 900,
    business_expenses: 15_000,
    expenses: 15_900,
    net: 10_350,
    invoices: 52,
    voided: 1,
    shifts: 2,
    legacy: 0
  },
  live: { cash: 1_400, bank: 0, total: 1_400, snack: 300, discounts: 0, expenses: 0, net: 1_400, invoices: 3, shifts: 1 },
  days: [],
  by_staff: [
    { user_id: 'a', name: 'Ali Raza', shifts: 1, cash: 12_500, bank: 4_250, total: 16_750, snack: 3_100, discounts: 200, expenses: 600, net: 16_150, invoices: 31 },
    { user_id: 'b', name: 'Sara Khan', shifts: 1, cash: 7_500, bank: 2_000, total: 9_500, snack: 2_300, discounts: 150, expenses: 300, net: 9_200, invoices: 21 }
  ],
  closed_shifts: [
    shift({}),
    shift({ id: 'y', staff_name: 'Sara Khan', cash: 7_500, bank: 2_000, total: 9_500, snack: 2_300, expenses: 300, net: 9_200, invoices: 21, partial: true })
  ],
  open_shifts: [shift({ id: 'z', staff_name: 'Bilal', status: 'open', closed_at: null, cash: 1_400, bank: 0, total: 1_400, snack: 300, expenses: 0, net: 1_400, invoices: 3 })]
}

describe('report PDF', () => {
  it('carries exactly the on-screen figures, the period and the business name', async () => {
    const model = buildReportDocument(report, new Date('2026-11-02T18:05:00Z'))
    expect(model.businessName).toBe('FUSION Gaming Lounge')
    expect(model.period).toBe('Sun, 1 Nov 2026 – Mon, 2 Nov 2026')
    expect(model.generated).toBe('02 Nov 2026, 11:05 PM') // Karachi time
    expect(model.summary.slice(0, 9)).toEqual(summaryLines(report).map((l) => [l.label, formatMoney(l.value)]))
    expect(model.summary).toContainEqual(['Total sales', 'PKR 26,250'])
    expect(model.summary).toContainEqual(['Net after expenses', 'PKR 10,350'])
    expect(model.summary).toContainEqual(['Closed shifts', '2'])
    expect(model.live?.summary).toContainEqual(['Sales so far', 'PKR 1,400'])
    expect(model.closedShifts[1]![1]).toMatch(/\*$/) // the partial shift is marked
    expect(model.notes.some((n) => n.includes('outside this period'))).toBe(true)
    expect(model.fileName).toBe('FUSION-report-2026-11-01-to-2026-11-02.pdf')

    const doc = await renderReportPdf(model)
    const bytes = Buffer.from(doc.output('arraybuffer'))
    if (process.env.FUSION_PDF_OUT) writeFileSync(process.env.FUSION_PDF_OUT, bytes)
    const text = bytes.toString('latin1')
    expect(text.startsWith('%PDF-')).toBe(true)
    for (const s of ['FUSION Gaming Lounge', 'Financial report', 'PKR 26,250', 'PKR 20,000', 'PKR 6,250', 'PKR 5,400', 'PKR 15,900', 'PKR 10,350', '(16,750)', '(9,200)', 'Ali Raza', 'Sara Khan', 'Bilal', 'Amounts in PKR', 'Page 1 of']) {
      expect(text, s).toContain(s)
    }
  })
})
