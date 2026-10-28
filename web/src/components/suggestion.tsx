import { useEffect, useRef, useState } from 'react'
import { Check, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, type ClassifierStatus, type Suggestion } from '@/lib/api'
import { usd } from '@/lib/format'
import { cn } from '@/lib/utils'

type ReviewProps = {
  sessionId: string
  suggestion?: Suggestion
  onResolved: (tags: string[], suggestion?: Suggestion) => void
  compact?: boolean
}

// Pending model suggestion with accept / dismiss.
export function SuggestionReview({ sessionId, suggestion, onResolved, compact }: ReviewProps) {
  if (!suggestion || suggestion.status !== 'pending') return null
  const resolve = async (action: 'accept' | 'dismiss') => {
    const res = await api.resolveSuggestion(sessionId, action)
    onResolved(res.tags, res.suggestion)
  }
  const tags = [...suggestion.tags, ...(suggestion.newTag ? [suggestion.newTag] : [])]
  const chips = tags.map((t) => (
    <span
      key={t}
      className={cn(
        'rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground',
        t === suggestion.newTag && 'border-[var(--series-7)] text-[var(--series-7)]',
      )}
    >
      {t === suggestion.newTag ? `+ ${t}` : t}
    </span>
  ))
  const buttons = (
    <>
      <Button variant="ghost" size="icon-xs" aria-label="Accept suggestion" onClick={() => resolve('accept')}>
        <Check className="text-[var(--good)]" />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss suggestion" onClick={() => resolve('dismiss')}>
        <X />
      </Button>
    </>
  )
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Sparkles className="size-3 text-[var(--series-7)]" />
            {chips}
            {buttons}
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{suggestion.rationale}</TooltipContent>
      </Tooltip>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm">
      <Sparkles className="size-4 text-[var(--series-7)]" />
      <span className="text-muted-foreground">Suggested</span>
      {chips}
      <span className="text-xs text-muted-foreground">— {suggestion.rationale}</span>
      <span className="ml-auto flex items-center gap-1">
        <span className="font-mono text-[10px] text-muted-foreground">
          {suggestion.model} · {usd(suggestion.cost)}
        </span>
        <Button variant="outline" size="xs" onClick={() => resolve('accept')}>
          <Check /> Accept
        </Button>
        <Button variant="ghost" size="xs" onClick={() => resolve('dismiss')}>
          Dismiss
        </Button>
      </span>
    </div>
  )
}

// Polls classifier status while work is queued or running.
export function useClassifier(initial?: ClassifierStatus, onIdle?: () => void) {
  const [status, setStatus] = useState(initial)
  const busy = !!status && status.queued + status.running > 0
  const idleRef = useRef(onIdle)
  idleRef.current = onIdle
  useEffect(() => setStatus(initial), [initial])
  useEffect(() => {
    if (!busy) return
    const t = setInterval(async () => {
      const s = await api.classifyStatus()
      setStatus(s)
      if (s.queued + s.running === 0) idleRef.current?.()
    }, 1500)
    return () => clearInterval(t)
  }, [busy])
  return { status, setStatus, busy }
}

type ButtonProps = {
  label: string
  request: () => Promise<{ status: ClassifierStatus }>
  status?: ClassifierStatus
  onDone: () => void
  disabled?: boolean
}

export function ClassifyButton({ label, request, status: initial, onDone, disabled }: ButtonProps) {
  const { status, setStatus, busy } = useClassifier(initial, onDone)
  const [error, setError] = useState<string>()
  const unavailable = status?.disabled
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || busy || !!unavailable}
        onClick={async () => {
          setError(undefined)
          try {
            const res = await request()
            setStatus(res.status)
            if (res.status.queued + res.status.running === 0) onDone()
          } catch (e) {
            setError((e as Error).message)
          }
        }}
      >
        <Sparkles className="text-[var(--series-7)]" />
        {busy ? `Classifying… ${status!.done} done, ${status!.queued + status!.running} left` : label}
      </Button>
      {status && status.cost > 0 && <span className="font-mono text-xs text-muted-foreground">spent {usd(status.cost)}</span>}
      {(error || unavailable) && <span className="max-w-md text-xs text-[var(--critical)]">{error || unavailable}</span>}
    </div>
  )
}
