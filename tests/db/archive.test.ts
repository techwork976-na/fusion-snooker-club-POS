/**
 * Closing a business day (no longer deletes anything) and the admin History
 * report over Today / Weekly / Monthly / Custom ranges.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

type CloseResult = {
  business_date: string
  summary: { total_cash: number; total_bank: number; total_sales: number; expenses: number; invoice_count: number; net_amount: number; closed_at: string }
  staff: { user_id: string; total: number }[]
}
type History = {
  totals: { cash: number; bank: number; total: number; snack: number; expenses: number; net: number; invoices: number; legacy: number }
  days: { date: string; total: number; closed: boolean }[]
  by_staff: { user_id: string; total: number; expenses: number; net: number; shifts: number }[]
  shifts: { id: string; user_id: string; total: number; retained_invoices: number }[]
}

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let cashier: TestUser
let other: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  cashier = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['counter_sale'] })
  other = await db.createUser('staff', { floorId: club.floors.first, permissions: ['counter_sale'] })
})
afterEach(async () => db.close())

async function sell(user: string, method: 'cash' | 'bank_transfer', qty: number) {
  return db.rpc<{ sale_id: string; final_amount: number }>(user, 'complete_checkout', {
    p_client_ref: randomUUID(),
    p_payment_method: method,
    p_items: [{ product_id: club.products.tea, quantity: qty, unit_price: 70 }]
  })
}

async function tableSale(user: string) {
  const s = await db.rpc<{ id: string }>(user, 'start_session', { p_table_id: club.tables.snooker1 })
  await db.ageSession(s.id, 1800)
  await db.rpc(user, 'end_session', { p_session_id: s.id })
  return db.rpc<{ sale_id: string }>(user, 'complete_checkout', {
    p_client_ref: randomUUID(),
    p_payment_method: 'cash',
    p_session_id: s.id
  })
}

/** A whole shift: open, trade, close — then moved `daysAgo` business days into the past. */
async function pastShift(user: string, daysAgo: number, trade: () => Promise<unknown>) {
  const shift = await db.openCounter(user)
  await trade()
  await db.rpc(user, 'close_counter')
  if (daysAgo > 0) {
    const args = [shift.id, daysAgo]
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
  return shift.id
}

const today = async () => (await db.one<{ d: string }>(`select public.get_current_business_date()::text as d`)).d
const minus = async (d: string, n: number) => (await db.one<{ d: string }>(`select ($1::date - $2::int)::text d`, [d, n])).d
const count = async (table: string) => (await db.one<{ n: number }>(`select count(*)::int n from public.${table}`)).n

describe('close day', () => {
  it('finalises the day’s summary and deletes nothing', async () => {
    await db.openCounter(cashier.id)
    await sell(cashier.id, 'cash', 2) // 140
    await sell(cashier.id, 'bank_transfer', 1) // 70
    await tableSale(cashier.id) // 300 cash
    await db.rpc(cashier.id, 'add_expense', { p_client_ref: randomUUID(), p_amount: 50, p_description: 'Ice' })
    await db.rpc(cashier.id, 'close_counter')
    const date = await today()

    const result = await db.rpc<CloseResult>(admin.id, 'close_business_day', { p_business_date: date })
    expect(result.summary).toMatchObject({ total_cash: 440, total_bank: 70, total_sales: 510, expenses: 50, net_amount: 460, invoice_count: 3 })
    expect(result.summary.closed_at).toBeTruthy()
    expect(result.staff.map((s) => [s.user_id, s.total])).toEqual([[cashier.id, 510]])
    // Every record is still there.
    expect(await count('sales')).toBe(3)
    expect(await count('sale_items')).toBe(2)
    expect(await count('counter_shifts')).toBe(1)
    expect(await count('expenses')).toBe(1)
    const sessions = await db.sql<{ status: string }>(`select status from public.sessions`)
    expect(sessions).toEqual([{ status: 'completed' }])
    expect(await db.rpcRows(admin.id, 'list_open_business_dates')).toHaveLength(0)
  })

  it('refuses while a counter that traded that day is still open', async () => {
    await db.openCounter(cashier.id)
    await sell(cashier.id, 'cash', 1)
    const date = await today()
    const err = await rejects(db.rpc(admin.id, 'close_business_day', { p_business_date: date }))
    expect(err.hint).toBe('counters_open')
    expect(err.message).toContain('staff ')
    const [listed] = await db.rpcRows<{ open_counters: number }>(admin.id, 'list_open_business_dates')
    expect(listed!.open_counters).toBe(1)
  })

  it('closing again after late trading refreshes the summary without double counting', async () => {
    const date = await today()
    await pastShift(cashier.id, 0, () => sell(cashier.id, 'cash', 2)) // 140
    await db.rpc(admin.id, 'close_business_day', { p_business_date: date })
    await pastShift(other.id, 0, () => sell(other.id, 'bank_transfer', 1)) // +70 later the same day
    const [changed] = await db.rpcRows<{ changed_since_close: boolean; total_sales: number }>(admin.id, 'list_open_business_dates')
    expect(changed!.changed_since_close).toBe(true)
    expect(Number(changed!.total_sales)).toBe(210)
    const again = await db.rpc<CloseResult>(admin.id, 'close_business_day', { p_business_date: date })
    expect(again.summary).toMatchObject({ total_cash: 140, total_bank: 70, total_sales: 210 })
    const third = await db.rpc<CloseResult>(admin.id, 'close_business_day', { p_business_date: date })
    expect(third.summary.total_sales).toBe(210)
    expect(await count('daily_summaries')).toBe(1)
  })

  it('is admin only and refuses future or empty dates', async () => {
    const date = await today()
    expect((await rejects(db.rpc(cashier.id, 'close_business_day', { p_business_date: date }))).hint).toBe('forbidden')
    const future = await rejects(db.rpc(admin.id, 'close_business_day', { p_business_date: await minus(date, -2) }))
    expect(future.hint).toBe('invalid_input')
    const empty = await rejects(db.rpc(admin.id, 'close_business_day', { p_business_date: '2020-01-01' }))
    expect(empty.hint).toBe('nothing_to_close')
  })
})

describe('history', () => {
  it('Today, Weekly, Monthly and Custom ranges return exact figures', async () => {
    const d = await today()
    const shiftToday = await pastShift(cashier.id, 0, () => sell(cashier.id, 'cash', 2)) // 140 cash
    const shift3 = await pastShift(other.id, 3, async () => {
      await sell(other.id, 'bank_transfer', 1) // 70 bank
      await db.rpc(other.id, 'add_expense', { p_client_ref: randomUUID(), p_amount: 20, p_description: 'Water' })
    })
    const shift20 = await pastShift(cashier.id, 20, () => sell(cashier.id, 'cash', 3)) // 210 cash
    const history = (from: string, to: string) => db.rpc<History>(admin.id, 'get_history', { p_from: from, p_to: to })

    const todayView = await history(d, d)
    expect(todayView.totals).toMatchObject({ cash: 140, bank: 0, total: 140, snack: 140, expenses: 0, net: 140, invoices: 1 })
    expect(todayView.shifts.map((s) => s.id)).toEqual([shiftToday])

    const weekly = await history(await minus(d, 6), d)
    expect(weekly.totals).toMatchObject({ cash: 140, bank: 70, total: 210, expenses: 20, net: 190, invoices: 2 })
    expect(Object.fromEntries(weekly.by_staff.map((s) => [s.user_id, [s.total, s.expenses, s.net]]))).toEqual({
      [cashier.id]: [140, 0, 140],
      [other.id]: [70, 20, 50]
    })
    expect(weekly.days.map((x) => x.total)).toEqual([70, 140])

    const monthly = await history(await minus(d, 29), d)
    expect(monthly.totals).toMatchObject({ total: 420, net: 400, invoices: 3 })
    expect(monthly.shifts.map((s) => s.id).sort()).toEqual([shiftToday, shift3, shift20].sort())

    const custom = await history(await minus(d, 20), await minus(d, 20))
    expect(custom.totals).toMatchObject({ cash: 210, total: 210 })
    expect(custom.shifts.map((s) => [s.id, s.total, s.retained_invoices])).toEqual([[shift20, 210, 1]])
    expect((await rejects(history(d, await minus(d, 1)))).hint).toBe('invalid_input')
  })
})

describe('business date', () => {
  it('uses the club timezone and day-start hour', async () => {
    const at = (ts: string) => db.one<{ d: string }>(`select public.fusion_business_date($1::timestamptz)::text d`, [ts])
    // 20:30 UTC = 01:30 next day in Karachi (UTC+5).
    expect((await at('2026-03-10T20:30:00Z')).d).toBe('2026-03-11')
    await db.sql(`update public.settings set day_start_hour = 6`)
    expect((await at('2026-03-10T20:30:00Z')).d).toBe('2026-03-10')
    expect((await at('2026-03-11T01:00:00Z')).d).toBe('2026-03-11') // 06:00 local
  })
})
