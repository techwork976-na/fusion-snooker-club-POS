import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { LayoutGrid, ShoppingBag } from 'lucide-react'
import { useTablesOverview } from '@/data/hooks'
import { errorMessage } from '@/lib/errors'
import type { TableOverview } from '@/lib/types'
import { Button } from '@/components/ui/Button'
import { EmptyState, ErrorState, Page, PageHeader, Segmented, Skeleton } from '@/components/ui/Misc'
import { useAuth } from '@/features/auth/AuthProvider'
import { CheckoutDialog } from '@/features/pos/CheckoutDialog'
import { SessionPanel } from './SessionPanel'
import { StartSessionDialog } from './StartSessionDialog'
import { TableCard } from './TableCard'
import { TableSalesReport } from './TableSalesReport'
import { statusMeta, useSessionActions } from './session'

type StatusFilter = 'all' | 'available' | 'active' | 'billing'

export function TablesPage() {
  const { isAdmin } = useAuth()
  const [params, setParams] = useSearchParams()
  // The Table Sales Report shows money, so it is for administrators only.
  const view = isAdmin && params.get('view') === 'report' ? 'report' : 'floor'
  const tabs = isAdmin ? (
    <Segmented
      layoutId="tables-view"
      value={view}
      onChange={(v) => setParams(v === 'floor' ? {} : { view: v })}
      options={[
        { value: 'floor', label: 'Live floor' },
        { value: 'report', label: 'Table Sales Report' }
      ]}
    />
  ) : null
  return view === 'report' ? <TableSalesReport tabs={tabs} /> : <TablesFloor tabs={tabs} />
}

function TablesFloor({ tabs }: { tabs: ReactNode }) {
  const { data, isLoading, error, refetch } = useTablesOverview()
  const { isAdmin, can, profile } = useAuth()
  const navigate = useNavigate()
  const actions = useSessionActions()
  const [floor, setFloor] = useState<string>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [startTable, setStartTable] = useState<TableOverview | null>(null)
  const [panelId, setPanelId] = useState<string | null>(null)
  const [checkout, setCheckout] = useState<{ open: boolean; tableId: string | null }>({ open: false, tableId: null })
  const openCheckout = (tableId: string | null) => setCheckout({ open: true, tableId })

  const tables = useMemo(() => data?.tables ?? [], [data])
  const floors = useMemo(() => {
    const map = new Map<number, string>()
    tables.forEach((t) => map.set(t.floor_id, t.floor_name))
    return [...map.entries()]
  }, [tables])

  const visible = tables.filter((t) => {
    if (floor !== 'all' && String(t.floor_id) !== floor) return false
    const s = t.session?.status
    if (status === 'available') return !s
    if (status === 'active') return s === 'running' || s === 'paused'
    if (status === 'billing') return s === 'billing'
    return true
  })
  const count = (fn: (t: TableOverview) => boolean) => tables.filter((t) => (floor === 'all' || String(t.floor_id) === floor) && fn(t)).length

  const panelTable = panelId ? tables.find((t) => t.id === panelId) ?? null : null
  const busyIds = new Set([
    ...[actions.pause, actions.resume, actions.end, actions.keepPlaying].filter((m) => m.isPending).map((m) => m.variables),
    ...(actions.extend.isPending && actions.extend.variables ? [actions.extend.variables.id] : [])
  ])

  return (
    <Page>
      <PageHeader
        title="Tables"
        subtitle={isAdmin ? 'Every floor, live. Payments are taken at staff counters.' : `${profile?.floor_name ?? 'All floors'} · live`}
        actions={
          <>
            {tabs}
            {!isAdmin && can('counter_sale') && (
              <Button variant="secondary" icon={<ShoppingBag className="size-4" />} onClick={() => openCheckout(null)}>
                Counter sale
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          {floors.length > 1 && (
            <Segmented
              layoutId="floor-filter"
              value={floor}
              onChange={setFloor}
              options={[{ value: 'all', label: 'All floors' }, ...floors.map(([id, name]) => ({ value: String(id), label: name }))]}
            />
          )}
          <Segmented
            layoutId="status-filter"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All', count: count(() => true) },
              { value: 'available', label: 'Available', count: count((t) => !t.session) },
              { value: 'active', label: 'In play', count: count((t) => t.session?.status === 'running' || t.session?.status === 'paused') },
              { value: 'billing', label: 'Checkout', count: count((t) => t.session?.status === 'billing') }
            ]}
          />
          <div className="ml-auto hidden items-center gap-4 text-xs text-fg-4 xl:flex">
            {(['available', 'running', 'paused', 'billing'] as const).map((s) => (
              <span key={s} className="flex items-center gap-1.5">
                <span className={`size-2 rounded-full ${statusMeta[s].dot}`} /> {statusMeta[s].label}
              </span>
            ))}
          </div>
        </div>
      </PageHeader>

      {error ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-5">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-[256px] rounded-[var(--radius-card)]" />
          ))}
        </div>
      ) : tables.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<LayoutGrid className="size-5" />}
            title={isAdmin ? 'No tables yet' : 'No tables on your floor'}
            description={isAdmin ? 'Add floors, categories with per-minute rates, and tables in Settings.' : 'Ask an administrator to assign tables to your floor.'}
            action={isAdmin && <Button variant="primary" onClick={() => navigate('/settings')}>Open settings</Button>}
          />
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState title="Nothing here" description="No tables match this filter." />
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-5">
          {visible.map((t) => (
            <TableCard
              key={t.id}
              table={t}
              busy={Boolean(t.session && busyIds.has(t.session.id))}
              onOpen={(x) => setPanelId(x.id)}
              onStart={setStartTable}
              onCheckout={(x) => openCheckout(x.id)}
              onPause={(id) => actions.pause.mutate(id)}
              onResume={(id) => actions.resume.mutate(id)}
              onEnd={(x) => x.session && actions.end.mutate(x.session.id, { onSuccess: () => openCheckout(x.id) })}
              onContinue={(id) => actions.keepPlaying.mutate(id)}
              onExtend={(id, from) => actions.extend.mutate({ id, minutes: 30, fromBookedSeconds: from })}
            />
          ))}
        </div>
      )}

      <StartSessionDialog table={startTable} onClose={() => setStartTable(null)} />
      <SessionPanel
        table={panelTable}
        onClose={() => setPanelId(null)}
        onCheckout={(x) => {
          setPanelId(null)
          openCheckout(x.id)
        }}
      />
      <CheckoutDialog open={checkout.open} onOpenChange={(o) => setCheckout((c) => ({ ...c, open: o }))} tableId={checkout.tableId} />
    </Page>
  )
}
