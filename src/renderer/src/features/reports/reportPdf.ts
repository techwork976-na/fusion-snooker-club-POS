import { SHIFT_HEAD, STAFF_HEAD, type ReportDocument } from './reportModel'
import { SHIFT_DAY_HEAD, SHIFT_EXPENSE_HEAD, SHIFT_INVOICE_HEAD, type ShiftDocument } from './shiftReportModel'

/**
 * Renders reports as A4 PDFs: the admin's financial report and a staff
 * member's counter closing share one heading, section, table and footer
 * style. The PDF libraries are loaded only when someone exports, so they never
 * slow down the app itself.
 */
const FOREST: [number, number, number] = [10, 31, 20]
const INK: [number, number, number] = [38, 48, 42]
const MUTED: [number, number, number] = [110, 116, 108]
const RULE: [number, number, number] = [218, 209, 191]
const HEAD_FILL: [number, number, number] = [240, 234, 223]
const MARGIN = 16

interface Heading {
  businessName: string
  title: string
  period: string
  generated: string
  /** The word before the period in the heading ("Period", "Shift"). */
  periodLabel?: string
}

type CellStyles = Record<number, { cellWidth?: number; halign?: 'right' }>

/** A new A4 document with the club's heading, and the drawing helpers every report uses. */
async function startPdf(h: Heading) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  const width = doc.internal.pageSize.getWidth()
  const lastY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY

  doc.setProperties({ title: `${h.businessName} — ${h.title} — ${h.period}`, author: h.businessName, creator: 'FUSION' })

  // Heading
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(...FOREST)
  doc.text(h.businessName, MARGIN, 22)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(12)
  doc.setTextColor(...INK)
  doc.text(h.title, MARGIN, 29)
  doc.setFontSize(9.5)
  doc.setTextColor(...MUTED)
  doc.text(`${h.periodLabel ?? 'Period'}: ${h.period}`, width - MARGIN, 22, { align: 'right' })
  doc.text(`Generated: ${h.generated}`, width - MARGIN, 29, { align: 'right' })
  doc.setDrawColor(...FOREST)
  doc.setLineWidth(0.6)
  doc.line(MARGIN, 34, width - MARGIN, 34)

  // A section title never sits alone at the bottom of a page.
  const section = (title: string, at: number, aside?: string) => {
    let y = at
    if (y > doc.internal.pageSize.getHeight() - 40) {
      doc.addPage()
      y = 20
    }
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(...FOREST)
    doc.text(title, MARGIN, y)
    if (aside) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8)
      doc.setTextColor(...MUTED)
      doc.text(aside, width - MARGIN, y, { align: 'right' })
    }
    return y + 3
  }
  const tableStyle = {
    theme: 'plain' as const,
    margin: { left: MARGIN, right: MARGIN },
    styles: { font: 'helvetica', fontSize: 8.5, textColor: INK, cellPadding: { top: 1.8, bottom: 1.8, left: 2, right: 2 }, lineColor: RULE },
    headStyles: { fillColor: HEAD_FILL, textColor: FOREST, fontStyle: 'bold' as const, fontSize: 8 },
    bodyStyles: { lineWidth: { bottom: 0.15 } }
  }

  /** Label → amount table; the strong labels are set bold in forest. Returns where it ends. */
  const summaryTable = (title: string, at: number, body: [string, string][], strong: string[] = []) => {
    autoTable(doc, {
      ...tableStyle,
      startY: section(title, at),
      head: [['', 'Amount']],
      body,
      tableWidth: 110,
      columnStyles: { 0: { cellWidth: 70 }, 1: { halign: 'right' } },
      didParseCell: (data) => {
        const label = String(data.row.raw && (data.row.raw as string[])[0])
        if (data.section === 'body' && strong.includes(label)) {
          data.cell.styles.fontStyle = 'bold'
          data.cell.styles.textColor = FOREST
        }
      }
    })
    return lastY()
  }

  /** Small grey notes under a table. Returns where they end. */
  const notes = (at: number, lines: string[]) => {
    let y = at
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    for (const note of lines) {
      const wrapped = doc.splitTextToSize(note, width - 2 * MARGIN) as string[]
      doc.text(wrapped, MARGIN, y)
      y += wrapped.length * 3.6
    }
    return y
  }

  /** A titled data table (or its empty message); right-aligned columns from `rightFrom` on. Returns where it ends. */
  const dataTable = (t: {
    title: string
    at: number
    head: string[]
    body: string[][]
    empty: string
    columnStyles: CellStyles
    rightColumns: number[]
  }) => {
    autoTable(doc, {
      ...tableStyle,
      startY: section(t.title, t.at, 'Amounts in PKR'),
      head: [t.head],
      body: t.body.length > 0 ? t.body : [[{ content: t.empty, colSpan: t.head.length, styles: { textColor: MUTED } }]],
      columnStyles: t.body.length > 0 ? t.columnStyles : {},
      didParseCell: (data) => {
        if (data.section === 'head' && t.rightColumns.includes(data.column.index)) data.cell.styles.halign = 'right'
      }
    })
    return lastY()
  }

  /** Footer on every page. */
  const finish = (line: string) => {
    const pages = doc.getNumberOfPages()
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i)
      const h = doc.internal.pageSize.getHeight()
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7.5)
      doc.setTextColor(...MUTED)
      doc.text(line, MARGIN, h - 9)
      doc.text(`Page ${i} of ${pages}`, width - MARGIN, h - 9, { align: 'right' })
    }
    return doc
  }

  return { doc, summaryTable, notes, dataTable, finish }
}

/** Name and shift columns get room; amounts and counts (columns 2–8) are right-aligned. */
const reportColumns = (first: number, second: number): CellStyles => ({
  0: { cellWidth: first },
  1: { cellWidth: second },
  ...Object.fromEntries([2, 3, 4, 5, 6, 7, 8].map((i) => [i, { halign: 'right' as const }]))
})
const REPORT_RIGHT = [2, 3, 4, 5, 6, 7, 8]

export async function renderReportPdf(model: ReportDocument) {
  const pdf = await startPdf(model)

  let y = pdf.summaryTable('Overall totals', 44, model.summary, ['Total sales', 'Net after expenses'])
  y = pdf.notes(y + 6, model.notes)

  const table = (title: string, head: string[], body: string[][], empty: string, widths: [number, number]) => {
    y = pdf.dataTable({ title, at: y + 8, head, body, empty, columnStyles: reportColumns(...widths), rightColumns: REPORT_RIGHT })
  }

  if (model.live) y = pdf.summaryTable('Open counters — live, provisional figures (not final)', y + 8, model.live.summary)
  table('Staff summaries (closed shifts)', STAFF_HEAD, model.staff, 'No closed shifts in this period.', [36, 14])
  table('Closed shifts', SHIFT_HEAD, model.closedShifts, 'No closed shifts in this period.', [26, 47])
  if (model.live) table('Open counters (provisional)', SHIFT_HEAD, model.live.shifts, 'No open counters.', [26, 47])

  return pdf.finish(`${model.businessName} · ${model.title} · ${model.period}`)
}

/** A staff member's counter shift: totals, notes, (days), expenses and invoices. */
export async function renderShiftPdf(model: ShiftDocument) {
  const pdf = await startPdf({ ...model, periodLabel: 'Shift' })

  let y = pdf.summaryTable(model.open ? 'Shift totals so far (counter still open)' : 'Shift totals', 44, model.summary, [
    'Total sales',
    'Net after expenses'
  ])
  if (model.notes.length > 0) y = pdf.notes(y + 6, model.notes)

  if (model.days.length > 0) {
    y = pdf.dataTable({
      title: 'By business day',
      at: y + 8,
      head: SHIFT_DAY_HEAD,
      body: model.days,
      empty: '',
      columnStyles: { 0: { cellWidth: 46 }, ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [i, { halign: 'right' as const }])) },
      rightColumns: [1, 2, 3, 4, 5, 6]
    })
  }
  y = pdf.dataTable({
    title: 'Expenses',
    at: y + 8,
    head: SHIFT_EXPENSE_HEAD,
    body: model.expenses,
    empty: 'No expenses recorded.',
    columnStyles: { 0: { cellWidth: 24 }, 2: { halign: 'right', cellWidth: 28 }, 3: { cellWidth: 20 } },
    rightColumns: [2]
  })
  if (model.invoices) {
    pdf.dataTable({
      title: 'Invoices',
      at: y + 8,
      head: SHIFT_INVOICE_HEAD,
      body: model.invoices,
      empty: 'No invoices in this shift.',
      columnStyles: { 0: { cellWidth: 20 }, 1: { cellWidth: 22 }, 4: { halign: 'right', cellWidth: 22 }, 5: { halign: 'right', cellWidth: 26 } },
      rightColumns: [4, 5]
    })
  }

  return pdf.finish(`${model.businessName} · ${model.title} · ${model.period}`)
}

/** Renders the report and downloads it as a file. */
export async function exportReportPdf(model: ReportDocument): Promise<void> {
  const doc = await renderReportPdf(model)
  doc.save(model.fileName)
}

/** Renders a counter shift and downloads it as a file. */
export async function exportShiftPdf(model: ShiftDocument): Promise<void> {
  const doc = await renderShiftPdf(model)
  doc.save(model.fileName)
}
