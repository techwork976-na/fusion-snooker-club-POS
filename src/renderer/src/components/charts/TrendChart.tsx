import { useState, type ReactNode } from 'react'
import { Area, AreaChart, AreaRevealShape, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type AreaRevealShapeProps } from 'recharts'
import { cn } from '@/lib/cn'
import { ChartTooltip, toRows, type BarDatum, type Series } from './BarChart'

/** Ink for each surface: the cream page panels, or the deep forest felt. */
const TONES = {
  light: {
    grid: 'rgb(10 31 20 / 0.075)',
    ink: 'var(--color-fg-4)',
    cursor: { stroke: 'rgb(10 31 20 / 0.28)', strokeWidth: 1, strokeDasharray: '2 4' },
    ring: 'var(--color-surface)',
    wash: 0.085
  },
  dark: {
    grid: 'rgb(244 240 231 / 0.075)',
    ink: 'var(--color-side-muted)',
    cursor: { stroke: 'rgb(244 240 231 / 0.32)', strokeWidth: 1, strokeDasharray: '2 4' },
    ring: 'var(--color-forest-950)',
    wash: 0.16
  }
} as const
const ENTRY_MS = 900

/**
 * The curve rises out of its baseline on entry (instead of Recharts' default
 * left-to-right wipe); later changes glide point to point.
 */
function RiseShape(props: AreaRevealShapeProps) {
  const { isEntrance, animationElapsedTime = 1, points, baseLine } = props
  if (isEntrance && animationElapsedTime < 1 && typeof baseLine === 'number' && points) {
    const t = Math.max(0, animationElapsedTime)
    const risen = points.map((p) => (p.y === null || p.y === undefined ? p : { ...p, y: baseLine + (p.y - baseLine) * t }))
    return <AreaRevealShape {...props} points={risen} isEntrance={false} isAnimating={false} />
  }
  return <AreaRevealShape {...props} isEntrance={false} />
}

/**
 * Smooth trend over time: monotone curves (they never overshoot the data),
 * 2px lines, a faint flat wash under a single series, clean points while the
 * series is short, a dotted crosshair and the shared tooltip.
 *
 * `series` are drawn; `tooltipSeries` (default: the drawn series) are listed in
 * the tooltip — e.g. draw the day's total, break it down into cash and bank.
 */
export function TrendChart({
  data,
  series,
  tooltipSeries,
  height = 240,
  formatValue,
  formatAxis,
  className,
  emptyLabel = 'No data for this period',
  label = 'Trend chart',
  tone = 'light'
}: {
  data: BarDatum[]
  series: Series[]
  tooltipSeries?: Series[]
  /** Pixels, or "auto" to fill a sized (e.g. flex) parent. */
  height?: number | 'auto'
  formatValue: (v: number) => string
  formatAxis?: (v: number) => string
  className?: string
  emptyLabel?: ReactNode
  label?: string
  /** "dark" when set on the deep forest felt. */
  tone?: 'light' | 'dark'
}) {
  const [width, setWidth] = useState(600)
  const ink = TONES[tone]
  const listed = tooltipSeries ?? series
  const rows = toRows(data, [...series, ...listed.filter((s) => !series.some((d) => d.key === s.key))])
  const empty = data.every((d) => series.every((s) => !(d.values[s.key] ?? 0)))
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor((width - 70) / 54))))
  const single = series.length === 1
  const dots = data.length <= 16
  return (
    <div className={cn('chart relative w-full select-none', className)} style={height === 'auto' ? undefined : { height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%" onResize={(w) => setWidth(w)}>
        <AreaChart data={rows} margin={{ top: 14, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={ink.grid} strokeDasharray="1 5" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fill: ink.ink, fontSize: 10 }}
            interval={labelEvery - 1}
            tickMargin={12}
            padding={{ left: 14, right: 14 }}
          />
          <YAxis
            width={44}
            tickLine={false}
            axisLine={false}
            tickCount={4}
            tick={{ fill: ink.ink, fontSize: 10 }}
            tickFormatter={(v: number) => (formatAxis ?? formatValue)(v)}
            allowDecimals={false}
            domain={[0, (max: number) => (max > 0 ? max : 1)]}
          />
          {!empty && (
            <Tooltip
              cursor={ink.cursor}
              content={(p) => <ChartTooltip {...p} series={listed} formatValue={formatValue} />}
              isAnimationActive={false}
              wrapperStyle={{ outline: 'none', zIndex: 10 }}
            />
          )}
          {series.map((s, i) => (
            <Area
              key={s.key}
              dataKey={s.key}
              name={s.label}
              type="monotone"
              connectNulls={false}
              stroke={s.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill={s.color}
              fillOpacity={single ? ink.wash : 0}
              shape={RiseShape}
              dot={dots && !empty ? { r: 3, fill: s.color, stroke: ink.ring, strokeWidth: 2, className: 'chart-dot' } : false}
              activeDot={{ r: 5, fill: s.color, stroke: ink.ring, strokeWidth: 2.5 }}
              isAnimationActive
              animationBegin={i * 120}
              animationDuration={ENTRY_MS}
              animationEasing="ease-out"
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      {empty && (
        <div className={cn('pointer-events-none absolute inset-0 flex items-center justify-center pl-12 text-sm', tone === 'dark' ? 'text-side-muted' : 'text-fg-4')}>
          {emptyLabel}
        </div>
      )}
    </div>
  )
}
