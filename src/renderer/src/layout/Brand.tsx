import logo from '@/assets/fusion-logo.jpg'
import { cn } from '@/lib/cn'

/** The official FUSION logo, shown unaltered inside a rounded tile. */
export function Logo({ size = 34, className }: { size?: number; className?: string }) {
  return (
    <img
      src={logo}
      alt="FUSION Gaming Lounge"
      width={size}
      height={size}
      draggable={false}
      className={cn('shrink-0 rounded-[28%] ring-1 ring-forest-950/10', className)}
      style={{ width: size, height: size }}
    />
  )
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={cn('text-[13px] font-extrabold tracking-[0.32em] text-fg', className)}>FUSION</span>
}
