import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowDown, ArrowUp, Filter, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SuggestionReview } from '@/components/suggestion'
import { TagEditor } from '@/components/tag-editor'
import type { Summary } from '@/lib/api'
import { dateTime, duration, modelLabel, sessionHref, usd } from '@/lib/format'

type SortKey = 'start' | 'title' | 'project' | 'activeSeconds' | 'userPrompts' | 'toolCalls' | 'cost' | 'friction'

const friction = (s: Summary) => s.toolErrors + s.rejections + s.interrupts

type Props = {
  sessions: Summary[]
  vocabulary: string[]
  labels: Record<string, string>
  onUpdate: (id: string, patch: Partial<Summary>) => void
  onVocabulary: (tags: string[]) => void
}

export function SessionTable({ sessions, vocabulary, labels, onUpdate, onVocabulary }: Props) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'start', desc: true })
  const [filters, setFilters] = useState<{ project: Set<string>; model: Set<string>; tag: Set<string>; source: Set<string> }>({
    project: new Set(),
    model: new Set(),
    tag: new Set(),
    source: new Set(),
  })
  const [limit, setLimit] = useState(50)

  const options = useMemo(
    () => ({
      project: [...new Set(sessions.map((s) => s.project))].sort(),
      model: [...new Set(sessions.flatMap((s) => s.models))].sort(),
      tag: [...new Set([...vocabulary, ...sessions.flatMap((s) => s.tags)])].sort(),
      source: [...new Set(sessions.map((s) => s.source))].sort(),
    }),
    [sessions, vocabulary],
  )

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const out = sessions.filter(
      (s) =>
        (!needle || `${s.title} ${s.firstPrompt} ${s.project} ${s.id}`.toLowerCase().includes(needle)) &&
        (!filters.project.size || filters.project.has(s.project)) &&
        (!filters.source.size || filters.source.has(s.source)) &&
        (!filters.model.size || s.models.some((m) => filters.model.has(m))) &&
        (!filters.tag.size || s.tags.some((t) => filters.tag.has(t))),
    )
    const val = (s: Summary): number | string =>
      sort.key === 'friction' ? friction(s) : sort.key === 'start' ? s.start : (s[sort.key] as number | string)
    out.sort((a, b) => {
      const x = val(a)
      const y = val(b)
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
      return sort.desc ? -c : c
    })
    return out
  }, [sessions, q, filters, sort])

  const toggleFilter = (k: keyof typeof filters, v: string) =>
    setFilters((f) => {
      const next = new Set(f[k])
      next.has(v) ? next.delete(v) : next.add(v)
      return { ...f, [k]: next }
    })
  const activeFilters = Object.values(filters).reduce((a, s) => a + s.size, 0)

  const Head = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <TableHead className={className}>
      <button
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => setSort((s) => ({ key: k, desc: s.key === k ? !s.desc : true }))}
      >
        {children}
        {sort.key === k && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
      </button>
    </TableHead>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search titles, prompts, projects…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Filter /> Filters {activeFilters > 0 && <Badge className="ml-1 h-4 px-1.5">{activeFilters}</Badge>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-96 w-64 overflow-y-auto">
            {(['project', 'model', 'tag', 'source'] as const).map((k, i) =>
              options[k].length > (k === 'source' ? 1 : 0) ? (
                <div key={k}>
                  {i > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="capitalize">{k}</DropdownMenuLabel>
                  {options[k].map((v) => (
                    <DropdownMenuCheckboxItem
                      key={v}
                      checked={filters[k].has(v)}
                      onCheckedChange={() => toggleFilter(k, v)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      {k === 'model' ? modelLabel(v, labels) : v}
                    </DropdownMenuCheckboxItem>
                  ))}
                </div>
              ) : null,
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {activeFilters > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilters({ project: new Set(), model: new Set(), tag: new Set(), source: new Set() })}
          >
            Clear
          </Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {rows.length} of {sessions.length} sessions
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <Head k="start">Date</Head>
              <Head k="title">Session</Head>
              <Head k="project">Project</Head>
              <TableHead>Models</TableHead>
              <TableHead>Purpose</TableHead>
              <Head k="activeSeconds" className="text-right">Active</Head>
              <Head k="userPrompts" className="text-right">Prompts</Head>
              <Head k="toolCalls" className="text-right">Tools</Head>
              <Head k="friction" className="text-right">Friction</Head>
              <Head k="cost" className="text-right">Cost</Head>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, limit).map((s) => (
              <TableRow key={`${s.source}/${s.id}`} className="cursor-pointer" onClick={() => navigate(sessionHref(s.id, s.title))}>
                <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground">{dateTime(s.start)}</TableCell>
                <TableCell className="max-w-[22rem]">
                  <div className="truncate font-medium">{s.title}</div>
                  {s.firstPrompt && s.firstPrompt !== s.title && (
                    <div className="truncate text-xs text-muted-foreground">{s.firstPrompt}</div>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {s.project}
                  {options.source.length > 1 && <div className="text-xs text-muted-foreground">{s.source}</div>}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {s.models.map((m) => (
                      <Badge key={m} variant="outline" className="font-normal">
                        {modelLabel(m, labels)}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <TagEditor
                      compact
                      sessionId={s.id}
                      tags={s.tags}
                      vocabulary={vocabulary}
                      onChange={(t) => onUpdate(s.id, { tags: t })}
                      onVocabulary={onVocabulary}
                    />
                    <SuggestionReview
                      compact
                      sessionId={s.id}
                      suggestion={s.suggestion}
                      onResolved={(tags, suggestion) => {
                        onUpdate(s.id, { tags, suggestion })
                        const added = tags.filter((t) => !vocabulary.includes(t))
                        if (added.length) onVocabulary([...vocabulary, ...added])
                      }}
                    />
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{duration(s.activeSeconds)}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">{s.userPrompts}</TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {s.toolCalls}
                  {s.subagents > 0 && <span className="text-muted-foreground"> +{s.subagents}a</span>}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {friction(s) > 0 ? <span className="text-[var(--critical)]">{friction(s)}</span> : <span className="text-muted-foreground">0</span>}
                </TableCell>
                <TableCell className="text-right font-mono text-xs font-medium tabular-nums">{usd(s.cost)}</TableCell>
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                  No sessions match.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {rows.length > limit && (
        <Button variant="outline" size="sm" className="self-center" onClick={() => setLimit((l) => l + 100)}>
          Show more ({rows.length - limit} remaining)
        </Button>
      )}
    </div>
  )
}
