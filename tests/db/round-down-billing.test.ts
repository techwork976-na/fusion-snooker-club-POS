/**
 * Completed minutes only (migration 1800, "round down"): a minute is charged
 * once all 60 seconds of it are played — open play, a booking ended early and
 * time after Continue. Runs with the settings exactly as the migrations ship them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, sessionCharge } from '@shared/billing'
import { TestDb, seedClub, type TestUser } from './harness'

type Session = { id: string; booked_seconds: number | null; booked_amount: string | null; billable_seconds: number | null; base_amount: string | null }

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let staff: TestUser

beforeEach(async () => {
  db = await TestDb.create({ shippedSettings: true })
  club = await seedClub(db) // Snooker PKR 10/min
  staff = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['counter_sale'] })
})
afterEach(async () => db.close())

const start = (booking: Record<string, unknown> = {}) =>
  db.rpc<Session>(staff.id, 'start_session', { p_table_id: club.tables.snooker1, p_booking: 'open', p_minutes: null, p_amount: null, ...booking })
const end = (s: Session) => db.rpc<Session>(staff.id, 'end_session', { p_session_id: s.id })
const clear = (s: Session) => db.sql(`update public.sessions set status = 'cancelled' where id = $1`, [s.id])

describe('round down', () => {
  it('is the club setting and the default', async () => {
    expect(await db.one(`select billing_rounding from public.settings`)).toEqual({ billing_rounding: 'down' })
    expect(await db.one(`select column_default from information_schema.columns where table_name = 'settings' and column_name = 'billing_rounding'`)).toEqual({
      column_default: "'down'::text"
    })
    expect(DEFAULT_POLICY.rounding).toBe('down')
  })

  it('open play charges completed minutes only', async () => {
    for (const [seconds, expected] of [
      [59, 0],
      [60, 10],
      [119, 10],
      [30 * 60 + 59, 300],
      [61 * 60, 610]
    ] as const) {
      const s = await start()
      await db.ageSession(s.id, seconds)
      expect(Number((await end(s)).base_amount), `${seconds} s`).toBe(expected)
      await clear(s)
    }
  })

  it('a 1-hour booking (PKR 600) continued 5 seconds over stays PKR 600 until a full extra minute', async () => {
    for (const [over, expected] of [
      [5, 600],
      [59, 600],
      [60, 610],
      [65, 610]
    ] as const) {
      const s = await start({ p_booking: 'minutes', p_minutes: 60 })
      await db.ageSession(s.id, 3600)
      await db.rpc(staff.id, 'continue_after_allocation', { p_session_id: s.id })
      await db.ageSession(s.id, over)
      expect(Number((await end(s)).base_amount), `${over} s over`).toBe(expected)
      await clear(s)
    }
  })

  it("time's up without Continue holds at the booking, and an early end pays completed minutes", async () => {
    const held = await start({ p_booking: 'minutes', p_minutes: 60 })
    await db.ageSession(held.id, 3605)
    expect(Number((await end(held)).base_amount)).toBe(600)
    await clear(held)

    const early = await start({ p_booking: 'amount', p_amount: 1000 })
    await db.ageSession(early.id, 15 * 60 + 40)
    expect(Number((await end(early)).base_amount)).toBe(150)
  })

  it('the live timer computes the same charges', () => {
    const booked = { ratePerMinute: 10, bookedSeconds: 3600, bookedAmount: 600 }
    expect([sessionCharge({ ratePerMinute: 10, billableSeconds: 59 }, DEFAULT_POLICY), sessionCharge({ ...booked, billableSeconds: 3605 }, DEFAULT_POLICY)]).toEqual([0, 600])
    expect(sessionCharge({ ...booked, billableSeconds: 3660 }, DEFAULT_POLICY)).toBe(610)
  })
})
