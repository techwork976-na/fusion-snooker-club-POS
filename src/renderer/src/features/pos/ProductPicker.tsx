import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { PackageSearch, Search } from 'lucide-react'
import { formatMoney } from '@shared/format'
import { cn } from '@/lib/cn'
import { searchProducts } from '@/data/api'
import { keys, useDebounced } from '@/data/hooks'
import { inputClass } from '@/components/ui/Field'
import { Spinner } from '@/components/ui/Misc'
import type { ProductSearchResult } from '@/lib/types'

/**
 * Prominent product search for tabs and checkout. Type to filter, arrows to
 * move, Enter to add.
 */
export function ProductPicker({
  onPick,
  disabled,
  autoFocus,
  busy
}: {
  onPick: (product: ProductSearchResult) => void
  disabled?: boolean
  autoFocus?: boolean
  busy?: boolean
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const debounced = useDebounced(query.trim(), 150)
  const boxRef = useRef<HTMLDivElement>(null)
  const { data, isFetching } = useQuery({
    queryKey: keys.productSearch(debounced),
    queryFn: () => searchProducts(debounced, 30),
    enabled: open,
    staleTime: 10_000
  })
  const results = data ?? []

  useEffect(() => setActive(0), [debounced])
  useEffect(() => {
    const onDoc = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    return () => document.removeEventListener('pointerdown', onDoc)
  }, [])

  const available = (p: ProductSearchResult) => !p.track_stock || p.stock_quantity > 0
  const pick = (p: ProductSearchResult | undefined) => {
    if (!p || !available(p)) return
    onPick(p)
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-fg-4" />
        <input
          className={cn(inputClass, 'h-12 rounded-2xl pl-11 text-[15px]')}
          placeholder="Search snacks & drinks…"
          value={query}
          autoFocus={autoFocus}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(i + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              pick(results[active])
            } else if (e.key === 'Escape') {
              setQuery('')
              setOpen(false)
            }
          }}
          aria-label="Search products"
          data-testid="product-search"
        />
        {(isFetching || busy) && <Spinner className="absolute top-1/2 right-3.5 size-4 -translate-y-1/2" />}
      </div>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14 }}
            className="absolute inset-x-0 top-[calc(100%+6px)] popover z-30 max-h-72 overflow-y-auto p-1.5"
          >
            {results.length === 0 && !isFetching ? (
              <div className="flex items-center gap-3 px-3 py-4 text-sm text-fg-3">
                <PackageSearch className="size-4" /> No products match “{query}”.
              </div>
            ) : (
              results.map((p, i) => {
                const ok = available(p)
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={!ok}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(p)}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                      i === active && ok ? 'bg-forest-950/[0.07]' : '',
                      !ok && 'opacity-45'
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-fg">{p.name}</span>
                      <span className="block text-xs text-fg-4">
                        {p.category || 'Product'}
                        {p.track_stock ? ` · ${p.stock_quantity > 0 ? `${p.stock_quantity} in stock` : 'Out of stock'}` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-bold text-forest-600 tabular">{formatMoney(p.selling_price)}</span>
                  </button>
                )
              })
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
