import type { ComponentType } from 'react'

export type Mode = 'light' | 'dark'

// Every UI color a theme must supply. Applied as `--<token>` on <html>, so Tailwind's
// `bg-background`, `text-muted-foreground`, etc. follow the active theme.
export const UI_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'border',
  'input',
  'ring',
  // App accents that are not chart series: the logo mark, AI/suggestion affordances,
  // and the single hue used for magnitude (heatmap cells, inline bars, "seen" dots).
  'brand',
  'highlight',
  'sequential',
] as const
export type UiToken = (typeof UI_TOKENS)[number]

export type ChartColors = {
  // Categorical slots in a validated order (dataviz validator, adjacent pairs, this
  // theme's mode and card surface). Up to 8; slot order is the CVD-safety mechanism.
  categorical: string[]
  // Neutral for the folded "Other" series.
  other: string
  // Two hue anchors for tonal mode; the palette engine derives lightness steps from these.
  tonal: [string, string]
}

export type Theme = {
  id: string
  name: string
  mode: Mode
  ui: Record<UiToken, string>
  chart: ChartColors
}

export type ChartMode = 'categorical' | 'tonal'

// A theme proposal: one complete approach to theming (theme lab only — the losers are
// deleted before merge). `useTheme` may use hooks; the host remounts on proposal switch.
export type Proposal = {
  id: string
  label: string
  description: string
  useTheme: () => Theme
  Picker: ComponentType
}
