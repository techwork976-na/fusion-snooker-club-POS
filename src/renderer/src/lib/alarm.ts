/**
 * The "time's up" alarm: a short three-note chime, repeated until silenced.
 * It is synthesised with the Web Audio API, so there is no sound file to
 * download or block, and the chimes are scheduled ahead on the audio clock,
 * so they keep ringing even when the browser slows timers in a background tab.
 *
 * Browsers only allow sound after someone clicks or types on the page; the
 * audio is unlocked on the first interaction (see `installAudioUnlock`).
 */
const CHIME_EVERY_S = 1.6
const SCHEDULE_AHEAD_S = 45

let ctx: AudioContext | null = null
let master: GainNode | null = null
let scheduledUntil = 0
let topUp: number | null = null
const listeners = new Set<() => void>()

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
    ctx.addEventListener('statechange', () => listeners.forEach((l) => l()))
  }
  return ctx
}

/** Unlocks audio on the first click or key press (browser autoplay rule). */
export function installAudioUnlock(): () => void {
  const unlock = () => {
    const c = context()
    if (c && c.state !== 'running') void c.resume()
  }
  window.addEventListener('pointerdown', unlock, true)
  window.addEventListener('keydown', unlock, true)
  return () => {
    window.removeEventListener('pointerdown', unlock, true)
    window.removeEventListener('keydown', unlock, true)
  }
}

/** Whether the browser currently allows the alarm to be heard. */
export function audioReady(): boolean {
  return context()?.state === 'running'
}

export function onAudioStateChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function chime(c: AudioContext, out: AudioNode, at: number) {
  for (const [offset, freq] of [
    [0, 880],
    [0.2, 660],
    [0.4, 990]
  ] as const) {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.0001, at + offset)
    gain.gain.exponentialRampToValueAtTime(0.4, at + offset + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + offset + 0.18)
    osc.connect(gain).connect(out)
    osc.start(at + offset)
    osc.stop(at + offset + 0.2)
  }
}

function scheduleAhead() {
  const c = context()
  if (!c || !master) return
  const horizon = c.currentTime + SCHEDULE_AHEAD_S
  scheduledUntil = Math.max(scheduledUntil, c.currentTime + 0.05)
  while (scheduledUntil < horizon) {
    chime(c, master, scheduledUntil)
    scheduledUntil += CHIME_EVERY_S
  }
}

/** Starts ringing (no-op if it already rings). */
export function startAlarm(): void {
  const c = context()
  if (!c || master) return
  void c.resume()
  master = c.createGain()
  master.connect(c.destination)
  scheduledUntil = 0
  scheduleAhead()
  topUp = window.setInterval(scheduleAhead, 15_000)
}

/** Stops at once, including chimes already scheduled. */
export function stopAlarm(): void {
  if (topUp !== null) window.clearInterval(topUp)
  topUp = null
  master?.disconnect()
  master = null
}

export function isAlarmRinging(): boolean {
  return master !== null
}
