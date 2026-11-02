import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { isDesktop } from '@/lib/platform'

/** Custom caption buttons for the desktop app's frameless window; nothing in a browser. */
export function WindowControls({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  return isDesktop ? <DesktopWindowControls tone={tone} /> : null
}

/** `tone` matches the surface behind the buttons. */
function DesktopWindowControls({ tone }: { tone: 'light' | 'dark' }) {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    void window.fusion.window.isMaximized().then(setMaximized)
    return window.fusion.window.onMaximizedChange(setMaximized)
  }, [])

  const base = cn(
    'no-drag flex h-full w-12 items-center justify-center transition-colors duration-150',
    tone === 'dark' ? 'text-side-muted' : 'text-fg-3'
  )
  const hover = tone === 'dark' ? 'hover:bg-cream/[0.08] hover:text-side-fg' : 'hover:bg-forest-950/[0.06] hover:text-fg'
  return (
    <div className="flex h-full items-stretch" data-testid="window-controls">
      <button aria-label="Minimize" data-testid="win-minimize" className={cn(base, hover)} onClick={() => window.fusion.window.minimize()}>
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
          <path d="M1 5.5h9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button
        aria-label={maximized ? 'Restore' : 'Maximize'}
        data-testid="win-maximize"
        className={cn(base, hover)}
        onClick={() => window.fusion.window.toggleMaximize()}
      >
        {maximized ? (
          <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.1">
            <rect x="1" y="3" width="7" height="7" rx="1" />
            <path d="M3 3V2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.1">
            <rect x="1" y="1" width="9" height="9" rx="1.2" />
          </svg>
        )}
      </button>
      <button aria-label="Close" data-testid="win-close" className={cn(base, 'hover:bg-claret-500 hover:text-white')} onClick={() => window.fusion.window.close()}>
        <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
          <path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  )
}
