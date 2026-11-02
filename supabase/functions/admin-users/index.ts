// FUSION — admin-users Edge Function (Deno)
//
// The only component that holds the Supabase service-role key (injected by
// Supabase as SUPABASE_SERVICE_ROLE_KEY; it never ships in the desktop app).
// It performs the three operations that need the Auth Admin API:
//   create        create a login + profile for a new staff member or admin
//   set_password  reset a user's password
//   set_active    activate/deactivate a user (profile flag + Auth ban)
//   delete        permanently delete a login that has no history
//
// Authorization is enforced twice: this function checks the caller is an
// active admin, and every profile change goes through SQL functions called
// with the caller's own JWT, which re-check admin rights in the database.

import { createClient } from 'npm:@supabase/supabase-js@2'

// Must match AUTH_EMAIL_DOMAIN in src/shared/constants.ts and scripts/create-admin.mjs.
const AUTH_EMAIL_DOMAIN = 'fusion.local'
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/
const PERMISSIONS = new Set([
  'apply_discount',
  'delete_sales',
  'cancel_session',
  'counter_sale',
  'manage_customers',
  'adjust_stock',
  'view_own_sales'
])

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

function fail(status: number, error: string) {
  return reply(status, { error })
}

function validPassword(p: unknown): p is string {
  return typeof p === 'string' && p.length >= 8 && p.length <= 72
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return fail(405, 'Method not allowed.')

  const url = Deno.env.get('SUPABASE_URL')
  // The caller's own public key (sent by supabase-js) works with both legacy
  // anon keys and new publishable keys.
  const anonKey = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY')
  // Projects with legacy keys disabled: `supabase secrets set FUSION_SECRET_KEY=sb_secret_...`
  const serviceKey = Deno.env.get('FUSION_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) return fail(500, 'Server is not configured.')

  const authHeader = req.headers.get('Authorization') ?? ''
  const jwt = authHeader.replace(/^Bearer\s+/i, '')
  if (!jwt) return fail(401, 'Sign in again.')

  const adminApi = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  })

  // Verify the caller's token with Auth, then their admin role in the database.
  const { data: caller, error: callerError } = await adminApi.auth.getUser(jwt)
  if (callerError || !caller?.user) return fail(401, 'Your session has expired. Sign in again.')
  const { data: isAdmin, error: roleError } = await asCaller.rpc('fusion_is_admin')
  if (roleError || isAdmin !== true) return fail(403, 'Only an administrator can manage staff accounts.')

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return fail(400, 'Invalid request.')
  }

  switch (body.action) {
    case 'create': {
      const username = String(body.username ?? '').trim().toLowerCase()
      const fullName = String(body.full_name ?? '').trim()
      const role = body.role === 'admin' ? 'admin' : body.role === 'staff' ? 'staff' : null
      const floorId = body.floor_id == null ? null : Number(body.floor_id)
      const permissions = Array.isArray(body.permissions) ? body.permissions.map(String) : []
      if (!USERNAME_RE.test(username)) {
        return fail(400, 'Usernames use 3–32 lowercase letters, digits, dots, dashes or underscores.')
      }
      if (!fullName || fullName.length > 80) return fail(400, 'Name is required (up to 80 characters).')
      if (!role) return fail(400, 'Role must be Admin or Staff.')
      if (floorId !== null && !Number.isInteger(floorId)) return fail(400, 'Invalid floor.')
      if (permissions.some((p) => !PERMISSIONS.has(p))) return fail(400, 'Unknown permission.')
      if (!validPassword(body.password)) return fail(400, 'Password must be 8–72 characters.')

      const { data: created, error: createError } = await adminApi.auth.admin.createUser({
        email: `${username}@${AUTH_EMAIL_DOMAIN}`,
        password: body.password,
        email_confirm: true,
        user_metadata: { full_name: fullName, username }
      })
      if (createError || !created?.user) {
        const taken = /already|exists|registered/i.test(createError?.message ?? '')
        return fail(taken ? 409 : 400, taken ? `Username "${username}" is already taken.` : createError?.message ?? 'Could not create the account.')
      }

      const { data: profile, error: profileError } = await asCaller.rpc('admin_create_user_profile', {
        p_user_id: created.user.id,
        p_username: username,
        p_full_name: fullName,
        p_role: role,
        p_floor_id: floorId,
        p_permissions: permissions
      })
      if (profileError) {
        // Compensate so a half-created login never lingers.
        await adminApi.auth.admin.deleteUser(created.user.id)
        return fail(400, profileError.message)
      }
      return reply(200, { user: profile })
    }

    case 'set_password': {
      const userId = String(body.user_id ?? '')
      if (!validPassword(body.password)) return fail(400, 'Password must be 8–72 characters.')
      const { data: target } = await asCaller.from('app_users').select('id').eq('id', userId).maybeSingle()
      if (!target) return fail(404, 'User not found.')
      const { error } = await adminApi.auth.admin.updateUserById(userId, { password: body.password })
      if (error) return fail(400, error.message)
      return reply(200, { ok: true })
    }

    case 'set_active': {
      const userId = String(body.user_id ?? '')
      const active = body.active === true
      // The profile flag is checked by every RLS policy and RPC, so access is
      // revoked immediately; the Auth ban additionally blocks new sign-ins.
      const { data: profile, error } = await asCaller.rpc('admin_set_user_active', { p_user_id: userId, p_active: active })
      if (error) return fail(400, error.message)
      const { error: banError } = await adminApi.auth.admin.updateUserById(userId, {
        ban_duration: active ? 'none' : '876000h'
      })
      return reply(200, { user: profile, warning: banError ? 'Account flag updated, but the sign-in ban could not be applied.' : null })
    }

    case 'delete': {
      const userId = String(body.user_id ?? '')
      // The database decides whether the account is safe to delete (not you,
      // not the last admin, no sales/shift/session history). Even if history
      // appears after this check, its foreign keys make the delete fail.
      const { error: checkError } = await asCaller.rpc('admin_check_user_deletable', { p_user_id: userId })
      if (checkError) return fail(400, checkError.message)
      const { error } = await adminApi.auth.admin.deleteUser(userId)
      if (error) return fail(400, `The account could not be deleted: ${error.message}`)
      return reply(200, { ok: true })
    }

    default:
      return fail(400, 'Unknown action.')
  }
})
