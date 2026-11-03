import { useState } from 'react'
import { DropdownMenu } from 'radix-ui'
import { motion } from 'framer-motion'
import { ArrowLeftRight, ChevronsUpDown, KeyRound, Lock } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuth } from './AuthProvider'
import { SwitchPortalDialog } from './SwitchPortalDialog'
import { ChangePasswordDialog } from './ChangePasswordDialog'

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}

const itemClass =
  'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-fg outline-none select-none data-[highlighted]:bg-forest-950/[0.06]'

/** The signed-in account at the foot of the sidebar; opens portal switching and sign-out. */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { profile, isAdmin, signOut } = useAuth()
  const [switchOpen, setSwitchOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  if (!profile) return null
  const portal = isAdmin ? 'Admin portal' : `Staff · ${profile.floor_name ?? 'All floors'}`

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            aria-label="Account"
            data-testid="account-menu"
            className={cn(
              'flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-cream/[0.05] data-[state=open]:bg-cream/[0.07]',
              compact && 'justify-center'
            )}
          >
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-full text-[12px] font-bold tracking-wide',
                isAdmin ? 'bg-brass-200 text-forest-950' : 'bg-sage-200 text-forest-950'
              )}
            >
              {initials(profile.full_name)}
            </span>
            <span className={cn('min-w-0 flex-1', compact && 'hidden')}>
              <span className="block truncate text-[13px] font-semibold text-side-fg">{profile.full_name}</span>
              <span className="block truncate text-[11.5px] text-side-muted">{portal}</span>
            </span>
            <ChevronsUpDown className={cn('size-4 shrink-0 text-side-muted', compact && 'hidden')} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content asChild side="top" align="start" sideOffset={8}>
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.16 }}
              className="popover z-[70] w-64 p-1.5"
            >
              <div className="px-3 pt-2.5 pb-3">
                <p className="text-sm font-bold text-fg">{profile.full_name}</p>
                <p className="mt-0.5 text-xs text-fg-3">{isAdmin ? 'Admin portal' : `Staff portal · ${profile.floor_name ?? 'All floors'}`}</p>
              </div>
              <DropdownMenu.Separator className="mx-2 mb-1 h-px bg-line" />
              <DropdownMenu.Item className={itemClass} onSelect={() => setSwitchOpen(true)}>
                <ArrowLeftRight className="size-4 text-fg-3" />
                {isAdmin ? 'Switch to Staff portal' : 'Switch to Admin portal'}
              </DropdownMenu.Item>
              <DropdownMenu.Item className={itemClass} onSelect={() => setPasswordOpen(true)}>
                <KeyRound className="size-4 text-fg-3" />
                Change my password
              </DropdownMenu.Item>
              <DropdownMenu.Item className={itemClass} onSelect={() => void signOut()}>
                <Lock className="size-4 text-fg-3" />
                Lock &amp; sign out
              </DropdownMenu.Item>
            </motion.div>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <SwitchPortalDialog open={switchOpen} onOpenChange={setSwitchOpen} target={isAdmin ? 'staff' : 'admin'} />
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </>
  )
}
