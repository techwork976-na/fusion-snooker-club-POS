import { motion } from 'framer-motion'
import { Button } from '@/components/ui/Button'
import { BareTitleBar } from '@/layout/TopBar'
import { Logo } from '@/layout/Brand'
import { BrandPanel } from './BrandPanel'

/**
 * Shown only when the deployment itself is misconfigured (its Supabase settings
 * are missing or invalid). Clients never enter server details; the
 * administrator fixes the deployment's environment variables instead.
 */
export function StartupErrorScreen({ reason }: { reason: string }) {
  return (
    <div className="relative flex h-full flex-col bg-canvas">
      <BareTitleBar />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
        <BrandPanel />
        <section className="flex items-center justify-center px-6 sm:px-8">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-[420px]"
            data-testid="startup-error"
          >
            <div className="mb-8 lg:hidden">
              <Logo size={84} />
            </div>
            <p className="label !text-claret-700">Can't start</p>
            <h1 className="mt-2.5 font-display-tight text-[34px] leading-tight text-forest-950">FUSION isn't connected</h1>
            <p className="mt-3 text-sm leading-relaxed text-fg-3">{reason}</p>
            <p className="mt-2 mb-8 text-sm leading-relaxed text-fg-3">
              Please contact the person who manages this FUSION installation.
            </p>
            <Button onClick={() => window.location.reload()}>Try again</Button>
          </motion.div>
        </section>
      </div>
    </div>
  )
}
