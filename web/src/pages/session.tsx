import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { AlertTriangle, ArrowLeft, Bot, ChevronDown, ChevronRight, Info, OctagonAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ClassifyButton, SuggestionReview } from '@/components/suggestion'
import { TagEditor } from '@/components/tag-editor'
import { Collapsible, StatusDot, ToolCallDetail } from '@/components/tool-call'
import { FilteredCalls, ToolFilterBar } from '@/components/tool-filter'
import { callStatus, toggled } from '@/lib/tool-call'
import { useToolFilter, type ToolFilter } from '@/lib/tool-filter'
import { MAIN, SYSTEM, TranscriptRow, USER } from '@/components/transcript'
import { useFetch } from '@/hooks/use-fetch'
import { api, promptTokens, totalTokens, type AgentInfo, type Insight, type MemoryAccess, type MemoryReload, type SessionDetail, type SessionEvent } from '@/lib/api'
import { dateTime, duration, modelLabel, time, tokens, usd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useThemeContext } from '@/theme/provider'

// Subagents are nominal (no rank), so they take Distinct slot hues in launch order in both
// chart modes; tonal would imply an order that isn't there. CSS vars, so theme previews apply
// without re-rendering. Never cycled: past the theme's slot count agents get the neutral.
const agentColor = (i: number, slots: number) => (i < slots ? `var(--series-${i + 1})` : 'var(--series-other)')

const NO_EVENTS: SessionEvent[] = []

// Keyed by id so page state (limit, tab, actors, pending jump) resets when navigating between sessions.
export function SessionPage() {
  const { id = '' } = useParams()
  return <SessionView key={id} id={id} />
}

function SessionView({ id }: { id: string }) {
  const detail = useFetch(() => api.session(id), [id])
  const meta = useFetch(() => api.meta(), [])
  const [tab, setTab] = useState('conversation')
  const [actors, setActors] = useState<Set<string>>()
  const [vocab, setVocab] = useState<string[]>()
  const [limit, setLimit] = useState(400)
  const [pending, setPending] = useState<{ uuid: string; toolId?: string; n: number }>()

  const d = detail.data
  const filter = useToolFilter(id, d?.events ?? NO_EVENTS)
  const labels = meta.data?.modelLabels ?? {}

  useEffect(() => {
    if (d) document.title = `${d.summary.title} · Session Browser`
  }, [d])

  useEffect(() => {
    if (!pending) return
    let tries = 0
    const go = () => {
      const el = (pending.toolId && document.getElementById(`tool-${pending.toolId}`)) || document.getElementById(`ev-${pending.uuid}`)
      if (!el || !el.getClientRects().length) {
        if (tries++ < 10) timer = setTimeout(go, 50)
        return
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.animate([{ background: 'color-mix(in oklab, var(--warning) 35%, transparent)' }, { background: 'transparent' }], { duration: 2000 })
    }
    let timer = setTimeout(go, 0)
    return () => clearTimeout(timer)
  }, [pending])

  if (detail.error) return <p className="text-destructive">{detail.error.message}</p>
  if (!d) return <Skeleton className="h-96" />

  const s = d.summary
  const allActors = [USER, MAIN, ...d.agents.map((a) => a.id), SYSTEM]
  const visible = actors ?? new Set(allActors.filter((a) => a !== SYSTEM))
  const openAgent = (agentId: string) => {
    setActors(new Set([agentId]))
    setTab('conversation')
    window.scrollTo({ top: 0 })
  }
  const jumpTo = (uuid: string, toolId?: string) => {
    setActors(new Set(allActors))
    setTab('conversation')
    // A jump to a tool row the filter hides would find nothing; drop the filter first.
    if (filter.active && d.events.some((e) => e.kind === 'tool_use' && e.toolId === toolId && !filter.passes(e))) filter.clear()
    const idx = d.events.findIndex((e) => (toolId ? e.kind === 'tool_use' && e.toolId === toolId : e.uuid === uuid))
    const at = idx < 0 ? d.events.findIndex((e) => e.uuid === uuid) : idx
    if (at >= 0) setLimit((l) => Math.max(l, at + 50))
    setPending((p) => ({ uuid, toolId, n: (p?.n ?? 0) + 1 }))
  }
  const prompt = promptTokens(s.usage)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link to="/" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> All sessions
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{s.title}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>{s.project}</span>
          {s.gitBranch && <span className="font-mono text-xs">⎇ {s.gitBranch}</span>}
          <span>{dateTime(s.start)} → {dateTime(s.end)}</span>
          <span>{duration(s.activeSeconds)} active</span>
          {s.version && <span className="font-mono text-xs">v{s.version}</span>}
          <span className="font-mono text-xs">{s.source}</span>
          <span className="font-mono text-xs">{s.id}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <TagEditor
            sessionId={s.id}
            tags={s.tags}
            vocabulary={vocab ?? meta.data?.tags ?? []}
            onChange={(tags) => detail.setData((x) => x && { ...x, summary: { ...x.summary, tags } })}
            onVocabulary={setVocab}
          />
          {d.suggestion?.status !== 'pending' && (
            <ClassifyButton
              label={d.suggestion ? 'Re-suggest tags' : 'Suggest tags'}
              status={meta.data?.classifier}
              request={() => api.classify({ ids: [s.id] })}
              onDone={detail.reload}
            />
          )}
        </div>
        {d.suggestion?.status === 'error' && (
          <p className="text-xs text-[var(--critical)]">Last suggestion failed: {d.suggestion.error}</p>
        )}
        <SuggestionReview
          sessionId={s.id}
          suggestion={d.suggestion}
          onResolved={(tags, suggestion) => {
            detail.setData((x) => x && { ...x, suggestion, summary: { ...x.summary, tags } })
            setVocab([...new Set([...(vocab ?? meta.data?.tags ?? []), ...tags])])
          }}
        />
      </div>

      {s.archived && (
        <div className="flex items-start gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>
            Claude Code deleted this transcript (see <code className="font-mono text-xs">cleanupPeriodDays</code>). Only the {s.userPrompts}{' '}
            {s.userPrompts === 1 ? 'prompt' : 'prompts'} you typed survive, from your prompt history; responses, tool calls and cost are gone.
          </p>
        </div>
      )}

      {s.archived ? (
        <Conversation d={d} visible={visible} allActors={allActors} setActors={setActors} onOpenAgent={openAgent} limit={limit} setLimit={setLimit} filter={filter} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="API-equivalent cost" value={usd(s.cost)} sub={d.models.map((m) => `${modelLabel(m.model, labels)} ${usd(m.cost)}`).join(' · ')} />
            <Stat label="Tokens" value={tokens(totalTokens(s.usage))} sub={`${tokens(s.usage.output)} output · ${tokens(s.usage.thinking)} thinking`} />
            <Stat label="Cache hit rate" value={prompt ? `${Math.round((s.usage.cacheRead / prompt) * 100)}%` : '–'} sub={`${tokens(s.usage.cacheWrite5m + s.usage.cacheWrite1h)} written`} />
            <Stat label="Prompts" value={`${s.userPrompts}`} sub={`${s.usage.messages} API responses`} />
            <Stat label="Tool calls" value={`${d.tools.reduce((a, t) => a + t.calls, 0)}`} sub={`${s.toolErrors} failed · ${s.rejections} rejected`} />
            <Stat label="Subagents" value={`${d.agents.length}`} sub={d.agents.length ? usd(d.agents.reduce((a, x) => a + x.cost, 0)) : undefined} />
          </div>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex-wrap">
              <TabsTrigger value="conversation">Conversation</TabsTrigger>
              <TabsTrigger value="agents">Agents ({d.agents.length + 1})</TabsTrigger>
              <TabsTrigger value="tools">Tools ({d.tools.length})</TabsTrigger>
              <TabsTrigger value="skills">Skills ({d.skills.length})</TabsTrigger>
              <TabsTrigger value="memories">Memories ({d.memories.length})</TabsTrigger>
              <TabsTrigger value="insights">
                Insights ({d.insights.length})
                {d.insights.some((i) => i.severity !== 'info') && <span className="size-1.5 rounded-full bg-[var(--warning)]" />}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="conversation" forceMount className="mt-4 data-[state=inactive]:hidden">
              <Conversation d={d} visible={visible} allActors={allActors} setActors={setActors} onOpenAgent={openAgent} limit={limit} setLimit={setLimit} filter={filter} />
            </TabsContent>
            <TabsContent value="agents" forceMount className="mt-4 data-[state=inactive]:hidden">
              <Agents d={d} labels={labels} onOpenAgent={openAgent} />
            </TabsContent>
            <TabsContent value="tools" forceMount className="mt-4 data-[state=inactive]:hidden">
              <Tools d={d} onJump={jumpTo} filter={filter} />
            </TabsContent>
            <TabsContent value="skills" forceMount className="mt-4 data-[state=inactive]:hidden">
              <Skills d={d} onJump={jumpTo} />
            </TabsContent>
            <TabsContent value="memories" forceMount className="mt-4 data-[state=inactive]:hidden">
              <Memories d={d} onJump={jumpTo} />
            </TabsContent>
            <TabsContent value="insights" forceMount className="mt-4 data-[state=inactive]:hidden">
              <Insights insights={d.insights} onJump={jumpTo} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent className="px-4">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="mt-0.5 truncate text-xs text-muted-foreground" title={sub}>{sub}</div>}
      </CardContent>
    </Card>
  )
}

type ConversationProps = {
  d: SessionDetail
  visible: Set<string>
  allActors: string[]
  setActors: (s: Set<string>) => void
  onOpenAgent: (id: string) => void
  limit: number
  setLimit: React.Dispatch<React.SetStateAction<number>>
  filter: ToolFilter
}

function Conversation({ d, visible, allActors, setActors, onOpenAgent, limit, setLimit, filter }: ConversationProps) {
  const [showThinking, setShowThinking] = useState(true)
  const [toolInputs, setToolInputs] = useState(false)
  const slots = useThemeContext().shown.chart.categorical.length
  const agents = useMemo(() => new Map(d.agents.map((a, i) => [a.id, { a, color: agentColor(i, slots) }])), [d.agents, slots])
  const index = useMemo(() => new Map(d.events.map((e, i) => [e, i])), [d.events])
  const visibleEvents = useMemo(
    () => d.events.filter((e) => visible.has(e.actor) || (!agents.has(e.actor) && !allActors.includes(e.actor) && visible.has(SYSTEM))),
    [d.events, visible, agents, allActors],
  )
  const events = useMemo(() => (filter.active ? visibleEvents.filter((e) => filter.passes(e)) : visibleEvents), [visibleEvents, filter])
  // The filter note counts only tool calls of the actors currently shown.
  const toolCounts = useMemo(() => {
    const count = (list: SessionEvent[]) => list.reduce((n, e) => n + (e.kind === 'tool_use' ? 1 : 0), 0)
    return { shown: count(events), total: count(visibleEvents) }
  }, [events, visibleEvents])

  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const e of d.events) c.set(e.actor, (c.get(e.actor) ?? 0) + 1)
    return c
  }, [d.events])

  const toggle = (a: string) => {
    const next = new Set(visible)
    if (!next.delete(a)) next.add(a)
    setActors(next)
  }
  const allVisible = allActors.every((a) => visible.has(a))
  const chip = (a: string, label: React.ReactNode, color?: string) => (
    <button
      key={a}
      onClick={(e) => (e.altKey || e.metaKey ? setActors(new Set([a])) : toggle(a))}
      title="Click to toggle · Alt-click to show only this actor"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
        visible.has(a) ? 'border-foreground/30 bg-secondary text-foreground' : 'text-muted-foreground opacity-60 hover:opacity-100',
      )}
    >
      {color && <span className="size-2 rounded-full" style={{ background: color }} />}
      {label}
      <span className="font-mono text-[10px] text-muted-foreground">{counts.get(a) ?? 0}</span>
    </button>
  )

  return (
    <div className="flex flex-col gap-4">
      {!d.summary.archived && <ToolFilterBar filter={filter} />}
      {filter.active && (
        <p className="text-xs text-muted-foreground">
          showing {toolCounts.shown} of {toolCounts.total} tool calls (filter active) —{' '}
          <button className="underline hover:text-foreground" onClick={filter.clear}>
            clear
          </button>
        </p>
      )}
      <div className="sticky top-14 z-20 -mx-1 flex flex-wrap items-center gap-2 bg-background/90 px-1 py-2 backdrop-blur">
        <span className="text-xs font-medium text-muted-foreground">Actors</span>
        {chip(USER, 'You')}
        {chip(MAIN, 'Claude (main)', 'var(--foreground)')}
        {d.agents.map((a) =>
          chip(
            a.id,
            <span className="max-w-56 truncate">
              {a.type}: {a.description}
            </span>,
            agents.get(a.id)?.color,
          ),
        )}
        {chip(SYSTEM, 'System & context')}
        <Button variant="ghost" size="xs" disabled={allVisible} onClick={() => setActors(new Set(allActors))}>
          All
        </Button>
        <Button variant="ghost" size="xs" disabled={!visible.size} onClick={() => setActors(new Set())}>
          None
        </Button>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={showThinking} onCheckedChange={(v) => setShowThinking(!!v)} /> thinking
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={toolInputs} onCheckedChange={(v) => setToolInputs(!!v)} /> tool inputs
        </label>
      </div>
      <div className="rounded-xl border bg-card px-4 py-3 sm:px-6">
        {events.slice(0, limit).map((e) => {
          const ag = agents.get(e.actor)
          return (
            <TranscriptRow
              key={e.kind === 'tool_use' && e.toolId ? `tool-${e.toolId}` : `${e.uuid}-${index.get(e)}`}
              e={e}
              agent={ag?.a}
              agentColor={ag?.color}
              sessionId={d.summary.id}
              showThinking={showThinking}
              toolInputs={toolInputs}
              onOpenAgent={onOpenAgent}
              hits={filter.hits(e)}
            />
          )
        })}
        {!events.length && <p className="py-10 text-center text-sm text-muted-foreground">{visible.size ? 'No events for the selected actors.' : 'No actors selected. Pick one above to see its events.'}</p>}
        {events.length > limit && (
          <div className="py-4 text-center">
            <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + 1000)}>
              Show more ({events.length - limit} remaining)
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function Agents({ d, labels, onOpenAgent }: { d: SessionDetail; labels: Record<string, string>; onOpenAgent: (id: string) => void }) {
  const main = d.main
  const slots = useThemeContext().shown.chart.categorical.length
  const children = (parent: string) => d.agents.filter((a) => (a.parentId ?? MAIN) === parent)
  const renderNode = (a: AgentInfo, depth: number, color?: string): React.ReactNode => (
    <div key={a.id} className="flex flex-col gap-2" style={{ marginLeft: depth * 20 }}>
      <div className="rounded-lg border p-4" style={color ? { borderLeft: `3px solid ${color}` } : undefined}>
        <div className="flex flex-wrap items-center gap-2">
          <Bot className="size-4 text-muted-foreground" />
          <span className="font-medium">{a.type}</span>
          <span className="text-sm text-muted-foreground">{a.description}</span>
          {a.background && <Badge variant="outline">background</Badge>}
          {(a.models ?? []).map((m) => (
            <Badge key={m} variant="secondary" className="font-normal">
              {modelLabel(m, labels)}
            </Badge>
          ))}
          {a.id !== MAIN && (
            <Button variant="outline" size="xs" className="ml-auto" onClick={() => onOpenAgent(a.id)}>
              View transcript
            </Button>
          )}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs text-muted-foreground sm:grid-cols-5">
          <span>{usd(a.cost)}</span>
          <span>{duration((new Date(a.end).getTime() - new Date(a.start).getTime()) / 1000)} wall</span>
          <span>{a.toolCalls} tool calls{a.toolErrors ? ` · ${a.toolErrors} failed` : ''}</span>
          <span>{tokens(promptTokens(a.usage))} in · {tokens(a.usage.output)} out</span>
          <span>{a.usage.messages} responses</span>
        </div>
        {a.prompt && (
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground">Prompt</summary>
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted/60 p-2 font-mono text-xs whitespace-pre-wrap">{a.prompt}</pre>
          </details>
        )}
      </div>
      {children(a.id).map((c) => renderNode(c, depth + 1, agentColor(d.agents.indexOf(c), slots)))}
    </div>
  )
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Agent tree</CardTitle>
          <CardDescription>Main thread and every subagent it launched, with their cost and model.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">{renderNode(main, 0)}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Cost by model</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.models.map((m) => (
                <TableRow key={m.model}>
                  <TableCell>
                    {modelLabel(m.model, labels)}
                    {m.rates.map((r) => (
                      <div key={r} className="text-[10px] text-muted-foreground">
                        {r}
                      </div>
                    ))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{tokens(m.usage.output)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{usd(m.cost)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function useActors(d: SessionDetail) {
  const slots = useThemeContext().shown.chart.categorical.length
  return useMemo(
    () => ({
      name: (a: string) => (a === MAIN ? 'main' : a === USER ? 'you' : (d.agents.find((x) => x.id === a)?.type ?? a.slice(0, 6))),
      color: (a: string) => {
        const i = d.agents.findIndex((x) => x.id === a)
        return i >= 0 ? agentColor(i, slots) : 'var(--foreground)'
      },
    }),
    [d.agents, slots],
  )
}

function ActorTag({ actor, actors }: { actor: string; actors: ReturnType<typeof useActors> }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-2 shrink-0 rounded-full" style={{ background: actors.color(actor) }} aria-hidden />
      {actors.name(actor)}
    </span>
  )
}

function Chevron({ open }: { open: boolean }) {
  const C = open ? ChevronDown : ChevronRight
  return <C className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
}

const SHOW_STEP = 25

function ToolCalls({ d, name, onJump, actors }: { d: SessionDetail; name: string; onJump: Jump; actors: ReturnType<typeof useActors> }) {
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [shown, setShown] = useState(SHOW_STEP)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const calls = useMemo(() => d.events.filter((e) => e.kind === 'tool_use' && e.tool === name), [d.events, name])
  const hasErrors = calls.some((e) => callStatus(e) === 'error')
  const list = errorsOnly ? calls.filter((e) => callStatus(e) === 'error') : calls
  const toggle = (k: string) => setOpen((o) => toggled(o, k))
  return (
    <div className="flex flex-col gap-1">
      {hasErrors && (
        <label className="mb-1 flex w-fit items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={errorsOnly} onCheckedChange={(v) => setErrorsOnly(!!v)} /> errors only
        </label>
      )}
      {!list.length && <span className="text-xs text-muted-foreground">No calls in the transcript.</span>}
      {list.slice(0, shown).map((e, i) => {
        const k = e.toolId ?? `${e.uuid}-${i}`
        const isOpen = open.has(k)
        return (
          <div key={k} className="rounded-md border">
            <div className="flex items-center gap-2 px-2 py-1 text-xs">
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={isOpen} onClick={() => toggle(k)}>
                <Chevron open={isOpen} />
                <span className="shrink-0 font-mono text-muted-foreground tabular-nums">{time(e.t)}</span>
                <ActorTag actor={e.actor} actors={actors} />
                <StatusDot status={callStatus(e)} />
                <span className="truncate font-mono" title={e.summary}>
                  {e.summary || '—'}
                </span>
              </button>
              <Button variant="outline" size="xs" onClick={() => onJump(e.uuid, e.toolId)}>
                jump
              </Button>
            </div>
            {isOpen && (
              <div className="border-t bg-muted/30 p-2">
                <ToolCallDetail e={e} sessionId={d.summary.id} />
              </div>
            )}
          </div>
        )
      })}
      {list.length > shown && (
        <Button variant="ghost" size="xs" className="w-fit" onClick={() => setShown((n) => n + SHOW_STEP)}>
          show more ({list.length - shown} remaining)
        </Button>
      )}
    </div>
  )
}

type Jump = (uuid: string, toolId?: string) => void

function Tools({ d, onJump, filter }: { d: SessionDetail; onJump: Jump; filter: ToolFilter }) {
  const max = Math.max(1, ...d.tools.map((t) => t.calls))
  const actors = useActors(d)
  // Subagents of one type are merged ("general-purpose 178 (8 agents)") so the column stays readable.
  const byActor = (counts: Record<string, number>) => {
    const by = new Map<string, { n: number; agents: number }>()
    for (const [a, n] of Object.entries(counts)) {
      const g = by.get(actors.name(a)) ?? { n: 0, agents: 0 }
      by.set(actors.name(a), { n: g.n + n, agents: g.agents + 1 })
    }
    return [...by].map(([name, g]) => `${name} ${g.n}${g.agents > 1 ? ` (${g.agents} agents)` : ''}`).join(' · ')
  }
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (k: string) => setOpen((o) => toggled(o, k))
  return (
    <div className="flex flex-col gap-4">
      <ToolFilterBar filter={filter} />
      {filter.active && (
        <FilteredCalls
          filter={filter}
          sessionId={d.summary.id}
          onJump={onJump}
          actor={(a) => <ActorTag actor={a} actors={actors} />}
        />
      )}
    <Card>
      <CardHeader>
        <CardTitle>Tool usage</CardTitle>
        <CardDescription>
          Token figures are estimates (≈4 chars/token): input is what Claude wrote into the call, output is the result text that entered context.
          Agent rows also show the real cost of the subagents they launched.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead className="w-[30%]">Calls</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">Rejected</TableHead>
              <TableHead>By actor</TableHead>
              <TableHead className="text-right">Input ≈tok</TableHead>
              <TableHead className="text-right">Output ≈tok</TableHead>
              <TableHead className="text-right">Subagent cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.tools.map((t) => (
              <Fragment key={t.name}>
                <TableRow className="cursor-pointer" onClick={() => toggle(t.name)}>
                  <TableCell className="font-mono text-xs">
                    <button className="flex items-center gap-1.5 text-left" aria-expanded={open.has(t.name)}>
                      <Chevron open={open.has(t.name)} />
                      <span>
                        {t.name}
                        {t.group !== 'builtin' && <span className="block text-[10px] text-muted-foreground">{t.group}</span>}
                      </span>
                    </button>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 rounded-full bg-muted">
                        <div className="h-2 rounded-full bg-[var(--sequential)]" style={{ width: `${(t.calls / max) * 100}%` }} />
                      </div>
                      <span className="w-8 text-right font-mono text-xs tabular-nums">{t.calls}</span>
                    </div>
                  </TableCell>
                  <TableCell className={cn('text-right font-mono text-xs', t.errors > 0 && 'text-[var(--critical)]')}>{t.errors}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{t.rejected}</TableCell>
                  <TableCell className="min-w-48 text-xs whitespace-normal text-muted-foreground">{byActor(t.byActor)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{tokens(t.inputTokensEst)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{tokens(t.resultTokensEst)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{t.subagentCost ? usd(t.subagentCost) : ''}</TableCell>
                </TableRow>
                {open.has(t.name) && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={8} className="bg-muted/20 whitespace-normal">
                      <div className="w-0 min-w-full">
                        <ToolCalls d={d} name={t.name} onJump={onJump} actors={actors} />
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
    </div>
  )
}

function Skills({ d, onJump }: { d: SessionDetail; onJump: (uuid: string) => void }) {
  if (!d.skills.length) return <Empty text="No skills or slash commands were used in this session." />
  return (
    <Card>
      <CardHeader>
        <CardTitle>Skills &amp; commands</CardTitle>
        <CardDescription>Skills invoked through the Skill tool, plus slash commands typed by the user.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Uses</TableHead>
              <TableHead>Invocations</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.skills.map((s) => (
              <TableRow key={`${s.kind}:${s.name}`}>
                <TableCell className="font-mono text-sm">{s.kind === 'command' ? `/${s.name}` : s.name}</TableCell>
                <TableCell>
                  <Badge variant={s.kind === 'skill' ? 'default' : 'outline'}>{s.kind === 'skill' ? 'skill' : 'slash command'}</Badge>
                </TableCell>
                <TableCell className="text-right font-mono">{s.count}</TableCell>
                <TableCell className="max-w-xl">
                  <ul className="flex flex-col gap-1">
                    {s.uses.map((u, i) => (
                      <li key={i} className="flex gap-2 text-xs">
                        <button className="shrink-0 font-mono text-muted-foreground hover:text-foreground hover:underline" onClick={() => onJump(u.uuid)}>
                          {dateTime(u.t)}
                        </button>
                        <span className="truncate text-muted-foreground" title={u.args}>
                          {u.args || '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

const OP_ORDER = ['loaded', 'read', 'write', 'edit']

// A time of day, prefixed with the date when it falls on a different (local) day than ref.
function timeOn(iso: string, ref: string) {
  const d = new Date(iso)
  if (d.toDateString() === new Date(ref).toDateString()) return time(iso)
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time(iso)}`
}

// Collapses time-ordered reloads that display the same second into one entry, keeping the first.
function sameSecond(reloads: MemoryReload[], ref: string) {
  const out: { r: MemoryReload; label: string; n: number }[] = []
  for (const r of reloads) {
    const label = timeOn(r.t, ref)
    const last = out[out.length - 1]
    if (last?.label === label) last.n++
    else out.push({ r, label, n: 1 })
  }
  return out
}

const REDACTED = /^\[redacted \d+ chars?\]$/

// Latest known body of a memory file. Edits (and writes whose input we can't read) after the chosen
// content are reported in `after` so the UI can say the shown text is stale.
function latestContent(accesses: MemoryAccess[], byTool: Map<string, SessionEvent>) {
  let after: MemoryAccess | undefined
  for (let i = accesses.length - 1; i >= 0; i--) {
    const a = accesses[i]
    if (a.op === 'loaded' && a.content) {
      // Reloads confirm the same content, so the text is current as of the last of them. Only an edit or
      // write after that point makes it stale.
      const last = a.reloads?.length ? a.reloads[a.reloads.length - 1].t : a.t
      const lastMs = Date.parse(last) || 0
      if (after && Date.parse(after.t) < lastMs) after = undefined
      return { text: a.content, from: `loaded ${timeOn(last, a.t)}`, after }
    }
    if (a.op === 'edit') after ??= a
    if (a.op === 'write') {
      const ev = a.toolId ? byTool.get(a.toolId) : undefined
      const inp = ev?.input
      const c = typeof inp === 'object' && inp !== null ? (inp as Record<string, unknown>).content : undefined
      if (ev && !ev.inputTruncated && typeof c === 'string' && !REDACTED.test(c.trim())) return { text: c, from: `Write ${time(a.t)}`, after }
      after ??= a
    }
  }
}

function MemoryAccessRow({ a, ev, d, onJump, actors }: { a: MemoryAccess; ev?: SessionEvent; d: SessionDetail; onJump: Jump; actors: ReturnType<typeof useActors> }) {
  const [open, setOpen] = useState(false)
  const tool = a.op !== 'loaded'
  const hasDetail = tool ? !!a.toolId : true
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 px-2 py-1 text-xs">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default" aria-expanded={open} disabled={!hasDetail} onClick={() => setOpen((o) => !o)}>
          {hasDetail ? <Chevron open={open} /> : <span className="size-3.5" />}
          <span className="shrink-0 font-mono text-muted-foreground tabular-nums">{time(a.t)}</span>
          <Badge variant={a.op === 'loaded' ? 'secondary' : 'outline'}>{a.op}</Badge>
          <ActorTag actor={a.actor} actors={actors} />
          {!!a.reloads?.length && <span className="text-[10px] text-muted-foreground">reloaded ×{a.reloads.length}</span>}
          {!tool && !!a.content && <span className="font-mono text-[10px] text-muted-foreground">≈{tokens(a.content.length / 4)} tokens</span>}
        </button>
        {a.uuid && (
          <Button variant="outline" size="xs" onClick={() => onJump(a.uuid, a.toolId)}>
            jump
          </Button>
        )}
      </div>
      {!!a.reloads?.length && (
        <div className="flex flex-wrap items-center gap-x-1.5 px-2 pb-1 pl-8 text-[11px] text-muted-foreground">
          <span>reloaded at</span>
          {sameSecond(a.reloads, a.t).map(({ r, label, n }, i) => (
            <Fragment key={`${r.uuid}-${i}`}>
              {i > 0 && <span aria-hidden>·</span>}
              <button className="font-mono tabular-nums hover:text-foreground hover:underline" title={`${actors.name(r.actor)} · jump to ${n > 1 ? `the first of these ${n} loads` : 'this load'}`} onClick={() => onJump(r.uuid)}>
                {label}
                {n > 1 && ` ×${n}`}
              </button>
            </Fragment>
          ))}
        </div>
      )}
      {open && (
        <div className="border-t bg-muted/30 p-2">
          {!tool ? (
            a.content ? (
              <>
                <Collapsible text={a.content} previewLines={12} scroll />
                {a.truncated && <div className="text-[10px] text-muted-foreground">content truncated</div>}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">path referenced in injected context; contents weren't captured</span>
            )
          ) : ev ? (
            <ToolCallDetail e={ev} sessionId={d.summary.id} />
          ) : (
            <span className="text-xs text-muted-foreground">tool call not found in transcript</span>
          )}
        </div>
      )}
    </div>
  )
}

function MemoryDetail({ m, d, byTool, onJump, actors }: { m: SessionDetail['memories'][number]; d: SessionDetail; byTool: Map<string, SessionEvent>; onJump: Jump; actors: ReturnType<typeof useActors> }) {
  const [showLatest, setShowLatest] = useState(false)
  const accesses = useMemo(() => {
    const ms = (a: MemoryAccess) => Date.parse(a.t) || 0
    return (m.accesses ?? []).map((a, i) => ({ a, i })).sort((x, y) => ms(x.a) - ms(y.a) || x.i - y.i).map((x) => x.a)
  }, [m.accesses])
  // Folded reloads count toward ops but have no row of their own.
  const unlisted = Object.values(m.ops).reduce((n, v) => n + v, 0) - accesses.length - accesses.reduce((n, a) => n + (a.reloads?.length ?? 0), 0)
  const latest = useMemo(() => latestContent(accesses, byTool), [accesses, byTool])
  if (!accesses.length) return <span className="text-xs text-muted-foreground">No access details in this payload.</span>
  return (
    <div className="flex flex-col gap-1">
      {latest && (
        <div className="mb-1 flex flex-col gap-1">
          <Button variant="outline" size="xs" className="w-fit" aria-expanded={showLatest} onClick={() => setShowLatest((v) => !v)}>
            {showLatest ? 'Hide' : 'Show'} {latest.after ? 'content' : 'latest content'} (as of {latest.from})
          </Button>
          {latest.after && (
            <span className="text-xs text-[var(--warning)]">
              Content as of {latest.from} — {latest.after.op === 'edit' ? 'edited' : 'written (content unavailable)'} at {time(latest.after.t)} after this
            </span>
          )}
          {showLatest && (
            <div className="rounded-md border bg-muted/30 p-2">
              <Collapsible text={latest.text} previewLines={20} scroll />
            </div>
          )}
        </div>
      )}
      {accesses.map((a, i) => (
        <MemoryAccessRow key={`${a.uuid}-${i}`} a={a} ev={a.toolId ? byTool.get(a.toolId) : undefined} d={d} onJump={onJump} actors={actors} />
      ))}
      {unlisted > 0 && <span className="text-xs text-muted-foreground">+{unlisted} more accesses not listed (first 200 kept)</span>}
    </div>
  )
}

function Memories({ d, onJump }: { d: SessionDetail; onJump: Jump }) {
  const actors = useActors(d)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const byTool = useMemo(() => {
    const m = new Map<string, SessionEvent>()
    for (const e of d.events) if (e.kind === 'tool_use' && e.toolId) m.set(e.toolId, e)
    return m
  }, [d.events])
  const toggle = (k: string) => setOpen((o) => toggled(o, k))
  if (!d.memories.length)
    return <Empty text="No CLAUDE.md, rules or auto-memory files were loaded, read or written in this session." />
  return (
    <Card>
      <CardHeader>
        <CardTitle>Memories</CardTitle>
        <CardDescription>CLAUDE.md files, rules and auto-memory files that were loaded into context or read/written by tools. Expand a row to see each access.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Path</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Operations</TableHead>
              <TableHead className="text-right">≈Tokens</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.memories.map((m) => (
              <Fragment key={m.path}>
                <TableRow className="cursor-pointer" onClick={() => toggle(m.path)}>
                  <TableCell className="max-w-lg font-mono text-xs" title={m.path}>
                    <button className="flex max-w-full items-center gap-1.5 text-left" aria-expanded={open.has(m.path)}>
                      <Chevron open={open.has(m.path)} />
                      <span className="truncate">{m.path}</span>
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{m.kind}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {Object.entries(m.ops)
                      .sort(([a], [b]) => OP_ORDER.indexOf(a) - OP_ORDER.indexOf(b))
                      .map(([k, v]) => `${k} ×${v}`)
                      .join(' · ')}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{m.tokensEst ? tokens(m.tokensEst) : '–'}</TableCell>
                </TableRow>
                {open.has(m.path) && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4} className="bg-muted/20 whitespace-normal">
                      <div className="w-0 min-w-full">
                        <MemoryDetail m={m} d={d} byTool={byTool} onJump={onJump} actors={actors} />
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

const severityIcon = {
  bad: <OctagonAlert className="size-4 text-[var(--critical)]" />,
  warn: <AlertTriangle className="size-4 text-[var(--serious)]" />,
  info: <Info className="size-4 text-muted-foreground" />,
}

function Insights({ insights, onJump }: { insights: Insight[]; onJump: (uuid: string) => void }) {
  if (!insights.length) return <Empty text="No friction detected: no failed or rejected calls, interruptions, retries or cache problems." />
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {insights.map((i) => (
        <Card key={i.kind}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {severityIcon[i.severity]}
              {i.title}
              <span className="ml-auto font-mono text-sm text-muted-foreground">{i.kind === 'cache' ? `${i.count}%` : `×${i.count}`}</span>
            </CardTitle>
            <CardDescription>{i.detail}</CardDescription>
          </CardHeader>
          {i.events && i.events.length > 0 && (
            <CardContent className="flex flex-wrap gap-1">
              {[...new Set(i.events)].slice(0, 12).map((uuid, n) => (
                <Button key={uuid} variant="outline" size="xs" onClick={() => onJump(uuid)}>
                  #{n + 1}
                </Button>
              ))}
            </CardContent>
          )}
        </Card>
      ))}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">{text}</div>
}
