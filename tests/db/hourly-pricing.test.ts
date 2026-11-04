/**
 * "Hourly + special 30-minute rate" categories (migration 1100), with the
 * owner's examples: PS5 PKR 600/hour, 30 min PKR 400; table tennis PKR
 * 400/hour, 30 min PKR 250. Per-minute categories stay as they were.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { slotPrice } from '@shared/billing'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

type Session = {
  id: string
  status: string
  pricing_mode: string
  hourly_rate: string | null
  special_30_rate: string | null
  rate_per_minute: string
  booked_seconds: number | null
  booked_amount: string | null
  paused_ms: number
  billable_seconds: number | null
  base_amount: string | null
  allocation_alert_ack_at: string | null
}
type Category = { id: number; pricing_mode: string; hourly_rate: string | null; special_30_rate: string | null; rate_per_minute: string }

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let staff: TestUser
let ps5: Category
let tt: Category
let ps5Table: string
let ttTable: string

const saveCategory = (args: Record<string, unknown>, user = admin.id) =>
  db.rpc<Category>(user, 'admin_save_category', { p_id: null, p_rate_per_minute: null, p_sort_order: 0, p_is_active: true, ...args })

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  staff = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['counter_sale', 'apply_discount'] })
  ps5 = await saveCategory({ p_name: 'PS5', p_pricing_mode: 'hourly_special30', p_hourly_rate: 600, p_special_30_rate: 400 })
  tt = await saveCategory({ p_name: 'Table Tennis', p_pricing_mode: 'hourly_special30', p_hourly_rate: 400, p_special_30_rate: 250 })
  const table = async (name: string, category: number) =>
    (await db.one<{ id: string }>(
      `insert into public.club_tables (name, category_id, floor_id) values ($1, $2, $3) returning id`,
      [name, category, club.floors.ground]
    )).id
  ps5Table = await table('PS5 1', ps5.id)
  ttTable = await table('TT 1', tt.id)
})
afterEach(async () => db.close())

const book = (table: string, minutes: number) =>
  db.rpc<Session>(staff.id, 'start_session', { p_table_id: table, p_booking: 'minutes', p_minutes: minutes })
const extend = (s: Session, minutes: number) =>
  db.rpc<Session>(staff.id, 'extend_session', { p_session_id: s.id, p_minutes: minutes, p_from_booked_seconds: s.booked_seconds })
const end = (id: string) => db.rpc<Session>(staff.id, 'end_session', { p_session_id: id })
/** Frees the table for the next case (as if paid). */
const clear = (id: string) =>
  db.sql(`update public.sessions set status = 'completed', ended_at = now(), billable_seconds = 0, base_amount = 0 where id = $1`, [id])

describe('prices', () => {
  it('PS5: 30 min PKR 400, 1 h 600, 1.5 h 900, 2 h 1,200, 2.5 h 1,500, 3 h 1,800', async () => {
    const prices: number[] = []
    for (const minutes of [30, 60, 90, 120, 150, 180]) {
      const s = await book(ps5Table, minutes)
      expect(s).toMatchObject({ pricing_mode: 'hourly_special30', booked_seconds: minutes * 60 })
      prices.push(Number(s.booked_amount))
      await clear(s.id)
    }
    expect(prices).toEqual([400, 600, 900, 1200, 1500, 1800])
  })

  it('Table tennis: 30 min PKR 250, 1 h 400, 1.5 h 600, 2 h 800, 2.5 h 1,000, 3 h 1,200', async () => {
    const prices: number[] = []
    for (const minutes of [30, 60, 90, 120, 150, 180]) {
      const s = await book(ttTable, minutes)
      prices.push(Number(s.booked_amount))
      await clear(s.id)
    }
    expect(prices).toEqual([250, 400, 600, 800, 1000, 1200])
  })

  it('the app and the database price every duration identically', async () => {
    for (let i = 0; i < 200; i++) {
      const hourly = Math.round((50 + ((i * 37) % 2000)) * 100 + (i % 3) * 25) / 100
      const special = Math.round((20 + ((i * 53) % 900)) * 100 + (i % 7)) / 100
      const minutes = 30 * (1 + ((i * 7) % 48))
      const { price } = await db.one<{ price: string }>(`select public.fusion_slot_price($1, $2, $3)::text price`, [minutes, hourly, special])
      expect(Number(price), `${minutes} min at ${hourly}/h, 30 min ${special}`).toBe(slotPrice(minutes, hourly, special))
    }
  })
})

describe('a session', () => {
  it('bills its booked price when used in full; ended early (1500) it bills only the time played', async () => {
    // 20 of 60 minutes: the existing slot price of 20 minutes (the hourly rate pro rata).
    const early = await book(ps5Table, 60)
    await db.ageSession(early.id, 20 * 60)
    expect(Number((await end(early.id)).base_amount)).toBe(200)
    await clear(early.id)

    // 20 min of play, a 30-minute pause, 10 more minutes: 30 minutes used, 30 left — the pause is never billed.
    const paused = await book(ps5Table, 60)
    await db.ageSession(paused.id, 20 * 60)
    await db.rpc(staff.id, 'pause_session', { p_session_id: paused.id })
    await db.ageSession(paused.id, 30 * 60)
    await db.rpc(staff.id, 'resume_session', { p_session_id: paused.id })
    await db.ageSession(paused.id, 10 * 60)
    const pausedEnd = await end(paused.id)
    expect([pausedEnd.billable_seconds, Number(pausedEnd.base_amount)]).toEqual([30 * 60, 400])
    await clear(paused.id)

    // Time's up and nobody reacts for half an hour: held at the booking.
    const held = await book(ps5Table, 90)
    await db.ageSession(held.id, 120 * 60)
    const heldEnd = await end(held.id)
    expect([heldEnd.billable_seconds, Number(heldEnd.base_amount)]).toEqual([90 * 60, 900])
  })

  it('extending re-prices the total time: 1 h + 30 min = 1.5 h = PKR 900, not 600 + 400', async () => {
    let s = await book(ps5Table, 60)
    expect(Number(s.booked_amount)).toBe(600)
    s = await extend(s, 30)
    expect([s.booked_seconds, Number(s.booked_amount)]).toEqual([90 * 60, 900])
    s = await extend(s, 30)
    expect([s.booked_seconds, Number(s.booked_amount)]).toEqual([120 * 60, 1200])

    let t = await book(ttTable, 30)
    expect(Number(t.booked_amount)).toBe(250)
    t = await extend(t, 30)
    expect([t.booked_seconds, Number(t.booked_amount)]).toEqual([60 * 60, 400]) // not 250 + 250
    t = await extend(t, 60) // 2 hours
    expect(Number(t.booked_amount)).toBe(800)
  })

  it('a repeated click or a second terminal never extends twice; steps are 30 minutes', async () => {
    const s = await book(ps5Table, 60)
    const once = await extend(s, 30)
    expect((await rejects(extend(s, 30))).hint).toBe('stale') // the same request again
    expect(Number((await db.one<{ amount: string }>(`select booked_amount amount from public.sessions where id = $1`, [s.id])).amount)).toBe(900)
    expect((await rejects(extend(once, 45))).hint).toBe('invalid_input')
    expect((await rejects(extend(once, 0))).hint).toBe('invalid_input')
    expect((await rejects(extend(once, 1380))).hint).toBe('invalid_input') // over 24 hours in total
  })

  it("extending after time's up does not use up the held minutes and re-arms the alarm", async () => {
    const s = await book(ps5Table, 60)
    await db.ageSession(s.id, 70 * 60) // held for 10 minutes
    const acked = await db.rpc<Session>(staff.id, 'acknowledge_allocation_alert', { p_session_id: s.id })
    expect(acked.allocation_alert_ack_at).not.toBeNull()
    const extended = await extend(acked, 30)
    expect(extended.allocation_alert_ack_at).toBeNull()
    expect(Number(extended.paused_ms)).toBeGreaterThanOrEqual(10 * 60 * 1000)
    expect(Number(extended.paused_ms)).toBeLessThan(10 * 60 * 1000 + 1000)
    // 30 more minutes of play are available: after 25 the booking is not used up yet…
    await db.ageSession(s.id, 25 * 60)
    const midway = await db.one<{ used: number }>(
      `select public.fusion_billable_seconds(s, now()) used from public.sessions s where s.id = $1`, [s.id])
    expect(midway.used).toBeLessThan(90 * 60)
    // …and the bill is 1.5 hours.
    await db.ageSession(s.id, 10 * 60)
    const ended = await end(s.id)
    expect([ended.billable_seconds, Number(ended.base_amount)]).toEqual([90 * 60, 900])
  })
})

describe('checkout and history', () => {
  it('the invoice carries the booked price, tab snacks and discount; per-minute custom rates are refused', async () => {
    await db.openCounter(staff.id)
    const s = await book(ps5Table, 90)
    await db.rpc(staff.id, 'add_session_item', { p_session_id: s.id, p_product_id: club.products.cola })
    await db.ageSession(s.id, 90 * 60) // played in full (ended early it would charge the time played — see early-end-billing)
    await end(s.id)
    const pay = (args: Record<string, unknown>) =>
      db.rpc<{ base_amount: number; products_subtotal: number; final_amount: number; session: Record<string, unknown> }>(
        staff.id, 'complete_checkout', { p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: s.id, ...args })
    expect((await rejects(pay({ p_custom_rate_per_minute: 5 }))).hint).toBe('invalid_rate')
    const receipt = await pay({ p_discount: 50 })
    expect(receipt).toMatchObject({ base_amount: 900, products_subtotal: 100, final_amount: 950 })
    expect(receipt.session).toMatchObject({ pricing_mode: 'hourly_special30', hourly_rate: 600, special_30_rate: 400, booked_seconds: 5400 })
    const ledger = await db.one<{ cash: string }>(`select cash_sales::text cash from public.counter_shifts where user_id = $1`, [staff.id])
    expect(ledger.cash).toBe('950.00')
  })

  it('changing the prices later never changes a running session, its extension or a past invoice', async () => {
    await db.openCounter(staff.id)
    const running = await book(ps5Table, 60)
    await saveCategory({ p_id: ps5.id, p_name: 'PS5', p_pricing_mode: 'hourly_special30', p_hourly_rate: 800, p_special_30_rate: 500 })
    const extended = await extend(running, 30)
    expect(Number(extended.booked_amount)).toBe(900) // 1.5 h at the price it started with
    await db.ageSession(running.id, 90 * 60) // the 1.5 hours are played in full
    await end(running.id)
    const paid = await db.rpc<{ sale_id: string; base_amount: number }>(staff.id, 'complete_checkout', {
      p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: running.id
    })
    expect(paid.base_amount).toBe(900)

    const next = await book(ps5Table, 60)
    expect(Number(next.booked_amount)).toBe(800) // new sessions use the new price
    await saveCategory({ p_id: ps5.id, p_name: 'PS5', p_pricing_mode: 'hourly_special30', p_hourly_rate: 1000, p_special_30_rate: 700 })
    const receipt = await db.rpc<{ base_amount: number; session: Record<string, unknown> }>(staff.id, 'get_receipt', { p_sale_id: paid.sale_id })
    expect(receipt).toMatchObject({ base_amount: 900, session: { hourly_rate: 600, special_30_rate: 400 } })
  })
})

describe('rules of the mode', () => {
  it('needs a duration in 30-minute steps; no open play, prepaid amount, per-minute continue or extension of per-minute tables', async () => {
    expect((await rejects(db.rpc(staff.id, 'start_session', { p_table_id: ps5Table }))).hint).toBe('duration_required')
    expect((await rejects(db.rpc(staff.id, 'start_session', { p_table_id: ps5Table, p_booking: 'amount', p_amount: 500 }))).hint).toBe('duration_required')
    expect((await rejects(book(ps5Table, 45))).hint).toBe('invalid_input')

    const s = await book(ps5Table, 30)
    await db.ageSession(s.id, 31 * 60)
    expect((await rejects(db.rpc(staff.id, 'continue_after_allocation', { p_session_id: s.id }))).hint).toBe('use_extend')

    // Per-minute categories are unchanged: a 30-minute snooker booking is 30 × PKR 10, and it continues per minute.
    const snooker = await db.rpc<Session>(staff.id, 'start_session', { p_table_id: club.tables.snooker1, p_booking: 'minutes', p_minutes: 30 })
    expect([snooker.pricing_mode, Number(snooker.booked_amount)]).toEqual(['per_minute', 300])
    expect((await rejects(extend(snooker, 30))).hint).toBe('invalid_state')
    await db.ageSession(snooker.id, 30 * 60)
    await db.rpc(staff.id, 'continue_after_allocation', { p_session_id: snooker.id })
    await db.ageSession(snooker.id, 5 * 60)
    expect(Number((await end(snooker.id)).base_amount)).toBe(350)
  })

  it('a pre-booking on an hourly table starts with a chosen duration', async () => {
    const booking = async () =>
      (await db.one<{ id: string }>(
        `insert into public.bookings (customer_name, table_id, booking_at, created_by) values ('Walk-in', $1, now(), $2) returning id`,
        [ps5Table, admin.id]
      )).id
    const b = await booking()
    expect((await rejects(db.rpc(admin.id, 'start_booking', { p_booking_id: b, p_table_id: ps5Table }))).hint).toBe('duration_required')
    const started = await db.rpc<{ session: Session }>(admin.id, 'start_booking', { p_booking_id: b, p_table_id: ps5Table, p_minutes: 90 })
    expect([started.session.booked_seconds, Number(started.session.booked_amount)]).toEqual([5400, 900])
  })

  it('only administrators set prices, and each mode needs its own prices', async () => {
    expect((await rejects(saveCategory({ p_name: 'Console', p_pricing_mode: 'hourly_special30', p_hourly_rate: 500, p_special_30_rate: 300 }, staff.id))).hint).toBe('forbidden')
    expect((await rejects(saveCategory({ p_name: 'Console', p_pricing_mode: 'hourly_special30', p_hourly_rate: 500 }))).hint).toBe('invalid_input')
    expect((await rejects(saveCategory({ p_name: 'Console', p_pricing_mode: 'hourly_special30', p_hourly_rate: 0, p_special_30_rate: 300 }))).hint).toBe('invalid_input')
    expect((await rejects(saveCategory({ p_name: 'Console', p_pricing_mode: 'per_minute' }))).hint).toBe('invalid_input')
    // Back to per minute: the hourly prices are cleared.
    const back = await saveCategory({ p_id: tt.id, p_name: 'Table Tennis', p_pricing_mode: 'per_minute', p_rate_per_minute: 7 })
    expect(back).toMatchObject({ pricing_mode: 'per_minute', hourly_rate: null, special_30_rate: null })
    expect(Number(back.rate_per_minute)).toBe(7)
    const hourly = await db.one<Category>(`select * from public.table_categories where id = $1`, [ps5.id])
    expect(hourly).toMatchObject({ pricing_mode: 'hourly_special30', hourly_rate: '600.00', special_30_rate: '400.00' })
  })
})
