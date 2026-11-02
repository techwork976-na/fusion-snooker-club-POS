/**
 * Upgrading a database that already holds sales (made before counter shifts
 * existed) and days archived by the old "Close Day & Archive": nothing may be
 * lost or counted twice.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let staff: TestUser

beforeEach(async () => {
  db = await TestDb.create({ stopBefore: '20261101000700' })
  club = await seedClub(db)
  admin = await db.createUser('admin')
  staff = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['counter_sale'] })
})
afterEach(async () => db.close())

const sellTea = (user: string, method: string, qty: number, phone?: string) =>
  db.rpc<{ sale_id: string }>(user, 'complete_checkout', {
    p_client_ref: randomUUID(),
    p_payment_method: method,
    p_items: [{ product_id: club.products.tea, quantity: qty, unit_price: 70 }],
    p_customer_name: phone ? 'Regular' : null,
    p_customer_phone: phone ?? null
  })
const moveBack = (saleId: string, days: number) =>
  db.sql(`update public.sales set business_date = business_date - $2::int where id = $1`, [saleId, days])

describe('upgrading an existing database', () => {
  it('keeps every sale and archived total, attached to imported shifts', async () => {
    const d = (await db.one<{ d: string }>(`select public.get_current_business_date()::text d`)).d
    const d2 = (await db.one<{ d: string }>(`select ($1::date - 2)::text d`, [d])).d

    // Two days ago: one sale archived the old way (deleted), one made after the archive.
    const archived = await sellTea(staff.id, 'cash', 2, '0300-2223334') // 140
    await moveBack(archived.sale_id, 2)
    await db.rpc(admin.id, 'close_business_day', { p_business_date: d2 })
    const late = await sellTea(staff.id, 'cash', 1) // 70
    await moveBack(late.sale_id, 2)
    // Today: the admin sold under the old rules; staff sold to a known customer.
    await sellTea(admin.id, 'bank_transfer', 1) // 70
    await sellTea(staff.id, 'cash', 3, '0300-2223334') // 210
    const before = await db.rpc<{ totals: { cash: number; bank: number; total: number } }>(admin.id, 'get_sales_report', {
      p_from: d2,
      p_to: d
    })
    expect(before.totals).toMatchObject({ cash: 420, bank: 70, total: 490 })

    await db.migrateRest()

    // Every remaining sale belongs to an imported, closed shift.
    const shifts = await db.sql<{ user_id: string; business_date: string; status: string; imported: boolean; total: string }>(
      `select user_id, business_date::text, status, imported, (cash_sales + bank_sales)::text total
       from public.counter_shifts order by business_date, user_id`
    )
    expect(shifts).toHaveLength(3)
    expect(shifts.every((s) => s.status === 'closed' && s.imported)).toBe(true)
    const [unattached] = await db.sql<{ n: number }>(`select count(*)::int n from public.sales where shift_id is null`)
    expect(unattached!.n).toBe(0)

    // Reports give the same totals as before, now from the permanent ledger.
    const after = await db.rpc<{ totals: { cash: number; bank: number; total: number } }>(admin.id, 'get_sales_report', { p_from: d2, p_to: d })
    expect(after.totals).toMatchObject(before.totals)
    const history = await db.rpc<{ totals: { cash: number; bank: number; total: number; legacy: number; invoices: number }; by_staff: { user_id: string; total: number }[] }>(
      admin.id,
      'get_history',
      { p_from: d2, p_to: d }
    )
    expect(history.totals).toMatchObject({ cash: 420, bank: 70, total: 490, legacy: 140, invoices: 3 })
    expect(Object.fromEntries(history.by_staff.map((s) => [s.user_id, s.total]))).toEqual({ [staff.id]: 280, [admin.id]: 70 })

    // The old archived day is kept as a legacy amount and needs one re-close for its late sale.
    const open = await db.rpcRows<{ business_date: string; total_sales: string; changed_since_close: boolean }>(admin.id, 'list_open_business_dates')
    const day = (v: unknown) => new Date(v as string).toISOString().slice(0, 10)
    expect(open.map((o) => [day(o.business_date), Number(o.total_sales), o.changed_since_close])).toEqual([
      [d, 280, false],
      [d2, 210, true]
    ])
    const closed = await db.rpc<{ summary: { total_sales: number; legacy_cash: number } }>(admin.id, 'close_business_day', { p_business_date: d2 })
    expect(closed.summary).toMatchObject({ total_sales: 210, legacy_cash: 140 })

    // Customer statistics were built from the remaining sales.
    const ranking = await db.rpc<{ rows: { phone: string; visits: number; spent: number }[] }>(admin.id, 'get_customer_rankings', {
      p_metric: 'spending'
    })
    expect(ranking.rows).toMatchObject([{ phone: '03002223334', visits: 1, spent: 210 }])

    // From now on the new rules apply.
    expect((await rejects(sellTea(admin.id, 'cash', 1))).hint).toBe('admin_no_sales')
    expect((await rejects(sellTea(staff.id, 'cash', 1))).hint).toBe('counter_closed')
  })
})
