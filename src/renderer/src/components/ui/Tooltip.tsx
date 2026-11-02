import type { ReactNode } from 'react'
import { Tooltip as T } from 'radix-ui'

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <T.Provider delayDuration={350} skipDelayDuration={150}>
      {children}
    </T.Provider>
  )
}

export function Tooltip({
  content,
  children,
  side = 'bottom'
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={8}
          className="z-[80] rounded-lg bg-forest-950 px-2.5 py-1.5 text-xs font-semibold text-side-fg shadow-[var(--shadow-pop)] data-[state=delayed-open]:animate-[fade-in_120ms_ease-out]"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
