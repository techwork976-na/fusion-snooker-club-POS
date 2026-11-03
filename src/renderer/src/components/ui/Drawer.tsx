import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'
import { useIsPhone } from '@/lib/useMedia'

/** Right-hand sheet for detail views that keep the floor visible. */
export function Drawer({
  open,
  onOpenChange,
  title,
  subtitle,
  aside,
  children,
  footer
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: ReactNode
  subtitle?: ReactNode
  aside?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  // Phones: a full-width sheet rising from the foot of the screen.
  const phone = useIsPhone()
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 top-12 z-[50] bg-forest-950/30 max-md:top-0 max-md:bg-forest-950/40"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <motion.aside
                className="fixed top-12 right-0 bottom-0 z-[51] flex w-[min(500px,100vw)] flex-col overflow-hidden rounded-tl-[24px] bg-surface shadow-[var(--shadow-pop)] outline-none max-md:top-2 max-md:w-full max-md:rounded-t-[24px]"
                initial={phone ? { y: '100%', opacity: 1 } : { x: 48, opacity: 0 }}
                animate={{
                  x: 0,
                  y: 0,
                  opacity: 1,
                  transition: phone
                    ? { type: 'spring', stiffness: 380, damping: 38 }
                    : { type: 'spring', stiffness: 340, damping: 34, mass: 0.9, opacity: { duration: 0.16, ease: 'easeOut' } }
                }}
                exit={phone ? { y: '100%', transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } } : { x: 40, opacity: 0, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
              >
                <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-forest-950/15 md:hidden" aria-hidden />
                <header className="flex items-start justify-between gap-4 px-5 pt-3 pb-3 md:px-7 md:pt-7">
                  <div className="min-w-0">
                    <Dialog.Title className="font-display-tight truncate text-[24px] leading-tight text-forest-950 md:text-[28px]">{title}</Dialog.Title>
                    {subtitle && <p className="mt-1 text-sm text-fg-3">{subtitle}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    {aside}
                    <Dialog.Close
                      aria-label="Close"
                      className="flex size-10 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-forest-950/[0.06] hover:text-fg md:size-9"
                    >
                      <X className="size-[18px]" />
                    </Dialog.Close>
                  </div>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-7 md:py-5">{children}</div>
                {footer && <footer className="bg-canvas/70 px-5 pt-4 pb-[calc(16px+env(safe-area-inset-bottom))] md:px-7 md:py-5">{footer}</footer>}
              </motion.aside>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
