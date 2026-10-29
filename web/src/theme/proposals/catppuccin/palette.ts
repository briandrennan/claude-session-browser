// Palette values from github.com/catppuccin/palette (MIT, (c) Catppuccin), flavor files palette.json.

export const FLAVORS = ['latte', 'frappe', 'macchiato', 'mocha'] as const
export type Flavor = (typeof FLAVORS)[number]

export const FLAVOR_NAMES: Record<Flavor, string> = {
  latte: 'Latte',
  frappe: 'Frappé',
  macchiato: 'Macchiato',
  mocha: 'Mocha',
}

export const ACCENTS = [
  'rosewater',
  'flamingo',
  'pink',
  'mauve',
  'red',
  'maroon',
  'peach',
  'yellow',
  'green',
  'teal',
  'sky',
  'sapphire',
  'blue',
  'lavender',
] as const
export type Accent = (typeof ACCENTS)[number]

export const ACCENT_NAMES: Record<Accent, string> = Object.fromEntries(
  ACCENTS.map((a) => [a, a[0].toUpperCase() + a.slice(1)]),
) as Record<Accent, string>

export type FlavorColors = Record<Accent, string> & {
  text: string
  subtext1: string
  subtext0: string
  overlay1: string
  overlay0: string
  surface1: string
  surface0: string
  base: string
  mantle: string
  crust: string
}

export const COLORS: Record<Flavor, FlavorColors> = {
  latte: {
    rosewater: '#dc8a78', flamingo: '#dd7878', pink: '#ea76cb', mauve: '#8839ef', red: '#d20f39',
    maroon: '#e64553', peach: '#fe640b', yellow: '#df8e1d', green: '#40a02b', teal: '#179299',
    sky: '#04a5e5', sapphire: '#209fb5', blue: '#1e66f5', lavender: '#7287fd',
    text: '#4c4f69', subtext1: '#5c5f77', subtext0: '#6c6f85', overlay1: '#8c8fa1', overlay0: '#9ca0b0',
    surface1: '#bcc0cc', surface0: '#ccd0da', base: '#eff1f5', mantle: '#e6e9ef', crust: '#dce0e8',
  },
  frappe: {
    rosewater: '#f2d5cf', flamingo: '#eebebe', pink: '#f4b8e4', mauve: '#ca9ee6', red: '#e78284',
    maroon: '#ea999c', peach: '#ef9f76', yellow: '#e5c890', green: '#a6d189', teal: '#81c8be',
    sky: '#99d1db', sapphire: '#85c1dc', blue: '#8caaee', lavender: '#babbf1',
    text: '#c6d0f5', subtext1: '#b5bfe2', subtext0: '#a5adce', overlay1: '#838ba7', overlay0: '#737994',
    surface1: '#51576d', surface0: '#414559', base: '#303446', mantle: '#292c3c', crust: '#232634',
  },
  macchiato: {
    rosewater: '#f4dbd6', flamingo: '#f0c6c6', pink: '#f5bde6', mauve: '#c6a0f6', red: '#ed8796',
    maroon: '#ee99a0', peach: '#f5a97f', yellow: '#eed49f', green: '#a6da95', teal: '#8bd5ca',
    sky: '#91d7e3', sapphire: '#7dc4e4', blue: '#8aadf4', lavender: '#b7bdf8',
    text: '#cad3f5', subtext1: '#b8c0e0', subtext0: '#a5adcb', overlay1: '#8087a2', overlay0: '#6e738d',
    surface1: '#494d64', surface0: '#363a4f', base: '#24273a', mantle: '#1e2030', crust: '#181926',
  },
  mocha: {
    rosewater: '#f5e0dc', flamingo: '#f2cdcd', pink: '#f5c2e7', mauve: '#cba6f7', red: '#f38ba8',
    maroon: '#eba0ac', peach: '#fab387', yellow: '#f9e2af', green: '#a6e3a1', teal: '#94e2d5',
    sky: '#89dceb', sapphire: '#74c7ec', blue: '#89b4fa', lavender: '#b4befe',
    text: '#cdd6f4', subtext1: '#bac2de', subtext0: '#a6adc8', overlay1: '#7f849c', overlay0: '#6c7086',
    surface1: '#45475a', surface0: '#313244', base: '#1e1e2e', mantle: '#181825', crust: '#11111b',
  },
}

// Chart palettes: 8 slots in validated adjacent order, checked against the flavor's card
// (mantle) with the dataviz validator. Latte uses official accent values untouched. The
// dark flavors' official pastels sit at OKLCH L 0.75-0.92, far above the dark band
// (0.48-0.67), so every slot is re-derived from the official accent: same hue, chroma
// raised to >= 0.11 where needed, lightness set to 0.66, or 0.58 for slots marked `_d`
// (a second lightness keeps neighbours apart). Dark charts are Catppuccin hues, not
// Catppuccin's exact pastels.
// Validator (adjacent pairs vs card): no FAIL; worst CVD / normal-vision deltaE:
//   latte 21.3 / 22.6 (contrast < 3:1 on 5 slots: WARN, official values kept)
//   frappe 17.8 / 19.4, macchiato 18.4 / 19.8, mocha 17.6 / 19.0 (contrast >= 3:1)
export const CHART: Record<Flavor, string[]> = {
  // flamingo mauve yellow sky green blue red pink
  latte: ['#dd7878', '#8839ef', '#df8e1d', '#04a5e5', '#40a02b', '#1e66f5', '#d20f39', '#ea76cb'],
  // sky yellow_d mauve_d green blue_d peach lavender rosewater_d
  frappe: ['#19a4b7', '#99741b', '#9066aa', '#77a159', '#5b78bc', '#c97c54', '#8a89d3', '#b26050'],
  // sky yellow_d blue_d green mauve_d peach lavender rosewater_d
  macchiato: ['#18a4b7', '#98741a', '#5879bc', '#70a25f', '#8b65b6', '#c87d52', '#858ad4', '#b25f51'],
  // sky yellow_d mauve_d peach blue_d green_d lavender rosewater_d
  mocha: ['#19a4b7', '#97751a', '#8b67b2', '#c77e4f', '#527abc', '#518b4d', '#828bd5', '#b25f52'],
}
