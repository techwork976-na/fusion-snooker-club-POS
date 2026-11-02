import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { BrowserRouter, HashRouter } from 'react-router-dom'
import { isDesktop, loadClientConfig, type ConfigResult } from '@/lib/platform'
import { initSupabase } from '@/lib/supabase'
import { AuthProvider, useAuth } from '@/features/auth/AuthProvider'
import { LoginScreen } from '@/features/auth/LoginScreen'
import { StartupErrorScreen } from '@/features/auth/StartupErrorScreen'
import { ToastProvider } from '@/components/ui/Toast'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { Spinner } from '@/components/ui/Misc'
import { AppShell } from '@/layout/AppShell'
import { Logo } from '@/layout/Brand'
import { BareTitleBar } from '@/layout/TopBar'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: true },
    mutations: { retry: 0 }
  }
})

function Splash() {
  return (
    <div className="relative flex h-full flex-col bg-forest-950">
      <BareTitleBar tone="dark" />
      <div className="flex flex-1 flex-col items-center justify-center gap-6">
        <Logo size={96} />
        <Spinner className="text-side-muted" />
      </div>
    </div>
  )
}

// The desktop app loads from a private app:// origin, where hash URLs are
// simplest; the web app uses real paths (Vercel rewrites them to index.html).
const Router = isDesktop ? HashRouter : BrowserRouter

function AuthGate() {
  const { status } = useAuth()
  if (status === 'loading') return <Splash />
  if (status === 'signed-out') return <LoginScreen />
  return (
    <Router>
      <AppShell />
    </Router>
  )
}

export function App() {
  const [config, setConfig] = useState<ConfigResult | undefined>(undefined)

  useEffect(() => {
    void loadClientConfig().then((c) => {
      if (c.ok) initSupabase(c.config.supabaseUrl, c.config.supabaseKey)
      setConfig(c)
    })
  }, [])

  return (
    // Animations always play: the owner wants them even when Windows' "Show
    // animations" is off (which Electron reports as prefers-reduced-motion).
    <MotionConfig reducedMotion="never">
      <ToastProvider>
        <TooltipProvider>
          {config === undefined ? (
            <Splash />
          ) : !config.ok ? (
            <StartupErrorScreen reason={config.message} />
          ) : (
            <QueryClientProvider client={queryClient}>
              <AuthProvider>
                <AuthGate />
              </AuthProvider>
            </QueryClientProvider>
          )}
        </TooltipProvider>
      </ToastProvider>
    </MotionConfig>
  )
}
