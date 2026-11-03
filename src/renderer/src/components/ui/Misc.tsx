import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-fg-3', className)} />
}

export function LoadingBlock({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-3 py-16 text-sm text-fg-3', className)}>
      <Spinner /> {label}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-forest-950/[0.045]', className)} />
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className
}: {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon && (
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-sunken text-forest-700">
          {icon}
        </div>
      )}
      <p className="font-display-tight text-[19px] text-forest-950">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-sm text-fg-3">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--radius-card)] bg-claret-50 px-6 py-8 text-center text-sm text-claret-800">
      <p>{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="font-semibold text-claret-700 underline-offset-4 hover:underline">
          Try again
        </button>
      )}
    </div>
  )
}

export function PageHeader({
  title,
  eyebrow,
  subtitle,
  actions,
  children
}: {
  title: ReactNode
  eyebrow?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 md:mb-9 md:gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <p className="label mb-2.5 !text-brass-700 md:mb-3">{eyebrow}</p>}
          <h1 className="font-display-tight text-[30px] leading-[1.05] text-forest-950 md:text-[36px] md:leading-none">{title}</h1>
          {subtitle && <p className="mt-2.5 text-sm text-fg-3 md:mt-3">{subtitle}</p>}
        </div>
        {actions && <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2.5">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

export function Segmented<V extends string>({
  value,
  onChange,
  options,
  size = 'md',
  layoutId
}: {
  value: V
  onChange: (v: V) => void
  options: { value: V; label: ReactNode; count?: number }[]
  size?: 'sm' | 'md'
  layoutId: string
}) {
  return (
    <div role="tablist" className="inline-flex max-w-full rounded-xl bg-forest-950/[0.05] p-1 max-md:overflow-x-auto max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative flex shrink-0 items-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-colors',
              size === 'sm' ? 'h-7 px-3 text-xs max-md:h-8' : 'h-8 px-3.5 text-[13px] max-md:h-9',
              active ? 'text-forest-950' : 'text-fg-3 hover:text-fg'
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 z-0 rounded-lg bg-surface shadow-[var(--shadow-control)]"
                transition={{ type: 'spring', stiffness: 520, damping: 40 }}
              />
            )}
            <span className="relative z-[1]">{o.label}</span>
            {o.count !== undefined && (
              <span
                className={cn(
                  'relative z-[1] min-w-5 rounded-full px-1.5 text-center tabular text-[11px] leading-[18px]',
                  active ? 'bg-forest-950 text-cream' : 'bg-forest-950/[0.07] text-fg-3'
                )}
              >
                {o.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function Stat({
  label,
  value,
  hint,
  accent,
  className
}: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  accent?: string
  className?: string
}) {
  return (
    <div className={cn('card p-5 md:p-6', className)}>
      <div className="flex items-center gap-2">
        {accent && <span className={cn('size-2 rounded-full', accent)} />}
        <span className="label">{label}</span>
      </div>
      <div className="mt-3.5 figure text-[24px] leading-none text-forest-950 md:text-[28px]">{value}</div>
      {hint && <div className="mt-2 text-xs text-fg-3">{hint}</div>}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md bg-sunken px-1.5 py-0.5 shadow-[inset_0_-1px_0_rgb(10_31_20/0.1)] font-sans text-[11px] font-semibold text-fg-3">
      {children}
    </kbd>
  )
}

/** Fades/slides page content in on route change. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className={cn('mx-auto w-full max-w-[1600px] px-4 pt-4 pb-10 sm:px-5 md:px-8 md:pt-6 md:pb-14 xl:px-10', className)}
    >
      {children}
    </motion.div>
  )
}
