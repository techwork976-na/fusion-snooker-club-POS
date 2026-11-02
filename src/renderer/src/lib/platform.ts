import type { AppInfo, PrinterInfo } from '@shared/ipc'
import { renderReceiptHtml, type PrintOptions, type Receipt } from '@shared/receipt'
import { validateServerConfig } from '@shared/serverConfig'

/**
 * Everything that differs between the web app (the product, served from
 * Vercel) and the optional Windows desktop build. The desktop build exposes a
 * narrow preload bridge as `window.fusion`; the browser has none.
 */
export const isDesktop = typeof window !== 'undefined' && 'fusion' in window

export interface ClientConfig {
  supabaseUrl: string
  supabaseKey: string
}

export type ConfigResult = { ok: true; config: ClientConfig } | { ok: false; message: string }

/**
 * The Supabase project is fixed by the deployment (environment variables set at
 * build time) — clients never type a server address or key.
 */
export async function loadClientConfig(): Promise<ConfigResult> {
  if (isDesktop) {
    const c = await window.fusion.config.get()
    if (!c) return { ok: false, message: 'This copy of FUSION was built without its server settings.' }
    return { ok: true, config: { supabaseUrl: c.supabaseUrl, supabaseKey: c.supabaseAnonKey } }
  }
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) return { ok: false, message: 'This deployment is missing its Supabase settings.' }
  const invalid = validateServerConfig(url, key)
  if (invalid) return { ok: false, message: invalid }
  return { ok: true, config: { supabaseUrl: new URL(url).origin, supabaseKey: key } }
}

export async function getAppInfo(): Promise<AppInfo> {
  if (isDesktop) return window.fusion.app.info()
  return { version: __APP_VERSION__, platform: 'web', packaged: import.meta.env.PROD }
}

/** Only the desktop app can list printers and print without a dialog. */
export const canChoosePrinter = isDesktop

export async function listPrinters(): Promise<PrinterInfo[]> {
  return isDesktop ? window.fusion.printer.list() : []
}

export async function printReceiptDocument(receipt: Receipt, options: PrintOptions): Promise<{ ok: boolean; error?: string }> {
  if (isDesktop) return window.fusion.printer.printReceipt(receipt, options)
  return printInBrowser(renderReceiptHtml(receipt, { paper: options.paper, timeZone: options.timeZone }))
}

/**
 * Prints a generated receipt through the browser's print dialog from a hidden
 * frame. The frame is sandboxed without scripts: the receipt HTML is escaped
 * data and can never run code.
 */
function printInBrowser(html: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-modals allow-same-origin')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none'
    const cleanup = () => setTimeout(() => frame.remove(), 1_000)
    frame.onload = () => {
      const win = frame.contentWindow
      if (!win) {
        frame.remove()
        resolve({ ok: false, error: 'This browser cannot print from FUSION.' })
        return
      }
      try {
        win.focus()
        win.print()
        resolve({ ok: true })
      } catch {
        resolve({ ok: false, error: 'This browser cannot print from FUSION.' })
      } finally {
        cleanup()
      }
    }
    frame.srcdoc = html
    document.body.appendChild(frame)
  })
}
