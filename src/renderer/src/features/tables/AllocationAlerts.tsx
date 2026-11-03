import { useEffect, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { BellRing, Play, Plus, Square, VolumeX } from 'lucide-react'
import { isAllocationComplete } from '@shared/billing'
import { formatDuration, formatMoney } from '@shared/format'
import type { TableOverview } from '@/lib/types'
import { audioReady, installAudioUnlock, onAudioStateChange, startAlarm, stopAlarm } from '@/lib/alarm'
import { useServerNow, useTablesOverview } from '@/data/hooks'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useSessionActions } from './session'

/**
 * "Time's up" for fixed-time and fixed-amount sessions, on every page.
 *
 * Each table alerts on its own, once: the popup and alarm last until someone
 * silences that table's alarm (stored in the database, so every terminal
 * stops and a refresh never rings again) or ends / continues the session.
 * Silencing changes nothing else — billing already holds at the booking until
 * staff end or continue it.
 */
export function AllocationAlerts() {
  const { data } = useTablesOverview()
  const now = useServerNow()
  const actions = useSessionActions()
  const navigate = useNavigate()
  // Clicked here but not yet confirmed by the server: stop ringing at once.
  const [silenced, setSilenced] = useState<ReadonlySet<string>>(new Set())
  const soundOn = useSyncExternalStore(onAudioStateChange, audioReady)

  useEffect(() => installAudioUnlock(), [])

  const due = (data?.tables ?? []).filter(
    (t): t is TableOverview & { session: NonNullable<TableOverview['session']> } =>
      Boolean(
        t.session &&
          (t.session.status === 'running' || t.session.status === 'paused') &&
          !t.session.allocation_alert_ack_at &&
          !silenced.has(t.session.id) &&
          isAllocationComplete(t.session, now)
      )
  )
  const ringing = due.length > 0
  const names = due.map((t) => t.name).join(', ')

  useEffect(() => {
    if (ringing) startAlarm()
    else stopAlarm()
  }, [ringing])
  useEffect(() => () => stopAlarm(), [])

  // A background tab shows it in its title too.
  useEffect(() => {
    if (!ringing) return
    const original = document.title
    document.title = `Time's up · ${names}`
    return () => {
      document.title = original
    }
  }, [ringing, names])

  const silence = (sessionIds: string[]) => {
    setSilenced((s) => new Set([...s, ...sessionIds]))
    for (const id of sessionIds) {
      actions.acknowledge.mutate(id, {
        onError: () =>
          setSilenced((s) => {
            const next = new Set(s)
            next.delete(id)
            return next
          })
      })
    }
  }

  return (
    <Modal
      open={ringing}
      onOpenChange={() => undefined}
      dismissible={false}
      size="md"
      title={
        <span className="flex items-center gap-2.5">
          <BellRing className="size-6 text-claret-600" /> Time's up
        </span>
      }
      description="Billing has stopped at the booked amount. The session stays open until you end it or let it continue."
      footer={
        due.length > 1 ? (
          <Button variant="secondary" icon={<VolumeX className="size-4" />} onClick={() => silence(due.map((t) => t.session.id))}>
            Silence all alarms
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-3" data-testid="time-up-alert" data-alarm={ringing ? 'ringing' : 'silent'}>
        {!soundOn && (
          <p className="rounded-xl bg-brass-50 px-3.5 py-2.5 text-xs text-brass-800">
            The alarm sound starts once someone clicks anywhere on this page (the browser's rule for sound).
          </p>
        )}
        {due.map((t) => (
          <section key={t.session.id} className="rounded-2xl bg-sunken/70 px-5 py-4" data-testid={`time-up-${t.name}`}>
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-display-tight text-[22px] text-forest-950">{t.name}</h3>
              <span className="text-xs text-fg-4">{t.floor_name}</span>
            </div>
            <p className="mt-1 text-sm text-fg-3">
              Booked {formatDuration(t.session.booked_seconds ?? 0)} · {formatMoney(t.session.booked_amount)} — used up.
              {t.session.customer ? ` ${t.session.customer.name}.` : ''}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="secondary" icon={<VolumeX className="size-4" />} onClick={() => silence([t.session.id])} data-testid="silence-alarm">
                Silence alarm
              </Button>
              {t.session.pricing_mode === 'hourly_special30' ? (
                [30, 60].map((m) => (
                  <Button
                    key={m}
                    variant="secondary"
                    icon={<Plus className="size-4" />}
                    disabled={actions.extend.isPending}
                    onClick={() => {
                      setSilenced((s) => new Set([...s, t.session.id]))
                      actions.extend.mutate({ id: t.session.id, minutes: m, fromBookedSeconds: t.session.booked_seconds! })
                    }}
                    data-testid={`alert-extend-${m}`}
                  >
                    {m === 30 ? '30 min' : '1 hour'}
                  </Button>
                ))
              ) : (
                <Button
                  variant="secondary"
                  icon={<Play className="size-4" />}
                  disabled={actions.keepPlaying.isPending}
                  onClick={() => {
                    setSilenced((s) => new Set([...s, t.session.id]))
                    actions.keepPlaying.mutate(t.session.id)
                  }}
                >
                  Continue playing
                </Button>
              )}
              <Button
                variant="primary"
                icon={<Square className="size-3.5" />}
                disabled={actions.end.isPending}
                onClick={() => {
                  setSilenced((s) => new Set([...s, t.session.id]))
                  actions.end.mutate(t.session.id, { onSuccess: () => navigate('/tables') })
                }}
              >
                End session
              </Button>
            </div>
          </section>
        ))}
      </div>
    </Modal>
  )
}
