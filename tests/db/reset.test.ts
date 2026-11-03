/**
 * The one-off operational-data reset (supabase/maintenance/reset-operational-data.sql):
 * every business record goes, every login and setting stays, the app works
 * afterwards, and the script refuses to run without its confirmation.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

const RESET_SQL = readFileSync(join(__dirname, '..', '..', 'supabase', 'maintenance', 'reset-operational-data.sql'), 'utf8')
const OPERATIONAL = [
  'sessions', 'session_items', 'bookings', 'sales', 'sale_items', 'counter_shifts', 'shift_daily_totals',
  'expenses', 'daily_summaries', 'product_sales_daily', 'customers', 'customer_visits', 'retention_runs'
]

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let staff: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  staff = await db.createUser('staff', { floorId: null, permissions: ['counter_sale', 'apply_discount'] })
})
afterEach(async () => db.close())

const today = async () => (await db.one<{ d: string }>(`select public.get_current_business_date()::text as d`)).d
const count = async (table: string) => (await db.one<{ n: number }>(`select count(*)::int n from public.${table}`)).n

/** Everything the reset must leave exactly as it was. */
const configuration = async () => ({
  settings: await db.sql(`select * from public.settings`),
  floors: await db.sql(`select * from public.floors order by id`),
  categories: await db.sql(`select * from public.table_categories order by id`),
  tables: await db.sql(`select * from public.club_tables order by id`),
  products: await db.sql(
    `select id, name, category, cost_price, selling_price, track_stock, low_stock_threshold, is_active
     from public.inventory_products order by id`
  ),
  users: await db.sql(`select * from public.app_users order by id`),
  logins: await db.sql(`select id, email from auth.users order by id`),
  functions: await db.sql(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace`),
  policies: await db.sql(`select tablename, policyname from pg_policies where schemaname = 'public' order by 1, 2`),
  grants: await db.sql(
    `select routine_name, grantee from information_schema.role_routine_grants
     where routine_schema = 'public' and grantee in ('anon', 'authenticated') order by 1, 2`
  )
})

/** A day of business: tables, tabs, counter sales, a customer, expenses, a booking, a closed day and a cleanup run. */
async function trade() {
  await db.openCounter(staff.id)
  const s = await db.rpc<{ id: string }>(staff.id, 'start_session', { p_table_id: club.tables.snooker1 })
  await db.rpc(staff.id, 'add_session_item', { p_session_id: s.id, p_product_id: club.products.cola })
  await db.ageSession(s.id, 20 * 60)
  await db.rpc(staff.id, 'end_session', { p_session_id: s.id })
  await db.rpc(staff.id, 'complete_checkout', {
    p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: s.id, p_customer_name: 'Test Customer', p_customer_phone: '03001234567'
  })
  await db.rpc(staff.id, 'complete_checkout', {
    p_client_ref: randomUUID(), p_payment_method: 'bank_transfer', p_items: [{ product_id: club.products.chips, quantity: 2, unit_price: 50 }]
  })
  const running = await db.rpc<{ id: string }>(staff.id, 'start_session', { p_table_id: club.tables.pool1 })
  await db.rpc(staff.id, 'add_session_item', { p_session_id: running.id, p_product_id: club.products.tea }) // an unpaid tab
  await db.rpc(staff.id, 'add_expense', { p_client_ref: randomUUID(), p_amount: 40, p_description: 'Milk' })
  await db.rpc(admin.id, 'admin_add_expense', {
    p_client_ref: randomUUID(), p_business_date: await today(), p_category: 'utilities', p_amount: 900, p_description: 'Gas'
  })
  await db.sql(
    `insert into public.bookings (customer_name, table_id, booking_at, created_by) values ('Walk-in', $1, now() + interval '1 day', $2)`,
    [club.tables.snooker1, admin.id]
  )
  await db.rpc(admin.id, 'admin_run_retention')
}

const reset = async () => {
  await db.pg.exec(`set fusion.confirm_reset = 'DELETE-ALL-OPERATIONAL-DATA'`)
  try {
    await db.pg.exec(RESET_SQL)
  } finally {
    await db.pg.exec(`reset fusion.confirm_reset`)
  }
}

describe('operational data reset', () => {
  it('permanently removes every business record and keeps logins, settings and the club set-up', async () => {
    await trade()
    for (const t of ['sessions', 'session_items', 'bookings', 'sales', 'sale_items', 'counter_shifts', 'shift_daily_totals', 'expenses', 'product_sales_daily', 'customers', 'customer_visits', 'retention_runs']) {
      expect(await count(t), t).toBeGreaterThan(0)
    }
    const before = await configuration()

    await reset()

    for (const t of OPERATIONAL) expect(await count(t), t).toBe(0)
    expect(await db.sql(`select stock_quantity, units_sold from public.inventory_products`)).toEqual([
      { stock_quantity: 0, units_sold: 0 },
      { stock_quantity: 0, units_sold: 0 },
      { stock_quantity: 0, units_sold: 0 }
    ])
    expect(await configuration()).toEqual(before)

    // Nothing old can show up in any report.
    const d = await today()
    const report = await db.rpc<{ final: Record<string, number>; live: Record<string, number> }>(admin.id, 'get_financial_report', { p_from: '2026-01-01', p_to: d })
    expect(report.final).toMatchObject({ total: 0, expenses: 0, shifts: 0, invoices: 0 })
    expect(report.live).toMatchObject({ total: 0, shifts: 0 })
    expect((await db.rpc<{ totals: Record<string, number> }>(admin.id, 'get_history', { p_from: '2026-01-01', p_to: d })).totals).toMatchObject({ total: 0, expenses: 0 })
    expect((await db.rpc<{ products: unknown[] }>(admin.id, 'get_product_sales', { p_from: '2026-01-01', p_to: d })).products).toEqual([])
    expect((await db.rpc<{ items: unknown[] }>(admin.id, 'get_expenses', { p_from: '2026-01-01', p_to: d })).items).toEqual([])
    const tables = await db.rpc<{ tables: { session: unknown }[] }>(staff.id, 'get_tables_overview')
    expect(JSON.stringify(tables)).not.toContain('"status":"running"')

    // The club can start trading straight away; receipts start again at 1.
    await db.rpc(admin.id, 'adjust_stock', { p_product_id: club.products.chips, p_delta: 10 })
    await db.openCounter(staff.id)
    const sale = await db.rpc<{ receipt_no: number }>(staff.id, 'complete_checkout', {
      p_client_ref: randomUUID(), p_payment_method: 'cash', p_items: [{ product_id: club.products.chips, quantity: 1, unit_price: 50 }]
    })
    expect(sale.receipt_no).toBe(1)
  })

  it('refuses to run without the confirmation and then deletes nothing', async () => {
    await trade()
    const sales = await count('sales')
    const err = await rejects(db.pg.exec(RESET_SQL))
    expect(err.message).toMatch(/Refusing to reset/)
    await db.pg.exec('rollback')
    expect(await count('sales')).toBe(sales)
    expect(await count('counter_shifts')).toBeGreaterThan(0)
  })
})
