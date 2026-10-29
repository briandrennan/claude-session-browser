// Chart color engine. Pure functions over the active theme's `chart` colors
// (`Theme.chart`: validated categorical slots, an "Other" neutral, two tonal anchors).
// Every number below was measured with the dataviz validator (validate_palette.js);
// see the notes next to each cap.

import { GATE, adjacentOk, deltaE, fitChroma, hexToOklch, oklchToHex, pairOk, type Oklch } from '@/lib/color'
import { baseDark, baseLight } from '@/theme/base'
import type { Mode } from '@/theme/types'

export { deltaE }
export const OTHER = 'Other'

// OKLCH lightness band that marks may use, per mode (dataviz color formula check 2).
export const BAND: Record<Mode, [number, number]> = { light: [0.43, 0.77], dark: [0.48, 0.67] }

// --- caps (series shown before the tail folds into "Other") -----------------------------

// Distinct: one categorical slot per identity, never cycled or generated. Up to 8 identities
// including "Other" (7 + Other, or 8 when exactly 8 groups exist).
export const DISTINCT_MAX = 8

// Tonal: 2 hues alternating by rank, lightness by rank across the mode's band. Validator on base
// anchors (#2a78d6/#eb6834 light, #3987e5/#d95926 dark), cards #ffffff / #171717:
//   k  min same-hue ΔL light/dark  adjacent gates, both modes            --ordinal per hue
//   4  0.222 / 0.121                PASS (worst CVD ΔE 22.7 / 25.0)       PASS
//   5  0.165 / 0.090                PASS (worst CVD ΔE 22.3 / 24.5)       PASS
//   6  0.132 / 0.073                PASS (worst CVD ΔE 22.1 / 25.4)       PASS
// Alternating hues clear the adjacent gates at any k; the binding limit is the dark band
// (0.19 L wide): same-hue steps must stay ~0.10 L apart for the legend to stay matchable by
// shade. 5 keeps 0.09 (light 0.165); 6 drops to 0.073. So 5 ranked series + "Other". The
// faintest step is below 3:1 on the card (light 2.1, dark 2.7) — legend + tooltip carry it.
export const TONAL_MAX = 5

// Hierarchical (hue = family/project, shade = version/model): ≤ 4 hues × ≤ SHADE_MAX shades,
// ≤ 8 series + "Other". Same-hue shades touch in the stack, so every pair must clear the
// normal-vision floor (ΔE ≥ 15) on lightness alone: the light band fits 3 (ΔL 0.165, worst
// pair ΔE 16.5), the dark band 2 (ΔL 0.18, ΔE ~19; 3 measured ΔE ~9, FAIL). shadeCount()
// re-checks per hue at runtime, so deep yellows/greens that lose chroma get fewer.
export const GROUP_MAX = 4
export const SHADE_MAX: Record<Mode, number> = { light: 3, dark: 2 }
export const HIER_MAX = 8

// --- ramps ------------------------------------------------------------------------------

// Chroma floor (check 3): below ~0.10 a hue reads as gray.
const CHROMA_FLOOR = 0.1
// Stay just inside the band so rounding to hex never lands on the edge.
const INSET = 0.004

// Lightness for n steps, strongest first, at most `maxStep` apart and centered in the band.
// Light: darkest = strongest. Dark: brightest = strongest — on a dark card the bright end
// carries the most contrast and draws the eye while the dim end recedes into the surface,
// so "more" reads as "more visible" in both modes (the dataviz sequential-ramp flip).
function ladder(n: number, mode: Mode, maxStep: number) {
  const [lo, hi] = BAND[mode]
  const span = Math.min(hi - lo - 2 * INSET, maxStep * (n - 1))
  const strong = mode === 'light' ? (lo + hi - span) / 2 : (lo + hi + span) / 2
  const dir = mode === 'light' ? 1 : -1
  return Array.from({ length: n }, (_, i) => strong + dir * (n === 1 ? 0 : (span * i) / (n - 1)))
}

// Hold H, use L, keep the anchor's chroma (raised to the floor) where the gamut allows. Where it can't reach the
// chroma floor (deep yellows and greens), slide L toward the band centre until it does.
function mark(L: number, C: number, H: number, mode: Mode) {
  const [lo, hi] = BAND[mode]
  const mid = (lo + hi) / 2
  // Aim a hair above the floor: hex rounding can shave ~0.001 off (0.0995 fails the validator).
  const floor = CHROMA_FLOOR + 0.003
  const c = Math.max(C, floor)
  for (let i = 0; i < 12 && fitChroma({ l: L, c, h: H }) < floor; i++) L += Math.sign(mid - L) * 0.005
  return oklchToHex({ l: L, c, h: H })
}

function tonalFrom(k: number, hues: Oklch[], mode: Mode) {
  return ladder(k, mode, 0.12).map((L, r) => mark(L, hues[r % 2].c, hues[r % 2].h, mode))
}

// Theme-supplied anchors are not validated by the theme author against every k, and some
// hue pairs collapse under CVD once the ladder pulls their lightness together (Role theme
// forest-night #27702f/#935f0e dark: protan ΔE 2.4 at k=5). So every result is checked
// against the validator's adjacent gates (normal ΔE ≥ 15, CVD ≥ 8 target / ≥ 6 floor):
//   1. the theme's anchors, if they reach the target;
//   2. else the second anchor's hue nudged by 15°, 30°, … 90° (either way, smallest first)
//      — keeps the theme's first hue and stays close to its second;
//   3. else the theme's anchors if they at least clear the floor;
//   4. else the base blue/orange pair for the mode (measured worst CVD 22+ at k ≤ 6).
const NUDGES = [15, -15, 30, -30, 45, -45, 60, -60, 75, -75, 90, -90]
const FALLBACK: Record<Mode, [string, string]> = { light: baseLight.chart.tonal, dark: baseDark.chart.tonal }
const tonalCache = new Map<string, string[]>()

// Tonal: colors for ranks 0..k-1 (largest first). Lightness encodes rank (steps ≤ 0.12 L,
// spread over the band); the two anchor hues alternate so neighbors never share a hue.
export function tonalColors(k: number, anchors: [string, string], mode: Mode): string[] {
  const key = `${k} ${anchors} ${mode}`
  const hit = tonalCache.get(key)
  if (hit) return hit
  const [a, b] = anchors.map(hexToOklch)
  const own = tonalFrom(k, [a, b], mode)
  let out = own
  if (!adjacentOk(own, GATE.cvdTarget)) {
    const nudged = NUDGES.map((d) => tonalFrom(k, [a, { ...b, h: (b.h + d + 360) % 360 }], mode)).find((p) => adjacentOk(p, GATE.cvdTarget))
    out = nudged ?? (adjacentOk(own) ? own : tonalFrom(k, FALLBACK[mode].map(hexToOklch), mode))
  }
  tonalCache.set(key, out)
  return out
}

// n shades of one hue, strongest first, centered in the band and up to 0.2 L apart.
// A single shade is the slot color itself.
export function shades(hex: string, n: number, mode: Mode): string[] {
  if (n <= 1) return [hex]
  const { c: C, h: H } = hexToOklch(hex)
  return ladder(n, mode, 0.2).map((L) => mark(L, C, H, mode))
}

// Same-hue shades touch in a stack, so every pair must clear the normal-vision floor (ΔE ≥ 15)
// and the CVD floor (ΔE ≥ 6; lightness survives CVD, so this rarely binds) on lightness alone. Returns how many shades of `hex` (≤ max) do. Measured on base slots:
// light 3 shades → worst pair ΔE 16.5–16.9 (deep yellow/green lose chroma low in the band and
// drop to 2); dark 3 shades → ΔE ~9 (fail), 2 shades → ΔE ~19.
export function shadeCount(hex: string, max: number, mode: Mode) {
  for (let n = max; n > 1; n--) {
    const s = shades(hex, n, mode)
    if (s.every((a, i) => s.slice(i + 1).every((b) => pairOk(a, b)))) return n
  }
  return 1
}

// The "Other" neutral sits on top of the stack, beside the last series. Neutral vs. hue only
// separates by lightness under CVD, so keep it ≥ 0.12 L from its neighbor (light base: the
// lightest tonal step #7eb6ff vs #a3a29c measured ΔE 14.0 normal / 7.2 protan before this).
export function otherColor(other: string, neighbor: string | undefined, mode: Mode) {
  if (!neighbor) return other
  const { l: L, c: C, h: H } = hexToOklch(other)
  const n = hexToOklch(neighbor).l
  if (Math.abs(L - n) >= 0.12) return other
  const [lo, hi] = BAND[mode]
  const options = [n - 0.12, n + 0.12].filter((x) => x >= lo - 0.04 && x <= hi + 0.04)
  const target = options.sort((a, b) => Math.abs(a - L) - Math.abs(b - L))[0] ?? L
  return oklchToHex({ l: target, c: C, h: H })
}

// --- Distinct slots: color follows the entity ------------------------------------------

const assigned = new Map<string, number>()

// Once a group gets a slot it keeps it while it stays visible; new groups take the lowest
// free slot. Never cycles: callers fold anything past the slot count into "Other".
export function slotFor(key: string, slots: number): number {
  const had = assigned.get(key)
  if (had !== undefined && had < slots) return had
  assigned.delete(key)
  const used = new Set(assigned.values())
  let slot = 0
  while (used.has(slot)) slot++
  assigned.set(key, slot)
  return slot
}

// Overwrite assignments (after a re-pack, so the new colors stick on later renders).
export function pinSlots(keys: string[]) {
  keys.forEach((k, i) => assigned.set(k, i))
}

// Release slots of groups no longer visible so new groups can reuse them. Call with the
// visible keys before assigning, largest first.
export function retainSeries(keys: string[]) {
  const keep = new Set(keys)
  for (const k of [...assigned.keys()]) if (!keep.has(k)) assigned.delete(k)
}
