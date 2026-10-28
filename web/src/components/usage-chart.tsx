import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { totalTokens, type UsageResult, type UsageRow } from '@/lib/api'
import { tokens, usd } from '@/lib/format'
import { MAX_SERIES, OTHER, retainSeries, seriesColor } from '@/lib/palette'

export type Metric = 'cost' | 'tokens' | 'output' | 'sessions'

export const metricValue = (r: UsageRow, m: Metric) =>
  m === 'cost' ? r.cost : m === 'tokens' ? totalTokens(r.usage) : m === 'output' ? r.usage.output : r.sessions

export const formatMetric = (v: number, m: Metric) => (m === 'cost' ? usd(v) : m === 'sessions' ? `${v}` : tokens(v))

type Props = { data: UsageResult; metric: Metric; hourly: boolean; label: (group: string) => string }

export function UsageChart({ data, metric, hourly, label }: Props) {
  const { rows, series, config } = useMemo(() => {
    const totals = new Map<string, number>()
    for (const r of data.rows) totals.set(r.group, (totals.get(r.group) ?? 0) + metricValue(r, metric))
    const ranked = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([g]) => g)
    const top = ranked.length > MAX_SERIES + 1 ? ranked.slice(0, MAX_SERIES) : ranked
    const keyOf = (g: string) => (top.includes(g) ? g : OTHER)
    const series = ranked.length > top.length ? [...top, OTHER] : top
    retainSeries(top)

    const byBucket = new Map<string, Record<string, number | string>>(data.buckets.map((b) => [b, { bucket: b }]))
    for (const r of data.rows) {
      const row = byBucket.get(r.bucket)
      if (!row) continue
      const k = keyOf(r.group)
      row[k] = ((row[k] as number) ?? 0) + metricValue(r, metric)
    }
    const config: ChartConfig = {}
    series.forEach((s, i) => (config[`s${i}`] = { label: s === OTHER ? OTHER : label(s), color: seriesColor(s) }))
    // Recharts dataKeys can't contain dots/spaces safely, so map to s0..sN.
    const rows = [...byBucket.values()].map((row) => {
      const out: Record<string, number | string> = { bucket: row.bucket }
      series.forEach((s, i) => (out[`s${i}`] = (row[s] as number) ?? 0))
      return out
    })
    return { rows, series, config }
  }, [data, metric, label])

  const tick = (b: string) => {
    if (hourly) return b.slice(11, 16)
    const d = new Date(`${b}T00:00:00`)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  if (!series.length) {
    return <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">No usage in this range.</div>
  }

  return (
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
        <ChartLegend content={<ChartLegendContent />} />
        {series.map((_, i) => (
          <Bar
            key={i}
            dataKey={`s${i}`}
            stackId="a"
            fill={`var(--color-s${i})`}
            stroke="var(--background)"
            strokeWidth={1}
            radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
          />
        ))}
      </BarChart>
    </ChartContainer>
  )
}
