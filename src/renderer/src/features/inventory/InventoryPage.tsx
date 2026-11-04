import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArchiveRestore, Boxes, PackagePlus, Pencil, PackageMinus, Search, Trash2 } from 'lucide-react'
import { formatDateTime, formatMoney } from '@shared/format'
import { toPaisa } from '@shared/billing'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { Product, ProductSearchResult } from '@/lib/types'
import { adjustStock, deleteProduct, getStockAdjustments, listProducts, saveProduct, searchProducts, setProductActive, type ProductInput } from '@/data/api'
import { keys, useAction, useDebounced, useSettings } from '@/data/hooks'
import { Button, IconButton } from '@/components/ui/Button'
import { inputClass, parseAmount, parseIntStrict, Switch, TextField } from '@/components/ui/Field'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { EmptyState, ErrorState, LoadingBlock, Page, PageHeader, Segmented } from '@/components/ui/Misc'
import { useAuth } from '@/features/auth/AuthProvider'
import { ProductSalesView } from './ProductSalesView'

const productKeys = [['products'], ['product-search'], keys.dashboard]

export function InventoryPage() {
  const { isAdmin } = useAuth()
  const [params, setParams] = useSearchParams()
  if (!isAdmin) return <StaffRestock />
  // Sales and profit show cost prices, so only administrators see them.
  const view = params.get('view') === 'sales' ? 'sales' : 'products'
  const tabs = (
    <Segmented
      layoutId="inventory-view"
      value={view}
      onChange={(v) => setParams(v === 'products' ? {} : { view: v })}
      options={[
        { value: 'products', label: 'Products' },
        { value: 'sales', label: 'Sales & profit' }
      ]}
    />
  )
  return view === 'sales' ? <ProductSalesView tabs={tabs} /> : <AdminInventory tabs={tabs} />
}

function StockBadge({ p }: { p: Pick<Product, 'track_stock' | 'stock_quantity'> & { low_stock_threshold?: number } }) {
  if (!p.track_stock) return <span className="text-xs text-fg-4">Not tracked</span>
  const low = p.stock_quantity <= (p.low_stock_threshold ?? 0)
  return (
    <span
      className={cn(
        'inline-flex min-w-12 justify-center rounded-full px-2.5 py-0.5 text-xs font-bold tabular',
        p.stock_quantity === 0 ? 'bg-claret-500/12 text-claret-700' : low ? 'bg-brass-500/12 text-brass-700' : 'bg-forest-950/[0.05] text-fg'
      )}
    >
      {p.stock_quantity}
    </span>
  )
}

function AdminInventory({ tabs }: { tabs: ReactNode }) {
  const [showInactive, setShowInactive] = useState(false)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  const [restocking, setRestocking] = useState<ProductSearchResult | null>(null)
  const [deactivating, setDeactivating] = useState<Product | null>(null)
  const [deleting, setDeleting] = useState<Product | null>(null)
  const { data, isLoading, error, refetch } = useQuery({ queryKey: keys.products(showInactive), queryFn: () => listProducts(showInactive) })
  const toggle = useAction((a: { id: string; active: boolean }) => setProductActive(a.id, a.active), {
    invalidate: productKeys,
    success: (p) => (p.is_active ? `${p.name} is available again.` : `${p.name} removed from sale.`)
  })
  const remove = useAction(deleteProduct, { invalidate: productKeys, success: 'Product deleted.' })

  const q = query.trim().toLowerCase()
  const products = (data ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q))
  const stockValue = useMemo(
    () => (data ?? []).filter((p) => p.is_active && p.track_stock).reduce((s, p) => s + toPaisa(p.cost_price) * p.stock_quantity, 0) / 100,
    [data]
  )
  const lowCount = (data ?? []).filter((p) => p.is_active && p.track_stock && p.stock_quantity <= p.low_stock_threshold).length

  return (
    <Page>
      <PageHeader
        title="Inventory"
        subtitle={data ? `${data.filter((p) => p.is_active).length} products · stock at cost ${formatMoney(stockValue)}${lowCount ? ` · ${lowCount} low on stock` : ''}` : undefined}
        actions={
          <>
            {tabs}
            <Button variant="primary" icon={<PackagePlus className="size-4" />} onClick={() => setEditing('new')}>
              Add product
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-fg-4" />
            <input className={cn(inputClass, 'pl-10')} placeholder="Search products…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="w-full sm:w-64">
            <Switch checked={showInactive} onChange={setShowInactive} label="Show removed products" />
          </div>
        </div>
      </PageHeader>

      <div className="card overflow-hidden">
        {error ? (
          <div className="p-6">
            <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
          </div>
        ) : isLoading ? (
          <LoadingBlock />
        ) : products.length === 0 ? (
          <EmptyState
            icon={<Boxes className="size-5" />}
            title={data?.length ? 'No matching products' : 'No products yet'}
            description={data?.length ? 'Try another search.' : 'Add the snacks and drinks you sell.'}
          />
        ) : (
          <table className="table-stack w-full text-sm">
            <thead>
              <tr className="thead-row">
                <th className="px-5 py-3 font-semibold">Product</th>
                <th className="px-5 py-3 text-right font-semibold">Cost</th>
                <th className="px-5 py-3 text-right font-semibold">Price</th>
                <th className="px-5 py-3 text-right font-semibold">Profit / unit</th>
                <th className="px-5 py-3 text-center font-semibold">Stock</th>
                <th className="px-5 py-3 text-right font-semibold">Sold</th>
                <th className="w-36 px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {products.map((p) => {
                const profit = (toPaisa(p.selling_price) - toPaisa(p.cost_price)) / 100
                const margin = Number(p.selling_price) > 0 ? Math.round((profit / Number(p.selling_price)) * 100) : 0
                return (
                  <tr key={p.id} className={cn('transition-colors hover:bg-forest-950/[0.02]', !p.is_active && 'opacity-55')}>
                    <td className="px-5 py-3" data-stack="title">
                      <p className="font-semibold text-fg">{p.name}</p>
                      <p className="text-xs text-fg-4">
                        {p.category || 'Uncategorised'}
                        {!p.is_active && ' · removed'}
                      </p>
                    </td>
                    <td className="px-5 py-3 text-right text-fg-3 tabular" data-label="Cost">{formatMoney(p.cost_price)}</td>
                    <td className="px-5 py-3 text-right font-semibold text-fg tabular" data-label="Price">{formatMoney(p.selling_price)}</td>
                    <td className={cn('px-5 py-3 text-right font-bold tabular', profit >= 0 ? 'text-sage-700' : 'text-claret-700')} data-label="Profit / unit">
                      {formatMoney(profit)}
                      <span className="ml-1.5 text-xs font-medium text-fg-4">{margin}%</span>
                    </td>
                    <td className="px-5 py-3 text-center" data-label="Stock">
                      <StockBadge p={p} />
                    </td>
                    <td className="px-5 py-3 text-right text-fg-3 tabular" data-label="Sold">{p.units_sold}</td>
                    <td className="px-3 py-2" data-stack="full">
                      <div className="flex justify-end gap-1">
                        {p.track_stock && p.is_active && (
                          <IconButton size="sm" label="Restock / correct stock" onClick={() => setRestocking(p)}>
                            <Boxes className="size-4" />
                          </IconButton>
                        )}
                        <IconButton size="sm" label="Edit" onClick={() => setEditing(p)}>
                          <Pencil className="size-4" />
                        </IconButton>
                        {p.is_active ? (
                          <IconButton size="sm" variant="danger" label="Remove from sale" onClick={() => setDeactivating(p)}>
                            <PackageMinus className="size-4" />
                          </IconButton>
                        ) : (
                          <IconButton size="sm" label="Restore" onClick={() => toggle.mutate({ id: p.id, active: true })}>
                            <ArchiveRestore className="size-4" />
                          </IconButton>
                        )}
                        {p.units_sold === 0 && (
                          <IconButton size="sm" variant="danger" label="Delete product" onClick={() => setDeleting(p)}>
                            <Trash2 className="size-4" />
                          </IconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <ProductDialog product={editing} onClose={() => setEditing(null)} />
      <RestockDialog product={restocking} onClose={() => setRestocking(null)} />
      <ConfirmDialog
        open={deactivating !== null}
        onOpenChange={(o) => !o && setDeactivating(null)}
        title={`Remove ${deactivating?.name ?? ''} from sale?`}
        confirmLabel="Remove"
        description="It disappears from product search. Open tabs that already contain it, and past sales, are not affected. You can restore it at any time."
        onConfirm={async () => {
          if (deactivating) await toggle.mutateAsync({ id: deactivating.id, active: false })
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''} for good?`}
        confirmLabel="Delete product"
        description="Only a product that has never been sold can be deleted. Products with sales history can only be removed from sale, so past invoices keep their name and price."
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id)
        }}
      />
    </Page>
  )
}

function ProductDialog({ product, onClose }: { product: Product | 'new' | null; onClose: () => void }) {
  const isNew = product === 'new'
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [cost, setCost] = useState('')
  const [price, setPrice] = useState('')
  const [track, setTrack] = useState(true)
  const [threshold, setThreshold] = useState('5')
  const [initial, setInitial] = useState('0')
  const [submitted, setSubmitted] = useState(false)
  const save = useAction(saveProduct, { invalidate: productKeys, success: (p) => `${p.name} saved.` })

  useEffect(() => {
    if (!product) return
    setSubmitted(false)
    if (product === 'new') {
      setName('')
      setCategory('')
      setCost('')
      setPrice('')
      setTrack(true)
      setThreshold('5')
      setInitial('0')
    } else {
      setName(product.name)
      setCategory(product.category)
      setCost(String(product.cost_price))
      setPrice(String(product.selling_price))
      setTrack(product.track_stock)
      setThreshold(String(product.low_stock_threshold))
    }
  }, [product])

  const costN = parseAmount(cost)
  const priceN = parseAmount(price)
  const thresholdN = parseIntStrict(threshold)
  const initialN = parseIntStrict(initial)
  const errors = {
    name: !name.trim() ? 'Name is required.' : name.length > 80 ? 'At most 80 characters.' : null,
    cost: costN === null ? 'Enter the cost price.' : null,
    price: priceN === null ? 'Enter the selling price.' : null,
    threshold: thresholdN === null || thresholdN < 0 ? 'Enter 0 or more.' : null,
    initial: isNew && track && (initialN === null || initialN < 0) ? 'Enter 0 or more.' : null
  }
  const valid = Object.values(errors).every((e) => !e)
  const profit = costN !== null && priceN !== null ? (toPaisa(priceN) - toPaisa(costN)) / 100 : null

  const submit = () => {
    setSubmitted(true)
    if (!valid || !product) return
    const input: ProductInput = {
      id: isNew ? null : (product as Product).id,
      name: name.trim(),
      category: category.trim(),
      cost_price: costN!,
      selling_price: priceN!,
      track_stock: track,
      low_stock_threshold: thresholdN!,
      initial_stock: isNew && track ? initialN! : 0
    }
    save.mutate(input, { onSuccess: onClose })
  }
  const show = (e: string | null) => (submitted ? e : null)

  return (
    <Modal
      open={product !== null}
      onOpenChange={(o) => !o && !save.isPending && onClose()}
      title={isNew ? 'Add product' : `Edit ${(product as Product | null)?.name ?? ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={save.isPending}>
            Save product
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <TextField containerClassName="col-span-2" label="Name" value={name} onChange={(e) => setName(e.target.value)} error={show(errors.name)} autoFocus />
        <TextField containerClassName="col-span-2" label="Category" placeholder="e.g. Drinks, Snacks" value={category} onChange={(e) => setCategory(e.target.value)} />
        <TextField label="Cost price" prefix="PKR" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} error={show(errors.cost)} />
        <TextField label="Selling price" prefix="PKR" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} error={show(errors.price)} />
        <div className="col-span-2 rounded-xl bg-sunken/70 px-4 py-3 text-sm">
          Profit per unit:{' '}
          <span className={cn('font-bold tabular', profit === null ? 'text-fg-4' : profit >= 0 ? 'text-sage-700' : 'text-claret-700')}>
            {profit === null ? '—' : formatMoney(profit)}
          </span>
        </div>
        <div className="col-span-2">
          <Switch checked={track} onChange={setTrack} label="Track stock" description="Prevents selling more than you have and warns when stock runs low." />
        </div>
        {track && (
          <>
            <TextField label="Low-stock warning at" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} error={show(errors.threshold)} />
            {isNew ? (
              <TextField label="Opening stock" inputMode="numeric" value={initial} onChange={(e) => setInitial(e.target.value)} error={show(errors.initial)} />
            ) : (
              <p className="self-end pb-2.5 text-xs text-fg-4">Change stock with Restock so concurrent sales are never overwritten.</p>
            )}
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

function RestockDialog({ product, onClose }: { product: ProductSearchResult | null; onClose: () => void }) {
  const [mode, setMode] = useState<'add' | 'remove'>('add')
  const [qty, setQty] = useState('')
  const adjust = useAction((a: { id: string; delta: number }) => adjustStock(a.id, a.delta), {
    invalidate: productKeys,
    success: (rows) => (rows[0] ? `${rows[0].name}: ${rows[0].stock_quantity} in stock.` : 'Stock updated.')
  })
  useEffect(() => {
    if (product) {
      setMode('add')
      setQty('')
    }
  }, [product])
  const n = parseIntStrict(qty)
  const valid = n !== null && n > 0 && n <= 100000 && (mode === 'add' || (product ? n <= product.stock_quantity : false))
  const after = product && n ? product.stock_quantity + (mode === 'add' ? n : -n) : null

  const submit = () => {
    if (!product || !valid) return
    adjust.mutate({ id: product.id, delta: mode === 'add' ? n! : -n! }, { onSuccess: onClose })
  }

  return (
    <Modal
      open={product !== null}
      onOpenChange={(o) => !o && !adjust.isPending && onClose()}
      size="sm"
      title={`Stock · ${product?.name ?? ''}`}
      description={`Currently ${product?.stock_quantity ?? 0} in stock.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={adjust.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={adjust.isPending} disabled={!valid}>
            {mode === 'add' ? 'Add stock' : 'Remove stock'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          {(['add', 'remove'] as const).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                'h-11 rounded-xl border text-sm font-bold transition-colors',
                mode === m ? 'border-transparent bg-forest-950 text-cream' : 'border-transparent bg-sunken/80 text-fg-3 hover:text-fg'
              )}
            >
              {m === 'add' ? 'Received stock' : 'Correct (remove)'}
            </button>
          ))}
        </div>
        <TextField label="Quantity" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus hint={after !== null ? `Stock after: ${after}` : undefined} />
        <button type="submit" hidden />
      </form>
      {product && <StockLog productId={product.id} />}
    </Modal>
  )
}

/** Administrators: who changed this product's stock, by how much, and when (the database's stock log). */
function StockLog({ productId }: { productId: string }) {
  const { isAdmin } = useAuth()
  const { data: settings } = useSettings()
  const { data } = useQuery({ queryKey: keys.stockLog(productId), queryFn: () => getStockAdjustments(productId), enabled: isAdmin })
  if (!isAdmin || !data) return null
  return (
    <section className="mt-5 border-t border-line pt-4" data-testid="stock-log">
      <p className="label">Recent stock changes</p>
      {data.length === 0 ? (
        <p className="mt-2 text-xs text-fg-4">No manual changes yet. Sales and voids are recorded with each invoice.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line text-[13px]">
          {data.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="block truncate font-semibold text-fg">
                  {a.source === 'opening' ? 'Opening stock' : a.delta > 0 ? 'Received' : 'Corrected'} · {a.user_name ?? 'Former user'}
                </span>
                <span className="block text-xs text-fg-4 tabular">{formatDateTime(a.created_at, settings?.business_timezone)}</span>
              </span>
              <span className="shrink-0 text-right tabular">
                <span className={cn('block font-bold', a.delta > 0 ? 'text-sage-700' : 'text-claret-700')}>
                  {a.delta > 0 ? '+' : '−'}
                  {Math.abs(a.delta)}
                </span>
                <span className="block text-xs text-fg-4">{a.stock_after} after</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Staff with the "Restock products" permission: no cost prices, stock only. */
function StaffRestock() {
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query.trim(), 200)
  const [restocking, setRestocking] = useState<ProductSearchResult | null>(null)
  const { data, isLoading, error, refetch } = useQuery({ queryKey: keys.productSearch(`inv:${debounced}`), queryFn: () => searchProducts(debounced, 100) })
  return (
    <Page>
      <PageHeader title="Restock" subtitle="Record stock you receive. Prices are managed by an administrator.">
        <div className="relative w-full sm:w-80">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-fg-4" />
          <input className={cn(inputClass, 'pl-10')} placeholder="Search products…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </PageHeader>
      <div className="card overflow-hidden">
        {error ? (
          <div className="p-6">
            <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
          </div>
        ) : isLoading ? (
          <LoadingBlock />
        ) : !data?.length ? (
          <EmptyState icon={<Boxes className="size-5" />} title="No products found" />
        ) : (
          <table className="table-stack w-full text-sm">
            <thead>
              <tr className="thead-row">
                <th className="px-5 py-3 font-semibold">Product</th>
                <th className="px-5 py-3 text-right font-semibold">Price</th>
                <th className="px-5 py-3 text-center font-semibold">Stock</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.map((p) => (
                <tr key={p.id}>
                  <td className="px-5 py-3" data-stack="title">
                    <p className="font-semibold text-fg">{p.name}</p>
                    <p className="text-xs text-fg-4">{p.category || 'Uncategorised'}</p>
                  </td>
                  <td className="px-5 py-3 text-right text-fg-2 tabular" data-label="Price">{formatMoney(p.selling_price)}</td>
                  <td className="px-5 py-3 text-center" data-label="Stock">
                    <StockBadge p={p} />
                  </td>
                  <td className="px-5 py-2 text-right" data-stack="full">
                    {p.track_stock && (
                      <Button size="sm" onClick={() => setRestocking(p)}>
                        Update stock
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <RestockDialog product={restocking} onClose={() => setRestocking(null)} />
    </Page>
  )
}
