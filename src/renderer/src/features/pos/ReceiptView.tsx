import { useState } from 'react'
import { motion } from 'framer-motion'
import { CheckCircle2, Printer } from 'lucide-react'
import { paymentRows, rateRows, type Receipt } from '@shared/receipt'
import { formatDateTime, formatDuration, formatMoney, paymentLabel, splitLabel } from '@shared/format'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useSettings } from '@/data/hooks'
import { printReceipt } from './printing'
import { ProductImage } from '@/components/ui/ProductImage'

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? 'flex justify-between py-1 text-[15px] font-bold' : 'flex justify-between py-0.5'}>
      <span>{label}</span>
      <span className="tabular">{value}</span>
    </div>
  )
}

/** On-screen receipt; mirrors the printed one and the saved transaction. */
export function ReceiptPaper({ receipt: r }: { receipt: Receipt }) {
  const { data: settings } = useSettings()
  const tz = settings?.business_timezone
  return (
    <div
      className="mx-auto w-full max-w-[340px] rounded-md bg-[#f7f4ec] px-6 py-6 text-[12.5px] leading-snug text-[#1b1d1c] shadow-[0_30px_60px_-25px_rgb(0_0_0/0.9)]"
      data-selectable
      data-testid="receipt"
    >
      <p className="text-center text-base font-extrabold tracking-[0.2em]">{r.club.name}</p>
      {r.club.address && <p className="text-center text-[11px] text-[#55595a]">{r.club.address}</p>}
      {r.club.phone && <p className="text-center text-[11px] text-[#55595a]">{r.club.phone}</p>}
      <div className="my-3 border-t border-dashed border-[#9a9d9b]" />
      <Row label="Receipt" value={`#${r.receipt_no}`} />
      <Row label="Date" value={formatDateTime(r.created_at, tz)} />
      <Row label="Cashier" value={r.cashier_name} />
      {r.customer_name && <Row label="Customer" value={r.customer_name} />}
      {r.customer_phone && <Row label="Phone" value={r.customer_phone} />}
      <div className="my-3 border-t border-dashed border-[#9a9d9b]" />
      {r.session ? (
        <>
          <Row label="Table" value={`${r.table_name ?? ''}${r.floor_name ? ` · ${r.floor_name}` : ''}`} />
          <Row label="Played" value={formatDuration(r.session.billable_seconds)} />
          {r.session.booked_seconds ? <Row label="Booked" value={formatDuration(r.session.booked_seconds)} /> : null}
          {rateRows(r.session).map(([label, value]) => (
            <Row key={label} label={label} value={value} />
          ))}
        </>
      ) : (
        <Row label="Sale" value="Counter sale" />
      )}
      <div className="my-3 border-t border-dashed border-[#9a9d9b]" />
      <Row label="Table charge" value={formatMoney(r.base_amount, false)} />
      {r.items.map((i, idx) => (
        <div key={idx} className="flex items-center justify-between gap-2 py-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <ProductImage name={i.name} size={22} />
            <span>
              {i.name} <span className="text-[#6b6f6d]">× {i.quantity}</span>
            </span>
          </span>
          <span className="tabular">{formatMoney(i.line_total, false)}</span>
        </div>
      ))}
      {r.items.length > 0 && <Row label="Snacks total" value={formatMoney(r.products_subtotal, false)} />}
      {r.discount > 0 && <Row label="Discount" value={`−${formatMoney(r.discount, false)}`} />}
      <div className="my-3 border-t border-dashed border-[#9a9d9b]" />
      <Row label="TOTAL (PKR)" value={formatMoney(r.final_amount, false)} strong />
      <Row label="Paid by" value={paymentLabel(r.payment_method)} />
      {paymentRows(r).map(([label, value]) => (
        <Row key={label} label={`  ${label}`} value={value} />
      ))}
      {r.club.footer && <p className="mt-4 text-center text-[11px] text-[#55595a]">{r.club.footer}</p>}
    </div>
  )
}

export function ReceiptPanel({ receipt, onDone, autoPrinted }: { receipt: Receipt; onDone: () => void; autoPrinted?: boolean }) {
  const toast = useToast()
  const { data: settings } = useSettings()
  const [printing, setPrinting] = useState(false)
  const print = async () => {
    setPrinting(true)
    const res = await printReceipt(receipt, settings?.business_timezone)
    setPrinting(false)
    if (res.ok) toast.success('Receipt sent to the printer.')
    else toast.error(res.error ?? 'Printing failed.')
  }
  return (
    <div className="grid grid-cols-1 items-start gap-8 md:grid-cols-[1fr_340px] md:gap-10">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="md:pt-4">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-sage-500/15 text-sage-600">
          <CheckCircle2 className="size-7" />
        </div>
        <p className="mt-5 label md:mt-6">Payment received</p>
        <p className="mt-2 figure text-[42px] leading-none text-forest-950 md:text-[52px]">{formatMoney(receipt.final_amount)}</p>
        <p className="mt-3 text-sm text-fg-3">
          {receipt.payment_method === 'split' && receipt.split_cash_amount != null
            ? splitLabel(receipt.final_amount, receipt.split_cash_amount)
            : paymentLabel(receipt.payment_method)}{' '}
          · Receipt #{receipt.receipt_no}
          {autoPrinted ? ' · printed' : ''}
        </p>
        <div className="mt-8 flex gap-3 md:mt-10">
          <Button variant="secondary" size="lg" className="max-md:flex-1" icon={<Printer className="size-[18px]" />} loading={printing} onClick={print}>
            Print receipt
          </Button>
          <Button variant="primary" size="lg" className="max-md:flex-1" onClick={onDone} autoFocus>
            Done
          </Button>
        </div>
      </motion.div>
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.05 }}>
        <ReceiptPaper receipt={receipt} />
      </motion.div>
    </div>
  )
}
