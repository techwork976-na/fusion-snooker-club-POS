/**
 * Upgrading to per-minute rates (migration 0800) on a database that already
 * holds hourly prices, paid invoices and sessions still running: nothing is
 * lost, no stored amount changes, and running sessions bill as they would have.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, seedClub, type TestUser } from './harness'

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let staff: TestUser

beforeEach(async () => {
  db = await TestDb.create({ stopBefore: '20261101000800' })
  club = await seedClub(db) // stored per hour: Snooker 600/h, Pool 450/h
  staff = await db.createUser('staff', { floorId: null, permissions: ['counter_sale'] })
  await db.sql(`update public.table_categories set rate_per_hour = 400 where id = $1`, [club.categories.pool])
  await db.openCounter(staff.id)
})
afterEach(async () => db.close())

const pay = (sessionId: string) =>
  db.rpc<{ base_amount: number; final_amount: number }>(staff.id, 'complete_checkout', {
    p_client_ref: randomUUID(),
    p_payment_method: 'cash',
    p_session_id: sessionId
  })

describe('upgrading hourly rates to per-minute rates', () => {
  it('converts every rate exactly and keeps all amounts and running sessions intact', async () => {
    // Paid before the upgrade: 30 min of snooker at 600/h = 300.
    const paid = await db.rpc<{ id: string }>(staff.id, 'start_session', { p_table_id: club.tables.snooker1 })
    await db.ageSession(paid.id, 30 * 60)
    await db.rpc(staff.id, 'end_session', { p_session_id: paid.id })
    const receipt = await pay(paid.id)
    expect(receipt.final_amount).toBe(300)

    // Still running at upgrade time: pool open play (400/h) and a prepaid snooker booking (PKR 500 at 600/h = 50 min).
    const pool = await db.rpc<{ id: string }>(staff.id, 'start_session', { p_table_id: club.tables.pool1 })
    await db.ageSession(pool.id, 100 * 60)
    const prepaid = await db.rpc<{ id: string; booked_seconds: number }>(staff.id, 'start_session', {
      p_table_id: club.tables.snooker1,
      p_booking: 'amount',
      p_amount: 500
    })
    expect(prepaid.booked_seconds).toBe(3000)
    await db.ageSession(prepaid.id, 55 * 60)

    const before = await db.sql(
      `select (select json_agg(s order by s.receipt_no) from (select receipt_no, base_amount, final_amount, discount from public.sales) s) sales,
              (select json_agg(c) from (select cash_sales, bank_sales, discounts, invoice_count from public.counter_shifts) c) shifts,
              (select json_agg(t) from (select cash_sales, invoice_count from public.shift_daily_totals) t) ledger`
    )

    await db.migrateRest()

    const rates = await db.sql<{ name: string; rate: string }>(
      `select name, rate_per_minute::text rate from public.table_categories order by name`
    )
    expect(rates).toEqual([
      { name: 'Pool', rate: '6.6667' },
      { name: 'Snooker', rate: '10.0000' }
    ])
    const [oldSale] = await db.sql<{ rate: string }>(`select rate_per_minute::text rate from public.sales`)
    expect(oldSale!.rate).toBe('10.0000')
    const snapshots = await db.sql<{ id: string; rate: string }>(`select id, rate_per_minute::text rate from public.sessions`)
    expect(Object.fromEntries(snapshots.map((s) => [s.id, s.rate]))).toEqual({
      [paid.id]: '10.0000',
      [pool.id]: '6.6667',
      [prepaid.id]: '10.0000'
    })

    // Stored amounts, shift totals and the ledger are untouched.
    const after = await db.sql(
      `select (select json_agg(s order by s.receipt_no) from (select receipt_no, base_amount, final_amount, discount from public.sales) s) sales,
              (select json_agg(c) from (select cash_sales, bank_sales, discounts, invoice_count from public.counter_shifts) c) shifts,
              (select json_agg(t) from (select cash_sales, invoice_count from public.shift_daily_totals) t) ledger`
    )
    expect(after).toEqual(before)

    // Running sessions bill exactly as the hourly price would have:
    // 100 min at 400/h = 666.67 -> 667; PKR 500 booking + 5 min at 600/h = 550.
    expect((await pay(await end(pool.id))).final_amount).toBe(667)
    expect((await pay(await end(prepaid.id))).final_amount).toBe(550)
    const closed = await db.rpc<{ total: number; invoices: number }>(staff.id, 'close_counter')
    expect(closed).toMatchObject({ total: 300 + 667 + 550, invoices: 3 })

    // No hourly column is left anywhere.
    const leftovers = await db.sql(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and column_name like '%per_hour%'`
    )
    expect(leftovers).toEqual([])
  })
})

async function end(sessionId: string): Promise<string> {
  await db.rpc(staff.id, 'end_session', { p_session_id: sessionId })
  return sessionId
}
