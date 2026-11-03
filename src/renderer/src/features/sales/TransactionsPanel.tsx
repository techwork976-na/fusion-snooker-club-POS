import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Eye, Printer, ReceiptText, Trash2 } from 'lucide-react'
import type { PaymentMethod } from '@shared/constants'
import { formatDateTime, formatMoney, formatRate, paymentLabel } from '@shared/format'
import type { Receipt } from '@shared/receipt'
import { errorMessage } from '@/lib/errors'
import type { Sale } from '@/lib/types'
import { deleteSale, getReceipt, listSales, listUsers } from '@/data/api'
import { accountingKeys, keys, useAction, useMyCounter, useSettings } from '@/data/hooks'
import { IconButton, Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Field'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Misc'
import { useToast } from '@/components/ui/Toast'
import { useAuth } from '@/features/auth/AuthProvider'
import { ReceiptPaper } from '@/features/pos/ReceiptView'
import { printReceipt } from '@/features/pos/printing'
import { DateRangePicker, type Range } from './DateRange'

export function TransactionsPanel({
  range,
  onRange,
  today,
  hideRange
}: {
  range: Range
  onRange: (r: Range) => void
  today: string
  /** The page shows its own period filter. */
  hideRange?: boolean
}) {
  const { isAdmin, can } = useAuth()
  const { data: settings } = useSettings()
  const { data: counter } = useMyCounter(!isAdmin)
  const toast = useToast()
  const [cashier, setCashier] = useState('all')
  const [method, setMethod] = useState<'all' | PaymentMethod>('all')
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [loadingReceipt, setLoadingReceipt] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<Sale | null>(null)
  const tz = settings?.business_timezone

  const filter = {
    from: range.from,
    to: range.to,
    cashierId: cashier === 'all' ? null : cashier,
    paymentMethod: method === 'all' ? null : method
  }
  const { data: users } = useQuery({ queryKey: keys.users, queryFn: listUsers, enabled: isAdmin })
  const { data: sales, isLoading, error, refetch } = useQuery({ queryKey: keys.sales(filter), queryFn: () => listSales(filter) })
  const remove = useAction(deleteSale, {
    invalidate: [...accountingKeys, ['products'], ['product-search']],
    success: 'Sale deleted and stock returned.'
  })

  // Sales can be voided only while their counter shift is open (the database
  // enforces this; an admin's attempt on a closed shift is refused with a reason).
  const canDelete = (s: Sale) => isAdmin || (can('delete_sales') && s.shift_id === counter?.shift?.id)
  const total = (sales ?? []).reduce((sum, s) => sum + Number(s.final_amount), 0)

  const openReceipt = async (s: Sale) => {
    setLoadingReceipt(s.id)
    try {
      setReceipt(await getReceipt(s.id))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setLoadingReceipt(null)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {hideRange ? <span /> : <DateRangePicker value={range} onChange={onRange} today={today} layoutId="tx-range" />}
        <div className="flex w-full gap-3 sm:w-auto">
          {isAdmin && (
            <Select
              className="min-w-0 flex-1 sm:w-52 sm:flex-none"
              value={cashier}
              onChange={setCashier}
              options={[{ value: 'all', label: 'All staff' }, ...(users ?? []).map((u) => ({ value: u.id, label: u.full_name }))]}
            />
          )}
          <Select
            className="min-w-0 flex-1 sm:w-44 sm:flex-none"
            value={method}
            onChange={setMethod}
            options={[
              { value: 'all', label: 'All payments' },
              { value: 'cash', label: 'Cash' },
              { value: 'bank_transfer', label: 'Bank Transfer' }
            ]}
          />
        </div>
      </div>

      <div className="card overflow-hidden">
        {error ? (
          <div className="p-6">
            <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
          </div>
        ) : isLoading ? (
          <LoadingBlock />
        ) : !sales?.length ? (
          <EmptyState
            icon={<ReceiptText className="size-5" />}
            title="No sales"
            description={`Nothing matches these filters. Invoices older than ${settings?.sales_retention_days ?? 30} day(s) are removed automatically; their totals stay in History.`}
          />
        ) : (
          <table className="table-stack w-full text-sm">
            <thead>
              <tr className="thead-row">
                <th className="px-5 py-3 font-semibold">Receipt</th>
                <th className="px-5 py-3 font-semibold">Time</th>
                <th className="px-5 py-3 font-semibold">Table</th>
                <th className="px-5 py-3 font-semibold">Customer</th>
                <th className="px-5 py-3 font-semibold">Cashier</th>
                <th className="px-5 py-3 font-semibold">Payment</th>
                <th className="px-5 py-3 text-right font-semibold">Discount</th>
                <th className="px-5 py-3 text-right font-semibold">Total</th>
                <th className="w-24 px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sales.map((s) => (
                <tr key={s.id} className="transition-colors hover:bg-forest-950/[0.02]">
                  <td className="px-5 py-3 font-semibold text-fg tabular max-md:text-[15px]" data-stack="top">#{s.receipt_no}</td>
                  <td className="px-5 py-3 text-fg-3 tabular" data-label="Time">{formatDateTime(s.created_at, tz)}</td>
                  <td className="px-5 py-3 text-fg-2" data-label="Table">
                    {s.table_name ?? <span className="text-fg-4">Counter</span>}
                    {s.standard_rate_per_minute != null && (
                      <span className="ml-1.5 text-[11px] font-semibold text-brass-700" title={`Custom ${formatRate(s.rate_per_minute)} (standard ${formatRate(s.standard_rate_per_minute)})`}>
                        custom rate
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-fg-2" data-label="Customer">{s.customer_name ?? <span className="text-fg-5">—</span>}</td>
                  <td className="px-5 py-3 text-fg-3" data-label="Cashier">{s.cashier_name}</td>
                  <td className="px-5 py-3" data-label="Payment">
                    <span className={s.payment_method === 'cash' ? 'text-forest-600' : 'text-brass-700'}>{paymentLabel(s.payment_method)}</span>
                  </td>
                  <td className="px-5 py-3 text-right text-fg-3 tabular" data-label="Discount">{Number(s.discount) > 0 ? formatMoney(s.discount) : '—'}</td>
                  <td className="px-5 py-3 text-right font-bold text-fg tabular max-md:text-[15px]" data-stack="top end">{formatMoney(s.final_amount)}</td>
                  <td className="px-3 py-2" data-stack="full">
                    <div className="flex justify-end gap-1">
                      <IconButton size="sm" label="View receipt" onClick={() => void openReceipt(s)} disabled={loadingReceipt === s.id}>
                        <Eye className="size-4" />
                      </IconButton>
                      {canDelete(s) && (
                        <IconButton size="sm" variant="danger" label="Delete sale" onClick={() => setToDelete(s)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line-strong/70">
                <td colSpan={7} className="px-5 py-3 text-xs text-fg-4 max-md:self-center">
                  {sales.length} sale{sales.length === 1 ? '' : 's'}
                  {sales.length >= 500 ? ' (showing the latest 500)' : ''}
                </td>
                <td className="px-5 py-3 text-right font-bold text-fg tabular" data-stack="end">{formatMoney(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      <Modal
        open={receipt !== null}
        onOpenChange={(o) => !o && setReceipt(null)}
        title={receipt ? `Receipt #${receipt.receipt_no}` : 'Receipt'}
        size="sm"
        footer={
          receipt && (
            <Button
              variant="primary"
              icon={<Printer className="size-4" />}
              onClick={async () => {
                const res = await printReceipt(receipt, tz)
                if (res.ok) toast.success('Receipt sent to the printer.')
                else toast.error(res.error ?? 'Printing failed.')
              }}
            >
              Print
            </Button>
          )
        }
      >
        {receipt && <ReceiptPaper receipt={receipt} />}
      </Modal>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete receipt #${toDelete?.receipt_no ?? ''}?`}
        confirmLabel="Delete sale"
        description={
          <>
            This removes the sale of <strong className="text-fg">{formatMoney(toDelete?.final_amount)}</strong> from its counter
            shift's totals, returns its products to stock, and cannot be undone. The void is recorded on the shift.
          </>
        }
        onConfirm={async () => {
          if (toDelete) await remove.mutateAsync(toDelete.id)
        }}
      />
    </div>
  )
}
