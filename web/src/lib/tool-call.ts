import { useCallback, useState } from 'react'
import { api, type SessionEvent, type ToolCallFull } from '@/lib/api'

export type CallStatus = 'ok' | 'error' | 'rejected' | 'pending'

export const callStatus = (e: SessionEvent): CallStatus => {
  const r = e.result
  return !r ? 'pending' : r.kind === 'rejected' ? 'rejected' : r.isError ? 'error' : 'ok'
}

export const statusBg: Record<CallStatus, string> = {
  ok: 'bg-[var(--good)]',
  error: 'bg-[var(--critical)]',
  rejected: 'bg-[var(--warning)]',
  pending: 'bg-muted-foreground',
}

export type FullCall = { data?: ToolCallFull; loading: boolean; error?: string; load: () => void; canLoad: boolean }

// Fetches the uncut input/output once and keeps it in component state.
export function useFullCall(sessionId: string, toolId?: string): FullCall {
  const [state, setState] = useState<{ data?: ToolCallFull; loading: boolean; error?: string }>({ loading: false })
  const { data, loading } = state
  const load = useCallback(() => {
    if (!toolId || data || loading) return
    setState({ loading: true })
    api.toolCall(sessionId, toolId).then(
      (d) => setState({ data: d, loading: false }),
      (err: Error) => setState({ loading: false, error: err.message }),
    )
  }, [sessionId, toolId, data, loading])
  return { ...state, load, canLoad: !!toolId }
}

export function toggled<T>(s: Set<T>, k: T) {
  const n = new Set(s)
  if (!n.delete(k)) n.add(k)
  return n
}

// Redacted exports often carry `{}`; treat that like no input.
export const hasInput = (v: unknown) => v != null && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)
