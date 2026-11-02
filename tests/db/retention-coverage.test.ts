/**
 * Sales retention across every way an invoice can exist: staff sales, sales
 * an administrator made before counters existed (imported into closed shifts),
 * and the permanent records that must survive cleanup — Reports, expenses,
 * product sales and customer statistics.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, seedClub, type TestUser } from './harness'

type Run = { status: string; sales_deleted: number; items_deleted: number }

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let staff: TestUser

afterEach(async () => db.close())

const today = async () => (await db.one<{ d: string }>(`select public.get_current_business_date()::text as d`)).d
const minus = async (d: string, n: number) => (await db.one<{ d: string }>(`select ($1::date - $2::int)::text d`, [d, n])).d
const count = async (table: string) => (await db.one<{ n: number }>(`select count(*)::int n from public.${table}`)).n

const sellTea = (user: string, qty: number, phone?: string) =>
  db.rpc<{ sale_id: string }>(user, 'complete_checkout', {
    p_client_ref: randomUUID(),
    p_payment_method: 'cash',
    p_items: [{ product_id: club.products.tea, quantity: qty, unit_price: 70 }],
    p_customer_name: phone ? 'Regular' : null,
    p_customer_phone: phone ?? null
  })

/** Moves every record of a shift `days` business days back (sales, ledger, products, visits, expenses). */
async function age(shiftId: string, days: number) {
  const args = [shiftId, days]
  await db.sql(
    `update public.product_sales_daily p set business_date = p.business_date - $2::int
     where (p.business_date, p.product_key) in (
       select s.business_date, coalesce(i.product_id::text, 'name:' || i.product_name)
       from public.sales s join public.sale_items i on i.sale_id = s.id where s.shift_id = $1)`,
    args
  )
  await db.sql(
    `update public.customer_visits v set business_date = v.business_date - $2::int
     where (v.customer_id, v.business_date) in (select s.customer_id, s.business_date from public.sales s where s.shift_id = $1)`,
    args
  )
  await db.sql(`update public.sales set business_date = business_date - $2::int where shift_id = $1`, args)
  await db.sql(`update public.shift_daily_totals set business_date = business_date - $2::int where shift_id = $1`, args)
  await db.sql(`update public.expenses set business_date = business_date - $2::int where shift_id = $1`, args)
  await db.sql(
    `update public.counter_shifts set business_date = business_date - $2::int,
       opened_at = opened_at - make_interval(days => $2::int), closed_at = closed_at - make_interval(days => $2::int)
     where id = $1`,
    args
  )
}

describe('retention covers every sale, whoever made it', () => {
  it('removes old invoices an administrator made before counters existed, keeping every total', async () => {
    db = await TestDb.create({ stopBefore: '20261101000700' })
    club = await seedClub(db)
    admin = await db.createUser('admin')
    staff = await db.createUser('staff', { floorId: null, permissions: ['counter_sale'] })
    // Before 0700 an administrator could check out at the counter.
    await sellTea(admin.id, 2) // 140, by the admin
    await sellTea(staff.id, 1) // 70, by staff
    await db.sql(`update public.sales set business_date = business_date - 10`)
    await db.migrateRest()

    const d = await today()
    const from = await minus(d, 30)
    const imported = await db.sql<{ user_id: string; status: string }>(`select user_id, status from public.counter_shifts order by user_id`)
    expect(imported.every((s) => s.status === 'closed')).toBe(true)
    expect(imported.map((s) => s.user_id).sort()).toEqual([admin.id, staff.id].sort())
    const reportBefore = await db.rpc<{ final: Record<string, number> }>(admin.id, 'get_financial_report', { p_from: from, p_to: d })
    const historyBefore = await db.rpc<{ totals: Record<string, number> }>(admin.id, 'get_history', { p_from: from, p_to: d })
    expect(reportBefore.final).toMatchObject({ total: 210, shifts: 2 })

    await db.sql(`update public.settings set sales_retention_days = 7`)
    const run = await db.rpc<Run>(admin.id, 'admin_run_retention')
    expect(run).toMatchObject({ status: 'success', sales_deleted: 2, items_deleted: 2 })
    expect(await count('sales')).toBe(0)
    expect(await count('sale_items')).toBe(0)

    expect((await db.rpc<{ final: unknown }>(admin.id, 'get_financial_report', { p_from: from, p_to: d })).final).toEqual(reportBefore.final)
    expect((await db.rpc<{ totals: unknown }>(admin.id, 'get_history', { p_from: from, p_to: d })).totals).toEqual(historyBefore.totals)
  })

  it('keeps Reports, expenses, product sales and customer statistics after cleanup, and a second run changes nothing', async () => {
    db = await TestDb.create()
    club = await seedClub(db)
    admin = await db.createUser('admin')
    staff = await db.createUser('staff', { floorId: null, permissions: ['counter_sale'] })
    const d = await today()
    const from = await minus(d, 30)

    // An old, closed counter: two sales and a counter expense.
    const old = await db.openCounter(staff.id)
    await sellTea(staff.id, 2, '0300-5550001')
    await sellTea(staff.id, 1)
    await db.rpc(staff.id, 'add_expense', { p_client_ref: randomUUID(), p_amount: 25, p_description: 'Sugar' })
    await db.rpc(staff.id, 'close_counter')
    await age(old.id, 10)
    // A business expense in the same period.
    await db.rpc(admin.id, 'admin_add_expense', {
      p_client_ref: randomUUID(), p_business_date: await minus(d, 10), p_category: 'utilities', p_amount: 900, p_description: 'Gas'
    })
    // Today's counter is still open: it must keep its invoices.
    await db.openCounter(staff.id)
    await sellTea(staff.id, 1)

    const snapshot = async () => ({
      report: await db.rpc<{ final: unknown; live: unknown; by_staff: unknown; closed_shifts: unknown; days: unknown }>(admin.id, 'get_financial_report', { p_from: from, p_to: d }),
      expenses: await db.rpc<{ totals: unknown; items: unknown }>(admin.id, 'get_expenses', { p_from: from, p_to: d }),
      products: await db.rpc<{ products: unknown; totals: unknown }>(admin.id, 'get_product_sales', { p_from: from, p_to: d }),
      rankings: await db.rpc(admin.id, 'get_customer_rankings', { p_metric: 'spending' }),
      ledger: await db.sql(`select * from public.shift_daily_totals order by shift_id, business_date`),
      shifts: await db.sql(`select id, cash_sales, bank_sales, snack_sales, expenses, invoice_count from public.counter_shifts order by id`)
    })
    const before = await snapshot()
    expect(before.report.final).toMatchObject({ total: 210, counter_expenses: 25, business_expenses: 900, net: -715 })
    expect(before.products.totals).toMatchObject({ quantity: 4, revenue: 280 })

    await db.sql(`update public.settings set sales_retention_days = 7`)
    const first = await db.rpc<Run>(admin.id, 'admin_run_retention')
    expect(first).toMatchObject({ status: 'success', sales_deleted: 2, items_deleted: 2 })
    expect(await count('sales')).toBe(1) // today's open counter
    const after = await snapshot()
    expect({ ...after, report: { ...after.report, generated_at: null } }).toEqual({ ...before, report: { ...before.report, generated_at: null } })
    expect(await count('expenses')).toBe(2)

    const second = await db.rpc<Run>(admin.id, 'admin_run_retention')
    expect(second).toMatchObject({ status: 'success', sales_deleted: 0 })
    const again = await snapshot()
    expect({ ...again, report: { ...again.report, generated_at: null } }).toEqual({ ...before, report: { ...before.report, generated_at: null } })
  })
})
