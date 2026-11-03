import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Info, XCircle } from 'lucide-react'

type Tone = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  tone: Tone
  message: string
}
interface ToastApi {
  success(message: string): void
  error(message: string): void
  info(message: string): void
}

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((tone: Tone, message: string) => {
    const id = Date.now() + Math.random()
    setItems((list) => [...list.slice(-3), { id, tone, message }])
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), tone === 'error' ? 6500 : 3500)
  }, [])
  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', m),
      info: (m) => push('info', m)
    }),
    [push]
  )
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-6 bottom-6 z-[100] flex w-[380px] flex-col gap-2.5 max-md:inset-x-3 max-md:bottom-[calc(76px+env(safe-area-inset-bottom))] max-md:w-auto" role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24, transition: { duration: 0.16 } }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="pointer-events-auto flex items-start gap-3 rounded-2xl bg-forest-950 px-4 py-3.5 text-sm font-medium text-side-fg shadow-[var(--shadow-pop)]"
              onClick={() => setItems((list) => list.filter((x) => x.id !== t.id))}
            >
              {t.tone === 'success' && <CheckCircle2 className="mt-px size-[18px] shrink-0 text-sage-300" />}
              {t.tone === 'error' && <XCircle className="mt-px size-[18px] shrink-0 text-claret-300" />}
              {t.tone === 'info' && <Info className="mt-px size-[18px] shrink-0 text-brass-300" />}
              <span className="leading-snug">{t.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
