import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Archive,
  Boxes,
  CalendarClock,
  ChevronRight,
  History,
  LayoutGrid,
  PackagePlus,
  ShoppingBag,
  UserCog,
  Wallet
} from 'lucide-react'
import { formatBusinessDate, formatClock, formatHour, formatMoney, formatTime } from '@shared/format'
import { toPaisa } from '@shared/billing'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { Dashboard, DayTotals, Shift, StaffDayRow, TableOverview } from '@/lib/types'
import * as api from '@/data/api'
import { accountingKeys, keys, useAction, useBusinessDate, useDashboard, useSettings, useTablesOverview } from '@/data/hooks'
import { BarChart, compactMoney, SERIES_COLORS } from '@/components/charts/BarChart'
import { AnimatedMoney } from '@/components/motion/AnimatedNumber'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Modal'
import { EmptyState, ErrorState, Page, PageHeader, Skeleton } from '@/components/ui/Misc'
import { useAuth } from '@/features/auth/AuthProvider'
import { CheckoutDialog } from '@/features/pos/CheckoutDialog'
import { ShiftFigures, ShiftStatusPill } from '@/features/shifts/ShiftParts'
import { StatusPill } from '@/features/tables/TableCard'
import { statusMeta, useLive } from '@/features/tables/session'

const rise = (i: number) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.4, delay: 0.05 * i, ease: [0.22, 1, 0.36, 1] as const }
})

function PanelHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="label">{children}</span>
      {aside}
    </div>
  )
}

function PanelLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group flex items-center gap-1 text-xs font-bold text-brass-700 transition-colors hover:text-forest-950">
      {children} <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
    </button>
  )
}

export function DashboardPage() {
  const { isAdmin, can, profile } = useAuth()
  const { data, isLoading, error, refetch } = useDashboard()
  const { data: settings } = useSettings()
  const navigate = useNavigate()
  const [counterOpen, setCounterOpen] = useState(false)
  // Admins manage the business; only a staff member with an open counter sells.
  const canCounter = !isAdmin && can('counter_sale') && Boolean(data?.my_counter)
  const inUse = data ? data.tables.running + data.tables.paused + data.tables.billing : 0

  return (
    <Page>
      <PageHeader
        eyebrow={isAdmin ? 'Dashboard' : `Dashboard · ${profile?.floor_name ?? 'All floors'}`}
        title={settings?.club_name || 'FUSION Gaming Lounge'}
        subtitle={
          data ? `${formatBusinessDate(data.business_date, { year: false })} · ${inUse} of ${data.tables.total} tables in use` : undefined
        }
        actions={
          <>
            {isAdmin && (
              <Button variant="secondary" icon={<CalendarClock className="size-4" />} onClick={() => navigate('/bookings')}>
                Pre-bookings{data?.bookings_today ? ` · ${data.bookings_today} today` : ''}
              </Button>
            )}
            {canCounter && (
              <Button variant="secondary" icon={<ShoppingBag className="size-4" />} onClick={() => setCounterOpen(true)}>
                Counter sale
              </Button>
            )}
            <Button variant="primary" icon={<LayoutGrid className="size-4" />} onClick={() => navigate('/tables')}>
              Open floor
            </Button>
          </>
        }
      />

      {error ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <div className="grid grid-cols-12 gap-6">
          <Skeleton className="col-span-8 h-[520px] rounded-[var(--radius-card)]" />
          <Skeleton className="col-span-4 h-[520px] rounded-[var(--radius-card)]" />
          <Skeleton className="col-span-12 h-56 rounded-[var(--radius-card)]" />
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-6">
          <motion.section {...rise(0)} className="col-span-12 xl:col-span-8">
            {isAdmin && data.today ? <TodayHero data={data} /> : <MyCounterCard shift={data.my_counter ?? null} />}
          </motion.section>

          <div className="col-span-12 flex flex-col gap-6 xl:col-span-4">
            <motion.section {...rise(1)}>
              <FloorStatus data={data} lifetime={isAdmin ? data.lifetime_total : undefined} />
            </motion.section>
            {isAdmin && (
              <motion.section {...rise(2)} className="flex-1">
                <TopLists data={data} />
              </motion.section>
            )}
          </div>

          {isAdmin && data.staff && (
            <motion.section {...rise(3)} className="col-span-12">
              <StaffLive rows={data.staff} today={data.today!} />
            </motion.section>
          )}

          <motion.section {...rise(4)} className="col-span-12 xl:col-span-8">
            <LiveSessions />
          </motion.section>

          <motion.section {...rise(5)} className="col-span-12 xl:col-span-4">
            <QuickActions data={data} onCounterSale={() => setCounterOpen(true)} canCounter={canCounter} />
          </motion.section>
        </div>
      )}
      <CheckoutDialog open={counterOpen} onOpenChange={setCounterOpen} tableId={null} />
    </Page>
  )
}

/**
 * The day at a glance: the headline figure, its make-up, and the hourly
 * pattern beneath — one continuous panel, the chart set straight onto it.
 */
/** Snacks sold without a table today (Snacks page / counter sales), kept live by the sales feed. */
function SnackOnlyNote() {
  const { data: day } = useBusinessDate()
  const { data } = useQuery({
    queryKey: keys.snackSales(day ?? '', day ?? ''),
    queryFn: () => api.getSnackSales(day!, day!),
    enabled: Boolean(day)
  })
  if (!data) return null
  return (
    <span data-testid="snack-only-today">
      {' '}
      Snacks without a table: {formatMoney(data.totals.total)} ({data.totals.count} sale{data.totals.count === 1 ? '' : 's'}).
    </span>
  )
}

function TodayHero({ data }: { data: Dashboard }) {
  const today = data.today!
  const cashShare = today.total > 0 ? today.cash / today.total : 0
  const delta = data.yesterday_total && data.yesterday_total > 0 ? (today.total - data.yesterday_total) / data.yesterday_total : null
  return (
    <div className="card flex h-full flex-col overflow-hidden" data-testid="today-sales">
      <div className="px-8 pt-8">
        <PanelHeading
          aside={
            today.archived && (
              <span className="flex items-center gap-1.5 rounded-full bg-sunken px-2.5 py-1 text-[11px] font-semibold text-fg-3">
                <Archive className="size-3" /> Includes archived total
              </span>
            )
          }
        >
          Today's sales
        </PanelHeading>
        <AnimatedMoney
          value={today.total}
          duration={0.9}
          className="mt-5 block figure text-[clamp(54px,5.6vw,78px)] leading-[0.92] text-forest-950"
          data-testid="today-total"
        />
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-fg-3">
          <span>
            {today.count} sale{today.count === 1 ? '' : 's'}
          </span>
          {today.discounts > 0 && <span>{formatMoney(today.discounts)} in discounts</span>}
          {delta !== null && (
            <span className={cn('flex items-center gap-1 font-semibold', delta >= 0 ? 'text-forest-700' : 'text-claret-600')}>
              {delta >= 0 ? <ArrowUpRight className="size-4" /> : <ArrowDownRight className="size-4" />}
              {Math.abs(Math.round(delta * 100))}% vs yesterday
            </span>
          )}
        </div>

        <div className="mt-9 flex h-1.5 gap-[2px] overflow-hidden rounded-full bg-forest-950/[0.06]">
          {today.total > 0 && (
            <>
              {cashShare > 0 && (
                <motion.div
                  className="h-full shrink-0 rounded-l-full"
                  style={{ background: SERIES_COLORS.cash }}
                  initial={{ width: 0 }}
                  animate={{ width: `${cashShare * 100}%` }}
                  transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
                />
              )}
              {cashShare < 1 && (
                <motion.div
                  className="h-full flex-1 rounded-r-full"
                  style={{ background: SERIES_COLORS.bank }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.5, delay: 0.25 }}
                />
              )}
            </>
          )}
        </div>
        <div className="mt-6 grid grid-cols-4 gap-6">
          <SplitFigure color={SERIES_COLORS.cash} label="Cash" value={today.cash} />
          <SplitFigure color={SERIES_COLORS.bank} label="Bank transfer" value={today.bank} />
          <SplitFigure label="Expenses" value={today.expenses} />
          <SplitFigure label="Net" value={today.net} strong />
        </div>
        <p className="mt-4 text-xs text-fg-4">
          Snack sales {formatMoney(today.snack)} — already included in Cash and Bank.
          <SnackOnlyNote />
        </p>
      </div>

      <HourlyChart data={data} />
    </div>
  )
}

/** Today's figures for every staff member, live, with business-wide totals. */
function StaffLive({ rows, today }: { rows: StaffDayRow[]; today: DayTotals }) {
  const { data: settings } = useSettings()
  const tz = settings?.business_timezone
  const [closing, setClosing] = useState<StaffDayRow | null>(null)
  const forceClose = useAction((shiftId: string) => api.closeCounter(shiftId, true), {
    invalidate: accountingKeys,
    success: 'Counter closed. Its summary is saved.'
  })
  const cell = 'px-4 py-3.5 text-right tabular'
  return (
    <div className="card overflow-hidden pb-2" data-testid="staff-live">
      <div className="flex items-center justify-between px-8 pt-7 pb-4">
        <PanelHeading>Staff today</PanelHeading>
        <span className="text-xs text-fg-4">Live — open counters update as staff sell</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-8 pb-6 text-sm text-fg-4">No counters have been opened today.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="thead-row">
              <th className="py-3 pr-4 pl-8">Staff</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Cash</th>
              <th className="px-4 py-3 text-right">Bank</th>
              <th className="px-4 py-3 text-right">Snack sales</th>
              <th className="px-4 py-3 text-right">Total sales</th>
              <th className="px-4 py-3 text-right">Expenses</th>
              <th className="px-4 py-3 text-right">Net</th>
              <th className="w-24 py-3 pr-8 pl-4" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.user_id} data-testid={`staff-row-${r.username}`} className="transition-colors hover:bg-canvas/50">
                <td className="py-3.5 pr-4 pl-8">
                  <span className="block font-semibold text-fg">{r.name}</span>
                  <span className="block text-xs text-fg-4">
                    {r.status === 'open' && r.open_since
                      ? `Open since ${formatTime(r.open_since, tz)}`
                      : r.last_closed_at
                        ? `Closed ${formatTime(r.last_closed_at, tz)}`
                        : ''}
                    {r.shifts > 1 ? ` · ${r.shifts} shifts` : ''}
                    {r.invoices ? ` · ${r.invoices} invoices` : ''}
                  </span>
                </td>
                <td className="px-4 py-3.5">
                  <ShiftStatusPill status={r.status} />
                </td>
                <td className={cn(cell, 'text-fg-2')}>
                  <AnimatedMoney value={r.cash} />
                </td>
                <td className={cn(cell, 'text-fg-2')}>
                  <AnimatedMoney value={r.bank} />
                </td>
                <td className={cn(cell, 'text-fg-3')}>
                  <AnimatedMoney value={r.snack} />
                </td>
                <td className={cn(cell, 'font-bold text-fg')}>
                  <AnimatedMoney value={r.total} />
                </td>
                <td className={cn(cell, 'text-fg-3')}>
                  <AnimatedMoney value={r.expenses} />
                </td>
                <td className={cn(cell, 'font-semibold text-forest-950')}>
                  <AnimatedMoney value={r.net} />
                </td>
                <td className="py-2 pr-8 pl-4 text-right">
                  {r.status === 'open' && r.open_shift_id && (
                    <Button size="sm" variant="ghost" onClick={() => setClosing(r)}>
                      Close
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong/70 font-bold" data-testid="staff-live-total">
              <td className="py-4 pr-4 pl-8 text-fg" colSpan={2}>
                All staff
              </td>
              <td className={cn(cell, 'py-4 text-fg')}>
                <AnimatedMoney value={today.cash} />
              </td>
              <td className={cn(cell, 'py-4 text-fg')}>
                <AnimatedMoney value={today.bank} />
              </td>
              <td className={cn(cell, 'py-4 text-fg-2')}>
                <AnimatedMoney value={today.snack} />
              </td>
              <td className={cn(cell, 'py-4 text-forest-950')}>
                <AnimatedMoney value={today.total} />
              </td>
              <td className={cn(cell, 'py-4 text-fg')}>
                <AnimatedMoney value={today.expenses} />
              </td>
              <td className={cn(cell, 'py-4 text-forest-950')}>
                <AnimatedMoney value={today.net} />
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}
      <ConfirmDialog
        open={closing !== null}
        onOpenChange={(o) => !o && setClosing(null)}
        tone="primary"
        title={`Close ${closing?.name ?? ''}'s counter?`}
        confirmLabel="Close counter"
        description="Use this when a staff member left without closing. Their figures so far become the shift's final summary."
        requireAcknowledgement="Any table sessions this counter started are handed over; they will be paid at whichever counter checks them out."
        onConfirm={async () => {
          if (closing?.open_shift_id) await forceClose.mutateAsync(closing.open_shift_id)
        }}
      />
    </div>
  )
}

/** A staff member's own counter at a glance (always visible to them). */
function MyCounterCard({ shift }: { shift: Shift | null }) {
  const navigate = useNavigate()
  const open = useAction(api.openCounter, { invalidate: accountingKeys, success: 'Counter opened.' })
  if (!shift) {
    return (
      <div className="card flex h-full min-h-[300px] flex-col justify-center gap-5 p-8" data-testid="my-counter-card">
        <PanelHeading>My counter</PanelHeading>
        <p className="font-display-tight text-[30px] leading-tight text-forest-950">Your counter is closed</p>
        <p className="max-w-md text-sm text-fg-3">Open it to take payments and record expenses. Everything you sell is kept on your own shift.</p>
        <div>
          <Button variant="primary" size="lg" icon={<Wallet className="size-4" />} loading={open.isPending} onClick={() => open.mutate(undefined)}>
            Open counter
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="card h-full p-8" data-testid="my-counter-card">
      <PanelHeading aside={<PanelLink onClick={() => navigate('/counter')}>My counter</PanelLink>}>My counter · open</PanelHeading>
      <AnimatedMoney value={shift.total} duration={0.9} className="mt-5 block figure text-[clamp(50px,5.2vw,68px)] leading-[0.92] text-forest-950" />
      <p className="mt-4 text-sm text-fg-3">
        {shift.invoices} invoice{shift.invoices === 1 ? '' : 's'} on this shift
      </p>
      <ShiftFigures figures={shift} className="mt-10" />
    </div>
  )
}

function SplitFigure({ color, label, value, strong }: { color?: string; label: string; value: number; strong?: boolean }) {
  return (
    <div>
      <p className="flex items-center gap-2 text-xs font-semibold text-fg-3">
        {color && <span className="size-2 rounded-full" style={{ background: color }} />}
        {label}
      </p>
      <AnimatedMoney value={value} className={cn('mt-2 block figure text-[25px] leading-none', strong ? 'text-forest-950' : 'text-fg-2')} />
    </div>
  )
}

function FloorStatus({ data, lifetime }: { data: Dashboard; lifetime?: number }) {
  const t = data.tables
  const rows: [keyof typeof statusMeta, number][] = [
    ['running', t.running],
    ['paused', t.paused],
    ['billing', t.billing],
    ['available', t.available]
  ]
  const occupied = t.running + t.paused + t.billing
  return (
    <div className="card flex h-full flex-col p-7">
      <PanelHeading>Floor right now</PanelHeading>
      <p className="mt-4 flex items-baseline gap-2">
        <span className="figure text-[44px] leading-none text-forest-950">{occupied}</span>
        <span className="text-sm font-medium text-fg-3 tabular">of {t.total} tables in play</span>
      </p>
      <div className="mt-5 flex h-1.5 gap-[2px] overflow-hidden rounded-full bg-forest-950/[0.06]">
        {t.total > 0 &&
          rows
            .filter(([s, n]) => s !== 'available' && n > 0)
            .map(([s, n]) => (
              <motion.div
                key={s}
                className={cn('h-full first:rounded-l-full', statusMeta[s].dot)}
                initial={{ width: 0 }}
                animate={{ width: `${(n / t.total) * 100}%` }}
                transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
              />
            ))}
      </div>
      <ul className="mt-5 space-y-1">
        {rows.map(([status, n]) => (
          <li key={status} className="flex items-center justify-between py-1.5">
            <span className="flex items-center gap-2.5 text-sm font-medium text-fg-2">
              <span className={cn('size-2 rounded-full', statusMeta[status].dot)} />
              {statusMeta[status].label}
            </span>
            <span className="figure text-[18px] text-forest-950">{n}</span>
          </li>
        ))}
      </ul>
      {lifetime !== undefined && (
        <div className="mt-6 flex items-center justify-between rounded-2xl bg-sunken/70 px-4 py-3.5">
          <span className="text-xs font-semibold text-fg-3">Lifetime sales</span>
          <span className="figure text-[15px] text-forest-950">{formatMoney(lifetime)}</span>
        </div>
      )}
    </div>
  )
}

function LiveRow({ table, onClick }: { table: TableOverview; onClick: () => void }) {
  const live = useLive(table.session)
  if (!table.session || !live) return null
  return (
    <button onClick={onClick} className="flex w-full items-center gap-4 rounded-xl px-3 py-3.5 text-left transition-colors hover:bg-canvas/60">
      <div className="min-w-0 flex-1">
        <p className="truncate font-display-tight text-[17px] leading-tight text-forest-950">{table.name}</p>
        <p className="mt-0.5 truncate text-xs text-fg-4">
          {table.category_name} · {table.floor_name}
          {table.session.customer ? ` · ${table.session.customer.name}` : ''}
        </p>
      </div>
      <StatusPill status={table.session.status} />
      <span className={cn('w-20 text-right figure text-lg', statusMeta[table.session.status].text)}>{formatClock(live.seconds)}</span>
      <span className="w-24 text-right figure text-[15px] text-forest-950">{formatMoney(live.total)}</span>
    </button>
  )
}

function LiveSessions() {
  const navigate = useNavigate()
  const { data } = useTablesOverview()
  const active = (data?.tables ?? []).filter((t) => t.session)
  const totalPaisa = active.reduce((s, t) => s + (t.session?.items.reduce((a, i) => a + toPaisa(i.unit_price) * i.quantity, 0) ?? 0), 0)
  return (
    <div className="card h-full p-7">
      <PanelHeading aside={<PanelLink onClick={() => navigate('/tables')}>Open floor</PanelLink>}>Live sessions</PanelHeading>
      {active.length === 0 ? (
        <EmptyState className="py-10" icon={<LayoutGrid className="size-5" />} title="All tables are free" description="Start a session from the Tables screen." />
      ) : (
        <div className="-mx-3 mt-3 max-h-[360px] divide-y divide-line overflow-y-auto">
          {active.map((t) => (
            <LiveRow key={t.id} table={t} onClick={() => navigate('/tables')} />
          ))}
        </div>
      )}
      {totalPaisa > 0 && <p className="mt-4 text-xs text-fg-4">{formatMoney(totalPaisa / 100)} in open tabs</p>}
    </div>
  )
}

function QuickAction({ icon, label, hint, onClick, tone = 'default' }: { icon: ReactNode; label: string; hint: string; onClick: () => void; tone?: 'default' | 'warn' }) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-3.5 rounded-2xl px-3 py-2.5 text-left transition-[background-color,scale] duration-150 hover:bg-canvas/70 active:scale-[0.99]"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 ease-out group-hover:-translate-y-px',
          tone === 'warn' ? 'bg-brass-100 text-brass-700' : 'bg-sunken text-forest-800'
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-forest-950">{label}</span>
        <span className={cn('block truncate text-xs', tone === 'warn' ? 'font-semibold text-brass-700' : 'text-fg-4')}>{hint}</span>
      </span>
      <ChevronRight className="ml-auto size-4 text-fg-5 transition-transform group-hover:translate-x-0.5 group-hover:text-fg-2" />
    </button>
  )
}

function QuickActions({ data, onCounterSale, canCounter }: { data: Dashboard; onCounterSale: () => void; canCounter: boolean }) {
  const navigate = useNavigate()
  const { isAdmin, can } = useAuth()
  return (
    <div className="card h-full p-4">
      <div className="px-3 pt-3 pb-2">
        <PanelHeading>Quick actions</PanelHeading>
      </div>
      <div className="space-y-0.5">
        <QuickAction icon={<LayoutGrid className="size-[18px]" />} label="Tables" hint={`${data.tables.available} available now`} onClick={() => navigate('/tables')} />
        {!isAdmin && (
          <QuickAction
            icon={<Wallet className="size-[18px]" />}
            label="My counter"
            hint={data.my_counter ? 'Open — expenses and shift figures' : 'Closed — open it to take payments'}
            tone={data.my_counter ? 'default' : 'warn'}
            onClick={() => navigate('/counter')}
          />
        )}
        {canCounter && <QuickAction icon={<ShoppingBag className="size-[18px]" />} label="Counter sale" hint="Sell snacks without a table" onClick={onCounterSale} />}
        {isAdmin && (
          <QuickAction
            icon={<CalendarClock className="size-[18px]" />}
            label="Pre-bookings"
            hint={data.bookings_today ? `${data.bookings_today} booked for today` : 'Reserve tables for customers'}
            onClick={() => navigate('/bookings')}
          />
        )}
        {isAdmin && (
          <QuickAction
            icon={<Archive className="size-[18px]" />}
            label="Close day"
            hint={data.open_days ? `${data.open_days} earlier day${data.open_days > 1 ? 's' : ''} not yet closed` : 'Finalise the day’s summary'}
            tone={data.open_days ? 'warn' : 'default'}
            onClick={() => navigate('/history?tab=close')}
          />
        )}
        {isAdmin && <QuickAction icon={<History className="size-[18px]" />} label="History" hint="Shifts, staff and daily figures" onClick={() => navigate('/history')} />}
        {isAdmin && <QuickAction icon={<PackagePlus className="size-[18px]" />} label="Inventory" hint="Products, prices and stock" onClick={() => navigate('/inventory')} />}
        {!isAdmin && can('adjust_stock') && <QuickAction icon={<Boxes className="size-[18px]" />} label="Restock" hint="Add stock to products" onClick={() => navigate('/inventory')} />}
        {isAdmin && <QuickAction icon={<UserCog className="size-[18px]" />} label="Staff" hint="Accounts, floors and permissions" onClick={() => navigate('/staff')} />}
      </div>
    </div>
  )
}

/** Hours of the business day in order (e.g. 06…23, 00…05 when the day starts at 06:00). */
function businessHours(data: Dashboard, startHour: number, timeZone: string | undefined): number[] {
  const pos = (h: number) => (h - startHour + 24) % 24
  const clubHour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(data.server_time))
  )
  const positions = (data.hourly ?? []).map((h) => pos(h.hour))
  const now = pos(clubHour)
  const first = positions.length ? Math.min(...positions, now) : Math.max(0, now - 5)
  const last = Math.max(...positions, now)
  return Array.from({ length: last - first + 1 }, (_, i) => (first + i + startHour) % 24)
}

/** Sales by hour, set into the foot of the Today panel; it fills the height the panel has left. */
function HourlyChart({ data }: { data: Dashboard }) {
  const { data: settings } = useSettings()
  const byHour = new Map((data.hourly ?? []).map((h) => [h.hour, h.total]))
  const range = businessHours(data, settings?.day_start_hour ?? 0, settings?.business_timezone)
  return (
    <div className="flex min-h-[260px] flex-1 flex-col px-8 pt-9 pb-6">
      <PanelHeading aside={<span className="text-xs text-fg-4">Today, club time</span>}>Sales by hour</PanelHeading>
      <BarChart
        className="mt-4 min-h-[200px] flex-1"
        height="auto"
        series={[{ key: 'total', label: 'Sales', color: SERIES_COLORS.total }]}
        data={range.map((h) => ({
          key: String(h),
          label: formatHour(h),
          title: `${formatHour(h, true)} – ${formatHour(h + 1, true)}`,
          values: { total: byHour.get(h) ?? 0 }
        }))}
        formatValue={(v) => formatMoney(v)}
        formatAxis={compactMoney}
        emptyLabel="No sales yet today"
      />
    </div>
  )
}

function TopLists({ data }: { data: Dashboard }) {
  const navigate = useNavigate()
  return (
    <div className="card h-full p-7">
      <section>
        <PanelHeading>Best sellers today</PanelHeading>
        {data.top_products?.length ? (
          <ul className="mt-4 space-y-3">
            {data.top_products.map((p, i) => (
              <li key={p.name} className="flex items-center gap-3 text-sm">
                <span className="w-4 shrink-0 text-xs font-bold text-fg-5 tabular">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate font-semibold text-fg">{p.name}</span>
                <span className="shrink-0 text-xs text-fg-4 tabular">{p.quantity} sold</span>
                <span className="w-20 shrink-0 text-right figure text-[14px] text-forest-950">{formatMoney(p.revenue)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-fg-4">No products sold yet today.</p>
        )}
      </section>
      {Boolean(data.low_stock?.length) && (
        <section className="mt-7">
          <button onClick={() => navigate('/inventory')} className="-mx-3 w-[calc(100%+24px)] rounded-2xl bg-brass-50 px-3 py-3 text-left transition-colors hover:bg-brass-100">
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-brass-600" />
              <span className="label !text-brass-700">Low stock</span>
            </span>
            <ul className="mt-3 space-y-1.5">
              {data.low_stock!.slice(0, 5).map((p) => (
                <li key={p.id} className="flex justify-between gap-3 text-sm">
                  <span className="truncate text-fg">{p.name}</span>
                  <span className={cn('shrink-0 font-bold tabular', p.stock_quantity === 0 ? 'text-claret-700' : 'text-brass-700')}>
                    {p.stock_quantity === 0 ? 'Out' : `${p.stock_quantity} left`}
                  </span>
                </li>
              ))}
            </ul>
          </button>
        </section>
      )}
    </div>
  )
}
