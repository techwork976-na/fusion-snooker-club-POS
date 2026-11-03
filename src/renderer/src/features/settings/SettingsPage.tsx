import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Building2, CalendarClock, Clock3, Database, DatabaseZap, Layers, LayoutGrid, Monitor, Pencil, Plus, ShieldCheck, Tags, Trash2, ArchiveRestore, PackageMinus } from 'lucide-react'
import { describePolicy, sessionCharge, slotPrice, type RoundingMode } from '@shared/billing'
import { formatHour, formatMoney, formatPricing, formatRate } from '@shared/format'
import { RetentionSection } from './RetentionSection'
import { DataManagementSection } from './DataManagementSection'
import { cn } from '@/lib/cn'
import type { AppInfo, PrinterInfo } from '@shared/ipc'
import type { Category, ClubTable, Floor, PricingMode, Settings } from '@/lib/types'
import * as api from '@/data/api'
import { keys, useAction, useCategories, useFloors, useSettings } from '@/data/hooks'
import { Button, IconButton } from '@/components/ui/Button'
import { parseAmount, parseIntStrict, parseRate, Select, Switch, TextField } from '@/components/ui/Field'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { LoadingBlock, Page, PageHeader, Segmented } from '@/components/ui/Misc'
import { useAuth } from '@/features/auth/AuthProvider'
import { ChangePasswordDialog } from '@/features/auth/ChangePasswordDialog'
import { canChoosePrinter, getAppInfo, isDesktop, listPrinters, printReceiptDocument } from '@/lib/platform'
import { readPrinterPrefs, writePrinterPrefs, type PrinterPrefs } from '@/features/pos/printing'
import { useToast } from '@/components/ui/Toast'

type Section = 'club' | 'day' | 'billing' | 'floors' | 'rates' | 'tables' | 'retention' | 'data' | 'security' | 'terminal'

const SECTIONS: { key: Section; label: string; icon: typeof Building2 }[] = [
  { key: 'club', label: 'Club & receipt', icon: Building2 },
  { key: 'day', label: 'Business day', icon: CalendarClock },
  { key: 'billing', label: 'Billing rules', icon: Clock3 },
  { key: 'floors', label: 'Floors', icon: Layers },
  { key: 'rates', label: 'Categories & rates', icon: Tags },
  { key: 'tables', label: 'Tables', icon: LayoutGrid },
  { key: 'retention', label: 'Data retention', icon: Database },
  { key: 'data', label: 'Data management', icon: DatabaseZap },
  { key: 'security', label: 'Account & security', icon: ShieldCheck },
  { key: 'terminal', label: 'This computer', icon: Monitor }
]

export function SettingsPage() {
  const [section, setSection] = useState<Section>('club')
  const { data: settings } = useSettings()
  return (
    <Page>
      <PageHeader title="Settings" subtitle="Club configuration. Changes apply to every terminal." />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[220px_1fr] lg:gap-8">
        <nav className="flex flex-row flex-wrap gap-1 lg:sticky lg:top-4 lg:flex-col">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={cn(
                'relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-left text-sm font-semibold transition-colors',
                section === s.key ? 'text-fg' : 'text-fg-3 hover:bg-forest-950/[0.03] hover:text-fg'
              )}
            >
              {section === s.key && (
                <motion.span layoutId="settings-nav" className="absolute inset-0 z-0 rounded-xl bg-surface shadow-[0_1px_2px_rgb(10_31_20/0.08)] ring-1 ring-line" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />
              )}
              <s.icon className={cn('relative z-[1] size-4', section === s.key ? 'text-forest-600' : '')} />
              <span className="relative z-[1]">{s.label}</span>
            </button>
          ))}
        </nav>
        <motion.div key={section} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="min-w-0">
          {!settings ? (
            <LoadingBlock />
          ) : section === 'club' ? (
            <ClubSection settings={settings} />
          ) : section === 'day' ? (
            <DaySection settings={settings} />
          ) : section === 'billing' ? (
            <BillingSection settings={settings} />
          ) : section === 'floors' ? (
            <FloorsSection />
          ) : section === 'rates' ? (
            <RatesSection />
          ) : section === 'tables' ? (
            <TablesSection />
          ) : section === 'retention' ? (
            <RetentionSection settings={settings} />
          ) : section === 'data' ? (
            <DataManagementSection />
          ) : section === 'security' ? (
            <SecuritySection settings={settings} />
          ) : (
            <TerminalSection />
          )}
        </motion.div>
      </div>
    </Page>
  )
}

function Panel({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="card max-w-3xl">
      <div className="px-8 pt-7 pb-2">
        <h2 className="font-display-tight text-[24px] text-forest-950">{title}</h2>
        {description && <p className="mt-1 text-sm text-fg-3">{description}</p>}
      </div>
      <div className="px-8 py-5">{children}</div>
      {footer && <div className="flex justify-end gap-2.5 rounded-b-[var(--radius-card)] bg-canvas/50 px-8 py-4">{footer}</div>}
    </section>
  )
}

function useSaveSettings() {
  return useAction((patch: Partial<Settings>) => api.updateSettings(patch), { invalidate: [keys.settings, keys.dashboard, keys.businessDate], success: 'Settings saved.' })
}

function ClubSection({ settings }: { settings: Settings }) {
  const save = useSaveSettings()
  const [form, setForm] = useState({
    club_name: settings.club_name,
    club_address: settings.club_address,
    club_phone: settings.club_phone,
    receipt_footer: settings.receipt_footer
  })
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))
  return (
    <Panel
      title="Club & receipt"
      description="Printed at the top and bottom of every receipt."
      footer={
        <Button variant="primary" loading={save.isPending} disabled={!form.club_name.trim()} onClick={() => save.mutate(form)}>
          Save
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <TextField containerClassName="col-span-2" label="Club name" value={form.club_name} onChange={set('club_name')} maxLength={80} />
        <TextField label="Address" value={form.club_address} onChange={set('club_address')} maxLength={200} />
        <TextField label="Phone" value={form.club_phone} onChange={set('club_phone')} maxLength={40} />
        <TextField containerClassName="col-span-2" label="Receipt footer" value={form.receipt_footer} onChange={set('receipt_footer')} maxLength={200} />
      </div>
    </Panel>
  )
}

const TIMEZONES = ['Asia/Karachi', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Kolkata', 'Asia/Dhaka', 'Europe/London', 'UTC']

function DaySection({ settings }: { settings: Settings }) {
  const save = useSaveSettings()
  const [tz, setTz] = useState(settings.business_timezone)
  const [hour, setHour] = useState(String(settings.day_start_hour))
  const zones = TIMEZONES.includes(tz) ? TIMEZONES : [tz, ...TIMEZONES]
  return (
    <Panel
      title="Business day"
      description="Decides which business date a sale belongs to — used by Today's Sales, reports and Close Day."
      footer={
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ business_timezone: tz, day_start_hour: Number(hour) })}>
          Save
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <Select label="Club timezone" value={tz} onChange={setTz} options={zones.map((z) => ({ value: z, label: z.replace('_', ' ') }))} />
        <Select
          label="Business day starts at"
          value={hour}
          onChange={setHour}
          options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${formatHour(h, true)}${h === 0 ? ' (midnight)' : h === 12 ? ' (noon)' : ''}` }))}
        />
      </div>
      <p className="mt-4 rounded-xl bg-sunken/70 px-4 py-3 text-sm text-fg-3">
        {Number(hour) === 0
          ? 'Each calendar day is its own business day.'
          : `A sale at ${formatHour(Number(hour) - 1, true).replace(':00', ':30')} counts toward the previous day, so a late night belongs to the evening it started.`}{' '}
        Changes apply to new sales only.
      </p>
    </Panel>
  )
}

function BillingSection({ settings }: { settings: Settings }) {
  const save = useSaveSettings()
  const [increment, setIncrement] = useState(String(settings.billing_increment_minutes))
  const [rounding, setRounding] = useState<RoundingMode>(settings.billing_rounding)
  const [minimum, setMinimum] = useState(String(settings.minimum_charge_minutes))
  const minN = parseIntStrict(minimum)
  const policy = { incrementMinutes: Number(increment), rounding, minimumMinutes: minN ?? 0 }
  const examples = [
    [9 * 60 + 30, '9 min 30 s'],
    [47 * 60 + 5, '47 min 5 s'],
    [63 * 60, '1 h 3 min']
  ] as const
  return (
    <Panel
      title="Billing rules"
      description="How playing time becomes a table charge. Rates are snapshotted when a session starts."
      footer={
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={minN === null || minN < 0 || minN > 600}
          onClick={() => save.mutate({ billing_increment_minutes: Number(increment), billing_rounding: rounding, minimum_charge_minutes: minN! })}
        >
          Save
        </Button>
      }
    >
      <div className="grid grid-cols-3 gap-4">
        <Select label="Bill in blocks of" value={increment} onChange={setIncrement} options={[1, 5, 10, 15, 30, 60].map((m) => ({ value: String(m), label: m === 1 ? '1 minute' : `${m} minutes` }))} />
        <Select
          label="Partly used block"
          value={rounding}
          onChange={setRounding}
          options={[
            { value: 'up', label: 'Charge in full', hint: 'Round up' },
            { value: 'nearest', label: 'Nearest', hint: 'Half or more is charged' },
            { value: 'down', label: 'Not charged', hint: 'Round down' }
          ]}
        />
        <TextField label="Minimum charge" suffix="min" inputMode="numeric" value={minimum} onChange={(e) => setMinimum(e.target.value)} error={minN === null || minN < 0 || minN > 600 ? '0–600' : null} />
      </div>
      <div className="mt-5 rounded-xl bg-sunken/70 p-4">
        <p className="text-sm font-semibold text-fg">{describePolicy(policy)}</p>
        <p className="mt-1 text-xs text-fg-4">Booked sessions (fixed time or amount) pay the booking; extra time uses these rules without the minimum.</p>
        <table className="mt-3 w-full text-sm">
          <tbody>
            {examples.map(([seconds, label]) => (
              <tr key={label}>
                <td className="py-1 text-fg-3">{label} at {formatRate(10)}</td>
                <td className="py-1 text-right font-bold text-fg tabular">{formatMoney(sessionCharge({ billableSeconds: seconds, ratePerMinute: 10 }, policy))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function SecuritySection({ settings }: { settings: Settings }) {
  const save = useSaveSettings()
  const { profile } = useAuth()
  const [minutes, setMinutes] = useState(String(settings.admin_idle_lock_minutes))
  const [passwordOpen, setPasswordOpen] = useState(false)
  return (
    <div className="space-y-5">
    <Panel
      title="Your account"
      description="The administrator login for this club."
      footer={
        <Button variant="primary" onClick={() => setPasswordOpen(true)} data-testid="settings-change-password">
          Change password
        </Button>
      }
    >
      <dl className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="label">Name</dt>
          <dd className="mt-1.5 font-semibold text-fg">{profile?.full_name}</dd>
        </div>
        <div>
          <dt className="label">Username</dt>
          <dd className="mt-1.5 font-semibold text-fg">{profile?.username}</dd>
        </div>
      </dl>
      <p className="mt-5 text-sm text-fg-3">
        Changing the password signs this account out on every other computer. Staff passwords are reset from the Staff page.
      </p>
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </Panel>
    <Panel
      title="Security"
      description="Protects the Admin portal on shared terminals."
      footer={
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ admin_idle_lock_minutes: Number(minutes) })}>
          Save
        </Button>
      }
    >
      <Select
        label="Lock the Admin portal after inactivity"
        value={minutes}
        onChange={setMinutes}
        options={[5, 10, 15, 30, 60, 0].map((m) => ({ value: String(m), label: m === 0 ? 'Never (not recommended)' : `${m} minutes` }))}
        className="max-w-xs"
      />
      <ul className="mt-5 space-y-2 text-sm text-fg-3">
        <li>• Switching Staff → Admin always requires the Admin master password.</li>
        <li>• Passwords are verified by Supabase Auth (bcrypt); FUSION never stores them.</li>
        <li>• Every permission and floor restriction is checked again by the database on each request.</li>
      </ul>
    </Panel>
    </div>
  )
}

// --- floors ---------------------------------------------------------------
function FloorsSection() {
  const { data: floors } = useFloors()
  const [editing, setEditing] = useState<Floor | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Floor | null>(null)
  const remove = useAction(api.deleteFloor, { invalidate: [keys.floors, keys.tables], success: 'Floor removed.' })
  return (
    <Panel
      title="Floors"
      description="Tables and staff are assigned to floors; staff only see their own floor."
      footer={
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
          Add floor
        </Button>
      }
    >
      {!floors?.length ? (
        <p className="text-sm text-fg-4">No floors yet. Add at least one before creating tables.</p>
      ) : (
        <ul className="divide-y divide-line">
          {floors.map((f) => (
            <li key={f.id} className="flex items-center justify-between py-2.5">
              <span className="font-semibold text-fg">{f.name}</span>
              <div className="flex gap-1">
                <IconButton size="sm" label="Rename" onClick={() => setEditing(f)}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton size="sm" variant="danger" label="Delete" onClick={() => setDeleting(f)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <NameDialog
        open={editing !== null}
        title={editing === 'new' ? 'Add floor' : 'Rename floor'}
        initial={editing && editing !== 'new' ? { name: editing.name, sort: editing.sort_order } : { name: '', sort: (floors?.length ?? 0) + 1 }}
        onClose={() => setEditing(null)}
        onSave={(name, sort) => api.saveFloor(editing && editing !== 'new' ? editing.id : null, name, sort)}
        invalidate={[keys.floors, keys.tables]}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}?`}
        confirmLabel="Delete floor"
        description="Only floors without tables or assigned staff can be deleted."
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id)
        }}
      />
    </Panel>
  )
}

function NameDialog({
  open,
  title,
  initial,
  onClose,
  onSave,
  invalidate
}: {
  open: boolean
  title: string
  initial: { name: string; sort: number }
  onClose: () => void
  onSave: (name: string, sort: number) => Promise<unknown>
  invalidate: readonly (readonly unknown[])[]
}) {
  const [name, setName] = useState('')
  const [sort, setSort] = useState('0')
  const save = useAction((a: { name: string; sort: number }) => onSave(a.name, a.sort), { invalidate: invalidate as unknown[][], success: 'Saved.' })
  useEffect(() => {
    if (open) {
      setName(initial.name)
      setSort(String(initial.sort))
    }
  }, [open])
  const submit = () => name.trim() && save.mutate({ name: name.trim(), sort: parseIntStrict(sort) ?? 0 }, { onSuccess: onClose })
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-[1fr_110px] gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus />
        <TextField label="Order" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

// --- categories & rates ---------------------------------------------------
function RatesSection() {
  const { data: categories } = useCategories()
  const [editing, setEditing] = useState<Category | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Category | null>(null)
  const remove = useAction(api.deleteCategory, { invalidate: [keys.categories], success: 'Category deleted.' })
  return (
    <Panel
      title="Categories & rates"
      description="Price per game type: per minute (e.g. Snooker, Pool), or hourly with a special 30-minute price (e.g. PS5, Table Tennis)."
      footer={
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
          Add category
        </Button>
      }
    >
      {!categories?.length ? (
        <p className="text-sm text-fg-4">No categories yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {categories.map((c) => (
            <li key={c.id} className={cn('flex items-center justify-between py-2.5', !c.is_active && 'opacity-50')}>
              <span className="font-semibold text-fg">
                {c.name}
                {!c.is_active && <span className="ml-2 text-xs text-fg-4">hidden</span>}
              </span>
              <div className="flex items-center gap-3">
                <span className="font-bold text-fg tabular" data-testid={`category-price-${c.name}`}>
                  {formatPricing(c)}
                </span>
                <IconButton size="sm" label="Edit" onClick={() => setEditing(c)}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton size="sm" variant="danger" label="Delete category" onClick={() => setDeleting(c)}>
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <CategoryDialog category={editing} count={categories?.length ?? 0} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'category'}?`}
        confirmLabel="Delete for good"
        description="Only a category no table has ever used can be deleted. If tables use it, it stays (and you can hide it from new tables in Edit) so their history keeps its name."
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id)
        }}
      />
    </Panel>
  )
}

function CategoryDialog({ category, count, onClose }: { category: Category | 'new' | null; count: number; onClose: () => void }) {
  const [name, setName] = useState('')
  const [mode, setMode] = useState<PricingMode>('per_minute')
  const [rate, setRate] = useState('')
  const [hourly, setHourly] = useState('')
  const [special, setSpecial] = useState('')
  const [active, setActive] = useState(true)
  const save = useAction(api.saveCategory, { invalidate: [keys.categories, keys.tables], success: 'Category saved.' })
  useEffect(() => {
    if (category === 'new') {
      setName('')
      setMode('per_minute')
      setRate('')
      setHourly('')
      setSpecial('')
      setActive(true)
    } else if (category) {
      setName(category.name)
      setMode(category.pricing_mode)
      setRate(category.pricing_mode === 'per_minute' ? String(Number(category.rate_per_minute)) : '')
      setHourly(category.hourly_rate != null ? String(Number(category.hourly_rate)) : '')
      setSpecial(category.special_30_rate != null ? String(Number(category.special_30_rate)) : '')
      setActive(category.is_active)
    }
  }, [category])
  const rateN = parseRate(rate)
  const hourlyN = parseAmount(hourly)
  const specialN = parseAmount(special)
  const hourlyOk = hourlyN !== null && hourlyN > 0
  const specialOk = specialN !== null && specialN > 0
  const valid = Boolean(name.trim()) && (mode === 'per_minute' ? rateN !== null : hourlyOk && specialOk)
  const submit = () =>
    valid &&
    category &&
    save.mutate(
      {
        id: category === 'new' ? null : category.id,
        name: name.trim(),
        pricing_mode: mode,
        rate_per_minute: mode === 'per_minute' ? rateN : null,
        hourly_rate: mode === 'hourly_special30' ? hourlyN : null,
        special_30_rate: mode === 'hourly_special30' ? specialN : null,
        sort_order: category === 'new' ? count + 1 : category.sort_order,
        is_active: active
      },
      { onSuccess: onClose }
    )
  return (
    <Modal
      open={category !== null}
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title={category === 'new' ? 'Add category' : 'Edit category'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={submit} data-testid="save-category">
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Snooker" maxLength={40} autoFocus />
        <div>
          <p className="mb-2 text-[13px] font-semibold text-fg-2">Pricing</p>
          <Segmented
            layoutId="category-pricing-mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'per_minute', label: 'Per minute' },
              { value: 'hourly_special30', label: 'Hourly + special 30-minute rate' }
            ]}
          />
        </div>
        {mode === 'per_minute' ? (
          <TextField
            label="Rate per minute"
            prefix="PKR"
            suffix="/min"
            inputMode="decimal"
            placeholder="10"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            error={rate.trim() && rateN === null ? 'Enter a rate above zero (up to 4 decimals).' : null}
            hint="Open play, fixed time and fixed amount are billed at this rate. Running sessions keep the rate they started with."
            data-testid="category-rate"
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <TextField
                label="Hourly rate"
                prefix="PKR"
                suffix="/hour"
                inputMode="decimal"
                placeholder="600"
                value={hourly}
                onChange={(e) => setHourly(e.target.value)}
                error={hourly.trim() && !hourlyOk ? 'Enter an amount above zero.' : null}
                data-testid="category-hourly"
              />
              <TextField
                label="Special 30-minute rate"
                prefix="PKR"
                inputMode="decimal"
                placeholder="400"
                value={special}
                onChange={(e) => setSpecial(e.target.value)}
                error={special.trim() && !specialOk ? 'Enter an amount above zero.' : null}
                data-testid="category-special"
              />
            </div>
            {hourlyOk && specialOk && (
              <div className="rounded-xl bg-sunken/70 px-4 py-3" data-testid="category-price-table">
                <p className="text-xs font-semibold text-fg-3">Customers pay</p>
                <dl className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
                  {[30, 60, 90, 120, 150, 180].map((m) => (
                    <div key={m} className="flex justify-between gap-2">
                      <dt className="text-fg-3">{m < 60 ? '30 min' : `${m / 60} h`}</dt>
                      <dd className="font-semibold text-fg tabular">{formatMoney(slotPrice(m, hourlyN!, specialN!))}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            <p className="text-xs leading-relaxed text-fg-4">
              Sold in 30-minute steps: exactly 30 minutes is the special price; an hour or more is the hourly rate × hours (1.5 hours = 1.5 × the
              hourly rate — the special price is never added on top). Extensions re-price the whole time. Running sessions keep the prices they
              started with.
            </p>
          </>
        )}
        {category !== 'new' && <Switch checked={active} onChange={setActive} label="Available for new tables" />}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

// --- tables ---------------------------------------------------------------
function TablesSection() {
  const { data: tables } = useQuery({ queryKey: keys.clubTables, queryFn: api.getClubTables })
  const { data: floors } = useFloors()
  const { data: categories } = useCategories()
  const [editing, setEditing] = useState<ClubTable | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ClubTable | null>(null)
  const toggle = useAction((a: { id: string; active: boolean }) => api.setTableActive(a.id, a.active), {
    invalidate: [keys.clubTables, keys.tables, keys.dashboard],
    success: (t) => (t.is_active ? `${t.name} restored.` : `${t.name} removed from the floor.`)
  })
  const remove = useAction(api.deleteTable, { invalidate: [keys.clubTables, keys.tables, keys.dashboard], success: 'Table deleted.' })
  const ready = Boolean(floors?.length && categories?.length)
  return (
    <Panel
      title="Tables"
      description="Each table has a name, a floor and a category. Leave the rate empty to use the category rate."
      footer={
        <Button variant="primary" icon={<Plus className="size-4" />} disabled={!ready} onClick={() => setEditing('new')}>
          Add table
        </Button>
      }
    >
      {!ready && <p className="mb-3 text-sm text-brass-700">Add at least one floor and one category first.</p>}
      {!tables?.length ? (
        <p className="text-sm text-fg-4">No tables yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="thead-row">
              <th className="pb-2 font-semibold">Table</th>
              <th className="pb-2 font-semibold">Floor</th>
              <th className="pb-2 font-semibold">Category</th>
              <th className="pb-2 text-right font-semibold">Rate</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {tables.map((t) => {
              const cat = categories?.find((c) => c.id === t.category_id)
              return (
                <tr key={t.id} className={cn(!t.is_active && 'opacity-50')}>
                  <td className="py-2.5 font-semibold text-fg">
                    {t.name}
                    {!t.is_active && <span className="ml-2 text-xs text-fg-4">removed</span>}
                  </td>
                  <td className="py-2.5 text-fg-3">{floors?.find((f) => f.id === t.floor_id)?.name}</td>
                  <td className="py-2.5 text-fg-3">{cat?.name}</td>
                  <td className="py-2.5 text-right text-fg tabular">
                    {formatRate(t.rate_override ?? cat?.rate_per_minute ?? 0)}
                    {t.rate_override !== null && <span className="ml-1 text-xs text-forest-600">custom</span>}
                  </td>
                  <td className="py-1.5 pl-3">
                    <div className="flex justify-end gap-1">
                      <IconButton size="sm" label="Edit" onClick={() => setEditing(t)}>
                        <Pencil className="size-4" />
                      </IconButton>
                      <IconButton size="sm" variant={t.is_active ? 'danger' : 'ghost'} label={t.is_active ? 'Remove from floor' : 'Restore'} onClick={() => toggle.mutate({ id: t.id, active: !t.is_active })}>
                        {t.is_active ? <PackageMinus className="size-4" /> : <ArchiveRestore className="size-4" />}
                      </IconButton>
                      <IconButton size="sm" variant="danger" label="Delete table" onClick={() => setDeleting(t)}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'table'}?`}
        confirmLabel="Delete for good"
        description="Only a table that has never had a session or booking can be deleted. A table with history can only be removed from the floor, so reports keep it."
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id)
        }}
      />
      <TableDialog table={editing} floors={floors ?? []} categories={(categories ?? []).filter((c) => c.is_active || (editing !== 'new' && editing?.category_id === c.id))} onClose={() => setEditing(null)} />
    </Panel>
  )
}

function TableDialog({ table, floors, categories, onClose }: { table: ClubTable | 'new' | null; floors: Floor[]; categories: Category[]; onClose: () => void }) {
  const [name, setName] = useState('')
  const [floor, setFloor] = useState<string | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [rate, setRate] = useState('')
  const [sort, setSort] = useState('0')
  const save = useAction(api.saveTable, { invalidate: [keys.clubTables, keys.tables, keys.dashboard], success: (t) => `${t.name} saved.` })
  useEffect(() => {
    if (table === 'new') {
      setName('')
      setFloor(floors[0] ? String(floors[0].id) : null)
      setCategory(categories[0] ? String(categories[0].id) : null)
      setRate('')
      setSort('0')
    } else if (table) {
      setName(table.name)
      setFloor(String(table.floor_id))
      setCategory(String(table.category_id))
      setRate(table.rate_override === null ? '' : String(Number(table.rate_override)))
      setSort(String(table.sort_order))
    }
  }, [table])
  const rateN = rate.trim() === '' ? null : parseRate(rate)
  const rateInvalid = rate.trim() !== '' && rateN === null
  const valid = name.trim() && floor && category && !rateInvalid
  const submit = () =>
    valid &&
    table &&
    save.mutate(
      {
        id: table === 'new' ? null : table.id,
        name: name.trim(),
        floor_id: Number(floor),
        category_id: Number(category),
        rate_override: rateN,
        sort_order: parseIntStrict(sort) ?? 0
      },
      { onSuccess: onClose }
    )
  return (
    <Modal
      open={table !== null}
      onOpenChange={(o) => !o && onClose()}
      title={table === 'new' ? 'Add table' : 'Edit table'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Snooker 1" maxLength={40} autoFocus />
        <TextField label="Display order" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
        <Select label="Floor" value={floor} onChange={setFloor} options={floors.map((f) => ({ value: String(f.id), label: f.name }))} />
        <Select label="Category" value={category} onChange={setCategory} options={categories.map((c) => ({ value: String(c.id), label: c.name, hint: formatPricing(c) }))} />
        {categories.find((c) => String(c.id) === category)?.pricing_mode === 'hourly_special30' ? (
          <p className="col-span-2 rounded-xl bg-sunken/70 px-4 py-3 text-sm text-fg-3">This table uses its category's hourly and 30-minute prices.</p>
        ) : (
          <TextField containerClassName="col-span-2" label="Custom rate per minute" prefix="PKR" suffix="/min" inputMode="decimal" placeholder="Use category rate" value={rate} onChange={(e) => setRate(e.target.value)} error={rateInvalid ? 'Enter a rate above zero or leave empty.' : null} />
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

// --- this computer --------------------------------------------------------
const TEST_RECEIPT = {
  sale_id: '00000000-0000-4000-8000-000000000000',
  receipt_no: 0,
  created_at: new Date().toISOString(),
  business_date: new Date().toISOString().slice(0, 10),
  club: { name: 'FUSION', address: 'Test print', phone: '', footer: 'Printer is working' },
  table_name: 'Test',
  floor_name: null,
  customer_name: null,
  customer_phone: null,
  cashier_name: 'Test',
  payment_method: 'cash' as const,
  session: null,
  base_amount: 0,
  items: [],
  products_subtotal: 0,
  discount: 0,
  final_amount: 0
}

function TerminalSection() {
  const toast = useToast()
  const [prefs, setPrefs] = useState<PrinterPrefs>(readPrinterPrefs)
  const [printers, setPrinters] = useState<PrinterInfo[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void listPrinters().then(setPrinters)
    void getAppInfo().then(setInfo)
  }, [])
  const update = (patch: Partial<PrinterPrefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    writePrinterPrefs(next)
  }
  return (
    <div className="space-y-5">
      <Panel
        title="Receipt printer"
        description={
          canChoosePrinter
            ? 'Saved on this computer only, so every counter can use its own printer.'
            : "Saved in this browser only. The browser's print dialog chooses the printer."
        }
      >
        <div className="grid grid-cols-2 gap-4">
          {canChoosePrinter && (
            <Select
              label="Printer"
              value={prefs.deviceName || '__default'}
              onChange={(v) => update({ deviceName: v === '__default' ? '' : v })}
              options={[{ value: '__default', label: 'Ask each time / system default' }, ...printers.map((p) => ({ value: p.name, label: p.displayName, hint: p.isDefault ? 'Default' : undefined }))]}
            />
          )}
          <Select
            label="Paper"
            value={prefs.paper}
            onChange={(v) => update({ paper: v })}
            options={[
              { value: '80mm', label: '80 mm thermal' },
              { value: '58mm', label: '58 mm thermal' },
              { value: 'a4', label: 'A4 / Letter' }
            ]}
          />
        </div>
        <div className="mt-5 space-y-4">
          {canChoosePrinter && (
            <Switch checked={prefs.silent} onChange={(v) => update({ silent: v })} disabled={!prefs.deviceName} label="Print without a dialog" description="Requires a selected printer." />
          )}
          <Switch checked={prefs.autoPrint} onChange={(v) => update({ autoPrint: v })} label="Print automatically after checkout" description={canChoosePrinter ? undefined : 'Opens the print dialog after each payment.'} />
        </div>
        <Button
          className="mt-5"
          onClick={async () => {
            const res = await printReceiptDocument(TEST_RECEIPT, {
              paper: prefs.paper,
              silent: canChoosePrinter && prefs.silent && Boolean(prefs.deviceName),
              deviceName: (canChoosePrinter && prefs.deviceName) || undefined
            })
            if (res.ok) toast.success(isDesktop ? 'Test page sent.' : 'Test page ready to print.')
            else toast.error(res.error ?? 'Printing failed.')
          }}
        >
          Print test page
        </Button>
      </Panel>
      {info && (
        <p className="px-1 text-xs text-fg-4" data-testid="app-version">
          FUSION {info.version} · {info.platform === 'web' ? 'Web' : info.platform}
          {info.packaged ? '' : ' · development build'}
        </p>
      )}
    </div>
  )
}
