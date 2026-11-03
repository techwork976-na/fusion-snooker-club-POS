/**
 * Snack-only sales (the Snacks page reuses the counter checkout) and the
 * table-wise sales report, which reads invoices directly so the retention
 * policy removes old figures from it too (migration 1000).
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

type TableRow = { table_id: string; name: string; sessions: number; total: number; cash: number; bank: number; table_time: number; snacks: number; discounts: number }
type TableSales = { tables: TableRow[]; totals: Record<string, number>; retention_days: number }
type SnackSales = { scope: string; totals: Record<string, number>; sales: { receipt_no: number; final_amount: number; cashier_name: string; items: { name: string; quantity: number }[] }[] }

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let ali: TestUser
let sara: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  ali = await db.createUser('staff', { floorId: null, permissions: ['counter_sale', 'apply_discount'] })
  sara = await db.createUser('staff', { floorId: null, permissions: ['counter_sale'] })
})
afterEach(async () => db.close())

const today = async () => (await db.one<{ d: string }>(`select public.get_current_business_date()::text as d`)).d
const minus = async (d: string, n: number) => (await db.one<{ d: string }>(`select ($1::date - $2::int)::text d`, [d, n])).d
const stock = async (id: string) => (await db.one<{ n: number }>(`select stock_quantity n from public.inventory_products where id = $1`, [id])).n

const snackSale = (user: string, items: [string, number, number][], method = 'cash', ref = randomUUID()) =>
  db.rpc<{ sale_id: string; receipt_no: number }>(user, 'complete_checkout', {
    p_client_ref: ref,
    p_payment_method: method,
    p_items: items.map(([product_id, quantity, unit_price]) => ({ product_id, quantity, unit_price }))
  })

/** A paid table session: `minutes` of open play, optional cola on the tab, discount, payment method. */
async function tableSale(user: string, table: string, minutes: number, opts: { cola?: number; discount?: number; method?: string } = {}) {
  const s = await db.rpc<{ id: string }>(user, 'start_session', { p_table_id: table })
  if (opts.cola) await db.rpc(user, 'add_session_item', { p_session_id: s.id, p_product_id: club.products.cola, p_quantity: opts.cola })
  await db.ageSession(s.id, minutes * 60)
  await db.rpc(user, 'end_session', { p_session_id: s.id })
  return db.rpc<{ sale_id: string }>(user, 'complete_checkout', {
    p_client_ref: randomUUID(), p_payment_method: opts.method ?? 'cash', p_session_id: s.id, p_discount: opts.discount ?? 0
  })
}
const tableSales = (from: string, to: string, user = admin.id) => db.rpc<TableSales>(user, 'get_table_sales', { p_from: from, p_to: to })
const row = (r: TableSales, table: string) => r.tables.find((t) => t.table_id === table)!

describe('snack-only sales', () => {
  it('sell from stock without a table, once per checkout, and appear in product profit — never on a table', async () => {
    await db.openCounter(ali.id)
    const ref = randomUUID()
    const sale = await snackSale(ali.id, [[club.products.cola, 2, 100], [club.products.chips, 1, 50]], 'cash', ref)
    // A retried checkout (same reference) is the same sale: no second stock deduction.
    expect((await snackSale(ali.id, [[club.products.cola, 2, 100], [club.products.chips, 1, 50]], 'cash', ref)).sale_id).toBe(sale.sale_id)
    expect([await stock(club.products.cola), await stock(club.products.chips)]).toEqual([8, 2])
    const [stored] = await db.sql<{ session_id: string | null; table_name: string | null; final_amount: string }>(
      `select session_id, table_name, final_amount from public.sales where id = $1`, [sale.sale_id]
    )
    expect(stored).toEqual({ session_id: null, table_name: null, final_amount: '250.00' })
    // Stock can never go below zero.
    expect((await rejects(snackSale(ali.id, [[club.products.chips, 3, 50]]))).hint).toBe('insufficient_stock')

    const d = await today()
    const products = await db.rpc<{ totals: Record<string, number> }>(admin.id, 'get_product_sales', { p_from: d, p_to: d })
    expect(products.totals).toMatchObject({ quantity: 3, revenue: 250, cost: 150, gross_profit: 100 })
    expect((await tableSales(d, d)).totals).toMatchObject({ sessions: 0, total: 0 })
  })

  it('each staff member sees their own snack sales; the admin sees all; admins cannot sell', async () => {
    await db.openCounter(ali.id)
    await db.openCounter(sara.id)
    await snackSale(ali.id, [[club.products.tea, 2, 70]])
    await snackSale(sara.id, [[club.products.cola, 1, 100]], 'bank_transfer')
    await tableSale(ali.id, club.tables.snooker1, 10) // a table: not a snack sale
    const d = await today()

    const all = await db.rpc<SnackSales>(admin.id, 'get_snack_sales', { p_from: d, p_to: d })
    expect(all.scope).toBe('all')
    expect(all.totals).toMatchObject({ total: 240, cash: 140, bank: 100, count: 2, items: 3 })
    const mine = await db.rpc<SnackSales>(sara.id, 'get_snack_sales', { p_from: d, p_to: d })
    expect(mine).toMatchObject({ scope: 'mine', totals: { total: 100, count: 1 } })
    expect(mine.sales.map((s) => s.items)).toEqual([[{ name: 'Cola', quantity: 1 }]])

    expect((await rejects(snackSale(admin.id, [[club.products.tea, 1, 70]]))).hint).toBe('admin_no_sales')
    expect((await rejects(db.rpc(null, 'get_snack_sales', { p_from: d, p_to: d }))).message).toMatch(/permission denied/)
  })
})

describe('table sales report', () => {
  it('totals each table from its paid invoices: sessions, cash, bank, tab snacks — snack-only sales excluded', async () => {
    await db.openCounter(ali.id)
    await tableSale(ali.id, club.tables.snooker1, 30) // 300 cash
    await tableSale(ali.id, club.tables.snooker1, 20, { cola: 1, discount: 50, method: 'bank_transfer' }) // 200 + 100 − 50 = 250 bank
    await tableSale(ali.id, club.tables.pool1, 40) // 40 × 7.5 = 300 cash
    await snackSale(ali.id, [[club.products.tea, 3, 70]]) // 210, no table
    const d = await today()

    const r = await tableSales(d, d)
    expect(row(r, club.tables.snooker1)).toMatchObject({ name: 'Snooker 1', sessions: 2, total: 550, cash: 300, bank: 250, table_time: 500, snacks: 100, discounts: 50 })
    expect(row(r, club.tables.pool1)).toMatchObject({ name: 'Pool 1', sessions: 1, total: 300, cash: 300, bank: 0 })
    expect(r.totals).toMatchObject({ sessions: 3, total: 850, cash: 600, bank: 250 })
    // The same money as the counter took for tables (snack-only sales are the rest).
    const ledger = await db.one<{ total: number }>(`select sum(cash_sales + bank_sales)::float total from public.shift_daily_totals`)
    expect(r.totals.total! + 210).toBe(ledger.total)
  })

  it('filters by business date (today, yesterday, a range)', async () => {
    await db.openCounter(ali.id)
    const old = await tableSale(ali.id, club.tables.snooker1, 10) // 100
    await tableSale(ali.id, club.tables.snooker1, 20) // 200
    const d = await today()
    const y = await minus(d, 1)
    await db.sql(`update public.sales set business_date = $2 where id = $1`, [old.sale_id, y])

    expect(row(await tableSales(d, d), club.tables.snooker1)).toMatchObject({ sessions: 1, total: 200 })
    expect(row(await tableSales(y, y), club.tables.snooker1)).toMatchObject({ sessions: 1, total: 100 })
    expect(row(await tableSales(await minus(d, 6), d), club.tables.snooker1)).toMatchObject({ sessions: 2, total: 300 })
    expect(row(await tableSales(await minus(d, 30), await minus(d, 2)), club.tables.snooker1)).toMatchObject({ sessions: 0, total: 0 })
  })

  it('follows the retention policy: once old invoices are removed, their table sales are gone too', async () => {
    const shift = await db.openCounter(ali.id)
    await tableSale(ali.id, club.tables.snooker1, 30) // 300
    await db.rpc(ali.id, 'close_counter')
    // Move that closed shift 10 days back (as if it traded then).
    await db.sql(`update public.sales set business_date = business_date - 10 where shift_id = $1`, [shift.id])
    await db.sql(`update public.shift_daily_totals set business_date = business_date - 10 where shift_id = $1`, [shift.id])
    const d = await today()
    const from = await minus(d, 30)
    expect(row(await tableSales(from, d), club.tables.snooker1)).toMatchObject({ sessions: 1, total: 300 })

    await db.sql(`update public.settings set sales_retention_days = 7`)
    expect(await db.rpc<{ sales_deleted: number }>(admin.id, 'admin_run_retention')).toMatchObject({ sales_deleted: 1 })
    const after = await tableSales(from, d)
    expect(row(after, club.tables.snooker1)).toMatchObject({ sessions: 0, total: 0 })
    expect(after.totals).toMatchObject({ sessions: 0, total: 0 })
    expect(after.retention_days).toBe(7)
  })

  it('is for administrators only and validates the range', async () => {
    const d = await today()
    expect((await rejects(tableSales(d, d, ali.id))).hint).toBe('forbidden')
    expect((await rejects(tableSales(d, await minus(d, 1)))).hint).toBe('invalid_input')
    expect((await rejects(db.rpc(null, 'get_table_sales', { p_from: d, p_to: d }))).message).toMatch(/permission denied/)
  })
})
