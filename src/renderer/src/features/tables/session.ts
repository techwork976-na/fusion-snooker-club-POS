import { billableSeconds, isAllocationComplete, sessionCharge, toPaisa, type BillingPolicy } from '@shared/billing'
import { useBillingPolicy, useServerNow, useAction, keys } from '@/data/hooks'
import * as api from '@/data/api'
import type { ActiveSession, SessionStatus } from '@/lib/types'

export interface LiveFigures {
  seconds: number
  tableCharge: number
  itemsTotal: number
  itemsCount: number
  total: number
  /** Seconds left on a booking — stops at 0, never negative; null for open play. */
  remaining: number | null
  /** The booking is used up: billing holds until staff end or continue the session. */
  timeUp: boolean
  /** Extra time played after staff chose to continue past the booking. */
  extraSeconds: number | null
}

export function computeLive(session: ActiveSession, policy: BillingPolicy, nowMs: number): LiveFigures {
  const seconds = billableSeconds(session, nowMs)
  const tableCharge =
    session.base_amount != null && session.status === 'billing'
      ? Number(session.base_amount)
      : sessionCharge(
          {
            billableSeconds: seconds,
            ratePerMinute: session.rate_per_minute,
            bookedSeconds: session.booked_seconds,
            bookedAmount: session.booked_amount,
            tiered:
              session.pricing_mode === 'tiered_hourly' && session.hourly_rate != null && session.under_hour_rate != null
                ? { hourlyRate: session.hourly_rate, underHourRate: session.under_hour_rate }
                : null
          },
          policy
        )
  const itemsPaisa = session.items.reduce((sum, i) => sum + toPaisa(i.unit_price) * i.quantity, 0)
  const itemsTotal = itemsPaisa / 100
  return {
    seconds,
    tableCharge,
    itemsTotal,
    itemsCount: session.items.reduce((n, i) => n + i.quantity, 0),
    total: (toPaisa(tableCharge) + itemsPaisa) / 100,
    remaining: session.booked_seconds != null ? Math.max(0, session.booked_seconds - seconds) : null,
    timeUp: (session.status === 'running' || session.status === 'paused') && isAllocationComplete(session, nowMs),
    extraSeconds: session.booked_seconds != null && session.allocation_extended_at ? Math.max(0, seconds - session.booked_seconds) : null
  }
}

/** Live timer + charges for a session, ticking with the server-aligned clock. */
export function useLive(session: ActiveSession | null): LiveFigures | null {
  const now = useServerNow()
  const policy = useBillingPolicy()
  if (!session || !policy) return null
  return computeLive(session, policy, now)
}

/**
 * Visual treatment per status — solid, matte colours that read at a glance:
 * `dot` for markers and the floor bar, `pill` for the status badge and
 * `text` for the live figures. Forest is play, champagne a pause, brass the
 * money moment (checkout); everything at rest stays neutral.
 */
export const statusMeta: Record<SessionStatus | 'available', { label: string; dot: string; text: string; pill: string }> = {
  available: { label: 'Available', dot: 'bg-fg-5', text: 'text-fg-3', pill: 'bg-forest-950/[0.05] text-fg-3' },
  running: { label: 'Running', dot: 'bg-forest-600', text: 'text-forest-950', pill: 'bg-sage-100 text-forest-800' },
  paused: { label: 'Paused', dot: 'bg-brass-300', text: 'text-brass-700', pill: 'bg-brass-100 text-brass-800' },
  billing: { label: 'Checkout', dot: 'bg-brass-600', text: 'text-brass-700', pill: 'bg-brass-600 text-surface' },
  completed: { label: 'Paid', dot: 'bg-fg-4', text: 'text-fg-3', pill: 'bg-sunken text-fg-3' },
  cancelled: { label: 'Cancelled', dot: 'bg-fg-5', text: 'text-fg-4', pill: 'bg-sunken text-fg-4' },
  voided: { label: 'Voided', dot: 'bg-claret-500', text: 'text-claret-700', pill: 'bg-claret-50 text-claret-700' }
}

/** A booking whose time is used up: an alert, not an error — claret marks it. */
export const timeUpMeta = { label: "Time's up", dot: 'bg-claret-500', text: 'text-claret-700', pill: 'bg-claret-50 text-claret-700' }

/** Session mutations with feedback; all refresh the floor and dashboard. */
export function useSessionActions() {
  const invalidate = [keys.tables, keys.dashboard]
  return {
    start: useAction(
      (a: { tableId: string; booking: api.Booking; customer: api.CustomerRef }) => api.startSession(a.tableId, a.booking, a.customer),
      { invalidate, success: 'Session started.' }
    ),
    pause: useAction(api.pauseSession, { invalidate }),
    resume: useAction(api.resumeSession, { invalidate }),
    end: useAction(api.endSession, { invalidate }),
    reopen: useAction(api.reopenSession, { invalidate, success: 'Session reopened — the clock is running again.' }),
    acknowledge: useAction(api.acknowledgeAllocationAlert, { invalidate }),
    keepPlaying: useAction(api.continueAfterAllocation, { invalidate, success: 'Playing on — extra time is billed per minute from now.' }),
    extend: useAction(api.extendSession, { invalidate, success: 'Session extended.' }),
    cancel: useAction(api.cancelSession, { invalidate, success: 'Session cancelled without charge.' }),
    addItem: useAction((a: { sessionId: string; productId: string; quantity?: number }) => api.addSessionItem(a.sessionId, a.productId, a.quantity), {
      invalidate
    }),
    setQty: useAction((a: { itemId: string; quantity: number }) => api.setSessionItemQuantity(a.itemId, a.quantity), { invalidate })
  }
}
