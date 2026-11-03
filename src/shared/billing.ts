/**
 * FUSION billing rules — the TypeScript twin of the SQL functions
 * fusion_billed_minutes / fusion_amount_for_minutes / fusion_session_charge.
 *
 * The database is authoritative (it computes the bill when a session ends);
 * this module powers the live timer and the checkout preview, and a parity
 * test runs both implementations over thousands of inputs to keep them equal.
 *
 * Every rate is rupees per minute. All arithmetic is integer based (seconds,
 * paisa, ten-thousandths of a rupee for rates) so there is no floating point
 * drift.
 */

export type RoundingMode = 'up' | 'nearest' | 'down'

export interface BillingPolicy {
  /** Time is billed in blocks of this many minutes (1 = per minute). */
  incrementMinutes: number
  /** How a partly used block is billed. */
  rounding: RoundingMode
  /** Minimum minutes billed for any open-ended session that ran at all. */
  minimumMinutes: number
}

export const DEFAULT_POLICY: BillingPolicy = { incrementMinutes: 1, rounding: 'up', minimumMinutes: 0 }

export function toPaisa(amount: number | string): number {
  return Math.round(Number(amount) * 100)
}

export function fromPaisa(paisa: number): number {
  return paisa / 100
}

/** Minutes billed for `seconds` of play under the policy. */
export function billedMinutes(seconds: number, policy: BillingPolicy, applyMinimum = true): number {
  const s = Math.floor(seconds)
  if (!(s > 0)) return 0
  const unit = policy.incrementMinutes * 60
  let units: number
  switch (policy.rounding) {
    case 'up':
      units = Math.floor((s + unit - 1) / unit)
      break
    case 'down':
      units = Math.floor(s / unit)
      break
    case 'nearest':
      units = Math.floor((2 * s + unit) / (2 * unit))
      break
  }
  return Math.max(units * policy.incrementMinutes, applyMinimum ? policy.minimumMinutes : 0)
}

/**
 * Rates are rupees per minute with up to four decimals (an hourly price
 * converted exactly, e.g. 400/hour = 6.6667/min), held as integer
 * ten-thousandths of a rupee.
 */
const RATE_SCALE = 10_000
export const MAX_RATE_PER_MINUTE = 10_000

export function toRateUnits(ratePerMinute: number | string): number {
  return Math.round(Number(ratePerMinute) * RATE_SCALE)
}

/** A rate the database accepts: above zero, at most 10,000, at most four decimals. */
export function isValidRate(ratePerMinute: number | null | undefined): ratePerMinute is number {
  if (ratePerMinute == null || !Number.isFinite(ratePerMinute)) return false
  const units = ratePerMinute * RATE_SCALE
  return ratePerMinute > 0 && ratePerMinute <= MAX_RATE_PER_MINUTE && Math.abs(units - Math.round(units)) < 1e-6
}

/** True when two rates are the same stored value. */
export function sameRate(a: number | string, b: number | string): boolean {
  return toRateUnits(a) === toRateUnits(b)
}

/** Charge for whole minutes at a per-minute rate, rounded half-up to a whole rupee. */
export function amountForMinutes(minutes: number, ratePerMinute: number | string): number {
  const num = minutes * toRateUnits(ratePerMinute)
  return Math.floor((2 * num + RATE_SCALE) / (2 * RATE_SCALE))
}

/** Pro-rata charge for seconds of play (seconds × rate / 60), rounded half-up — re-prices booked time. */
export function amountForSeconds(seconds: number, ratePerMinute: number | string): number {
  const num = seconds * toRateUnits(ratePerMinute)
  const den = 60 * RATE_SCALE
  return Math.floor((2 * num + den) / (2 * den))
}

/** Category pricing: per minute (e.g. Snooker, Pool) or hourly with a special 30-minute price (e.g. PS5, table tennis). */
export type PricingMode = 'per_minute' | 'hourly_special30'

/** Hourly-priced categories sell time in steps of this many minutes. */
export const SLOT_STEP_MINUTES = 30
/** The longest booking, in minutes (also the database limit). */
export const MAX_BOOKED_MINUTES = 1440

export function isValidSlotMinutes(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= SLOT_STEP_MINUTES && minutes <= MAX_BOOKED_MINUTES && minutes % SLOT_STEP_MINUTES === 0
}

/**
 * The price of a duration on an hourly-priced category (fusion_slot_price in
 * SQL): exactly 30 minutes = the special 30-minute price; 1 hour or more = the
 * hourly rate × hours (1.5 h = 1.5 × hourly — the special price is never added
 * on top), rounded half-up to a rupee.
 */
export function slotPrice(minutes: number, hourlyRate: number | string, special30: number | string): number {
  if (minutes === SLOT_STEP_MINUTES) return Number(special30)
  const num = toPaisa(hourlyRate) * minutes
  const den = 60 * 100
  return Math.floor((2 * num + den) / (2 * den))
}

export interface ChargeInput {
  billableSeconds: number
  ratePerMinute: number | string
  bookedSeconds?: number | null
  bookedAmount?: number | string | null
}

/** The table charge for a session (open-ended or booked + overtime). */
export function sessionCharge(input: ChargeInput, policy: BillingPolicy): number {
  const { billableSeconds, ratePerMinute, bookedSeconds, bookedAmount } = input
  if (bookedSeconds != null && bookedAmount != null) {
    const overtime = billableSeconds - bookedSeconds
    const extra = overtime > 0 ? amountForMinutes(billedMinutes(overtime, policy, false), ratePerMinute) : 0
    return fromPaisa(toPaisa(bookedAmount) + extra * 100)
  }
  return amountForMinutes(billedMinutes(billableSeconds, policy, true), ratePerMinute)
}

/**
 * The table charge when the cashier sets a custom rate per minute at checkout
 * (SQL: fusion_charge_at_rate). The same rules apply at the custom rate to all
 * of the time: a booking's time is re-priced pro rata, overtime as usual.
 */
export function chargeAtRate(
  input: Omit<ChargeInput, 'ratePerMinute' | 'bookedAmount'>,
  ratePerMinute: number | string,
  policy: BillingPolicy
): number {
  const { billableSeconds, bookedSeconds } = input
  return sessionCharge(
    {
      billableSeconds,
      ratePerMinute,
      bookedSeconds,
      bookedAmount: bookedSeconds != null ? amountForSeconds(bookedSeconds, ratePerMinute) : null
    },
    policy
  )
}

/** Playing time a prepaid amount buys, in whole seconds (floored). */
export function secondsForAmount(amount: number | string, ratePerMinute: number | string): number {
  const rate = toRateUnits(ratePerMinute)
  if (rate <= 0) return 0
  return Math.floor((toPaisa(amount) * (RATE_SCALE / 100) * 60) / rate)
}

/** Booked price for a fixed number of minutes. */
export function amountForBookedMinutes(minutes: number, ratePerMinute: number | string): number {
  return amountForMinutes(minutes, ratePerMinute)
}

export interface SessionClock {
  status: 'running' | 'paused' | 'billing' | 'completed' | 'cancelled' | 'voided'
  started_at: string
  paused_at: string | null
  ended_at: string | null
  paused_ms: number
  billable_seconds?: number | null
  /** Fixed-time / fixed-amount bookings: the allocated play time. */
  booked_seconds?: number | null
  /** Set when staff chose to continue past a used-up booking. */
  allocation_extended_at?: string | null
}

/** Time played, ignoring the booking hold: paused and post-end time never count. */
export function playedMs(session: SessionClock, nowMs: number): number {
  const start = Date.parse(session.started_at)
  const stop = session.ended_at
    ? Date.parse(session.ended_at)
    : session.paused_at
      ? Date.parse(session.paused_at)
      : nowMs
  return Math.max(0, stop - start - Number(session.paused_ms))
}

/**
 * Billable milliseconds at `nowMs` (server-aligned), stable while paused and
 * after ending. A booking holds at its allocation — the clock stops at zero
 * time left — until staff choose to continue (fusion_billable_seconds in SQL).
 */
export function billableMs(session: SessionClock, nowMs: number): number {
  const played = playedMs(session, nowMs)
  return isAllocationHeld(session) ? Math.min(played, session.booked_seconds! * 1000) : played
}

/** A booked session that has not been continued past its allocation. */
export function isAllocationHeld(session: SessionClock): boolean {
  return session.booked_seconds != null && !session.allocation_extended_at
}

/** The allocation of a booked, not-continued session is used up ("time's up"). */
export function isAllocationComplete(session: SessionClock, nowMs: number): boolean {
  return isAllocationHeld(session) && playedMs(session, nowMs) >= session.booked_seconds! * 1000
}

export function billableSeconds(session: SessionClock, nowMs: number): number {
  if (session.billable_seconds != null && session.status !== 'running' && session.status !== 'paused') {
    return session.billable_seconds
  }
  return Math.floor(billableMs(session, nowMs) / 1000)
}

export function describePolicy(policy: BillingPolicy): string {
  const block = policy.incrementMinutes === 1 ? 'per minute' : `in ${policy.incrementMinutes}-minute blocks`
  const rounding =
    policy.rounding === 'up'
      ? 'any started block is charged in full'
      : policy.rounding === 'down'
        ? 'unfinished blocks are not charged'
        : 'blocks are rounded to the nearest (half up)'
  const minimum = policy.minimumMinutes > 0 ? `, minimum ${policy.minimumMinutes} min` : ''
  return `Billed ${block}; ${rounding}${minimum}. Amounts round to the nearest rupee.`
}
