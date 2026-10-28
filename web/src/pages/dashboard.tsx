import { useCallback, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { CalendarIcon } from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SessionTable } from '@/components/session-table'
import { ClassifyButton } from '@/components/suggestion'
import { formatMetric, UsageChart, type Metric } from '@/components/usage-chart'
import { useFetch } from '@/hooks/use-fetch'
import { api, promptTokens, totalTokens, type ClassifierStatus, type Summary, type UsageResult } from '@/lib/api'
import { duration, modelLabel, sessionHref, tokens, usd } from '@/lib/format'
import { PRESETS, presetRange, type Preset } from '@/lib/range'

type Group = 'project' | 'model' | 'project_model' | 'source'
const GROUPS: { value: Group; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'model', label: 'Model' },
  { value: 'project_model', label: 'Project × Model' },
]
const METRICS: { value: Metric; label: string }[] = [
  { value: 'cost', label: 'API cost' },
  { value: 'tokens', label: 'All tokens' },
  { value: 'output', label: 'Output tokens' },
  { value: 'sessions', label: 'Sessions' },
]

function useDashboardParams() {
  const [params, setParams] = useSearchParams()
  const preset = (params.get('range') ?? '7D') as Preset
  const group = (params.get('group') ?? 'project') as Group
  const metric = (params.get('metric') ?? 'cost') as Metric
  const range = useMemo(() => {
    if (preset === 'custom' && params.get('from') && params.get('to')) {
      const from = new Date(`${params.get('from')}T00:00:00`)
      const to = new Date(`${params.get('to')}T23:59:59`)
      return { from, to }
    }
    return presetRange(preset === 'custom' ? '7D' : preset)
    // Recompute "now" only when the preset or custom bounds change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, params.get('from'), params.get('to')])
  const set = (patch: Record<string, string | null>) =>
    setParams((p) => {
      for (const [k, v] of Object.entries(patch)) v === null ? p.delete(k) : p.set(k, v)
      return p
    })
  return { preset, group, metric, range, set }
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function DashboardPage() {
  const { preset, group, metric, range, set } = useDashboardParams()
  const meta = useFetch(() => api.meta(), [])
  const usage = useFetch(() => api.usage(range, group), [range, group])
  const matrix = useFetch(() => api.usage(range, 'project_model'), [range])
  const sessions = useFetch(() => api.sessions(range), [range])
  const [vocab, setVocab] = useState<string[]>()
  const vocabulary = vocab ?? meta.data?.tags ?? []
  const labels = meta.data?.modelLabels ?? {}

  const groupLabel = useCallback(
    (g: string) => {
      if (group === 'model') return modelLabel(g, labels)
      if (group === 'project_model') {
        const [p, m] = g.split(' · ')
        return `${p} · ${modelLabel(m ?? '', labels)}`
      }
      return g
    },
    [group, labels],
  )

  const updateSession = (id: string, patch: Partial<Summary>) =>
    sessions.setData((list) => list?.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold tracking-tight">Usage</h1>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={preset}
          onValueChange={(v) => v && v !== 'custom' && set({ range: v, from: null, to: null })}
        >
          {PRESETS.map((p) => (
            <ToggleGroupItem key={p} value={p} className="px-3">
              {p}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <CustomRange
          active={preset === 'custom'}
          range={range}
          onChange={(r) => r.from && r.to && set({ range: 'custom', from: ymd(r.from), to: ymd(r.to) })}
        />
        <ToggleGroup type="single" variant="outline" size="sm" value={group} onValueChange={(v) => v && set({ group: v })}>
          {[...GROUPS, ...((meta.data?.sources.length ?? 0) > 1 ? [{ value: 'source' as Group, label: 'Person' }] : [])].map((g) => (
            <ToggleGroupItem key={g.value} value={g.value} className="px-3">
              {g.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <KpiRow usage={usage.data} sessions={sessions.data} />

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{METRICS.find((m) => m.value === metric)?.label} over time</CardTitle>
            <CardDescription>
              By {group === 'source' ? 'person' : GROUPS.find((g) => g.value === group)?.label.toLowerCase()} · list price at time of use, subagents included
            </CardDescription>
          </div>
          <ToggleGroup type="single" variant="outline" size="sm" value={metric} onValueChange={(v) => v && set({ metric: v })}>
            {METRICS.map((m) => (
              <ToggleGroupItem key={m.value} value={m.value} className="px-2.5 text-xs">
                {m.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardHeader>
        <CardContent>
          {usage.data ? (
            <UsageChart data={usage.data} metric={metric} hourly={usage.data.buckets[0]?.length > 10} label={groupLabel} />
          ) : (
            <Skeleton className="h-[300px] w-full" />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Project × model</CardTitle>
            <CardDescription>API-equivalent cost; darker cells cost more. Shows how the model mix differs per project.</CardDescription>
          </CardHeader>
          <CardContent>{matrix.data ? <Matrix data={matrix.data} labels={labels} /> : <Skeleton className="h-40" />}</CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Friction signals</CardTitle>
            <CardDescription>Where time and tokens were likely wasted in this range</CardDescription>
          </CardHeader>
          <CardContent>{sessions.data ? <Friction sessions={sessions.data} /> : <Skeleton className="h-40" />}</CardContent>
        </Card>
      </div>

      <TagBreakdown
        sessions={sessions.data ?? []}
        classifier={meta.data?.classifier}
        onClassify={() => api.classify({ from: range.from.toISOString(), to: range.to.toISOString() })}
        onDone={sessions.reload}
      />

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>Sessions active in the selected range. Click a row to open its transcript.</CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.data ? (
            <SessionTable
              sessions={sessions.data}
              vocabulary={vocabulary}
              labels={labels}
              onUpdate={updateSession}
              onVocabulary={setVocab}
            />
          ) : (
            <Skeleton className="h-64" />
          )}
        </CardContent>
      </Card>
      {(usage.error || sessions.error) && <p className="text-sm text-destructive">{(usage.error ?? sessions.error)?.message}</p>}
    </div>
  )
}

function CustomRange({ active, range, onChange }: { active: boolean; range: { from: Date; to: Date }; onChange: (r: DateRange) => void }) {
  const [draft, setDraft] = useState<DateRange | undefined>()
  return (
    <Popover onOpenChange={(o) => o && setDraft({ from: range.from, to: range.to })}>
      <PopoverTrigger asChild>
        <Button variant={active ? 'secondary' : 'outline'} size="sm">
          <CalendarIcon />
          {active ? `${range.from.toLocaleDateString()} – ${range.to.toLocaleDateString()}` : 'Custom'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end">
        <Calendar
          mode="range"
          numberOfMonths={2}
          selected={draft}
          defaultMonth={range.from}
          disabled={{ after: new Date() }}
          onSelect={(r) => {
            setDraft(r)
            if (r?.from && r?.to && r.from.getTime() !== r.to.getTime()) onChange(r)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="px-4">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="mt-1 font-mono text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  )
}

function KpiRow({ usage, sessions }: { usage?: UsageResult; sessions?: Summary[] }) {
  if (!usage || !sessions) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[92px]" />
        ))}
      </div>
    )
  }
  const cost = usage.rows.reduce((a, r) => a + r.cost, 0)
  const all = usage.rows.reduce((a, r) => a + totalTokens(r.usage), 0)
  const output = usage.rows.reduce((a, r) => a + r.usage.output, 0)
  const prompt = usage.rows.reduce((a, r) => a + promptTokens(r.usage), 0)
  const cacheRead = usage.rows.reduce((a, r) => a + r.usage.cacheRead, 0)
  const active = sessions.reduce((a, s) => a + s.activeSeconds, 0)
  const agents = sessions.reduce((a, s) => a + s.subagents, 0)
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Kpi label="API-equivalent cost" value={usd(cost)} sub={sessions.length ? `${usd(cost / sessions.length)} / session` : undefined} />
      <Kpi label="Sessions" value={`${sessions.length}`} sub={`${agents} subagents launched`} />
      <Kpi label="Active time" value={duration(active)} sub="gaps capped at 5 min" />
      <Kpi label="Tokens processed" value={tokens(all)} sub={`${tokens(output)} output`} />
      <Kpi label="Cache hit rate" value={prompt ? `${Math.round((cacheRead / prompt) * 100)}%` : '–'} sub="cache reads / prompt tokens" />
      <Kpi label="Cost per active hour" value={active ? usd(cost / (active / 3600)) : '–'} />
    </div>
  )
}

function Matrix({ data, labels }: { data: UsageResult; labels: Record<string, string> }) {
  const { projects, models, cells, max } = useMemo(() => {
    const cells = new Map<string, number>()
    const pTot = new Map<string, number>()
    const mTot = new Map<string, number>()
    for (const r of data.rows) {
      const [p, m] = r.group.split(' · ')
      cells.set(r.group, (cells.get(r.group) ?? 0) + r.cost)
      pTot.set(p, (pTot.get(p) ?? 0) + r.cost)
      mTot.set(m, (mTot.get(m) ?? 0) + r.cost)
    }
    const sort = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
    return { projects: sort(pTot).slice(0, 12), models: sort(mTot), cells, max: Math.max(0, ...cells.values()) }
  }, [data])
  if (!projects.length) return <p className="text-sm text-muted-foreground">No usage in this range.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0.5 text-sm">
        <thead>
          <tr>
            <th />
            {models.map((m) => (
              <th key={m} className="px-2 pb-1 text-left text-xs font-medium whitespace-nowrap text-muted-foreground">
                {modelLabel(m, labels)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p}>
              <td className="max-w-48 truncate pr-3 text-xs font-medium">{p}</td>
              {models.map((m) => {
                const v = cells.get(`${p} · ${m}`) ?? 0
                const t = max ? v / max : 0
                return (
                  <td
                    key={m}
                    title={`${p} · ${modelLabel(m, labels)}: ${usd(v)}`}
                    className="h-9 min-w-20 rounded-sm px-2 text-right font-mono text-xs tabular-nums"
                    style={{
                      background: v ? `color-mix(in oklab, var(--series-1) ${Math.round(12 + t * 88)}%, var(--card))` : 'var(--muted)',
                      color: t > 0.5 ? 'white' : undefined,
                    }}
                  >
                    {v ? usd(v) : ''}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Friction({ sessions }: { sessions: Summary[] }) {
  const sum = (f: (s: Summary) => number) => sessions.reduce((a, s) => a + f(s), 0)
  const items = [
    { label: 'Failed tool calls', value: sum((s) => s.toolErrors), of: sum((s) => s.toolCalls) },
    { label: 'Rejected tool calls', value: sum((s) => s.rejections) },
    { label: 'User interruptions', value: sum((s) => s.interrupts) },
    { label: 'Context compactions', value: sum((s) => s.compactions) },
  ]
  const worst = [...sessions]
    .map((s) => ({ s, score: s.toolErrors + s.rejections * 2 + s.interrupts * 3 + s.compactions * 2 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3">
        {items.map((i) => (
          <div key={i.label} className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">{i.label}</dt>
            <dd className="font-mono text-xl font-semibold tabular-nums">
              {i.value}
              {i.of ? <span className="ml-1 text-xs font-normal text-muted-foreground">/ {i.of}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">Highest-friction sessions</div>
        {worst.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {worst.map(({ s }) => (
              <li key={s.id} className="flex items-center gap-2">
                <Link to={sessionHref(s.id, s.title)} className="truncate hover:underline">
                  {s.title}
                </Link>
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                  {s.toolErrors}e · {s.rejections}r · {s.interrupts}i
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No friction recorded. 🎉</p>
        )}
      </div>
    </div>
  )
}

type TagBreakdownProps = {
  sessions: Summary[]
  classifier?: ClassifierStatus
  onClassify: () => Promise<{ status: ClassifierStatus }>
  onDone: () => void
}

function TagBreakdown({ sessions, classifier, onClassify, onDone }: TagBreakdownProps) {
  const unclassified = sessions.filter(
    (s) => !s.tags.length && s.userPrompts > 0 && (!s.suggestion || s.suggestion.status === 'error'),
  ).length
  const pending = sessions.filter((s) => s.suggestion?.status === 'pending').length
  const rows = useMemo(() => {
    const m = new Map<string, { n: number; cost: number; active: number }>()
    for (const s of sessions) {
      for (const t of s.tags.length ? s.tags : ['(unclassified)']) {
        const r = m.get(t) ?? { n: 0, cost: 0, active: 0 }
        r.n++
        r.cost += s.cost
        r.active += s.activeSeconds
        m.set(t, r)
      }
    }
    return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost)
  }, [sessions])
  const max = Math.max(0, ...rows.map(([, r]) => r.cost))
  if (!rows.length) return null
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>By purpose</CardTitle>
          <CardDescription>
            Session cost by classification tag (a session with several tags counts toward each)
            {pending > 0 && ` · ${pending} suggestion${pending > 1 ? 's' : ''} awaiting review in the table below`}
          </CardDescription>
        </div>
        <ClassifyButton
          label={`Suggest tags for ${unclassified} unclassified`}
          disabled={unclassified === 0}
          status={classifier}
          request={onClassify}
          onDone={onDone}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows.map(([tag, r]) => (
          <div key={tag} className="grid grid-cols-[10rem_1fr_auto] items-center gap-3 text-sm">
            <span className={tag === '(unclassified)' ? 'text-muted-foreground italic' : ''}>{tag}</span>
            <div className="h-2 rounded-full bg-muted">
              <div className="h-2 rounded-full bg-[var(--series-1)]" style={{ width: `${max ? (r.cost / max) * 100 : 0}%` }} />
            </div>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {formatMetric(r.cost, 'cost')} · {r.n} sessions · {duration(r.active)}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

