import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, Rectangle, XAxis, YAxis, type BarShapeProps } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { totalTokens, type UsageResult, type UsageRow } from '@/lib/api'
import { tokens, usd } from '@/lib/format'
import { OTHER } from '@/lib/palette'
import { planSeries, type Grouping, type Plan } from '@/lib/series'
import { useThemeContext } from '@/theme/provider'

export type Metric = 'cost' | 'tokens' | 'output' | 'sessions'

export const metricValue = (r: UsageRow, m: Metric) =>
  m === 'cost' ? r.cost : m === 'tokens' ? totalTokens(r.usage) : m === 'output' ? r.usage.output : r.sessions

export const formatMetric = (v: number, m: Metric) => (m === 'cost' ? usd(v) : m === 'sessions' ? `${v}` : tokens(v))

// 2px surface gap above each stacked segment (dataviz marks spec). Cut from the segment's
// height rather than stroked in the card color, so thin bars on long ranges keep their width.
const GAP = 2
function Segment({ x, y, width, height, fill, radius }: BarShapeProps) {
  if (height <= GAP) return null
  return <Rectangle x={x} y={y + GAP} width={width} height={height - GAP} fill={fill} radius={radius} />
}

const MORE: Record<Metric, string> = { cost: 'higher cost', tokens: 'more tokens', output: 'more output tokens', sessions: 'more sessions' }

type Props = { data: UsageResult; metric: Metric; hourly: boolean; grouping: Grouping; label: (group: string) => string }

export function UsageChart({ data, metric, hourly, grouping, label }: Props) {
  const { shown, chartMode } = useThemeContext()
  const { rows, series, config, plan } = useMemo(() => {
    const totals = new Map<string, number>()
    for (const r of data.rows) totals.set(r.group, (totals.get(r.group) ?? 0) + metricValue(r, metric))
    const plan = planSeries(totals, { grouping, mode: chartMode, chart: shown.chart, theme: shown.mode })
    const series = plan.series.map((s) => s.key)
    const keyOf = plan.keyOf

    const byBucket = new Map<string, Record<string, number | string>>(data.buckets.map((b) => [b, { bucket: b }]))
    for (const r of data.rows) {
      const row = byBucket.get(r.bucket)
      if (!row) continue
      const k = keyOf(r.group)
      row[k] = ((row[k] as number) ?? 0) + metricValue(r, metric)
    }
    const config: ChartConfig = {}
    plan.series.forEach((s, i) => (config[`s${i}`] = { label: s.key === OTHER ? OTHER : label(s.key), color: s.color }))
    // Recharts dataKeys can't contain dots/spaces safely, so map to s0..sN.
    const rows = [...byBucket.values()].map((row) => {
      const out: Record<string, number | string> = { bucket: row.bucket }
      series.forEach((s, i) => (out[`s${i}`] = (row[s] as number) ?? 0))
      return out
    })
    return { rows, series, config, plan }
  }, [data, metric, label, grouping, chartMode, shown])

  const tick = (b: string) => {
    if (hourly) return b.slice(11, 16)
    const d = new Date(`${b}T00:00:00`)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  if (!series.length) {
    return <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">No usage in this range.</div>
  }

  return (
    <div>
      <ChartContainer config={config} className="aspect-auto h-[300px] w-full">
        <BarChart data={rows} margin={{ left: 4, right: 4, top: 8 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} strokeOpacity={0.5} />
          <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickFormatter={tick} minTickGap={16} />
          <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => formatMetric(v, metric)} />
          <ChartTooltip
            cursor={{ fillOpacity: 0.4 }}
            content={
              <ChartTooltipContent
                labelFormatter={(_, p) => {
                  const b = p?.[0]?.payload?.bucket as string | undefined
                  return b ? (hourly ? `${b.slice(0, 10)} ${b.slice(11)}` : tick(b)) : ''
                }}
                formatter={(value, name, item) => (
                  <div className="flex w-full items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item.color }} />
                    <span className="text-muted-foreground">{config[name as string]?.label}</span>
                    <span className="ml-auto font-mono tabular-nums text-foreground">{formatMetric(Number(value), metric)}</span>
                  </div>
                )}
              />
            }
          />
          {series.map((_, i) => (
            <Bar
              key={i}
              dataKey={`s${i}`}
              stackId="a"
              fill={`var(--color-s${i})`}
              shape={Segment}
              radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ChartContainer>
      {series.length > 1 && <Legend plan={plan} config={config} note={note(plan, grouping, metric, shown.mode)} />}
    </div>
  )
}

// One-line key for what hue and lightness mean, in plain words.
function note(plan: Plan, grouping: Grouping, metric: Metric, mode: 'light' | 'dark') {
  if (!plan.shade) return null
  const stronger = mode === 'light' ? 'darker' : 'brighter'
  const meaning = plan.shade === 'rank' ? MORE[metric] : plan.shade === 'version' ? 'newer version' : 'higher model tier'
  if (!plan.groups) return `${stronger[0].toUpperCase()}${stronger.slice(1)} = ${meaning}`
  return `Color = ${grouping === 'model' ? 'model family' : 'project'} · ${stronger} = ${meaning}`
}

// Legend in rank order, text in text tokens; hierarchical charts group items under their
// family or project so hue → group and shade → member read at a glance.
function Legend({ plan, config, note }: { plan: Plan; config: ChartConfig; note: string | null }) {
  const color = new Map(plan.series.map((s, i) => [s.key, { color: s.color, label: config[`s${i}`]?.label as string }]))
  const item = (key: string, prefix?: string) => {
    const c = color.get(key)
    if (!c) return null
    const text = prefix && c.label.startsWith(prefix) ? c.label.slice(prefix.length).replace(/^\s*·?\s*/, '') || c.label : c.label
    return (
      <span key={key} className="inline-flex items-center gap-1.5 text-foreground" title={c.label}>
        <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: c.color }} />
        {text}
      </span>
    )
  }
  const other = color.has(OTHER) && item(OTHER)
  return (
    <div className="flex flex-col items-center gap-1.5 pt-3 text-xs">
      <div className={`flex flex-wrap items-center justify-center gap-y-1.5 ${plan.groups ? 'gap-x-8' : 'gap-x-5'}`}>
        {plan.groups
          ? plan.groups.map((g) => (
              <span key={g.label} className="inline-flex items-center gap-2">
                <span className="font-medium text-muted-foreground">{g.label}</span>
                {g.keys.map((k) => item(k, g.label))}
              </span>
            ))
          : plan.series.filter((s) => s.key !== OTHER).map((s) => item(s.key))}
        {other}
      </div>
      {note && <p className="text-muted-foreground">{note}</p>}
    </div>
  )
}
