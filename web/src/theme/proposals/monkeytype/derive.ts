import { baseDark, baseLight } from '../../base'
import type { Mode, Theme } from '../../types'
import { contrast, hexToOklch, mix, oklchToHex, snapLightness } from '@/lib/color'

// The whole vocabulary of a theme: nine colors (hex). Everything else is derived.
export type Roles = {
  bg: string // page background
  surface: string // cards, popovers, chart surface
  surfaceAlt: string // secondary / muted fills and hover
  border?: string // optional; default is text mixed into bg
  text: string
  sub: string // muted text
  main: string // primary accent: buttons, focus ring, brand, magnitude (heatmap, bars)
  alt: string // second accent: suggestion highlight, tonal anchor B
  error: string
}

export type Meta = {
  id: string
  name: string
  mode: Mode
  // Optional hand-picked categorical series (rarely needed).
  categorical?: string[]
  // Optional tonal anchors, for themes whose main is neutral (also drives `sequential`).
  tonal?: [string, string]
}

// Lightness bands for chart marks (dataviz validator: ~0.43-0.77 light, ~0.48-0.67 dark),
// narrowed a little so marks keep contrast against tinted surfaces.
const BAND = { light: [0.5, 0.74], dark: [0.55, 0.68] } as const

const MIN_TEXT = 4.5

// First candidate that reaches AA on `bg`, else whichever of black/white is better.
function readableOn(bg: string, candidates: string[]): string {
  return (
    candidates.find((c) => contrast(c, bg) >= MIN_TEXT) ??
    (contrast('#ffffff', bg) >= contrast('#000000', bg) ? '#ffffff' : '#000000')
  )
}

// Categorical series: the base palette for the mode (validated hue order), each slot's
// lightness snapped into the band, then nudged until it holds 3:1 against the surface.
export function deriveCategorical(mode: Mode, surface: string): string[] {
  const base = mode === 'dark' ? baseDark : baseLight
  const [lo, hi] = BAND[mode]
  return base.chart.categorical.map((c) => {
    let out = snapLightness(c, [lo, hi])
    const k = hexToOklch(out)
    const step = mode === 'dark' ? 0.005 : -0.005
    for (let i = 0; i < 20 && contrast(out, surface) < 3; i++) {
      k.l += step
      out = oklchToHex(k)
    }
    return out
  })
}

// Roles -> every Theme token.
//   background            bg                     foreground / card-foreground / popover-foreground  text
//   card, popover         surface                primary / ring / brand                            main
//   primary-foreground    bg or text, whichever clears AA on main (else black/white)
//   secondary, muted, accent  surfaceAlt         *-foreground                                       text
//   muted-foreground      sub                    destructive                                        error
//   border                border ?? text 14% into bg;  input = text 20% into bg
//   highlight             alt                    chart.tonal  [main, alt] (or meta.tonal) snapped into the chart band;
//   sequential            tonal[0]
//   chart.categorical     deriveCategorical()    chart.other  sub 55% into surface
export function deriveTheme(r: Roles, meta: Meta): Theme {
  const [lo, hi] = BAND[meta.mode]
  const tonal = meta.tonal ?? [r.main, r.alt]
  return {
    id: meta.id,
    name: meta.name,
    mode: meta.mode,
    ui: {
      background: r.bg,
      foreground: r.text,
      card: r.surface,
      'card-foreground': r.text,
      popover: r.surface,
      'popover-foreground': r.text,
      primary: r.main,
      'primary-foreground': readableOn(r.main, [r.bg, r.text]),
      secondary: r.surfaceAlt,
      'secondary-foreground': r.text,
      muted: r.surfaceAlt,
      'muted-foreground': r.sub,
      accent: r.surfaceAlt,
      'accent-foreground': r.text,
      destructive: r.error,
      border: r.border ?? mix(r.bg, r.text, 0.14),
      input: mix(r.bg, r.text, 0.2),
      ring: r.main,
      brand: r.main,
      highlight: r.alt,
      sequential: snapLightness(tonal[0], [lo, hi]),
    },
    chart: {
      categorical: meta.categorical ?? deriveCategorical(meta.mode, r.surface),
      other: mix(r.surface, r.sub, 0.55),
      tonal: [snapLightness(tonal[0], [lo, hi]), snapLightness(tonal[1], [lo, hi])],
    },
  }
}
