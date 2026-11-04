import { useState, type ReactNode } from 'react'
import {
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  Global,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
  type TooltipContentProps
} from 'recharts'
import { cn } from '@/lib/cn'

// Recharts connects each chart to the Redux DevTools extension by default; the
// live app never exposes its state to developer tools.
Global.devToolsEnabled = import.meta.env.DEV

/**
 * Chart series colours from the house palette — forest for cash, brass for
 * bank transfers — validated (dataviz validator, light mode, surface #fffdf8):
 * lightness band, chroma floor, CVD and normal-vision separation and contrast
 * all pass. `total` is the deep brand forest for single-series charts. Text
 * never uses these — only marks do.
 */
export const SERIES_COLORS = { cash: '#1c6c42', bank: '#ae843a', total: '#1f4430' } as const

const INK_MUTED = 'var(--color-fg-4)'
/** Recessive grid: faint dotted hairlines that sit into the panel. */
const GRID = 'rgb(10 31 20 / 0.08)'
const BASELINE = 'rgb(10 31 20 / 0.14)'
/** Matte hover band behind the bar under the pointer. */
const CURSOR = { fill: 'rgb(10 31 20 / 0.04)', radius: 8 }
const ENTRY_MS = 800

export interface Series {
  key: string
  label: string
  color: string
}

export interface BarDatum {
  key: string
  /** Axis label (keep short). */
  label: string
  /** Tooltip heading. */
  title: string
  values: Record<string, number>
  note?: string
}

interface Row extends Record<string, unknown> {
  __datum: BarDatum
}

/** Path for a bar segment with optional 4px rounded data-end corners. */
function segmentPath(x: number, y: number, w: number, h: number, roundEnd: boolean, horizontal: boolean): string {
  const r = roundEnd ? Math.min(4, horizontal ? h / 2 : w / 2, horizontal ? w : h) : 0
  if (horizontal) {
    // Anchored at the left; the rounded end is on the right.
    return `M${x},${y}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + h - r}${r ? `Q${x + w},${y + h} ${x + w - r},${y + h}` : ''}H${x}Z`
  }
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + h}Z`
}

/**
 * Stacked segments: the outermost non-zero segment gets the rounded end, and
 * each segment after the first leaves a 2px surface gap where it meets the
 * previous one.
 */
function segmentShape(series: Series[], index: number, horizontal: boolean) {
  return function Segment(props: BarShapeProps) {
    const { x = 0, y = 0, width = 0, height = 0, fill } = props as BarShapeProps & { x: number; y: number; width: number; height: number; fill: string }
    const values = (props.payload as Row).__datum.values
    if (!(values[series[index]!.key]! > 0)) return null
    const before = series.slice(0, index).some((s) => (values[s.key] ?? 0) > 0)
    const outermost = !series.slice(index + 1).some((s) => (values[s.key] ?? 0) > 0)
    const gap = before ? 2 : 0
    const d = horizontal
      ? segmentPath(x + gap, y, Math.max(0, width - gap), height, outermost, true)
      : segmentPath(x, y, width, Math.max(0, height - gap), outermost, false)
    return <path d={d} fill={fill} />
  }
}

function ChartTooltip({ active, payload, series, formatValue }: TooltipContentProps & { series: Series[]; formatValue: (v: number) => string }) {
  const datum = (payload?.[0]?.payload as Row | undefined)?.__datum
  if (!active || !datum) return null
  const total = series.reduce((s, ser) => s + (datum.values[ser.key] ?? 0), 0)
  return (
    <div className="popover pointer-events-none min-w-52 px-4 py-3 text-xs">
      <p className="mb-2 text-[11px] font-semibold tracking-[0.1em] text-fg-4 uppercase">{datum.title}</p>
      {series.map((s) => (
        <p key={s.key} className="flex items-center justify-between gap-5 py-0.5 text-fg-2">
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
          <span className="font-semibold text-fg tabular">{formatValue(datum.values[s.key] ?? 0)}</span>
        </p>
      ))}
      {series.length > 1 && (
        <p className="mt-1.5 flex justify-between border-t border-line pt-2 font-bold text-fg">
          <span>Total</span>
          <span className="tabular">{formatValue(total)}</span>
        </p>
      )}
      {datum.note && <p className="mt-1.5 text-[11px] text-fg-4">{datum.note}</p>}
    </div>
  )
}

function toRows(data: BarDatum[], series: Series[]): Row[] {
  return data.map((d) => ({ label: d.label, __datum: d, ...Object.fromEntries(series.map((s) => [s.key, d.values[s.key] ?? 0])) }))
}

/**
 * Vertical (optionally stacked) bar chart on Recharts: thin bars on a
 * recessive grid, bars that grow from the baseline on entry and glide to new
 * values on update, a matte hover band and a readable tooltip.
 */
export function BarChart({
  data,
  series,
  height = 220,
  formatValue,
  formatAxis,
  className,
  emptyLabel = 'No data for this period'
}: {
  data: BarDatum[]
  series: Series[]
  /** Pixels, or "auto" to fill a sized (e.g. flex) parent. */
  height?: number | 'auto'
  formatValue: (v: number) => string
  formatAxis?: (v: number) => string
  className?: string
  emptyLabel?: ReactNode
}) {
  const rows = toRows(data, series)
  const empty = data.every((d) => series.every((s) => !(d.values[s.key] ?? 0)))
  const [width, setWidth] = useState(600)
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor((width - 60) / 48))))
  return (
    <div className={cn('relative w-full select-none', className)} style={height === 'auto' ? undefined : { height }} role="img" aria-label="Bar chart">
      <ResponsiveContainer width="100%" height="100%" onResize={(w) => setWidth(w)}>
        <RBarChart data={rows} margin={{ top: 12, right: 8, bottom: 0, left: 0 }} barCategoryGap="32%">
          <CartesianGrid vertical={false} stroke={GRID} strokeDasharray="1 5" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: BASELINE }}
            tick={{ fill: INK_MUTED, fontSize: 10.5, fontWeight: 600 }}
            interval={labelEvery - 1}
            tickMargin={10}
          />
          <YAxis
            width={46}
            tickLine={false}
            axisLine={false}
            tickCount={4}
            tick={{ fill: INK_MUTED, fontSize: 10.5, fontWeight: 600 }}
            tickFormatter={(v: number) => (formatAxis ?? formatValue)(v)}
            allowDecimals={false}
            domain={[0, (max: number) => (max > 0 ? max : 1)]}
          />
          {!empty && (
            <Tooltip
              cursor={CURSOR}
              content={(p) => <ChartTooltip {...p} series={series} formatValue={formatValue} />}
              isAnimationActive={false}
              wrapperStyle={{ outline: 'none', zIndex: 10 }}
            />
          )}
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="stack"
              fill={s.color}
              maxBarSize={30}
              shape={segmentShape(series, i, false)}
              activeBar={false}
              isAnimationActive
              animationBegin={i * 90}
              animationDuration={ENTRY_MS}
              animationEasing="ease-out"
            />
          ))}
        </RBarChart>
      </ResponsiveContainer>
      {empty && <div className="pointer-events-none absolute inset-0 flex items-center justify-center pl-12 text-sm text-fg-4">{emptyLabel}</div>}
    </div>
  )
}

/**
 * Horizontal stacked bars, one row per entity (e.g. staff), labelled on the
 * left — compares totals and their make-up at a glance.
 */
export function HorizontalBarChart({
  data,
  series,
  formatValue,
  formatAxis,
  className,
  rowHeight = 34
}: {
  data: BarDatum[]
  series: Series[]
  formatValue: (v: number) => string
  formatAxis?: (v: number) => string
  className?: string
  rowHeight?: number
}) {
  const rows = toRows(data, series)
  const height = data.length * rowHeight + 28
  return (
    <div className={cn('relative w-full select-none', className)} style={{ height }} role="img" aria-label="Bar chart">
      <ResponsiveContainer width="100%" height="100%">
        <RBarChart data={rows} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barCategoryGap="30%">
          <CartesianGrid horizontal={false} stroke={GRID} strokeDasharray="1 5" />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            tick={{ fill: INK_MUTED, fontSize: 10.5, fontWeight: 600 }}
            tickCount={5}
            tickFormatter={(v: number) => (formatAxis ?? formatValue)(v)}
            allowDecimals={false}
            domain={[0, (max: number) => (max > 0 ? max : 1)]}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={96}
            tickLine={false}
            axisLine={{ stroke: BASELINE }}
            tick={{ fill: 'var(--color-fg-2)', fontSize: 12, fontWeight: 600 }}
          />
          <Tooltip
            cursor={CURSOR}
            content={(p) => <ChartTooltip {...p} series={series} formatValue={formatValue} />}
            isAnimationActive={false}
            wrapperStyle={{ outline: 'none', zIndex: 10 }}
          />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="stack"
              fill={s.color}
              maxBarSize={14}
              shape={segmentShape(series, i, true)}
              activeBar={false}
              isAnimationActive
              animationBegin={i * 90}
              animationDuration={ENTRY_MS}
              animationEasing="ease-out"
            />
          ))}
        </RBarChart>
      </ResponsiveContainer>
    </div>
  )
}

export function Legend({ series, values }: { series: Series[]; values?: Record<string, string> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-2 text-xs font-medium text-fg-3">
          <span className="size-2 rounded-full" style={{ background: s.color }} />
          {s.label}
          {values?.[s.key] && <span className="font-bold text-fg tabular">{values[s.key]}</span>}
        </span>
      ))}
    </div>
  )
}

/** Compact axis money: 12500 → "12.5k". */
export function compactMoney(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`
  return String(Math.round(v))
}
