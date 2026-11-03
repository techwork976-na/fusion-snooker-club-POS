import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Dialog } from 'radix-ui'
import { AlertTriangle, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useIsPhone } from '@/lib/useMedia'
import { Button } from './Button'

const sizes = {
  sm: 'w-[min(440px,calc(100vw-48px))]',
  md: 'w-[min(560px,calc(100vw-48px))]',
  lg: 'w-[min(760px,calc(100vw-48px))]',
  xl: 'w-[min(1080px,calc(100vw-48px))]'
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
  className
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: keyof typeof sizes
  dismissible?: boolean
  className?: string
}) {
  // Phones: a sheet that rises from the foot of the screen, full width.
  const phone = useIsPhone()
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (dismissible || o ? onOpenChange(o) : undefined)}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-[60] bg-forest-950/40"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              />
            </Dialog.Overlay>
            <div className="pointer-events-none fixed inset-0 z-[61] flex items-center justify-center p-6 pt-16 max-md:items-end max-md:p-0">
              <Dialog.Content
                asChild
                forceMount
                onPointerDownOutside={(e) => !dismissible && e.preventDefault()}
                onEscapeKeyDown={(e) => !dismissible && e.preventDefault()}
              >
                <motion.div
                  className={cn(
                    'pointer-events-auto flex max-h-[calc(100vh-96px)] flex-col overflow-hidden rounded-[24px] bg-surface shadow-[var(--shadow-pop)] outline-none max-md:max-h-[calc(100dvh-16px)] max-md:w-full max-md:rounded-b-none',
                    sizes[size],
                    className
                  )}
                  // A weighty spring in (readable at once: opacity fades fast), a quick ease out.
                  initial={phone ? { opacity: 1, y: '100%', scale: 1 } : { opacity: 0, y: 18, scale: 0.97 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    scale: 1,
                    transition: phone
                      ? { type: 'spring', stiffness: 380, damping: 38 }
                      : { type: 'spring', stiffness: 380, damping: 32, mass: 0.9, opacity: { duration: 0.16, ease: 'easeOut' } }
                  }}
                  exit={
                    phone
                      ? { y: '100%', transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } }
                      : { opacity: 0, y: 8, scale: 0.985, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } }
                  }
                >
                  <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-forest-950/15 md:hidden" aria-hidden />
                  <div className="flex items-start justify-between gap-4 px-5 pt-3 pb-2 md:px-7 md:pt-6">
                    <div className="min-w-0">
                      <Dialog.Title className="font-display-tight text-[21px] leading-tight text-forest-950 md:text-[24px]">
                        {title}
                      </Dialog.Title>
                      {description ? (
                        <Dialog.Description className="mt-1 text-sm text-fg-3">{description}</Dialog.Description>
                      ) : (
                        <Dialog.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</Dialog.Description>
                      )}
                    </div>
                    {dismissible && (
                      <Dialog.Close
                        aria-label="Close"
                        className="-mr-2 flex size-10 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-forest-950/[0.06] hover:text-fg md:size-9"
                      >
                        <X className="size-[18px]" />
                      </Dialog.Close>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-7 md:py-5">{children}</div>
                  {footer && (
                    <div className="flex flex-wrap items-center justify-end gap-2.5 bg-canvas/70 px-5 pt-3.5 pb-[calc(14px+env(safe-area-inset-bottom))] md:px-7 md:py-4">
                      {footer}
                    </div>
                  )}
                </motion.div>
              </Dialog.Content>
            </div>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  tone = 'danger',
  onConfirm,
  children,
  requireAcknowledgement
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  confirmLabel?: string
  tone?: 'danger' | 'primary'
  onConfirm: () => Promise<unknown> | void
  children?: ReactNode
  /** Text of a checkbox the operator must tick before confirming. */
  requireAcknowledgement?: string
}) {
  const [busy, setBusy] = useState(false)
  const [ack, setAck] = useState(false)
  const close = (o: boolean) => {
    if (busy) return
    if (!o) setAck(false)
    onOpenChange(o)
  }
  return (
    <Modal
      open={open}
      onOpenChange={close}
      size="sm"
      title={
        <span className="flex items-center gap-2.5">
          {tone === 'danger' && <AlertTriangle className="size-5 text-claret-700" />}
          {title}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            loading={busy}
            disabled={Boolean(requireAcknowledgement) && !ack}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
                setAck(false)
                onOpenChange(false)
              } catch {
                // The caller shows the error; keep the dialog open.
              } finally {
                setBusy(false)
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm leading-relaxed text-fg-2">
        {description}
        {children}
        {requireAcknowledgement && (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-sunken/70 p-3.5">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="mt-0.5 size-4 accent-[var(--color-forest-700)]"
            />
            <span className="text-[13px] text-fg">{requireAcknowledgement}</span>
          </label>
        )}
      </div>
    </Modal>
  )
}
