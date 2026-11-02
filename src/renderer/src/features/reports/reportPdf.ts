import { SHIFT_HEAD, STAFF_HEAD, type ReportDocument } from './reportModel'

/**
 * Renders the report as an A4 PDF. The PDF libraries are loaded only when
 * someone exports, so they never slow down the app itself.
 */
const FOREST: [number, number, number] = [10, 31, 20]
const INK: [number, number, number] = [38, 48, 42]
const MUTED: [number, number, number] = [110, 116, 108]
const RULE: [number, number, number] = [218, 209, 191]
const HEAD_FILL: [number, number, number] = [240, 234, 223]
const MARGIN = 16

export async function renderReportPdf(model: ReportDocument) {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  const width = doc.internal.pageSize.getWidth()
  const lastY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY

  doc.setProperties({ title: `${model.businessName} — ${model.title} — ${model.period}`, author: model.businessName, creator: 'FUSION' })

  // Heading
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(...FOREST)
  doc.text(model.businessName, MARGIN, 22)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(12)
  doc.setTextColor(...INK)
  doc.text(model.title, MARGIN, 29)
  doc.setFontSize(9.5)
  doc.setTextColor(...MUTED)
  doc.text(`Period: ${model.period}`, width - MARGIN, 22, { align: 'right' })
  doc.text(`Generated: ${model.generated}`, width - MARGIN, 29, { align: 'right' })
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
  // Name and shift columns get room; amounts and counts are right-aligned.
  const columns = (first: number, second: number) => ({
    0: { cellWidth: first },
    1: { cellWidth: second },
    ...Object.fromEntries([2, 3, 4, 5, 6, 7, 8].map((i) => [i, { halign: 'right' as const }]))
  })

  // Overall totals
  autoTable(doc, {
    ...tableStyle,
    startY: section('Overall totals', 44),
    head: [['', 'Amount']],
    body: model.summary,
    tableWidth: 110,
    columnStyles: { 0: { cellWidth: 70 }, 1: { halign: 'right' } },
    didParseCell: (data) => {
      const label = String(data.row.raw && (data.row.raw as string[])[0])
      if (data.section === 'body' && (label === 'Total sales' || label === 'Net after expenses')) {
        data.cell.styles.fontStyle = 'bold'
        data.cell.styles.textColor = FOREST
      }
    }
  })

  let y = lastY() + 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  for (const note of model.notes) {
    const lines = doc.splitTextToSize(note, width - 2 * MARGIN) as string[]
    doc.text(lines, MARGIN, y)
    y += lines.length * 3.6
  }

  const table = (title: string, head: string[], body: string[][], empty: string, widths: [number, number]) => {
    autoTable(doc, {
      ...tableStyle,
      startY: section(title, y + 8, 'Amounts in PKR'),
      head: [head],
      body: body.length > 0 ? body : [[{ content: empty, colSpan: head.length, styles: { textColor: MUTED } }]],
      columnStyles: body.length > 0 ? columns(...widths) : {},
      didParseCell: (data) => {
        if (data.section === 'head' && data.column.index >= 2) data.cell.styles.halign = 'right'
      }
    })
    y = lastY()
  }

  if (model.live) {
    autoTable(doc, {
      ...tableStyle,
      startY: section('Open counters — live, provisional figures (not final)', y + 8),
      head: [['', 'Amount']],
      body: model.live.summary,
      tableWidth: 110,
      columnStyles: { 0: { cellWidth: 70 }, 1: { halign: 'right' } }
    })
    y = lastY()
  }
  table('Staff summaries (closed shifts)', STAFF_HEAD, model.staff, 'No closed shifts in this period.', [36, 14])
  table('Closed shifts', SHIFT_HEAD, model.closedShifts, 'No closed shifts in this period.', [26, 47])
  if (model.live) table('Open counters (provisional)', SHIFT_HEAD, model.live.shifts, 'No open counters.', [26, 47])

  // Footer on every page
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    const h = doc.internal.pageSize.getHeight()
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...MUTED)
    doc.text(`${model.businessName} · ${model.title} · ${model.period}`, MARGIN, h - 9)
    doc.text(`Page ${i} of ${pages}`, width - MARGIN, h - 9, { align: 'right' })
  }

  return doc
}

/** Renders the report and downloads it as a file. */
export async function exportReportPdf(model: ReportDocument): Promise<void> {
  const doc = await renderReportPdf(model)
  doc.save(model.fileName)
}
