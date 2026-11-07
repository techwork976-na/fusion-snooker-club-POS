import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { USERNAME_PATTERN, usernameToEmail, type Permission } from '@shared/constants'
import {
  ACCOUNTS_KEY,
  loadAccounts,
  removeAccount,
  saveAccounts,
  sortAccounts,
  upsertAccount,
  withSession,
  type StoredAccount,
  type StoredSession
} from '@/lib/accounts'
import { AppError, toAppError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import type { Profile } from '@/lib/types'
import { getMyProfile } from '@/data/api'

type Status = 'loading' | 'signed-out' | 'signed-in'

interface AuthContextValue {
  status: Status
  profile: Profile | null
  /** Message shown on the sign-in screen (e.g. why the user was signed out). */
  notice: string | null
  isAdmin: boolean
  can(permission: Permission): boolean
  /** Every account signed in on this device, the active one first. */
  accounts: StoredAccount[]
  /** Signs an account in with its password, keeps it on this device and switches to it. Throws AppError on failure. */
  signIn(username: string, password: string): Promise<Profile>
  /** Switches to an account already signed in on this device — no password. */
  switchTo(userId: string): Promise<Profile>
  /** Signs the active account out; another account on this device (if any) takes over. */
  signOut(notice?: string): Promise<void>
  /** Signs every account on this device out (end of the night): passwords are needed again. */
  signOutAll(notice?: string): Promise<void>
  /** Reloads the active account's profile (e.g. after a new profile picture). */
  refreshProfile(): Promise<void>
  /** Re-verifies the signed-in user's password (used before changing it). */
  verifyPassword(password: string): Promise<void>
  changePassword(newPassword: string): Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function authError(message: string): AppError {
  if (/invalid login credentials/i.test(message)) return new AppError('Incorrect username or password.', 'invalid_credentials')
  if (/banned|disabled/i.test(message)) return new AppError('This account has been deactivated.', 'deactivated')
  if (/rate limit|too many/i.test(message)) return new AppError('Too many attempts. Wait a minute and try again.', 'rate_limited')
  return toAppError({ message })
}

const tokens = (s: Session): StoredSession => ({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at })

const stored = (p: Profile, s: Session): StoredAccount => ({
  userId: p.id,
  username: p.username,
  fullName: p.full_name,
  role: p.role,
  floorName: p.floor_name,
  avatarPath: p.avatar_path ?? null,
  session: tokens(s),
  usedAt: Date.now()
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [status, setStatus] = useState<Status>('loading')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<StoredAccount[]>([])
  const accountsRef = useRef<StoredAccount[]>([])
  const currentUserId = useRef<string | null>(null)
  // While this device changes accounts itself, the auth events it causes are not "signed out".
  const changing = useRef(false)

  const applyProfile = useCallback(
    (p: Profile | null) => {
      // Never let one account's cached data be shown to another.
      if (currentUserId.current !== (p?.id ?? null)) qc.clear()
      currentUserId.current = p?.id ?? null
      setProfile(p)
      setStatus(p ? 'signed-in' : 'signed-out')
    },
    [qc]
  )

  const commit = useCallback(async (list: StoredAccount[]) => {
    accountsRef.current = sortAccounts(list)
    setAccounts(accountsRef.current)
    await saveAccounts(accountsRef.current)
  }, [])

  const remember = useCallback((p: Profile, s: Session) => commit(upsertAccount(accountsRef.current, stored(p, s))), [commit])

  /** Writes the active session (its tokens rotate) back into its account before another account takes over. */
  const snapshot = useCallback(async () => {
    const { data } = await supabase().auth.getSession()
    const s = data.session
    if (s && accountsRef.current.some((a) => a.userId === s.user.id)) await commit(withSession(accountsRef.current, s.user.id, tokens(s)))
  }, [commit])

  const loadProfile = useCallback(async (): Promise<Profile | null> => {
    try {
      const p = await getMyProfile()
      applyProfile(p)
      return p
    } catch (e) {
      const err = toAppError(e)
      if (err.code === 'not_authenticated') {
        const { data } = await supabase().auth.getSession()
        if (data.session) await commit(removeAccount(accountsRef.current, data.session.user.id))
        await supabase().auth.signOut({ scope: 'local' })
        setNotice('This account is not active. Ask an administrator for access.')
        applyProfile(null)
        return null
      }
      throw err
    }
  }, [applyProfile, commit])

  /** Makes a stored account the active one; an account whose session was ended elsewhere is dropped from this device. */
  const activate = useCallback(
    async (a: StoredAccount): Promise<Profile> => {
      const { data, error } = await supabase().auth.setSession({ access_token: a.session.access_token, refresh_token: a.session.refresh_token })
      if (error || !data.session) {
        await commit(removeAccount(accountsRef.current, a.userId))
        throw new AppError(`${a.fullName} was signed out — sign in again with the password.`, 'session_expired')
      }
      const p = await loadProfile()
      if (!p) throw new AppError(`${a.fullName} can no longer sign in.`, 'deactivated')
      await remember(p, data.session)
      return p
    },
    [commit, loadProfile, remember]
  )

  useEffect(() => {
    let cancelled = false
    const client = supabase()
    void (async () => {
      accountsRef.current = await loadAccounts()
      setAccounts(accountsRef.current)
      const { data } = await client.auth.getSession()
      if (cancelled) return
      try {
        if (data.session) {
          const p = await loadProfile()
          if (p && !cancelled) await remember(p, data.session)
          return
        }
        // The active session is gone (e.g. revoked) but other accounts are still on this device.
        for (const a of [...accountsRef.current]) {
          try {
            changing.current = true
            await activate(a)
            return
          } catch {
            // That one needs its password again; try the next.
          } finally {
            changing.current = false
          }
        }
        applyProfile(null)
      } catch {
        if (!cancelled) {
          setNotice("Couldn't load your account. Check the connection and sign in again.")
          applyProfile(null)
        }
      }
    })()
    const { data: sub } = client.auth.onAuthStateChange((event, session) => {
      // Keep each account's rotating tokens current (no Supabase calls inside this callback).
      if (session && (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'USER_UPDATED')) {
        if (accountsRef.current.some((a) => a.userId === session.user.id)) {
          void commit(withSession(accountsRef.current, session.user.id, tokens(session)))
        }
        // Another tab of this browser switched accounts: follow it.
        if (!changing.current && currentUserId.current && session.user.id !== currentUserId.current) setTimeout(() => void loadProfile(), 0)
      }
      if (event === 'SIGNED_OUT' && !changing.current) setTimeout(() => applyProfile(null), 0)
    })
    // Another tab added or removed an account.
    const onStorage = (e: StorageEvent) => {
      if (e.key === ACCOUNTS_KEY) void loadAccounts().then((list) => !cancelled && ((accountsRef.current = list), setAccounts(list)))
    }
    window.addEventListener('storage', onStorage)
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
      window.removeEventListener('storage', onStorage)
    }
  }, [activate, applyProfile, commit, loadProfile, remember])

  const signIn = useCallback(
    async (username: string, password: string) => {
      const u = username.trim().toLowerCase()
      if (!USERNAME_PATTERN.test(u)) throw new AppError('Enter a valid username.', 'invalid_input')
      if (!password) throw new AppError('Enter the password.', 'invalid_input')
      changing.current = true
      try {
        await snapshot()
        const { data, error } = await supabase().auth.signInWithPassword({ email: usernameToEmail(u), password })
        if (error || !data.session) throw authError(error?.message ?? 'Sign-in failed.')
        setNotice(null)
        const p = await loadProfile()
        if (!p) throw new AppError('This account is not active.', 'deactivated')
        await remember(p, data.session)
        return p
      } finally {
        changing.current = false
      }
    },
    [loadProfile, remember, snapshot]
  )

  const switchTo = useCallback(
    async (userId: string) => {
      const target = accountsRef.current.find((a) => a.userId === userId)
      if (!target) throw new AppError('That account is not signed in on this device.', 'not_found')
      changing.current = true
      try {
        await snapshot()
        const previous = accountsRef.current.find((a) => a.userId === currentUserId.current)
        try {
          return await activate(target)
        } catch (e) {
          // Stay with (or return to) the account that was active.
          if (previous && previous.userId !== userId) await activate(previous).catch(() => applyProfile(null))
          throw e
        }
      } finally {
        changing.current = false
      }
    },
    [activate, applyProfile, snapshot]
  )

  const signOut = useCallback(
    async (message?: string) => {
      changing.current = true
      try {
        const leaving = currentUserId.current
        await supabase().auth.signOut({ scope: 'local' })
        const rest = leaving ? removeAccount(accountsRef.current, leaving) : accountsRef.current
        await commit(rest)
        for (const next of rest) {
          try {
            await activate(next)
            setNotice(null)
            return
          } catch {
            // Needs its password again (already dropped); try the next.
          }
        }
        setNotice(message ?? null)
        applyProfile(null)
      } finally {
        changing.current = false
      }
    },
    [activate, applyProfile, commit]
  )

  const signOutAll = useCallback(
    async (message?: string) => {
      changing.current = true
      setStatus('loading')
      try {
        await snapshot()
        const client = supabase()
        // End each account's session on the server, so its tokens can never be used again.
        for (const a of accountsRef.current) {
          try {
            const { error } = await client.auth.setSession({ access_token: a.session.access_token, refresh_token: a.session.refresh_token })
            if (!error) await client.auth.signOut({ scope: 'local' })
          } catch {
            // Already ended elsewhere.
          }
        }
        await client.auth.signOut({ scope: 'local' }).catch(() => undefined)
        await commit([])
        setNotice(message ?? null)
        applyProfile(null)
      } finally {
        changing.current = false
      }
    },
    [applyProfile, commit, snapshot]
  )

  const refreshProfile = useCallback(async () => {
    const p = await loadProfile()
    const { data } = await supabase().auth.getSession()
    if (p && data.session) await remember(p, data.session)
  }, [loadProfile, remember])

  const verifyPassword = useCallback(
    async (password: string) => {
      if (!profile) throw new AppError('Not signed in.')
      const { error } = await supabase().auth.signInWithPassword({ email: usernameToEmail(profile.username), password })
      if (error) throw new AppError('The current password is incorrect.', 'invalid_credentials')
    },
    [profile]
  )

  const changePassword = useCallback(async (newPassword: string) => {
    const { error } = await supabase().auth.updateUser({ password: newPassword })
    if (error) throw toAppError(error)
    // Anyone still signed in elsewhere with the old password is signed out.
    await supabase().auth.signOut({ scope: 'others' })
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      profile,
      notice,
      isAdmin: profile?.role === 'admin',
      can: (perm) => profile?.role === 'admin' || Boolean(profile?.permissions.includes(perm)),
      accounts,
      signIn,
      switchTo,
      signOut,
      signOutAll,
      refreshProfile,
      verifyPassword,
      changePassword
    }),
    [status, profile, notice, accounts, signIn, switchTo, signOut, signOutAll, refreshProfile, verifyPassword, changePassword]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
