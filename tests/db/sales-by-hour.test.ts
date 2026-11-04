/**
 * One business day hour by hour (migration 1600), for the History and Reports
 * charts of a single day. The hours come from the invoices and must add up to
 * the permanent ledger while the invoices are kept; Reports (closed only)
 * leaves out counters that are still open.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

type Hours = {
  date: string
  closed_only: boolean
  hours: { hour: number; cash: number; bank: number; total: number; invoices: number }[]
  day_start_hour: number
  covered_total: number
}
type Money = Record<string, number>

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let ali: TestUser
let sara: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  ali = await db.createUser('staff', { floorId: null, permissions: ['counter_sale', 'delete_sales'] })
  sara = await db.createUser('staff', { floorId: null, permissions: ['counter_sale'] })
})
afterEach(async () => db.close())

const today = async () => (await db.one<{ d: string }>(`select public.get_current_business_date()::text d`)).d
const sell = (user: string, quantity: number, method: 'cash' | 'bank_transfer' | 'split' = 'cash', extra: Record<string, unknown> = {}) =>
  db.rpc<{ sale_id: string }>(user, 'complete_checkout', {
    p_client_ref: randomUUID(),
    p_payment_method: method,
    p_items: [{ product_id: club.products.tea, quantity, unit_price: 70 }],
    p_discount: 0,
    ...extra
  })
/** Moves an invoice to a club hour of its business day (the club's time zone). */
const at = (saleId: string, hour: number) =>
  db.sql(
    `update public.sales s set created_at = ((s.business_date + make_interval(hours => $2))::timestamp at time zone st.business_timezone)
     from public.settings st where st.id = 1 and s.id = $1`,
    [saleId, hour]
  )
const hours = (date: string, closedOnly: boolean, user = admin.id) => db.rpc<Hours>(user, 'get_sales_by_hour', { p_date: date, p_closed_only: closedOnly })
const sum = (h: Hours) => h.hours.reduce((s, x) => s + Number(x.total), 0)

describe('sales by hour', () => {
  it('adds up to the ledger, hour by hour, with cash and bank (split payments in both)', async () => {
    const d = await today()
    await db.openCounter(ali.id)
    await at((await sell(ali.id, 2)).sale_id, 18) // 140 cash at 6 PM
    await at((await sell(ali.id, 1, 'bank_transfer')).sale_id, 18) // 70 bank at 6 PM
    await at((await sell(ali.id, 3, 'split', { p_split_cash: 100 })).sale_id, 21) // 210: 100 cash + 110 bank at 9 PM

    const h = await hours(d, false)
    expect(h.hours.map((x) => [x.hour, Number(x.cash), Number(x.bank), Number(x.total), x.invoices])).toEqual([
      [18, 140, 70, 210, 2],
      [21, 100, 110, 210, 1]
    ])
    const history = await db.rpc<{ totals: Money }>(admin.id, 'get_history', { p_from: d, p_to: d })
    expect(Number(h.covered_total)).toBe(420)
    expect(sum(h)).toBe(history.totals.total)
  })

  it('Reports (closed only) leaves out counters still open, matching its final figures', async () => {
    const d = await today()
    await db.openCounter(ali.id)
    await sell(ali.id, 2)
    await db.rpc(ali.id, 'close_counter')
    await db.openCounter(sara.id)
    await sell(sara.id, 1) // still open: live, not final

    const report = await db.rpc<{ final: Money; live: Money }>(admin.id, 'get_financial_report', { p_from: d, p_to: d })
    expect(sum(await hours(d, true))).toBe(report.final.total)
    expect(sum(await hours(d, false))).toBe(report.final.total! + report.live.total!)
  })

  it('a voided invoice leaves the hours, as it leaves the ledger', async () => {
    const d = await today()
    await db.openCounter(ali.id)
    await sell(ali.id, 2)
    const mistake = await sell(ali.id, 5)
    await db.rpc(ali.id, 'delete_sale', { p_sale_id: mistake.sale_id })
    const history = await db.rpc<{ totals: Money }>(admin.id, 'get_history', { p_from: d, p_to: d })
    expect([sum(await hours(d, false)), history.totals.total]).toEqual([140, 140])
  })

  it('says how much of the day it covers once old invoices are removed (the ledger keeps the total)', async () => {
    const d = await today()
    await db.openCounter(ali.id)
    await sell(ali.id, 2)
    const removed = await sell(ali.id, 1)
    await db.sql(`delete from public.sale_items where sale_id = $1`, [removed.sale_id])
    await db.sql(`delete from public.sales where id = $1`, [removed.sale_id]) // as the retention job does
    const history = await db.rpc<{ totals: Money }>(admin.id, 'get_history', { p_from: d, p_to: d })
    const h = await hours(d, false)
    expect([Number(h.covered_total), history.totals.total]).toEqual([140, 210])
  })

  it('is for administrators only and needs a day', async () => {
    const d = await today()
    expect((await rejects(hours(d, false, ali.id))).hint).toBe('forbidden')
    expect((await rejects(db.rpc(admin.id, 'get_sales_by_hour', { p_date: null }))).hint).toBe('invalid_input')
    expect(await hours(d, false)).toMatchObject({ hours: [], covered_total: 0, closed_only: false })
  })
})
