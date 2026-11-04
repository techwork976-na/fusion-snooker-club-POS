import { describe, expect, it } from 'vitest'
import {
  amountForBookedMinutes,
  amountForMinutes,
  amountForSeconds,
  billableSeconds,
  billedMinutes,
  chargeAtRate,
  isAllocationComplete,
  isValidRate,
  isValidSlotMinutes,
  endedEarly,
  slotPrice,
  sameRate,
  secondsForAmount,
  sessionCharge,
  tierPrice,
  tierSecondsForAmount,
  type BillingPolicy
} from '@shared/billing'
import { paymentLabel, splitLabel } from '@shared/format'
import { paymentRows } from '@shared/receipt'

const perMinuteUp: BillingPolicy = { incrementMinutes: 1, rounding: 'up', minimumMinutes: 0 }

describe('billed minutes', () => {
  it('charges every started minute by default', () => {
    expect(billedMinutes(0, perMinuteUp)).toBe(0)
    expect(billedMinutes(1, perMinuteUp)).toBe(1)
    expect(billedMinutes(60, perMinuteUp)).toBe(1)
    expect(billedMinutes(61, perMinuteUp)).toBe(2)
    expect(billedMinutes(570, perMinuteUp)).toBe(10) // 9:30
  })

  it('supports blocks, nearest and down rounding', () => {
    const quarter = { incrementMinutes: 15, rounding: 'up' as const, minimumMinutes: 0 }
    expect(billedMinutes(16 * 60, quarter)).toBe(30)
    const nearest = { incrementMinutes: 10, rounding: 'nearest' as const, minimumMinutes: 0 }
    expect(billedMinutes(4 * 60 + 59, nearest)).toBe(0)
    expect(billedMinutes(5 * 60, nearest)).toBe(10) // exactly half rounds up
    const down = { incrementMinutes: 1, rounding: 'down' as const, minimumMinutes: 0 }
    expect(billedMinutes(119, down)).toBe(1)
  })

  it('applies the minimum only to time actually played', () => {
    const min30 = { ...perMinuteUp, minimumMinutes: 30 }
    expect(billedMinutes(0, min30)).toBe(0)
    expect(billedMinutes(5 * 60, min30)).toBe(30)
    expect(billedMinutes(45 * 60, min30)).toBe(45)
    expect(billedMinutes(5 * 60, min30, false)).toBe(5)
  })
})

describe('amounts', () => {
  // Rates are rupees per minute (the former hourly cases, converted: 600/h = 10/min).
  it('rounds to the nearest rupee, half up', () => {
    expect(amountForMinutes(10, 10)).toBe(100)
    expect(amountForMinutes(7, 8.3333)).toBe(58) // 58.33 (500/h)
    expect(amountForMinutes(3, 9.5)).toBe(29) // 28.5 → 29
    expect(amountForMinutes(1, 16.6665)).toBe(17) // 16.67 (999.99/h)
    expect(amountForMinutes(100, 10)).toBe(1000)
  })

  it('open sessions use elapsed time; bookings pay the booking plus overtime, or only the time played if ended early', () => {
    expect(sessionCharge({ billableSeconds: 3600, ratePerMinute: 10 }, perMinuteUp)).toBe(600)
    const booked = { ratePerMinute: 10, bookedSeconds: 1800, bookedAmount: 300 }
    expect(sessionCharge({ ...booked, billableSeconds: 600 }, perMinuteUp)).toBe(100) // ended early: 10 minutes
    expect(sessionCharge({ ...booked, billableSeconds: 1800 }, perMinuteUp)).toBe(300)
    expect(sessionCharge({ ...booked, billableSeconds: 1801 }, perMinuteUp)).toBe(310)
    expect(sessionCharge({ ...booked, billableSeconds: 1800 + 310 }, perMinuteUp)).toBe(360)
  })

  it('converts a prepaid amount into whole seconds of play', () => {
    expect(secondsForAmount(400, 10)).toBe(2400)
    expect(secondsForAmount(400, 11.6667)).toBe(2057) // 700/h
    expect(secondsForAmount(100, 0)).toBe(0)
    expect(amountForBookedMinutes(45, 10)).toBe(450)
  })

  it('bills an exact hourly conversion the same as before (400/h = 6.6667/min)', () => {
    for (const minutes of [1, 3, 30, 60, 100, 180, 600]) {
      expect(amountForMinutes(minutes, 6.6667)).toBe(Math.round((minutes * 400) / 60))
    }
  })
})

describe('custom rate per minute at checkout', () => {
  it('re-prices 100 minutes from 10/min (1,000) to 9/min (900)', () => {
    const played = { billableSeconds: 100 * 60, bookedSeconds: null }
    expect(sessionCharge({ ...played, ratePerMinute: 10 }, perMinuteUp)).toBe(1000)
    expect(chargeAtRate(played, 9, perMinuteUp)).toBe(900)
    // A later PKR 30 discount is taken from the re-priced bill: 870.
    expect(chargeAtRate(played, 9, perMinuteUp) - 30).toBe(870)
  })

  it('follows the billing rules (blocks, minimum) at the custom rate', () => {
    const quarter = { incrementMinutes: 15, rounding: 'up' as const, minimumMinutes: 30 }
    expect(chargeAtRate({ billableSeconds: 16 * 60 }, 8, quarter)).toBe(240) // 30 min minimum
    expect(chargeAtRate({ billableSeconds: 31 * 60 }, 8, quarter)).toBe(360) // 45 min
  })

  it('re-prices booked time pro rata, overtime as usual, and an early end by the time played', () => {
    // 60 booked minutes + 5 over, at 9/min instead of 10/min.
    expect(chargeAtRate({ billableSeconds: 65 * 60, bookedSeconds: 3600 }, 9, perMinuteUp)).toBe(585)
    // A prepaid PKR 500 at 10/min bought 3000 s; at 8/min that time costs 400…
    expect(chargeAtRate({ billableSeconds: 3000, bookedSeconds: 3000 }, 8, perMinuteUp)).toBe(400)
    // …and ended early after 2000 s (34 started minutes) it costs 272.
    expect(chargeAtRate({ billableSeconds: 2000, bookedSeconds: 3000 }, 8, perMinuteUp)).toBe(272)
    expect(amountForSeconds(90, 10)).toBe(15)
  })

  it('validates rates like the database', () => {
    expect(isValidRate(9)).toBe(true)
    expect(isValidRate(6.6667)).toBe(true)
    expect(isValidRate(0)).toBe(false)
    expect(isValidRate(-1)).toBe(false)
    expect(isValidRate(1.23456)).toBe(false)
    expect(isValidRate(10_001)).toBe(false)
    expect(isValidRate(null)).toBe(false)
    expect(sameRate('10.0000', 10)).toBe(true)
    expect(sameRate(9.99, 10)).toBe(false)
  })
})

describe('live clock', () => {
  const t0 = Date.parse('2026-10-31T18:00:00Z')
  const base = {
    started_at: '2026-10-31T18:00:00Z',
    paused_at: null as string | null,
    ended_at: null as string | null,
    paused_ms: 0
  }

  it('counts from the persisted start time', () => {
    expect(billableSeconds({ ...base, status: 'running' }, t0 + 125_400)).toBe(125)
  })

  it('freezes while paused and excludes earlier pauses', () => {
    const paused = { ...base, status: 'paused' as const, paused_at: '2026-10-31T18:09:30Z', paused_ms: 60_000 }
    // Paused at 9:30 wall time with 1 minute paused earlier → 8:30 billable,
    // no matter how much later we look.
    expect(billableSeconds(paused, t0 + 3_600_000)).toBe(510)
  })

  it('uses the server-computed value once ended', () => {
    expect(billableSeconds({ ...base, status: 'billing', ended_at: '2026-10-31T19:00:00Z', billable_seconds: 3333 }, t0)).toBe(3333)
  })
})

describe("time's up: a booking holds at its allocation", () => {
  const t0 = Date.parse('2026-11-03T18:00:00Z')
  const booked = { status: 'running' as const, started_at: '2026-11-03T18:00:00Z', paused_at: null, ended_at: null, paused_ms: 0, booked_seconds: 1800 }

  it('stops the billable clock at the booked time until staff continue', () => {
    expect(billableSeconds(booked, t0 + 29 * 60_000)).toBe(29 * 60)
    expect(isAllocationComplete(booked, t0 + 29 * 60_000)).toBe(false)
    expect(billableSeconds(booked, t0 + 45 * 60_000)).toBe(1800)
    expect(isAllocationComplete(booked, t0 + 30 * 60_000)).toBe(true)
    // The charge therefore stays at the booked amount.
    expect(sessionCharge({ billableSeconds: billableSeconds(booked, t0 + 45 * 60_000), ratePerMinute: 10, bookedSeconds: 1800, bookedAmount: 300 }, perMinuteUp)).toBe(300)
  })

  it('counts on after Continue, without the held minutes (recorded as paused)', () => {
    const continued = { ...booked, paused_ms: 10 * 60_000, allocation_extended_at: '2026-11-03T18:40:00Z' }
    expect(billableSeconds(continued, t0 + 45 * 60_000)).toBe(35 * 60)
    expect(isAllocationComplete(continued, t0 + 45 * 60_000)).toBe(false)
  })

  it('never holds open play', () => {
    const open = { ...booked, booked_seconds: null }
    expect(billableSeconds(open, t0 + 90 * 60_000)).toBe(90 * 60)
    expect(isAllocationComplete(open, t0 + 90 * 60_000)).toBe(false)
  })
})

describe('hourly + special 30-minute pricing', () => {
  it('PS5 (PKR 600/hour, 30 min PKR 400): the special price is for 30 minutes only, never added on top', () => {
    const ps5 = (minutes: number) => slotPrice(minutes, 600, 400)
    expect([30, 60, 90, 120, 150, 180].map(ps5)).toEqual([400, 600, 900, 1200, 1500, 1800])
  })

  it('Table tennis (PKR 400/hour, 30 min PKR 250)', () => {
    const tt = (minutes: number) => slotPrice(minutes, 400, 250)
    expect([30, 60, 90, 120, 150, 180].map(tt)).toEqual([250, 400, 600, 800, 1000, 1200])
  })

  it('rounds half-up to a rupee and sells only 30-minute steps', () => {
    expect(slotPrice(90, 605, 400)).toBe(908) // 907.5
    expect(slotPrice(30, 600, 399.5)).toBe(399.5)
    expect([30, 60, 1440].every(isValidSlotMinutes)).toBe(true)
    expect([0, 15, 45, 61, 1470, 30.5].some(isValidSlotMinutes)).toBe(false)
  })
})

describe('under-1-hour rate (PS5: PKR 800/hour under 1 hour, PKR 600/hour from 1 hour)', () => {
  const policy = { incrementMinutes: 1, rounding: 'up' as const, minimumMinutes: 0 }
  const tiered = { hourlyRate: 600, underHourRate: 800 }
  it('prices the whole time by tier', () => {
    expect([15, 30, 45, 59, 60, 90, 120].map((m) => tierPrice(m, 600, 800))).toEqual([200, 400, 600, 787, 600, 900, 1200])
  })
  it("keeps the owner's price list: 30 min 400, 45 min 600, 1 h 600, 1 h 15 750, 1 h 30 900, 1 h 45 1,050, 2 h 1,200, 2 h 20 1,400", () => {
    expect([30, 45, 60, 75, 90, 105, 120, 140].map((m) => tierPrice(m, 600, 800))).toEqual([400, 600, 600, 750, 900, 1050, 1200, 1400])
  })
  it('switches to the hourly rate as the 60th minute is billed', () => {
    const charge = (seconds: number) => sessionCharge({ billableSeconds: seconds, ratePerMinute: 10, tiered }, policy)
    expect([charge(15 * 60), charge(59 * 60), charge(59 * 60 + 1), charge(3600), charge(90 * 60)]).toEqual([200, 787, 600, 600, 900])
  })
  it('a booking used in full is never billed below its price; ended early it bills the time played', () => {
    const booked = (seconds: number) =>
      sessionCharge({ billableSeconds: seconds, ratePerMinute: 10, bookedSeconds: 55 * 60, bookedAmount: tierPrice(55, 600, 800), tiered }, policy)
    expect([booked(10 * 60), booked(55 * 60), booked(60 * 60), booked(80 * 60)]).toEqual([133, 733, 733, 800])
  })
  it('a prepaid amount buys time at the hourly rate once it covers an hour', () => {
    expect([tierSecondsForAmount(400, 600, 800), tierSecondsForAmount(600, 600, 800), tierSecondsForAmount(700, 600, 800)]).toEqual([1800, 3600, 4200])
  })
})

describe('a booking ended early pays only the time played (1500)', () => {
  const policy = { incrementMinutes: 1, rounding: 'up' as const, minimumMinutes: 0 }
  it('per minute: billed minutes at the rate, never more than the booking', () => {
    const hour = { ratePerMinute: 10, bookedSeconds: 3600, bookedAmount: 600 }
    expect([0, 10, 60, 15 * 60, 59 * 60, 59 * 60 + 30, 3600].map((s) => sessionCharge({ ...hour, billableSeconds: s }, policy))).toEqual([
      0, 10, 10, 150, 590, 600, 600
    ])
    // PKR 1,000 at 7.5/min buys 8,000 s; 7,990 s rounds up to 134 minutes (1,005) and is capped at the booking.
    expect(sessionCharge({ ratePerMinute: 7.5, bookedSeconds: 8000, bookedAmount: 1000, billableSeconds: 7990 }, policy)).toBe(1000)
  })
  it("under-1-hour tables: the time played at the table's existing prices (the same as open play)", () => {
    const tiered = { hourlyRate: 600, underHourRate: 800 }
    // A 2-hour booking (PKR 1,200) ended early at each length on the owner's price list.
    const twoHours = (minutes: number) =>
      sessionCharge({ billableSeconds: minutes * 60, ratePerMinute: 10, bookedSeconds: 7200, bookedAmount: 1200, tiered }, policy)
    const openPlay = (minutes: number) => sessionCharge({ billableSeconds: minutes * 60, ratePerMinute: 10, tiered }, policy)
    for (const [m, price] of [[30, 400], [45, 600], [60, 600], [75, 750], [90, 900], [105, 1050]] as const) {
      expect(twoHours(m), `${m} min`).toBe(price)
      expect(twoHours(m)).toBe(openPlay(m))
    }
    // A 1-hour booking (PKR 600) ended at 50 minutes: 667 at the under-1-hour rate, never more than the booking.
    expect(sessionCharge({ billableSeconds: 50 * 60, ratePerMinute: 10, bookedSeconds: 3600, bookedAmount: 600, tiered }, policy)).toBe(600)
  })
  it('hourly + 30-minute tables: the minutes played at the existing slot prices (no new minimum)', () => {
    const slot = { hourlyRate: 600, special30: 400 }
    const charge = (played: number, bookedMinutes: number) =>
      sessionCharge({ billableSeconds: played, ratePerMinute: 10, bookedSeconds: bookedMinutes * 60, bookedAmount: slotPrice(bookedMinutes, 600, 400), slot }, policy)
    expect([charge(15 * 60, 60), charge(30 * 60, 60), charge(45 * 60, 60), charge(60 * 60, 60), charge(10 * 60, 30), charge(30 * 60, 30)]).toEqual([
      150, 400, 450, 600, 100, 400
    ])
  })
  it('tells an early end from a booking used in full', () => {
    expect([endedEarly(899, 900), endedEarly(900, 900), endedEarly(1200, 900), endedEarly(10, null)]).toEqual([true, false, false, false])
  })
})

describe('split payment labels', () => {
  it('names both parts; the bank part is the rest of the total', () => {
    expect(paymentLabel('split')).toBe('Cash + Bank')
    expect(splitLabel(1000, 300)).toBe('Cash PKR 300 + Bank PKR 700')
    expect(splitLabel(250.5, 100.25)).toBe('Cash PKR 100.25 + Bank PKR 150.25')
    expect(paymentRows({ payment_method: 'split', split_cash_amount: 300, final_amount: 1000 })).toEqual([
      ['Cash', '300'],
      ['Bank Transfer', '700']
    ])
    expect(paymentRows({ payment_method: 'cash', split_cash_amount: null, final_amount: 1000 })).toEqual([])
  })
})
