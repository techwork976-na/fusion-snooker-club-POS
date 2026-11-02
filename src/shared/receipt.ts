import { z } from 'zod'
import { formatDateTime, formatDuration, formatMoney, formatRate, paymentLabel } from './format'

/** Receipt as returned by complete_checkout / get_receipt. */
export const receiptSchema = z.object({
  sale_id: z.string().uuid(),
  receipt_no: z.number().int().nonnegative(),
  created_at: z.string().max(64),
  business_date: z.string().max(16),
  club: z.object({
    name: z.string().max(120),
    address: z.string().max(240),
    phone: z.string().max(60),
    footer: z.string().max(240)
  }),
  table_name: z.string().max(80).nullable(),
  floor_name: z.string().max(80).nullable(),
  customer_name: z.string().max(120).nullable(),
  customer_phone: z.string().max(40).nullable(),
  cashier_name: z.string().max(120),
  payment_method: z.enum(['cash', 'bank_transfer']),
  session: z
    .object({
      started_at: z.string().max(64).nullable(),
      ended_at: z.string().max(64).nullable(),
      billable_seconds: z.number().int().nonnegative(),
      rate_per_minute: z.number().nonnegative(),
      /** Set when the cashier replaced the table's rate with a custom one. */
      standard_rate_per_minute: z.number().positive().nullable().optional(),
      standard_base_amount: z.number().nonnegative().nullable().optional(),
      booked_seconds: z.number().int().nullable(),
      booked_amount: z.number().nullable()
    })
    .nullable(),
  base_amount: z.number().nonnegative(),
  items: z
    .array(
      z.object({
        name: z.string().max(120),
        unit_price: z.number().nonnegative(),
        quantity: z.number().int().positive(),
        line_total: z.number().nonnegative()
      })
    )
    .max(200),
  products_subtotal: z.number().nonnegative(),
  discount: z.number().nonnegative(),
  final_amount: z.number().nonnegative()
})

export type Receipt = z.infer<typeof receiptSchema>

/** Rate lines for a receipt: the rate charged, and the standard rate when a custom one replaced it. */
export function rateRows(session: NonNullable<Receipt['session']>): [string, string][] {
  if (session.standard_rate_per_minute == null) return [['Rate', formatRate(session.rate_per_minute)]]
  return [
    ['Rate', `${formatRate(session.rate_per_minute)} (custom)`],
    ['Standard rate', formatRate(session.standard_rate_per_minute)]
  ]
}

export const printOptionsSchema = z.object({
  paper: z.enum(['80mm', '58mm', 'a4']).default('80mm'),
  silent: z.boolean().default(false),
  deviceName: z.string().max(200).optional(),
  timeZone: z
    .string()
    .max(64)
    .optional()
    .refine((tz) => {
      if (!tz) return true
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz })
        return true
      } catch {
        return false
      }
    }, 'Unknown timezone')
})

export type PrintOptions = z.infer<typeof printOptionsSchema>

function esc(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Self-contained, script-free receipt document for the print window. Every
 * value is HTML-escaped; the window it is loaded into has JavaScript disabled.
 */
export function renderReceiptHtml(r: Receipt, opts: { paper: PrintOptions['paper']; timeZone?: string }): string {
  const width = opts.paper === '58mm' ? '48mm' : opts.paper === '80mm' ? '72mm' : '120mm'
  const row = (label: string, value: string, strong = false) =>
    `<tr class="${strong ? 'strong' : ''}"><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`
  const items = r.items
    .map(
      (i) =>
        `<tr><td>${esc(i.name)}<div class="muted">${esc(i.quantity)} × ${esc(formatMoney(i.unit_price, false))}</div></td><td class="r">${esc(formatMoney(i.line_total, false))}</td></tr>`
    )
    .join('')
  const session = r.session
    ? [
        row('Table', `${r.table_name ?? ''}${r.floor_name ? ` · ${r.floor_name}` : ''}`),
        r.session.started_at ? row('Start', formatDateTime(r.session.started_at, opts.timeZone)) : '',
        r.session.ended_at ? row('End', formatDateTime(r.session.ended_at, opts.timeZone)) : '',
        row('Played', formatDuration(r.session.billable_seconds)),
        r.session.booked_seconds ? row('Booked', formatDuration(r.session.booked_seconds)) : '',
        ...rateRows(r.session).map(([label, value]) => row(label, value))
      ].join('')
    : row('Sale', 'Counter sale')

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Receipt ${esc(r.receipt_no)}</title>
<style>
  @page { margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 11px/1.35 "Segoe UI", Arial, sans-serif; color: #000; }
  .page { width: ${width}; margin: 0 auto; padding: 4mm 0; }
  h1 { font-size: 16px; letter-spacing: .12em; text-align: center; margin: 0 0 2px; }
  .center { text-align: center; }
  .muted { color: #444; font-size: 10px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; padding-left: 6px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
  .strong td { font-weight: 700; font-size: 13px; }
</style></head><body><div class="page">
  <h1>${esc(r.club.name)}</h1>
  ${r.club.address ? `<div class="center muted">${esc(r.club.address)}</div>` : ''}
  ${r.club.phone ? `<div class="center muted">${esc(r.club.phone)}</div>` : ''}
  <hr>
  <table>
    ${row('Receipt', `#${r.receipt_no}`)}
    ${row('Date', formatDateTime(r.created_at, opts.timeZone))}
    ${row('Cashier', r.cashier_name)}
    ${r.customer_name ? row('Customer', r.customer_name) : ''}
    ${r.customer_phone ? row('Phone', r.customer_phone) : ''}
  </table>
  <hr>
  <table>${session}</table>
  <hr>
  <table>
    ${row('Table charge', formatMoney(r.base_amount, false))}
    ${items}
    ${r.items.length ? row('Snacks total', formatMoney(r.products_subtotal, false)) : ''}
    ${r.discount > 0 ? row('Discount', `−${formatMoney(r.discount, false)}`) : ''}
  </table>
  <hr>
  <table>
    ${row('TOTAL (PKR)', formatMoney(r.final_amount, false), true)}
    ${row('Paid by', paymentLabel(r.payment_method))}
  </table>
  <hr>
  ${r.club.footer ? `<div class="center">${esc(r.club.footer)}</div>` : ''}
  <div class="center muted">Sale ${esc(r.sale_id.slice(0, 8).toUpperCase())}</div>
</div></body></html>`
}
