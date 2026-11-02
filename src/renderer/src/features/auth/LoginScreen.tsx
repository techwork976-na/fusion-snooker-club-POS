import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { errorMessage } from '@/lib/errors'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/Field'
import { BareTitleBar } from '@/layout/TopBar'
import { Logo } from '@/layout/Brand'
import { useAuth } from './AuthProvider'
import { BrandPanel } from './BrandPanel'

const LAST_USER_KEY = 'fusion.lastUsername'

function readLastUser(): string {
  try {
    return localStorage.getItem(LAST_USER_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * Waits after repeated wrong passwords (2 s, 4 s, 8 s … up to 30 s). Supabase
 * Auth rate-limits sign-ins on the server; this only slows guessing from the
 * screen itself.
 */
function cooldownFor(failures: number): number {
  return failures < 3 ? 0 : Math.min(30, 2 ** (failures - 2))
}

export function LoginScreen() {
  const { signIn, notice } = useAuth()
  const [username, setUsername] = useState(readLastUser)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState(0)
  const [waitUntil, setWaitUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  const waiting = Math.max(0, Math.ceil((waitUntil - now) / 1000))
  useEffect(() => {
    if (waitUntil <= Date.now()) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [waitUntil])

  const submit = async () => {
    if (waiting > 0) return
    setBusy(true)
    setError(null)
    try {
      await signIn(username, password)
      setFailures(0)
      try {
        localStorage.setItem(LAST_USER_KEY, username.trim().toLowerCase())
      } catch {
        // Remembering the username is only a convenience.
      }
    } catch (e) {
      const next = failures + 1
      setFailures(next)
      setWaitUntil(Date.now() + cooldownFor(next) * 1000)
      setNow(Date.now())
      setError(errorMessage(e))
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex h-full flex-col bg-canvas">
      <BareTitleBar />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
        <BrandPanel />

        <section className="flex items-center justify-center px-6 sm:px-8">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-[380px]"
          >
            <div className="mb-8 lg:hidden">
              <Logo size={88} />
            </div>
            <p className="label !text-brass-700">FUSION Gaming Lounge</p>
            <h1 className="mt-2.5 font-display-tight text-[36px] leading-tight text-forest-950">Sign in</h1>
            <p className="mt-2 mb-8 text-sm text-fg-3">Use the username and password your administrator gave you.</p>
            {notice && <div className="mb-5 rounded-2xl bg-brass-50 px-4 py-3 text-sm text-brass-800">{notice}</div>}
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              <TextField
                label="Username"
                autoComplete="username"
                autoFocus={!username}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                spellCheck={false}
                autoCapitalize="none"
                data-testid="login-username"
              />
              <TextField
                label="Password"
                type="password"
                autoComplete="current-password"
                autoFocus={Boolean(username)}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={error}
                data-testid="login-password"
              />
              <Button type="submit" variant="primary" size="lg" className="mt-2 w-full" loading={busy} disabled={!username || !password || waiting > 0}>
                {waiting > 0 ? `Try again in ${waiting} s` : 'Sign in'}
              </Button>
            </form>
            <p className="mt-10 text-xs leading-relaxed text-fg-4">
              Forgot your password? An administrator can set a new one under Staff.
            </p>
          </motion.div>
        </section>
      </div>
    </div>
  )
}
