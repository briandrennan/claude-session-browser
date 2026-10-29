import { memo, useState } from 'react'
import { Bot } from 'lucide-react'
import type { AgentInfo, SessionEvent, Usage } from '@/lib/api'
import { time, tokens } from '@/lib/format'
import { cn } from '@/lib/utils'

export const USER = 'user'
export const MAIN = 'main'
export const SYSTEM = 'system'

const PREVIEW_LINES = 4

function lines(s: string) {
  return s.replace(/\s+$/, '').split('\n')
}

function Collapsible({ text, className, previewLines = PREVIEW_LINES }: { text: string; className?: string; previewLines?: number }) {
  const [open, setOpen] = useState(false)
  const all = lines(text)
  const shown = open ? all : all.slice(0, previewLines)
  const hidden = all.length - shown.length
  return (
    <div className={className}>
      <pre className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{shown.join('\n')}</pre>
      {hidden > 0 && (
        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(true)}>
          … +{hidden} lines (click to expand)
        </button>
      )}
      {open && all.length > previewLines && (
        <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>
          collapse
        </button>
      )}
    </div>
  )
}

function UsageNote({ u }: { u: Usage }) {
  const written = u.cacheWrite5m + u.cacheWrite1h
  return (
    <span
      className="font-mono text-[10px] text-muted-foreground/70 tabular-nums"
      title={`input ${u.input} · cache read ${u.cacheRead} · cache write ${written} · output ${u.output} (thinking ${u.thinking})`}
    >
      ↑{tokens(u.input + u.cacheRead + written)} ↓{tokens(u.output)}
    </span>
  )
}

function Dot({ className }: { className?: string }) {
  return <span className={cn('mt-[3px] inline-block size-2 shrink-0 rounded-full', className)} aria-hidden />
}

type RowProps = {
  e: SessionEvent
  agent?: AgentInfo
  agentColor?: string
  showThinking: boolean
  onOpenAgent: (id: string) => void
}

export const TranscriptRow = memo(function TranscriptRow({ e, agent, agentColor, showThinking, onOpenAgent }: RowProps) {
  const body = (() => {
    switch (e.kind) {
      case 'prompt':
      case 'command':
        return (
          <div className="rounded-md bg-muted/70 px-3 py-2">
            <div className="flex gap-2 font-mono text-sm">
              <span className="text-muted-foreground select-none">&gt;</span>
              <Collapsible text={e.text ?? ''} previewLines={e.actor === USER ? 40 : 8} className="min-w-0 flex-1 [&_pre]:text-sm" />
            </div>
          </div>
        )
      case 'command_output':
        return (
          <div className="flex gap-2 pl-4 text-muted-foreground">
            <span className="font-mono text-xs select-none">└</span>
            <Collapsible text={e.text ?? ''} className="min-w-0 flex-1" />
          </div>
        )
      case 'interrupt':
        return <div className="pl-4 font-mono text-xs text-[var(--critical)]">└ Interrupted by user</div>
      case 'text':
        return (
          <div className="flex gap-2.5">
            <Dot className="bg-foreground" />
            <div className="min-w-0 flex-1 text-sm leading-relaxed break-words whitespace-pre-wrap">{e.text}</div>
          </div>
        )
      case 'thinking':
        if (!showThinking) return null
        return (
          <div className="flex gap-2 text-xs text-muted-foreground italic">
            <span className="select-none">✻</span>
            {e.text ? <Collapsible text={e.text} previewLines={3} className="min-w-0 flex-1 [&_pre]:font-sans" /> : <span>Thinking…</span>}
          </div>
        )
      case 'tool_use': {
        const r = e.result
        const status = !r ? 'pending' : r.kind === 'rejected' ? 'rejected' : r.isError ? 'error' : 'ok'
        return (
          <div className="flex flex-col gap-1">
            <div className="flex gap-2.5">
              <Dot
                className={cn(
                  status === 'ok' && 'bg-[var(--good)]',
                  status === 'error' && 'bg-[var(--critical)]',
                  status === 'rejected' && 'bg-[var(--warning)]',
                  status === 'pending' && 'bg-muted-foreground',
                )}
              />
              <div className="min-w-0 flex-1 font-mono text-sm break-all">
                <span className="font-semibold">{e.tool}</span>
                {e.summary && <span className="text-muted-foreground">({e.summary})</span>}
                {e.agentLink && (
                  <button
                    onClick={() => onOpenAgent(e.agentLink!)}
                    className="ml-2 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-sans text-xs hover:bg-muted"
                  >
                    <Bot className="size-3" /> view agent transcript
                  </button>
                )}
              </div>
            </div>
            {r && (
              <div className={cn('flex gap-2 pl-4', status === 'error' ? 'text-[var(--critical)]' : 'text-muted-foreground')}>
                <span className="font-mono text-xs select-none">└</span>
                {status === 'rejected' ? (
                  <span className="font-mono text-xs text-[var(--serious)]">User rejected this call</span>
                ) : (
                  <div className="min-w-0 flex-1">
                    <Collapsible text={r.text || '(no output)'} />
                    {r.chars > 2000 && <div className="font-mono text-[10px]">≈{tokens(r.chars / 4)} tokens of output</div>}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      }
      case 'compact':
        return <SystemLine label="context compacted" text={e.text} />
      case 'notification':
        return <SystemLine label="notification" text={e.text} />
      case 'meta':
        return <SystemLine label="injected context" text={e.text} />
      case 'attachment':
        return <SystemLine label={`attachment · ${e.tool}`} text={e.text} />
      case 'system':
        return <SystemLine label={e.tool || 'system'} text={e.text} critical={e.tool === 'api_error'} />
      default:
        return null
    }
  })()
  if (!body) return null

  return (
    <div id={`ev-${e.uuid}`} className="group relative scroll-mt-28 py-1.5" data-actor={e.actor}>
      <div className={cn('flex gap-3', agent && 'border-l-2 pl-3')} style={agent ? { borderColor: agentColor } : undefined}>
        <div className="min-w-0 flex-1">
          {agent && (e.kind === 'prompt' || e.kind === 'command') && (
            // Text wears text tokens; the series color rides on a swatch beside it (and the rule).
            <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <span className="size-2 shrink-0 rounded-full" style={{ background: agentColor }} aria-hidden />
              <Bot className="size-3" /> {agent.type} · {agent.description}
            </div>
          )}
          {body}
        </div>
        <div className="flex w-24 shrink-0 flex-col items-end gap-0.5 pt-0.5 opacity-60 group-hover:opacity-100">
          <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{time(e.t)}</span>
          {e.usage && <UsageNote u={e.usage} />}
        </div>
      </div>
    </div>
  )
})

function SystemLine({ label, text, critical }: { label: string; text?: string; critical?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn('text-xs', critical ? 'text-[var(--critical)]' : 'text-muted-foreground/80')}>
      <button className="font-mono hover:text-foreground" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} {label}
      </button>
      {open && text && (
        <pre className="mt-1 max-h-80 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] break-words whitespace-pre-wrap">{text}</pre>
      )}
    </div>
  )
}
