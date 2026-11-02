import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { UserRound } from 'lucide-react'
import { cn } from '@/lib/cn'
import { searchCustomers } from '@/data/api'
import { keys, useDebounced } from '@/data/hooks'
import { TextField } from '@/components/ui/Field'

export interface CustomerValue {
  id: string | null
  name: string
  phone: string
}

export const emptyCustomer: CustomerValue = { id: null, name: '', phone: '' }

/**
 * Customer name with suggestions from existing customers. Choosing one fills
 * the phone number and links the record, so no duplicate is created.
 */
export function CustomerField({ value, onChange }: { value: CustomerValue; onChange: (v: CustomerValue) => void }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const query = useDebounced(value.name.trim(), 180)
  const { data } = useQuery({
    queryKey: keys.customers(query),
    queryFn: () => searchCustomers(query, 6),
    enabled: open && query.length >= 2 && !value.id
  })
  const suggestions = (data ?? []).filter((c) => c.id !== value.id)

  useEffect(() => {
    const onDoc = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    return () => document.removeEventListener('pointerdown', onDoc)
  }, [])

  return (
    <div className="grid grid-cols-[1.4fr_1fr] gap-3">
      <div ref={boxRef} className="relative">
        <TextField
          label="Customer"
          placeholder="Name (optional)"
          value={value.name}
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onChange({ id: null, name: e.target.value, phone: value.id ? '' : value.phone })
            setOpen(true)
          }}
          suffix={value.id ? <UserRound className="size-4 text-sage-600" aria-label="Existing customer" /> : undefined}
          data-testid="customer-name"
        />
        <AnimatePresence>
          {open && suggestions.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="absolute inset-x-0 top-[calc(100%+4px)] popover z-30 p-1"
            >
              {suggestions.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={cn('flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-forest-950/[0.07]')}
                  onClick={() => {
                    onChange({ id: c.id, name: c.name, phone: c.phone ?? '' })
                    setOpen(false)
                  }}
                >
                  <span className="truncate text-sm font-semibold text-fg">{c.name}</span>
                  <span className="shrink-0 text-xs text-fg-3 tabular">{c.phone ?? 'No phone'}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <TextField
        label="Phone"
        placeholder="03xx xxxxxxx"
        inputMode="tel"
        value={value.phone}
        onChange={(e) => onChange({ id: null, name: value.name, phone: e.target.value })}
        data-testid="customer-phone"
      />
    </div>
  )
}
