import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Minus, PackageSearch, Plus, Search, ShoppingBag, Trash2 } from 'lucide-react'
import { formatMoney, formatTime, paymentLabel, splitLabel } from '@shared/format'
import { toPaisa } from '@shared/billing'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { ProductSearchResult } from '@/lib/types'
import { getSnackSales, searchProducts } from '@/data/api'
import { keys, useBusinessDate, useDebounced, useMyCounter, useSettings } from '@/data/hooks'
import { Button, IconButton } from '@/components/ui/Button'
import { inputClass } from '@/components/ui/Field'
import { EmptyState, ErrorState, LoadingBlock, Page, PageHeader } from '@/components/ui/Misc'
import { useToast } from '@/components/ui/Toast'
import { useAuth } from '@/features/auth/AuthProvider'
import { CheckoutDialog, type CartLine } from '@/features/pos/CheckoutDialog'

/**
 * Snack and drink sales without a table: pick products into a cart, then pay
 * through the usual counter checkout (cash or bank transfer, receipt, stock).
 * Staff sell from their own open counter; administrators see stock and every
 * snack sale but do not take payments.
 */
export function SnacksPage() {
  const { isAdmin, can } = useAuth()
  const toast = useToast()
  const { data: myCounter } = useMyCounter(!isAdmin)
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query.trim(), 150)
  const [cart, setCart] = useState<CartLine[]>([])
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const cartRef = useRef<HTMLElement>(null)
  const products = useQuery({
    queryKey: ['product-search', 'snacks', debounced],
    queryFn: () => searchProducts(debounced, 100)
  })

  const canSell = !isAdmin && can('counter_sale')
  const counterOpen = Boolean(myCounter?.shift)
  const cartQuantity = (id: string) => cart.find((l) => l.productId === id)?.quantity ?? 0
  const totalPaisa = cart.reduce((sum, l) => sum + toPaisa(l.unitPrice) * l.quantity, 0)
  const units = cart.reduce((n, l) => n + l.quantity, 0)

  const add = (p: ProductSearchResult) => {
    const max = p.track_stock ? p.stock_quantity : null
    if (max !== null && cartQuantity(p.id) >= max) {
      toast.error(max === 0 ? `${p.name} is out of stock.` : `Only ${max} × ${p.name} in stock.`)
      return
    }
    setCart((c) =>
      c.some((l) => l.productId === p.id)
        ? c.map((l) => (l.productId === p.id ? { ...l, quantity: l.quantity + 1 } : l))
        : [...c, { key: p.id, itemId: null, productId: p.id, name: p.name, unitPrice: Number(p.selling_price), quantity: 1, maxQuantity: max }]
    )
  }
  const setQuantity = (line: CartLine, quantity: number) =>
    setCart((c) =>
      quantity <= 0 ? c.filter((l) => l.key !== line.key) : c.map((l) => (l.key === line.key ? { ...l, quantity: Math.min(quantity, l.maxQuantity ?? 999) } : l))
    )

  return (
    <Page>
      <PageHeader title="Snacks" subtitle="Sell snacks and drinks to customers who are not playing — no table needed." />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_380px]">
        <section className="card p-4 sm:p-6" data-testid="snack-products">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-fg-4" />
            <input
              className={cn(inputClass, 'h-12 pl-10 text-[15px]')}
              placeholder="Search snacks & drinks…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search products"
            />
          </div>
          {products.error ? (
            <div className="mt-5">
              <ErrorState message={errorMessage(products.error)} onRetry={() => void products.refetch()} />
            </div>
          ) : products.isLoading ? (
            <LoadingBlock />
          ) : (products.data ?? []).length === 0 ? (
            <EmptyState icon={<PackageSearch className="size-5" />} title={debounced ? 'No matching products' : 'No products yet'} description={debounced ? 'Try another name.' : 'Add products under Inventory.'} />
          ) : (
            <ul className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 max-sm:grid-cols-2 max-sm:gap-2.5 sm:mt-5">
              {(products.data ?? []).map((p) => {
                const left = p.track_stock ? p.stock_quantity - cartQuantity(p.id) : null
                const out = left !== null && left <= 0
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => add(p)}
                      disabled={!canSell || !counterOpen || out}
                      className="flex h-full w-full flex-col rounded-2xl bg-sunken/60 px-4 py-3.5 text-left max-sm:px-3.5 max-sm:py-3 transition-[background-color,box-shadow] duration-150 enabled:hover:bg-surface enabled:hover:shadow-[var(--shadow-card)] disabled:cursor-default"
                      data-testid={`snack-${p.name}`}
                    >
                      <span className="text-[15px] font-semibold text-fg max-sm:leading-snug">{p.name}</span>
                      <span className="mt-0.5 text-xs text-fg-4">{p.category}</span>
                      <span className="mt-3 flex items-end justify-between gap-2 max-sm:mt-auto max-sm:flex-wrap max-sm:gap-x-2 max-sm:gap-y-0.5 max-sm:pt-3">
                        <span className="figure text-[17px] text-forest-950">{formatMoney(p.selling_price)}</span>
                        <span className={cn('text-xs font-semibold tabular', out ? 'text-claret-700' : 'text-fg-4')}>
                          {p.track_stock ? (out ? 'Out of stock' : `${left} left`) : 'Always available'}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <aside className="lg:sticky lg:top-4">
          {isAdmin ? (
            <section className="card p-6">
              <span className="label">Selling</span>
              <p className="mt-3 text-sm leading-relaxed text-fg-3">
                Administrators manage the business and do not take payments. Staff sell snacks here from their own counter; to sell yourself, switch to a
                staff portal from the account menu.
              </p>
            </section>
          ) : !canSell ? (
            <section className="card p-6">
              <span className="label">Selling</span>
              <p className="mt-3 text-sm leading-relaxed text-fg-3">Selling without a table needs the Counter sales permission. Ask an administrator.</p>
            </section>
          ) : !counterOpen ? (
            <section className="card p-6">
              <span className="label">Selling</span>
              <p className="mt-3 text-sm leading-relaxed text-fg-3">Open your counter to take payments.</p>
              <Link to="/counter" className="mt-4 inline-block">
                <Button variant="primary">Go to My counter</Button>
              </Link>
            </section>
          ) : (
            <section ref={cartRef} className="card scroll-mt-4 p-5 sm:p-6" data-testid="snack-cart">
              <div className="flex items-baseline justify-between">
                <span className="label">Cart</span>
                {cart.length > 0 && (
                  <button className="text-xs font-semibold text-fg-4 hover:text-claret-700" onClick={() => setCart([])}>
                    Clear
                  </button>
                )}
              </div>
              {cart.length === 0 ? (
                <p className="py-10 text-center text-sm text-fg-4">Tap a product to add it.</p>
              ) : (
                <ul className="mt-4 divide-y divide-line">
                  {cart.map((l) => (
                    <li key={l.key} className="flex items-center gap-3 py-3 max-sm:flex-wrap max-sm:gap-y-2">
                      <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-6rem)]">
                        <p className="line-clamp-2 text-sm leading-snug font-semibold text-fg">{l.name}</p>
                        <p className="text-xs text-fg-4 tabular">{formatMoney(l.unitPrice)} each</p>
                      </div>
                      <div className="flex items-center rounded-xl bg-surface shadow-[var(--shadow-control)] max-sm:order-2">
                        <IconButton label="One less" size="sm" tooltip={false} onClick={() => setQuantity(l, l.quantity - 1)}>
                          <Minus className="size-3.5" />
                        </IconButton>
                        <span className="w-7 text-center text-sm font-bold tabular" data-testid={`cart-qty-${l.name}`}>
                          {l.quantity}
                        </span>
                        <IconButton
                          label="One more"
                          size="sm"
                          tooltip={false}
                          disabled={l.maxQuantity !== null && l.quantity >= l.maxQuantity}
                          onClick={() => setQuantity(l, l.quantity + 1)}
                        >
                          <Plus className="size-3.5" />
                        </IconButton>
                      </div>
                      <span className="w-20 text-right text-sm font-semibold text-fg tabular max-sm:order-1">{formatMoney((toPaisa(l.unitPrice) * l.quantity) / 100)}</span>
                      <IconButton label={`Remove ${l.name}`} size="sm" variant="danger" tooltip={false} className="max-sm:order-3 max-sm:ml-auto" onClick={() => setQuantity(l, 0)}>
                        <Trash2 className="size-3.5" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 flex items-baseline justify-between border-t border-line pt-4">
                <span className="text-sm text-fg-3">
                  {units} item{units === 1 ? '' : 's'}
                </span>
                <span className="figure text-[28px] text-forest-950" data-testid="cart-total">
                  {formatMoney(totalPaisa / 100)}
                </span>
              </div>
              <Button
                variant="primary"
                size="lg"
                className="mt-4 w-full"
                icon={<ShoppingBag className="size-4" />}
                disabled={cart.length === 0}
                onClick={() => setCheckoutOpen(true)}
                data-testid="snack-checkout"
              >
                Checkout
              </Button>
            </section>
          )}
        </aside>
      </div>

      {/* Phones and tablets: the cart sits below the products, so its total and Checkout follow the thumb. */}
      {canSell && counterOpen && cart.length > 0 && (
        <div className="sticky bottom-3 z-20 mt-4 lg:hidden" data-testid="snack-cart-bar">
          <div className="flex items-center gap-3 rounded-2xl bg-forest-950 p-2 pl-4 text-cream shadow-[var(--shadow-pop)]">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => cartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              <span className="block text-xs font-semibold text-side-muted">
                {units} item{units === 1 ? '' : 's'} · View cart
              </span>
              <span className="block figure text-[20px] leading-tight">{formatMoney(totalPaisa / 100)}</span>
            </button>
            <Button variant="brass" size="lg" icon={<ShoppingBag className="size-4" />} onClick={() => setCheckoutOpen(true)} data-testid="snack-cart-bar-checkout">
              Checkout
            </Button>
          </div>
        </div>
      )}

      <SnackSalesToday />
      <CheckoutDialog open={checkoutOpen} onOpenChange={setCheckoutOpen} tableId={null} initialCart={cart} onCompleted={() => setCart([])} />
    </Page>
  )
}

function SnackSalesToday() {
  const { data: today } = useBusinessDate()
  const { data: settings } = useSettings()
  const { data, error, refetch } = useQuery({
    queryKey: keys.snackSales(today ?? '', today ?? ''),
    queryFn: () => getSnackSales(today!, today!),
    enabled: Boolean(today)
  })
  if (error) return <div className="mt-6"><ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /></div>
  if (!data) return null
  const all = data.scope === 'all'
  return (
    <section className="card mt-6 overflow-hidden" data-testid="snack-sales-today">
      <div className="flex flex-wrap items-end justify-between gap-4 px-5 pt-6 pb-4 md:px-8 md:pt-7">
        <div>
          <span className="label">{all ? 'Snack sales today · all counters' : 'Your snack sales today'}</span>
          <p className="mt-2.5 figure text-[30px] leading-none text-forest-950" data-testid="snack-sales-total">
            {formatMoney(data.totals.total)}
          </p>
        </div>
        <p className="text-sm text-fg-3 tabular">
          {data.totals.count} sale{data.totals.count === 1 ? '' : 's'} · {data.totals.items} item{data.totals.items === 1 ? '' : 's'} · Cash {formatMoney(data.totals.cash)} · Bank{' '}
          {formatMoney(data.totals.bank)}
        </p>
      </div>
      {data.sales.length === 0 ? (
        <p className="px-5 pb-6 text-sm text-fg-4 md:px-8 md:pb-7">No snack-only sales yet today.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table-stack w-full min-w-[640px] text-sm">
            <thead>
              <tr className="thead-row">
                <th className="px-8 py-3">Receipt</th>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Items</th>
                {all && <th className="px-4 py-3">Staff</th>}
                <th className="px-4 py-3">Payment</th>
                <th className="px-8 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.sales.map((s) => (
                <tr key={s.id}>
                  <td className="px-8 py-3 font-semibold text-fg tabular" data-stack="top">#{s.receipt_no}</td>
                  <td className="px-4 py-3 text-fg-3 tabular" data-label="Time">{formatTime(s.created_at, settings?.business_timezone)}</td>
                  <td className="px-4 py-3 text-fg-2" data-label="Items" data-stack="full">{s.items.map((i) => `${i.name} × ${i.quantity}`).join(', ')}</td>
                  {all && <td className="px-4 py-3 text-fg-3" data-label="Staff">{s.cashier_name}</td>}
                  <td className="px-4 py-3 text-fg-3" data-label="Payment">{s.payment_method === 'split' && s.split_cash_amount != null ? splitLabel(s.final_amount, s.split_cash_amount) : paymentLabel(s.payment_method)}</td>
                  <td className="px-8 py-3 text-right font-semibold text-fg tabular" data-stack="top end">{formatMoney(s.final_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
