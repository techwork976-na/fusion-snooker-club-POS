/**
 * A minimal, local stand-in for the Supabase HTTP APIs that FUSION uses —
 * Auth (password grant), PostgREST (table reads + RPC) and the admin-users
 * Edge Function — backed by the real migrations running in PGlite.
 *
 * TEST ONLY. It does not verify JWT signatures and keeps test passwords in
 * memory. It exists so the end-to-end suite drives the real Electron app,
 * the real supabase-js client and the real SQL functions/RLS together.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { TestDb } from '../db/harness'

const IDENT = /^[a-z_][a-z0-9_]*$/

/**
 * Fixed addresses for the end-to-end run: the web build bakes the test
 * server's URL in at build time (scripts/build-e2e.mjs), like a deployment.
 */
export const E2E = {
  supabasePort: 54329,
  supabaseUrl: 'http://127.0.0.1:54329',
  publishableKey: 'test-anon-key-for-local-e2e-only',
  appUrl: 'http://127.0.0.1:4173'
} as const

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function makeJwt(sub: string, email: string): string {
  const now = Math.floor(Date.now() / 1000)
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 })}.test-signature`
}

function subOf(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? ''
  const token = auth.replace(/^Bearer\s+/i, '')
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as { sub?: string }
    return payload.sub ?? null
  } catch {
    return null
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

export class FakeSupabase {
  readonly passwords = new Map<string, { id: string; password: string }>()
  private refresh = new Map<string, string>()
  url = ''
  private server = createServer((req, res) => {
    const started = Date.now()
    if (process.env.FAKE_SUPABASE_LOG) console.log('->', req.method, req.url)
    void this.exclusive(() => this.handle(req, res)).finally(() => {
      if (process.env.FAKE_SUPABASE_LOG) console.log('<-', req.method, req.url, res.statusCode, `${Date.now() - started}ms`)
    })
  })
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * PGlite has one connection and each API call switches role/JWT claims, so
   * requests (and test fixtures) run one at a time.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private constructor(readonly db: TestDb) {}

  static async start(port = 0): Promise<FakeSupabase> {
    const fake = new FakeSupabase(await TestDb.create())
    await new Promise<void>((resolve) => fake.server.listen(port, '127.0.0.1', resolve))
    fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`
    return fake
  }

  async stop() {
    await new Promise((r) => this.server.close(r))
    await this.db.close()
  }

  /** Creates a login + profile directly (like scripts/create-admin.mjs). */
  async addUser(username: string, password: string, role: 'admin' | 'staff', opts: { floorId?: number | null; permissions?: string[] } = {}) {
    const user = await this.db.createUser(role, { username, password, floorId: opts.floorId ?? null, permissions: opts.permissions ?? [] })
    this.passwords.set(`${username}@fusion.local`, { id: user.id, password })
    return user
  }

  private send(res: ServerResponse, status: number, body?: unknown) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
    })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }

  private session(id: string, email: string) {
    const refresh = randomUUID()
    this.refresh.set(refresh, id)
    return {
      access_token: makeJwt(id, email),
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refresh,
      user: this.userJson(id, email)
    }
  }

  private userJson(id: string, email: string) {
    return { id, email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      if (req.method === 'OPTIONS') return this.send(res, 204)
      const url = new URL(req.url ?? '/', this.url)
      const path = url.pathname

      if (path === '/auth/v1/settings') return this.send(res, 200, { external: {}, disable_signup: true })
      if (path === '/auth/v1/token') return await this.token(req, res, url.searchParams.get('grant_type'))
      if (path === '/auth/v1/logout') return this.send(res, 204)
      if (path === '/auth/v1/user') return await this.user(req, res)
      if (path.startsWith('/rest/v1/rpc/')) return await this.rpc(req, res, path.slice('/rest/v1/rpc/'.length))
      if (path.startsWith('/rest/v1/')) return await this.select(req, res, path.slice('/rest/v1/'.length), url.searchParams)
      if (path === '/functions/v1/admin-users') return await this.adminUsers(req, res)
      return this.send(res, 404, { message: 'not found' })
    } catch (e) {
      const err = e as { message?: string; code?: string; hint?: string; detail?: string }
      const status = err.code === '42501' ? 403 : err.code === 'P0002' ? 404 : 400
      return this.send(res, status, { message: err.message, code: err.code, hint: err.hint ?? null, details: err.detail ?? null })
    }
  }

  private async token(req: IncomingMessage, res: ServerResponse, grant: string | null) {
    const body = (await readBody(req)) as { email?: string; password?: string; refresh_token?: string }
    if (grant === 'password') {
      const entry = this.passwords.get(String(body.email))
      if (!entry || entry.password !== body.password) {
        return this.send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' })
      }
      return this.send(res, 200, this.session(entry.id, String(body.email)))
    }
    if (grant === 'refresh_token') {
      const id = this.refresh.get(String(body.refresh_token))
      const email = [...this.passwords.entries()].find(([, v]) => v.id === id)?.[0]
      if (!id || !email) return this.send(res, 400, { error: 'invalid_grant', msg: 'Invalid Refresh Token' })
      return this.send(res, 200, this.session(id, email))
    }
    return this.send(res, 400, { msg: 'unsupported grant' })
  }

  private async user(req: IncomingMessage, res: ServerResponse) {
    const sub = subOf(req)
    const email = [...this.passwords.entries()].find(([, v]) => v.id === sub)?.[0]
    if (!sub || !email) return this.send(res, 401, { msg: 'invalid JWT' })
    if (req.method === 'PUT') {
      const body = (await readBody(req)) as { password?: string }
      if (body.password) this.passwords.set(email, { id: sub, password: body.password })
    }
    return this.send(res, 200, this.userJson(sub, email))
  }

  private async rpc(req: IncomingMessage, res: ServerResponse, fn: string) {
    if (!IDENT.test(fn)) return this.send(res, 404, { message: 'unknown function' })
    const args = ((await readBody(req)) ?? {}) as Record<string, unknown>
    const [meta] = await this.db.sql<{ retset: boolean; typtype: string; typname: string; names: string[] | null; types: string[] }>(
      `select p.proretset as retset, t.typtype, t.typname, p.proargnames as names,
              array(select format_type(x, null) from unnest(p.proargtypes) x) as types
       from pg_proc p join pg_type t on t.oid = p.prorettype
       where p.proname = $1 and p.pronamespace = 'public'::regnamespace`,
      [fn]
    )
    if (!meta) return this.send(res, 404, { message: `function ${fn} not found` })
    const names = meta.names ?? []
    const parts: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(args)) {
      const idx = names.indexOf(key)
      if (idx < 0 || !IDENT.test(key)) return this.send(res, 400, { message: `unknown argument ${key}` })
      const type = meta.types[idx]!
      values.push(value === null || value === undefined ? null : type === 'jsonb' || type.endsWith('[]') ? JSON.stringify(value) : String(value))
      const n = values.length
      parts.push(
        type.endsWith('[]')
          ? `${key} => (select coalesce(array_agg(x), '{}') from jsonb_array_elements_text($${n}::jsonb) x)::${type}`
          : `${key} => $${n}::${type}`
      )
    }
    const call = `public.${fn}(${parts.join(', ')})`
    const sql = meta.retset
      ? `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as v from ${call} r`
      : meta.typtype === 'c'
        ? `select to_jsonb(r) as v from ${call} r`
        : meta.typname === 'void'
          ? `select null::jsonb as v from (select ${call}) r`
          : `select to_jsonb(${call}) as v`
    const rows = await this.db.as(subOf(req), () => this.db.pg.query<{ v: unknown }>(sql, values).then((r) => r.rows))
    const v = rows[0]?.v ?? null
    return this.send(res, 200, meta.typtype === 'c' && v && (v as { id?: unknown }).id === null ? null : v)
  }

  private async select(req: IncomingMessage, res: ServerResponse, table: string, params: URLSearchParams) {
    if (!IDENT.test(table)) return this.send(res, 404, { message: 'unknown table' })
    const cols = (params.get('select') ?? '*').split(',').map((c) => c.trim())
    if (cols.some((c) => c !== '*' && !IDENT.test(c))) return this.send(res, 400, { message: 'unsupported select' })
    const where: string[] = []
    const values: unknown[] = []
    let order = ''
    let limit = ''
    for (const [key, raw] of params.entries()) {
      if (key === 'select') continue
      if (key === 'order') {
        order = ` order by ${raw
          .split(',')
          .map((o) => {
            const [c, dir] = o.split('.')
            if (!IDENT.test(c!)) throw new Error('bad order')
            return `${c} ${dir === 'desc' ? 'desc' : 'asc'}`
          })
          .join(', ')}`
        continue
      }
      if (key === 'limit') {
        limit = ` limit ${Number(raw) | 0}`
        continue
      }
      if (!IDENT.test(key)) throw new Error('bad filter')
      const dot = raw.indexOf('.')
      const op = raw.slice(0, dot)
      const value = raw.slice(dot + 1)
      const sqlOp = { eq: '=', neq: '<>', gte: '>=', lte: '<=', gt: '>', lt: '<' }[op]
      if (!sqlOp) throw new Error(`unsupported operator ${op}`)
      values.push(value)
      where.push(`${key}::text ${sqlOp === '=' || sqlOp === '<>' ? sqlOp : sqlOp} $${values.length}`)
    }
    // Comparisons are done on text for eq/neq and natively for ranges.
    const conditions = where.map((w) => (/ (>=|<=|>|<) /.test(w) ? w.replace('::text', '') : w))
    const sql = `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as v from (select ${cols.join(', ')} from public.${table}${
      conditions.length ? ` where ${conditions.join(' and ')}` : ''
    }${order}${limit}) r`
    const rows = await this.db.as(subOf(req), () => this.db.pg.query<{ v: unknown }>(sql, values).then((r) => r.rows))
    return this.send(res, 200, rows[0]?.v ?? [])
  }

  /** Mirrors supabase/functions/admin-users against the local database. */
  private async adminUsers(req: IncomingMessage, res: ServerResponse) {
    const caller = subOf(req)
    const isAdmin = await this.db.rpc<boolean>(caller, 'fusion_is_admin')
    if (!isAdmin) return this.send(res, 403, { error: 'Only an administrator can manage staff accounts.' })
    const body = (await readBody(req)) as Record<string, unknown>
    if (body.action === 'create') {
      const id = randomUUID()
      const email = `${body.username}@fusion.local`
      if (this.passwords.has(email)) return this.send(res, 409, { error: `Username "${body.username}" is already taken.` })
      await this.db.sql(`insert into auth.users (id, email) values ($1, $2)`, [id, email])
      try {
        const user = await this.db.rpc(caller, 'admin_create_user_profile', {
          p_user_id: id,
          p_username: body.username,
          p_full_name: body.full_name,
          p_role: body.role,
          p_floor_id: body.floor_id,
          p_permissions: body.permissions
        })
        this.passwords.set(email, { id, password: String(body.password) })
        return this.send(res, 200, { user })
      } catch (e) {
        await this.db.sql(`delete from auth.users where id = $1`, [id])
        return this.send(res, 400, { error: (e as Error).message })
      }
    }
    if (body.action === 'set_password') {
      const entry = [...this.passwords.entries()].find(([, v]) => v.id === body.user_id)
      if (!entry) return this.send(res, 404, { error: 'User not found.' })
      this.passwords.set(entry[0], { id: entry[1].id, password: String(body.password) })
      return this.send(res, 200, { ok: true })
    }
    if (body.action === 'set_active') {
      const user = await this.db.rpc(caller, 'admin_set_user_active', { p_user_id: body.user_id, p_active: body.active })
      return this.send(res, 200, { user, warning: null })
    }
    if (body.action === 'delete') {
      try {
        await this.db.rpc(caller, 'admin_check_user_deletable', { p_user_id: body.user_id })
        await this.db.sql(`delete from auth.users where id = $1`, [body.user_id])
      } catch (e) {
        return this.send(res, 400, { error: (e as Error).message })
      }
      for (const [email, v] of this.passwords) if (v.id === body.user_id) this.passwords.delete(email)
      return this.send(res, 200, { ok: true })
    }
    return this.send(res, 400, { error: 'Unknown action.' })
  }
}
