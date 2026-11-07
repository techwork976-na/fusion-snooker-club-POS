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
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'supabase', 'migrations')

const SUPABASE_STUB = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create schema auth;
  create schema extensions;
  create extension pgcrypto with schema extensions;
  -- Supabase Auth keeps a bcrypt hash of each password here.
  create table auth.users (id uuid primary key, email text, encrypted_password varchar(255));
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
  $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  -- Supabase Storage keeps buckets and files here; its policies run as the API roles.
  create schema storage;
  create table storage.buckets (
    id text primary key, name text not null, public boolean not null default false,
    file_size_limit bigint, allowed_mime_types text[], owner uuid,
    created_at timestamptz default now(), updated_at timestamptz default now());
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text not null,
    owner uuid default auth.uid(), metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now(),
    unique (bucket_id, name));
  alter table storage.objects enable row level security;
  -- The folders of a path ("<user id>/<file>" → {<user id>}), as Supabase defines it.
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  $$;
  grant usage on schema storage to anon, authenticated, service_role;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant select on storage.buckets to anon, authenticated;
  grant execute on function storage.foldername(text) to anon, authenticated;
`

export type Role = 'admin' | 'staff'

export interface TestUser {
  id: string
  username: string
}

/** Every test login's password unless a test chooses another. */
export const TEST_PASSWORD = 'test-password-123'

export class TestDb {
  private constructor(
    readonly pg: PGlite,
    private pending: string[] = [],
    private readonly shipped = false
  ) {}

  /**
   * Applies the migrations in order. `stopBefore` (a filename prefix) leaves
   * that migration and later ones for `migrateRest()`, to test upgrades of a
   * database that already holds data.
   */
  static async create(opts: { stopBefore?: string; shippedSettings?: boolean } = {}): Promise<TestDb> {
    const pg = new PGlite({ extensions: { pgcrypto } })
    await pg.exec(SUPABASE_STUB)
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    const stop = opts.stopBefore ? files.findIndex((f) => f.startsWith(opts.stopBefore!)) : -1
    const now = stop >= 0 ? files.slice(0, stop) : files
    for (const file of now) {
      await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    const db = new TestDb(pg, stop >= 0 ? files.slice(stop) : [], Boolean(opts.shippedSettings))
    await db.pinTestPolicy()
    return db
  }

  async migrateRest(): Promise<void> {
    for (const file of this.pending) {
      await this.pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    this.pending = []
    await this.pinTestPolicy()
  }

  /**
   * The club bills completed minutes only since migration 1800 ("round down").
   * The suites written for the earlier "every started minute" policy keep it,
   * so their figures stay meaningful; `shippedSettings: true` keeps the
   * settings exactly as the migrations leave them (the round-down tests).
   */
  private async pinTestPolicy(): Promise<void> {
    if (this.shipped) return
    const [col] = (await this.pg.query<{ n: number }>(
      `select count(*)::int n from information_schema.columns where table_schema = 'public' and table_name = 'settings' and column_name = 'billing_rounding'`
    )).rows
    if (col?.n) await this.pg.exec(`update public.settings set billing_rounding = 'up' where billing_rounding <> 'up'`)
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
    opts: { username?: string; floorId?: number | null; permissions?: string[]; active?: boolean; password?: string } = {}
  ): Promise<TestUser> {
    const id = randomUUID()
    const username = opts.username ?? `${role}${id.slice(0, 6)}`
    await this.sql(
      `insert into auth.users (id, email, encrypted_password) values ($1, $2, extensions.crypt($3, extensions.gen_salt('bf', 4)))`,
      [id, `${username}@fusion.local`, opts.password ?? TEST_PASSWORD]
    )
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
