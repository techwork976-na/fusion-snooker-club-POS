import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { Banknote, Landmark, Minus, Plus, ShieldAlert, ShoppingBag, Trash2, Wallet } from 'lucide-react'
import { chargeAtRate, sameRate, toPaisa } from '@shared/billing'
import type { PaymentMethod } from '@shared/constants'
import type { Receipt } from '@shared/receipt'
import { formatDuration, formatMoney, formatPricing, formatRate } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import { useIsPhone } from '@/lib/useMedia'
import type { ProductSearchResult } from '@/lib/types'
import { completeCheckout, openCounter } from '@/data/api'
import { accountingKeys, keys, useAction, useBillingPolicy, useMyCounter, useSettings, useTablesOverview } from '@/data/hooks'
import { Modal } from '@/components/ui/Modal'
import { Button, IconButton } from '@/components/ui/Button'
import { parseAmount, parseRate, TextField } from '@/components/ui/Field'
import { EmptyState } from '@/components/ui/Misc'
import { useToast } from '@/components/ui/Toast'
import { useAuth } from '@/features/auth/AuthProvider'
import { useSessionActions } from '@/features/tables/session'
import { CustomerField, emptyCustomer, type CustomerValue } from './CustomerField'
import { ProductPicker } from './ProductPicker'
import { ReceiptPanel } from './ReceiptView'
import { printReceipt, readPrinterPrefs } from './printing'

export interface CartLine {
  key: string
  itemId: string | null
  productId: string
  name: string
  unitPrice: number
  quantity: number
  maxQuantity: number | null
}

type DiscountMode = 'flat' | 'percent'

/** "12.5" → 12.5 for a percentage discount (0–100, up to two decimals). */
function parsePercent(text: string): number | null {
  const n = parseAmount(text)
  return n !== null && n <= 100 ? n : null
}

/**
 * Checkout for a table (session ended → items from its tab) or a counter sale
 * (tableId = null → local cart). The database recomputes and validates every
 * figure; the receipt shown afterwards is the saved transaction.
 */
export function CheckoutDialog({
  open,
  onOpenChange,
  tableId,
  initialCart,
  onCompleted
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  tableId: string | null
  /** Counter sale only: the cart to start from (the Snacks page builds it). */
  initialCart?: CartLine[]
  /** Called once the sale is saved. */
  onCompleted?: () => void
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const { can, isAdmin } = useAuth()
  const { data: settings } = useSettings()
  const policy = useBillingPolicy()
  // Payments belong to a staff member's own open counter; admins never take them.
  const { data: myCounter } = useMyCounter(open && !isAdmin)
  const startCounter = useAction(openCounter, { invalidate: accountingKeys, success: 'Counter opened.' })
  const counterBlock = isAdmin ? 'admin' : myCounter && !myCounter.shift ? 'closed' : null
  const { data: overview } = useTablesOverview()
  const actions = useSessionActions()
  // Phones: no automatic keyboard over the bill; staff tap the search when they need it.
  const phone = useIsPhone()

  const table = tableId ? overview?.tables.find((t) => t.id === tableId) ?? null : null
  const session = table?.session ?? null
  const isCounter = tableId === null

  const [customer, setCustomer] = useState<CustomerValue>(emptyCustomer)
  const [discountText, setDiscountText] = useState('')
  const [discountMode, setDiscountMode] = useState<DiscountMode>('flat')
  const [rateText, setRateText] = useState('')
  const [payment, setPayment] = useState<PaymentMethod>('cash')
  const [counterCart, setCounterCart] = useState<CartLine[]>([])
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [autoPrinted, setAutoPrinted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clientRef = useRef<string>(crypto.randomUUID())
  const sessionCustomerApplied = useRef(false)

  // A counter sale prepared elsewhere (Snacks page) opens with its cart.
  useEffect(() => {
    // Only when the dialog opens; edits inside the dialog stay local.
    if (open && isCounter && initialCart) setCounterCart(initialCart)
  }, [open])

  useEffect(() => {
    if (open) return
    const t = setTimeout(() => {
      setCustomer(emptyCustomer)
      setDiscountText('')
      setDiscountMode('flat')
      setRateText('')
      setPayment('cash')
      setCounterCart([])
      setReceipt(null)
      setAutoPrinted(false)
      setError(null)
      clientRef.current = crypto.randomUUID()
      sessionCustomerApplied.current = false
    }, 250)
    return () => clearTimeout(t)
  }, [open])

  // Pre-fill the customer chosen when the session started.
  useEffect(() => {
    if (open && session?.customer && !sessionCustomerApplied.current) {
      sessionCustomerApplied.current = true
      setCustomer({ id: session.customer.id, name: session.customer.name, phone: session.customer.phone ?? '' })
    }
  }, [open, session?.customer])

  const lines: CartLine[] = useMemo(
    () =>
      isCounter
        ? counterCart
        : (session?.items ?? []).map((i) => ({
            key: i.id,
            itemId: i.id,
            productId: i.product_id,
            name: i.name,
            unitPrice: Number(i.unit_price),
            quantity: i.quantity,
            maxQuantity: null
          })),
    [isCounter, counterCart, session?.items]
  )

  const canDiscount = can('apply_discount')
  // Tables priced by the hour are not re-priced per minute (a discount still applies).
  const perMinuteTable = session?.pricing_mode !== 'hourly_special30'
  const billing = session?.status === 'billing'
  const standardBasePaisa = billing ? toPaisa(session.base_amount ?? 0) : 0

  // Custom rate per minute (regulars): re-prices the played time with the same
  // rules the database applies (fusion_charge_at_rate); the discount follows.
  const customRate = rateText.trim() === '' ? null : parseRate(rateText)
  const rateError = rateText.trim() !== '' && customRate === null ? 'Enter a rate above zero (up to 4 decimals).' : null
  const rateApplied =
    canDiscount && perMinuteTable && billing && policy !== null && customRate !== null && !sameRate(customRate, session.rate_per_minute)
  const basePaisa = rateApplied
    ? toPaisa(chargeAtRate({ billableSeconds: session.billable_seconds ?? 0, bookedSeconds: session.booked_seconds }, customRate, policy))
    : standardBasePaisa

  const itemsPaisa = lines.reduce((s, l) => s + toPaisa(l.unitPrice) * l.quantity, 0)
  const subtotalPaisa = basePaisa + itemsPaisa
  const discountInput = discountText.trim() === '' ? 0 : discountMode === 'percent' ? parsePercent(discountText) : parseAmount(discountText)
  // A percentage becomes a flat amount (to the paisa) of the bill after the custom rate.
  const discountPaisa =
    discountInput === null ? 0 : discountMode === 'percent' ? Math.round((subtotalPaisa * discountInput) / 100) : toPaisa(discountInput)
  const discountError =
    discountInput === null
      ? discountMode === 'percent'
        ? 'Enter a percentage from 0 to 100.'
        : 'Enter a valid amount.'
      : discountPaisa > subtotalPaisa
        ? 'Discount cannot be more than the bill.'
        : null
  const totalPaisa = Math.max(0, subtotalPaisa - discountPaisa)

  const notReady = !isCounter && (!session || session.status !== 'billing')
  const emptyCounter = isCounter && lines.length === 0
  const tabBusy = actions.addItem.isPending || actions.setQty.isPending

  const addProduct = (p: ProductSearchResult) => {
    if (isCounter) {
      setCounterCart((cart) => {
        const existing = cart.find((l) => l.productId === p.id)
        const max = p.track_stock ? p.stock_quantity : null
        if (existing) {
          if (max !== null && existing.quantity >= max) {
            toast.error(`Only ${max} × ${p.name} in stock.`)
            return cart
          }
          return cart.map((l) => (l.productId === p.id ? { ...l, quantity: l.quantity + 1 } : l))
        }
        return [
          ...cart,
          { key: p.id, itemId: null, productId: p.id, name: p.name, unitPrice: Number(p.selling_price), quantity: 1, maxQuantity: max }
        ]
      })
    } else if (session) {
      actions.addItem.mutate({ sessionId: session.id, productId: p.id })
    }
  }

  const setQuantity = (line: CartLine, quantity: number) => {
    if (isCounter) {
      setCounterCart((cart) =>
        quantity <= 0
          ? cart.filter((l) => l.key !== line.key)
          : cart.map((l) => (l.key === line.key ? { ...l, quantity: Math.min(quantity, l.maxQuantity ?? 999) } : l))
      )
    } else if (line.itemId) {
      actions.setQty.mutate({ itemId: line.itemId, quantity: Math.max(0, quantity) })
    }
  }

  const submit = async () => {
    if (notReady || emptyCounter || discountError || rateError || submitting || counterBlock) return
    if (discountPaisa > 0 && !canDiscount) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await completeCheckout({
        clientRef: clientRef.current,
        paymentMethod: payment,
        sessionId: isCounter ? null : session!.id,
        items: isCounter ? lines.map((l) => ({ product_id: l.productId, quantity: l.quantity, unit_price: l.unitPrice })) : null,
        discount: discountPaisa / 100,
        customerId: customer.id,
        customerName: customer.id ? null : customer.name.trim() || null,
        customerPhone: customer.id ? null : customer.phone.trim() || null,
        customRatePerMinute: rateApplied ? customRate : null
      })
      setReceipt(result)
      onCompleted?.()
      for (const key of [keys.tables, ...accountingKeys, ['product-search'], ['products']]) {
        void qc.invalidateQueries({ queryKey: key })
      }
      if (readPrinterPrefs().autoPrint) {
        const res = await printReceipt(result, settings?.business_timezone)
        setAutoPrinted(res.ok)
        if (!res.ok) toast.error(res.error ?? 'Printing failed.')
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  const title = receipt ? 'Checkout complete' : isCounter ? 'Counter sale' : `Checkout · ${table?.name ?? 'Table'}`

  return (
    <Modal open={open} onOpenChange={(o) => !submitting && onOpenChange(o)} size="xl" title={title} dismissible={!submitting}>
      {receipt ? (
        <ReceiptPanel receipt={receipt} onDone={() => onOpenChange(false)} autoPrinted={autoPrinted} />
      ) : !isCounter && !session ? (
        <EmptyState title="This session is no longer open" description="It may have been checked out or cancelled on another terminal." />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr_1fr] lg:gap-8">
          {/* Bill */}
          <div className="flex min-w-0 flex-col gap-5">
            {session && (
              <div className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-2xl bg-sunken/60 px-4 py-3.5 sm:grid-cols-4 sm:gap-6 sm:px-5 sm:py-4">
                {[
                  ['Played', session.billable_seconds != null ? formatDuration(session.billable_seconds) : '—'],
                  ['Rate', rateApplied ? formatRate(customRate) : formatPricing(session)],
                  ['Booking', session.booked_seconds ? formatDuration(session.booked_seconds) : 'Open play'],
                  ['Table charge', formatMoney(basePaisa / 100)]
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <p className="label !text-[10px]">
                      {label}
                      {label === 'Rate' && rateApplied && <span className="ml-1.5 normal-case tracking-normal text-brass-700">custom</span>}
                    </p>
                    <p className="mt-2 truncate figure text-[17px] text-forest-950">{value}</p>
                  </div>
                ))}
              </div>
            )}
            {notReady && session && (
              <div className="rounded-xl bg-brass-50 px-4 py-3 text-sm text-brass-800">
                This session is {session.status} again. End it before checking out.
              </div>
            )}

            <ProductPicker onPick={addProduct} autoFocus={isCounter && !phone} busy={tabBusy} />

            <div className="rounded-2xl bg-sunken/60 sm:min-h-[220px]">
              {lines.length === 0 ? (
                <EmptyState
                  className="py-10"
                  icon={<ShoppingBag className="size-5" />}
                  title="No snacks or drinks"
                  description="Search above to add products to this bill."
                />
              ) : (
                <ul className="divide-y divide-line">
                  <AnimatePresence initial={false}>
                    {lines.map((l) => (
                      <motion.li
                        key={l.key}
                        layout
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="flex items-center gap-3 px-4 py-3 max-sm:flex-wrap max-sm:gap-y-2"
                      >
                        <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-7rem)]">
                          <p className="truncate text-sm font-semibold text-fg">{l.name}</p>
                          <p className="text-xs text-fg-4 tabular">{formatMoney(l.unitPrice)} each</p>
                        </div>
                        <div className="flex items-center gap-1 rounded-xl bg-surface p-1 shadow-[var(--shadow-control)] max-sm:order-2">
                          <IconButton size="sm" label="Decrease" tooltip={false} onClick={() => setQuantity(l, l.quantity - 1)} disabled={tabBusy}>
                            <Minus className="size-3.5" />
                          </IconButton>
                          <span className="w-7 text-center text-sm font-bold tabular">{l.quantity}</span>
                          <IconButton
                            size="sm"
                            label="Increase"
                            tooltip={false}
                            onClick={() => setQuantity(l, l.quantity + 1)}
                            disabled={tabBusy || (l.maxQuantity !== null && l.quantity >= l.maxQuantity)}
                          >
                            <Plus className="size-3.5" />
                          </IconButton>
                        </div>
                        <span className="w-24 text-right text-sm font-bold tabular max-sm:order-1">{formatMoney((toPaisa(l.unitPrice) * l.quantity) / 100)}</span>
                        <IconButton label={`Remove ${l.name}`} variant="danger" size="sm" className="max-sm:order-3 max-sm:ml-auto" onClick={() => setQuantity(l, 0)} disabled={tabBusy}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              )}
            </div>
          </div>

          {/* Payment */}
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <CustomerField value={customer} onChange={setCustomer} />
            {canDiscount && session && perMinuteTable && (
              <TextField
                label="Custom rate per minute"
                prefix="PKR"
                suffix="/min"
                inputMode="decimal"
                placeholder={String(Number(session.rate_per_minute))}
                value={rateText}
                onChange={(e) => setRateText(e.target.value)}
                error={rateError}
                hint={
                  rateApplied
                    ? `Table charge ${formatMoney(standardBasePaisa / 100)} at ${formatRate(session.rate_per_minute)} → ${formatMoney(basePaisa / 100)}`
                    : `Leave empty for the table's rate (${formatRate(session.rate_per_minute)}).`
                }
                aside={
                  rateText && (
                    <button type="button" className="text-xs font-semibold text-fg-3 hover:text-fg" onClick={() => setRateText('')}>
                      Use table rate
                    </button>
                  )
                }
                data-testid="custom-rate"
              />
            )}
            {canDiscount && (
              <TextField
                label="Discount"
                prefix={discountMode === 'percent' ? undefined : 'PKR'}
                suffix={discountMode === 'percent' ? '%' : undefined}
                inputMode="decimal"
                placeholder="0"
                value={discountText}
                onChange={(e) => setDiscountText(e.target.value)}
                error={discountText ? discountError : null}
                hint={
                  discountMode === 'percent'
                    ? discountPaisa > 0 && !discountError
                      ? `${formatMoney(discountPaisa / 100)} off ${formatMoney(subtotalPaisa / 100)}.`
                      : 'Percentage of the bill.'
                    : 'Flat amount off the total.'
                }
                aside={
                  <div className="flex rounded-lg bg-forest-950/[0.05] p-0.5" role="radiogroup" aria-label="Discount type">
                    {(
                      [
                        ['flat', 'PKR'],
                        ['percent', '%']
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={discountMode === mode}
                        onClick={() => setDiscountMode(mode)}
                        data-testid={`discount-${mode}`}
                        className={cn(
                          'h-6 min-w-9 rounded-md px-2 text-[11px] font-bold transition-colors',
                          discountMode === mode ? 'bg-forest-950 text-cream' : 'text-fg-3 hover:text-fg'
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                }
                data-testid="discount"
              />
            )}
            <div>
              <p className="mb-1.5 text-[13px] font-semibold text-fg-2">Payment</p>
              <div className="grid grid-cols-2 gap-2.5" role="radiogroup" aria-label="Payment method">
                {(
                  [
                    ['cash', 'Cash', Banknote],
                    ['bank_transfer', 'Bank Transfer', Landmark]
                  ] as const
                ).map(([value, label, Icon]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={payment === value}
                    onClick={() => setPayment(value)}
                    className={cn(
                      'flex h-14 items-center justify-center gap-2.5 rounded-xl text-sm font-bold transition-[background-color,color,box-shadow]',
                      payment === value
                        ? 'bg-forest-950 text-cream shadow-[var(--shadow-control)]'
                        : 'bg-surface text-fg-2 shadow-[var(--shadow-control)] hover:text-fg'
                    )}
                  >
                    <Icon className="size-[18px]" /> {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-auto rounded-2xl bg-sunken/70 p-4 sm:p-5">
              <div className="space-y-2 text-sm">
                {!isCounter && (
                  <div className="flex justify-between text-fg-3">
                    <span>Table charge{rateApplied && ` · ${formatRate(customRate)}`}</span>
                    <span className="tabular text-fg">
                      {rateApplied && <span className="mr-2 text-fg-4 line-through">{formatMoney(standardBasePaisa / 100)}</span>}
                      <span data-testid="checkout-table-charge">{formatMoney(basePaisa / 100)}</span>
                    </span>
                  </div>
                )}
                <div className="flex justify-between text-fg-3">
                  <span>Snacks total</span>
                  <span className="tabular text-fg">{formatMoney(itemsPaisa / 100)}</span>
                </div>
                {discountPaisa > 0 && !discountError && (
                  <div className="flex justify-between text-fg-3">
                    <span>Discount</span>
                    <span className="tabular text-brass-700">−{formatMoney(discountPaisa / 100)}</span>
                  </div>
                )}
              </div>
              <div className="mt-4 flex items-end justify-between border-t border-forest-950/[0.07] pt-4">
                <span className="label">Total</span>
                <span className="figure text-[36px] leading-none text-forest-950 sm:text-[44px]" data-testid="checkout-total">
                  {formatMoney(totalPaisa / 100)}
                </span>
              </div>
              {error && <p className="mt-4 rounded-lg bg-claret-500/10 px-3 py-2.5 text-sm text-claret-700">{error}</p>}
              {counterBlock === 'admin' && (
                <p className="mt-4 flex items-start gap-2 rounded-xl bg-sunken px-3.5 py-3 text-sm text-fg-2" data-testid="admin-no-sales">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                  Payments are taken at a staff counter. Administrators manage the business and do not take payments.
                </p>
              )}
              {counterBlock === 'closed' && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brass-50 px-3.5 py-2.5 text-sm text-brass-800">
                  <span>Open your counter to take this payment.</span>
                  <Button size="sm" variant="primary" icon={<Wallet className="size-3.5" />} loading={startCounter.isPending} onClick={() => startCounter.mutate(undefined)}>
                    Open counter
                  </Button>
                </div>
              )}
              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="mt-5 w-full"
                loading={submitting}
                disabled={notReady || emptyCounter || Boolean(discountError) || Boolean(rateError) || tabBusy || Boolean(counterBlock)}
                data-testid="complete-checkout"
              >
                Complete · {formatMoney(totalPaisa / 100)}
              </Button>
            </div>
          </form>
        </div>
      )}
    </Modal>
  )
}
