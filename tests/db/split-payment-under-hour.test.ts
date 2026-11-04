/**
 * Migration 1300: split payments (part cash, part bank transfer on one bill)
 * and the "Hourly + under-1-hour rate" pricing mode, with the owner's PS5
 * example: PKR 800/hour under 1 hour, PKR 600/hour from 1 hour.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let ali: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  ali = await db.createUser('staff', { floorId: null, permissions: ['counter_sale', 'apply_discount', 'delete_sales'] })
})
afterEach(async () => db.close())

const today = async () => (await db.one<{ d: string }>(`select public.get_current_business_date()::text as d`)).d
const checkout = (args: Record<string, unknown>, user = ali.id) =>
  db.rpc<{ sale_id: string; final_amount: number; payment_method: string; split_cash_amount: number | null }>(user, 'complete_checkout', {
    p_client_ref: randomUUID(),
    ...args
  })
const colas = (n: number) => [{ product_id: club.products.cola, quantity: n, unit_price: 100 }]
/** Cash and bank on the counter's ledger (counter_shifts and shift_daily_totals must agree). */
const ledger = async () => {
  const shift = await db.one<{ cash: string; bank: string }>(`select cash_sales::text cash, bank_sales::text bank from public.counter_shifts where user_id = $1`, [ali.id])
  const daily = await db.one<{ cash: string; bank: string }>(
    `select sum(cash_sales)::text cash, sum(bank_sales)::text bank from public.shift_daily_totals where user_id = $1`,
    [ali.id]
  )
  expect(daily).toEqual(shift)
  return shift
}

describe('split payment', () => {
  it('records the cash part, posts each part to the counter, and every report splits it', async () => {
    await db.openCounter(ali.id)
    // Snacks without a table: PKR 300, PKR 120 in cash, the rest by bank transfer.
    const snack = await checkout({ p_payment_method: 'split', p_items: colas(3), p_split_cash: 120 })
    expect(snack).toMatchObject({ final_amount: 300, payment_method: 'split', split_cash_amount: 120 })
    // A table: 40 minutes at PKR 10/min = PKR 400, PKR 250 in cash.
    const s = await db.rpc<{ id: string }>(ali.id, 'start_session', { p_table_id: club.tables.snooker1 })
    await db.ageSession(s.id, 40 * 60)
    await db.rpc(ali.id, 'end_session', { p_session_id: s.id })
    await checkout({ p_payment_method: 'split', p_session_id: s.id, p_split_cash: 250 })
    // And an ordinary cash sale, unchanged.
    await checkout({ p_payment_method: 'cash', p_items: colas(1) })

    const [stored] = await db.sql<{ split_cash_amount: string; final_amount: string }>(
      `select split_cash_amount::text, final_amount::text from public.sales where id = $1`, [snack.sale_id]
    )
    expect(stored).toEqual({ split_cash_amount: '120.00', final_amount: '300.00' })
    expect(await ledger()).toEqual({ cash: '470.00', bank: '330.00' }) // 120 + 250 + 100 | 180 + 150

    const d = await today()
    const snacks = await db.rpc<{ totals: Record<string, number>; sales: { split_cash_amount: number | null; payment_method: string }[] }>(
      admin.id, 'get_snack_sales', { p_from: d, p_to: d }
    )
    expect(snacks.totals).toMatchObject({ total: 400, cash: 220, bank: 180 })
    expect(snacks.sales.find((x) => x.payment_method === 'split')?.split_cash_amount).toBe(120)
    const tables = await db.rpc<{ totals: Record<string, number> }>(admin.id, 'get_table_sales', { p_from: d, p_to: d })
    expect(tables.totals).toMatchObject({ total: 400, cash: 250, bank: 150 })

    const receipt = await db.rpc<{ payment_method: string; split_cash_amount: number }>(ali.id, 'get_receipt', { p_sale_id: snack.sale_id })
    expect(receipt).toMatchObject({ payment_method: 'split', split_cash_amount: 120 })
    const shiftId = (await db.one<{ id: string }>(`select id from public.counter_shifts where user_id = $1`, [ali.id])).id
    const detail = await db.rpc<{ invoice_list: { receipt_no: number; split_cash_amount: number | null }[] }>(admin.id, 'get_shift_detail', { p_shift_id: shiftId })
    expect(detail.invoice_list.map((i) => i.split_cash_amount).sort()).toEqual([120, 250, null].sort())

    // Closing reconciles the invoices with the ledger; Reports and Close day see the same split.
    await db.rpc(ali.id, 'close_counter', {})
    const report = await db.rpc<{ final: Record<string, number> }>(admin.id, 'get_financial_report', { p_from: d, p_to: d })
    expect(report.final).toMatchObject({ total: 800, cash: 470, bank: 330 })
    const [day] = await db.rpcRows<{ total_cash: string; total_bank: string }>(admin.id, 'list_open_business_dates')
    expect([Number(day!.total_cash), Number(day!.total_bank)]).toEqual([470, 330])
  })

  it('voiding a split sale takes back exactly its two parts', async () => {
    await db.openCounter(ali.id)
    const sale = await checkout({ p_payment_method: 'split', p_items: colas(2), p_split_cash: 50 })
    expect(await ledger()).toEqual({ cash: '50.00', bank: '150.00' })
    await db.rpc(ali.id, 'delete_sale', { p_sale_id: sale.sale_id })
    expect(await ledger()).toEqual({ cash: '0.00', bank: '0.00' })
  })

  it('needs a cash part above zero and below the total, and only for a split', async () => {
    await db.openCounter(ali.id)
    for (const cash of [null, 0, -10, 12.345, 200, 250]) {
      expect((await rejects(checkout({ p_payment_method: 'split', p_items: colas(2), p_split_cash: cash }))).hint, String(cash)).toBe('invalid_split')
    }
    expect((await rejects(checkout({ p_payment_method: 'cash', p_items: colas(2), p_split_cash: 50 }))).hint).toBe('invalid_split')
    // After a discount the cash part must still be below the new total.
    expect((await rejects(checkout({ p_payment_method: 'split', p_items: colas(2), p_discount: 60, p_split_cash: 140 }))).hint).toBe('invalid_split')
    expect(await checkout({ p_payment_method: 'split', p_items: colas(2), p_discount: 60, p_split_cash: 139.5 })).toMatchObject({ final_amount: 140 })
    // The table itself refuses an inconsistent row.
    expect((await rejects(db.sql(`update public.sales set split_cash_amount = final_amount where payment_method = 'split'`))).message).toMatch(/sales_split_cash/)
    await checkout({ p_payment_method: 'cash', p_items: colas(1) })
    expect((await rejects(db.sql(`update public.sales set split_cash_amount = 1 where payment_method = 'cash'`))).message).toMatch(/sales_split_cash/)
    expect((await rejects(checkout({ p_payment_method: 'cheque', p_items: colas(1) }))).hint).toBe('invalid_input')
  })
})

describe('Hourly + under-1-hour rate', () => {
  type Session = { id: string; rate_per_minute: string; booked_seconds: number | null; booked_amount: string | null; base_amount: string | null }
  let ps5: { id: number; rate_per_minute: string; pricing_mode: string; hourly_rate: string; under_hour_rate: string }
  let table: string

  beforeEach(async () => {
    ps5 = await db.rpc(admin.id, 'admin_save_category', {
      p_id: null, p_name: 'PS5', p_rate_per_minute: null, p_sort_order: 3, p_is_active: true,
      p_pricing_mode: 'tiered_hourly', p_hourly_rate: 600, p_under_hour_rate: 800
    })
    // A table's own per-minute rate does not apply to this pricing.
    table = (await db.one<{ id: string }>(
      `insert into public.club_tables (name, category_id, floor_id, rate_override) values ('PS5 A', $1, $2, 5) returning id`,
      [ps5.id, club.floors.ground]
    )).id
    await db.openCounter(ali.id)
  })

  const start = (args: Record<string, unknown> = {}) => db.rpc<Session>(ali.id, 'start_session', { p_table_id: table, ...args })
  /** Ends a session after `seconds` of play and returns its table charge; the table is free again afterwards. */
  async function charge(s: Session, seconds: number, opts: { continueAt?: number } = {}) {
    if (opts.continueAt !== undefined) {
      await db.ageSession(s.id, opts.continueAt)
      await db.rpc(ali.id, 'continue_after_allocation', { p_session_id: s.id })
      await db.ageSession(s.id, seconds - opts.continueAt)
    } else await db.ageSession(s.id, seconds)
    const ended = await db.rpc<Session>(ali.id, 'end_session', { p_session_id: s.id })
    await db.rpc(admin.id, 'cancel_session', { p_session_id: s.id })
    return Number(ended.base_amount)
  }

  it('saves the two rates; the under-1-hour rate must be the higher one', async () => {
    expect(ps5).toMatchObject({ pricing_mode: 'tiered_hourly', hourly_rate: '600.00', under_hour_rate: '800.00', rate_per_minute: '10.0000' })
    const save = (under: number | null, hourly = 600) =>
      db.rpc(admin.id, 'admin_save_category', { p_id: ps5.id, p_name: 'PS5', p_pricing_mode: 'tiered_hourly', p_hourly_rate: hourly, p_under_hour_rate: under })
    for (const under of [null, 600, 500, 800.555]) expect((await rejects(save(under))).hint, String(under)).toBe('invalid_input')
    expect((await rejects(db.rpc(ali.id, 'admin_save_category', { p_id: null, p_name: 'X', p_pricing_mode: 'tiered_hourly', p_hourly_rate: 600, p_under_hour_rate: 800 }))).hint).toBe('forbidden')
    // Switching back to per minute clears the hourly prices.
    const back = await db.rpc<{ hourly_rate: string | null; under_hour_rate: string | null }>(admin.id, 'admin_save_category', {
      p_id: ps5.id, p_name: 'PS5', p_rate_per_minute: 10, p_pricing_mode: 'per_minute'
    })
    expect(back).toMatchObject({ hourly_rate: null, under_hour_rate: null })
  })

  it('open play: under an hour at PKR 800/hour, from an hour at PKR 600/hour', async () => {
    const s = await start()
    expect(s.rate_per_minute).toBe('10.0000') // not the table's PKR 5/min override
    expect(await charge(s, 15 * 60)).toBe(200)
    expect(await charge(await start(), 45 * 60)).toBe(600)
    expect(await charge(await start(), 59 * 60)).toBe(787) // 59 × 800/60
    expect(await charge(await start(), 59 * 60 + 30)).toBe(600) // billed as 60 minutes
    expect(await charge(await start(), 60 * 60)).toBe(600)
    expect(await charge(await start(), 90 * 60)).toBe(900)
  })

  it('fixed time: priced by its length, held at the booking, re-priced when play continues', async () => {
    const thirty = await start({ p_booking: 'minutes', p_minutes: 30 })
    expect([thirty.booked_seconds, thirty.booked_amount]).toEqual([1800, '400.00'])
    expect(await charge(thirty, 50 * 60)).toBe(400) // held at the booked 30 minutes
    const ninety = await start({ p_booking: 'minutes', p_minutes: 90 })
    expect(ninety.booked_amount).toBe('900.00')
    expect(await charge(ninety, 20 * 60)).toBe(267) // ended early (1500): 20 minutes at the under-1-hour rate
    // (The minute held at "time's up" before staff continue is never billed.)
    // 30 minutes booked, continued to 70 billed minutes: all of it at the hourly rate.
    expect(await charge(await start({ p_booking: 'minutes', p_minutes: 30 }), 71 * 60, { continueAt: 31 * 60 })).toBe(700)
    // 50 minutes booked (PKR 667), continued to 55: still under an hour, at the under-1-hour rate.
    expect(await charge(await start({ p_booking: 'minutes', p_minutes: 50 }), 56 * 60, { continueAt: 51 * 60 })).toBe(733)
    // 55 minutes booked (PKR 733), continued to 60 (PKR 600 at the hourly rate): never less than the booking.
    expect(await charge(await start({ p_booking: 'minutes', p_minutes: 55 }), 61 * 60, { continueAt: 56 * 60 })).toBe(733)
  })

  it('fixed amount: buys time at the hourly rate once it covers an hour', async () => {
    const small = await start({ p_booking: 'amount', p_amount: 400 })
    expect([small.booked_seconds, small.booked_amount]).toEqual([1800, '400.00'])
    expect(await charge(small, 40 * 60)).toBe(400)
    const large = await start({ p_booking: 'amount', p_amount: 700 })
    expect(large.booked_seconds).toBe(4200) // 70 minutes at 600/hour
    await db.rpc(admin.id, 'cancel_session', { p_session_id: large.id })
    expect((await start({ p_booking: 'amount', p_amount: 590 })).booked_seconds).toBe(2655) // 44 min 15 s at 800/hour
  })

  it('a running session keeps its rates; the floor and receipt show them; no custom per-minute rate', async () => {
    const s = await start()
    await db.rpc(admin.id, 'admin_save_category', { p_id: ps5.id, p_name: 'PS5', p_pricing_mode: 'tiered_hourly', p_hourly_rate: 700, p_under_hour_rate: 900 })
    const overview = await db.rpc<{ tables: { id: string; under_hour_rate: number; session: { under_hour_rate: number; hourly_rate: number } | null }[] }>(
      ali.id, 'get_tables_overview'
    )
    const row = overview.tables.find((t) => t.id === table)!
    expect([row.under_hour_rate, row.session?.hourly_rate, row.session?.under_hour_rate]).toEqual([900, 600, 800])
    await db.ageSession(s.id, 20 * 60)
    await db.rpc(ali.id, 'end_session', { p_session_id: s.id })
    expect((await rejects(checkout({ p_payment_method: 'cash', p_session_id: s.id, p_custom_rate_per_minute: 5 }))).hint).toBe('invalid_rate')
    const sale = await checkout({ p_payment_method: 'cash', p_session_id: s.id })
    expect(sale.final_amount).toBe(267) // 20 × 800/60
    const receipt = await db.rpc<{ session: { pricing_mode: string; hourly_rate: number; under_hour_rate: number } }>(ali.id, 'get_receipt', { p_sale_id: sale.sale_id })
    expect(receipt.session).toMatchObject({ pricing_mode: 'tiered_hourly', hourly_rate: 600, under_hour_rate: 800 })
  })
})
