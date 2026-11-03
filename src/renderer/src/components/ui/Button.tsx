import { forwardRef, useCallback, useRef, useState, type ButtonHTMLAttributes, type PointerEvent, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Tooltip } from './Tooltip'

interface Ripple {
  id: number
  x: number
  y: number
  size: number
}

/**
 * Press ripples for a control: a matte disc grows from the pointer and fades
 * (styles.css `.ripple`). Returns the ripple elements and the pointer handler.
 */
function useRipples(onPointerDown?: (e: PointerEvent<HTMLButtonElement>) => void) {
  const [ripples, setRipples] = useState<Ripple[]>([])
  const next = useRef(0)
  const handle = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      onPointerDown?.(e)
      if (e.button !== 0) return
      const rect = e.currentTarget.getBoundingClientRect()
      const size = Math.max(rect.width, rect.height) * 2.2
      const ripple = { id: next.current++, x: e.clientX - rect.left, y: e.clientY - rect.top, size }
      setRipples((list) => [...list.slice(-2), ripple])
    },
    [onPointerDown]
  )
  const elements = ripples.map((r) => (
    <span
      key={r.id}
      aria-hidden
      className="ripple"
      style={{ left: r.x, top: r.y, width: r.size, height: r.size }}
      onAnimationEnd={() => setRipples((list) => list.filter((x) => x.id !== r.id))}
    />
  ))
  return [elements, handle] as const
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'brass'
type Size = 'sm' | 'md' | 'lg'

// Solid, matte fills; the secondary button is raised by a soft shadow, not outlined.
const variants: Record<Variant, string> = {
  primary: 'bg-forest-950 text-cream shadow-[var(--shadow-control)] hover:bg-forest-800 active:bg-forest-900',
  secondary: 'bg-surface text-fg shadow-[var(--shadow-control)] hover:bg-field hover:shadow-[0_1px_2px_rgb(10_31_20/0.08),0_6px_14px_-6px_rgb(10_31_20/0.14)]',
  ghost: 'text-fg-2 hover:bg-forest-950/[0.05] hover:text-fg',
  danger: 'bg-claret-50 text-claret-700 hover:bg-claret-100',
  brass: 'bg-brass-600 text-surface shadow-[var(--shadow-control)] hover:bg-brass-700'
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg max-md:h-9',
  md: 'h-10 px-4 text-sm gap-2 rounded-[10px]',
  lg: 'h-12 px-5 text-[15px] gap-2.5 rounded-xl'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', onPointerDown, ...rest },
  ref
) {
  const [ripples, onPress] = useRipples(onPointerDown)
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      onPointerDown={onPress}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden font-semibold whitespace-nowrap transition-[background-color,box-shadow,color,translate,scale,opacity] duration-150 ease-out select-none active:translate-y-px active:scale-[0.985] disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
      {ripples}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  variant?: 'ghost' | 'secondary' | 'danger'
  size?: 'sm' | 'md'
  tooltip?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', size = 'md', tooltip = true, className, children, type = 'button', onPointerDown, ...rest },
  ref
) {
  const [ripples, onPress] = useRipples(onPointerDown)
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      onPointerDown={onPress}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'size-8 max-md:size-9' : 'size-10',
        variant === 'ghost' && 'text-fg-3 hover:bg-forest-950/[0.06] hover:text-fg',
        variant === 'secondary' && 'bg-surface text-fg-2 shadow-[var(--shadow-control)] hover:text-fg',
        variant === 'danger' && 'text-fg-3 hover:bg-claret-50 hover:text-claret-700',
        className
      )}
      {...rest}
    >
      {children}
      {ripples}
    </button>
  )
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button
})
