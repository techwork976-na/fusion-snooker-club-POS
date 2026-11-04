/**
 * Fixed-time and fixed-amount bookings ended EARLY (migration 1500): only the
 * time played is charged — priced by the table's EXISTING pricing (rate per
 * minute, under-1-hour tiers, hourly + 30-minute slots — unchanged), never more
 * than the booking — while a booking used in full (time's up) keeps its booked
 * price, its hold and its Continue/extend behaviour. The charge set by
 * end_session is what the invoice, the counter ledger, History and Reports
 * record.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, seedClub, type TestUser } from './harness'

type Session = {
  id: string
  status: string
  booked_seconds: number | null
  booked_amount: string | null
  billable_seconds: number | null
  base_amount: string | null
}
type Money = Record<string, number>

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let ali: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db) // Snooker PKR 10/min, Pool PKR 7.5/min
  admin = await db.createUser('admin')
  ali = await db.createUser('staff', { floorId: null, permissions: ['counter_sale', 'apply_discount'] })
})
afterEach(async () => db.close())

const start = (table: string, booking: { p_booking: 'minutes'; p_minutes: number } | { p_booking: 'amount'; p_amount: number }) =>
  db.rpc<Session>(ali.id, 'start_session', { p_table_id: table, p_minutes: null, p_amount: null, ...booking })
const end = (s: Session) => db.rpc<Session>(ali.id, 'end_session', { p_session_id: s.id })
const charge = async (s: Session, playedSeconds: number) => {
  await db.ageSession(s.id, playedSeconds)
  return end(s)
}
const pause = (s: Session) => db.rpc(ali.id, 'pause_session', { p_session_id: s.id })
const resume = (s: Session) => db.rpc(ali.id, 'resume_session', { p_session_id: s.id })
/** Pauses for `seconds` (moves the start and the pause back together, as the clock would). */
const sitOut = (s: Session, seconds: number) =>
  db.sql(
    `update public.sessions set started_at = started_at - make_interval(secs => $2), paused_at = paused_at - make_interval(secs => $2) where id = $1`,
    [s.id, seconds]
  )
const clear = (s: Session) => db.sql(`update public.sessions set status = 'cancelled' where id = $1`, [s.id])
const category = (args: Record<string, unknown>) =>
  db.rpc<{ id: number }>(admin.id, 'admin_save_category', { p_id: null, p_rate_per_minute: null, p_sort_order: 5, p_is_active: true, ...args })
const tableIn = async (name: string, categoryId: number) =>
  (await db.one<{ id: string }>(`insert into public.club_tables (name, category_id, floor_id) values ($1, $2, $3) returning id`, [name, categoryId, club.floors.ground])).id

describe('per-minute tables (Snooker PKR 10/min)', () => {
  it('fixed time ended early charges the minutes played', async () => {
    const s = await start(club.tables.snooker1, { p_booking: 'minutes', p_minutes: 60 })
    expect(Number(s.booked_amount)).toBe(600)
    const ended = await charge(s, 15 * 60)
    expect([ended.billable_seconds, Number(ended.base_amount)]).toEqual([900, 150])
  })

  it('fixed amount ended after 10 seconds charges one started minute, not PKR 1,000', async () => {
    const s = await start(club.tables.snooker1, { p_booking: 'amount', p_amount: 1000 })
    expect(s.booked_seconds).toBe(6000)
    expect(Number((await charge(s, 10)).base_amount)).toBe(10)
  })

  it('ending immediately after starting charges nothing', async () => {
    const s = await start(club.tables.snooker1, { p_booking: 'amount', p_amount: 1000 })
    const ended = await end(s)
    expect([ended.billable_seconds, Number(ended.base_amount)]).toEqual([0, 0])
  })

  it('bills by elapsed time at every point of the booking', async () => {
    for (const [played, expected] of [
      [59, 10], // a started minute
      [60, 10],
      [61, 20],
      [20 * 60, 200],
      [45 * 60 + 1, 460],
      [59 * 60, 590],
      [59 * 60 + 30, 600], // rounds up to 60 minutes = the booking's own price
      [60 * 60, 600] // used in full
    ] as const) {
      const s = await start(club.tables.snooker1, { p_booking: 'minutes', p_minutes: 60 })
      expect(Number((await charge(s, played)).base_amount), `${played} s`).toBe(expected)
      await clear(s)
    }
  })

  it('paused time is never billed when a booking ends early', async () => {
    const s = await start(club.tables.snooker1, { p_booking: 'minutes', p_minutes: 60 })
    await db.ageSession(s.id, 10 * 60)
    await pause(s)
    await sitOut(s, 25 * 60)
    await resume(s)
    await db.ageSession(s.id, 5 * 60)
    const ended = await end(s)
    expect([ended.billable_seconds, Number(ended.base_amount)]).toEqual([15 * 60, 150])
  })

  it('ending while paused bills the time played before the pause', async () => {
    const s = await start(club.tables.snooker1, { p_booking: 'amount', p_amount: 500 })
    await db.ageSession(s.id, 7 * 60)
    await pause(s)
    await sitOut(s, 40 * 60)
    const ended = await end(s)
    expect([ended.billable_seconds, Number(ended.base_amount)]).toEqual([7 * 60, 70])
  })

  it('never charges more than the booking, even when minutes round up past it', async () => {
    // Pool PKR 7.5/min: PKR 1,000 buys 8,000 s (133:20); 7,990 s rounds up to 134 minutes = PKR 1,005.
    const s = await start(club.tables.pool1, { p_booking: 'amount', p_amount: 1000 })
    expect(s.booked_seconds).toBe(8000)
    expect(Number((await charge(s, 7990)).base_amount)).toBe(1000)
  })

  it('uses the billing policy (blocks, rounding, minimum) exactly as open play does', async () => {
    await db.sql(`update public.settings set billing_increment_minutes = 15, billing_rounding = 'up', minimum_charge_minutes = 30`)
    const s = await start(club.tables.snooker1, { p_booking: 'minutes', p_minutes: 90 })
    // 10 minutes → one 15-minute block → raised to the 30-minute minimum → PKR 300.
    expect(Number((await charge(s, 10 * 60)).base_amount)).toBe(300)
    await clear(s)
    const t = await start(club.tables.snooker1, { p_booking: 'minutes', p_minutes: 90 })
    expect(Number((await charge(t, 46 * 60)).base_amount)).toBe(600) // 4 blocks = 60 minutes
  })

  it("a booking used in full keeps its price: time's up holds, Continue bills only the extra time", async () => {
    const held = await start(club.tables.snooker1, { p_booking: 'minutes', p_minutes: 30 })
    const heldEnd = await charge(held, 75 * 60) // nobody reacted for 45 minutes
    expect([heldEnd.billable_seconds, Number(heldEnd.base_amount)]).toEqual([1800, 300])
    await clear(held)

    const continued = await start(club.tables.snooker1, { p_booking: 'minutes', p_minutes: 30 })
    await db.ageSession(continued.id, 31 * 60)
    await db.rpc(ali.id, 'continue_after_allocation', { p_session_id: continued.id })
    await db.ageSession(continued.id, 4 * 60 + 5)
    expect(Number((await end(continued)).base_amount)).toBe(350) // 300 + 5 started minutes
  })
})

describe('under-1-hour tables (PKR 600/hour, PKR 800/hour under an hour)', () => {
  let table: string
  beforeEach(async () => {
    const c = await category({ p_name: 'PS5', p_pricing_mode: 'tiered_hourly', p_hourly_rate: 600, p_under_hour_rate: 800 })
    table = await tableIn('PS5 A', c.id)
  })

  it("ended early: the time played at the table's existing prices — the owner's price list", async () => {
    // A 2-hour booking (PKR 1,200) ended at each length: exactly what open play of that length costs.
    for (const [minutes, price] of [[30, 400], [45, 600], [60, 600], [75, 750], [90, 900], [105, 1050]] as const) {
      const booked = await start(table, { p_booking: 'minutes', p_minutes: 120 })
      expect(Number(booked.booked_amount)).toBe(1200)
      expect(Number((await charge(booked, minutes * 60)).base_amount), `${minutes} of 120 min`).toBe(price)
      await clear(booked)
    }
  })

  it('ended early: never more than the booking', async () => {
    const hour = await start(table, { p_booking: 'minutes', p_minutes: 60 })
    expect(Number(hour.booked_amount)).toBe(600)
    expect(Number((await charge(hour, 15 * 60)).base_amount)).toBe(200) // 15 × 800/60
    await clear(hour)
    const capped = await start(table, { p_booking: 'minutes', p_minutes: 60 })
    expect(Number((await charge(capped, 50 * 60)).base_amount)).toBe(600) // 50 min costs 667 at the under-1-hour rate; the booking was 600
    await clear(capped)
    const amount = await start(table, { p_booking: 'amount', p_amount: 400 }) // 30 minutes at PKR 800/hour
    expect(amount.booked_seconds).toBe(1800)
    expect(Number((await charge(amount, 10 * 60)).base_amount)).toBe(133)
  })

  it('used in full: the booked price, as before (2 h 20 min = PKR 1,400)', async () => {
    const s = await start(table, { p_booking: 'minutes', p_minutes: 90 })
    expect(Number((await charge(s, 100 * 60)).base_amount)).toBe(900)
    await clear(s)
    const long = await start(table, { p_booking: 'minutes', p_minutes: 140 })
    expect(Number(long.booked_amount)).toBe(1400)
    expect(Number((await charge(long, 140 * 60)).base_amount)).toBe(1400)
  })
})

describe('hourly + 30-minute tables (PS5 PKR 600/hour, 30 minutes PKR 400)', () => {
  let table: string
  beforeEach(async () => {
    const c = await category({ p_name: 'PS5', p_pricing_mode: 'hourly_special30', p_hourly_rate: 600, p_special_30_rate: 400 })
    table = await tableIn('PS5 B', c.id)
  })
  const book = (minutes: number) => start(table, { p_booking: 'minutes', p_minutes: minutes })

  it('ended early: the minutes played at the existing slot prices (exactly 30 minutes = the 30-minute price, otherwise hourly)', async () => {
    for (const [booked, played, expected] of [
      [60, 15 * 60, 150],
      [60, 29 * 60, 290],
      [60, 30 * 60, 400], // exactly the 30-minute price
      [60, 35 * 60, 350],
      [60, 45 * 60, 450],
      [30, 10 * 60, 100],
      [90, 70 * 60, 700]
    ] as const) {
      const s = await book(booked)
      expect(Number((await charge(s, played)).base_amount), `${played / 60} of ${booked} min`).toBe(expected)
      await clear(s)
    }
  })

  it('an extended booking ended early pays the time played; used in full it pays the extended price', async () => {
    let s = await book(60)
    await db.ageSession(s.id, 60 * 60) // time's up
    s = await db.rpc<Session>(ali.id, 'extend_session', { p_session_id: s.id, p_minutes: 30, p_from_booked_seconds: 3600 })
    expect(Number(s.booked_amount)).toBe(900)
    await db.ageSession(s.id, 10 * 60)
    expect(Number((await end(s)).base_amount)).toBe(700) // 70 minutes at the hourly rate
    await clear(s)

    const full = await book(60)
    expect(Number((await charge(full, 80 * 60)).base_amount)).toBe(600) // held at the booking
  })
})

describe("the owner's case: a fixed booking stopped after 10–15 seconds", () => {
  it('charges the standard price of the time played on every kind of table, never the booked amount', async () => {
    const tiered = await category({ p_name: 'PS5', p_pricing_mode: 'tiered_hourly', p_hourly_rate: 600, p_under_hour_rate: 800 })
    const ps5 = await tableIn('PS5 C', tiered.id)
    for (const [table, booking, seconds, expected] of [
      // Snooker PKR 10/min: one started minute.
      [club.tables.snooker1, { p_booking: 'amount', p_amount: 1000 }, 10, 10],
      [club.tables.snooker1, { p_booking: 'minutes', p_minutes: 60 }, 15, 10],
      // Under-1-hour table (PKR 800/hour under an hour): one started minute = 800/60 → 13.
      [ps5, { p_booking: 'amount', p_amount: 1000 }, 10, 13],
      [ps5, { p_booking: 'minutes', p_minutes: 60 }, 15, 13]
    ] as const) {
      const s = await start(table, booking)
      const ended = await charge(s, seconds)
      expect([ended.billable_seconds, Number(ended.base_amount)], JSON.stringify(booking)).toEqual([seconds, expected])
      expect(Number(ended.base_amount)).toBeLessThan(Number(s.booked_amount))
      await clear(s)
    }
  })
})

describe('invoices and accounting follow the early charge', () => {
  it('checkout, the counter ledger, History and Reports all record the charge for the time played', async () => {
    const d = (await db.one<{ d: string }>(`select public.get_current_business_date()::text d`)).d
    await db.openCounter(ali.id)
    const s = await start(club.tables.snooker1, { p_booking: 'amount', p_amount: 1000 })
    await db.rpc(ali.id, 'add_session_item', { p_session_id: s.id, p_product_id: club.products.cola, p_quantity: 1 })
    await db.ageSession(s.id, 15 * 60)
    expect(Number((await end(s)).base_amount)).toBe(150)
    const sale = await db.rpc<{ final_amount: number }>(ali.id, 'complete_checkout', {
      p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: s.id, p_items: null, p_discount: 0
    })
    expect(Number(sale.final_amount)).toBe(250) // 150 table + 100 cola
    const invoice = await db.one<{ base_amount: string; final_amount: string }>(`select base_amount::text, final_amount::text from public.sales`)
    expect(invoice).toEqual({ base_amount: '150.00', final_amount: '250.00' })
    const shift = await db.one<{ cash: string }>(`select cash_sales::text cash from public.counter_shifts where user_id = $1`, [ali.id])
    expect(Number(shift.cash)).toBe(250)

    await db.rpc(ali.id, 'close_counter')
    const report = await db.rpc<{ final: Money }>(admin.id, 'get_financial_report', { p_from: d, p_to: d })
    const history = await db.rpc<{ totals: Money }>(admin.id, 'get_history', { p_from: d, p_to: d })
    expect(report.final).toMatchObject({ total: 250, cash: 250, invoices: 1 })
    expect(history.totals.total).toBe(250)
  })

  it('a custom checkout rate re-prices only the time played', async () => {
    await db.openCounter(ali.id)
    const s = await start(club.tables.snooker1, { p_booking: 'minutes', p_minutes: 60 })
    await db.ageSession(s.id, 20 * 60)
    expect(Number((await end(s)).base_amount)).toBe(200)
    await db.rpc(ali.id, 'complete_checkout', {
      p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: s.id, p_items: null, p_discount: 0, p_custom_rate_per_minute: 9
    })
    const invoice = await db.one<{ base_amount: string; standard_base_amount: string }>(
      `select base_amount::text, standard_base_amount::text from public.sales`
    )
    expect(invoice).toEqual({ base_amount: '180.00', standard_base_amount: '200.00' })
  })

  it('sessions ended before this rule keep the charge they were ended with', async () => {
    // A session ended (and stored) under the old rule is never re-priced: checkout uses the stored charge.
    await db.openCounter(ali.id)
    const s = await start(club.tables.snooker1, { p_booking: 'minutes', p_minutes: 60 })
    await db.ageSession(s.id, 15 * 60)
    await end(s)
    await db.sql(`update public.sessions set base_amount = 600 where id = $1`, [s.id]) // as the old rule stored it
    const sale = await db.rpc<{ final_amount: number }>(ali.id, 'complete_checkout', {
      p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: s.id, p_items: null, p_discount: 0
    })
    expect(Number(sale.final_amount)).toBe(600)
  })
})
