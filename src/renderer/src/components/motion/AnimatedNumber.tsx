import { useEffect, useRef, type HTMLAttributes } from 'react'
import { animate, motion, useMotionValue, useTransform } from 'framer-motion'
import { formatMoney } from '@shared/format'

const EASE = [0.22, 1, 0.36, 1] as const

/**
 * A figure that rolls to its value — up from 0 when it first appears, then
 * from the previous value whenever it updates (a sale, a realtime refresh).
 * The text is written straight to the DOM by a motion value, so the roll
 * costs no React renders, and it always settles on the exact formatted value.
 * It plays whatever the operating system's animation setting (see App.tsx).
 */
export function AnimatedNumber({
  value,
  format = formatMoney,
  duration = 0.9,
  ...rest
}: { value: number; format?: (n: number) => string; duration?: number } & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>) {
  const target = Number(value) || 0
  const targetRef = useRef(target)
  const formatRef = useRef(format)
  formatRef.current = format
  const mv = useMotionValue(0)
  // Whole numbers while rolling (no flickering paisa), the exact value at rest.
  const text = useTransform(mv, (v) => formatRef.current(Math.abs(v - targetRef.current) < 0.005 ? targetRef.current : Math.round(v)))

  useEffect(() => {
    targetRef.current = target
    // A larger change takes a little longer, within a quick, weighty range.
    const distance = Math.abs(target - mv.get())
    if (distance === 0) {
      mv.set(target)
      return
    }
    const controls = animate(mv, target, {
      duration: Math.min(duration * 1.3, duration * (0.8 + Math.log10(1 + distance) / 12)),
      ease: EASE
    })
    return () => controls.stop()
  }, [target, duration, mv])

  return <motion.span {...(rest as object)}>{text}</motion.span>
}

/** Money with the house formatting; the common case. */
export function AnimatedMoney(props: { value: number; duration?: number } & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>) {
  return <AnimatedNumber format={formatMoney} {...props} />
}
