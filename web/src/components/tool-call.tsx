import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { hasInput, statusBg, useFullCall, type CallStatus, type FullCall } from '@/lib/tool-call'
import type { SessionEvent, ToolResult } from '@/lib/api'
import { cn } from '@/lib/utils'

const PREVIEW_LINES = 4
const PREVIEW_CHARS = 4000

function lines(s: string) {
  return s.replace(/\s+$/, '').split('\n')
}

export function Collapsible({
  text,
  className,
  previewLines = PREVIEW_LINES,
  scroll,
}: {
  text: string
  className?: string
  previewLines?: number
  scroll?: boolean
}) {
  const [open, setOpen] = useState(false)
  const all = useMemo(() => lines(text), [text])
  const shown = open ? all : all.slice(0, previewLines)
  const hiddenLines = all.length - shown.length
  const joined = shown.join('\n')
  const clipped = !open && joined.length > PREVIEW_CHARS
  const preview = clipped ? joined.slice(0, PREVIEW_CHARS) + '…' : joined
  const hiddenChars = clipped ? joined.length - PREVIEW_CHARS : 0
  const more = [hiddenLines > 0 && `+${hiddenLines} lines`, hiddenChars > 0 && `+${hiddenChars.toLocaleString()} chars`].filter(Boolean).join(' / ')
  return (
    <div className={className}>
      <pre className={cn('font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap', open && scroll && 'max-h-96 overflow-auto')}>
        {preview}
      </pre>
      {more && (
        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(true)}>
          … {more} (click to expand)
        </button>
      )}
      {open && (all.length > previewLines || text.length > PREVIEW_CHARS) && (
        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>
          collapse
        </button>
      )}
    </div>
  )
}

export function StatusDot({ status }: { status: CallStatus }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', statusBg[status])} title={status} aria-label={status} />
}

function LoadButton({ label, call }: { label: string; call: FullCall }) {
  if (call.data) return null
  if (!call.canLoad) return <span className="text-xs text-muted-foreground">(truncated)</span>
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="xs" disabled={call.loading} onClick={call.load}>
        {call.loading ? 'Loading…' : label}
      </Button>
      {call.error && <span className="text-xs text-[var(--critical)]">{call.error}</span>}
    </div>
  )
}

export function ToolResultView({ r, call, previewLines }: { r: ToolResult; call: FullCall; previewLines?: number }) {
  const full = call.data?.result
  const text = full?.text ?? r.text
  const truncated = full ? !!full.truncated : !!r.truncated
  return (
    <div className="flex flex-col gap-1">
      <Collapsible text={text || '(no output)'} previewLines={previewLines} scroll />
      {truncated && !full && <LoadButton label={`Load full output (${r.chars.toLocaleString()} chars)`} call={call} />}
      {truncated && full && <span className="text-[10px] text-muted-foreground">output truncated at 2 MiB ({full.chars.toLocaleString()} chars total)</span>}
    </div>
  )
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const pretty = (v: unknown) => (typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? String(v)))

function Field({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-28 shrink-0 font-mono text-muted-foreground">{k}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function Value({ v }: { v: unknown }) {
  if (typeof v === 'string') {
    return v.includes('\n') || v.length > 120 ? <Collapsible text={v} previewLines={6} scroll /> : <span className="font-mono [overflow-wrap:anywhere] whitespace-pre-wrap">{v}</span>
  }
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return <span className="font-mono">{String(v)}</span>
  return <pre className="max-h-64 overflow-auto font-mono leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">{pretty(v)}</pre>
}

function Fields({ obj, skip }: { obj: Rec; skip?: string[] }) {
  const entries = Object.entries(obj).filter(([k]) => !skip?.includes(k))
  return (
    <>
      {entries.map(([k, v]) => (
        <Field key={k} k={k}>
          <Value v={v} />
        </Field>
      ))}
    </>
  )
}

function Diff({ oldS, newS }: { oldS: unknown; newS: unknown }) {
  const block = (v: unknown, sign: string, tint: string) =>
    typeof v === 'string' && v !== '' ? (
      <pre className={cn('overflow-x-auto px-2 py-1 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]', tint)}>
        {lines(v)
          .map((l) => `${sign} ${l}`)
          .join('\n')}
      </pre>
    ) : null
  return (
    <div className="max-h-96 overflow-auto rounded border">
      {block(oldS, '−', 'bg-[color-mix(in_oklab,var(--critical)_15%,transparent)]')}
      {block(newS, '+', 'bg-[color-mix(in_oklab,var(--good)_15%,transparent)]')}
    </div>
  )
}

const todoMark: Record<string, string> = { completed: '☑', in_progress: '◐', pending: '☐' }

function InputView({ tool, input }: { tool?: string; input: unknown }) {
  if (!hasInput(input)) return <span className="text-xs text-muted-foreground">(no input)</span>
  if (!isRec(input)) return <Value v={input} />
  switch (tool) {
    case 'Bash':
      return (
        <>
          {typeof input.command === 'string' && (
            <pre className="max-h-96 overflow-auto rounded bg-muted/60 p-2 font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
              <span className="text-muted-foreground select-none">$ </span>
              {input.command}
            </pre>
          )}
          <Fields obj={input} skip={['command']} />
        </>
      )
    case 'Edit':
      return (
        <>
          <Fields obj={input} skip={['old_string', 'new_string']} />
          <Diff oldS={input.old_string} newS={input.new_string} />
        </>
      )
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : []
      return (
        <>
          <Fields obj={input} skip={['edits']} />
          {edits.map((ed, i) =>
            isRec(ed) ? (
              <div key={i} className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground">
                  edit {i + 1}/{edits.length}
                  {ed.replace_all === true && ' · replace_all'}
                </span>
                <Diff oldS={ed.old_string} newS={ed.new_string} />
              </div>
            ) : (
              <Value key={i} v={ed} />
            ),
          )}
        </>
      )
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : null
      if (!todos) break
      return (
        <ul className="flex flex-col gap-0.5 text-xs">
          {todos.map((t, i) => {
            const todo = isRec(t) ? t : {}
            const status = String(todo.status ?? 'pending')
            return (
              <li key={i} className={cn('flex gap-2', status === 'completed' && 'text-muted-foreground line-through')}>
                <span className="font-mono select-none" aria-label={status}>
                  {todoMark[status] ?? '☐'}
                </span>
                <span>{String(todo.content ?? todo.activeForm ?? pretty(t))}</span>
              </li>
            )
          })}
        </ul>
      )
    }
  }
  return <Fields obj={input} />
}

type Parts = 'input' | 'result' | 'both'

export function ToolCallDetail({ e, sessionId, parts = 'both', call }: { e: SessionEvent; sessionId: string; parts?: Parts; call?: FullCall }) {
  const own = useFullCall(sessionId, e.toolId)
  const c = call ?? own
  const input = c.data ? c.data.input : e.input
  const clipped = !c.data && e.inputTruncated
  const raw = clipped && isRec(input) && typeof input._truncated === 'string' ? input._truncated : null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {parts !== 'result' && (
        <>
          {raw !== null ? (
            <>
              <pre className="max-h-96 overflow-auto rounded bg-muted/60 p-2 font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">{raw}</pre>
              <LoadButton label="Load full input" call={c} />
            </>
          ) : (
            <InputView tool={e.tool} input={input} />
          )}
        </>
      )}
      {parts !== 'input' && e.result && <ToolResultView r={e.result} call={c} previewLines={12} />}
      {parts === 'both' && !e.result && <span className="text-xs text-muted-foreground">(no result recorded)</span>}
    </div>
  )
}
