import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { AlertTriangle, ArrowLeft, Bot, Info, OctagonAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ClassifyButton, SuggestionReview } from '@/components/suggestion'
import { TagEditor } from '@/components/tag-editor'
import { MAIN, SYSTEM, TranscriptRow, USER } from '@/components/transcript'
import { useFetch } from '@/hooks/use-fetch'
import { api, promptTokens, totalTokens, type AgentInfo, type Insight, type SessionDetail } from '@/lib/api'
import { dateTime, duration, modelLabel, tokens, usd } from '@/lib/format'
import { cn } from '@/lib/utils'

const agentColor = (i: number) => `var(--series-${(i % 7) + 1})`

export function SessionPage() {
  const { id = '' } = useParams()
  const detail = useFetch(() => api.session(id), [id])
  const meta = useFetch(() => api.meta(), [])
  const [tab, setTab] = useState('conversation')
  const [actors, setActors] = useState<Set<string>>()
  const [vocab, setVocab] = useState<string[]>()

  const d = detail.data
  const labels = meta.data?.modelLabels ?? {}

  useEffect(() => {
    if (d) document.title = `${d.summary.title} · Session Browser`
  }, [d])

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
  const jumpTo = (uuid: string) => {
    setActors(new Set(allActors))
    setTab('conversation')
    setTimeout(() => {
      const el = document.getElementById(`ev-${uuid}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el?.animate([{ background: 'color-mix(in oklab, var(--warning) 35%, transparent)' }, { background: 'transparent' }], { duration: 2000 })
    }, 50)
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
        <Conversation d={d} visible={visible} allActors={allActors} setActors={setActors} onOpenAgent={openAgent} />
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

            <TabsContent value="conversation" className="mt-4">
              <Conversation d={d} visible={visible} allActors={allActors} setActors={setActors} onOpenAgent={openAgent} />
            </TabsContent>
            <TabsContent value="agents" className="mt-4">
              <Agents d={d} labels={labels} onOpenAgent={openAgent} />
            </TabsContent>
            <TabsContent value="tools" className="mt-4">
              <Tools d={d} />
            </TabsContent>
            <TabsContent value="skills" className="mt-4">
              <Skills d={d} onJump={jumpTo} />
            </TabsContent>
            <TabsContent value="memories" className="mt-4">
              <Memories d={d} />
            </TabsContent>
            <TabsContent value="insights" className="mt-4">
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
}

function Conversation({ d, visible, allActors, setActors, onOpenAgent }: ConversationProps) {
  const [showThinking, setShowThinking] = useState(true)
  const [limit, setLimit] = useState(400)
  const agents = useMemo(() => new Map(d.agents.map((a, i) => [a.id, { a, color: agentColor(i + 1) }])), [d.agents])
  const events = useMemo(() => d.events.filter((e) => visible.has(e.actor) || (!agents.has(e.actor) && !allActors.includes(e.actor) && visible.has(SYSTEM))), [d.events, visible, agents, allActors])

  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const e of d.events) c.set(e.actor, (c.get(e.actor) ?? 0) + 1)
    return c
  }, [d.events])

  const toggle = (a: string) => {
    const next = new Set(visible)
    next.has(a) ? next.delete(a) : next.add(a)
    setActors(next)
  }
  const chip = (a: string, label: React.ReactNode, color?: string) => (
    <button
      key={a}
      onClick={() => toggle(a)}
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
        <Button variant="ghost" size="xs" onClick={() => setActors(new Set(allActors))}>
          All
        </Button>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={showThinking} onCheckedChange={(v) => setShowThinking(!!v)} /> thinking
        </label>
      </div>
      <div className="rounded-xl border bg-card px-4 py-3 sm:px-6">
        {events.slice(0, limit).map((e, i) => {
          const ag = agents.get(e.actor)
          return (
            <TranscriptRow
              key={`${e.uuid}-${i}`}
              e={e}
              agent={ag?.a}
              agentColor={ag?.color}
              showThinking={showThinking}
              onOpenAgent={onOpenAgent}
            />
          )
        })}
        {!events.length && <p className="py-10 text-center text-sm text-muted-foreground">No events for the selected actors.</p>}
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
      {children(a.id).map((c) => renderNode(c, depth + 1, agentColor(d.agents.indexOf(c) + 1)))}
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

function Tools({ d }: { d: SessionDetail }) {
  const max = Math.max(1, ...d.tools.map((t) => t.calls))
  const actorName = (a: string) => (a === MAIN ? 'main' : (d.agents.find((x) => x.id === a)?.type ?? a.slice(0, 6)))
  return (
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
              <TableRow key={t.name}>
                <TableCell className="font-mono text-xs">
                  {t.name}
                  {t.group !== 'builtin' && <div className="text-[10px] text-muted-foreground">{t.group}</div>}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="h-2 flex-1 rounded-full bg-muted">
                      <div className="h-2 rounded-full bg-[var(--series-1)]" style={{ width: `${(t.calls / max) * 100}%` }} />
                    </div>
                    <span className="w-8 text-right font-mono text-xs tabular-nums">{t.calls}</span>
                  </div>
                </TableCell>
                <TableCell className={cn('text-right font-mono text-xs', t.errors > 0 && 'text-[var(--critical)]')}>{t.errors}</TableCell>
                <TableCell className="text-right font-mono text-xs">{t.rejected}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {Object.entries(t.byActor)
                    .map(([a, n]) => `${actorName(a)} ${n}`)
                    .join(' · ')}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">{tokens(t.inputTokensEst)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{tokens(t.resultTokensEst)}</TableCell>
                <TableCell className="text-right font-mono text-xs">{t.subagentCost ? usd(t.subagentCost) : ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
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

function Memories({ d }: { d: SessionDetail }) {
  if (!d.memories.length)
    return <Empty text="No CLAUDE.md, rules or auto-memory files were loaded, read or written in this session." />
  return (
    <Card>
      <CardHeader>
        <CardTitle>Memories</CardTitle>
        <CardDescription>CLAUDE.md files, rules and auto-memory files that were loaded into context or read/written by tools.</CardDescription>
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
              <TableRow key={m.path}>
                <TableCell className="max-w-lg truncate font-mono text-xs" title={m.path}>
                  {m.path}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{m.kind}</Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {Object.entries(m.ops)
                    .map(([k, v]) => `${k} ×${v}`)
                    .join(' · ')}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">{m.tokensEst ? tokens(m.tokensEst) : '–'}</TableCell>
              </TableRow>
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
