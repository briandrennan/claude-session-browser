import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type SearchCall, type SearchResult, type SessionEvent } from '@/lib/api'

const MAX_BRACE_EXPANSIONS = 64

class GlobError extends Error {}

// Expands `{a,b}` alternation (nested too). Unbalanced braces are taken literally. Backslash escapes
// and `[...]` classes are skipped over, so `\{` and `[{]` stay literal.
function expandBraces(g: string): string[] {
  let open = -1
  let depth = 0
  let close = -1
  const commas: number[] = []
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '\\') i++
    else if (c === '[') {
      const j = g.indexOf(']', i + 2)
      if (j > 0) i = j
    } else if (c === '{') {
      if (depth++ === 0) open = i
    } else if (c === '}' && depth > 0 && --depth === 0) {
      close = i
      break
    } else if (c === ',' && depth === 1) commas.push(i)
  }
  if (open < 0 || close < 0) return [g]
  const pre = g.slice(0, open)
  const alts: string[] = []
  let from = open + 1
  for (const c of [...commas, close]) {
    alts.push(g.slice(from, c))
    from = c + 1
  }
  const tails = expandBraces(g.slice(close + 1))
  const out: string[] = []
  for (const alt of alts)
    for (const a of expandBraces(alt))
      for (const t of tails) {
        out.push(pre + a + t)
        if (out.length > MAX_BRACE_EXPANSIONS) throw new GlobError(`more than ${MAX_BRACE_EXPANSIONS} brace alternatives`)
      }
  return out
}

type Tok =
  | { k: 'lit'; c: string }
  | { k: 'any' } // ?  (one char, not `/`)
  | { k: 'star' } // *  (any run of chars except `/`)
  | { k: 'deep' } // ** (any run of chars)
  | { k: 'dirs' } // **/ (zero or more directories)
  | { k: 'set'; neg: boolean; items: [string, string][] }

// Parses one brace-free glob. Returns the tokens and whether the glob had any wildcard.
function tokenize(g: string): { toks: Tok[]; wild: boolean } {
  const toks: Tok[] = []
  let wild = false
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '\\') toks.push({ k: 'lit', c: i + 1 < g.length ? g[++i] : '\\' })
    else if (c === '*') {
      wild = true
      let j = i
      while (g[j + 1] === '*') j++
      if (j === i) toks.push({ k: 'star' })
      else if (g[j + 1] === '/') {
        toks.push({ k: 'dirs' })
        j++
      } else toks.push({ k: 'deep' })
      i = j
    } else if (c === '?') {
      wild = true
      toks.push({ k: 'any' })
    } else if (c === '[') {
      wild = true
      let j = i + 1
      const neg = g[j] === '!' || g[j] === '^'
      if (neg) j++
      const items: [string, string][] = []
      let closed = false
      for (let first = true; j < g.length; j++, first = false) {
        let ch = g[j]
        if (ch === ']' && !first) {
          closed = true
          break
        }
        if (ch === '\\' && j + 1 < g.length) ch = g[++j]
        if (g[j + 1] === '-' && j + 2 < g.length && g[j + 2] !== ']') {
          let hi = g[j + 2]
          j += 2
          if (hi === '\\' && j + 1 < g.length) hi = g[++j]
          if (hi < ch) throw new GlobError(`reversed range ${ch}-${hi} in [...]`)
          items.push([ch, hi])
        } else items.push([ch, ch])
      }
      if (!closed) throw new GlobError('unterminated [')
      toks.push({ k: 'set', neg, items })
      i = j
    } else toks.push({ k: 'lit', c })
  }
  return { toks, wild }
}

// Does toks match all of s? Iterative DP over (token, position), O(tokens x chars) with no backtracking,
// so patterns like `*a*a*a*a*b` stay fast.
function matchToks(toks: Tok[], s: string): boolean {
  const m = s.length
  let next = new Uint8Array(m + 2)
  next[m] = 1 // empty token list matches only the end of s
  let cur = new Uint8Array(m + 2)
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i]
    cur.fill(0)
    // h: some k > j with s[k-1] === '/' and next[k] (for `**/`), computed right to left.
    let h = 0
    for (let j = m; j >= 0; j--) {
      let ok = 0
      const ch = j < m ? s[j] : ''
      switch (t.k) {
        case 'lit':
          ok = j < m && ch === t.c ? next[j + 1] : 0
          break
        case 'any':
          ok = j < m && ch !== '/' ? next[j + 1] : 0
          break
        case 'set': {
          if (j < m && ch !== '/') {
            const hit = t.items.some(([lo, hi]) => ch >= lo && ch <= hi)
            ok = hit !== t.neg ? next[j + 1] : 0
          }
          break
        }
        case 'star':
          ok = next[j] || (j < m && ch !== '/' ? cur[j + 1] : 0)
          break
        case 'deep':
          ok = next[j] || (j < m ? cur[j + 1] : 0)
          break
        case 'dirs':
          h = j < m ? ((ch === '/' && next[j + 1]) || h ? 1 : 0) : 0
          ok = next[j] || h
          break
      }
      cur[j] = ok
    }
    ;[next, cur] = [cur, next]
  }
  return next[0] === 1
}

export type Glob = { test: (path: string) => boolean }

// Compiles a glob (case-sensitive) or throws a GlobError-style Error with a readable message.
// `**` matches across `/` (`**/` matches zero or more directories), `*` and `?` stay within a path
// segment, plus `{a,b}`, `[...]`/`[!...]` and `\` escapes. A pattern without `/` matches the basename or the
// whole path; a relative pattern with `/` (not starting with `**`) matches the whole path or any suffix
// that starts after a `/`. A pattern with no wildcard, or ending in `/`, also matches everything
// beneath it (`internal` matches `/h/internal/a.go` by whole segment, never `xinternal`).
export function compileGlob(glob: string): Glob {
  const alts: Tok[][] = []
  for (const g of expandBraces(glob)) {
    const { toks, wild } = tokenize(g)
    const base = g.startsWith('/') || g.startsWith('**') ? toks : [{ k: 'dirs' } as Tok, ...toks]
    if (g.endsWith('/') && !g.endsWith('\\/')) alts.push([...base, { k: 'deep' }])
    else if (!wild) {
      alts.push(base)
      alts.push([...base, { k: 'lit', c: '/' }, { k: 'deep' }])
    } else alts.push(base)
  }
  return { test: (path) => alts.some((t) => matchToks(t, path)) }
}

export function matchGlob(glob: string, path: string): boolean {
  return compileGlob(glob).test(path)
}

// Splits on commas (outside braces/brackets) and whitespace.
export function splitGlobs(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  let inClass = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\' && i + 1 < text.length) {
      cur += c + text[++i]
      continue
    }
    if (inClass) inClass = c !== ']'
    else if (c === '[') inClass = true
    else if (c === '{') depth++
    else if (c === '}' && depth > 0) depth--
    if ((c === ',' && depth === 0 && !inClass) || (/\s/.test(c) && depth === 0 && !inClass)) {
      if (cur) out.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur) out.push(cur)
  return out
}

export type SearchEngine = 'auto' | 'go'
export type CaseMode = 'smart' | 'insensitive' | 'sensitive'
export type Scope = 'both' | 'input' | 'output'

const ENGINE_KEY = 'csb.searchEngine'

function loadEngine(): SearchEngine {
  try {
    return localStorage.getItem(ENGINE_KEY) === 'go' ? 'go' : 'auto'
  } catch {
    return 'auto'
  }
}

export type SearchStatus = { state: 'idle' } | { state: 'searching' } | { state: 'done'; engine: string; total: number; truncated: boolean } | { state: 'error'; message: string }

export type ToolFilter = {
  glob: string
  setGlob: (v: string) => void
  // Set when a glob can't be compiled; such globs are ignored until corrected.
  globError?: string
  cmdPaths: boolean
  setCmdPaths: (v: boolean) => void
  query: string
  setQuery: (v: string) => void
  caseMode: CaseMode
  setCaseMode: (v: CaseMode) => void
  scope: Scope
  setScope: (v: Scope) => void
  literal: boolean
  setLiteral: (v: boolean) => void
  engine: SearchEngine
  setEngine: (v: SearchEngine) => void
  searchNow: () => void
  status: SearchStatus
  active: boolean
  // Identifies the current set of matching calls; changes when it does (used to reset paging).
  matchKey: string
  passes: (e: SessionEvent) => boolean
  calls: SessionEvent[]
  totalCalls: number
  hits: (e: SessionEvent) => SearchCall | undefined
  clear: () => void
}

type Done = { key: string; data?: SearchResult; error?: string }

// One filter shared by the Tools and Conversation tabs: glob over the paths the server extracted from
// each call, ANDed with a debounced content search done by the server.
export function useToolFilter(sessionId: string, events: SessionEvent[]): ToolFilter {
  const [glob, setGlob] = useState('')
  const [appliedGlob, setAppliedGlob] = useState('')
  const [cmdPaths, setCmdPaths] = useState(false)
  const [query, setQueryState] = useState('')
  const [caseMode, setCaseMode] = useState<CaseMode>('smart')
  const [scope, setScope] = useState<Scope>('both')
  const [literal, setLiteral] = useState(false)
  const [engine, setEngineState] = useState<SearchEngine>(loadEngine)
  const setEngine = useCallback((v: SearchEngine) => {
    setEngineState(v)
    try {
      localStorage.setItem(ENGINE_KEY, v)
    } catch {
      // Private mode: the choice just doesn't persist.
    }
  }, [])

  const q = query.trim() ? query : ''
  const reqKey = q ? JSON.stringify([q, caseMode, scope, literal, engine]) : ''
  const [submitted, setSubmitted] = useState('')
  const [done, setDone] = useState<Done>()
  const setQuery = useCallback((v: string) => {
    setQueryState(v)
    // An emptied search forgets its old result and any request in flight, so the next query starts
    // fresh, even if it repeats the last one.
    if (!v.trim()) {
      setDone(undefined)
      setSubmitted('')
    }
  }, [])

  useEffect(() => {
    if (reqKey === submitted) return
    const t = setTimeout(() => setSubmitted(reqKey), 300)
    return () => clearTimeout(t)
  }, [reqKey, submitted])

  // The glob input stays responsive; matching uses the value from 150 ms after the last keystroke.
  useEffect(() => {
    if (glob === appliedGlob) return
    const t = setTimeout(() => setAppliedGlob(glob), 150)
    return () => clearTimeout(t)
  }, [glob, appliedGlob])

  useEffect(() => {
    if (!submitted) return
    const [sq, sc, ss, sl, se] = JSON.parse(submitted) as [string, CaseMode, Scope, boolean, SearchEngine]
    const ctl = new AbortController()
    // "auto" sends no engine so the server's configured default (search.engine) applies.
    api.searchTools(sessionId, { q: sq, case: sc, scope: ss, literal: sl, engine: se === 'go' ? 'go' : undefined }, ctl.signal).then(
      (data) => setDone({ key: submitted, data }),
      (err: Error) => {
        if (!ctl.signal.aborted) setDone({ key: submitted, error: err.message })
      },
    )
    return () => ctl.abort()
  }, [sessionId, submitted])

  const searchNow = useCallback(() => setSubmitted(reqKey), [reqKey])

  const { globs, globError } = useMemo(() => {
    const out: Glob[] = []
    let globError: string | undefined
    for (const g of splitGlobs(appliedGlob)) {
      try {
        out.push(compileGlob(g))
      } catch (err) {
        globError ??= `invalid glob "${g}": ${err instanceof Error ? err.message : String(err)}`
      }
    }
    return { globs: out, globError }
  }, [appliedGlob])

  // Last completed result stays in use while a newer search runs, so the list doesn't flash empty.
  const data = done?.data
  const hitsById = useMemo(() => new Map((data?.calls ?? []).map((c) => [c.toolId, c])), [data])
  const searchActive = !!q
  // Until the first result (or error) for a search arrives there is nothing to filter by.
  const searchApplied = searchActive && !!done
  const globActive = globs.length > 0
  const active = searchApplied || globActive
  const settled = !!done && done.key === submitted
  const status = useMemo<SearchStatus>(
    () =>
      !searchActive
        ? { state: 'idle' }
        : done?.error !== undefined && settled && done.key === reqKey
          ? { state: 'error', message: done.error }
          : data && settled && done.key === reqKey
            ? { state: 'done', engine: data.engine, total: data.totalCalls, truncated: data.truncated }
            : { state: 'searching' },
    [searchActive, done, settled, reqKey, data],
  )

  const passes = useCallback(
    (e: SessionEvent) => {
      if (e.kind !== 'tool_use') return true
      if (globActive) {
        const paths = cmdPaths ? [...(e.paths ?? []), ...(e.cmdPaths ?? [])] : (e.paths ?? [])
        if (!globs.some((g) => paths.some((p) => g.test(p)))) return false
      }
      if (searchApplied) return !!e.toolId && hitsById.has(e.toolId)
      return true
    },
    [globActive, globs, cmdPaths, searchApplied, hitsById],
  )

  const calls = useMemo(() => (active ? events.filter((e) => e.kind === 'tool_use' && passes(e)) : []), [active, events, passes])
  const matchKey = useMemo(() => calls.map((e) => e.toolId ?? e.uuid).join('|'), [calls])
  const totalCalls = useMemo(() => events.reduce((n, e) => n + (e.kind === 'tool_use' ? 1 : 0), 0), [events])
  const hits = useCallback((e: SessionEvent) => (searchApplied && e.toolId ? hitsById.get(e.toolId) : undefined), [searchApplied, hitsById])
  const clear = useCallback(() => {
    setGlob('')
    setAppliedGlob('')
    setQuery('')
  }, [setQuery])

  // Memoized so consumers (the Conversation event list) only recompute when the filter really changed.
  return useMemo(
    () => ({
      glob,
      setGlob,
      globError,
      cmdPaths,
      setCmdPaths,
      query,
      setQuery,
      caseMode,
      setCaseMode,
      scope,
      setScope,
      literal,
      setLiteral,
      engine,
      setEngine,
      searchNow,
      status,
      active,
      matchKey,
      passes,
      calls,
      totalCalls,
      hits,
      clear,
    }),
    [glob, globError, cmdPaths, query, setQuery, caseMode, scope, literal, engine, setEngine, searchNow, status, active, matchKey, passes, calls, totalCalls, hits, clear],
  )
}
