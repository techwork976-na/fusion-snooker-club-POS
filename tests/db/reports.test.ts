/**
 * Reports, business expenses and inventory sales/profit (migration 0900).
 * Final figures come only from closed counters; business expenses never touch
 * a counter or History; product profit uses the cost recorded at each sale.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

type Money = Record<string, number>
type ShiftRow = { id: string; staff_name: string; status: string; total: number; cash: number; bank: number; expenses: number; net: number; invoices: number; partial: boolean }
type Report = { final: Money; live: Money; by_staff: (Money & { name: string })[]; closed_shifts: ShiftRow[]; open_shifts: ShiftRow[]; days: (Money & { date: string })[]; club_name: string }
type ProductRow = { name: string; quantity: number; revenue: number; discount: number; net_revenue: number; cost: number; gross_profit: number | null; uncosted_quantity: number; avg_cost: number | null }
type Products = { products: ProductRow[]; totals: Money; tracking_since: string | null; cost_tracking_since: string | null }
type Expenses = { totals: Money; by_category: { category: string; total: number }[]; items: { id: string; kind: string; category: string; amount: number; recorded_by: string; voided_at: string | null }[] }

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let ali: TestUser
let sara: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin', { username: 'owner' })
  ali = await db.createUser('staff', { floorId: null, permissions: ['counter_sale', 'apply_discount', 'delete_sales'] })
  sara = await db.createUser('staff', { floorId: null, permissions: ['counter_sale'] })
})
afterEach(async () => db.close())

const today = async () => (await db.one<{ d: string }>(`select public.get_current_business_date()::text as d`)).d
const minus = async (d: string, n: number) => (await db.one<{ d: string }>(`select ($1::date - $2::int)::text d`, [d, n])).d

const sell = (user: string, items: [string, number, number][], opts: { method?: string; discount?: number } = {}) =>
  db.rpc<{ sale_id: string }>(user, 'complete_checkout', {
    p_client_ref: randomUUID(),
    p_payment_method: opts.method ?? 'cash',
    p_items: items.map(([product_id, quantity, unit_price]) => ({ product_id, quantity, unit_price })),
    p_discount: opts.discount ?? 0
  })
const report = (from: string, to: string) => db.rpc<Report>(admin.id, 'get_financial_report', { p_from: from, p_to: to })
const productSales = (from: string, to: string) => db.rpc<Products>(admin.id, 'get_product_sales', { p_from: from, p_to: to })
const expenses = (from: string, to: string) => db.rpc<Expenses>(admin.id, 'get_expenses', { p_from: from, p_to: to })
const addBusinessExpense = (args: { date: string; category: string; amount: number; description: string; ref?: string }, user = admin.id) =>
  db.rpc<{ id: string; shift_id: string | null }>(user, 'admin_add_expense', {
    p_client_ref: args.ref ?? randomUUID(),
    p_business_date: args.date,
    p_category: args.category,
    p_amount: args.amount,
    p_description: args.description
  })

describe('financial report', () => {
  it('reports closed counters as final and open counters separately as live', async () => {
    const d = await today()
    await db.openCounter(ali.id)
    await sell(ali.id, [[club.products.tea, 2, 70]]) // 140 cash
    await sell(ali.id, [[club.products.cola, 1, 100]], { method: 'bank_transfer' }) // 100 bank
    await db.rpc(ali.id, 'add_expense', { p_client_ref: randomUUID(), p_amount: 30, p_description: 'Milk' })
    await db.rpc(ali.id, 'close_counter')
    await db.openCounter(sara.id)
    await sell(sara.id, [[club.products.tea, 1, 70]]) // still open

    const r = await report(d, d)
    expect(r.final).toMatchObject({ cash: 140, bank: 100, total: 240, snack: 240, counter_expenses: 30, business_expenses: 0, expenses: 30, net: 210, invoices: 2, shifts: 1 })
    expect(r.live).toMatchObject({ total: 70, cash: 70, invoices: 1, shifts: 1 })
    expect(r.by_staff).toHaveLength(1)
    expect(r.by_staff[0]).toMatchObject({ total: 240, shifts: 1, expenses: 30, net: 210 })
    expect(r.closed_shifts.map((s) => [s.status, s.total, s.net, s.partial])).toEqual([['closed', 240, 210, false]])
    expect(r.open_shifts.map((s) => [s.status, s.total])).toEqual([['open', 70]])
    expect(r.days).toEqual([{ date: d, cash: 140, bank: 100, total: 240, expenses: 30, net: 210 }])

    // Final + live always equals the History page's total for the same dates.
    const history = await db.rpc<{ totals: Money }>(admin.id, 'get_history', { p_from: d, p_to: d })
    expect(r.final.total! + r.live.total!).toBe(history.totals.total)
    expect(r.final.counter_expenses! + r.live.expenses!).toBe(history.totals.expenses)
  })

  it('counts a shift only for the dates in the range and marks a shift that crosses it', async () => {
    const d = await today()
    const y = await minus(d, 1)
    const shift = await db.openCounter(ali.id)
    await sell(ali.id, [[club.products.tea, 1, 70]])
    // The first sale belongs to yesterday's business day (e.g. before the day start).
    await db.sql(`update public.sales set business_date = $2 where shift_id = $1`, [shift.id, y])
    await db.sql(`update public.shift_daily_totals set business_date = $2 where shift_id = $1`, [shift.id, y])
    await sell(ali.id, [[club.products.tea, 2, 70]]) // today: 140
    await db.rpc(ali.id, 'close_counter')

    const onlyToday = await report(d, d)
    expect(onlyToday.final).toMatchObject({ total: 140, shifts: 1 })
    expect(onlyToday.closed_shifts[0]).toMatchObject({ total: 140, partial: true })
    const onlyYesterday = await report(y, y)
    expect(onlyYesterday.final).toMatchObject({ total: 70, shifts: 1 })
    const both = await report(y, d)
    expect(both.final).toMatchObject({ total: 210, shifts: 1 })
    expect(both.closed_shifts[0]).toMatchObject({ total: 210, partial: false })
    expect(both.days.map((x) => [x.date, x.total])).toEqual([
      [y, 70],
      [d, 140]
    ])
  })

  it('is admin-only and validates the range', async () => {
    const d = await today()
    expect((await rejects(db.rpc(ali.id, 'get_financial_report', { p_from: d, p_to: d }))).hint).toBe('forbidden')
    expect((await rejects(db.rpc(ali.id, 'get_product_sales', { p_from: d, p_to: d }))).hint).toBe('forbidden')
    expect((await rejects(db.rpc(ali.id, 'get_expenses', { p_from: d, p_to: d }))).hint).toBe('forbidden')
    expect((await rejects(report(d, await minus(d, 1)))).hint).toBe('invalid_input')
    expect((await rejects(report(await minus(d, 400), d))).hint).toBe('invalid_input')
    // Not callable at all without signing in.
    expect((await rejects(db.rpc(null, 'get_financial_report', { p_from: d, p_to: d }))).message).toMatch(/permission denied/)
  })
})

describe('business expenses', () => {
  it('are admin-only, validated and idempotent', async () => {
    const d = await today()
    expect((await rejects(addBusinessExpense({ date: d, category: 'rent', amount: 100, description: 'x' }, ali.id))).hint).toBe('forbidden')
    const tomorrow = await minus(d, -1)
    expect((await rejects(addBusinessExpense({ date: tomorrow, category: 'rent', amount: 100, description: 'Rent' }))).hint).toBe('invalid_input')
    expect((await rejects(addBusinessExpense({ date: d, category: 'salary', amount: 100, description: 'Pay' }))).hint).toBe('invalid_input')
    expect((await rejects(addBusinessExpense({ date: d, category: 'rent', amount: 0, description: 'Rent' }))).hint).toBe('invalid_input')
    expect((await rejects(addBusinessExpense({ date: d, category: 'rent', amount: 10.005, description: 'Rent' }))).hint).toBe('invalid_input')
    expect((await rejects(addBusinessExpense({ date: d, category: 'rent', amount: 100, description: '  ' }))).hint).toBe('invalid_input')

    const ref = randomUUID()
    const first = await addBusinessExpense({ date: d, category: 'rent', amount: 5000, description: 'November rent', ref })
    const again = await addBusinessExpense({ date: d, category: 'rent', amount: 5000, description: 'November rent', ref })
    expect(again.id).toBe(first.id)
    expect(first.shift_id).toBeNull()
    expect((await expenses(d, d)).totals).toMatchObject({ total: 5000, business: 5000, count: 1 })
  })

  it('never change a counter, the shift ledger or History, but count in Reports', async () => {
    const d = await today()
    const y = await minus(d, 1)
    await db.openCounter(ali.id)
    await sell(ali.id, [[club.products.tea, 1, 70]])
    const counterExpense = await db.rpc<{ id: string }>(ali.id, 'add_expense', { p_client_ref: randomUUID(), p_amount: 30, p_description: 'Milk' })
    const historyBefore = await db.rpc<{ totals: Money; by_staff: unknown[] }>(admin.id, 'get_history', { p_from: y, p_to: d })
    const counterBefore = await db.rpc<{ shift: Money }>(ali.id, 'get_my_counter')

    const rent = await addBusinessExpense({ date: d, category: 'rent', amount: 5000, description: 'November rent' })
    await addBusinessExpense({ date: y, category: 'utilities', amount: 1200, description: 'Electricity' })

    expect(await db.rpc(admin.id, 'get_history', { p_from: y, p_to: d })).toMatchObject({ totals: historyBefore.totals, by_staff: historyBefore.by_staff })
    expect((await db.rpc<{ shift: Money }>(ali.id, 'get_my_counter')).shift).toEqual(counterBefore.shift)

    const list = await expenses(y, d)
    expect(list.totals).toMatchObject({ total: 6230, business: 6200, counter: 30, count: 3, voided_count: 0 })
    expect(list.by_category).toEqual([
      { category: 'rent', total: 5000, count: 1 },
      { category: 'utilities', total: 1200, count: 1 },
      { category: 'counter', total: 30, count: 1 }
    ])
    // Newest first: today's rent, today's counter expense, yesterday's electricity.
    expect(list.items.map((i) => [i.kind, i.category, i.amount, i.recorded_by])).toEqual([
      ['business', 'rent', 5000, `admin ${admin.username}`],
      ['counter', 'counter', 30, `staff ${ali.username}`],
      ['business', 'utilities', 1200, `admin ${admin.username}`]
    ])

    // Staff can read only their own expenses; business expenses stay private.
    const staffView = await db.as(ali.id, () => db.pg.query(`select id from public.expenses`).then((r) => r.rows))
    expect(staffView).toEqual([{ id: counterExpense.id }])

    await db.rpc(ali.id, 'close_counter')
    const r = await report(y, d)
    expect(r.final).toMatchObject({ total: 70, counter_expenses: 30, business_expenses: 6200, expenses: 6230, net: -6160 })

    // Voiding keeps the record; counter expenses are voided from their counter only.
    await db.rpc(admin.id, 'admin_void_expense', { p_expense_id: rent.id })
    await db.rpc(admin.id, 'admin_void_expense', { p_expense_id: rent.id }) // idempotent
    expect((await expenses(y, d)).totals).toMatchObject({ total: 1230, business: 1200, voided_count: 1 })
    expect((await report(y, d)).final).toMatchObject({ business_expenses: 1200 })
    expect((await rejects(db.rpc(admin.id, 'admin_void_expense', { p_expense_id: counterExpense.id }))).hint).toBe('invalid_state')
    expect((await rejects(db.rpc(ali.id, 'admin_void_expense', { p_expense_id: rent.id }))).hint).toBe('forbidden')
  })
})

describe('inventory sales and profit', () => {
  it('uses the cost at the time of sale, shares discounts pro rata and excludes table time', async () => {
    const d = await today()
    await db.openCounter(ali.id)
    // Counter sale: 2 cola (200) + 1 tea (70), PKR 27 off → cola carries 20, tea 7.
    const first = await sell(ali.id, [[club.products.cola, 2, 100], [club.products.tea, 1, 70]], { discount: 27 })
    // The cola's cost rises afterwards; the earlier sale keeps its cost of 60.
    await db.sql(`update public.inventory_products set cost_price = 80 where id = $1`, [club.products.cola])
    // A table: 30 min of snooker (300) with a cola on the tab (100), PKR 40 off → the cola carries 10.
    const s = await db.rpc<{ id: string }>(ali.id, 'start_session', { p_table_id: club.tables.snooker1 })
    await db.rpc(ali.id, 'add_session_item', { p_session_id: s.id, p_product_id: club.products.cola })
    await db.ageSession(s.id, 30 * 60)
    await db.rpc(ali.id, 'end_session', { p_session_id: s.id })
    await db.rpc(ali.id, 'complete_checkout', { p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: s.id, p_discount: 40 })

    const costs = await db.sql<{ unit_cost: string }>(`select unit_cost::text from public.sale_items where product_id = $1 order by unit_cost`, [club.products.cola])
    expect(costs.map((c) => c.unit_cost)).toEqual(['60.00', '80.00'])

    const p = await productSales(d, d)
    const byName = Object.fromEntries(p.products.map((x) => [x.name, x]))
    expect(byName.Cola).toMatchObject({ quantity: 3, revenue: 300, discount: 30, net_revenue: 270, cost: 200, gross_profit: 70, uncosted_quantity: 0, avg_cost: 66.67 })
    expect(byName.Tea).toMatchObject({ quantity: 1, revenue: 70, discount: 7, net_revenue: 63, cost: 20, gross_profit: 43 })
    expect(p.totals).toMatchObject({ quantity: 4, revenue: 370, discount: 37, net_revenue: 333, cost: 220, gross_profit: 113 })
    // Product revenue is exactly the ledger's snack sales — table time is not included.
    const ledger = await db.one<{ snack: number }>(`select sum(snack_sales)::float as snack from public.shift_daily_totals`)
    expect(p.totals.revenue).toBe(ledger.snack)

    // Deleting a sale takes exactly its lines back out.
    await db.rpc(ali.id, 'delete_sale', { p_sale_id: first.sale_id })
    const after = await productSales(d, d)
    expect(after.products.map((x) => [x.name, x.quantity, x.revenue, x.discount, x.cost, x.gross_profit])).toEqual([['Cola', 1, 100, 10, 80, 10]])
    const ledgerAfter = await db.one<{ snack: number }>(`select sum(snack_sales)::float as snack from public.shift_daily_totals`)
    expect(after.totals.revenue).toBe(ledgerAfter.snack)
  })
})

describe('upgrading to product tracking', () => {
  it('fills product sales from the remaining invoice lines without inventing costs', async () => {
    await db.close()
    db = await TestDb.create({ stopBefore: '20261103000900' })
    club = await seedClub(db)
    admin = await db.createUser('admin')
    ali = await db.createUser('staff', { floorId: null, permissions: ['counter_sale'] })
    await db.openCounter(ali.id)
    await sell(ali.id, [[club.products.cola, 2, 100]])
    await sell(ali.id, [[club.products.tea, 1, 70]])
    const expensesBefore = await db.sql(`select * from public.expenses`)
    await db.migrateRest()

    const d = await today()
    const p = await productSales(d, d)
    expect(p.products.map((x) => [x.name, x.quantity, x.revenue, x.uncosted_quantity, x.gross_profit])).toEqual([
      ['Cola', 2, 200, 2, null],
      ['Tea', 1, 70, 1, null]
    ])
    expect(p.cost_tracking_since).toBeNull()
    expect(await db.sql(`select * from public.expenses`)).toEqual(expensesBefore)

    // Sales after the upgrade record their cost.
    await sell(ali.id, [[club.products.cola, 1, 100]])
    const after = await productSales(d, d)
    expect(after.products.find((x) => x.name === 'Cola')).toMatchObject({ quantity: 3, uncosted_quantity: 2, cost: 60, gross_profit: 40 })
    expect(after.cost_tracking_since).toBe(d)
  })
})
