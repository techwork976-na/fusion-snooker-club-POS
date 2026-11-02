import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarClock, CalendarPlus, ChevronLeft, ChevronRight, MoreHorizontal, Pencil, Play, Trash2, UserX, Undo2, XCircle } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { addDays, formatBusinessDate, formatTime, fromClockParts, toClockParts, type Period } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { Booking, BookingStatus } from '@/lib/types'
import * as api from '@/data/api'
import { keys, useAction, useBusinessDate, useSettings, useTablesOverview } from '@/data/hooks'
import { Button, IconButton } from '@/components/ui/Button'
import { FieldShell, inputClass, Select, TextField } from '@/components/ui/Field'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { EmptyState, ErrorState, LoadingBlock, Page, PageHeader, Segmented } from '@/components/ui/Misc'

const STATUS: Record<BookingStatus, { label: string; pill: string }> = {
  booked: { label: 'Booked', pill: 'bg-brass-100 text-brass-800' },
  started: { label: 'Started', pill: 'bg-sage-100 text-sage-800' },
  completed: { label: 'Completed', pill: 'bg-sunken text-fg-3' },
  cancelled: { label: 'Cancelled', pill: 'bg-claret-50 text-claret-700' },
  no_show: { label: 'No-show', pill: 'bg-forest-950/[0.07] text-fg-2' }
}
const bookingKeys = [['bookings'], keys.tables, keys.dashboard]

export function BookingsPage() {
  const { data: today } = useBusinessDate()
  const { data: settings } = useSettings()
  const tz = settings?.business_timezone
  const [day, setDay] = useState<string | null>(null)
  const [editing, setEditing] = useState<Booking | 'new' | null>(null)
  const [starting, setStarting] = useState<Booking | null>(null)
  const [deleting, setDeleting] = useState<Booking | null>(null)
  useEffect(() => {
    if (today && !day) setDay(today)
  }, [today, day])

  const list = useQuery({ queryKey: keys.bookings(day ?? '', day ?? ''), queryFn: () => api.listBookings(day!, day!), enabled: Boolean(day) })
  const upcomingTo = today ? addDays(today, 30) : ''
  const upcoming = useQuery({ queryKey: keys.bookings(today ?? '', upcomingTo), queryFn: () => api.listBookings(today!, upcomingTo), enabled: Boolean(today) })
  const setStatus = useAction((a: { id: string; status: 'booked' | 'cancelled' | 'no_show' }) => api.setBookingStatus(a.id, a.status), {
    invalidate: bookingKeys,
    success: 'Booking updated.'
  })
  const remove = useAction(api.deleteBooking, { invalidate: bookingKeys, success: 'Booking deleted.' })

  const bookings = list.data ?? []
  const counts = (Object.keys(STATUS) as BookingStatus[]).map((s) => [s, bookings.filter((b) => b.status === s).length] as const)
  const byDay = new Map<string, Booking[]>()
  for (const b of (upcoming.data ?? []).filter((b) => b.status === 'booked')) byDay.set(b.business_date, [...(byDay.get(b.business_date) ?? []), b])

  return (
    <Page>
      <PageHeader
        title="Pre-bookings"
        subtitle="Reserve a table for a customer, then start it with one click when they arrive."
        actions={
          <Button variant="primary" icon={<CalendarPlus className="size-4" />} onClick={() => setEditing('new')}>
            New booking
          </Button>
        }
      />
      {!today || !day ? (
        <LoadingBlock />
      ) : (
        <div className="grid grid-cols-12 gap-6">
          <section className="card col-span-12 overflow-hidden xl:col-span-8">
            <div className="flex flex-wrap items-center justify-between gap-3 px-7 pt-6 pb-3">
              <div className="flex items-center gap-2">
                <IconButton label="Previous day" variant="secondary" size="sm" onClick={() => setDay(addDays(day, -1))}>
                  <ChevronLeft className="size-4" />
                </IconButton>
                <div className="min-w-44 text-center">
                  <p className="font-display-tight text-[19px] text-forest-950">{formatBusinessDate(day)}</p>
                </div>
                <IconButton label="Next day" variant="secondary" size="sm" onClick={() => setDay(addDays(day, 1))}>
                  <ChevronRight className="size-4" />
                </IconButton>
                {day !== today && (
                  <Button size="sm" variant="ghost" onClick={() => setDay(today)}>
                    Today
                  </Button>
                )}
                <input type="date" aria-label="Choose day" className={cn(inputClass, 'h-8 w-[150px] text-[13px]')} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
              </div>
              <p className="text-[13px] text-fg-3" data-testid="booking-count">
                <span className="font-bold text-forest-950">{bookings.length}</span> booking{bookings.length === 1 ? '' : 's'}
                {counts
                  .filter(([, n]) => n > 0)
                  .map(([s, n]) => ` · ${n} ${STATUS[s].label.toLowerCase()}`)
                  .join('')}
              </p>
            </div>
            {list.error ? (
              <div className="p-6">
                <ErrorState message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
              </div>
            ) : list.isLoading ? (
              <LoadingBlock />
            ) : bookings.length === 0 ? (
              <EmptyState icon={<CalendarClock className="size-5" />} title="No bookings for this day" action={<Button onClick={() => setEditing('new')}>Add a booking</Button>} />
            ) : (
              <ul className="divide-y divide-line" data-testid="booking-list">
                {bookings.map((b) => (
                  <li key={b.id} className="flex items-center gap-5 px-6 py-4">
                    <span className="w-24 shrink-0 figure text-[19px] text-forest-950">{formatTime(b.booking_at, tz)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-bold text-fg">{b.customer_name}</span>
                      <span className="block truncate text-xs text-fg-4">
                        {b.customer_phone ?? 'No phone'} · {b.table_name ? `${b.table_name} (${b.floor_name})` : 'Table chosen at start'}
                        {b.notes ? ` · ${b.notes}` : ''}
                      </span>
                    </span>
                    <span className={cn('rounded-full px-2.5 py-1 text-[11px] font-bold', STATUS[b.status].pill)}>{STATUS[b.status].label}</span>
                    <div className="flex w-36 shrink-0 items-center justify-end gap-1">
                      {b.status === 'booked' && (
                        <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} onClick={() => setStarting(b)} data-testid={`start-booking-${b.customer_name}`}>
                          Start
                        </Button>
                      )}
                      <BookingMenu
                        booking={b}
                        onEdit={() => setEditing(b)}
                        onStatus={(status) => setStatus.mutate({ id: b.id, status })}
                        onDelete={() => setDeleting(b)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card col-span-12 self-start p-6 xl:col-span-4">
            <span className="label">Upcoming</span>
            {upcoming.isLoading ? (
              <LoadingBlock />
            ) : byDay.size === 0 ? (
              <p className="mt-3 text-sm text-fg-4">No upcoming bookings in the next 30 days.</p>
            ) : (
              <ul className="mt-3 space-y-1">
                {[...byDay.entries()].map(([d, items]) => (
                  <li key={d}>
                    <button
                      onClick={() => setDay(d)}
                      className={cn('flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-forest-950/[0.04]', d === day && 'bg-forest-50')}
                    >
                      <span>
                        <span className="block font-semibold text-fg">{d === today ? 'Today' : formatBusinessDate(d)}</span>
                        <span className="block truncate text-xs text-fg-4">
                          {items
                            .slice(0, 3)
                            .map((b) => `${formatTime(b.booking_at, tz)} ${b.customer_name}`)
                            .join(' · ')}
                        </span>
                      </span>
                      <span className="ml-3 rounded-full bg-forest-950 px-2 text-xs leading-5 font-bold text-cream tabular">{items.length}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <BookingDialog booking={editing} defaultDate={day ?? today ?? ''} onClose={() => setEditing(null)} />
      <StartDialog booking={starting} onClose={() => setStarting(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this booking?"
        confirmLabel="Delete booking"
        description={deleting && `${deleting.customer_name} at ${formatTime(deleting.booking_at, tz)} on ${formatBusinessDate(deleting.business_date)}.`}
        onConfirm={async () => {
          if (deleting) await remove.mutateAsync(deleting.id)
        }}
      />
    </Page>
  )
}

function BookingMenu({
  booking,
  onEdit,
  onStatus,
  onDelete
}: {
  booking: Booking
  onEdit: () => void
  onStatus: (s: 'booked' | 'cancelled' | 'no_show') => void
  onDelete: () => void
}) {
  if (booking.status === 'started' || booking.status === 'completed') return null
  const item = 'flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-fg outline-none data-[highlighted]:bg-forest-950/[0.06]'
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button aria-label="More actions" className="flex size-8 items-center justify-center rounded-lg text-fg-3 hover:bg-forest-950/[0.06] hover:text-fg">
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="popover z-[70] w-48 p-1">
          {booking.status === 'booked' ? (
            <>
              <DropdownMenu.Item className={item} onSelect={onEdit}>
                <Pencil className="size-4 text-fg-3" /> Edit
              </DropdownMenu.Item>
              <DropdownMenu.Item className={item} onSelect={() => onStatus('no_show')}>
                <UserX className="size-4 text-fg-3" /> Mark no-show
              </DropdownMenu.Item>
              <DropdownMenu.Item className={item} onSelect={() => onStatus('cancelled')}>
                <XCircle className="size-4 text-fg-3" /> Cancel booking
              </DropdownMenu.Item>
            </>
          ) : (
            <DropdownMenu.Item className={item} onSelect={() => onStatus('booked')}>
              <Undo2 className="size-4 text-fg-3" /> Restore to booked
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item className={cn(item, 'text-claret-700')} onSelect={onDelete}>
            <Trash2 className="size-4" /> Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1))
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'))

function BookingDialog({ booking, defaultDate, onClose }: { booking: Booking | 'new' | null; defaultDate: string; onClose: () => void }) {
  const { data: settings } = useSettings()
  const { data: tables } = useQuery({ queryKey: keys.clubTables, queryFn: api.getClubTables })
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [date, setDate] = useState('')
  const [hour, setHour] = useState('7')
  const [minute, setMinute] = useState('00')
  const [period, setPeriod] = useState<Period>('PM')
  const [tableId, setTableId] = useState('none')
  const [notes, setNotes] = useState('')
  const save = useAction(api.saveBooking, { invalidate: bookingKeys, success: 'Booking saved.' })

  useEffect(() => {
    if (!booking) return
    if (booking === 'new') {
      setName('')
      setPhone('')
      setDate(defaultDate)
      setHour('7')
      setMinute('00')
      setPeriod('PM')
      setTableId('none')
      setNotes('')
      return
    }
    // Show the stored time in the club's local 12-hour form.
    const local = new Date(booking.booking_at).toLocaleTimeString('en-GB', {
      timeZone: settings?.business_timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
    const parts = toClockParts(local)
    const localDate = new Date(booking.booking_at).toLocaleDateString('en-CA', { timeZone: settings?.business_timezone })
    setName(booking.customer_name)
    setPhone(booking.customer_phone ?? '')
    setDate(localDate)
    setHour(String(parts.hour))
    setMinute(String(parts.minute - (parts.minute % 5)).padStart(2, '0'))
    setPeriod(parts.period)
    setTableId(booking.table_id ?? 'none')
    setNotes(booking.notes)
  }, [booking, defaultDate, settings?.business_timezone])

  const submit = () =>
    save.mutate(
      {
        id: booking && booking !== 'new' ? booking.id : null,
        customerName: name.trim(),
        customerPhone: phone.trim() || null,
        date,
        time: fromClockParts(Number(hour), Number(minute), period),
        tableId: tableId === 'none' ? null : tableId,
        notes: notes.trim()
      },
      { onSuccess: onClose }
    )

  return (
    <Modal
      open={booking !== null}
      onOpenChange={(o) => !o && onClose()}
      title={booking === 'new' ? 'New booking' : 'Edit booking'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim() || !date} onClick={submit} data-testid="save-booking">
            Save booking
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4">
        <TextField label="Customer name" value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="booking-name" />
        <TextField label="Phone" hint="Used to recognise returning customers" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" data-testid="booking-phone" />
        <FieldShell label="Date">
          <input type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} data-testid="booking-date" />
        </FieldShell>
        <FieldShell label="Time">
          <div className="flex items-center gap-2">
            <Select className="w-20" value={hour} onChange={setHour} options={HOURS.map((h) => ({ value: h, label: h }))} />
            <span className="text-fg-4">:</span>
            <Select className="w-20" value={minute} onChange={setMinute} options={MINUTES.map((m) => ({ value: m, label: m }))} />
            <Segmented
              layoutId="booking-period"
              size="sm"
              value={period}
              onChange={setPeriod}
              options={[
                { value: 'AM', label: 'AM' },
                { value: 'PM', label: 'PM' }
              ]}
            />
          </div>
        </FieldShell>
        <Select
          className="col-span-2"
          label="Table"
          value={tableId}
          onChange={setTableId}
          options={[
            { value: 'none', label: 'Choose when the customer arrives' },
            ...(tables ?? []).filter((t) => t.is_active).map((t) => ({ value: t.id, label: t.name }))
          ]}
        />
        <TextField containerClassName="col-span-2" label="Notes (optional)" maxLength={200} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </Modal>
  )
}

function StartDialog({ booking, onClose }: { booking: Booking | null; onClose: () => void }) {
  const { data: overview } = useTablesOverview()
  const [tableId, setTableId] = useState<string | null>(null)
  useEffect(() => setTableId(booking?.table_id ?? null), [booking])
  const start = useAction((a: { id: string; tableId: string | null }) => api.startBooking(a.id, a.tableId), {
    invalidate: bookingKeys,
    success: 'Booking started — the table timer is running.'
  })
  const free = (overview?.tables ?? []).filter((t) => !t.session)
  const chosen = overview?.tables.find((t) => t.id === tableId)
  return (
    <Modal
      open={booking !== null}
      onOpenChange={(o) => !o && onClose()}
      title={booking ? `Start ${booking.customer_name}'s booking` : 'Start booking'}
      description="This starts an ordinary table session. It is paid at a staff counter like any other table."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Play className="size-4" />}
            loading={start.isPending}
            disabled={!tableId || Boolean(chosen?.session)}
            onClick={() => booking && start.mutate({ id: booking.id, tableId }, { onSuccess: onClose })}
            data-testid="confirm-start-booking"
          >
            Start table
          </Button>
        </>
      }
    >
      <Select
        label="Table"
        value={tableId}
        onChange={setTableId}
        placeholder="Choose an available table"
        error={chosen?.session ? `${chosen.name} is in use right now — choose another table.` : null}
        options={[
          ...(chosen?.session ? [{ value: chosen.id, label: `${chosen.name} (in use)` }] : []),
          ...free.map((t) => ({ value: t.id, label: t.name, hint: `${t.category_name} · ${t.floor_name}` }))
        ]}
      />
    </Modal>
  )
}
