import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import type { BillingPolicy } from '@shared/billing'
import { supabase } from '@/lib/supabase'
import { errorMessage } from '@/lib/errors'
import { useToast } from '@/components/ui/Toast'
import * as api from './api'

export const keys = {
  settings: ['settings'] as const,
  floors: ['floors'] as const,
  categories: ['categories'] as const,
  clubTables: ['club-tables'] as const,
  tables: ['tables'] as const,
  dashboard: ['dashboard'] as const,
  products: (inactive: boolean) => ['products', inactive] as const,
  productSearch: (q: string) => ['product-search', q] as const,
  stockLog: (productId: string) => ['products', 'stock-log', productId] as const,
  customers: (q: string) => ['customers', q] as const,
  sales: (f: api.SalesFilter) => ['sales', f] as const,
  report: (from: string, to: string, cashier: string | null) => ['report', from, to, cashier] as const,
  openDays: ['open-days'] as const,
  summaries: ['summaries'] as const,
  users: ['users'] as const,
  switchTargets: ['switch-targets'] as const,
  businessDate: ['business-date'] as const,
  myCounter: ['my-counter'] as const,
  shift: (id: string) => ['shift', id] as const,
  history: (from: string, to: string) => ['history', from, to] as const,
  bookings: (from: string, to: string) => ['bookings', from, to] as const,
  rankings: (metric: string) => ['rankings', metric] as const,
  retention: ['retention'] as const,
  financialReport: (from: string, to: string) => ['financial-report', from, to] as const,
  expenses: (from: string, to: string) => ['expenses', from, to] as const,
  productSales: (from: string, to: string) => ['product-sales', from, to] as const,
  snackSales: (from: string, to: string) => ['snack-sales', from, to] as const,
  tableSales: (from: string, to: string) => ['table-sales', from, to] as const
}

/** Everything that shows money or shift state; refreshed after any counter activity. */
export const accountingKeys: QueryKey[] = [
  keys.dashboard,
  keys.myCounter,
  ['shift'],
  ['history'],
  ['sales'],
  ['report'],
  keys.openDays,
  ['rankings'],
  keys.retention,
  ['financial-report'],
  ['expenses'],
  ['product-sales'],
  ['snack-sales'],
  ['table-sales']
]

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: api.getSettings, staleTime: 60_000 })

/** The signed-in staff member's counter (open shift, expenses, recent shifts). */
export const useMyCounter = (enabled = true) =>
  useQuery({ queryKey: keys.myCounter, queryFn: api.getMyCounter, enabled, refetchInterval: 30_000 })
export const useFloors = () => useQuery({ queryKey: keys.floors, queryFn: api.getFloors, staleTime: 60_000 })
export const useBusinessDate = () => useQuery({ queryKey: keys.businessDate, queryFn: api.getCurrentBusinessDate, staleTime: 60_000 })
export const useCategories = () => useQuery({ queryKey: keys.categories, queryFn: api.getCategories, staleTime: 60_000 })

export function useBillingPolicy(): BillingPolicy | null {
  const { data } = useSettings()
  if (!data) return null
  return {
    incrementMinutes: data.billing_increment_minutes,
    rounding: data.billing_rounding,
    minimumMinutes: data.minimum_charge_minutes
  }
}

export function useTablesOverview() {
  const query = useQuery({
    queryKey: keys.tables,
    queryFn: async () => {
      const sent = Date.now()
      const data = await api.getTablesOverview()
      serverClock.sync(Date.parse(data.server_time), sent, Date.now())
      return data
    },
    refetchInterval: 20_000
  })
  return query
}

export const useDashboard = () =>
  useQuery({
    queryKey: keys.dashboard,
    queryFn: async () => {
      const sent = Date.now()
      const data = await api.getDashboard()
      serverClock.sync(Date.parse(data.server_time), sent, Date.now())
      return data
    },
    refetchInterval: 30_000
  })

/**
 * Wraps a mutation with toasts and invalidation of the given query keys.
 */
export function useAction<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  opts: { invalidate?: QueryKey[]; success?: string | ((r: TResult) => string); silent?: boolean } = {}
) {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      for (const key of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: key })
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(result) : opts.success)
    },
    onError: (error) => {
      if (!opts.silent) toast.error(errorMessage(error))
    }
  })
}

// ---------------------------------------------------------------------------
// Server-aligned clock. Timers display (server now − started_at − paused), so
// a terminal with a wrong system clock still shows the correct elapsed time.
// ---------------------------------------------------------------------------
type Listener = () => void
const serverClock = (() => {
  let offset = 0
  const listeners = new Set<Listener>()
  let timer: ReturnType<typeof setInterval> | null = null
  const tick = () => listeners.forEach((l) => l())
  return {
    sync(serverMs: number, sentMs: number, receivedMs: number) {
      if (!Number.isFinite(serverMs)) return
      offset = serverMs - (sentMs + receivedMs) / 2
      tick()
    },
    subscribe(listener: Listener) {
      listeners.add(listener)
      if (!timer) timer = setInterval(tick, 1000)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer) {
          clearInterval(timer)
          timer = null
        }
      }
    },
    // Computed on every read (never a cached value that went stale while no
    // timer was on screen), rounded to the second so it is stable per render.
    get: () => Math.floor((Date.now() + offset) / 1000) * 1000
  }
})()

/** Server-aligned "now" in ms, re-rendering once per second. */
export function useServerNow(): number {
  return useSyncExternalStore(serverClock.subscribe, serverClock.get)
}

/** Periodically re-syncs the clock offset with the database time. */
export function useServerClockSync() {
  useEffect(() => {
    let cancelled = false
    const sync = async () => {
      try {
        const sent = Date.now()
        const iso = await api.getServerTime()
        if (!cancelled) serverClock.sync(Date.parse(iso), sent, Date.now())
      } catch {
        // Next attempt will retry.
      }
    }
    void sync()
    const id = setInterval(sync, 5 * 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])
}

/**
 * Realtime: when any terminal changes a session, tab, sale, counter, expense
 * or booking, refresh the affected screens here (Row Level Security limits
 * each user to the changes they may see). Polling remains as a fallback.
 */
export function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient()
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!enabled) return
    const refresh = () => {
      if (pending.current) clearTimeout(pending.current)
      pending.current = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: keys.tables })
        for (const key of accountingKeys) void qc.invalidateQueries({ queryKey: key })
        void qc.invalidateQueries({ queryKey: ['bookings'] })
      }, 250)
    }
    const channel = supabase()
      .channel('fusion-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'session_items' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'club_tables' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'counter_shifts' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shift_daily_totals' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, refresh)
      .subscribe()
    return () => {
      if (pending.current) clearTimeout(pending.current)
      void supabase().removeChannel(channel)
    }
  }, [enabled, qc])
}

/** Debounced value for search boxes. */
export function useDebounced<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}
