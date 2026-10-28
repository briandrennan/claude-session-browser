export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  thinking: number
  webSearches: number
  messages: number
}

export type Summary = {
  id: string
  source: string
  project: string
  cwd: string
  title: string
  firstPrompt: string
  start: string
  end: string
  activeSeconds: number
  version: string
  gitBranch: string
  entrypoint: string
  models: string[]
  usage: Usage
  cost: number
  unpricedModel?: boolean
  userPrompts: number
  toolCalls: number
  toolErrors: number
  interrupts: number
  rejections: number
  compactions: number
  subagents: number
  skills: string[]
  tags: string[]
  note?: string
  suggestion?: Suggestion
}

export type Suggestion = {
  tags: string[]
  newTag?: string
  rationale: string
  model: string
  at: string
  cost: number
  error?: string
  status: 'pending' | 'accepted' | 'dismissed' | 'error'
}

export type ClassifierStatus = {
  enabled: boolean
  auto: boolean
  model: string
  disabled?: string
  queued: number
  running: number
  done: number
  failed: number
  cost: number
  lastError?: string
}

export type PriceRow = {
  match: string
  label: string
  from?: string
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  longAbove?: number
  longInput?: number
  longOutput?: number
  fastMultiplier?: number
  geoMultipliers?: Record<string, number>
  note?: string
}

export type PricingCheck = {
  checkedAt: string
  changes: { kind: 'changed' | 'new'; match: string; label: string; old?: PriceRow; new: PriceRow }[]
  error?: string
}

export type PricingInfo = {
  table: { path: string; models: PriceRow[]; webSearchPer1k: { from?: string; price: number }[] }
  seen: { model: string; label: string; priced: boolean }[]
  check?: PricingCheck
  pageUrl: string
}

export type ToolResult = { text: string; chars: number; isError: boolean; kind?: string }

export type SessionEvent = {
  uuid: string
  t: string
  actor: string
  kind: string
  text?: string
  truncated?: boolean
  tool?: string
  toolId?: string
  summary?: string
  input?: unknown
  result?: ToolResult
  model?: string
  usage?: Usage
  agentLink?: string
}

export type AgentInfo = {
  id: string
  parentId?: string
  type: string
  description: string
  prompt?: string
  models: string[] | null
  background: boolean
  start: string
  end: string
  toolCalls: number
  toolErrors: number
  usage: Usage
  cost: number
  toolUseId?: string
}

export type ToolStat = {
  name: string
  group: string
  calls: number
  errors: number
  rejected: number
  inputTokensEst: number
  resultTokensEst: number
  subagentCost?: number
  subagentTokens?: number
  byActor: Record<string, number>
}

export type SkillUse = {
  name: string
  kind: 'skill' | 'command'
  count: number
  uses: { t: string; actor: string; args?: string; uuid: string }[]
}

export type MemoryUse = { path: string; kind: string; ops: Record<string, number>; tokensEst: number; first: string }

export type Insight = {
  kind: string
  severity: 'info' | 'warn' | 'bad'
  title: string
  detail: string
  count: number
  events?: string[]
}

export type SessionDetail = {
  summary: Summary
  main: AgentInfo
  events: SessionEvent[]
  agents: AgentInfo[]
  tools: ToolStat[]
  skills: SkillUse[]
  memories: MemoryUse[]
  insights: Insight[]
  models: { model: string; usage: Usage; cost: number; rates: string[] }[]
  suggestion?: Suggestion
}

export type UsageRow = { bucket: string; group: string; cost: number; usage: Usage; sessions: number }
export type UsageResult = { buckets: string[]; rows: UsageRow[] }

export type Meta = {
  tags: string[]
  sources: string[]
  modelLabels: Record<string, string>
  classifier: ClassifierStatus
  pricingCheck?: PricingCheck
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json()
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export type Range = { from: Date; to: Date }

const rangeParams = (r: Range) => `from=${encodeURIComponent(r.from.toISOString())}&to=${encodeURIComponent(r.to.toISOString())}`

export const api = {
  meta: () => req<Meta>('/api/meta'),
  sessions: (r: Range) => req<Summary[]>(`/api/sessions?${rangeParams(r)}`),
  session: (id: string) => req<SessionDetail>(`/api/sessions/${id}`),
  usage: (r: Range, group: string) =>
    req<UsageResult>(`/api/usage?${rangeParams(r)}&group=${group}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`),
  setEnrichment: (id: string, tags: string[], note = '') =>
    req<{ tags: string[]; note: string; suggestion?: Suggestion }>(`/api/sessions/${id}/enrichment`, json('PUT', { tags, note })),
  resolveSuggestion: (id: string, action: 'accept' | 'dismiss') =>
    req<{ tags: string[]; note: string; suggestion?: Suggestion }>(`/api/sessions/${id}/suggestion/${action}`, { method: 'POST' }),
  classify: (body: { ids?: string[]; from?: string; to?: string }) =>
    req<{ queued: number; status: ClassifierStatus }>('/api/classify', json('POST', body)),
  classifyStatus: () => req<ClassifierStatus>('/api/classify'),
  pricing: () => req<PricingInfo>('/api/pricing'),
  checkPricing: () => req<PricingCheck>('/api/pricing/check', { method: 'POST' }),
  addTag: (tag: string) => req<string[]>('/api/tags', json('POST', { tag })),
  deleteTag: (tag: string) => req<string[]>(`/api/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' }),
}

export const totalTokens = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
export const promptTokens = (u: Usage) => u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
