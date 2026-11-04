/**
 * Migration 1400 (security audit): the stock log, staff-scoped switch targets,
 * no API access to internal helpers, and closed-by-default privileges for
 * objects that future migrations create.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

type Adjustment = { delta: number; stock_after: number; source: string; user_name: string | null }

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let restocker: TestUser
let seller: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  restocker = await db.createUser('staff', { floorId: null, permissions: ['adjust_stock'] })
  seller = await db.createUser('staff', { floorId: null, permissions: ['counter_sale'] })
})
afterEach(async () => db.close())

const history = (product: string, user = admin.id) => db.rpc<Adjustment[]>(user, 'get_stock_adjustments', { p_product_id: product })

describe('stock log', () => {
  it('records every restock and correction with who made it and the stock afterwards', async () => {
    await db.rpc(restocker.id, 'adjust_stock', { p_product_id: club.products.cola, p_delta: 12 })
    await db.rpc(admin.id, 'adjust_stock', { p_product_id: club.products.cola, p_delta: -2 })
    // A refused change (below zero) leaves no entry.
    expect((await rejects(db.rpc(restocker.id, 'adjust_stock', { p_product_id: club.products.cola, p_delta: -500 }))).hint).toBe('insufficient_stock')
    expect((await rejects(db.rpc(seller.id, 'adjust_stock', { p_product_id: club.products.cola, p_delta: 5 }))).hint).toBe('forbidden')

    const log = await history(club.products.cola)
    expect(log.map((a) => [a.delta, a.stock_after, a.source])).toEqual([
      [-2, 20, 'adjust'],
      [12, 22, 'adjust']
    ])
    expect(log.map((a) => a.user_name)).toEqual([`admin ${admin.username}`, `staff ${restocker.username}`])
  })

  it("logs a new product's opening stock; editing a product never changes stock or the log", async () => {
    const product = await db.rpc<{ id: string; stock_quantity: number }>(admin.id, 'admin_save_product', {
      p_id: null, p_name: 'Red Bull', p_category: 'Drinks', p_cost_price: 300, p_selling_price: 450,
      p_track_stock: true, p_low_stock_threshold: 5, p_initial_stock: 24
    })
    const empty = await db.rpc<{ id: string }>(admin.id, 'admin_save_product', {
      p_id: null, p_name: 'Juice', p_category: 'Drinks', p_cost_price: 50, p_selling_price: 90,
      p_track_stock: true, p_low_stock_threshold: 5, p_initial_stock: 0
    })
    await db.rpc(admin.id, 'admin_save_product', {
      p_id: product.id, p_name: 'Red Bull 250ml', p_category: 'Drinks', p_cost_price: 300, p_selling_price: 500,
      p_track_stock: true, p_low_stock_threshold: 5
    })
    expect((await history(product.id)).map((a) => [a.delta, a.stock_after, a.source])).toEqual([[24, 24, 'opening']])
    expect(await history(empty.id)).toEqual([])
  })

  it('cannot be read or written directly, and only administrators can see it', async () => {
    await db.rpc(restocker.id, 'adjust_stock', { p_product_id: club.products.cola, p_delta: 3 })
    for (const user of [restocker.id, admin.id, null]) {
      const read = await rejects(db.as(user, () => db.sql(`select * from public.stock_adjustments`)))
      expect(read.message, String(user)).toMatch(/permission denied/)
      const write = await rejects(
        db.as(user, () => db.sql(`insert into public.stock_adjustments (product_id, delta, stock_after, source) values ($1, 5, 5, 'adjust')`, [club.products.cola]))
      )
      expect(write.message).toMatch(/permission denied/)
    }
    expect((await rejects(history(club.products.cola, restocker.id))).hint).toBe('forbidden')
  })
})

describe('least privilege', () => {
  it('staff see only the admin accounts they can switch to; administrators see everyone', async () => {
    const forStaff = await db.rpcRows<{ username: string; role: string }>(seller.id, 'list_switch_targets')
    expect(forStaff.map((r) => r.role)).toEqual(['admin'])
    const forAdmin = await db.rpcRows<{ username: string; role: string }>(admin.id, 'list_switch_targets')
    expect(forAdmin.map((r) => r.username).sort()).toEqual([admin.username, restocker.username, seller.username].sort())
  })

  it('internal billing helpers cannot be called through the API', async () => {
    for (const call of [
      `select public.fusion_billed_minutes(600, 1, 'up', 0)`,
      `select public.fusion_amount_for_minutes(10, 10)`,
      `select public.fusion_session_charge(600, 10, null, null, 1, 'up', 0)`
    ]) {
      expect((await rejects(db.as(seller.id, () => db.sql(call)))).message, call).toMatch(/permission denied/)
    }
    // The database's own functions still use them.
    const s = await db.rpc<{ id: string }>(seller.id, 'start_session', { p_table_id: club.tables.snooker1 })
    await db.ageSession(s.id, 600)
    expect((await db.rpc<{ base_amount: string }>(seller.id, 'end_session', { p_session_id: s.id })).base_amount).toBe('100.00')
  })

  it('objects a future migration creates in public start closed to the API roles', async () => {
    await db.sql(`create table public.future_feature (id int primary key)`)
    await db.sql(`create function public.future_fn() returns int language sql as 'select 1'`)
    const [row] = await db.sql<Record<string, boolean>>(
      `select has_table_privilege('authenticated', 'public.future_feature', 'select') as auth_read,
              has_table_privilege('anon', 'public.future_feature', 'insert') as anon_write,
              has_function_privilege('authenticated', 'public.future_fn()', 'execute') as auth_exec,
              has_function_privilege('anon', 'public.future_fn()', 'execute') as anon_exec`
    )
    expect(row).toEqual({ auth_read: false, anon_write: false, auth_exec: false, anon_exec: false })
    // Existing objects keep exactly the access they were given.
    const [kept] = await db.sql<Record<string, boolean>>(
      `select has_table_privilege('authenticated', 'public.sales', 'select') as sales_read,
              has_table_privilege('authenticated', 'public.sales', 'insert') as sales_write,
              has_function_privilege('authenticated', 'public.complete_checkout(uuid,text,uuid,jsonb,numeric,uuid,text,text,numeric,numeric)', 'execute') as checkout`
    )
    expect(kept).toEqual({ sales_read: true, sales_write: false, checkout: true })
  })
})
