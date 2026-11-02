import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

type Session = {
  id: string
  status: string
  paused_ms: string | number
  billable_seconds: number | null
  base_amount: string | null
  booked_seconds: number | null
  booked_amount: string | null
  rate_per_minute: string
}

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let staff: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  staff = await db.createUser('staff', { floorId: club.floors.ground })
})
afterEach(async () => db.close())

const start = (user: string, table: string, extra: Record<string, unknown> = {}) =>
  db.rpc<Session>(user, 'start_session', { p_table_id: table, ...extra })

describe('starting sessions', () => {
  it('starts on an available table and snapshots the rate', async () => {
    const s = await start(staff.id, club.tables.snooker1)
    expect(s.status).toBe('running')
    expect(Number(s.rate_per_minute)).toBe(10)
  })

  it('refuses a second start while the table is running', async () => {
    await start(staff.id, club.tables.snooker1)
    const err = await rejects(start(admin.id, club.tables.snooker1))
    expect(err.hint).toBe('table_busy')
    expect(err.message).toMatch(/already in use/)
  })

  it('refuses to start on a paused table', async () => {
    const s = await start(staff.id, club.tables.snooker1)
    await db.rpc(staff.id, 'pause_session', { p_session_id: s.id })
    const err = await rejects(start(staff.id, club.tables.snooker1))
    expect(err.hint).toBe('table_busy')
  })

  it('refuses to start on a table awaiting checkout', async () => {
    const s = await start(staff.id, club.tables.snooker1)
    await db.rpc(staff.id, 'end_session', { p_session_id: s.id })
    const err = await rejects(start(staff.id, club.tables.snooker1))
    expect(err.hint).toBe('table_busy')
  })

  it('the database itself rejects a duplicate open session (concurrency backstop)', async () => {
    await start(staff.id, club.tables.snooker1)
    const err = await rejects(
      db.sql(
        `insert into public.sessions (table_id, status, rate_per_minute, started_by) values ($1, 'running', 10, $2)`,
        [club.tables.snooker1, staff.id]
      )
    )
    expect(err.message).toMatch(/sessions_one_open_per_table/)
  })

  it('allows a new session after checkout completes', async () => {
    await db.openCounter(staff.id)
    const s = await start(staff.id, club.tables.snooker1)
    await db.rpc(staff.id, 'end_session', { p_session_id: s.id })
    await db.rpc(staff.id, 'complete_checkout', {
      p_client_ref: crypto.randomUUID(),
      p_payment_method: 'cash',
      p_session_id: s.id
    })
    const again = await start(staff.id, club.tables.snooker1)
    expect(again.status).toBe('running')
  })

  it('enforces floor assignment for staff', async () => {
    const err = await rejects(start(staff.id, club.tables.pool1))
    expect(err.hint).toBe('wrong_floor')
    const allFloors = await db.createUser('staff', { floorId: null })
    expect((await start(allFloors.id, club.tables.pool1)).status).toBe('running')
  })

  it('rejects deactivated users and anonymous callers', async () => {
    const gone = await db.createUser('staff', { floorId: club.floors.ground, active: false })
    expect((await rejects(start(gone.id, club.tables.snooker1))).hint).toBe('not_authenticated')
    const anon = await rejects(start(null as unknown as string, club.tables.snooker1))
    expect(anon.message).toMatch(/permission denied|not signed in/)
  })
})

describe('timer, pause and resume', () => {
  it('does not bill paused time', async () => {
    const s = await start(staff.id, club.tables.snooker1)
    // Ran 9:30, then paused.
    await db.ageSession(s.id, 570)
    await db.rpc(staff.id, 'pause_session', { p_session_id: s.id })
    // 20 minutes pass while paused.
    await db.sql(
      `update public.sessions set started_at = started_at - interval '20 minutes', paused_at = paused_at - interval '20 minutes' where id = $1`,
      [s.id]
    )
    const resumed = await db.rpc<Session>(staff.id, 'resume_session', { p_session_id: s.id })
    expect(resumed.status).toBe('running')
    const pausedMs = Number(resumed.paused_ms)
    expect(pausedMs).toBeGreaterThanOrEqual(20 * 60 * 1000)
    expect(pausedMs).toBeLessThan(20 * 60 * 1000 + 2000)

    const ended = await db.rpc<Session>(staff.id, 'end_session', { p_session_id: s.id })
    // Elapsed continues from 9:30 (plus the few ms the test took).
    expect(ended.billable_seconds).toBeGreaterThanOrEqual(570)
    expect(ended.billable_seconds).toBeLessThanOrEqual(571)
    // 9:30 rounds up to 10 minutes at PKR 10/min = PKR 100.
    expect(Number(ended.base_amount)).toBe(100)
  })

  it('ending while paused stops the clock at the pause', async () => {
    const s = await start(staff.id, club.tables.snooker1)
    await db.ageSession(s.id, 600)
    await db.rpc(staff.id, 'pause_session', { p_session_id: s.id })
    await db.sql(
      `update public.sessions set started_at = started_at - interval '1 hour', paused_at = paused_at - interval '1 hour' where id = $1`,
      [s.id]
    )
    const ended = await db.rpc<Session>(staff.id, 'end_session', { p_session_id: s.id })
    expect(ended.billable_seconds).toBe(600)
    expect(Number(ended.base_amount)).toBe(100)
  })

  it('rejects invalid state transitions', async () => {
    const s = await start(staff.id, club.tables.snooker1)
    expect((await rejects(db.rpc(staff.id, 'resume_session', { p_session_id: s.id }))).hint).toBe('invalid_state')
    await db.rpc(staff.id, 'pause_session', { p_session_id: s.id })
    expect((await rejects(db.rpc(staff.id, 'pause_session', { p_session_id: s.id }))).hint).toBe('invalid_state')
    await db.rpc(staff.id, 'end_session', { p_session_id: s.id })
    expect((await rejects(db.rpc(staff.id, 'end_session', { p_session_id: s.id }))).hint).toBe('invalid_state')
  })

  it('reopening an ended session excludes the time spent at checkout', async () => {
    const s = await start(staff.id, club.tables.snooker1)
    await db.ageSession(s.id, 300)
    await db.rpc(staff.id, 'end_session', { p_session_id: s.id })
    await db.sql(
      `update public.sessions set started_at = started_at - interval '10 minutes', ended_at = ended_at - interval '10 minutes' where id = $1`,
      [s.id]
    )
    const reopened = await db.rpc<Session>(staff.id, 'reopen_session', { p_session_id: s.id })
    expect(reopened.status).toBe('running')
    expect(reopened.billable_seconds).toBeNull()
    const ended = await db.rpc<Session>(staff.id, 'end_session', { p_session_id: s.id })
    expect(ended.billable_seconds).toBeGreaterThanOrEqual(300)
    expect(ended.billable_seconds).toBeLessThanOrEqual(301)
  })
})

describe('billing rules', () => {
  it('applies the configured increment, rounding and minimum', async () => {
    await db.sql(
      `update public.settings set billing_increment_minutes = 15, billing_rounding = 'up', minimum_charge_minutes = 30`
    )
    const s = await start(staff.id, club.tables.snooker1)
    await db.ageSession(s.id, 10 * 60)
    const ended = await db.rpc<Session>(staff.id, 'end_session', { p_session_id: s.id })
    // 10 min -> one 15-min block -> raised to the 30-min minimum -> PKR 300.
    expect(Number(ended.base_amount)).toBe(300)
  })

  it('books a fixed number of minutes', async () => {
    const s = await start(staff.id, club.tables.snooker1, {
      p_booking: 'minutes',
      p_minutes: 45
    })
    expect(s.booked_seconds).toBe(2700)
    expect(Number(s.booked_amount)).toBe(450)
    // Leaving early still pays the booking.
    await db.ageSession(s.id, 20 * 60)
    const ended = await db.rpc<Session>(staff.id, 'end_session', { p_session_id: s.id })
    expect(Number(ended.base_amount)).toBe(450)
  })

  it('charges overtime beyond the booking at the normal rate', async () => {
    const s = await start(staff.id, club.tables.snooker1, { p_booking: 'minutes', p_minutes: 30 })
    await db.ageSession(s.id, 30 * 60 + 5 * 60 + 10)
    const ended = await db.rpc<Session>(staff.id, 'end_session', { p_session_id: s.id })
    // PKR 300 booking + 5:10 overtime -> 6 minutes -> PKR 60.
    expect(Number(ended.base_amount)).toBe(360)
  })

  it('converts a prepaid amount into playing time', async () => {
    const s = await start(staff.id, club.tables.snooker1, { p_booking: 'amount', p_amount: 400 })
    // PKR 400 at PKR 10/min = 40 minutes.
    expect(s.booked_seconds).toBe(2400)
    expect(Number(s.booked_amount)).toBe(400)

    await db.sql(`update public.table_categories set rate_per_minute = 11.6667 where id = $1`, [club.categories.snooker])
    await db.sql(`update public.sessions set status = 'completed', ended_at = now(), billable_seconds = 0, base_amount = 0 where id = $1`, [s.id])
    const s2 = await start(staff.id, club.tables.snooker1, { p_booking: 'amount', p_amount: 400 })
    // 400 / 11.6667 per min (700/h) = 34 min 17.14 s -> floored to whole seconds.
    expect(s2.booked_seconds).toBe(2057)
  })

  it('rejects invalid bookings', async () => {
    expect((await rejects(start(staff.id, club.tables.snooker1, { p_booking: 'minutes', p_minutes: 0 }))).hint).toBe(
      'invalid_input'
    )
    expect((await rejects(start(staff.id, club.tables.snooker1, { p_booking: 'amount', p_amount: 5 }))).hint).toBe(
      'invalid_input'
    )
    expect((await rejects(start(staff.id, club.tables.snooker1, { p_booking: 'credit' }))).hint).toBe('invalid_input')
  })

  it('keeps the rate snapshotted when rates change mid-session', async () => {
    const s = await start(staff.id, club.tables.snooker1)
    await db.sql(`update public.table_categories set rate_per_minute = 20 where id = $1`, [club.categories.snooker])
    await db.ageSession(s.id, 3600)
    const ended = await db.rpc<Session>(staff.id, 'end_session', { p_session_id: s.id })
    expect(Number(ended.base_amount)).toBe(600)
  })
})

describe('cancelling sessions', () => {
  it('requires the cancel_session permission and returns tab stock', async () => {
    const s = await start(staff.id, club.tables.snooker1)
    await db.rpc(staff.id, 'add_session_item', { p_session_id: s.id, p_product_id: club.products.cola, p_quantity: 2 })
    expect((await rejects(db.rpc(staff.id, 'cancel_session', { p_session_id: s.id }))).hint).toBe('forbidden')
    await db.rpc(admin.id, 'cancel_session', { p_session_id: s.id })
    const [cola] = await db.sql<{ stock_quantity: number }>(`select stock_quantity from public.inventory_products where id = $1`, [club.products.cola])
    expect(cola!.stock_quantity).toBe(10)
    // The session is kept as a cancelled record with the waived charge.
    const [kept] = await db.sql<{ status: string; ended_at: string | null; base_amount: string; items: number }>(
      `select status, ended_at, base_amount, (select count(*)::int from public.session_items) as items from public.sessions where id = $1`,
      [s.id]
    )
    expect(kept).toMatchObject({ status: 'cancelled', items: 0 })
    expect(kept!.ended_at).not.toBeNull()
    // The table is free again and the cancelled session cannot be touched.
    expect((await start(staff.id, club.tables.snooker1)).status).toBe('running')
    expect((await rejects(db.rpc(admin.id, 'cancel_session', { p_session_id: s.id }))).hint).toBe('invalid_state')
    expect((await rejects(db.rpc(admin.id, 'resume_session', { p_session_id: s.id }))).hint).toBe('invalid_state')
  })
})
