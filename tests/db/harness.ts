/**
 * Runs the real Supabase migrations inside PGlite (PostgreSQL compiled to WASM)
 * with a minimal stand-in for Supabase's `auth` schema and API roles, so the
 * business rules, permission checks and Row Level Security can be exercised
 * exactly as PostgREST would call them: `set role authenticated` plus JWT
 * claims in `request.jwt.claims`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'supabase', 'migrations')

const SUPABASE_STUB = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
  $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`

export type Role = 'admin' | 'staff'

export interface TestUser {
  id: string
  username: string
}

export class TestDb {
  private constructor(
    readonly pg: PGlite,
    private pending: string[] = []
  ) {}

  /**
   * Applies the migrations in order. `stopBefore` (a filename prefix) leaves
   * that migration and later ones for `migrateRest()`, to test upgrades of a
   * database that already holds data.
   */
  static async create(opts: { stopBefore?: string } = {}): Promise<TestDb> {
    const pg = new PGlite()
    await pg.exec(SUPABASE_STUB)
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    const stop = opts.stopBefore ? files.findIndex((f) => f.startsWith(opts.stopBefore!)) : -1
    const now = stop >= 0 ? files.slice(0, stop) : files
    for (const file of now) {
      await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    return new TestDb(pg, stop >= 0 ? files.slice(stop) : [])
  }

  async migrateRest(): Promise<void> {
    for (const file of this.pending) {
      await this.pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    this.pending = []
  }

  /** Superuser query (bypasses RLS) — used for fixtures and assertions. */
  async sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pg.query<T>(query, params)
    return res.rows
  }

  async one<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T> {
    const rows = await this.sql<T>(query, params)
    if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`)
    return rows[0] as T
  }

  /**
   * Run statements as an API client: role `authenticated` with the given user
   * as JWT subject (or `anon` when userId is null).
   */
  async as<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
    await this.pg.exec(`set role ${userId ? 'authenticated' : 'anon'}`)
    await this.pg.query(`select set_config('request.jwt.claims', $1, false)`, [
      userId ? JSON.stringify({ sub: userId, role: 'authenticated' }) : ''
    ])
    try {
      return await fn()
    } finally {
      await this.pg.exec(`reset role`)
      await this.pg.query(`select set_config('request.jwt.claims', '', false)`)
    }
  }

  /**
   * Call an RPC as a user, like PostgREST does: scalar/jsonb results are
   * unwrapped, composite results come back as an object.
   */
  async rpc<T = unknown>(userId: string | null, fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const rows = await this.rpcRows<Record<string, unknown>>(userId, fn, args)
    const first = rows[0]
    if (!first) return null as T
    const keys = Object.keys(first)
    return (keys.length === 1 && keys[0] === fn ? first[fn] : first) as T
  }

  /** Call a set-returning RPC as a user. */
  async rpcRows<T = Record<string, unknown>>(
    userId: string | null,
    fn: string,
    args: Record<string, unknown> = {}
  ): Promise<T[]> {
    const names = Object.keys(args)
    const list = names.map((n, i) => `${n} => $${i + 1}`).join(', ')
    const values = names.map((n) => {
      const v = args[n]
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v
    })
    return this.as(userId, async () => {
      const res = await this.pg.query<T>(`select * from public.${fn}(${list})`, values)
      return res.rows
    })
  }

  async createUser(
    role: Role,
    opts: { username?: string; floorId?: number | null; permissions?: string[]; active?: boolean } = {}
  ): Promise<TestUser> {
    const id = randomUUID()
    const username = opts.username ?? `${role}${id.slice(0, 6)}`
    await this.sql(`insert into auth.users (id, email) values ($1, $2)`, [id, `${username}@fusion.local`])
    await this.sql(
      `insert into public.app_users (id, username, full_name, role, floor_id, permissions, is_active)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, username, `${role} ${username}`, role, opts.floorId ?? null, opts.permissions ?? [], opts.active ?? true]
    )
    return { id, username }
  }

  /** Opens the staff member's counter (payments and expenses need one). */
  async openCounter(userId: string): Promise<{ id: string }> {
    return this.rpc<{ id: string }>(userId, 'open_counter')
  }

  /** Shift a session's clock into the past so elapsed time is deterministic. */
  async ageSession(sessionId: string, seconds: number): Promise<void> {
    await this.sql(
      `update public.sessions set
         started_at = started_at - make_interval(secs => $2),
         paused_at = paused_at - make_interval(secs => $2),
         ended_at = ended_at - make_interval(secs => $2)
       where id = $1`,
      [sessionId, seconds]
    )
  }

  async close(): Promise<void> {
    await this.pg.close()
  }
}

/** Creates floors, a category, tables and products for a typical club. */
export async function seedClub(db: TestDb) {
  const [ground] = await db.sql<{ id: number }>(`insert into public.floors (name, sort_order) values ('Ground', 1) returning id`)
  const [first] = await db.sql<{ id: number }>(`insert into public.floors (name, sort_order) values ('First', 2) returning id`)
  // Rates are per minute; a database not yet upgraded past 0800 (upgrade
  // tests) still stores the same prices per hour.
  const perMinute =
    (await db.sql(
      `select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'table_categories' and column_name = 'rate_per_minute'`
    )).length > 0
  const category = (name: string, ratePerMinute: number) =>
    db.sql<{ id: number }>(
      perMinute
        ? `insert into public.table_categories (name, rate_per_minute) values ($1, $2) returning id`
        : `insert into public.table_categories (name, rate_per_hour) values ($1, $2) returning id`,
      [name, perMinute ? ratePerMinute : ratePerMinute * 60]
    )
  const [snooker] = await category('Snooker', 10)
  const [pool] = await category('Pool', 7.5)
  const [t1] = await db.sql<{ id: string }>(
    `insert into public.club_tables (name, category_id, floor_id) values ('Snooker 1', $1, $2) returning id`,
    [snooker!.id, ground!.id]
  )
  const [t2] = await db.sql<{ id: string }>(
    `insert into public.club_tables (name, category_id, floor_id) values ('Pool 1', $1, $2) returning id`,
    [pool!.id, first!.id]
  )
  const [cola] = await db.sql<{ id: string }>(
    `insert into public.inventory_products (name, category, cost_price, selling_price, stock_quantity)
     values ('Cola', 'Drinks', 60, 100, 10) returning id`
  )
  const [chips] = await db.sql<{ id: string }>(
    `insert into public.inventory_products (name, category, cost_price, selling_price, stock_quantity)
     values ('Chips', 'Snacks', 30, 50, 3) returning id`
  )
  const [tea] = await db.sql<{ id: string }>(
    `insert into public.inventory_products (name, category, cost_price, selling_price, track_stock)
     values ('Tea', 'Drinks', 20, 70, false) returning id`
  )
  return {
    floors: { ground: ground!.id, first: first!.id },
    categories: { snooker: snooker!.id, pool: pool!.id },
    tables: { snooker1: t1!.id, pool1: t2!.id },
    products: { cola: cola!.id, chips: chips!.id, tea: tea!.id }
  }
}

/** Await a promise expected to reject; returns the Postgres error. */
export async function rejects(p: Promise<unknown>): Promise<{ message: string; code?: string; hint?: string }> {
  try {
    await p
  } catch (e) {
    return e as { message: string; code?: string; hint?: string }
  }
  throw new Error('Expected the operation to fail, but it succeeded')
}
