import { useEffect, useState } from 'react'
import { FileDown } from 'lucide-react'
import { useBusinessDate, useMyCounter } from '@/data/hooks'
import { Button } from '@/components/ui/Button'
import { LoadingBlock, Page, PageHeader } from '@/components/ui/Misc'
import { useShiftPdf } from '@/features/shifts/useShiftPdf'
import { TransactionsPanel } from './TransactionsPanel'
import { rangeFor, type Range } from './DateRange'

/** A staff member's own invoices (admins use History), and their shift closing as a PDF. */
export function SalesPage() {
  const { data: today } = useBusinessDate()
  const [range, setRange] = useState<Range | null>(null)
  const { data: counter } = useMyCounter()
  const { exporting, exportShift } = useShiftPdf()
  // The open shift; once it is closed, the last closing.
  const target = counter?.shift ?? counter?.recent[0] ?? null

  useEffect(() => {
    if (today && !range) setRange(rangeFor('today', today))
  }, [today, range])

  return (
    <Page>
      <PageHeader
        title="My sales"
        subtitle="Invoices from your own counter shifts. Export PDF saves your open shift (or, once closed, your last closing) to send to the owner."
        actions={
          <Button
            variant="primary"
            icon={<FileDown className="size-4" />}
            loading={exporting}
            disabled={!target}
            title={target ? undefined : 'Open your counter first — there is no shift to export yet.'}
            onClick={() => target && void exportShift(target.id)}
            data-testid="export-shift-pdf"
          >
            Export PDF
          </Button>
        }
      />
      {!today || !range ? <LoadingBlock /> : <TransactionsPanel range={range} onRange={setRange} today={today} />}
    </Page>
  )
}
