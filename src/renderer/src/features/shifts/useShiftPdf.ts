import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { errorMessage } from '@/lib/errors'
import type { ShiftDetail } from '@/lib/types'
import { getShiftDetail } from '@/data/api'
import { keys, useSettings } from '@/data/hooks'
import { useToast } from '@/components/ui/Toast'
import { exportShiftPdf } from '@/features/reports/reportPdf'
import { buildShiftDocument } from '@/features/reports/shiftReportModel'

/**
 * Exports a counter shift (its closing, or the figures so far while it is
 * open) as a PDF to send to the owner. Takes the shift's detail, or its id —
 * then the latest figures are fetched first. The database decides what the
 * account may see (staff: their own shifts; invoice lines only with the
 * "view own sales" permission).
 */
export function useShiftPdf() {
  const queryClient = useQueryClient()
  const { data: settings } = useSettings()
  const toast = useToast()
  const [exporting, setExporting] = useState(false)

  const exportShift = async (shift: ShiftDetail | string) => {
    setExporting(true)
    try {
      const detail =
        typeof shift === 'string' ? await queryClient.fetchQuery({ queryKey: keys.shift(shift), queryFn: () => getShiftDetail(shift) }) : shift
      await exportShiftPdf(buildShiftDocument(detail, { timeZone: settings?.business_timezone, clubName: settings?.club_name }))
      toast.success(detail.status === 'open' ? 'Shift exported as PDF (figures so far).' : 'Closing exported as PDF.')
    } catch (e) {
      toast.error(`Could not create the PDF: ${errorMessage(e)}`)
    } finally {
      setExporting(false)
    }
  }
  return { exporting, exportShift }
}
