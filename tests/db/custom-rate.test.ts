/**
 * Per-minute rates and the custom rate per minute at checkout: the re-priced
 * table charge, the discount after it, and the same figure everywhere the
 * money goes — invoice, receipt, shift ledger, counter close, history and
 * customer statistics.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

type Receipt = {
  sale_id: string
  base_amount: number
  products_subtotal: number
  discount: number
  final_amount: number
  session: { billable_seconds: number; rate_per_minute: number; standard_rate_per_minute: number | null; standard_base_amount: number | null }
}
type Shift = { status: string; cash: number; bank: number; snack: number; discounts: number; total: number; net: number; invoices: number; voided_amount: number }

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let cashier: TestUser
let plain: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db) // Snooker: PKR 10/min
  admin = await db.createUser('admin')
  cashier = await db.createUser('staff', {
    username: 'cashier',
    floorId: club.floors.ground,
    permissions: ['apply_discount', 'view_own_sales', 'delete_sales', 'counter_sale']
  })
  plain = await db.createUser('staff', { username: 'plain', floorId: club.floors.ground, permissions: ['counter_sale'] })
  await db.openCounter(cashier.id)
})
afterEach(async () => db.close())

/** Plays Snooker 1 for `minutes` (optionally booked / with colas) and ends it. */
async function played(user: string, minutes: number, opts: { booking?: Record<string, unknown>; cola?: number } = {}) {
  const s = await db.rpc<{ id: string }>(user, 'start_session', { p_table_id: club.tables.snooker1, ...opts.booking })
  if (opts.cola) await db.rpc(user, 'add_session_item', { p_session_id: s.id, p_product_id: club.products.cola, p_quantity: opts.cola })
  await db.ageSession(s.id, minutes * 60)
  await db.rpc(user, 'end_session', { p_session_id: s.id })
  return s.id
}

const checkout = (user: string, sessionId: string, args: Record<string, unknown> = {}) =>
  db.rpc<Receipt>(user, 'complete_checkout', { p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: sessionId, ...args })

describe('custom rate per minute at checkout', () => {
  it('100 min at 10/min (1,000) → custom 9/min (900) → PKR 30 discount = 870, the same everywhere', async () => {
    const sessionId = await played(cashier.id, 100)
    const [standard] = await db.sql<{ base_amount: string }>(`select base_amount from public.sessions where id = $1`, [sessionId])
    expect(Number(standard!.base_amount)).toBe(1000)

    const r = await checkout(cashier.id, sessionId, { p_custom_rate_per_minute: 9, p_discount: 30, p_customer_name: 'Regular', p_customer_phone: '0300-5556667' })
    expect(r).toMatchObject({ base_amount: 900, products_subtotal: 0, discount: 30, final_amount: 870 })
    expect(r.session).toMatchObject({ billable_seconds: 6000, rate_per_minute: 9, standard_rate_per_minute: 10, standard_base_amount: 1000 })

    // The invoice keeps the rate charged and the standard figures it replaced.
    const [sale] = await db.sql<Record<string, string>>(
      `select rate_per_minute::text, standard_rate_per_minute::text, standard_base_amount::text, base_amount::text,
              discount::text, final_amount::text from public.sales where id = $1`,
      [r.sale_id]
    )
    expect(sale).toEqual({
      rate_per_minute: '9.0000',
      standard_rate_per_minute: '10.0000',
      standard_base_amount: '1000.00',
      base_amount: '900.00',
      discount: '30.00',
      final_amount: '870.00'
    })
    // The session records the charge actually billed and the custom rate.
    const [s] = await db.sql<{ status: string; rate: string; custom: string; base: string }>(
      `select status, rate_per_minute::text rate, custom_rate_per_minute::text custom, base_amount::text base from public.sessions where id = $1`,
      [sessionId]
    )
    expect(s).toEqual({ status: 'completed', rate: '10.0000', custom: '9.0000', base: '900.00' })

    // Shift ledger: the amount paid (870) and the discount (30) — the rate change is not a second discount.
    const live = await db.rpc<{ shift: Shift }>(cashier.id, 'get_my_counter')
    expect(live.shift).toMatchObject({ cash: 870, bank: 0, total: 870, discounts: 30, net: 870, invoices: 1 })
    const [ledger] = await db.sql<{ cash: string; discounts: string; invoices: number }>(
      `select sum(cash_sales)::text cash, sum(discounts)::text discounts, sum(invoice_count)::int invoices from public.shift_daily_totals`
    )
    expect(ledger).toEqual({ cash: '870.00', discounts: '30.00', invoices: 1 })

    // Closing the counter verifies the shift against the ledger and the invoices.
    const closed = await db.rpc<Shift>(cashier.id, 'close_counter')
    expect(closed).toMatchObject({ status: 'closed', cash: 870, total: 870, discounts: 30, net: 870 })

    const d = (await db.one<{ d: string }>(`select public.get_current_business_date()::text d`)).d
    const history = await db.rpc<{ totals: { total: number; cash: number; discounts: number; invoices: number } }>(admin.id, 'get_history', {
      p_from: d,
      p_to: d
    })
    expect(history.totals).toMatchObject({ cash: 870, total: 870, discounts: 30, invoices: 1 })
    const [visit] = await db.sql<{ spent: string; play_seconds: string }>(`select spent::text, play_seconds::text from public.customer_visits`)
    expect(visit).toEqual({ spent: '870.00', play_seconds: '6000' })
  })

  it('keeps snacks at their price: (900 + 200) − 30 = 1,070, by bank transfer', async () => {
    const sessionId = await played(cashier.id, 100, { cola: 2 })
    const r = await checkout(cashier.id, sessionId, { p_custom_rate_per_minute: 9, p_discount: 30, p_payment_method: 'bank_transfer' })
    expect(r).toMatchObject({ base_amount: 900, products_subtotal: 200, discount: 30, final_amount: 1070 })
    const live = await db.rpc<{ shift: Shift }>(cashier.id, 'get_my_counter')
    expect(live.shift).toMatchObject({ cash: 0, bank: 1070, snack: 200, total: 1070, discounts: 30 })
    expect((await db.rpc<Shift>(cashier.id, 'close_counter')).total).toBe(1070)
  })

  it('a percentage-style discount is sent as its flat amount of the re-priced bill', async () => {
    // 10% of (900 + 100) = 100 — the app converts the percentage before sending it.
    const sessionId = await played(cashier.id, 100, { cola: 1 })
    const r = await checkout(cashier.id, sessionId, { p_custom_rate_per_minute: 9, p_discount: 100 })
    expect(r.final_amount).toBe(900)
  })

  it('re-prices booked time at the custom rate (60 booked + 5 over at 9/min = 585)', async () => {
    const sessionId = await played(cashier.id, 65, { booking: { p_booking: 'minutes', p_minutes: 60 } })
    const [s] = await db.sql<{ base_amount: string }>(`select base_amount from public.sessions where id = $1`, [sessionId])
    expect(Number(s!.base_amount)).toBe(650) // 600 booking + 5 min × 10
    const r = await checkout(cashier.id, sessionId, { p_custom_rate_per_minute: 9 })
    expect(r).toMatchObject({ base_amount: 585, final_amount: 585 })
  })

  it('without a custom rate the standard charge is used and nothing extra is stored', async () => {
    const r = await checkout(cashier.id, await played(cashier.id, 30))
    expect(r).toMatchObject({ base_amount: 300, final_amount: 300 })
    expect(r.session).toMatchObject({ rate_per_minute: 10, standard_rate_per_minute: null, standard_base_amount: null })
    // Entering the table's own rate changes nothing (and needs no permission).
    const same = await db.openCounter(plain.id).then(async () =>
      checkout(plain.id, await played(plain.id, 30), { p_custom_rate_per_minute: 10 })
    )
    expect(same).toMatchObject({ base_amount: 300, final_amount: 300 })
    expect(same.session.standard_rate_per_minute).toBeNull()
  })

  it('needs the discount permission, a valid rate and a table checkout', async () => {
    await db.openCounter(plain.id)
    const s = await played(plain.id, 10)
    expect((await rejects(checkout(plain.id, s, { p_custom_rate_per_minute: 9 }))).hint).toBe('forbidden')

    // The same unpaid table, now at a cashier who may set rates.
    for (const bad of [0, -5, 9.12345, 10_001]) {
      expect((await rejects(checkout(cashier.id, s, { p_custom_rate_per_minute: bad }))).hint, String(bad)).toBe('invalid_rate')
    }
    const counterSale = db.rpc(cashier.id, 'complete_checkout', {
      p_client_ref: randomUUID(),
      p_payment_method: 'cash',
      p_items: [{ product_id: club.products.tea, quantity: 1, unit_price: 70 }],
      p_custom_rate_per_minute: 5
    })
    expect((await rejects(counterSale)).hint).toBe('invalid_input')
    // Nothing was posted by the refused attempts.
    const live = await db.rpc<{ shift: Shift }>(cashier.id, 'get_my_counter')
    expect(live.shift).toMatchObject({ total: 0, invoices: 0 })
  })

  it('the discount limit applies to the re-priced bill', async () => {
    const s = await played(cashier.id, 100) // 1,000 standard
    const err = await rejects(checkout(cashier.id, s, { p_custom_rate_per_minute: 1, p_discount: 150 })) // bill is 100
    expect(err.hint).toBe('invalid_discount')
    expect((await checkout(cashier.id, s, { p_custom_rate_per_minute: 1, p_discount: 100 })).final_amount).toBe(0)
  })

  it('a retried checkout posts once; a void reverses exactly what was paid', async () => {
    const s = await played(cashier.id, 100)
    const ref = randomUUID()
    const first = await checkout(cashier.id, s, { p_client_ref: ref, p_custom_rate_per_minute: 9, p_discount: 30 })
    const again = await checkout(cashier.id, s, { p_client_ref: ref, p_custom_rate_per_minute: 9, p_discount: 30 })
    expect(again.sale_id).toBe(first.sale_id)
    expect((await db.rpc<{ shift: Shift }>(cashier.id, 'get_my_counter')).shift).toMatchObject({ cash: 870, invoices: 1 })

    await db.rpc(cashier.id, 'delete_sale', { p_sale_id: first.sale_id })
    const after = (await db.rpc<{ shift: Shift }>(cashier.id, 'get_my_counter')).shift
    expect(after).toMatchObject({ cash: 0, discounts: 0, total: 0, invoices: 0, voided_amount: 870 })
    expect((await db.rpc<Shift>(cashier.id, 'close_counter')).total).toBe(0)
  })

  it('administrators still cannot take the payment, custom rate or not', async () => {
    const s = await played(admin.id, 20)
    expect((await rejects(checkout(admin.id, s, { p_custom_rate_per_minute: 9 }))).hint).toBe('admin_no_sales')
  })
})

describe('per-minute rates in setup and sessions', () => {
  it('categories and tables take a rate per minute (up to 4 decimals)', async () => {
    const cat = await db.rpc<{ id: number; rate_per_minute: string }>(admin.id, 'admin_save_category', {
      p_id: null,
      p_name: 'Carrom',
      p_rate_per_minute: 6.6667
    })
    expect(Number(cat.rate_per_minute)).toBe(6.6667)
    for (const bad of [0, -1, 1.23456]) {
      expect((await rejects(db.rpc(admin.id, 'admin_save_category', { p_id: null, p_name: `X${bad}`, p_rate_per_minute: bad }))).hint).toBe(
        'invalid_input'
      )
    }
    const table = await db.rpc<{ rate_override: string }>(admin.id, 'admin_save_table', {
      p_id: club.tables.pool1,
      p_name: 'Pool 1',
      p_category_id: club.categories.pool,
      p_floor_id: club.floors.first,
      p_rate_per_minute: 8.5
    })
    expect(Number(table.rate_override)).toBe(8.5)
    // The hourly parameter no longer exists, so an outdated app cannot save an hourly figure.
    const old = await rejects(db.rpc(admin.id, 'admin_save_category', { p_id: null, p_name: 'Old', p_rate_per_hour: 600 }))
    expect(old.message).toMatch(/function .*admin_save_category.* does not exist/)
  })

  it('the tables overview reports rates per minute', async () => {
    const overview = await db.rpc<{ tables: { name: string; rate_per_minute: number; rate_per_hour?: number }[] }>(cashier.id, 'get_tables_overview')
    const snooker = overview.tables.find((t) => t.name === 'Snooker 1')!
    expect(snooker.rate_per_minute).toBe(10)
    expect(snooker.rate_per_hour).toBeUndefined()
  })

  it('fixed amounts buy time at the per-minute rate', async () => {
    const s = await db.rpc<{ booked_seconds: number }>(cashier.id, 'start_session', {
      p_table_id: club.tables.snooker1,
      p_booking: 'amount',
      p_amount: 250
    })
    expect(s.booked_seconds).toBe(1500) // 25 minutes at 10/min
  })
})
