import type { PrintOptions, Receipt } from '@shared/receipt'
import { canChoosePrinter, printReceiptDocument } from '@/lib/platform'

/**
 * Printer preferences are per terminal (each counter has its own printer).
 * Choosing a printer and printing without a dialog need the desktop app; in a
 * browser the print dialog picks the printer.
 */
export interface PrinterPrefs {
  paper: PrintOptions['paper']
  silent: boolean
  deviceName: string
  autoPrint: boolean
}

const KEY = 'fusion.printer'
const DEFAULTS: PrinterPrefs = { paper: '80mm', silent: false, deviceName: '', autoPrint: false }

export function readPrinterPrefs(): PrinterPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PrinterPrefs>) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

export function writePrinterPrefs(prefs: PrinterPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // Preferences are a convenience only.
  }
}

export async function printReceipt(receipt: Receipt, timeZone?: string) {
  const prefs = readPrinterPrefs()
  return printReceiptDocument(receipt, {
    paper: prefs.paper,
    silent: canChoosePrinter && prefs.silent && Boolean(prefs.deviceName),
    deviceName: (canChoosePrinter && prefs.deviceName) || undefined,
    timeZone
  })
}
