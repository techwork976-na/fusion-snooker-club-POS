import { useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
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
 * Chart series colours — one meaning each, the same on every screen:
 * baize green for sales and cash, brass for bank transfers, lake blue for
 * snacks and products, claret for expenses (with a lighter claret for counter
 * expenses beside business ones). Validated with the dataviz validator (light
 * mode, surface #fffdf8): lightness band, chroma floor, colour-blind and
 * normal-vision separation all pass. Text never uses these — only marks do.
 */
export const SERIES_COLORS = {
  cash: '#16804c',
  bank: '#b0832c',
  sales: '#16804c',
  products: '#1371a0',
  expenses: '#a8483a',
  counterExpenses: '#cf7f6c',
  total: '#1f4430'
} as const

/** Cash and bank on the deep forest panels — their own validated steps for the dark surface (#0a1f14). */
export const SERIES_ON_DARK = { cash: '#1d8552', bank: '#bb8a33' } as const

const INK_MUTED = 'var(--color-fg-4)'
/** Recessive grid: faint dotted hairlines that sit into the panel. */
const GRID = 'rgb(10 31 20 / 0.075)'
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
  /** A slot still to come (e.g. a later hour of today): on the axis, but no value is drawn or shown. */
  future?: boolean
}

interface Row extends Record<string, unknown> {
  __datum: BarDatum
}

/** Path for a bar segment with optional 4px rounded data-end corners. */
function segmentPath(x: number, y: number, w: number, h: number, roundEnd: boolean): string {
  const r = roundEnd ? Math.min(4, w / 2, h) : 0
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + h}Z`
}

/**
 * Stacked segments: the outermost non-zero segment gets the rounded end, and
 * each segment after the first leaves a 2px surface gap where it meets the
 * previous one.
 */
function segmentShape(series: Series[], index: number) {
  return function Segment(props: BarShapeProps) {
    const { x = 0, y = 0, width = 0, height = 0, fill } = props as BarShapeProps & { x: number; y: number; width: number; height: number; fill: string }
    const values = (props.payload as Row).__datum.values
    if (!(values[series[index]!.key]! > 0)) return null
    const before = series.slice(0, index).some((s) => (values[s.key] ?? 0) > 0)
    const outermost = !series.slice(index + 1).some((s) => (values[s.key] ?? 0) > 0)
    const gap = before ? 2 : 0
    return <path d={segmentPath(x, y, width, Math.max(0, height - gap), outermost)} fill={fill} />
  }
}

export function ChartTooltip({ active, payload, series, formatValue }: TooltipContentProps & { series: Series[]; formatValue: (v: number) => string }) {
  const datum = (payload?.[0]?.payload as Row | undefined)?.__datum
  if (!active || !datum || datum.future) return null
  const total = series.reduce((s, ser) => s + (datum.values[ser.key] ?? 0), 0)
  return (
    <div className="popover pointer-events-none min-w-52 px-4 py-3 text-xs">
      <p className="label mb-2">{datum.title}</p>
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

export function toRows(data: BarDatum[], series: Series[]): Row[] {
  return data.map((d) => ({
    label: d.label,
    __datum: d,
    ...Object.fromEntries(series.map((s) => [s.key, d.future ? null : (d.values[s.key] ?? 0)]))
  }))
}

/**
 * Vertical (optionally stacked) bar chart on Recharts, for amounts that come
 * in lumps rather than flow (e.g. expenses by day): slim bars on a recessive
 * grid that grow from the baseline on entry and glide to new values on update,
 * a matte hover band and a readable tooltip.
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
    <div className={cn('chart relative w-full select-none', className)} style={height === 'auto' ? undefined : { height }} role="img" aria-label="Bar chart">
      <ResponsiveContainer width="100%" height="100%" onResize={(w) => setWidth(w)}>
        <RBarChart data={rows} margin={{ top: 12, right: 8, bottom: 0, left: 0 }} barCategoryGap="38%">
          <CartesianGrid vertical={false} stroke={GRID} strokeDasharray="1 5" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: BASELINE }}
            tick={{ fill: INK_MUTED, fontSize: 10 }}
            interval={labelEvery - 1}
            tickMargin={10}
          />
          <YAxis
            width={44}
            tickLine={false}
            axisLine={false}
            tickCount={4}
            tick={{ fill: INK_MUTED, fontSize: 10 }}
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
              maxBarSize={22}
              shape={segmentShape(series, i)}
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
 * Ranked bars, one row per entity (staff, table, product, category), largest
 * first: the name and its amount on one line, a thin bar beneath scaled to the
 * leader, split into its series with a 2px gap. The bars grow in on entry and
 * glide to new values; hovering a row shows its breakdown.
 */
export function HorizontalBarChart({
  data,
  series,
  formatValue,
  className
}: {
  data: BarDatum[]
  series: Series[]
  formatValue: (v: number) => string
  /** Kept for call-site compatibility; ranked bars print full amounts. */
  formatAxis?: (v: number) => string
  className?: string
}) {
  const [hover, setHover] = useState<string | null>(null)
  const totalOf = (d: BarDatum) => series.reduce((s, ser) => s + Math.max(0, d.values[ser.key] ?? 0), 0)
  const max = Math.max(1, ...data.map(totalOf))
  return (
    <ul className={cn('relative space-y-4', className)} aria-label="Ranked bars">
      {data.map((d, i) => {
        const parts = series.filter((s) => (d.values[s.key] ?? 0) > 0)
        return (
          <li key={d.key} className="relative" onMouseEnter={() => setHover(d.key)} onMouseLeave={() => setHover((h) => (h === d.key ? null : h))}>
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className={cn('min-w-0 truncate font-medium transition-colors', hover === d.key ? 'text-fg' : 'text-fg-2')} title={d.title}>
                {d.label}
              </span>
              <span className="shrink-0 figure text-[13.5px] text-fg">{formatValue(totalOf(d))}</span>
            </div>
            <div className="mt-1.5 flex h-[7px] gap-[2px] overflow-hidden rounded-full bg-forest-950/[0.045]">
              {parts.map((s, j) => (
                <motion.span
                  key={s.key}
                  className={cn('h-full shrink-0', j === 0 && 'rounded-l-full', j === parts.length - 1 && 'rounded-r-full')}
                  style={{ background: s.color }}
                  initial={{ width: 0 }}
                  animate={{ width: `${(Math.max(0, d.values[s.key] ?? 0) / max) * 100}%` }}
                  transition={{ duration: 0.75, delay: 0.04 * i + 0.08 * j, ease: [0.22, 1, 0.36, 1] }}
                />
              ))}
            </div>
            {hover === d.key && (series.length > 1 || d.note) && (
              <div className="popover pointer-events-none absolute right-0 bottom-full z-10 mb-2 min-w-52 px-4 py-3 text-xs">
                <p className="label mb-2">{d.title}</p>
                {series.length > 1 &&
                  series.map((s) => (
                    <p key={s.key} className="flex items-center justify-between gap-5 py-0.5 text-fg-2">
                      <span className="flex items-center gap-2">
                        <span className="size-2 rounded-full" style={{ background: s.color }} />
                        {s.label}
                      </span>
                      <span className="font-semibold text-fg tabular">{formatValue(d.values[s.key] ?? 0)}</span>
                    </p>
                  ))}
                {d.note && <p className={cn('text-[11px] text-fg-4', series.length > 1 && 'mt-1.5')}>{d.note}</p>}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function Legend({ series, values }: { series: Series[]; values?: Record<string, string> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-2 text-xs font-medium text-fg-3">
          <span className="h-[3px] w-3.5 rounded-full" style={{ background: s.color }} />
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
