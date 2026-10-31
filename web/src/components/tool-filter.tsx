import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { StatusDot, ToolCallDetail } from '@/components/tool-call'
import type { SearchCall, SearchHit, SessionEvent } from '@/lib/api'
import { time } from '@/lib/format'
import { callStatus, toggled } from '@/lib/tool-call'
import type { CaseMode, Scope, SearchEngine, ToolFilter } from '@/lib/tool-filter'
import { cn } from '@/lib/utils'

const selectClass =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 [&>option]:bg-popover [&>option]:text-popover-foreground'

const enc = new TextEncoder()
const dec = new TextDecoder()

// Ranges are byte offsets into the UTF-8 text.
function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts = useMemo(() => {
    const bytes = enc.encode(text)
    const out: { s: string; hit: boolean }[] = []
    let at = 0
    for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
      const from = Math.max(a, at)
      const to = Math.min(b, bytes.length)
      if (to <= from) continue
      if (from > at) out.push({ s: dec.decode(bytes.subarray(at, from)), hit: false })
      out.push({ s: dec.decode(bytes.subarray(from, to)), hit: true })
      at = to
    }
    if (at < bytes.length) out.push({ s: dec.decode(bytes.subarray(at)), hit: false })
    return out
  }, [text, ranges])
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-[color-mix(in_oklch,var(--warning)_35%,transparent)] text-inherit">
            {p.s}
          </mark>
        ) : (
          <span key={i}>{p.s}</span>
        ),
      )}
    </>
  )
}

function Hit({ h }: { h: SearchHit }) {
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <span className="shrink-0 rounded border px-1 font-mono text-[10px] text-muted-foreground" title={h.field === 'input' ? 'matched in the call input' : 'matched in the call output'}>
        {h.field === 'input' ? 'in' : 'out'}
      </span>
      <span className="w-8 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">{h.line}</span>
      <span className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap">
        <Highlighted text={h.text} ranges={h.ranges} />
      </span>
    </li>
  )
}

export function ToolHits({ call, className }: { call?: SearchCall; className?: string }) {
  if (!call?.hits.length) return null
  return (
    <ul className={cn('flex flex-col gap-0.5', className)}>
      {call.hits.map((h, i) => (
        <Hit key={i} h={h} />
      ))}
      {!!call.more && <li className="pl-12 text-[10px] text-muted-foreground">+{call.more} more</li>}
    </ul>
  )
}

function Status({ f }: { f: ToolFilter }) {
  const s = f.status
  if (s.state === 'idle') return null
  if (s.state === 'searching') return <span className="text-xs text-muted-foreground">searching…</span>
  if (s.state === 'error') return <span className="text-xs text-[var(--critical)]">{s.message}</span>
  return (
    <span className="text-xs text-muted-foreground">
      {s.total} {s.total === 1 ? 'call' : 'calls'} · {s.engine}
      {s.truncated && ' (capped)'}
    </span>
  )
}

export function ToolFilterBar({ filter: f }: { filter: ToolFilter }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={f.glob}
        onChange={(e) => f.setGlob(e.target.value)}
        placeholder="glob: **/*.go, internal/**"
        aria-label="Filter calls by path glob"
        className="h-8 w-56 font-mono text-xs md:text-xs"
      />
      <label className="flex items-center gap-2 text-xs text-muted-foreground" title="Also match globs against path-like words in Bash commands">
        <Checkbox checked={f.cmdPaths} onCheckedChange={(v) => f.setCmdPaths(!!v)} /> include Bash arguments
      </label>
      <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
      <Input
        value={f.query}
        onChange={(e) => f.setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && f.searchNow()}
        placeholder={f.literal ? 'search input/output (literal)' : 'search input/output (regex)'}
        aria-label="Search tool call input and output"
        className="h-8 w-64 font-mono text-xs md:text-xs"
      />
      <select className={selectClass} value={f.caseMode} onChange={(e) => f.setCaseMode(e.target.value as CaseMode)} aria-label="Case sensitivity" title="Case sensitivity">
        <option value="smart">smart case</option>
        <option value="insensitive">ignore case</option>
        <option value="sensitive">match case</option>
      </select>
      <select className={selectClass} value={f.scope} onChange={(e) => f.setScope(e.target.value as Scope)} aria-label="Search scope" title="Where to search">
        <option value="both">input + output</option>
        <option value="input">input only</option>
        <option value="output">output only</option>
      </select>
      <select className={selectClass} value={f.literal ? 'literal' : 'regex'} onChange={(e) => f.setLiteral(e.target.value === 'literal')} aria-label="Pattern type" title="Pattern type">
        <option value="regex">regex</option>
        <option value="literal">literal</option>
      </select>
      <select className={selectClass} value={f.engine} onChange={(e) => f.setEngine(e.target.value as SearchEngine)} aria-label="Search engine" title="Search engine (remembered in this browser). Default uses the server's search.engine setting.">
        <option value="auto">default engine</option>
        <option value="go">force Go</option>
      </select>
      <Status f={f} />
      {f.globError && <span className="basis-full text-xs text-[var(--critical)]">{f.globError} (ignored until corrected)</span>}
      <Button variant="ghost" size="xs" className="ml-auto" disabled={!f.glob && !f.query} onClick={f.clear} title="Clear glob and search">
        <X /> clear
      </Button>
    </div>
  )
}

const SHOW_STEP = 25

type Jump = (uuid: string, toolId?: string) => void

// Flat list of the calls the active filter lets through, for the Tools tab. Paging returns to the first
// page whenever the set of matching calls changes; open rows survive glob edits.
export function FilteredCalls({
  filter: f,
  sessionId,
  onJump,
  actor,
}: {
  filter: ToolFilter
  sessionId: string
  onJump: Jump
  actor: (a: string) => React.ReactNode
}) {
  // Paging is tied to the match set it was grown for; a different set starts over at the first page.
  const [paging, setPaging] = useState({ key: f.matchKey, n: SHOW_STEP })
  const shown = paging.key === f.matchKey ? paging.n : SHOW_STEP
  const [open, setOpen] = useState<Set<string>>(new Set())
  const perTool = useMemo(() => {
    const c = new Map<string, number>()
    for (const e of f.calls) c.set(e.tool ?? '?', (c.get(e.tool ?? '?') ?? 0) + 1)
    return [...c].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} ${k}`)
  }, [f.calls])
  const searching = f.status.state === 'searching'
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {f.calls.length} matching {f.calls.length === 1 ? 'call' : 'calls'}
          <span className="ml-2 text-sm font-normal text-muted-foreground">of {f.totalCalls}</span>
        </CardTitle>
        {perTool.length > 0 && <CardDescription>{perTool.join(' · ')}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {!f.calls.length && <span className="text-xs text-muted-foreground">{searching ? 'Searching…' : 'No calls match the filter.'}</span>}
        {f.calls.slice(0, shown).map((e, i) => (
          <CallRow key={e.toolId ?? `${e.uuid}-${i}`} e={e} sessionId={sessionId} f={f} onJump={onJump} actor={actor} open={open.has(e.toolId ?? `${e.uuid}-${i}`)} onToggle={() => setOpen((o) => toggled(o, e.toolId ?? `${e.uuid}-${i}`))} />
        ))}
        {f.calls.length > shown && (
          <Button variant="ghost" size="xs" className="w-fit" onClick={() => setPaging({ key: f.matchKey, n: shown + SHOW_STEP })}>
            show more ({f.calls.length - shown} remaining)
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function CallRow({ e, sessionId, f, onJump, actor, open, onToggle }: { e: SessionEvent; sessionId: string; f: ToolFilter; onJump: Jump; actor: (a: string) => React.ReactNode; open: boolean; onToggle: () => void }) {
  const C = open ? ChevronDown : ChevronRight
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 px-2 py-1 text-xs">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open} onClick={onToggle}>
          <C className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="shrink-0 font-mono text-muted-foreground tabular-nums">{time(e.t)}</span>
          {actor(e.actor)}
          <StatusDot status={callStatus(e)} />
          <span className="shrink-0 font-mono font-semibold">{e.tool}</span>
          <span className="truncate font-mono text-muted-foreground" title={e.summary}>
            {e.summary || '—'}
          </span>
        </button>
        <Button variant="outline" size="xs" onClick={() => onJump(e.uuid, e.toolId)}>
          jump
        </Button>
      </div>
      <ToolHits call={f.hits(e)} className="px-2 pb-1.5" />
      {open && (
        <div className="border-t bg-muted/30 p-2">
          <ToolCallDetail e={e} sessionId={sessionId} />
        </div>
      )}
    </div>
  )
}
