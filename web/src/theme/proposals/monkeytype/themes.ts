import { deriveTheme, type Meta, type Roles } from './derive'

// Each theme is nine colors. Written from scratch; names describe the colors.
// meta.tonal pairs were checked with tonalColors(5, ...) on each card (validator, adjacent pairs):
// no FAIL, chroma >= 0.10, CVD pass. Worst CVD / normal-vision ΔE:
//   paper-and-ink 22.4/29.5  warm-linen 22.4/27.2  pale-sage 21.9/24.8  cool-porcelain 23.9/27.2
//   blush-paper 17.2/25.0  high-contrast-light 13.1/23.4  neutral-dark 24.5/31.4  slate 21.0/24.7
//   warm-graphite 25.5/26.0  deep-sea 17.5/24.2  forest-night 22.0/25.2  plum-dusk 19.5/19.7
// ([main, alt] failed for warm-linen, pale-sage, blush-paper, warm-graphite, deep-sea, forest-night;
// those get a main-hue anchor plus a blue/orange partner. Sub-3:1 faint steps are the engine's
// documented relief case.)
type Entry = [Meta, Roles]

const entries: Entry[] = [
  // Light
  [
    { id: 'paper-and-ink', name: 'Paper and ink', mode: 'light', tonal: ['#2a78d6', '#eb6834'] },
    { bg: '#ffffff', surface: '#ffffff', surfaceAlt: '#f5f5f5', border: '#e5e5e5', text: '#171717', sub: '#666666', main: '#262626', alt: '#6250d6', error: '#c62828' },
  ],
  [
    { id: 'warm-linen', name: 'Warm linen', mode: 'light', tonal: ['#c85b32', '#5e78d9'] },
    { bg: '#f4efe6', surface: '#fbf8f2', surfaceAlt: '#ebe4d6', text: '#2e2a24', sub: '#675f51', main: '#a94a22', alt: '#2f6b57', error: '#b3261e' },
  ],
  [
    { id: 'pale-sage', name: 'Pale sage', mode: 'light', tonal: ['#25984d', '#5e78d9'] },
    { bg: '#edf1ea', surface: '#f8faf6', surfaceAlt: '#dfe7db', text: '#1e2a21', sub: '#4f6055', main: '#2b7048', alt: '#8a4f9e', error: '#b3261e' },
  ],
  [
    { id: 'cool-porcelain', name: 'Cool porcelain', mode: 'light' },
    { bg: '#eaeff6', surface: '#ffffff', surfaceAlt: '#dfe6f0', text: '#1b2433', sub: '#505d72', main: '#2459b8', alt: '#b94c18', error: '#b3261e' },
  ],
  [
    { id: 'blush-paper', name: 'Blush paper', mode: 'light', tonal: ['#ca545a', '#5e78d9'] },
    { bg: '#f7ecee', surface: '#fffafb', surfaceAlt: '#efdde1', text: '#3a1f28', sub: '#6f4c58', main: '#a8304f', alt: '#2f6a8c', error: '#b3261e' },
  ],
  [
    { id: 'high-contrast-light', name: 'High contrast light', mode: 'light' },
    { bg: '#ffffff', surface: '#ffffff', surfaceAlt: '#ececec', border: '#8a8a8a', text: '#000000', sub: '#404040', main: '#0838c0', alt: '#a81a6a', error: '#b00020' },
  ],
  // Dark
  [
    { id: 'neutral-dark', name: 'Neutral dark', mode: 'dark', tonal: ['#3987e5', '#d95926'] },
    { bg: '#0a0a0a', surface: '#171717', surfaceAlt: '#262626', border: '#2a2a2a', text: '#fafafa', sub: '#a3a3a3', main: '#e5e5e5', alt: '#9085e9', error: '#f07178' },
  ],
  [
    { id: 'slate', name: 'Slate', mode: 'dark' },
    { bg: '#12171f', surface: '#1b2330', surfaceAlt: '#263142', text: '#e3e8f0', sub: '#9aa6b8', main: '#6a9fee', alt: '#e0915a', error: '#f27a7a' },
  ],
  [
    { id: 'warm-graphite', name: 'Warm graphite', mode: 'dark', tonal: ['#c46d00', '#647ee0'] },
    { bg: '#1a1816', surface: '#252220', surfaceAlt: '#322e2b', text: '#ece6df', sub: '#a89f94', main: '#e0975a', alt: '#8fb996', error: '#f27a6e' },
  ],
  [
    { id: 'deep-sea', name: 'Deep sea', mode: 'dark', tonal: ['#0093c2', '#cb6620'] },
    { bg: '#08171f', surface: '#0f2530', surfaceAlt: '#18343f', text: '#dcebf0', sub: '#8fb0bb', main: '#3fc1c9', alt: '#f0a868', error: '#f27a7a' },
  ],
  [
    { id: 'forest-night', name: 'Forest night', mode: 'dark', tonal: ['#2e9e52', '#647ee0'] },
    { bg: '#0f1913', surface: '#18241b', surfaceAlt: '#223127', text: '#e2ece4', sub: '#97ad9c', main: '#7bc47f', alt: '#d9a05b', error: '#f27a6e' },
  ],
  [
    { id: 'plum-dusk', name: 'Plum dusk', mode: 'dark' },
    { bg: '#181220', surface: '#221a2b', surfaceAlt: '#2e2339', text: '#ebe3f0', sub: '#a898b5', main: '#c49bf0', alt: '#f0a070', error: '#f27a8a' },
  ],
]

export const ROLE_THEMES = entries.map(([meta, roles]) => deriveTheme(roles, meta))
export const ROLE_INPUTS = entries
export const DEFAULT_LIGHT = 'paper-and-ink'
export const DEFAULT_DARK = 'neutral-dark'
export const themeById = (id: string) => ROLE_THEMES.find((t) => t.id === id)
