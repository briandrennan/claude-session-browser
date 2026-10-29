import { useMemo } from 'react'
import { contrast, hexToOklch, oklchToHex } from '@/lib/color'
import { ACCENTS, CHART, COLORS, FLAVORS, FLAVOR_NAMES, type Accent, type Flavor } from './palette'
import { usePersisted, useSystemMode } from '../../storage'
import type { Theme } from '../../types'

export type Choice = Flavor | 'system'
export type Selection = { choice: Choice; accent: Accent; darkFlavor: Exclude<Flavor, 'latte'> }

const isFlavor = (v: unknown): v is Flavor => FLAVORS.includes(v as Flavor)
const isDark = (v: unknown): v is Selection['darkFlavor'] => isFlavor(v) && v !== 'latte'
const isChoice = (v: unknown): v is Choice => v === 'system' || isFlavor(v)
const isAccent = (v: unknown): v is Accent => ACCENTS.includes(v as Accent)

export function useSelection() {
  const [choice, setChoice] = usePersisted<Choice>('theme.catppuccin.flavor', 'system', isChoice)
  const [accent, setAccent] = usePersisted<Accent>('theme.catppuccin.accent', 'blue', isAccent)
  const [darkFlavor, setDarkFlavor] = usePersisted<Selection['darkFlavor']>(
    'theme.catppuccin.dark-flavor',
    'mocha',
    isDark,
  )
  return { choice, accent, darkFlavor, setChoice, setAccent, setDarkFlavor }
}

export function resolveFlavor(sel: Pick<Selection, 'choice' | 'darkFlavor'>, system: 'light' | 'dark'): Flavor {
  return sel.choice === 'system' ? (system === 'dark' ? sel.darkFlavor : 'latte') : sel.choice
}

const AA = 4.5

// Text on a filled accent (primary). The official accent stays on `brand` and `ring`; `primary`
// is the accent with OKLCH hue and chroma held and only lightness moved, in 0.01 steps, until
// the text color reaches AA. Dark flavors: crust text on the pastel accent already passes, so
// it is unchanged. Latte: base (near-white) text, and the fill is darkened to reach AA.
function fill(flavor: Flavor, accent: string) {
  const c = COLORS[flavor]
  const fg = flavor === 'latte' ? c.base : [c.crust, c.base, c.text].reduce((best, k) => (contrast(k, accent) > contrast(best, accent) ? k : best))
  if (contrast(fg, accent) >= AA) return { primary: accent, fg }
  const o = hexToOklch(accent)
  const dir = flavor === 'latte' ? -1 : 1
  for (let i = 1; i <= 100; i++) {
    const hex = oklchToHex({ ...o, l: Math.min(1, Math.max(0, o.l + dir * i * 0.01)) })
    if (contrast(fg, hex) >= AA) return { primary: hex, fg }
  }
  return { primary: accent, fg }
}

// Muted text must hold AA on the page, the card and the muted fill: subtext0, then subtext1, then text.
function mutedText(flavor: Flavor) {
  const c = COLORS[flavor]
  const surfaces = [c.base, c.mantle, c.surface0]
  const ok = (t: string) => surfaces.every((s) => contrast(t, s) >= AA)
  return [c.subtext0, c.subtext1, c.text].find(ok) ?? c.text
}

const cache = new Map<string, Theme>()

export function buildTheme(flavor: Flavor, accentName: Accent): Theme {
  const key = `${flavor}/${accentName}`
  const hit = cache.get(key)
  if (hit) return hit
  const c = COLORS[flavor]
  const accent = c[accentName]
  const dark = flavor !== 'latte'
  // Cards use mantle (one step off the base page); borders use surface1 so the edge reads.
  const { primary, fg } = fill(flavor, accent)
  const theme: Theme = {
    id: `catppuccin-${flavor}-${accentName}`,
    name: `${FLAVOR_NAMES[flavor]} (${accentName})`,
    mode: dark ? 'dark' : 'light',
    ui: {
      background: c.base,
      foreground: c.text,
      card: c.mantle,
      'card-foreground': c.text,
      popover: c.mantle,
      'popover-foreground': c.text,
      primary,
      'primary-foreground': fg,
      secondary: c.surface0,
      'secondary-foreground': c.text,
      muted: c.surface0,
      'muted-foreground': mutedText(flavor),
      accent: c.surface0,
      'accent-foreground': c.text,
      destructive: c.red,
      border: c.surface1,
      input: c.surface1,
      ring: accent,
      brand: accent,
      // AI sparkles: mauve, or blue when the accent is already purple-ish.
      highlight: ['mauve', 'lavender', 'pink'].includes(accentName) ? c.blue : c.mauve,
      // Magnitude hue: blue, Catppuccin's data/link color.
      sequential: c.blue,
    },
    chart: {
      categorical: CHART[flavor],
      other: dark ? c.overlay0 : c.overlay1,
      tonal: [c.blue, c.peach],
    },
  }
  cache.set(key, theme)
  return theme
}

export function useTheme(): Theme {
  const sel = useSelection()
  const system = useSystemMode()
  const flavor = resolveFlavor(sel, system)
  return useMemo(() => buildTheme(flavor, sel.accent), [flavor, sel.accent])
}
