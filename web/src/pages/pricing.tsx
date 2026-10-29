import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useFetch } from '@/hooks/use-fetch'
import { api, type PriceRow, type PricingCheck } from '@/lib/api'
import { dateTime } from '@/lib/format'

const p = (n?: number) =>
  n === undefined ? '–' : `$${n >= 1 && Number.isInteger(n) ? n : n.toFixed(Math.round(n * 1000) % 10 ? 3 : 2)}`

const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku']
// Newest family members first: Opus 5.5, Opus 5, Opus 4.8, …
function rowOrder(match: string) {
  const family = FAMILIES.findIndex((f) => match.includes(f))
  const version = Number((match.match(/\d+(-\d+)?/)?.[0] ?? '0').replace('-', '.'))
  const v = match.startsWith('claude-3') ? Number(match.slice(7, 10).replace('-', '.')) : version
  return [family < 0 ? 99 : family, -v] as const
}

export function PricingPage() {
  const info = useFetch(() => api.pricing(), [])
  const [check, setCheck] = useState<PricingCheck>()
  const [checking, setChecking] = useState(false)
  const current = check ?? info.data?.check

  // Group rows by match; newest first within each model.
  const groups = useMemo(() => {
    const m = new Map<string, PriceRow[]>()
    for (const r of info.data?.table.models ?? []) m.set(r.match, [...(m.get(r.match) ?? []), r])
    return [...m.entries()].sort(([a], [b]) => {
      const [fa, va] = rowOrder(a)
      const [fb, vb] = rowOrder(b)
      return fa - fb || va - vb
    })
  }, [info.data])
  const seen = info.data?.seen ?? []
  const unpriced = seen.filter((s) => !s.priced)

  if (!info.data) return <Skeleton className="h-96" />
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pricing</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every API response is priced at the list price in effect at its timestamp, from{' '}
          <code className="font-mono text-xs">{info.data.table.path}</code>. When prices change, a new dated row is appended rather than
          editing history, so past usage keeps its original cost. Costs are undiscounted list prices.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Change detection</CardTitle>
            <CardDescription>
              The server compares the table with{' '}
              <a href={info.data.pageUrl.replace(/\.md$/, '')} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                the pricing page <ExternalLink className="size-3" />
              </a>{' '}
              daily. Record changes with <code className="font-mono text-xs">csb pricing check -write</code>.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={checking}
            onClick={async () => {
              setChecking(true)
              try {
                setCheck(await api.checkPricing())
              } finally {
                setChecking(false)
              }
            }}
          >
            <RefreshCw className={checking ? 'animate-spin' : ''} /> Check now
          </Button>
        </CardHeader>
        <CardContent className="text-sm">
          {!current ? (
            <p className="text-muted-foreground">Not checked yet.</p>
          ) : current.error ? (
            <p className="text-[var(--critical)]">Check failed: {current.error}</p>
          ) : current.changes.length === 0 ? (
            <p className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-[var(--good)]" /> Table matches the pricing page (checked {dateTime(current.checkedAt)}).
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-2">
                <AlertTriangle className="size-4 text-[var(--serious)]" /> {current.changes.length} difference(s) found {dateTime(current.checkedAt)}:
              </p>
              <ul className="ml-6 list-disc font-mono text-xs">
                {current.changes.map((c) => (
                  <li key={c.match}>
                    {c.kind === 'new' ? 'new model' : 'changed'} {c.match}: in {p(c.old?.input)}→{p(c.new.input)}, out {p(c.old?.output)}→{p(c.new.output)},
                    cache read {p(c.old?.cacheRead)}→{p(c.new.cacheRead)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {unpriced.length > 0 && (
        <Card className="border-[var(--serious)]">
          <CardHeader>
            <CardTitle>Unpriced models in your data</CardTitle>
            <CardDescription>These model ids match no row, so their usage counts as $0. Add rows to the table.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {unpriced.map((s) => (
              <Badge key={s.model} variant="outline" className="font-mono">
                {s.model}
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Rate table</CardTitle>
          <CardDescription>USD per million tokens. Rows without a date apply from the beginning. Models seen in your transcripts are marked.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Cache write 5m</TableHead>
                <TableHead className="text-right">Cache write 1h</TableHead>
                <TableHead className="text-right">Cache read</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead>Modifiers</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.flatMap(([match, rows]) =>
                rows.map((r, i) => {
                  const used = seen.some((s) => s.priced && s.label === rows[0].label)
                  const mods = [
                    r.longAbove ? `>${(r.longAbove / 1000).toFixed(0)}K prompt: ${p(r.longInput)} / ${p(r.longOutput)}` : '',
                    r.fastMultiplier ? `fast ×${r.fastMultiplier}` : '',
                    ...Object.entries(r.geoMultipliers ?? {}).map(([g, m]) => `${g} ×${m}`),
                  ].filter(Boolean)
                  return (
                    <TableRow key={`${match}-${i}`} className={i > 0 ? 'text-muted-foreground' : ''}>
                      <TableCell>
                        {i === 0 && (
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{r.label}</span>
                            {used && <span className="size-1.5 rounded-full bg-[var(--sequential)]" title="seen in your transcripts" />}
                          </div>
                        )}
                        {i === 0 && <div className="font-mono text-[10px] text-muted-foreground">{match}*</div>}
                      </TableCell>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        {r.from ? `from ${r.from}` : 'since launch'}
                        {i > 0 && ' (superseded)'}
                      </TableCell>
                      {[r.input, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead, r.output].map((v, k) => (
                        <TableCell key={k} className="text-right font-mono text-xs tabular-nums">
                          {p(v)}
                        </TableCell>
                      ))}
                      <TableCell className="text-xs text-muted-foreground">{mods.join(' · ')}</TableCell>
                    </TableRow>
                  )
                }),
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
