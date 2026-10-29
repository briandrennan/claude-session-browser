// Small sRGB / OKLCH helpers (Ottosson's OKLab matrices). No dependencies.

export type Oklch = { l: number; c: number; h: number }

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const toLinear = (u: number) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4)
const fromLinear = (u: number) => (u <= 0.0031308 ? u * 12.92 : 1.055 * u ** (1 / 2.4) - 0.055)

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const f = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  const n = parseInt(f.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex(rgb: readonly number[]): string {
  return '#' + rgb.map((v) => Math.round(clamp01(v / 255) * 255).toString(16).padStart(2, '0')).join('')
}

function linearToOklab([r, g, b]: number[]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabToLinear([L, a, b]: number[]): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

export function hexToOklab(hex: string): [number, number, number] {
  return linearToOklab(hexToRgb(hex).map((v) => toLinear(v / 255)))
}

export function oklabToHex(lab: number[]): string {
  return rgbToHex(oklabToLinear(lab).map((v) => fromLinear(clamp01(v)) * 255))
}

export function hexToOklch(hex: string): Oklch {
  const [l, a, b] = hexToOklab(hex)
  return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 }
}

const inGamut = (lin: number[]) => lin.every((v) => v >= -0.0005 && v <= 1.0005)

const linearAt = (l: number, c: number, h: number) =>
  oklabToLinear([l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)])

// Largest chroma <= c that is displayable at this lightness and hue.
export function fitChroma({ l, c, h }: Oklch): number {
  if (inGamut(linearAt(l, c, h))) return c
  let lo = 0
  let hi = c
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (inGamut(linearAt(l, mid, h))) lo = mid
    else hi = mid
  }
  return lo
}

// OKLCH -> hex; out-of-gamut colors lose chroma (hue and lightness are held).
export function oklchToHex(k: Oklch): string {
  const c = fitChroma(k)
  const rad = (k.h * Math.PI) / 180
  return oklabToHex([k.l, c * Math.cos(rad), c * Math.sin(rad)])
}

// OKLab distance x100 (the dataviz validator's Delta E, unsimulated vision).
export function deltaE(a: string, b: string): number {
  const x = hexToOklab(a)
  const y = hexToOklab(b)
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

// Mix in OKLab: `t` is the share of `b`.
export function mix(a: string, b: string, t: number): string {
  const x = hexToOklab(a)
  const y = hexToOklab(b)
  return oklabToHex(x.map((v, i) => v + (y[i] - v) * t))
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => toLinear(v / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// WCAG contrast ratio.
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

// Move a color's OKLCH lightness into [lo, hi], keeping hue and (as far as gamut allows) chroma.
export function snapLightness(hex: string, [lo, hi]: readonly [number, number]): string {
  const k = hexToOklch(hex)
  const l = Math.min(hi, Math.max(lo, k.l))
  return l === k.l ? hex : oklchToHex({ ...k, l })
}

// --- color-vision deficiency ---------------------------------------------------------

// Machado, Oliveira & Fernandes 2009, severity 1.0, applied in linear sRGB — the same
// matrices as the dataviz validator (validate_palette.js), so runtime checks match it.
const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
}
export type Cvd = keyof typeof MACHADO

function simulatedOklab(hex: string, kind: Cvd) {
  const lin = hexToRgb(hex).map((v) => toLinear(v / 255))
  return linearToOklab(MACHADO[kind].map((row) => clamp01(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])))
}

// OKLab distance x100 under simulated protanopia / deuteranopia.
export function cvdDeltaE(a: string, b: string, kind: Cvd): number {
  const x = simulatedOklab(a, kind)
  const y = simulatedOklab(b, kind)
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

// Worse of protan and deutan (the validator's CVD separation figure).
export const cvdMin = (a: string, b: string) => Math.min(cvdDeltaE(a, b, 'protan'), cvdDeltaE(a, b, 'deutan'))

// Validator gates for two marks that touch: normal-vision ΔE ≥ 15 (hard floor), CVD ΔE ≥ 8
// target, 6 floor (6–8 is the validator's WARN band).
export const GATE = { normal: 15, cvdTarget: 8, cvdFloor: 6 } as const

export const pairOk = (a: string, b: string, cvd: number = GATE.cvdFloor) => deltaE(a, b) >= GATE.normal && cvdMin(a, b) >= cvd

// Every neighbor pair of a stack (bottom first) clears the gates.
export const adjacentOk = (colors: readonly string[], cvd: number = GATE.cvdFloor) =>
  colors.every((c, i) => i === 0 || pairOk(colors[i - 1], c, cvd))

// --- CSS colors ---------------------------------------------------------------------

// Hex for the two forms theme tokens use: `#rgb` / `#rrggbb` and `oklch(L C H [/ a])` (L as a
// number or %, alpha ignored). Anything else returns null.
export function parseColor(css: string): string | null {
  const s = css.trim()
  if (/^#([\da-f]{3}|[\da-f]{6})$/i.test(s)) return rgbToHex(hexToRgb(s))
  const m = s.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/[^)]*)?\)$/i)
  if (!m) return null
  return oklchToHex({ l: m[2] ? +m[1] / 100 : +m[1], c: +m[3], h: +m[4] })
}

// The candidate ink with the highest WCAG contrast on `bg`; pure black/white join in when no
// candidate reaches 4.5:1.
export function bestInk(bg: string, candidates: readonly string[]): string {
  const best = (list: readonly string[]) => list.reduce((a, b) => (contrast(b, bg) > contrast(a, bg) ? b : a))
  const pick = best(candidates)
  return contrast(pick, bg) >= 4.5 ? pick : best([pick, '#000000', '#ffffff'])
}
