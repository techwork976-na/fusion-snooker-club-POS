import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  amountForMinutes,
  amountForSeconds,
  billedMinutes,
  chargeAtRate,
  isValidRate,
  secondsForAmount,
  sessionCharge,
  tierPrice,
  tierSecondsForAmount,
  type RoundingMode
} from '@shared/billing'
import { TestDb } from './harness'

let db: TestDb
beforeAll(async () => {
  db = await TestDb.create()
})
afterAll(async () => db.close())

/** Deterministic pseudo-random generator so failures are reproducible. */
function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

describe('TypeScript billing matches the database exactly', () => {
  it('for 2,000 random sessions across every policy', async () => {
    const rand = rng(42)
    const modes: RoundingMode[] = ['up', 'nearest', 'down']
    const cases = Array.from({ length: 2000 }, () => {
      const booked = rand() < 0.3
      // Rupees per minute, including exact four-decimal conversions of hourly prices.
      const rate = [5, 7.5, 8.3333, 9.175, 10, 11.6667, 16.6665, 20][Math.floor(rand() * 8)]!
      const bookedMinutes = 1 + Math.floor(rand() * 120)
      return {
        seconds: Math.floor(rand() * 4 * 3600),
        rate,
        increment: [1, 1, 5, 10, 15, 30, 60][Math.floor(rand() * 7)]!,
        rounding: modes[Math.floor(rand() * 3)]!,
        minimum: [0, 0, 10, 30][Math.floor(rand() * 4)]!,
        bookedSeconds: booked ? bookedMinutes * 60 : null,
        bookedAmount: booked ? amountForMinutes(bookedMinutes, rate) : null
      }
    })
    const rows = await db.sql<{ i: number; charge: string; minutes: number }>(
      `select (c->>'i')::int as i,
              public.fusion_session_charge((c->>'seconds')::int, (c->>'rate')::numeric, (c->>'bookedSeconds')::int,
                (c->>'bookedAmount')::numeric, (c->>'increment')::int, c->>'rounding', (c->>'minimum')::int)::text as charge,
              public.fusion_billed_minutes((c->>'seconds')::int, (c->>'increment')::int, c->>'rounding', (c->>'minimum')::int) as minutes
       from jsonb_array_elements($1::jsonb) c order by 1`,
      [JSON.stringify(cases.map((c, i) => ({ ...c, i })))]
    )
    let checked = 0
    for (const row of rows) {
      const c = cases[row.i]!
      const policy = { incrementMinutes: c.increment, rounding: c.rounding, minimumMinutes: c.minimum }
      expect(billedMinutes(c.seconds, policy), JSON.stringify(c)).toBe(row.minutes)
      expect(
        sessionCharge(
          { billableSeconds: c.seconds, ratePerMinute: c.rate, bookedSeconds: c.bookedSeconds, bookedAmount: c.bookedAmount },
          policy
        ),
        JSON.stringify(c)
      ).toBe(Number(row.charge))
      checked++
    }
    expect(checked).toBe(2000)
  })

  it('prepaid amount → seconds matches start_session', async () => {
    for (const [amount, rate] of [
      [400, 10],
      [400, 11.6667],
      [250, 9.175],
      [1000, 16.6665],
      [75, 7.5],
      [500, 6.6667]
    ] as const) {
      const row = await db.one<{ s: number }>(`select floor($1::numeric * 60 / $2::numeric)::int s`, [amount, rate])
      expect(secondsForAmount(amount, rate)).toBe(row.s)
    }
  })

  it('custom checkout rate: TypeScript preview equals fusion_charge_at_rate for 2,000 cases', async () => {
    const rand = rng(7)
    const modes: RoundingMode[] = ['up', 'nearest', 'down']
    const cases = Array.from({ length: 2000 }, () => {
      const booked = rand() < 0.35
      return {
        seconds: Math.floor(rand() * 5 * 3600),
        rate: [0.5, 4.25, 6.6667, 7, 8.3333, 9, 9.99, 12.3456][Math.floor(rand() * 8)]!,
        increment: [1, 1, 5, 10, 15, 30][Math.floor(rand() * 6)]!,
        rounding: modes[Math.floor(rand() * 3)]!,
        minimum: [0, 0, 10, 30][Math.floor(rand() * 4)]!,
        // Fixed-time bookings are whole minutes; prepaid ones any number of seconds.
        bookedSeconds: booked ? (rand() < 0.5 ? (1 + Math.floor(rand() * 120)) * 60 : 60 + Math.floor(rand() * 7200)) : null
      }
    })
    const rows = await db.sql<{ i: number; charge: string; prorata: string }>(
      `select (c->>'i')::int as i,
              public.fusion_charge_at_rate((c->>'seconds')::int, (c->>'rate')::numeric, (c->>'bookedSeconds')::int,
                (c->>'increment')::int, c->>'rounding', (c->>'minimum')::int)::text as charge,
              public.fusion_amount_for_seconds((c->>'seconds')::int, (c->>'rate')::numeric)::text as prorata
       from jsonb_array_elements($1::jsonb) c order by 1`,
      [JSON.stringify(cases.map((c, i) => ({ ...c, i })))]
    )
    for (const row of rows) {
      const c = cases[row.i]!
      const policy = { incrementMinutes: c.increment, rounding: c.rounding, minimumMinutes: c.minimum }
      expect(chargeAtRate({ billableSeconds: c.seconds, bookedSeconds: c.bookedSeconds }, c.rate, policy), JSON.stringify(c)).toBe(
        Number(row.charge)
      )
      expect(amountForSeconds(c.seconds, c.rate), JSON.stringify(c)).toBe(Number(row.prorata))
    }
    expect(rows).toHaveLength(2000)
  })

  it('under-1-hour rate: the live timer equals fusion_tiered_charge for 2,000 sessions', async () => {
    const rand = rng(1300)
    const modes: RoundingMode[] = ['up', 'nearest', 'down']
    const rates = [
      [600, 800],
      [400, 500],
      [350.5, 420.25],
      [1000, 1500],
      [90, 120]
    ] as const
    const cases = Array.from({ length: 2000 }, () => {
      const [hourly, under] = rates[Math.floor(rand() * rates.length)]!
      const booked = rand() < 0.4
      const bookedMinutes = 1 + Math.floor(rand() * 150)
      return {
        // Many sessions around the one-hour mark, where the rate changes.
        seconds: rand() < 0.5 ? 3300 + Math.floor(rand() * 600) : Math.floor(rand() * 4 * 3600),
        hourly,
        under,
        increment: [1, 1, 5, 10, 15, 30][Math.floor(rand() * 6)]!,
        rounding: modes[Math.floor(rand() * 3)]!,
        minimum: [0, 0, 10, 30][Math.floor(rand() * 4)]!,
        bookedSeconds: booked ? bookedMinutes * 60 : null,
        bookedAmount: booked ? tierPrice(bookedMinutes, hourly, under) : null,
        amount: [100, 250.5, 400, 590, 599.99, 600, 700, 1234.56][Math.floor(rand() * 8)]!
      }
    })
    const rows = await db.sql<{ i: number; charge: string; price: string; seconds: number }>(
      `select (c->>'i')::int as i,
              public.fusion_tiered_charge((c->>'seconds')::int, (c->>'hourly')::numeric, (c->>'under')::numeric,
                (c->>'bookedSeconds')::int, (c->>'bookedAmount')::numeric, (c->>'increment')::int, c->>'rounding',
                (c->>'minimum')::int)::text as charge,
              public.fusion_tier_price(((c->>'seconds')::int / 60), (c->>'hourly')::numeric, (c->>'under')::numeric)::text as price,
              public.fusion_tier_seconds((c->>'amount')::numeric, (c->>'hourly')::numeric, (c->>'under')::numeric) as seconds
       from jsonb_array_elements($1::jsonb) c order by 1`,
      [JSON.stringify(cases.map((c, i) => ({ ...c, i })))]
    )
    for (const row of rows) {
      const c = cases[row.i]!
      const policy = { incrementMinutes: c.increment, rounding: c.rounding, minimumMinutes: c.minimum }
      const input = {
        billableSeconds: c.seconds,
        ratePerMinute: c.hourly / 60,
        bookedSeconds: c.bookedSeconds,
        bookedAmount: c.bookedAmount,
        tiered: { hourlyRate: c.hourly, underHourRate: c.under }
      }
      expect(sessionCharge(input, policy), JSON.stringify(c)).toBe(Number(row.charge))
      expect(tierPrice(Math.floor(c.seconds / 60), c.hourly, c.under), JSON.stringify(c)).toBe(Number(row.price))
      expect(tierSecondsForAmount(c.amount, c.hourly, c.under), JSON.stringify(c)).toBe(row.seconds)
    }
    expect(rows).toHaveLength(2000)
  })

  it('rate validation matches fusion_valid_rate', async () => {
    for (const rate of [0, -1, 0.0001, 0.00005, 6.6667, 1.23456, 9, 10_000, 10_000.0001]) {
      const row = await db.one<{ ok: boolean }>(`select public.fusion_valid_rate($1::numeric) ok`, [rate])
      expect(isValidRate(rate), String(rate)).toBe(row.ok)
    }
  })
})
