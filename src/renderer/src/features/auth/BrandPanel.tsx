import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { formatTime } from '@shared/format'
import { Logo } from '@/layout/Brand'

const ease = [0.22, 1, 0.36, 1] as const

/**
 * Left half of the sign-in screens, on deep forest felt: the club's lockup at
 * the top, the day and the club clock set large in the middle, and a quiet
 * footer — type, space and the brass accent only; no artwork, glow or gradient.
 */
export function BrandPanel() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000)
    return () => clearInterval(id)
  }, [])

  return (
    <section className="felt relative hidden flex-col justify-between overflow-hidden bg-forest-950 p-12 text-side-fg lg:flex xl:p-16">
      <motion.header
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease }}
        className="relative flex items-center gap-4"
      >
        <Logo size={64} className="ring-cream/10" />
        <div>
          <p className="text-[15px] font-extrabold tracking-[0.42em] text-side-fg">FUSION</p>
          <p className="mt-2 text-[10.5px] font-semibold tracking-[0.34em] text-brass-300">GAMING LOUNGE</p>
        </div>
      </motion.header>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.06, ease }}
        className="relative"
      >
        <p className="eyebrow !text-brass-300">Club time</p>
        <p className="mt-6 font-display-tight text-[72px] leading-[0.95] text-cream xl:text-[84px]">
          {now.toLocaleDateString('en-GB', { weekday: 'long' })}
        </p>
        <p className="mt-6 flex items-baseline gap-4 text-side-muted">
          <span className="timer text-[40px] leading-none text-side-fg">{formatTime(now)}</span>
          <span className="text-[15px]">{now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
        </p>
      </motion.div>

      <motion.footer
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.15 }}
        className="relative flex items-center justify-between border-t border-cream/[0.08] pt-5 text-[12px] text-side-muted"
      >
        <span>Club management &amp; point of sale</span>
        <span className="tabular">Version {__APP_VERSION__}</span>
      </motion.footer>
    </section>
  )
}
