import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { DISTINCT_MAX } from '@/lib/palette'
import { PROPOSALS } from './proposals'
import { usePersisted } from './storage'
import { UI_TOKENS, type ChartMode, type Proposal, type Theme } from './types'

// Key read by the pre-paint script in index.html, so a reload starts in the last theme.
const PAINT_KEY = 'theme.paint'

export function applyTheme(t: Theme, remember = true) {
  const root = document.documentElement
  const vars: Record<string, string> = {}
  for (const k of UI_TOKENS) vars[`--${k}`] = t.ui[k]
  for (let i = 0; i < DISTINCT_MAX; i++) {
    const c = t.chart.categorical[i]
    if (c) vars[`--series-${i + 1}`] = c
    else root.style.removeProperty(`--series-${i + 1}`)
  }
  vars['--series-other'] = t.chart.other
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  root.classList.toggle('dark', t.mode === 'dark')
  root.style.colorScheme = t.mode
  if (!remember) return
  try {
    localStorage.setItem(PAINT_KEY, JSON.stringify({ mode: t.mode, vars }))
  } catch {
    /* storage unavailable */
  }
}

type Ctx = {
  proposal: Proposal
  setProposal: (id: string) => void
  // The committed theme, ignoring any live preview.
  theme: Theme
  // What is on screen right now: the preview if one is active, else `theme`.
  shown: Theme
  // Live preview (e.g. hovering a theme in a picker); null restores the committed theme.
  setPreview: (t: Theme | null) => void
  chartMode: ChartMode
  setChartMode: (m: ChartMode) => void
}

const ThemeContext = createContext<Ctx | null>(null)

const isProposalId = (v: unknown): v is string => typeof v === 'string' && PROPOSALS.some((p) => p.id === v)
const isChartMode = (v: unknown): v is ChartMode => v === 'categorical' || v === 'tonal'

// Runs the active proposal's hook. Remounted (via key) when the proposal changes, so
// each proposal's hook order is stable.
function ProposalBridge({ proposal, onTheme }: { proposal: Proposal; onTheme: (t: Theme) => void }) {
  const t = proposal.useTheme()
  useLayoutEffect(() => onTheme(t), [t, onTheme])
  return null
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [proposalId, setProposal] = usePersisted('theme-lab.proposal', PROPOSALS[0].id, isProposalId)
  const [chartMode, setChartMode] = usePersisted<ChartMode>('chart-mode', 'categorical', isChartMode)
  const [theme, setTheme] = useState<Theme | null>(null)
  const [preview, setPreview] = useState<Theme | null>(null)
  const proposal = PROPOSALS.find((p) => p.id === proposalId) ?? PROPOSALS[0]
  const shown = preview ?? theme

  useLayoutEffect(() => {
    // Previews are not remembered for the next page load; only committed themes are.
    if (shown) applyTheme(shown, shown === theme)
  }, [shown, theme])

  const value = useMemo(
    () =>
      shown && theme ? { proposal, setProposal, theme, shown, setPreview, chartMode, setChartMode } : null,
    [proposal, setProposal, theme, shown, chartMode, setChartMode],
  )

  return (
    <>
      <ProposalBridge key={proposal.id} proposal={proposal} onTheme={setTheme} />
      {value && <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>}
    </>
  )
}

export function useThemeContext() {
  const c = useContext(ThemeContext)
  if (!c) throw new Error('useThemeContext outside ThemeProvider')
  return c
}
