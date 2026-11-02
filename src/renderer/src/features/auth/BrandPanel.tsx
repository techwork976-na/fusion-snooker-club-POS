import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { formatTime } from '@shared/format'
import { Logo } from '@/layout/Brand'

/**
 * Left half of the sign-in screens: the logo on forest green, the club's name
 * in tracked capitals, and the time — type and space only, no artwork.
 */
export function BrandPanel() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(id)
  }, [])

  return (
    <section className="relative hidden items-center justify-center overflow-hidden bg-forest-950 lg:flex">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        className="relative flex flex-col items-center text-center"
      >
        <Logo size={168} className="ring-cream/10" />
        <p className="mt-9 text-[15px] font-extrabold tracking-[0.42em] text-side-fg">FUSION</p>
        <p className="mt-2.5 text-[11px] font-semibold tracking-[0.34em] text-brass-300">GAMING LOUNGE</p>
        <span className="mt-9 h-px w-12 bg-brass-300/40" aria-hidden />
        <p className="mt-9 figure text-[44px] leading-none text-side-fg">{formatTime(now)}</p>
        <p className="mt-3 text-sm text-side-muted">
          {now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
      </motion.div>
    </section>
  )
}
