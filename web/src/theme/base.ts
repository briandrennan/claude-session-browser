import type { Theme } from './types'

// The app's original look (shadcn neutral + dataviz reference palette), as theme data.
// Proposals may use these as seeds; status colors (--good/--warning/...) stay fixed in
// index.css and are never themed.

export const baseLight: Theme = {
  id: 'base-light',
  name: 'Light',
  mode: 'light',
  ui: {
    background: 'oklch(1 0 0)',
    foreground: 'oklch(0.145 0 0)',
    card: 'oklch(1 0 0)',
    'card-foreground': 'oklch(0.145 0 0)',
    popover: 'oklch(1 0 0)',
    'popover-foreground': 'oklch(0.145 0 0)',
    primary: 'oklch(0.205 0 0)',
    'primary-foreground': 'oklch(0.985 0 0)',
    secondary: 'oklch(0.97 0 0)',
    'secondary-foreground': 'oklch(0.205 0 0)',
    muted: 'oklch(0.97 0 0)',
    'muted-foreground': 'oklch(0.556 0 0)',
    accent: 'oklch(0.97 0 0)',
    'accent-foreground': 'oklch(0.205 0 0)',
    destructive: 'oklch(0.577 0.245 27.325)',
    border: 'oklch(0.922 0 0)',
    input: 'oklch(0.922 0 0)',
    ring: 'oklch(0.708 0 0)',
    brand: '#eb6834',
    highlight: '#6250d6',
    sequential: '#2a78d6',
  },
  chart: {
    categorical: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    other: '#a3a29c',
    tonal: ['#2a78d6', '#eb6834'],
  },
}

export const baseDark: Theme = {
  id: 'base-dark',
  name: 'Dark',
  mode: 'dark',
  ui: {
    background: 'oklch(0.145 0 0)',
    foreground: 'oklch(0.985 0 0)',
    card: 'oklch(0.205 0 0)',
    'card-foreground': 'oklch(0.985 0 0)',
    popover: 'oklch(0.205 0 0)',
    'popover-foreground': 'oklch(0.985 0 0)',
    primary: 'oklch(0.922 0 0)',
    'primary-foreground': 'oklch(0.205 0 0)',
    secondary: 'oklch(0.269 0 0)',
    'secondary-foreground': 'oklch(0.985 0 0)',
    muted: 'oklch(0.269 0 0)',
    'muted-foreground': 'oklch(0.708 0 0)',
    accent: 'oklch(0.269 0 0)',
    'accent-foreground': 'oklch(0.985 0 0)',
    destructive: 'oklch(0.704 0.191 22.216)',
    border: 'oklch(1 0 0 / 10%)',
    input: 'oklch(1 0 0 / 15%)',
    ring: 'oklch(0.556 0 0)',
    brand: '#d95926',
    highlight: '#9085e9',
    sequential: '#3987e5',
  },
  chart: {
    categorical: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    other: '#6b6a65',
    tonal: ['#3987e5', '#d95926'],
  },
}
