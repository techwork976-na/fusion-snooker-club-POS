import { BrowserWindow, type WebContents } from 'electron'
import { renderReceiptHtml, type PrintOptions, type Receipt } from '@shared/receipt'
import type { PrinterInfo } from '@shared/ipc'

/**
 * Prints a receipt from a hidden, sandboxed window with JavaScript disabled.
 * The receipt document is generated here from validated data — the renderer
 * never supplies HTML.
 */
export async function printReceipt(receipt: Receipt, options: PrintOptions): Promise<{ ok: boolean; error?: string }> {
  const html = renderReceiptHtml(receipt, { paper: options.paper, timeZone: options.timeZone })
  const win = new BrowserWindow({
    show: false,
    width: 420,
    height: 800,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return await new Promise((resolve) => {
      win.webContents.print(
        {
          silent: options.silent,
          deviceName: options.deviceName || undefined,
          printBackground: false,
          margins: { marginType: 'none' }
        },
        (success, failureReason) => {
          resolve(success ? { ok: true } : { ok: false, error: failureReason || 'Printing was cancelled.' })
        }
      )
    })
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

export async function listPrinters(contents: WebContents): Promise<PrinterInfo[]> {
  const printers = await contents.getPrintersAsync()
  return printers.map((p) => ({
    name: p.name,
    displayName: p.displayName || p.name,
    isDefault: Boolean((p as { isDefault?: boolean }).isDefault)
  }))
}
