/**
 * The 30-day (Monthly) automatic invoice cleanup, run the way pg_cron runs it.
 *
 * PGlite has no pg_cron, so a stand-in `cron` schema records the job exactly
 * as the migration's `cron.schedule(...)` call creates it, and a small
 * scheduler replays that cron expression minute by minute, executing the
 * stored command as the database owner — the same path Supabase uses. Time
 * "passes" by moving every stored date one day back per simulated day.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, seedClub, type TestUser } from './harness'

type Run = { status: string; source: string; sales_deleted: number; items_deleted: number; message: string | null; cutoff_date: string }
type Totals = { cash: number; bank: number; total: number; snack: number; expenses: number; net: number; invoices: number }

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'supabase', 'migrations', '20261101000700_counter_shifts_history_retention.sql'),
  'utf8'
)
// The exact scheduling statement the migration runs on Supabase.
const SCHEDULE_CALL = /perform (cron\.schedule\('fusion-sales-retention', '([^']+)', '([^']+)'\));/.exec(MIGRATION)

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let cashier: TestUser
let night: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  cashier = await db.createUser('staff', {
    username: 'cashier',
    floorId: club.floors.ground,
    permissions: ['counter_sale', 'view_own_sales', 'apply_discount']
  })
  night = await db.createUser('staff', { username: 'night', floorId: club.floors.ground, permissions: ['counter_sale'] })
  // pg_cron stand-in: the job table and cron.schedule() as pg_cron defines them.
  await db.pg.exec(`
    create schema cron;
    create table cron.job (jobid bigserial primary key, jobname text unique, schedule text not null,
                           command text not null, active boolean not null default true, username text not null default current_user);
    create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $$
      insert into cron.job (jobname, schedule, command) values (p_name, p_schedule, p_command)
      on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
      returning jobid $$;`)
  await db.pg.exec(`select ${SCHEDULE_CALL![1]}`)
})
afterEach(async () => db.close())

/** Does a five-field cron expression (numbers, lists, ranges, steps or *) fire at this minute? */
function cronMatches(expr: string, at: { minute: number; hour: number; day: number; month: number; weekday: number }) {
  const fields = expr.trim().split(/\s+/)
  const values = [at.minute, at.hour, at.day, at.month, at.weekday]
  return fields.every((field, i) =>
    field.split(',').some((part) => {
      const [range, step] = part.split('/') as [string, string | undefined]
      const every = step ? Number(step) : 1
      if (range === '*') return values[i]! % every === 0
      const [lo, hi] = range.split('-').map(Number) as [number, number | undefined]
      const v = values[i]!
      return v >= lo && v <= (hi ?? lo) && (v - lo) % every === 0
    })
  )
}

/** One simulated day of pg_cron: every minute, run each active job whose schedule fires. */
async function runCronDay(day: number): Promise<number> {
  const jobs = await db.sql<{ schedule: string; command: string }>(`select schedule, command from cron.job where active`)
  let runs = 0
  for (let minute = 0; minute < 24 * 60; minute++) {
    const at = { minute: minute % 60, hour: Math.floor(minute / 60), day: (day % 28) + 1, month: 11, weekday: day % 7 }
    for (const job of jobs) {
      if (cronMatches(job.schedule, at)) {
        await db.pg.exec(job.command) // pg_cron runs the command as the job owner (the database owner)
        runs++
      }
    }
  }
  return runs
}

/** Move every stored date `days` back — the same as the calendar moving forward. */
async function passDays(days: number) {
  const n = String(days)
  await db.pg.exec(`
    update public.sales set business_date = business_date - ${n}, created_at = created_at - interval '${n} days';
    update public.shift_daily_totals set business_date = business_date - ${n};
    update public.customer_visits set business_date = business_date - ${n};
    update public.expenses set business_date = business_date - ${n}, created_at = created_at - interval '${n} days';
    update public.daily_summaries set business_date = business_date - ${n};
    update public.sessions set started_at = started_at - interval '${n} days', ended_at = ended_at - interval '${n} days';
    update public.counter_shifts set business_date = business_date - ${n},
      opened_at = opened_at - interval '${n} days', closed_at = closed_at - interval '${n} days';`)
}

const count = async (table: string) => (await db.one<{ n: number }>(`select count(*)::int n from public.${table}`)).n
const today = async () => (await db.one<{ d: string }>(`select public.get_current_business_date()::text d`)).d
const historyTotals = async () => {
  const d = await today()
  const from = (await db.one<{ d: string }>(`select ($1::date - 90)::text d`, [d])).d
  return (await db.rpc<{ totals: Totals }>(admin.id, 'get_history', { p_from: from, p_to: d })).totals
}
/** Row counts of every table the cleanup must never delete from, plus the ledger's money. */
const permanentSnapshot = async () =>
  db.one(
    `select (select count(*)::int from public.app_users) users, (select count(*)::int from public.customers) customers,
            (select count(*)::int from public.customer_visits) visits, (select sum(spent)::text from public.customer_visits) spent,
            (select count(*)::int from public.counter_shifts) shifts, (select count(*)::int from public.shift_daily_totals) ledger_rows,
            (select sum(cash_sales + bank_sales)::text from public.shift_daily_totals) ledger_total,
            (select count(*)::int from public.expenses) expenses, (select count(*)::int from public.daily_summaries) summaries,
            (select count(*)::int from public.sessions) sessions, (select count(*)::int from public.inventory_products) products,
            (select count(*)::int from public.club_tables) tables, (select count(*)::int from public.bookings) bookings`
  )

/** A day of trading at one counter, then the counter closes. */
async function tradeAndClose(user: TestUser) {
  await db.openCounter(user.id)
  const s = await db.rpc<{ id: string }>(user.id, 'start_session', { p_table_id: club.tables.snooker1 })
  await db.ageSession(s.id, 100 * 60)
  await db.rpc(user.id, 'end_session', { p_session_id: s.id })
  // 100 min at a custom 9/min = 900, less PKR 30 = 870 cash.
  await db.rpc(user.id, 'complete_checkout', {
    p_client_ref: randomUUID(),
    p_payment_method: 'cash',
    p_session_id: s.id,
    p_custom_rate_per_minute: 9,
    p_discount: 30,
    p_customer_name: 'Regular',
    p_customer_phone: '0300-7778889'
  })
  // Two teas (140) by bank transfer, to the same regular.
  await db.rpc(user.id, 'complete_checkout', {
    p_client_ref: randomUUID(),
    p_payment_method: 'bank_transfer',
    p_items: [{ product_id: club.products.tea, quantity: 2, unit_price: 70 }],
    p_customer_name: 'Regular',
    p_customer_phone: '0300-7778889'
  })
  await db.rpc(user.id, 'add_expense', { p_client_ref: randomUUID(), p_amount: 50, p_description: 'Chalk' })
  return db.rpc<{ id: string }>(user.id, 'close_counter')
}

describe('Monthly (30-day) cleanup under pg_cron', () => {
  it('the migration schedules exactly the cleanup command, hourly at minute 17', async () => {
    expect(SCHEDULE_CALL).not.toBeNull()
    const [job] = await db.sql<{ jobname: string; schedule: string; command: string; active: boolean }>(
      `select jobname, schedule, command, active from cron.job`
    )
    expect(job).toEqual({
      jobname: 'fusion-sales-retention',
      schedule: '17 * * * *',
      command: 'select public.fusion_retention_job()',
      active: true
    })
    // Settings → Data retention reads this to show the job as scheduled.
    const status = await db.rpc<{ scheduled: boolean; retention_days: number }>(admin.id, 'get_retention_status')
    expect(status).toMatchObject({ scheduled: true, retention_days: 30 })
    // The scheduler replays it 24 times a day.
    expect(await runCronDay(0)).toBe(24)
  })

  it('keeps invoices for 30 full days, removes them on day 31, and never changes a total', async () => {
    expect((await db.one<{ d: number }>(`select sales_retention_days d from public.settings`)).d).toBe(30) // the default
    const firstShift = await tradeAndClose(cashier)
    await db.rpc(admin.id, 'close_business_day', { p_business_date: await today() })
    // A counter left open the whole time: its invoice must survive, however old.
    await db.openCounter(night.id)
    await db.rpc(night.id, 'complete_checkout', {
      p_client_ref: randomUUID(),
      p_payment_method: 'cash',
      p_items: [{ product_id: club.products.tea, quantity: 1, unit_price: 70 }]
    })

    const totals = await historyTotals()
    expect(totals).toMatchObject({ cash: 940, bank: 140, total: 1080, snack: 210, expenses: 50, net: 1030, invoices: 3 })
    const permanent = await permanentSnapshot()
    const rankings = await db.rpc(admin.id, 'get_customer_rankings', { p_metric: 'spending' })
    expect(await count('sales')).toBe(3)

    let secondShiftDay: number | null = null
    for (let day = 1; day <= 32; day++) {
      await passDays(1)
      if (day === 10) {
        await tradeAndClose(cashier) // a newer shift, 21 days old when the first one expires
        secondShiftDay = day
      }
      expect(await runCronDay(day)).toBe(24)

      const firstShiftInvoices = (
        await db.one<{ n: number }>(`select count(*)::int n from public.sales where shift_id = $1`, [firstShift.id])
      ).n
      // Age in business days of the first shift's invoices is `day`; the cut-off is today − 30.
      expect(firstShiftInvoices, `day ${day}`).toBe(day <= 30 ? 2 : 0)
      // The open counter keeps its invoice; the newer shift is never old enough here.
      expect(await count('sales'), `day ${day}`).toBe((day <= 30 ? 2 : 0) + 1 + (secondShiftDay ? 2 : 0))
      // Every total stays exactly the same, every day.
      const expected = secondShiftDay
        ? { cash: 1810, bank: 280, total: 2090, snack: 350, expenses: 100, net: 1990, invoices: 5 }
        : totals
      expect(await historyTotals(), `day ${day}`).toMatchObject(expected)
    }

    // 32 days × 24 hourly runs, all successful; only the day-31 run at 00:17 removed anything.
    const runs = await db.sql<{ status: string; source: string; sales_deleted: number; items_deleted: number }>(
      `select status, source, sales_deleted, items_deleted from public.retention_runs order by id`
    )
    expect(runs).toHaveLength(32 * 24)
    expect(runs.every((r) => r.status === 'success' && r.source === 'schedule')).toBe(true)
    const removing = runs.map((r, i) => [i, r] as const).filter(([, r]) => r.sales_deleted > 0)
    expect(removing).toEqual([[30 * 24, { status: 'success', source: 'schedule', sales_deleted: 2, items_deleted: 1 }]])

    // The first shift's figures, the day summary, customers and their statistics are all still there.
    const shift = await db.rpc<{ total: number; net: number; invoices: number; retained_invoices: number; details_purged_at: string | null }>(
      admin.id,
      'get_shift_detail',
      { p_shift_id: firstShift.id }
    )
    expect(shift).toMatchObject({ total: 1010, net: 960, invoices: 2, retained_invoices: 0 })
    expect(shift.details_purged_at).not.toBeNull()
    const after = await permanentSnapshot()
    expect(after).toEqual({
      ...permanent,
      shifts: Number(permanent.shifts) + 1,
      ledger_rows: Number(permanent.ledger_rows) + 1,
      ledger_total: '2090.00',
      visits: Number(permanent.visits) + 1,
      spent: '2020.00',
      expenses: Number(permanent.expenses) + 1,
      sessions: Number(permanent.sessions) + 1
    })
    expect(await db.rpc(admin.id, 'get_customer_rankings', { p_metric: 'spending' })).not.toEqual(rankings) // grew with the 2nd shift
    const ranking = await db.rpc<{ rows: { spent: number; visits: number; invoices: number }[] }>(admin.id, 'get_customer_rankings', { p_metric: 'spending' })
    expect(ranking.rows[0]).toMatchObject({ spent: 2020, visits: 2, invoices: 4 })
    const [summary] = await db.sql<{ total_sales: string; expenses: string }>(`select total_sales::text, expenses::text from public.daily_summaries`)
    expect(summary).toEqual({ total_sales: '1010.00', expenses: '50.00' })
  })

  it('an open counter keeps its invoices past 30 days; the first run after it closes removes them', async () => {
    await db.openCounter(cashier.id)
    await db.rpc(cashier.id, 'complete_checkout', {
      p_client_ref: randomUUID(),
      p_payment_method: 'cash',
      p_items: [{ product_id: club.products.tea, quantity: 1, unit_price: 70 }]
    })
    await passDays(40)
    await runCronDay(40)
    expect(await count('sales')).toBe(1)
    const status = await db.rpc<{ waiting_on_open_shifts: number; eligible_sales: number }>(admin.id, 'get_retention_status')
    expect(status).toMatchObject({ waiting_on_open_shifts: 1, eligible_sales: 0 })

    await db.rpc(cashier.id, 'close_counter')
    await db.pg.exec(`select public.fusion_retention_job()`)
    expect(await count('sales')).toBe(0)
    expect((await historyTotals()).total).toBe(70)
  })

  it('removes at most 20,000 invoices per run and clears a backlog over the next hourly runs', async () => {
    await db.openCounter(cashier.id)
    const first = await db.rpc<{ sale_id: string }>(cashier.id, 'complete_checkout', {
      p_client_ref: randomUUID(),
      p_payment_method: 'cash',
      p_items: [{ product_id: club.products.tea, quantity: 1, unit_price: 70 }]
    })
    await db.rpc(cashier.id, 'close_counter')
    // Copy that invoice 24,999 times inside the same closed shift (a large backlog).
    const [{ cols }] = (await db.sql<{ cols: string }>(
      `select string_agg(quote_ident(column_name), ', ' order by ordinal_position) cols from information_schema.columns
       where table_schema = 'public' and table_name = 'sales' and column_name not in ('id', 'client_ref', 'receipt_no')`
    )) as [{ cols: string }]
    await db.sql(
      `insert into public.sales (client_ref, ${cols})
       select gen_random_uuid(), ${cols} from public.sales cross join generate_series(1, 24999) where id = $1`,
      [first.sale_id]
    )
    await db.sql(
      `insert into public.sale_items (sale_id, product_id, product_name, unit_price, quantity, line_total)
       select s.id, i.product_id, i.product_name, i.unit_price, i.quantity, i.line_total
       from public.sales s cross join (select * from public.sale_items where sale_id = $1) i where s.id <> $1`,
      [first.sale_id]
    )
    expect(await count('sales')).toBe(25_000)
    await passDays(31)

    const runs: Run[] = []
    for (let i = 0; i < 3; i++) {
      await db.pg.exec(`select public.fusion_retention_job()`)
      runs.push(await db.one<Run>(`select * from public.retention_runs order by id desc limit 1`))
    }
    expect(runs.map((r) => [r.status, r.sales_deleted, r.items_deleted])).toEqual([
      ['success', 20_000, 20_000],
      ['success', 5_000, 5_000],
      ['success', 0, 0]
    ])
    expect(await count('sales')).toBe(0)
    expect(await count('sale_items')).toBe(0)
  })

  it('stops without removing anything if an invoice has no permanent summary', async () => {
    const shift = await tradeAndClose(cashier)
    await passDays(31)
    await db.sql(`delete from public.shift_daily_totals where shift_id = $1`, [shift.id]) // simulate a missing ledger row
    await db.pg.exec(`select public.fusion_retention_job()`)
    const run = await db.one<Run>(`select * from public.retention_runs order by id desc limit 1`)
    expect(run).toMatchObject({ status: 'failed', sales_deleted: 0 })
    expect(run.message).toMatch(/no permanent summary/)
    expect(await count('sales')).toBe(2)
    expect(await count('sale_items')).toBe(1)
  })

  it('a shorter period applies from the next run; a longer one keeps more from then on', async () => {
    await tradeAndClose(cashier)
    await passDays(10)
    await db.pg.exec(`select public.fusion_retention_job()`)
    expect(await count('sales')).toBe(2) // 10 days old: kept under Monthly
    await db.rpc(admin.id, 'admin_update_settings', { p_settings: { sales_retention_days: 7 } })
    await db.pg.exec(`select public.fusion_retention_job()`)
    expect(await count('sales')).toBe(0) // Weekly removes them

    await db.rpc(admin.id, 'admin_update_settings', { p_settings: { sales_retention_days: 30 } })
    await tradeAndClose(cashier)
    await passDays(10)
    await db.pg.exec(`select public.fusion_retention_job()`)
    expect(await count('sales')).toBe(2)
    expect((await historyTotals()).total).toBe(2020)
  })

  it('trims its own log after 180 days and never touches anything else', async () => {
    await db.sql(
      `insert into public.retention_runs (source, status, started_at, finished_at) values
         ('schedule', 'success', now() - interval '200 days', now() - interval '200 days'),
         ('schedule', 'success', now() - interval '100 days', now() - interval '100 days')`
    )
    const before = await permanentSnapshot()
    await db.pg.exec(`select public.fusion_retention_job()`)
    const ages = await db.sql<{ days: number }>(`select extract(day from now() - started_at)::int days from public.retention_runs order by started_at`)
    expect(ages.map((a) => a.days)).toEqual([100, 0])
    expect(await permanentSnapshot()).toEqual(before)
  })
})
