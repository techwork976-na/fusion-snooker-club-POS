import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let ground: TestUser
let groundSeller: TestUser
let saleId: string

beforeAll(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin', { username: 'owner' })
  ground = await db.createUser('staff', { floorId: club.floors.ground })
  groundSeller = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['counter_sale', 'view_own_sales'] })
  await db.rpc(admin.id, 'start_session', { p_table_id: club.tables.pool1 })
  await db.openCounter(groundSeller.id)
  const r =await db.rpc<{ sale_id: string }>(groundSeller.id, 'complete_checkout', {
    p_client_ref: crypto.randomUUID(),
    p_payment_method: 'cash',
    p_items: [{ product_id: club.products.tea, quantity: 1, unit_price: 70 }]
  })
  saleId = r.sale_id
  await db.sql(`insert into public.daily_summaries (business_date, total_cash, total_bank, total_sales, legacy_cash, legacy_bank) values ('2026-01-01', 1, 2, 3, 1, 2)`)
})
afterAll(async () => db.close())

const select = (user: string | null, query: string) => db.as(user, () => db.pg.query(query).then((r) => r.rows))

describe('row level security', () => {
  it('anonymous clients can read nothing', async () => {
    for (const table of ['app_users', 'settings', 'club_tables', 'sales', 'inventory_products', 'customers']) {
      const err = await rejects(select(null, `select * from public.${table}`))
      expect(err.message).toMatch(/permission denied/)
    }
  })

  it('staff cannot read cost prices, summaries or other users', async () => {
    expect(await select(ground.id, `select * from public.inventory_products`)).toHaveLength(0)
    expect(await select(ground.id, `select * from public.daily_summaries`)).toHaveLength(0)
    const users = await select(ground.id, `select id from public.app_users`)
    expect(users).toEqual([{ id: ground.id }])
    expect(await select(admin.id, `select * from public.inventory_products`)).toHaveLength(3)
    expect(await select(admin.id, `select * from public.app_users`)).toHaveLength(3)
  })

  it('staff only see their floor’s tables and sessions', async () => {
    const tables = await select(ground.id, `select name from public.club_tables`)
    expect(tables).toEqual([{ name: 'Snooker 1' }])
    expect(await select(ground.id, `select * from public.sessions`)).toHaveLength(0)
    expect(await select(admin.id, `select * from public.sessions`)).toHaveLength(1)
    const overview = await db.rpc<{ tables: { name: string }[] }>(ground.id, 'get_tables_overview')
    expect(overview.tables.map((t) => t.name)).toEqual(['Snooker 1'])
  })

  it('sales are visible to admins and, with permission, to their own cashier', async () => {
    expect(await select(ground.id, `select * from public.sales`)).toHaveLength(0)
    expect(await select(ground.id, `select * from public.sale_items`)).toHaveLength(0)
    expect(await select(groundSeller.id, `select id from public.sales`)).toEqual([{ id: saleId }])
    expect(await select(admin.id, `select id from public.sales`)).toHaveLength(1)
    expect((await rejects(db.rpc(ground.id, 'get_receipt', { p_sale_id: saleId }))).hint).toBe('not_found')
  })

  it('staff see open and today’s sessions on their floor, never older history', async () => {
    await db.openCounter(ground.id)
    const s =await db.rpc<{ id: string }>(ground.id, 'start_session', { p_table_id: club.tables.snooker1 })
    await db.rpc(ground.id, 'end_session', { p_session_id: s.id })
    await db.rpc(ground.id, 'complete_checkout', { p_client_ref: crypto.randomUUID(), p_payment_method: 'cash', p_session_id: s.id })
    expect(await select(ground.id, `select id from public.sessions`)).toEqual([{ id: s.id }])
    // Move it to an earlier business day: it disappears for staff, not for admins.
    await db.sql(`update public.sessions set started_at = started_at - interval '3 days', ended_at = ended_at - interval '3 days' where id = $1`, [s.id])
    expect(await select(ground.id, `select id from public.sessions`)).toHaveLength(0)
    expect(await select(admin.id, `select id from public.sessions where id = '${s.id}'`)).toHaveLength(1)
  })

  it('customer records are not readable in bulk by ordinary staff', async () => {
    await db.sql(`insert into public.customers (name, phone) values ('Zara Malik', '03211234567'), ('Zain Ali', null)`)
    expect(await select(ground.id, `select * from public.customers`)).toHaveLength(0)
    expect(await select(admin.id, `select * from public.customers`)).toHaveLength(2)
    expect(await db.rpcRows(ground.id, 'search_customers', { p_query: '' })).toHaveLength(0)
    expect(await db.rpcRows(ground.id, 'search_customers', { p_query: 'z' })).toHaveLength(0)
    expect((await db.rpcRows<{ name: string }>(ground.id, 'search_customers', { p_query: 'za' })).map((c) => c.name)).toEqual([
      'Zain Ali',
      'Zara Malik'
    ])
    expect((await db.rpcRows<{ name: string }>(ground.id, 'search_customers', { p_query: '1234' })).map((c) => c.name)).toEqual(['Zara Malik'])
    const manager = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['manage_customers'] })
    expect(await db.rpcRows(manager.id, 'search_customers', { p_query: '' })).toHaveLength(2)
  })

  it('clients cannot write any table directly', async () => {
    const writes = [
      `update public.app_users set role = 'admin'`,
      `insert into public.daily_summaries (business_date) values ('2026-02-02')`,
      `update public.inventory_products set stock_quantity = 999`,
      `delete from public.sales`,
      `update public.settings set club_name = 'x'`,
      `insert into public.sessions (table_id, status, rate_per_minute, started_by) values ('${club.tables.snooker1}', 'running', 1, '${ground.id}')`,
      `update public.counter_shifts set cash_sales = 0`,
      `update public.shift_daily_totals set cash_sales = 0`,
      `insert into public.expenses (client_ref, shift_id, user_id, business_date, amount, description) select gen_random_uuid(), id, user_id, business_date, 1, 'x' from public.counter_shifts`,
      `delete from public.customer_visits`,
      `insert into public.bookings (customer_name, booking_at, created_by) values ('x', now(), '${admin.id}')`,
      `delete from public.retention_runs`
    ]
    for (const user of [ground.id, admin.id]) {
      for (const sql of writes) {
        const err = await rejects(select(user, sql))
        expect(err.message).toMatch(/permission denied/)
      }
    }
  })

  it('internal helpers are not callable from the API', async () => {
    for (const fn of [
      `public.fusion_receipt_json('${saleId}')`,
      `public.fusion_resolve_customer(null, 'x', null)`,
      `public.fusion_lock_session('${saleId}')`,
      `public.fusion_post_ledger(null, null, null, 1, 0, 0, 0, 0, 1, 0, 0)`,
      `public.fusion_post_visit(null, null, 1, 1, 1)`,
      `public.fusion_shift_json(null)`,
      `public.fusion_staff_day(current_date)`,
      `public.fusion_closing_candidates()`,
      `public.fusion_run_retention('manual', null)`,
      `public.fusion_retention_job()`
    ]) {
      const err = await rejects(select(ground.id, `select ${fn}`))
      expect(err.message).toMatch(/permission denied/)
    }
  })
})

describe('admin-only operations', () => {
  const adminCalls: [string, Record<string, unknown>][] = [
    ['admin_update_settings', { p_settings: { club_name: 'Hacked' } }],
    ['admin_save_floor', { p_id: null, p_name: 'Roof' }],
    ['admin_save_category', { p_id: null, p_name: 'Carrom', p_rate_per_minute: 2 }],
    ['admin_save_product', { p_id: null, p_name: 'X', p_category: '', p_cost_price: 1, p_selling_price: 2, p_track_stock: true, p_low_stock_threshold: 1 }],
    ['admin_set_product_active', { p_id: null, p_active: false }],
    ['admin_update_user', { p_user_id: null, p_full_name: 'x', p_role: 'admin', p_floor_id: null, p_permissions: [] }],
    ['admin_set_user_active', { p_user_id: null, p_active: false }],
    ['get_sales_report', { p_from: '2026-01-01', p_to: '2026-01-02' }],
    ['close_business_day', { p_business_date: '2026-01-01' }],
    ['get_history', { p_from: '2026-01-01', p_to: '2026-01-02' }],
    ['list_open_business_dates', {}],
    ['list_bookings', { p_from: '2026-01-01', p_to: '2026-01-02' }],
    ['admin_save_booking', { p_id: null, p_customer_name: 'x', p_customer_phone: null, p_date: '2026-01-01', p_time: '18:00' }],
    ['start_booking', { p_booking_id: null }],
    ['admin_set_booking_status', { p_id: null, p_status: 'cancelled' }],
    ['admin_delete_booking', { p_id: null }],
    ['get_customer_rankings', { p_metric: 'visits' }],
    ['admin_delete_category', { p_id: 1 }],
    ['admin_delete_table', { p_id: null }],
    ['admin_delete_product', { p_id: null }],
    ['admin_check_user_deletable', { p_user_id: null }],
    ['admin_run_retention', {}],
    ['get_retention_status', {}]
  ]
  it.each(adminCalls)('%s is refused for staff', async (fn, args) => {
    const err = await rejects(db.rpc(ground.id, fn, args))
    expect(err.hint).toBe('forbidden')
  })

  it('staff cannot promote themselves', async () => {
    const err = await rejects(
      db.rpc(ground.id, 'admin_update_user', {
        p_user_id: ground.id,
        p_full_name: 'me',
        p_role: 'admin',
        p_floor_id: null,
        p_permissions: []
      })
    )
    expect(err.hint).toBe('forbidden')
    const [me] = await db.sql<{ role: string }>(`select role from public.app_users where id = $1`, [ground.id])
    expect(me!.role).toBe('staff')
  })

  it('the last active admin cannot be demoted or deactivated', async () => {
    const demote = await rejects(
      db.rpc(admin.id, 'admin_update_user', { p_user_id: admin.id, p_full_name: 'x', p_role: 'staff', p_floor_id: null, p_permissions: [] })
    )
    expect(demote.hint).toBe('last_admin')
    const self = await rejects(db.rpc(admin.id, 'admin_set_user_active', { p_user_id: admin.id, p_active: false }))
    expect(self.hint).toBe('invalid_state')
  })

  it('admin can manage staff permissions and floors', async () => {
    const updated = await db.rpc<{ permissions: string[]; floor_id: number }>(admin.id, 'admin_update_user', {
      p_user_id: ground.id,
      p_full_name: 'Ground Staff',
      p_role: 'staff',
      p_floor_id: club.floors.first,
      p_permissions: ['apply_discount']
    })
    expect(updated.permissions).toEqual(['apply_discount'])
    expect(updated.floor_id).toBe(club.floors.first)
    const bad = await rejects(
      db.rpc(admin.id, 'admin_update_user', {
        p_user_id: ground.id,
        p_full_name: 'x',
        p_role: 'staff',
        p_floor_id: null,
        p_permissions: ['give_me_money']
      })
    )
    expect(bad.hint).toBe('invalid_input')
    // Deactivation takes effect immediately for every API call.
    await db.rpc(admin.id, 'admin_set_user_active', { p_user_id: ground.id, p_active: false })
    expect((await rejects(db.rpc(ground.id, 'get_my_profile'))).hint).toBe('not_authenticated')
    expect(await select(ground.id, `select * from public.club_tables`)).toHaveLength(0)
  })

  it('validates settings', async () => {
    expect((await rejects(db.rpc(admin.id, 'admin_update_settings', { p_settings: { business_timezone: 'Mars/Base' } }))).hint).toBe(
      'invalid_input'
    )
    expect((await rejects(db.rpc(admin.id, 'admin_update_settings', { p_settings: { billing_rounding: 'sideways' } }))).hint).toBe(
      'invalid_input'
    )
    const before = await db.one<{ h: number }>(`select day_start_hour h from public.settings`)
    const ok = await db.rpc<{ day_start_hour: number }>(admin.id, 'admin_update_settings', { p_settings: { day_start_hour: 6 } })
    expect(ok.day_start_hour).toBe(6)
    // Put it back: the seeded sale is dated by the old day start, so a later day
    // start would move "today" to yesterday whenever the suite runs before it.
    const restored = await db.rpc<{ day_start_hour: number }>(admin.id, 'admin_update_settings', { p_settings: { day_start_hour: before.h } })
    expect(restored.day_start_hour).toBe(before.h)
  })

  it('dashboard hides financial data from staff', async () => {
    const staffDash = await db.rpc<Record<string, unknown>>(groundSeller.id, 'get_dashboard')
    expect(staffDash.today).toBeUndefined()
    expect(staffDash.staff).toBeUndefined()
    expect(staffDash.lifetime_total).toBeUndefined()
    // Every staff member always sees their own open counter's figures.
    expect(staffDash.my_counter).toMatchObject({ status: 'open', total: 70, cash: 70, invoices: 1 })
    const plain = await db.rpc<Record<string, unknown>>(
      (await db.createUser('staff', { floorId: club.floors.ground })).id,
      'get_dashboard'
    )
    expect(plain.my_counter).toBeNull()
    const adminDash = await db.rpc<{ today: { total: number }; lifetime_total: number }>(admin.id, 'get_dashboard')
    expect(adminDash.today.total).toBe(70)
    expect(adminDash.lifetime_total).toBe(73)
  })

  it('switch targets expose names only', async () => {
    const rows = await db.rpcRows<Record<string, unknown>>(groundSeller.id, 'list_switch_targets')
    expect(Object.keys(rows[0]!).sort()).toEqual(['full_name', 'id', 'role', 'username'])
  })

  it('product search never returns cost price', async () => {
    const rows = await db.rpcRows<Record<string, unknown>>(ground.id === '' ? admin.id : groundSeller.id, 'search_products', {
      p_query: 'co'
    })
    expect(rows.map((r) => r.name)).toEqual(['Cola'])
    expect(rows[0]).not.toHaveProperty('cost_price')
  })
})
