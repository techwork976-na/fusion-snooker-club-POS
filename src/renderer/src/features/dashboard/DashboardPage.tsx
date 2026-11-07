import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
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
import { compactMoney, SERIES_ON_DARK } from '@/components/charts/BarChart'
import { TrendChart } from '@/components/charts/TrendChart'
import { AnimatedMoney } from '@/components/motion/AnimatedNumber'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Modal'
import { Delta, EmptyState, ErrorState, Page, PageHeader, Skeleton } from '@/components/ui/Misc'
import { useAuth } from '@/features/auth/AuthProvider'
import { CheckoutDialog } from '@/features/pos/CheckoutDialog'
import { ShiftFigures, ShiftStatusPill } from '@/features/shifts/ShiftParts'
import { StatusPill } from '@/features/tables/TableCard'
import { statusMeta, useLive } from '@/features/tables/session'
import { ProductImage } from '@/components/ui/ProductImage'

const rise = (i: number) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.4, delay: 0.05 * i, ease: [0.22, 1, 0.36, 1] as const }
})

/** Cash and bank on the deep forest hero: the series hues, stepped for the dark surface. */
const ON_DARK = SERIES_ON_DARK
/** The day's sales curve on the felt: the baize of the cash series, lifted to read on the dark. */
const SALES_ON_DARK = '#2f9a63'

function PanelHeading({ children, aside, dark }: { children: ReactNode; aside?: ReactNode; dark?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={cn('label', dark && '!text-side-muted')}>{children}</span>
      {aside}
    </div>
  )
}

function PanelLink({ children, onClick, dark }: { children: ReactNode; onClick: () => void; dark?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'group flex items-center gap-1 text-xs font-bold transition-colors',
        dark ? 'text-brass-300 hover:text-cream' : 'text-brass-700 hover:text-forest-950'
      )}
    >
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
          <Skeleton className="col-span-12 h-[520px] rounded-[var(--radius-card)] md:col-span-8" />
          <Skeleton className="col-span-12 h-[520px] rounded-[var(--radius-card)] md:col-span-4" />
          <Skeleton className="col-span-12 h-56 rounded-[var(--radius-card)]" />
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-4 sm:gap-6">
          {isAdmin && data.today ? (
            <>
              {/* The day's money and its hourly curve, across the page. */}
              <motion.section {...rise(0)} className="col-span-12">
                <TodayHero data={data} />
              </motion.section>
              {/* The floor: who is playing now, and the room at a glance. */}
              <motion.section {...rise(1)} className="col-span-12 xl:col-span-8">
                <LiveSessions />
              </motion.section>
              <motion.section {...rise(2)} className="col-span-12 xl:col-span-4">
                <FloorStatus data={data} lifetime={data.lifetime_total} />
              </motion.section>
              {data.staff && (
                <motion.section {...rise(3)} className="col-span-12">
                  <StaffLive rows={data.staff} today={data.today} />
                </motion.section>
              )}
              {/* Low stock is an alert, shown only when something runs low; sales figures live on Snacks and the reports. */}
              {Boolean(data.low_stock?.length) && (
                <motion.section {...rise(4)} className="col-span-12 lg:col-span-5">
                  <LowStockAlert data={data} />
                </motion.section>
              )}
              <motion.section {...rise(5)} className={cn('col-span-12', data.low_stock?.length && 'lg:col-span-7')}>
                <QuickActions data={data} onCounterSale={() => setCounterOpen(true)} canCounter={canCounter} width={data.low_stock?.length ? 'half' : 'full'} />
              </motion.section>
            </>
          ) : (
            <>
              <motion.section {...rise(0)} className="col-span-12 xl:col-span-8">
                <MyCounterCard shift={data.my_counter ?? null} />
              </motion.section>
              <motion.section {...rise(1)} className="col-span-12 xl:col-span-4">
                <FloorStatus data={data} lifetime={isAdmin ? data.lifetime_total : undefined} />
              </motion.section>
              {isAdmin && data.staff && data.today && (
                <motion.section {...rise(2)} className="col-span-12">
                  <StaffLive rows={data.staff} today={data.today} />
                </motion.section>
              )}
              {isAdmin && Boolean(data.low_stock?.length) && (
                <motion.section {...rise(2)} className="col-span-12">
                  <LowStockAlert data={data} />
                </motion.section>
              )}
              <motion.section {...rise(2)} className="col-span-12 xl:col-span-8">
                <LiveSessions />
              </motion.section>
              <motion.section {...rise(3)} className="col-span-12 xl:col-span-4">
                <QuickActions data={data} onCounterSale={() => setCounterOpen(true)} canCounter={canCounter} />
              </motion.section>
            </>
          )}
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
    <div className="card felt rail grid overflow-hidden bg-forest-950 [--rail:var(--color-brass-300)] xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]" data-testid="today-sales">
      <div className="relative px-5 pt-6 pb-7 sm:px-8 sm:pt-8 sm:pb-8">
        <PanelHeading
          dark
          aside={
            today.archived && (
              <span className="flex items-center gap-1.5 rounded-full bg-cream/10 px-2.5 py-1 text-[11px] font-semibold text-side-fg">
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
          className="mt-5 block figure-display text-[clamp(42px,12.5vw,56px)] leading-[0.9] text-cream sm:text-[clamp(56px,5.4vw,80px)]"
          data-testid="today-total"
        />
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-side-muted">
          {delta !== null && <Delta tone="dark" change={delta} against="vs yesterday" />}
          <span>
            {today.count} sale{today.count === 1 ? '' : 's'}
          </span>
          {today.discounts > 0 && <span>{formatMoney(today.discounts)} in discounts</span>}
        </div>

        <div className="mt-8 flex h-1.5 gap-[2px] overflow-hidden rounded-full bg-cream/10">
          {today.total > 0 && (
            <>
              {cashShare > 0 && (
                <motion.div
                  className="h-full shrink-0 rounded-l-full"
                  style={{ background: ON_DARK.cash }}
                  initial={{ width: 0 }}
                  animate={{ width: `${cashShare * 100}%` }}
                  transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
                />
              )}
              {cashShare < 1 && (
                <motion.div
                  className="h-full flex-1 rounded-r-full"
                  style={{ background: ON_DARK.bank }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.5, delay: 0.25 }}
                />
              )}
            </>
          )}
        </div>
        <div className="mt-6 grid grid-cols-2 gap-y-5 sm:grid-cols-4 xl:grid-cols-2">
          <SplitFigure color={ON_DARK.cash} label="Cash" value={today.cash} />
          <SplitFigure color={ON_DARK.bank} label="Bank transfer" value={today.bank} />
          <SplitFigure label="Expenses" value={today.expenses} />
          <SplitFigure label="Net" value={today.net} strong />
        </div>
        <p className="mt-6 text-xs leading-relaxed text-side-muted">
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
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 pt-6 pb-4 sm:px-8 sm:pt-7">
        <PanelHeading>Staff today</PanelHeading>
        <span className="text-xs text-fg-4">Live — open counters update as staff sell</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 pb-6 text-sm text-fg-4 sm:px-8">No counters have been opened today.</p>
      ) : (
        <table className="table-stack w-full text-sm">
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
                <td className="py-3.5 pr-4 pl-8" data-stack="top">
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
                <td className="px-4 py-3.5" data-stack="top end">
                  <ShiftStatusPill status={r.status} />
                </td>
                <td className={cn(cell, 'text-fg-2')} data-label="Cash">
                  <AnimatedMoney value={r.cash} />
                </td>
                <td className={cn(cell, 'text-fg-2')} data-label="Bank">
                  <AnimatedMoney value={r.bank} />
                </td>
                <td className={cn(cell, 'text-fg-3')} data-label="Snack sales">
                  <AnimatedMoney value={r.snack} />
                </td>
                <td className={cn(cell, 'font-bold text-fg')} data-label="Total sales">
                  <AnimatedMoney value={r.total} />
                </td>
                <td className={cn(cell, 'text-fg-3')} data-label="Expenses">
                  <AnimatedMoney value={r.expenses} />
                </td>
                <td className={cn(cell, 'font-semibold text-forest-950')} data-label="Net">
                  <AnimatedMoney value={r.net} />
                </td>
                <td className="py-2 pr-8 pl-4 text-right" data-stack="full">
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
              <td className="py-4 pr-4 pl-8 text-fg" colSpan={2} data-stack="title">
                All staff
              </td>
              <td className={cn(cell, 'py-4 text-fg')} data-label="Cash">
                <AnimatedMoney value={today.cash} />
              </td>
              <td className={cn(cell, 'py-4 text-fg')} data-label="Bank">
                <AnimatedMoney value={today.bank} />
              </td>
              <td className={cn(cell, 'py-4 text-fg-2')} data-label="Snack sales">
                <AnimatedMoney value={today.snack} />
              </td>
              <td className={cn(cell, 'py-4 text-forest-950')} data-label="Total sales">
                <AnimatedMoney value={today.total} />
              </td>
              <td className={cn(cell, 'py-4 text-fg')} data-label="Expenses">
                <AnimatedMoney value={today.expenses} />
              </td>
              <td className={cn(cell, 'py-4 text-forest-950')} data-label="Net">
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
      <div className="card flex h-full min-h-[260px] flex-col justify-center gap-5 p-6 sm:min-h-[300px] sm:p-8" data-testid="my-counter-card">
        <PanelHeading>My counter</PanelHeading>
        <p className="font-display-tight text-[26px] leading-tight text-forest-950 sm:text-[30px]">Your counter is closed</p>
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
    <div className="card felt rail h-full overflow-hidden bg-forest-950 p-5 [--rail:var(--color-brass-300)] sm:p-8" data-testid="my-counter-card">
      <PanelHeading dark aside={<PanelLink dark onClick={() => navigate('/counter')}>My counter</PanelLink>}>
        My counter · open
      </PanelHeading>
      <AnimatedMoney value={shift.total} duration={0.9} className="mt-5 block figure-display text-[clamp(42px,12.5vw,52px)] leading-[0.9] text-cream sm:text-[clamp(52px,5.2vw,72px)]" />
      <p className="mt-4 text-sm text-side-muted">
        {shift.invoices} invoice{shift.invoices === 1 ? '' : 's'} on this shift
      </p>
      <ShiftFigures figures={shift} tone="dark" className="mt-8 sm:mt-10 xl:!grid-cols-3" />
    </div>
  )
}

/** A figure on the hero panel. */
function SplitFigure({ color, label, value, strong }: { color?: string; label: string; value: number; strong?: boolean }) {
  return (
    <div className="border-l border-cream/[0.09] pl-4 sm:pl-5">
      <p className="flex items-center gap-2 font-mono text-[10.5px] font-medium tracking-[0.1em] text-side-muted uppercase">
        {color && <span className="h-[3px] w-3 rounded-full" style={{ background: color }} />}
        {label}
      </p>
      <AnimatedMoney value={value} className={cn('mt-2.5 block figure-display text-[23px] leading-none sm:text-[27px]', strong ? 'text-brass-200' : 'text-side-fg')} />
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
    <div className="card flex h-full flex-col p-5 sm:p-7">
      <PanelHeading>Floor right now</PanelHeading>
      <p className="mt-4 flex items-baseline gap-2.5">
        <span className="figure-display text-[52px] leading-none text-forest-950">{occupied}</span>
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
        <div className="mt-auto flex items-baseline justify-between border-t border-line pt-4 max-xl:mt-6">
          <span className="label">Lifetime sales</span>
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
    <button onClick={onClick} className="flex w-full items-center gap-4 rounded-xl px-3 py-3.5 text-left transition-colors hover:bg-canvas/60 max-sm:flex-wrap max-sm:gap-x-3 max-sm:gap-y-1.5">
      <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-7rem)]">
        <p className="truncate font-display-tight text-[17px] leading-tight text-forest-950">{table.name}</p>
        <p className="mt-0.5 truncate text-xs text-fg-4">
          {table.category_name} · {table.floor_name}
          {table.session.customer ? ` · ${table.session.customer.name}` : ''}
        </p>
      </div>
      <StatusPill status={table.session.status} />
      <span className={cn('w-24 text-right timer text-[19px] max-sm:order-1 max-sm:w-auto max-sm:text-left', statusMeta[table.session.status].text)}>{formatClock(live.seconds)}</span>
      <span className="w-24 text-right figure text-[15px] text-forest-950 max-sm:order-2 max-sm:ml-auto">{formatMoney(live.total)}</span>
    </button>
  )
}

function LiveSessions() {
  const navigate = useNavigate()
  const { data } = useTablesOverview()
  const active = (data?.tables ?? []).filter((t) => t.session)
  const totalPaisa = active.reduce((s, t) => s + (t.session?.items.reduce((a, i) => a + toPaisa(i.unit_price) * i.quantity, 0) ?? 0), 0)
  return (
    <div className="card h-full p-5 sm:p-7">
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
          'flex size-10 shrink-0 items-center justify-center rounded-full transition-[translate,background-color,color] duration-200 ease-out group-hover:-translate-y-px',
          tone === 'warn' ? 'bg-brass-100 text-brass-700' : 'bg-forest-950/[0.05] text-forest-800 group-hover:bg-forest-950 group-hover:text-cream'
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

/** `width`: the space the panel gets — a narrow side column keeps one list on large screens. */
function QuickActions({
  data,
  onCounterSale,
  canCounter,
  width = 'narrow'
}: {
  data: Dashboard
  onCounterSale: () => void
  canCounter: boolean
  width?: 'narrow' | 'half' | 'full'
}) {
  const navigate = useNavigate()
  const { isAdmin, can } = useAuth()
  return (
    <div className="card h-full p-4">
      <div className="px-3 pt-3 pb-2">
        <PanelHeading>Quick actions</PanelHeading>
      </div>
      <div className={cn('space-y-0.5 sm:grid sm:grid-cols-2 sm:gap-x-2 sm:space-y-0', width === 'narrow' && 'xl:grid-cols-1', width === 'full' && 'xl:grid-cols-3')}>
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

/**
 * Hours of the business day in order (e.g. 06…23, 00…05 when the day starts at 06:00), at least six:
 * early in the day the next hours are added as empty slots still to come (never as zero sales).
 */
function businessHours(data: Dashboard, startHour: number, timeZone: string | undefined): { hour: number; future: boolean }[] {
  const pos = (h: number) => (h - startHour + 24) % 24
  const clubHour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(data.server_time))
  )
  const positions = (data.hourly ?? []).map((h) => pos(h.hour))
  const now = pos(clubHour)
  // At least the last six hours of the business day, so the curve has a course to run.
  const first = Math.min(...positions, now, Math.max(0, now - 5))
  const last = Math.min(23, Math.max(...positions, now, first + 5))
  return Array.from({ length: last - first + 1 }, (_, i) => ({ hour: (first + i + startHour) % 24, future: first + i > Math.max(now, ...positions) }))
}

/** Sales by hour, set into the foot of the Today panel; it fills the height the panel has left. */
function HourlyChart({ data }: { data: Dashboard }) {
  const { data: settings } = useSettings()
  const byHour = new Map((data.hourly ?? []).map((h) => [h.hour, h.total]))
  const range = businessHours(data, settings?.day_start_hour ?? 0, settings?.business_timezone)
  return (
    <div className="relative flex min-h-[260px] flex-col border-t border-cream/[0.07] px-4 pt-6 pb-5 sm:min-h-[300px] sm:px-7 sm:pt-8 sm:pb-6 xl:border-t-0 xl:border-l">
      <PanelHeading dark aside={<span className="text-xs text-side-muted">Today, club time</span>}>
        Sales by hour
      </PanelHeading>
      <TrendChart
        tone="dark"
        label="Sales by hour"
        className="mt-5 min-h-[220px] flex-1"
        height="auto"
        series={[{ key: 'total', label: 'Sales', color: SALES_ON_DARK }]}
        data={range.map(({ hour: h, future }) => ({
          key: String(h),
          future,
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

/** Products at or below their low-stock level — an alert that opens Inventory. */
function LowStockAlert({ data }: { data: Dashboard }) {
  const navigate = useNavigate()
  const items = data.low_stock ?? []
  return (
    <button
      onClick={() => navigate('/inventory')}
      className="card h-full w-full bg-brass-50 p-5 text-left transition-colors hover:bg-brass-100 sm:p-6"
      data-testid="low-stock"
    >
      <span className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-brass-600" />
          <span className="label !text-brass-700">Low stock</span>
        </span>
        <span className="flex items-center gap-1 text-xs font-bold text-brass-700">
          Inventory <ChevronRight className="size-3.5" />
        </span>
      </span>
      <ul className="mt-4 space-y-2">
        {items.slice(0, 6).map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2.5">
              <ProductImage productId={p.id} name={p.name} size={26} />
              <span className="truncate text-fg">{p.name}</span>
            </span>
            <span className={cn('shrink-0 font-bold tabular', p.stock_quantity === 0 ? 'text-claret-700' : 'text-brass-700')}>
              {p.stock_quantity === 0 ? 'Out' : `${p.stock_quantity} left`}
            </span>
          </li>
        ))}
      </ul>
      {items.length > 6 && <p className="mt-3 text-xs text-brass-700">+{items.length - 6} more</p>}
    </button>
  )
}
