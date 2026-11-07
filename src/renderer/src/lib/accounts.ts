import type { Role } from './types'
import { isDesktop } from './platform'

/**
 * The accounts signed in on this device ("Instagram-style" switching): each
 * keeps its own Supabase session, so one click switches between them all day
 * with no password and no time limit, until "Log out of all accounts".
 *
 * Only real Supabase sessions are kept here — each account's own refresh and
 * access token, issued when that account signed in with its password. The
 * database still authorises every request by the one account it comes from
 * (auth.uid(), permissions, floors, RLS): switching changes which account's
 * session the app uses, never what an account may do.
 *
 * Stored with the active session: the desktop app keeps it in the OS keychain
 * (main process), the browser in this site's local storage.
 */
export interface StoredSession {
  access_token: string
  refresh_token: string
  expires_at?: number
}

export interface StoredAccount {
  userId: string
  username: string
  fullName: string
  role: Role
  floorName: string | null
  avatarPath: string | null
  session: StoredSession
  /** Last time this account was the active one (most recent first in the list). */
  usedAt: number
}

export const ACCOUNTS_KEY = 'fusion-accounts'

async function read(): Promise<string | null> {
  if (isDesktop) return (await window.fusion.secureStore.get(ACCOUNTS_KEY)) ?? null
  try {
    return localStorage.getItem(ACCOUNTS_KEY)
  } catch {
    return null
  }
}

async function write(value: string | null): Promise<void> {
  if (isDesktop) {
    if (value === null) await window.fusion.secureStore.remove(ACCOUNTS_KEY)
    else await window.fusion.secureStore.set(ACCOUNTS_KEY, value)
    return
  }
  try {
    if (value === null) localStorage.removeItem(ACCOUNTS_KEY)
    else localStorage.setItem(ACCOUNTS_KEY, value)
  } catch {
    // Storage blocked (private mode): switching then falls back to signing in again.
  }
}

function valid(a: unknown): a is StoredAccount {
  const x = a as StoredAccount
  return Boolean(x && typeof x.userId === 'string' && x.session && typeof x.session.refresh_token === 'string' && typeof x.username === 'string')
}

export async function loadAccounts(): Promise<StoredAccount[]> {
  try {
    const raw = await read()
    const list = raw ? (JSON.parse(raw) as unknown[]) : []
    return Array.isArray(list) ? sortAccounts(list.filter(valid)) : []
  } catch {
    return []
  }
}

export async function saveAccounts(list: StoredAccount[]): Promise<void> {
  await write(list.length ? JSON.stringify(sortAccounts(list)) : null)
}

export function sortAccounts(list: StoredAccount[]): StoredAccount[] {
  return [...list].sort((a, b) => b.usedAt - a.usedAt)
}

/** Adds or replaces one account (by user id), keeping the others. */
export function upsertAccount(list: StoredAccount[], account: StoredAccount): StoredAccount[] {
  return sortAccounts([account, ...list.filter((a) => a.userId !== account.userId)])
}

/** Updates the stored session of an account already on the device (its tokens rotate on every refresh). */
export function withSession(list: StoredAccount[], userId: string, session: StoredSession): StoredAccount[] {
  return list.map((a) => (a.userId === userId ? { ...a, session } : a))
}

export function removeAccount(list: StoredAccount[], userId: string): StoredAccount[] {
  return list.filter((a) => a.userId !== userId)
}
