import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Dialog } from 'radix-ui'
import { Camera, KeyRound, Lock, LogOut, MoreHorizontal, UserPlus, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Avatar } from '@/components/ui/Avatar'
import { useAuth } from '@/features/auth/AuthProvider'
import { LogoutAllDialog, portalLabel, useSwitchAccount } from '@/features/auth/AccountMenu'
import { AddAccountDialog } from '@/features/auth/AddAccountDialog'
import { ChangePasswordDialog } from '@/features/auth/ChangePasswordDialog'
import { ProfilePictureDialog } from '@/features/auth/ProfilePictureDialog'
import { useNavItems, type NavItem } from './Sidebar'

/** The four destinations each role reaches most; everything else sits under More. */
const PRIMARY = {
  admin: ['/', '/tables', '/reports', '/history'],
  staff: ['/', '/tables', '/snacks', '/counter']
}

/** Shorter tab-bar wording where the full label would not fit a narrow phone. */
const TAB_LABEL: Record<string, string> = { '/counter': 'Counter' }

const isActive = (item: NavItem, pathname: string) => (item.to === '/' ? pathname === '/' : pathname.startsWith(item.to))

/**
 * Phones: a forest-green tab bar at the foot of the screen (thumb reach) with
 * the role's main pages, and More for every other page and the account. The
 * sidebar takes over from tablet width up.
 */
export function MobileNav() {
  const items = useNavItems()
  const { isAdmin } = useAuth()
  const { pathname } = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)
  const primaryPaths = isAdmin ? PRIMARY.admin : PRIMARY.staff
  const primary = items.filter((i) => primaryPaths.includes(i.to))
  const rest = items.filter((i) => !primaryPaths.includes(i.to))
  const moreActive = rest.some((i) => isActive(i, pathname))

  const tab = 'relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 pt-1.5 text-[10.5px] font-semibold tracking-[0.01em] max-[359px]:text-[9.5px] max-[359px]:tracking-normal'
  const indicator = (
    <motion.span
      layoutId="mobile-nav-active"
      className="absolute top-1.5 h-8 w-14 rounded-full bg-cream/[0.09]"
      transition={{ type: 'spring', stiffness: 480, damping: 40 }}
    />
  )

  return (
    <>
      <nav
        aria-label="Main"
        className="felt relative z-40 flex shrink-0 items-stretch bg-forest-950 px-1 pb-[env(safe-area-inset-bottom)] md:hidden"
        data-testid="mobile-nav"
      >
        {primary.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            aria-label={item.label}
            className={({ isActive: active }) => cn(tab, 'h-16', active ? 'text-cream' : 'text-side-muted')}
          >
            {({ isActive: active }) => (
              <>
                {active && indicator}
                <item.icon className={cn('relative z-[1] size-5', active && 'text-brass-200')} strokeWidth={active ? 2 : 1.7} />
                <span className="relative z-[1] max-w-full truncate px-0.5">{TAB_LABEL[item.to] ?? item.label}</span>
              </>
            )}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-label="More"
          aria-haspopup="dialog"
          className={cn(tab, 'h-16', moreActive || moreOpen ? 'text-cream' : 'text-side-muted')}
          data-testid="mobile-more"
        >
          {moreActive && indicator}
          <MoreHorizontal className={cn('relative z-[1] size-5', moreActive && 'text-brass-200')} strokeWidth={moreActive ? 2 : 1.7} />
          <span className="relative z-[1]">More</span>
        </button>
      </nav>
      <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} items={rest} />
    </>
  )
}

/** Every page not in the tab bar, then the signed-in account and its actions. */
function MoreSheet({ open, onOpenChange, items }: { open: boolean; onOpenChange: (o: boolean) => void; items: NavItem[] }) {
  const { profile, isAdmin, accounts, signOut } = useAuth()
  const { pathname } = useLocation()
  const switchAccount = useSwitchAccount()
  const [addOpen, setAddOpen] = useState(false)
  const [pictureOpen, setPictureOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const close = () => onOpenChange(false)
  const portal = isAdmin ? 'Admin portal' : `Staff portal · ${profile?.floor_name ?? 'All floors'}`
  const row = 'flex h-12 w-full items-center gap-3 rounded-xl px-3.5 text-left text-[15px] font-semibold text-fg active:bg-forest-950/[0.06]'

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <AnimatePresence>
          {open && (
            <Dialog.Portal forceMount>
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  className="fixed inset-0 z-[60] bg-forest-950/40 md:hidden"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                />
              </Dialog.Overlay>
              <Dialog.Content asChild forceMount aria-describedby={undefined}>
                <motion.div
                  className="fixed inset-x-0 bottom-0 z-[61] flex max-h-[88dvh] flex-col overflow-hidden rounded-t-[24px] bg-surface shadow-[var(--shadow-pop)] outline-none md:hidden"
                  initial={{ y: '100%' }}
                  animate={{ y: 0, transition: { type: 'spring', stiffness: 380, damping: 38 } }}
                  exit={{ y: '100%', transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } }}
                  data-testid="more-sheet"
                >
                  <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-forest-950/15" aria-hidden />
                  <div className="flex items-center justify-between px-5 pt-3 pb-1">
                    <Dialog.Title className="font-display-tight text-[21px] text-forest-950">Menu</Dialog.Title>
                    <Dialog.Close aria-label="Close" className="-mr-2 flex size-10 items-center justify-center rounded-lg text-fg-3 active:bg-forest-950/[0.06]">
                      <X className="size-5" />
                    </Dialog.Close>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(16px+env(safe-area-inset-bottom))]">
                    {items.length > 0 && (
                      <nav aria-label="More pages" className="grid grid-cols-3 gap-2 pt-2">
                        {items.map((item) => {
                          const active = isActive(item, pathname)
                          return (
                            <NavLink
                              key={item.to}
                              to={item.to}
                              onClick={close}
                              className={cn(
                                'flex min-h-[84px] flex-col items-center justify-center gap-2 rounded-2xl px-2 py-3 text-center text-[12.5px] leading-tight font-semibold transition-colors',
                                active ? 'bg-forest-950 text-cream' : 'bg-sunken/70 text-fg-2 active:bg-sunken'
                              )}
                            >
                              <item.icon className={cn('size-[22px]', active ? 'text-brass-200' : 'text-forest-700')} strokeWidth={1.8} />
                              {item.label}
                            </NavLink>
                          )
                        })}
                      </nav>
                    )}

                    {profile && (
                      <section className="mt-5 rounded-2xl bg-sunken/60 p-2" data-testid="mobile-account">
                        <div className="flex items-center gap-3 px-2.5 pt-2 pb-3">
                          <Avatar name={profile.full_name} path={profile.avatar_path} role={profile.role} size={40} />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-bold text-fg">{profile.full_name}</span>
                            <span className="block truncate text-xs text-fg-3">{portal}</span>
                          </span>
                        </div>
                        {/* The other accounts on this device: one tap, no password. */}
                        {accounts
                          .filter((a) => a.userId !== profile.id)
                          .map((a) => (
                            <button
                              key={a.userId}
                              className={row}
                              onClick={() => {
                                close()
                                void switchAccount(a)
                              }}
                              data-testid={`mobile-account-${a.username}`}
                            >
                              <Avatar name={a.fullName} path={a.avatarPath} role={a.role} size={28} />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate">{a.fullName}</span>
                                <span className="block truncate text-xs font-normal text-fg-4">{portalLabel(a)}</span>
                              </span>
                            </button>
                          ))}
                        <button
                          className={row}
                          onClick={() => {
                            close()
                            setAddOpen(true)
                          }}
                          data-testid="mobile-add-account"
                        >
                          <UserPlus className="size-[18px] text-fg-3" />
                          Add account
                        </button>
                        <button
                          className={row}
                          onClick={() => {
                            close()
                            setPictureOpen(true)
                          }}
                        >
                          <Camera className="size-[18px] text-fg-3" />
                          Profile picture
                        </button>
                        <button
                          className={row}
                          onClick={() => {
                            close()
                            setPasswordOpen(true)
                          }}
                        >
                          <KeyRound className="size-[18px] text-fg-3" />
                          Change my password
                        </button>
                        <button
                          className={row}
                          onClick={() => {
                            close()
                            void signOut()
                          }}
                          data-testid="mobile-sign-out"
                        >
                          <Lock className="size-[18px] text-fg-3" />
                          Sign out of {profile.full_name.split(/s+/)[0]}
                        </button>
                        <button
                          className={row}
                          onClick={() => {
                            close()
                            setLogoutOpen(true)
                          }}
                          data-testid="mobile-sign-out-all"
                        >
                          <LogOut className="size-[18px] text-fg-3" />
                          Log out of all accounts
                        </button>
                      </section>
                    )}
                  </div>
                </motion.div>
              </Dialog.Content>
            </Dialog.Portal>
          )}
        </AnimatePresence>
      </Dialog.Root>
      <AddAccountDialog open={addOpen} onOpenChange={setAddOpen} />
      <ProfilePictureDialog open={pictureOpen} onOpenChange={setPictureOpen} />
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
      <LogoutAllDialog open={logoutOpen} onOpenChange={setLogoutOpen} />
    </>
  )
}
