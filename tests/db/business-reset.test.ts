/**
 * Settings → Data management → Reset business data (migration 1200): admin
 * only, password and typed confirmation checked by the database, optional
 * backup, one transaction, and everything that is not business data kept.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TEST_PASSWORD, TestDb, rejects, seedClub, type TestUser } from './harness'

const CONFIRM = 'RESET BUSINESS DATA'
const BUSINESS_TABLES = [
  'sessions', 'session_items', 'bookings', 'sales', 'sale_items', 'counter_shifts', 'shift_daily_totals',
  'expenses', 'daily_summaries', 'product_sales_daily', 'customers', 'customer_visits', 'retention_runs'
]
type Counts = Record<string, number>
type ResetResult = { removed: Counts; stock_reset: boolean; reset_by: string }
type Backup = { format: string; version: number; summary: Counts; tables: Record<string, Record<string, unknown>[]> }

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let staff: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin', { username: 'owner' })
  staff = await db.createUser('staff', { floorId: null, permissions: ['counter_sale', 'apply_discount', 'cancel_session'] })
})
afterEach(async () => db.close())

const count = async (table: string) => (await db.one<{ n: number }>(`select count(*)::int n from public.${table}`)).n
const today = async () => (await db.one<{ d: string }>(`select public.get_current_business_date()::text as d`)).d
const reset = (args: { password?: string; confirmation?: string; resetStock?: boolean } = {}, user = admin.id) =>
  db.rpc<ResetResult>(user, 'admin_reset_business_data', {
    p_password: args.password ?? TEST_PASSWORD,
    p_confirmation: args.confirmation ?? CONFIRM,
    p_reset_stock: args.resetStock ?? false
  })

/** Everything a reset must leave exactly as it was. */
const kept = async () => ({
  logins: await db.sql(`select id, email, encrypted_password from auth.users order by id`),
  users: await db.sql(`select * from public.app_users order by id`),
  floors: await db.sql(`select * from public.floors order by id`),
  categories: await db.sql(`select * from public.table_categories order by id`),
  tables: await db.sql(`select * from public.club_tables order by id`),
  products: await db.sql(`select id, name, category, cost_price, selling_price, track_stock, low_stock_threshold, is_active from public.inventory_products order by id`),
  settings: await db.sql(`select club_name, club_address, business_timezone, day_start_hour, billing_increment_minutes, billing_rounding,
                                 minimum_charge_minutes, admin_idle_lock_minutes, sales_retention_days from public.settings`),
  functions: await db.sql(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace`),
  policies: await db.sql(`select tablename, policyname from pg_policies where schemaname = 'public' order by 1, 2`),
  grants: await db.sql(`select routine_name, grantee from information_schema.role_routine_grants
                        where routine_schema = 'public' and grantee in ('anon', 'authenticated') order by 1, 2`)
})

/** Months of business in miniature: every kind of record a reset removes. */
async function trade() {
  await db.openCounter(staff.id)
  const s = await db.rpc<{ id: string }>(staff.id, 'start_session', { p_table_id: club.tables.snooker1 })
  await db.rpc(staff.id, 'add_session_item', { p_session_id: s.id, p_product_id: club.products.cola })
  await db.ageSession(s.id, 30 * 60)
  await db.rpc(staff.id, 'end_session', { p_session_id: s.id })
  await db.rpc(staff.id, 'complete_checkout', {
    p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: s.id, p_customer_name: 'Regular', p_customer_phone: '03001234567'
  })
  await db.rpc(staff.id, 'complete_checkout', {
    p_client_ref: randomUUID(), p_payment_method: 'bank_transfer', p_items: [{ product_id: club.products.chips, quantity: 1, unit_price: 50 }]
  })
  const open = await db.rpc<{ id: string }>(staff.id, 'start_session', { p_table_id: club.tables.pool1 })
  await db.rpc(staff.id, 'add_session_item', { p_session_id: open.id, p_product_id: club.products.tea })
  await db.rpc(staff.id, 'add_expense', { p_client_ref: randomUUID(), p_amount: 40, p_description: 'Milk' })
  await db.rpc(admin.id, 'admin_add_expense', {
    p_client_ref: randomUUID(), p_business_date: await today(), p_category: 'utilities', p_amount: 900, p_description: 'Gas'
  })
  await db.sql(`insert into public.bookings (customer_name, table_id, booking_at, created_by) values ('Walk-in', $1, now() + interval '1 day', $2)`,
    [club.tables.snooker1, admin.id])
  await db.sql(`insert into public.daily_summaries (business_date, total_cash, total_bank, total_sales) values ('2026-01-01', 1, 2, 3)`)
  await db.rpc(admin.id, 'admin_run_retention')
}

describe('who may reset, and how it is confirmed', () => {
  it('only an administrator, with their own password and the exact phrase; staff and visitors never', async () => {
    await trade()
    const before = await db.rpc<{ counts: Counts }>(admin.id, 'admin_business_data_summary')
    expect((await rejects(reset({}, staff.id))).hint).toBe('forbidden')
    expect((await rejects(db.rpc(staff.id, 'admin_export_business_data', { p_password: TEST_PASSWORD }))).hint).toBe('forbidden')
    expect((await rejects(db.rpc(staff.id, 'admin_business_data_summary'))).hint).toBe('forbidden')
    expect((await rejects(reset({}, null as unknown as string))).message).toMatch(/permission denied/)
    expect((await rejects(reset({ password: 'wrong-password' }))).hint).toBe('wrong_password')
    expect((await rejects(reset({ password: '' }))).hint).toBe('wrong_password')
    // Another administrator's password is not this administrator's password.
    const other = await db.createUser('admin', { username: 'partner', password: 'partner-secret-1' })
    expect((await rejects(reset({ password: 'partner-secret-1' }))).hint).toBe('wrong_password')
    expect((await rejects(reset({ password: TEST_PASSWORD }, other.id))).hint).toBe('wrong_password')
    for (const phrase of ['reset business data', 'RESET', ' RESET BUSINESS DATA', '']) {
      expect((await rejects(reset({ confirmation: phrase }))).hint).toBe('invalid_input')
    }
    // Nothing was touched by any refused attempt.
    expect(await db.rpc<{ counts: Counts }>(admin.id, 'admin_business_data_summary')).toMatchObject({ counts: before.counts })
  })

  it('is never started by the scheduled cleanup', async () => {
    const job = await db.sql<{ src: string }>(`select prosrc src from pg_proc where proname in ('fusion_retention_job', 'fusion_run_retention')`)
    expect(job.every((j) => !j.src.includes('admin_reset_business_data') && !j.src.includes('truncate'))).toBe(true)
  })
})

describe('the reset', () => {
  it('permanently removes every business record and keeps accounts, roles, settings, tables, categories and products', async () => {
    await trade()
    for (const t of BUSINESS_TABLES) expect(await count(t), t).toBeGreaterThan(0)
    const stockBefore = await db.sql(`select id, stock_quantity from public.inventory_products order by id`)
    const before = await kept()

    const result = await reset()
    expect(result.removed).toMatchObject({ sales: 2, counter_shifts: 1, open_sessions: 1, open_counters: 1, customers: 1, expenses: 2, bookings: 1 })
    expect(result).toMatchObject({ stock_reset: false, reset_by: 'admin owner' })
    for (const t of BUSINESS_TABLES) expect(await count(t), t).toBe(0)
    expect(await kept()).toEqual(before)
    // Stock is kept by default; units-sold totals (sales history) are not.
    expect(await db.sql(`select id, stock_quantity from public.inventory_products order by id`)).toEqual(stockBefore)
    expect((await db.one<{ sold: number }>(`select sum(units_sold)::int sold from public.inventory_products`)).sold).toBe(0)
    const stamp = await db.rpc<{ counts: Counts; last_reset_at: string | null; last_reset_by: string | null }>(admin.id, 'admin_business_data_summary')
    expect(stamp.last_reset_at).not.toBeNull()
    expect(stamp.last_reset_by).toBe('admin owner')
    expect(Object.values(stamp.counts).every((n) => n === 0)).toBe(true)
  })

  it('sets stock to zero only when asked', async () => {
    await trade()
    await reset({ resetStock: true })
    expect(await db.sql(`select distinct stock_quantity from public.inventory_products`)).toEqual([{ stock_quantity: 0 }])
  })

  it('leaves every screen at zero and the club ready to trade again, with receipts from #1', async () => {
    await trade()
    await reset()
    const d = await today()
    const from = '2026-01-01'
    expect((await db.rpc<{ today: Record<string, number> }>(admin.id, 'get_dashboard')).today).toMatchObject({ total: 0, cash: 0, bank: 0, expenses: 0 })
    expect((await db.rpc<{ final: Record<string, number>; live: Record<string, number> }>(admin.id, 'get_financial_report', { p_from: from, p_to: d }))
      .final).toMatchObject({ total: 0, expenses: 0, shifts: 0 })
    expect((await db.rpc<{ totals: Record<string, number> }>(admin.id, 'get_history', { p_from: from, p_to: d })).totals).toMatchObject({ total: 0 })
    expect((await db.rpc<{ products: unknown[] }>(admin.id, 'get_product_sales', { p_from: from, p_to: d })).products).toEqual([])
    expect((await db.rpc<{ totals: Record<string, number> }>(admin.id, 'get_table_sales', { p_from: from, p_to: d })).totals).toMatchObject({ total: 0, sessions: 0 })
    expect((await db.rpc<{ totals: Record<string, number> }>(admin.id, 'get_snack_sales', { p_from: from, p_to: d })).totals).toMatchObject({ total: 0 })
    expect((await db.rpc<{ items: unknown[] }>(admin.id, 'get_expenses', { p_from: from, p_to: d })).items).toEqual([])
    expect(await db.rpcRows(admin.id, 'list_open_business_dates')).toEqual([])
    const tables = await db.rpc<{ tables: { session: unknown }[] }>(staff.id, 'get_tables_overview')
    expect(tables.tables.every((t) => t.session === null)).toBe(true)
    expect(await db.rpc(staff.id, 'get_my_counter')).toMatchObject({ shift: null })

    await db.openCounter(staff.id)
    const sale = await db.rpc<{ receipt_no: number }>(staff.id, 'complete_checkout', {
      p_client_ref: randomUUID(), p_payment_method: 'cash', p_items: [{ product_id: club.products.tea, quantity: 1, unit_price: 70 }]
    })
    expect(sale.receipt_no).toBe(1)
    expect((await db.rpc<{ final: Record<string, number>; live: Record<string, number> }>(admin.id, 'get_financial_report', { p_from: d, p_to: d })).live.total).toBe(70)
  })

  it('can be repeated: a second reset finds nothing and changes nothing else', async () => {
    await trade()
    await reset()
    const before = await kept()
    const again = await reset()
    expect(Object.values(again.removed).every((n) => n === 0)).toBe(true)
    expect(await kept()).toEqual(before)
  })

  it('a failure part-way changes nothing (one transaction)', async () => {
    await trade()
    // A table a future version might add that refers to sessions: TRUNCATE refuses to leave it dangling.
    await db.sql(`create table public.session_notes (session_id uuid references public.sessions (id), note text)`)
    await db.sql(`insert into public.session_notes select id, 'x' from public.sessions limit 1`)
    const sales = await count('sales')
    const stock = await db.sql(`select id, stock_quantity, units_sold from public.inventory_products order by id`)
    await expect(reset()).rejects.toThrow(/cannot truncate a table referenced in a foreign key constraint/)
    expect(await count('sales')).toBe(sales)
    expect(await count('counter_shifts')).toBe(1)
    expect(await db.sql(`select id, stock_quantity, units_sold from public.inventory_products order by id`)).toEqual(stock)
    expect((await db.rpc<{ last_reset_at: string | null }>(admin.id, 'admin_business_data_summary')).last_reset_at).toBeNull()
  })
})

describe('the live API guard', () => {
  // Supabase loads pg-safeupdate for API requests: an UPDATE or DELETE
  // without WHERE is refused and rolls the whole call back. That broke the
  // first live reset (its products update had no WHERE); PGlite has no such
  // guard, so every function's statements are checked here instead.
  it('no database function updates or deletes without a WHERE clause', async () => {
    const fns = await db.sql<{ name: string; src: string }>(
      `select p.proname as name, p.prosrc as src from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.prolang in (select oid from pg_language where lanname in ('plpgsql', 'sql'))`
    )
    const offenders: string[] = []
    for (const f of fns) {
      for (const statement of f.src.replace(/--[^\n]*/g, '').split(';')) {
        if (/\b(update|delete\s+from)\s+public\.\w+/i.test(statement) && !/\bwhere\b/i.test(statement)) {
          offenders.push(`${f.name}: ${statement.replace(/\s+/g, ' ').trim().slice(0, 80)}`)
        }
      }
    }
    expect(fns.length).toBeGreaterThan(80)
    expect(offenders).toEqual([])
  })
})

describe('the optional backup', () => {
  it('needs the password and contains every record a reset would remove', async () => {
    await trade()
    expect((await rejects(db.rpc(admin.id, 'admin_export_business_data', { p_password: 'nope' }))).hint).toBe('wrong_password')
    const backup = await db.rpc<Backup>(admin.id, 'admin_export_business_data', { p_password: TEST_PASSWORD })
    expect(backup).toMatchObject({ format: 'fusion-business-data-backup', version: 1 })
    for (const t of BUSINESS_TABLES) {
      expect(backup.tables[t]!.length, t).toBe(await count(t))
      expect(backup.summary[t], t).toBe(await count(t))
    }
    expect(backup.tables.customers![0]).toMatchObject({ name: 'Regular', phone: '03001234567' })
    // Exporting changes nothing; skipping it is simply resetting without exporting.
    expect(await count('sales')).toBe(2)
    await reset()
    expect(await count('sales')).toBe(0)
  })
})
