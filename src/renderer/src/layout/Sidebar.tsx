import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Boxes, CalendarClock, CupSoda, FileText, Gauge, HandCoins, History, LayoutGrid, ReceiptText, Settings2, UserCog, Users, Wallet } from 'lucide-react'
import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { useAuth } from '@/features/auth/AuthProvider'
import { AccountMenu } from '@/features/auth/AccountMenu'
import { Tooltip } from '@/components/ui/Tooltip'
import { Logo, Wordmark } from './Brand'

export interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  /** Where it sits in the menu: running the floor, the business, or the club's set-up. */
  group: 'floor' | 'business' | 'manage'
}

const GROUP_LABEL: Record<NavItem['group'], string> = { floor: 'Floor', business: 'Business', manage: 'Manage' }

export function useNavItems(): NavItem[] {
  const { isAdmin, can } = useAuth()
  // Admin: a management portal (no counter). Staff: their own counter and sales.
  const items: (NavItem | false)[] = [
    { to: '/', label: 'Dashboard', icon: Gauge, group: 'floor' },
    { to: '/tables', label: 'Tables', icon: LayoutGrid, group: 'floor' },
    { to: '/snacks', label: 'Snacks', icon: CupSoda, group: 'floor' },
    !isAdmin && { to: '/counter', label: 'My counter', icon: Wallet, group: 'floor' },
    !isAdmin && (can('view_own_sales') || can('delete_sales')) && { to: '/sales', label: 'My sales', icon: ReceiptText, group: 'floor' },
    isAdmin && { to: '/bookings', label: 'Pre-bookings', icon: CalendarClock, group: 'business' },
    isAdmin && { to: '/history', label: 'History', icon: History, group: 'business' },
    isAdmin && { to: '/reports', label: 'Reports', icon: FileText, group: 'business' },
    isAdmin && { to: '/expenses', label: 'Expenses', icon: HandCoins, group: 'business' },
    (isAdmin || can('adjust_stock')) && { to: '/inventory', label: 'Inventory', icon: Boxes, group: 'manage' },
    (isAdmin || can('manage_customers')) && { to: '/customers', label: 'Customers', icon: Users, group: 'manage' },
    isAdmin && { to: '/staff', label: 'Staff', icon: UserCog, group: 'manage' },
    isAdmin && { to: '/settings', label: 'Settings', icon: Settings2, group: 'manage' }
  ]
  return items.filter((i): i is NavItem => Boolean(i))
}

/** True on wide screens, where the sidebar shows labels; narrower windows get an icon rail. */
function useWideLayout(): boolean {
  const query = '(min-width: 1280px)'
  const [wide, setWide] = useState(() => typeof window === 'undefined' || window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const update = () => setWide(mq.matches)
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return wide
}

/** The forest-green rail (tablet and up): brand, main navigation and the signed-in account. Phones use MobileNav. */
export function Sidebar() {
  const items = useNavItems()
  const wide = useWideLayout()
  // The tooltip wraps its own element: merging trigger props into NavLink would
  // replace NavLink's className function and break the active-item styling.
  const hint = (key: string, label: string, node: ReactNode) =>
    wide ? (
      node
    ) : (
      <Tooltip key={key} content={label} side="right">
        <div className="flex flex-col">{node}</div>
      </Tooltip>
    )
  return (
    <aside
      className="felt drag-region relative z-40 hidden w-[76px] shrink-0 flex-col bg-forest-950 text-side-fg shadow-[inset_-1px_0_0_rgb(244_240_231/0.05)] md:flex xl:w-[240px]"
      data-layout={wide ? 'wide' : 'rail'}
    >
      <div className="flex items-center justify-center gap-3.5 px-3 pt-6 pb-7 xl:justify-start xl:px-5">
        <Logo size={42} className="ring-cream/10" />
        <div className="hidden min-w-0 xl:block">
          <Wordmark className="block text-[14px] text-side-fg" />
          <p className="mt-1.5 text-[10px] leading-none font-semibold tracking-[0.28em] whitespace-nowrap text-brass-300" data-testid="brand-tagline">
            GAMING LOUNGE
          </p>
        </div>
      </div>

      <span className="mx-5 mb-5 hidden h-px bg-brass-300/20 xl:block" aria-hidden />
      <nav aria-label="Main" className="no-drag flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-2">
        {items.flatMap((item, i) => [
          ...(i === 0 || items[i - 1]!.group !== item.group
            ? [
                <p
                  key={`group-${item.group}`}
                  className={cn(
                    'hidden px-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.2em] text-side-muted/75 uppercase xl:block',
                    i > 0 && 'pt-4'
                  )}
                >
                  {GROUP_LABEL[item.group]}
                </p>,
                ...(i > 0 ? [<span key={`rule-${item.group}`} className="mx-4 my-2 h-px shrink-0 bg-cream/[0.07] xl:hidden" aria-hidden />] : [])
              ]
            : []),
          hint(item.to, item.label,
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            aria-label={item.label}
            className={({ isActive }) =>
              cn(
                'relative flex h-10 shrink-0 items-center justify-center gap-3 rounded-xl px-3 text-[13.5px] font-semibold transition-colors duration-150 xl:justify-start',
                isActive ? 'text-cream' : 'text-side-muted hover:bg-cream/[0.04] hover:text-side-fg'
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-0 z-0 rounded-xl bg-cream/[0.07]"
                    transition={{ type: 'spring', stiffness: 480, damping: 40 }}
                  >
                    <span className="absolute top-3 bottom-3 left-0 w-[2px] rounded-r-full bg-brass-300" />
                  </motion.span>
                )}
                <item.icon className={cn('relative z-[1] size-[18px] shrink-0', isActive && 'text-brass-200')} strokeWidth={isActive ? 2 : 1.7} />
                <span className="relative z-[1] hidden truncate xl:inline">{item.label}</span>
              </>
            )}
          </NavLink>
          )
        ])}
      </nav>

      <div className="no-drag px-3 pt-3 pb-4">
        <AccountMenu compact={!wide} />
      </div>
    </aside>
  )
}
