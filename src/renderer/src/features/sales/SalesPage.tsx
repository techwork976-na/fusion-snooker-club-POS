import { useEffect, useState } from 'react'
import { useBusinessDate } from '@/data/hooks'
import { LoadingBlock, Page, PageHeader } from '@/components/ui/Misc'
import { TransactionsPanel } from './TransactionsPanel'
import { rangeFor, type Range } from './DateRange'

/** A staff member's own invoices (admins use History). */
export function SalesPage() {
  const { data: today } = useBusinessDate()
  const [range, setRange] = useState<Range | null>(null)

  useEffect(() => {
    if (today && !range) setRange(rangeFor('today', today))
  }, [today, range])

  return (
    <Page>
      <PageHeader title="My sales" subtitle="Invoices from your own counter shifts." />
      {!today || !range ? <LoadingBlock /> : <TransactionsPanel range={range} onRange={setRange} today={today} />}
    </Page>
  )
}
