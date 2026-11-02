/**
 * Counter shifts and staff-wise accounting: isolation between staff members,
 * live admin figures, closing, voids, expenses and session handover.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

type Shift = {
  id: string
  user_id: string
  status: 'open' | 'closed'
  cash: number
  bank: number
  snack: number
  total: number
  expenses: number
  net: number
  invoices: number
  voided_count: number
  voided_amount: number
  open_sessions: number
  handover_sessions: number
  opened_at: string
  closed_at: string | null
}
type StaffRow = { user_id: string; name: string; status: 'open' | 'closed'; cash: number; bank: number; snack: number; total: number; expenses: number; net: number; invoices: number }
type Dashboard = { today: { cash: number; bank: number; total: number; snack: number; expenses: number; net: number; count: number }; staff: StaffRow[] }

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let staffA: TestUser
let staffB: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  staffA = await db.createUser('staff', {
    username: 'staff.a',
    floorId: club.floors.ground,
    permissions: ['counter_sale', 'view_own_sales', 'delete_sales', 'apply_discount']
  })
  staffB = await db.createUser('staff', {
    username: 'staff.b',
    floorId: club.floors.first,
    permissions: ['counter_sale', 'view_own_sales', 'delete_sales']
  })
})
afterEach(async () => db.close())

/** A counter sale of `qty` teas (PKR 70 each). */
const sellTea = (user: string, method: 'cash' | 'bank_transfer', qty = 1, ref = randomUUID()) =>
  db.rpc<{ sale_id: string; final_amount: number }>(user, 'complete_checkout', {
    p_client_ref: ref,
    p_payment_method: method,
    p_items: [{ product_id: club.products.tea, quantity: qty, unit_price: 70 }]
  })

/** A table session (PKR 10/min snooker or 7.50/min pool) of `seconds`, with optional tab items. */
async function tableSale(user: string, table: string, seconds: number, method: 'cash' | 'bank_transfer', cola = 0) {
  const s = await db.rpc<{ id: string }>(user, 'start_session', { p_table_id: table })
  if (cola) await db.rpc(user, 'add_session_item', { p_session_id: s.id, p_product_id: club.products.cola, p_quantity: cola })
  await db.ageSession(s.id, seconds)
  await db.rpc(user, 'end_session', { p_session_id: s.id })
  return db.rpc<{ sale_id: string; final_amount: number }>(user, 'complete_checkout', {
    p_client_ref: randomUUID(),
    p_payment_method: method,
    p_session_id: s.id
  })
}

const addExpense = (user: string, amount: number, description = 'Milk') =>
  db.rpc<{ id: string }>(user, 'add_expense', { p_client_ref: randomUUID(), p_amount: amount, p_description: description })
const counter = (user: string) => db.rpc<{ shift: Shift | null; expenses: { id: string }[]; recent: Shift[] }>(user, 'get_my_counter')
const select = (user: string, query: string) => db.as(user, () => db.pg.query(query).then((r) => r.rows))

describe('opening counters', () => {
  it('each staff member opens their own counter; a second open returns the same shift', async () => {
    const a1 = await db.openCounter(staffA.id)
    const a2 = await db.openCounter(staffA.id)
    const b = await db.openCounter(staffB.id)
    expect(a2.id).toBe(a1.id)
    expect(b.id).not.toBe(a1.id)
    const [n] = await db.sql<{ n: number }>(`select count(*)::int n from public.counter_shifts where status = 'open'`)
    expect(n!.n).toBe(2)
    // The database itself forbids two open counters for one person.
    const err = await rejects(
      db.sql(`insert into public.counter_shifts (user_id, staff_name, business_date) values ($1, 'x', current_date)`, [staffA.id])
    )
    expect(err.message).toMatch(/counter_shifts_one_open_per_user/)
  })

  it('payments and expenses need an open counter', async () => {
    expect((await rejects(sellTea(staffA.id, 'cash'))).hint).toBe('counter_closed')
    expect((await rejects(addExpense(staffA.id, 50))).hint).toBe('counter_closed')
  })

  it('admins cannot open a counter, take payments or record counter expenses', async () => {
    expect((await rejects(db.openCounter(admin.id))).hint).toBe('admin_no_sales')
    expect((await rejects(sellTea(admin.id, 'cash'))).hint).toBe('admin_no_sales')
    expect((await rejects(addExpense(admin.id, 10))).hint).toBe('admin_no_sales')
    // Even a table the admin started must be paid at a staff counter.
    const s = await db.rpc<{ id: string }>(admin.id, 'start_session', { p_table_id: club.tables.snooker1 })
    await db.rpc(admin.id, 'end_session', { p_session_id: s.id })
    const err = await rejects(
      db.rpc(admin.id, 'complete_checkout', { p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: s.id })
    )
    expect(err.hint).toBe('admin_no_sales')
    await db.openCounter(staffA.id)
    const paid = await db.rpc<{ final_amount: number }>(staffA.id, 'complete_checkout', {
      p_client_ref: randomUUID(),
      p_payment_method: 'cash',
      p_session_id: s.id
    })
    expect(paid.final_amount).toBe(0)
  })
})

describe('staff-wise accounting', () => {
  it('keeps two counters separate and the admin sees both live', async () => {
    await db.openCounter(staffA.id)
    await db.openCounter(staffB.id)

    // Staff A: snooker 30 min (PKR 300) + 2 colas (PKR 200) by cash; 2 teas by bank (PKR 140).
    await tableSale(staffA.id, club.tables.snooker1, 1800, 'cash', 2)
    await sellTea(staffA.id, 'bank_transfer', 2)
    await addExpense(staffA.id, 120, 'Cleaning')
    // Staff B: pool 1 hour (PKR 450) by bank, 1 tea cash (PKR 70).
    await tableSale(staffB.id, club.tables.pool1, 3600, 'bank_transfer')
    await sellTea(staffB.id, 'cash', 1)

    const a = (await counter(staffA.id)).shift!
    expect(a).toMatchObject({ status: 'open', cash: 500, bank: 140, total: 640, snack: 340, expenses: 120, net: 520, invoices: 2 })
    const b = (await counter(staffB.id)).shift!
    expect(b).toMatchObject({ cash: 70, bank: 450, total: 520, snack: 70, expenses: 0, net: 520, invoices: 2 })

    const dash = await db.rpc<Dashboard>(admin.id, 'get_dashboard')
    const rows = Object.fromEntries(dash.staff.map((r) => [r.user_id, r]))
    expect(rows[staffA.id]).toMatchObject({ status: 'open', cash: 500, bank: 140, total: 640, snack: 340, expenses: 120, net: 520, invoices: 2 })
    expect(rows[staffB.id]).toMatchObject({ status: 'open', cash: 70, bank: 450, total: 520, snack: 70, expenses: 0, net: 520 })
    // Business-wide totals are exactly the sum of the staff rows; snacks are not added twice.
    expect(dash.today).toMatchObject({ cash: 570, bank: 590, total: 1160, snack: 410, expenses: 120, net: 1040, count: 4 })
  })

  it('staff can never read or change another staff member’s accounting', async () => {
    await db.openCounter(staffA.id)
    const shiftB = await db.openCounter(staffB.id)
    const saleB = await sellTea(staffB.id, 'cash', 1)
    const expenseB = await addExpense(staffB.id, 30)
    await sellTea(staffA.id, 'cash', 1)

    // Even a raw query returns only A's own rows (Row Level Security), while the admin sees both.
    for (const table of ['counter_shifts', 'shift_daily_totals', 'expenses', 'sales']) {
      const owner = table === 'sales' ? 'cashier_id' : 'user_id'
      const mine = await select(staffA.id, `select ${owner} as owner from public.${table}`)
      expect(mine.every((r) => (r as { owner: string }).owner === staffA.id)).toBe(true)
      const all = await select(admin.id, `select ${owner} as owner from public.${table}`)
      expect(all.some((r) => (r as { owner: string }).owner === staffB.id)).toBe(true)
    }
    expect((await rejects(db.rpc(staffA.id, 'get_shift_detail', { p_shift_id: shiftB.id }))).hint).toBe('not_found')
    expect((await rejects(db.rpc(staffA.id, 'get_receipt', { p_sale_id: saleB.sale_id }))).hint).toBe('not_found')
    expect((await rejects(db.rpc(staffA.id, 'delete_sale', { p_sale_id: saleB.sale_id }))).hint).toBe('forbidden')
    expect((await rejects(db.rpc(staffA.id, 'void_expense', { p_expense_id: expenseB.id }))).hint).toBe('not_found')
    expect((await rejects(db.rpc(staffA.id, 'close_counter', { p_shift_id: shiftB.id }))).hint).toBe('not_found')
    expect((await rejects(db.rpc(staffA.id, 'get_history', { p_from: '2026-01-01', p_to: '2026-01-02' }))).hint).toBe('forbidden')
    // B's figures are untouched.
    expect((await counter(staffB.id)).shift).toMatchObject({ cash: 70, expenses: 30, net: 40 })
  })

  it('a closed shift keeps its final figures while the other counter keeps trading', async () => {
    await db.openCounter(staffA.id)
    await db.openCounter(staffB.id)
    await sellTea(staffA.id, 'cash', 2)
    await addExpense(staffA.id, 40)
    const closed = await db.rpc<Shift>(staffA.id, 'close_counter')
    expect(closed).toMatchObject({ status: 'closed', cash: 140, expenses: 40, net: 100 })
    expect(closed.closed_at).not.toBeNull()

    await sellTea(staffB.id, 'bank_transfer', 3)
    const dash = await db.rpc<Dashboard>(admin.id, 'get_dashboard')
    const rows = Object.fromEntries(dash.staff.map((r) => [r.user_id, r]))
    expect(rows[staffA.id]).toMatchObject({ status: 'closed', cash: 140, expenses: 40, net: 100 })
    expect(rows[staffB.id]).toMatchObject({ status: 'open', bank: 210 })
    expect(dash.today.total).toBe(350)

    // The closed shift is history now: no more payments, voids or expenses on it.
    const detail = await db.rpc<Shift>(admin.id, 'get_shift_detail', { p_shift_id: closed.id })
    expect(detail).toMatchObject({ status: 'closed', cash: 140, expenses: 40, net: 100 })
    expect((await counter(staffA.id)).recent.map((s) => s.id)).toEqual([closed.id])
    expect((await rejects(sellTea(staffA.id, 'cash'))).hint).toBe('counter_closed')
  })

  it('a new shift after closing starts from zero', async () => {
    await db.openCounter(staffA.id)
    await sellTea(staffA.id, 'cash', 1)
    await db.rpc(staffA.id, 'close_counter')
    const next = await db.openCounter(staffA.id)
    expect((await counter(staffA.id)).shift).toMatchObject({ id: next.id, total: 0, invoices: 0 })
    // Today's admin figure still includes the first shift (no double count, nothing lost).
    await sellTea(staffA.id, 'bank_transfer', 1)
    const dash = await db.rpc<Dashboard>(admin.id, 'get_dashboard')
    expect(dash.staff.find((r) => r.user_id === staffA.id)).toMatchObject({ status: 'open', cash: 70, bank: 70, total: 140 })
  })
})

describe('voids, expenses and retries', () => {
  it('voiding a sale reverses it once; a closed shift cannot be changed', async () => {
    await db.openCounter(staffA.id)
    const keep = await sellTea(staffA.id, 'cash', 1)
    const voidMe = await tableSale(staffA.id, club.tables.snooker1, 1800, 'bank_transfer', 1)
    await db.rpc(staffA.id, 'delete_sale', { p_sale_id: voidMe.sale_id })
    expect((await rejects(db.rpc(staffA.id, 'delete_sale', { p_sale_id: voidMe.sale_id }))).hint).toBe('not_found')
    const shift = (await counter(staffA.id)).shift!
    expect(shift).toMatchObject({ cash: 70, bank: 0, snack: 70, invoices: 1, voided_count: 1, voided_amount: 400 })

    await db.rpc(staffA.id, 'close_counter')
    expect((await rejects(db.rpc(staffA.id, 'delete_sale', { p_sale_id: keep.sale_id }))).hint).toBe('shift_closed')
    expect((await rejects(db.rpc(admin.id, 'delete_sale', { p_sale_id: keep.sale_id }))).hint).toBe('shift_closed')
  })

  it('expenses reduce net, can be voided while open, and are kept for the audit trail', async () => {
    await db.openCounter(staffA.id)
    await sellTea(staffA.id, 'cash', 5) // 350
    const e1 = await addExpense(staffA.id, 100, 'Ice')
    await addExpense(staffA.id, 25.5, 'Tissues')
    expect((await counter(staffA.id)).shift).toMatchObject({ total: 350, expenses: 125.5, net: 224.5 })
    await db.rpc(staffA.id, 'void_expense', { p_expense_id: e1.id })
    await db.rpc(staffA.id, 'void_expense', { p_expense_id: e1.id }) // repeat: no further change
    expect((await counter(staffA.id)).shift).toMatchObject({ expenses: 25.5, net: 324.5 })
    const [kept] = await db.sql<{ n: number }>(`select count(*)::int n from public.expenses where voided_at is not null`)
    expect(kept!.n).toBe(1)
    expect((await rejects(addExpense(staffA.id, 0))).hint).toBe('invalid_input')
    expect((await rejects(addExpense(staffA.id, 10, '  '))).hint).toBe('invalid_input')
  })

  it('retrying a payment or an expense with the same reference never posts twice', async () => {
    await db.openCounter(staffA.id)
    const ref = randomUUID()
    const first = await sellTea(staffA.id, 'cash', 1, ref)
    const again = await sellTea(staffA.id, 'cash', 1, ref)
    expect(again.sale_id).toBe(first.sale_id)
    const expenseRef = randomUUID()
    await db.rpc(staffA.id, 'add_expense', { p_client_ref: expenseRef, p_amount: 20, p_description: 'Water' })
    await db.rpc(staffA.id, 'add_expense', { p_client_ref: expenseRef, p_amount: 20, p_description: 'Water' })
    expect((await counter(staffA.id)).shift).toMatchObject({ cash: 70, invoices: 1, expenses: 20 })
    // A payment that fails half way (insufficient stock) posts nothing.
    await rejects(
      db.rpc(staffA.id, 'complete_checkout', {
        p_client_ref: randomUUID(),
        p_payment_method: 'cash',
        p_items: [{ product_id: club.products.chips, quantity: 99, unit_price: 50 }]
      })
    )
    expect((await counter(staffA.id)).shift).toMatchObject({ cash: 70, invoices: 1 })
  })

  it('shift totals always equal the ledger and the invoices', async () => {
    await db.openCounter(staffA.id)
    for (let i = 0; i < 6; i++) await sellTea(staffA.id, i % 2 ? 'cash' : 'bank_transfer', i + 1)
    const v = await sellTea(staffA.id, 'cash', 2)
    await db.rpc(staffA.id, 'delete_sale', { p_sale_id: v.sale_id })
    const [check] = await db.sql<{ ok: boolean }>(`
      select (c.cash_sales, c.bank_sales, c.snack_sales, c.invoice_count) =
             (select coalesce(sum(final_amount) filter (where payment_method = 'cash'), 0),
                     coalesce(sum(final_amount) filter (where payment_method = 'bank_transfer'), 0),
                     coalesce(sum(products_subtotal), 0), count(*)::int
              from public.sales s where s.shift_id = c.id)
         and (c.cash_sales, c.bank_sales, c.invoice_count) =
             (select sum(cash_sales), sum(bank_sales), sum(invoice_count)::int from public.shift_daily_totals t where t.shift_id = c.id)
         as ok
      from public.counter_shifts c`)
    expect(check!.ok).toBe(true)
  })
})

describe('closing a counter with tables still in play', () => {
  it('needs an explicit handover; the payment is then recorded once, by the counter that takes it', async () => {
    // 30-minute blocks keep the charge exact however long the steps below take.
    await db.sql(`update public.settings set billing_increment_minutes = 30`)
    await db.openCounter(staffA.id)
    const s = await db.rpc<{ id: string }>(staffA.id, 'start_session', { p_table_id: club.tables.snooker1 })
    expect((await counter(staffA.id)).shift!.open_sessions).toBe(1)
    expect((await rejects(db.rpc(staffA.id, 'close_counter'))).hint).toBe('sessions_open')
    const closed = await db.rpc<Shift>(staffA.id, 'close_counter', { p_handover: true })
    expect(closed).toMatchObject({ status: 'closed', handover_sessions: 1, total: 0 })

    // Another Ground-floor staff member takes over and is paid.
    const relief = await db.createUser('staff', { floorId: club.floors.ground })
    await db.openCounter(relief.id)
    await db.ageSession(s.id, 1500)
    await db.rpc(relief.id, 'end_session', { p_session_id: s.id })
    await db.rpc(relief.id, 'complete_checkout', { p_client_ref: randomUUID(), p_payment_method: 'cash', p_session_id: s.id })
    expect((await counter(relief.id)).shift).toMatchObject({ cash: 300 })
    expect((await db.rpc<Shift>(admin.id, 'get_shift_detail', { p_shift_id: closed.id })).total).toBe(0)
    const dash = await db.rpc<Dashboard>(admin.id, 'get_dashboard')
    expect(dash.today.total).toBe(300)
  })

  it('an admin can close a staff counter that was left open', async () => {
    const shift = await db.openCounter(staffA.id)
    await sellTea(staffA.id, 'cash', 1)
    const closed = await db.rpc<Shift & { closed_by_self: boolean }>(admin.id, 'close_counter', { p_shift_id: shift.id })
    expect(closed).toMatchObject({ status: 'closed', cash: 70, closed_by_self: false })
    expect((await rejects(db.rpc(admin.id, 'close_counter', { p_shift_id: shift.id }))).hint).toBe('already_closed')
  })
})
