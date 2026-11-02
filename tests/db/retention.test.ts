/**
 * Automatic sales-detail retention: only expired invoices of closed shifts
 * are removed; every total, shift summary and customer statistic survives.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

type Run = { status: string; source: string; sales_deleted: number; items_deleted: number; shifts_affected: number; message: string | null; cutoff_date: string }
type Status = { retention_days: number; eligible_sales: number; eligible_items: number; waiting_on_open_shifts: number; retained_sales: number; scheduled: boolean; last_success: Run | null; recent_runs: Run[] }

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let cashier: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  cashier = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['counter_sale', 'view_own_sales'] })
})
afterEach(async () => db.close())

const sellCola = (qty: number, phone?: string) =>
  db.rpc<{ sale_id: string }>(cashier.id, 'complete_checkout', {
    p_client_ref: randomUUID(),
    p_payment_method: 'cash',
    p_items: [{ product_id: club.products.tea, quantity: qty, unit_price: 70 }],
    p_customer_name: phone ? 'Regular' : null,
    p_customer_phone: phone ?? null
  })

/** Open a counter, trade, close it, then move the whole shift `daysAgo` business days back. */
async function shiftDaysAgo(daysAgo: number, trade: () => Promise<unknown>, close = true) {
  const shift = await db.openCounter(cashier.id)
  await trade()
  if (close) await db.rpc(cashier.id, 'close_counter')
  const args = [shift.id, daysAgo]
  await db.sql(`update public.sales set business_date = business_date - $2::int where shift_id = $1`, args)
  await db.sql(`update public.shift_daily_totals set business_date = business_date - $2::int where shift_id = $1`, args)
  await db.sql(
    `update public.customer_visits v set business_date = v.business_date - $2::int
     where v.customer_id in (select s.customer_id from public.sales s where s.shift_id = $1)
       and v.business_date = (select max(s.business_date) + $2::int from public.sales s where s.shift_id = $1)`,
    args
  )
  await db.sql(
    `update public.counter_shifts set business_date = business_date - $2::int,
       opened_at = opened_at - make_interval(days => $2::int), closed_at = closed_at - make_interval(days => $2::int)
     where id = $1`,
    args
  )
  return shift.id
}

const today = async () => (await db.one<{ d: string }>(`select public.get_current_business_date()::text as d`)).d
const minus = async (d: string, n: number) => (await db.one<{ d: string }>(`select ($1::date - $2::int)::text d`, [d, n])).d
const count = async (table: string) => (await db.one<{ n: number }>(`select count(*)::int n from public.${table}`)).n
const history = async (days: number) => {
  const d = await today()
  return db.rpc<{ totals: { total: number; invoices: number }; days: unknown[]; by_staff: unknown[] }>(admin.id, 'get_history', { p_from: await minus(d, days), p_to: d })
}

describe('sales retention', () => {
  it('removes only invoices older than the period, from closed shifts, keeping every total', async () => {
    await db.sql(`update public.settings set sales_retention_days = 7`)
    const old = await shiftDaysAgo(10, async () => {
      await sellCola(2, '0300-5550001') // 140
      await sellCola(1) // 70
    })
    const recent = await shiftDaysAgo(3, () => sellCola(3)) // 210
    const before = await history(60)
    const rankingBefore = await db.rpc<{ rows: unknown[] }>(admin.id, 'get_customer_rankings', { p_metric: 'spending' })

    const status = await db.rpc<Status>(admin.id, 'get_retention_status')
    expect(status).toMatchObject({ retention_days: 7, eligible_sales: 2, eligible_items: 2, retained_sales: 3, scheduled: false })

    const run = await db.rpc<Run>(admin.id, 'admin_run_retention')
    expect(run).toMatchObject({ status: 'success', source: 'manual', sales_deleted: 2, items_deleted: 2, shifts_affected: 1 })
    expect(await count('sales')).toBe(1)

    // Permanent figures are unchanged (only invoice availability differs).
    const after = await history(60)
    expect([after.totals, after.days, after.by_staff]).toEqual([before.totals, before.days, before.by_staff])
    expect(before.totals).toMatchObject({ total: 420, invoices: 3 })
    expect(await db.rpc(admin.id, 'get_customer_rankings', { p_metric: 'spending' })).toEqual(rankingBefore)
    const oldShift = await db.rpc<{ total: number; invoices: number; details_purged_at: string | null; retained_invoices: number; invoices_visible: boolean }>(
      admin.id,
      'get_shift_detail',
      { p_shift_id: old }
    )
    expect(oldShift).toMatchObject({ total: 210, invoices: 2, retained_invoices: 0, invoices_visible: true })
    expect(oldShift.details_purged_at).not.toBeNull()
    const recentShift = await db.rpc<{ retained_invoices: number; details_purged_at: string | null }>(admin.id, 'get_shift_detail', {
      p_shift_id: recent
    })
    expect(recentShift).toMatchObject({ retained_invoices: 1, details_purged_at: null })
    // Expense records, shifts and customers are never removed.
    expect(await count('counter_shifts')).toBe(2)
    expect(await count('customers')).toBe(1)
  })

  it('keeps invoices of a counter that is still open, however old', async () => {
    await db.sql(`update public.settings set sales_retention_days = 1`)
    await shiftDaysAgo(5, () => sellCola(1), false)
    const status = await db.rpc<Status>(admin.id, 'get_retention_status')
    expect(status).toMatchObject({ eligible_sales: 0, waiting_on_open_shifts: 1 })
    const run = await db.rpc<Run>(admin.id, 'admin_run_retention')
    expect(run).toMatchObject({ status: 'success', sales_deleted: 0 })
    expect(await count('sales')).toBe(1)
  })

  it('respects each period exactly: Daily keeps yesterday, removes the day before', async () => {
    await db.sql(`update public.settings set sales_retention_days = 1`)
    await shiftDaysAgo(1, () => sellCola(1))
    await shiftDaysAgo(2, () => sellCola(1))
    const run = await db.rpc<Run>(admin.id, 'admin_run_retention')
    expect(run.sales_deleted).toBe(1)
    const [left] = await db.sql<{ age: number }>(`select (public.get_current_business_date() - business_date) as age from public.sales`)
    expect(left!.age).toBe(1)
  })

  it('is idempotent and logs every run, including the scheduled entry point', async () => {
    await db.sql(`update public.settings set sales_retention_days = 7`)
    await shiftDaysAgo(9, () => sellCola(1))
    await db.sql(`select public.fusion_retention_job()`) // as the scheduler (no signed-in user)
    const second = await db.rpc<Run>(admin.id, 'admin_run_retention')
    expect(second).toMatchObject({ status: 'success', sales_deleted: 0 })
    const status = await db.rpc<Status>(admin.id, 'get_retention_status')
    expect(status.recent_runs.map((r) => [r.source, r.status, r.sales_deleted])).toEqual([
      ['manual', 'success', 0],
      ['schedule', 'success', 1]
    ])
    expect(status.last_success?.source).toBe('manual')
    expect((await history(30)).totals.total).toBe(70)
  })

  it('a failure removes nothing and is logged', async () => {
    await db.sql(`update public.settings set sales_retention_days = 7`)
    await shiftDaysAgo(9, () => sellCola(1))
    await db.pg.exec(`
      create function public.test_block() returns trigger language plpgsql as $$
      begin raise exception 'disk full'; end $$;
      create trigger block_delete before delete on public.sale_items for each row execute function public.test_block();`)
    const run = await db.rpc<Run>(admin.id, 'admin_run_retention')
    expect(run).toMatchObject({ status: 'failed', sales_deleted: 0 })
    expect(run.message).toContain('disk full')
    expect(await count('sales')).toBe(1)
    expect(await count('sale_items')).toBe(1)
    const [shift] = await db.sql<{ details_purged_at: string | null }>(`select details_purged_at from public.counter_shifts`)
    expect(shift!.details_purged_at).toBeNull()
  })

  it('the period is Daily, Weekly or Monthly only, Monthly by default, and admin-only', async () => {
    expect((await db.one<{ d: number }>(`select sales_retention_days d from public.settings`)).d).toBe(30)
    const err = await rejects(db.rpc(admin.id, 'admin_update_settings', { p_settings: { sales_retention_days: 14 } }))
    expect(err.hint).toBe('invalid_input')
    await db.rpc(admin.id, 'admin_update_settings', { p_settings: { sales_retention_days: 7 } })
    expect((await db.one<{ d: number }>(`select sales_retention_days d from public.settings`)).d).toBe(7)
    expect((await rejects(db.rpc(cashier.id, 'admin_run_retention'))).hint).toBe('forbidden')
    expect((await rejects(db.rpc(cashier.id, 'get_retention_status'))).hint).toBe('forbidden')
  })
})
