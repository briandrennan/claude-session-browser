import { useMemo } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { baseDark, baseLight } from '../../base'
import { usePersisted, useSystemMode } from '../../storage'
import type { Mode, Proposal, Theme, UiToken } from '../../types'

type ModeChoice = Mode | 'system'
type Soften = 0 | 5 | 10 | 15

const MODES: ModeChoice[] = ['light', 'dark', 'system']
const SOFTENS: Soften[] = [0, 5, 10, 15]

const isModeChoice = (v: unknown): v is ModeChoice => MODES.includes(v as ModeChoice)
const isSoften = (v: unknown): v is Soften => SOFTENS.includes(v as Soften)

// Softening rule (the only place it lives). p = percent / 100. Only lightness changes
// (surfaces are neutral grays: chroma 0). Text colors are left alone, so 0% === base.
//   light: page-level surfaces (background, secondary, muted, accent, border, input)
//          go DOWN by 0.5 * p in OKLCH L (15% -> L 1.00 to 0.925). Cards and popovers
//          go down by half that (0.25 * p, 15% -> 0.9625), so they sit slightly ABOVE
//          the page. The original white-on-white relied on a hairline border alone;
//          once the page is tinted, the lift gives layering a second cue.
//   dark:  every surface goes UP by 0.3 * p (15% -> background 0.145 to 0.19, card
//          0.205 to 0.25), keeping the base steps between page, card and muted.
//          Border/input are translucent white and are left as is.
//   text:  foreground is never changed. Dark muted-foreground is unchanged (>= 6:1).
//          Light muted-foreground goes DOWN by 0.5 * p (15% -> 0.481) so it holds >= 4.5:1
//          on the card and page at every step (the base already sits at 4.34 on muted).
const PAGE_KEYS: UiToken[] = ['background', 'secondary', 'muted', 'accent', 'border', 'input']
const CARD_KEYS: UiToken[] = ['card', 'popover']

function soften(mode: Mode, percent: Soften): Theme {
  const base = mode === 'dark' ? baseDark : baseLight
  if (percent === 0) return base
  const p = percent / 100
  const ui = { ...base.ui }
  const move = (keys: UiToken[], dL: number) => {
    for (const k of keys) {
      // base values here are all 'oklch(L 0 0)' or 'oklch(L 0 0 / A)'
      ui[k] = base.ui[k].replace(/^oklch\(([\d.]+)/, (_, l) => `oklch(${+(+l + dL).toFixed(4)}`)
    }
  }
  if (mode === 'dark') {
    move([...PAGE_KEYS.filter((k) => k !== 'border' && k !== 'input'), ...CARD_KEYS], 0.3 * p)
  } else {
    move(PAGE_KEYS, -0.5 * p)
    move(CARD_KEYS, -0.25 * p)
    move(['muted-foreground'], -0.5 * p)
  }
  // Charts reuse the base palettes: validated on the 15% card (#f2f2f2 light, #222222
  // dark) with no hard FAIL and the same worst-pair CVD numbers as the base card
  // (light adjacent #eda100/#1baf7a 9.1 protan, 5.8 tritan; dark #c98500/#199e70 8.4).
  return { ...base, id: `${base.id}-soft-${percent}`, name: `${base.name}, softened ${percent}%`, ui }
}

// Old key held a raw (unquoted) 'light' | 'dark'.
function legacyMode(): ModeChoice {
  try {
    const v = localStorage.getItem('theme')
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* storage unavailable */
  }
  return 'system'
}
const LEGACY_MODE = legacyMode()

function useSettings() {
  const [mode, setMode] = usePersisted<ModeChoice>('theme.basic.mode', LEGACY_MODE, isModeChoice)
  const [percent, setPercent] = usePersisted<Soften>('theme.basic.soften', 0, isSoften)
  return { mode, setMode, percent, setPercent }
}

function useTheme(): Theme {
  const { mode, percent } = useSettings()
  const system = useSystemMode()
  const resolved = mode === 'system' ? system : mode
  return useMemo(() => soften(resolved, percent), [resolved, percent])
}

const MODE_LABEL: Record<ModeChoice, string> = { light: 'Light', dark: 'Dark', system: 'System' }

function Picker() {
  const { mode, setMode, percent, setPercent } = useSettings()
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm">Mode</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          onValueChange={(v) => isModeChoice(v) && setMode(v)}
          className="w-full"
        >
          {MODES.map((m) => (
            <ToggleGroupItem key={m} value={m} className="flex-1">
              {MODE_LABEL[m]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm">Soften</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={String(percent)}
          onValueChange={(v) => v && setPercent(Number(v) as Soften)}
          className="w-full"
        >
          {SOFTENS.map((s) => (
            <ToggleGroupItem key={s} value={String(s)} className="flex-1">
              {s === 0 ? 'Off' : `${s}%`}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-xs text-muted-foreground">Eases the page and card backgrounds. Text stays sharp.</p>
      </div>
    </div>
  )
}

export const basic: Proposal = {
  id: 'basic',
  label: 'Basic',
  description: 'Light and dark, with optional softening of the page and card surfaces.',
  useTheme,
  Picker,
}
