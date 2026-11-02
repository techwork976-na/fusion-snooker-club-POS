import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { USERNAME_PATTERN, usernameToEmail, type Permission } from '@shared/constants'
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
  /** Signs in (or switches to) the given account. Throws AppError on failure. */
  signIn(username: string, password: string): Promise<Profile>
  signOut(notice?: string): Promise<void>
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [status, setStatus] = useState<Status>('loading')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const currentUserId = useRef<string | null>(null)

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

  const loadProfile = useCallback(async (): Promise<Profile | null> => {
    try {
      const p = await getMyProfile()
      applyProfile(p)
      return p
    } catch (e) {
      const err = toAppError(e)
      if (err.code === 'not_authenticated') {
        await supabase().auth.signOut({ scope: 'local' })
        setNotice('This account is not active. Ask an administrator for access.')
        applyProfile(null)
        return null
      }
      throw err
    }
  }, [applyProfile])

  useEffect(() => {
    let cancelled = false
    const client = supabase()
    void (async () => {
      const { data } = await client.auth.getSession()
      if (cancelled) return
      if (!data.session) return applyProfile(null)
      try {
        await loadProfile()
      } catch {
        if (!cancelled) {
          setNotice("Couldn't load your account. Check the connection and sign in again.")
          applyProfile(null)
        }
      }
    })()
    const { data: sub } = client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') setTimeout(() => applyProfile(null), 0)
    })
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [applyProfile, loadProfile])

  const signIn = useCallback(
    async (username: string, password: string) => {
      const u = username.trim().toLowerCase()
      if (!USERNAME_PATTERN.test(u)) throw new AppError('Enter a valid username.', 'invalid_input')
      if (!password) throw new AppError('Enter the password.', 'invalid_input')
      const { error } = await supabase().auth.signInWithPassword({ email: usernameToEmail(u), password })
      if (error) throw authError(error.message)
      setNotice(null)
      const p = await loadProfile()
      if (!p) throw new AppError('This account is not active.', 'deactivated')
      return p
    },
    [loadProfile]
  )

  const signOut = useCallback(
    async (message?: string) => {
      await supabase().auth.signOut({ scope: 'local' })
      setNotice(message ?? null)
      applyProfile(null)
    },
    [applyProfile]
  )

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
      signIn,
      signOut,
      verifyPassword,
      changePassword
    }),
    [status, profile, notice, signIn, signOut, verifyPassword, changePassword]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
