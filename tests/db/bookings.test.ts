/**
 * Admin pre-bookings, customer statistics and rankings, and safe deletion of
 * configuration records.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

type Booking = { id: string; status: string; session_id: string | null; booking_at: string; table_id: string | null; customer_id: string | null }
type Listed = Booking & { table_name: string | null; session_status: string | null; business_date: string }
type Ranking = { rank: number; id: string; name: string; phone: string | null; visits: number; invoices: number; play_seconds: number; spent: number; last_visit_at: string }

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let staff: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  staff = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['counter_sale', 'delete_sales'] })
})
afterEach(async () => db.close())

const today = async () => (await db.one<{ d: string }>(`select public.get_current_business_date()::text as d`)).d

const book = (args: Record<string, unknown>) =>
  db.rpc<Booking>(admin.id, 'admin_save_booking', {
    p_id: null,
    p_customer_name: 'Hamza',
    p_customer_phone: '0300-7654321',
    p_time: '19:30',
    p_table_id: club.tables.snooker1,
    p_notes: '',
    ...args
  })

/** End a session and pay for it at the staff counter. */
async function payFor(sessionId: string, seconds: number, extra: Record<string, unknown> = {}) {
  await db.ageSession(sessionId, seconds)
  await db.rpc(staff.id, 'end_session', { p_session_id: sessionId })
  return db.rpc<{ sale_id: string; final_amount: number }>(staff.id, 'complete_checkout', {
    p_client_ref: randomUUID(),
    p_payment_method: 'cash',
    p_session_id: sessionId,
    ...extra
  })
}

describe('pre-bookings', () => {
  it('admin books a table and starts it once, through the normal session engine', async () => {
    const date = await today()
    const b = await book({ p_date: date })
    const [listed] = await db.rpc<Listed[]>(admin.id, 'list_bookings', { p_from: date, p_to: date })
    expect(listed).toMatchObject({ id: b.id, status: 'booked', table_name: 'Snooker 1', session_id: null })

    const started = await db.rpc<{ booking: Booking; session: { id: string; status: string; customer_id: string } }>(
      admin.id,
      'start_booking',
      { p_booking_id: b.id }
    )
    expect(started.booking).toMatchObject({ status: 'started', session_id: started.session.id })
    expect(started.session.status).toBe('running')
    expect((await rejects(db.rpc(admin.id, 'start_booking', { p_booking_id: b.id }))).hint).toBe('already_started')
    const [sessions] = await db.sql<{ n: number }>(`select count(*)::int n from public.sessions`)
    expect(sessions!.n).toBe(1)

    // The phone identified (and created) one customer profile, shown on the floor.
    const overview = await db.rpc<{ tables: { name: string; session: { booking_id: string; customer: { name: string; phone: string } } | null }[] }>(
      admin.id,
      'get_tables_overview'
    )
    expect(overview.tables.find((t) => t.name === 'Snooker 1')!.session).toMatchObject({
      booking_id: b.id,
      customer: { name: 'Hamza', phone: '03007654321' }
    })
    // Edits and deletion are refused once started.
    expect((await rejects(book({ p_id: b.id, p_date: date }))).hint).toBe('invalid_state')
    expect((await rejects(db.rpc(admin.id, 'admin_delete_booking', { p_id: b.id }))).hint).toBe('in_use')

    // Paid at a staff counter → completed, and counted for the customer.
    await db.openCounter(staff.id)
    await payFor(started.session.id, 1800)
    const [done] = await db.rpc<Listed[]>(admin.id, 'list_bookings', { p_from: date, p_to: date })
    expect(done).toMatchObject({ status: 'completed', session_status: 'completed' })
  })

  it('stores the date and time as the club’s local time and lists by business day', async () => {
    const b = await book({ p_date: '2026-11-05', p_time: '19:30' })
    expect(new Date(b.booking_at).toISOString()).toBe('2026-11-05T14:30:00.000Z') // Karachi = UTC+5
    const late = await book({ p_date: '2026-11-06', p_time: '01:00' })
    await db.sql(`update public.settings set day_start_hour = 6`)
    const listed = await db.rpc<Listed[]>(admin.id, 'list_bookings', { p_from: '2026-11-05', p_to: '2026-11-05' })
    // 1:00 AM after midnight still belongs to the evening of the 5th.
    expect(listed.map((x) => x.id)).toEqual([b.id, late.id])
  })

  it('needs a table to start; a busy table is refused and the booking stays booked', async () => {
    const date = await today()
    const noTable = await book({ p_date: date, p_table_id: null })
    expect((await rejects(db.rpc(admin.id, 'start_booking', { p_booking_id: noTable.id }))).hint).toBe('invalid_input')
    await db.rpc(staff.id, 'start_session', { p_table_id: club.tables.snooker1 })
    const busy = await rejects(db.rpc(admin.id, 'start_booking', { p_booking_id: noTable.id, p_table_id: club.tables.snooker1 }))
    expect(busy.hint).toBe('table_busy')
    const [row] = await db.sql<{ status: string; session_id: string | null }>(`select status, session_id from public.bookings where id = $1`, [noTable.id])
    expect(row).toEqual({ status: 'booked', session_id: null })
    await db.rpc(admin.id, 'start_booking', { p_booking_id: noTable.id, p_table_id: club.tables.pool1 })
  })

  it('cancel, no-show and restore; cancelling the session cancels its booking', async () => {
    const date = await today()
    const b = await book({ p_date: date })
    await db.rpc(admin.id, 'admin_set_booking_status', { p_id: b.id, p_status: 'no_show' })
    expect((await rejects(db.rpc(admin.id, 'start_booking', { p_booking_id: b.id }))).hint).toBe('invalid_state')
    await db.rpc(admin.id, 'admin_set_booking_status', { p_id: b.id, p_status: 'booked' })
    const started = await db.rpc<{ session: { id: string } }>(admin.id, 'start_booking', { p_booking_id: b.id })
    await db.rpc(admin.id, 'cancel_session', { p_session_id: started.session.id })
    const [row] = await db.sql<{ status: string }>(`select status from public.bookings where id = $1`, [b.id])
    expect(row!.status).toBe('cancelled')
    const other = await book({ p_date: date })
    await db.rpc(admin.id, 'admin_delete_booking', { p_id: other.id })
    expect(await db.rpc<Listed[]>(admin.id, 'list_bookings', { p_from: date, p_to: date })).toHaveLength(1)
  })

  it('staff cannot see or manage bookings', async () => {
    const date = await today()
    await book({ p_date: date })
    expect(await db.as(staff.id, () => db.pg.query(`select * from public.bookings`).then((r) => r.rows))).toHaveLength(0)
    expect((await rejects(db.rpc(staff.id, 'list_bookings', { p_from: date, p_to: date }))).hint).toBe('forbidden')
  })
})

describe('customers', () => {
  it('one profile per phone number, whatever the format', async () => {
    await db.openCounter(staff.id)
    for (const phone of ['0300-1112223', '+92 300 1112223', '00923001112223', '923001112223']) {
      await db.rpc(staff.id, 'complete_checkout', {
        p_client_ref: randomUUID(),
        p_payment_method: 'cash',
        p_items: [{ product_id: club.products.tea, quantity: 1, unit_price: 70 }],
        p_customer_name: 'Bilal',
        p_customer_phone: phone
      })
    }
    const rows = await db.sql<{ phone: string }>(`select phone from public.customers`)
    expect(rows).toEqual([{ phone: '03001112223' }])
  })

  it('ranks by visits, playing time and spending; same-day bills are one visit; voids reverse', async () => {
    await db.openCounter(staff.id)
    const play = async (name: string, phone: string, seconds: number) => {
      const s = await db.rpc<{ id: string }>(staff.id, 'start_session', {
        p_table_id: club.tables.snooker1,
        p_customer_name: name,
        p_customer_phone: phone
      })
      return payFor(s.id, seconds)
    }
    await play('Ali', '03001000001', 3600) // 600, 1 h
    await play('Ali', '03001000001', 1800) // same day: still one visit
    await play('Sara', '03001000002', 7200) // 1200, 2 h
    const voided = await play('Omar', '03001000003', 600) // 100 — then voided
    await db.rpc(staff.id, 'delete_sale', { p_sale_id: voided.sale_id })
    // Ali visited on an earlier day too.
    await db.sql(
      `insert into public.customer_visits (customer_id, business_date, invoices, spent, play_seconds, last_at)
       select id, current_date - 10, 1, 50, 600, now() - interval '10 days' from public.customers where phone = '03001000001'`
    )

    const rank = (metric: string) =>
      db.rpc<{ rows: Ranking[]; summary: { customers: number; with_visits: number; repeat: number } }>(admin.id, 'get_customer_rankings', {
        p_metric: metric
      })
    const visits = await rank('visits')
    expect(visits.rows.map((r) => [r.rank, r.name, r.visits, r.invoices])).toEqual([
      [1, 'Ali', 2, 3],
      [2, 'Sara', 1, 1]
    ])
    expect(visits.summary).toEqual({ customers: 3, with_visits: 2, repeat: 1 })
    const time = await rank('play_time')
    expect(time.rows.map((r) => [r.name, r.play_seconds])).toEqual([
      ['Sara', 7200],
      ['Ali', 6000]
    ])
    const spending = await rank('spending')
    expect(spending.rows.map((r) => [r.name, r.spent])).toEqual([
      ['Sara', 1200],
      ['Ali', 950]
    ])
    expect((await rejects(rank('loyalty'))).hint).toBe('invalid_input')
    expect((await rejects(db.rpc(staff.id, 'get_customer_rankings', { p_metric: 'visits' }))).hint).toBe('forbidden')
  })
})

describe('deleting configuration records', () => {
  it('categories, tables and products with history are protected; unused ones are deleted', async () => {
    await db.openCounter(staff.id)
    const s = await db.rpc<{ id: string }>(staff.id, 'start_session', { p_table_id: club.tables.snooker1 })
    await db.rpc(staff.id, 'add_session_item', { p_session_id: s.id, p_product_id: club.products.cola })
    await payFor(s.id, 600)

    expect((await rejects(db.rpc(admin.id, 'admin_delete_category', { p_id: club.categories.snooker }))).hint).toBe('in_use')
    expect((await rejects(db.rpc(admin.id, 'admin_delete_table', { p_id: club.tables.snooker1 }))).hint).toBe('in_use')
    expect((await rejects(db.rpc(admin.id, 'admin_delete_product', { p_id: club.products.cola }))).hint).toBe('in_use')

    // Deactivating keeps history readable: the old invoice still names the product.
    await db.rpc(admin.id, 'admin_set_product_active', { p_id: club.products.cola, p_active: false })
    await db.rpc(admin.id, 'admin_set_table_active', { p_id: club.tables.snooker1, p_active: false })
    const [line] = await db.sql<{ product_name: string; unit_price: string }>(`select product_name, unit_price from public.sale_items`)
    expect(line).toEqual({ product_name: 'Cola', unit_price: '100.00' })

    const [carrom] = await db.sql<{ id: number }>(`insert into public.table_categories (name, rate_per_minute) values ('Carrom', 3.5) returning id`)
    await db.rpc(admin.id, 'admin_delete_category', { p_id: carrom!.id })
    await db.rpc(admin.id, 'admin_delete_table', { p_id: club.tables.pool1 })
    await db.rpc(admin.id, 'admin_delete_product', { p_id: club.products.chips })
    const [left] = await db.sql<{ cats: number; tables: number; products: number }>(
      `select (select count(*)::int from public.table_categories) cats, (select count(*)::int from public.club_tables) tables,
              (select count(*)::int from public.inventory_products) products`
    )
    expect(left).toEqual({ cats: 2, tables: 1, products: 2 })
  })

  it('staff accounts with history can only be deactivated', async () => {
    await db.openCounter(staff.id)
    expect((await rejects(db.rpc(admin.id, 'admin_check_user_deletable', { p_user_id: staff.id }))).hint).toBe('in_use')
    const fresh = await db.createUser('staff', { floorId: club.floors.ground })
    expect(await db.rpc(admin.id, 'admin_check_user_deletable', { p_user_id: fresh.id })).toBe(true)
    expect((await rejects(db.rpc(admin.id, 'admin_check_user_deletable', { p_user_id: admin.id }))).hint).toBe('invalid_state')
    // The database itself refuses to remove an account that history refers to.
    const err = await rejects(db.sql(`delete from auth.users where id = $1`, [staff.id]))
    expect(err.message).toMatch(/foreign key/)
  })
})
