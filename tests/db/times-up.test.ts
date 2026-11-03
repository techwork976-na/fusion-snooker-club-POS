/**
 * "Time's up" for fixed-time and fixed-amount sessions (migration 1000): the
 * billable clock holds at the allocation, the alarm can be dismissed without
 * ending or continuing, and continuing never bills the minutes held.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

type Session = {
  id: string
  status: string
  booked_seconds: number | null
  booked_amount: string | null
  paused_ms: number
  billable_seconds: number | null
  base_amount: string | null
  allocation_alert_ack_at: string | null
  allocation_extended_at: string | null
}
type Overview = { tables: { id: string; session: (Session & { allocation_alert_ack_at: string | null }) | null }[] }

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let staff: TestUser
let upstairs: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  staff = await db.createUser('staff', { floorId: club.floors.ground })
  upstairs = await db.createUser('staff', { floorId: club.floors.first })
})
afterEach(async () => db.close())

// Snooker 1 is on the ground floor at PKR 10/min.
const bookMinutes = (minutes: number) =>
  db.rpc<Session>(staff.id, 'start_session', { p_table_id: club.tables.snooker1, p_booking: 'minutes', p_minutes: minutes })
const bookAmount = (amount: number) =>
  db.rpc<Session>(staff.id, 'start_session', { p_table_id: club.tables.snooker1, p_booking: 'amount', p_amount: amount })
const end = (id: string) => db.rpc<Session>(staff.id, 'end_session', { p_session_id: id })
const ack = (id: string, user = staff.id) => db.rpc<Session>(user, 'acknowledge_allocation_alert', { p_session_id: id })
const keepPlaying = (id: string) => db.rpc<Session>(staff.id, 'continue_after_allocation', { p_session_id: id })
const row = async (id: string) => (await db.sql<Session>(`select * from public.sessions where id = $1`, [id]))[0]!

describe("time's up: fixed time", () => {
  it('holds at the booked time however long staff take; ending bills exactly the booking', async () => {
    const s = await bookMinutes(30) // PKR 300
    await db.ageSession(s.id, 45 * 60) // 15 minutes past the allocation, nobody reacted
    const ended = await end(s.id)
    expect(ended.billable_seconds).toBe(1800)
    expect(Number(ended.base_amount)).toBe(300)
  })

  it('continuing never bills the held minutes; extra time is billed per minute from then on', async () => {
    const s = await bookMinutes(30)
    await db.ageSession(s.id, 40 * 60) // held for 10 minutes
    const continued = await keepPlaying(s.id)
    expect(continued.allocation_extended_at).not.toBeNull()
    expect(continued.allocation_alert_ack_at).not.toBeNull() // continuing also silences the alarm
    // The 10 held minutes (plus the few real milliseconds the test itself takes) become paused time.
    const held = Number(continued.paused_ms)
    expect(held).toBeGreaterThanOrEqual(10 * 60 * 1000)
    expect(held).toBeLessThan(10 * 60 * 1000 + 1000)
    await db.ageSession(s.id, 5 * 60)
    const ended = await end(s.id)
    expect(ended.billable_seconds).toBe(35 * 60)
    expect(Number(ended.base_amount)).toBe(350) // 300 + 5 min × 10
    // Continuing again (another terminal) changes nothing.
    expect(Number((await row(s.id)).paused_ms)).toBe(held)
  })

  it('cannot continue while the booking still has time left', async () => {
    const s = await bookMinutes(30)
    await db.ageSession(s.id, 29 * 60)
    expect((await rejects(keepPlaying(s.id))).hint).toBe('invalid_state')
    expect((await row(s.id)).allocation_extended_at).toBeNull()
  })

  it('a pause during the hold is not billed either', async () => {
    const s = await bookMinutes(30)
    await db.ageSession(s.id, 31 * 60) // held 1 minute
    await db.rpc(staff.id, 'pause_session', { p_session_id: s.id })
    await db.ageSession(s.id, 3 * 60) // paused 3 minutes
    await keepPlaying(s.id)
    await db.rpc(staff.id, 'resume_session', { p_session_id: s.id })
    await db.ageSession(s.id, 2 * 60)
    const ended = await end(s.id)
    expect(ended.billable_seconds).toBe(32 * 60)
    expect(Number(ended.base_amount)).toBe(320)
  })

  it('reopening a held session keeps it held; cancelling records only the booked charge', async () => {
    const s = await bookMinutes(30)
    await db.ageSession(s.id, 50 * 60)
    await end(s.id)
    await db.rpc(staff.id, 'reopen_session', { p_session_id: s.id })
    await db.ageSession(s.id, 10 * 60)
    expect(Number((await end(s.id)).base_amount)).toBe(300)

    await db.sql(`update public.sessions set status = 'completed' where id = $1`, [s.id])
    const manager = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['cancel_session'] })
    const c = await bookMinutes(20)
    await db.ageSession(c.id, 60 * 60)
    await db.rpc(manager.id, 'cancel_session', { p_session_id: c.id })
    const cancelled = await row(c.id)
    expect([cancelled.status, cancelled.billable_seconds, Number(cancelled.base_amount)]).toEqual(['cancelled', 1200, 200])
  })
})

describe("time's up: fixed amount", () => {
  it('a prepaid amount holds at its time and bills the amount paid', async () => {
    const s = await bookAmount(400) // 40 minutes at PKR 10/min
    expect(s.booked_seconds).toBe(2400)
    await db.ageSession(s.id, 55 * 60)
    const ended = await end(s.id)
    expect(ended.billable_seconds).toBe(2400)
    expect(Number(ended.base_amount)).toBe(400)
  })

  it('continuing a prepaid session bills extra minutes on top of the amount', async () => {
    const s = await bookAmount(400)
    await db.ageSession(s.id, 42 * 60) // held 2 minutes
    await keepPlaying(s.id)
    await db.ageSession(s.id, 3 * 60)
    expect(Number((await end(s.id)).base_amount)).toBe(430)
  })
})

describe("time's up: the alarm", () => {
  it('dismissing records it once for every terminal and neither ends nor continues the session', async () => {
    const s = await bookMinutes(30)
    await db.ageSession(s.id, 31 * 60)
    const first = await ack(s.id)
    expect(first.allocation_alert_ack_at).not.toBeNull()
    expect(first.status).toBe('running')
    expect(first.allocation_extended_at).toBeNull()
    const again = await ack(s.id)
    expect(again.allocation_alert_ack_at).toEqual(first.allocation_alert_ack_at)
    // Every terminal sees it (the floor overview carries the state).
    const overview = await db.rpc<Overview>(staff.id, 'get_tables_overview')
    const card = overview.tables.find((t) => t.id === club.tables.snooker1)!.session!
    expect(Date.parse(String(card.allocation_alert_ack_at))).toBe(new Date(first.allocation_alert_ack_at!).getTime())
    expect(card.allocation_extended_at).toBeNull()
    // Still held: ending bills the booking.
    await db.ageSession(s.id, 20 * 60)
    expect(Number((await end(s.id)).base_amount)).toBe(300)
  })

  it('is floor-checked and only for bookings', async () => {
    const s = await bookMinutes(30)
    expect((await rejects(ack(s.id, upstairs.id))).hint).toBe('wrong_floor')
    expect((await rejects(db.rpc(upstairs.id, 'continue_after_allocation', { p_session_id: s.id }))).hint).toBe('wrong_floor')
    const open = await db.rpc<Session>(staff.id, 'start_session', { p_table_id: club.tables.snooker1 }).catch(() => null)
    expect(open).toBeNull() // the table is busy; use the open-play check on a fresh table below
    await end(s.id)
    await db.sql(`update public.sessions set status = 'completed' where id = $1`, [s.id])
    const play = await db.rpc<Session>(staff.id, 'start_session', { p_table_id: club.tables.snooker1 })
    expect((await rejects(ack(play.id))).hint).toBe('invalid_state')
    expect((await rejects(keepPlaying(play.id))).hint).toBe('invalid_state')
    expect((await rejects(db.rpc(null, 'acknowledge_allocation_alert', { p_session_id: play.id }))).message).toMatch(/permission denied/)
  })

  it('open play is never held', async () => {
    const play = await db.rpc<Session>(staff.id, 'start_session', { p_table_id: club.tables.snooker1 })
    await db.ageSession(play.id, 90 * 60)
    expect(Number((await end(play.id)).base_amount)).toBe(900)
  })
})
