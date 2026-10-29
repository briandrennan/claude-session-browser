// Which series a usage chart shows, in what order, in what color.
//
// Order: rank by the current metric total. Largest sits at the bottom of the stack, on the
// baseline — the only segment readers can compare accurately across buckets — and first in
// the legend; "Other" goes on top and last. Hierarchical groupings keep each family/project
// together (ordered by group total, members by their own total) so a hue reads as one block.
//
// Color safety: a theme's categorical order is validated on ADJACENT slots only (slot i next to
// i+1), which is what a stack shows when slots are handed out in stack order. Color that
// follows the entity (Distinct slots kept while a group stays visible, model families pinned
// to a tier slot) breaks that: after a re-rank, filter or metric switch, slot 3 can sit on
// slot 0, and some such pairs collapse under CVD (Catppuccin Mocha: Opus #8b67b2 on Haiku
// #527abc, deutan ΔE 2.3). Safety first, stability where it's free: a chart keeps its stable
// colors only while every touching pair clears the validator's gates — normal ΔE ≥ 15; CVD ≥ 8
// (target) for slot pairs the theme never validated, ≥ 6 (the floor the theme's own adjacent
// pairs were held to) for consecutive slots and same-hue shades. Otherwise it re-packs to slots
// 0..n-1 in stack order — validated pairs by construction — and pins that, so later renders
// keep the new colors instead of flipping back. Rejected: always packing by rank (recolors
// survivors on every re-rank — the dataviz "recolor-on-filter" anti-pattern; measured, stable
// colors survive in every model chart on the base and Role themes and ~60-75% on Catppuccin's
// dark flavors), and stacking Distinct series in slot order (takes the largest series off the
// baseline, and freed slots still leave gaps, so it isn't safe by itself either).
import type { ChartColors, ChartMode, Mode } from '@/theme/types'
import { compareModels, familyName, familyTier, parseModel } from '@/lib/models'
import { GATE, pairOk } from '@/lib/color'
import {
  DISTINCT_MAX,
  GROUP_MAX,
  HIER_MAX,
  OTHER,
  SHADE_MAX,
  TONAL_MAX,
  otherColor,
  pinSlots,
  retainSeries,
  shadeCount,
  shades,
  slotFor,
  tonalColors,
} from '@/lib/palette'

export type Grouping = 'project' | 'model' | 'project_model' | 'source'

export type Series = { key: string; color: string }
// Legend sections for hierarchical charts; null for flat ones.
export type LegendGroup = { label: string; keys: string[] }

export type Plan = {
  series: Series[] // stack order, bottom first; may end with OTHER
  keyOf: (group: string) => string // raw group → series key (OTHER when folded)
  groups: LegendGroup[] | null
  // What lightness means, for the legend's one-line key.
  shade: 'rank' | 'version' | 'tier' | null
}

type Opts = { grouping: Grouping; mode: ChartMode; chart: ChartColors; theme: Mode }

// `totals`: positive metric totals per raw group.
export function planSeries(totals: Map<string, number>, o: Opts): Plan {
  const ranked = [...totals.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([g]) => g)
  if (o.grouping === 'model') return hierarchical(ranked, totals, o, (g) => modelParent(g))
  if (o.grouping === 'project_model') return hierarchical(ranked, totals, o, (g) => projectParent(g))
  return flat(ranked, o)
}

// Every touching pair (bottom first) clears the gates; see the header for which CVD bar applies.
function touchingOk(s: { color: string; slot: number }[]) {
  return s.every((x, i) => {
    if (i === 0) return true
    const y = s[i - 1]
    return pairOk(y.color, x.color, Math.abs(x.slot - y.slot) <= 1 ? GATE.cvdFloor : GATE.cvdTarget)
  })
}

function finish(series: Series[], kept: Set<string>, folded: boolean, o: Opts, rest: Omit<Plan, 'series' | 'keyOf'>): Plan {
  if (folded) series.push({ key: OTHER, color: otherColor(o.chart.other, series.at(-1)?.color, o.theme) })
  return { series, keyOf: (g) => (kept.has(g) ? g : OTHER), ...rest }
}

function flat(ranked: string[], o: Opts): Plan {
  const slots = Math.min(o.chart.categorical.length, DISTINCT_MAX)
  // Tonal folds past TONAL_MAX even when one group would be left over: a 6th step would put
  // same-hue neighbors < 0.10 L apart on dark cards.
  const cap = o.mode === 'tonal' ? TONAL_MAX : ranked.length <= slots ? slots : slots - 1
  const top = ranked.slice(0, cap)
  const folded = ranked.length > top.length
  let colors: string[]
  if (o.mode === 'tonal') colors = tonalColors(top.length, o.chart.tonal, o.theme)
  else {
    retainSeries(top)
    const slotOf = top.map((g) => slotFor(g, slots))
    colors = slotOf.map((i) => o.chart.categorical[i])
    if (!touchingOk(colors.map((color, i) => ({ color, slot: slotOf[i] })))) {
      pinSlots(top)
      colors = top.map((_, i) => o.chart.categorical[i])
    }
  }
  const series = top.map((key, i) => ({ key, color: colors[i] }))
  return finish(series, new Set(top), folded, o, { groups: null, shade: o.mode === 'tonal' && top.length > 1 ? 'rank' : null })
}

type Parent = { id: string; label: string; slot?: number }

const modelParent = (g: string): Parent => {
  const f = parseModel(g).family
  // Preferred slot by tier (fable 0 … haiku 4, unknown 5), stable across ranges and metrics
  // while the stack order keeps touching pairs safe (see the header).
  return { id: f, label: familyName(f), slot: familyTier(f) }
}

const projectParent = (g: string): Parent => {
  const p = g.split(' · ')[0]
  return { id: p, label: p }
}

const modelOf = (g: string) => g.split(' · ').at(-1) ?? g

// Hue per parent (model family or project), shade per member. Families and projects are
// nominal, so both chart modes take their hues from the categorical slots — two tonal anchors
// can't name four families. What changes with the mode is the shade: Distinct = identity
// (newer version / higher model tier is stronger, stable across metrics); Tonal = rank within
// the parent (stronger = larger), consistent with tonal meaning "color shows rank".
function hierarchical(ranked: string[], totals: Map<string, number>, o: Opts, parentOf: (g: string) => Parent): Plan {
  const parents = new Map<string, Parent & { total: number; members: string[] }>()
  for (const g of ranked) {
    const p = parentOf(g)
    const e = parents.get(p.id) ?? { ...p, total: 0, members: [] }
    e.total += totals.get(g) ?? 0
    e.members.push(g)
    parents.set(p.id, e)
  }
  const slots = o.chart.categorical.length
  const order = [...parents.values()].sort((a, b) => b.total - a.total).slice(0, GROUP_MAX)
  // Stable slots first: model families by tier; Distinct projects keep a slot while visible
  // (shared with the Project grouping, so switching keeps colors). Tonal projects take slots
  // in rank order outright — tonal colors already follow rank.
  let stable: number[] | null = null
  if (o.grouping === 'model') stable = order.map((p) => p.slot ?? 0)
  else if (o.mode !== 'tonal') {
    retainSeries(order.map((p) => p.id))
    stable = order.map((p) => slotFor(p.id, slots))
  }
  const caps = new Map<string, number>()
  const build = (slotOf: number[]) => {
    const base = (i: number) => o.chart.categorical[slotOf[i]] ?? o.chart.other
    // Members kept per parent: as many as the hue's shades can separate (and any cap from
    // the safety pass below), then trim the globally smallest until ≤ HIER_MAX series.
    const keep = new Map(
      order.map((p, i) => [p.id, p.members.slice(0, Math.min(caps.get(p.id) ?? Infinity, shadeCount(base(i), SHADE_MAX[o.theme], o.theme)))]),
    )
    const kept = new Set([...keep.values()].flat())
    for (const g of [...ranked].reverse()) {
      if (kept.size <= HIER_MAX) break
      if (!kept.has(g)) continue
      kept.delete(g)
      const list = keep.get(parentOf(g).id)!
      list.splice(list.indexOf(g), 1)
    }
    const series: (Series & { parent: string; slot: number })[] = []
    const groups: LegendGroup[] = []
    order.forEach((p, i) => {
      const members = keep.get(p.id)!
      if (!members.length) return
      const strength = o.mode === 'tonal' ? members : [...members].sort((a, b) => compareModels(modelOf(a), modelOf(b)))
      const ladder = shades(base(i), members.length, o.theme)
      for (const g of members) series.push({ key: g, color: ladder[strength.indexOf(g)], parent: p.id, slot: slotOf[i] })
      groups.push({ label: p.label, keys: members })
    })
    return { series, groups, kept }
  }
  const safe = touchingOk

  let plan = stable && build(stable)
  if (!plan || !safe(plan.series)) {
    // Re-pack: slots in stack order make each parent boundary a validated base pair. Shades
    // move off the base lightness, so a boundary can still fail (light shade on light shade):
    // then drop a shade from the parent with more until it clears — two single-member parents
    // in adjacent slots are the theme's own validated pair.
    if (stable && o.grouping !== 'model') pinSlots(order.map((p) => p.id))
    const packed = order.map((_, i) => i)
    plan = build(packed)
    for (let guard = 0; guard < HIER_MAX * 2 && !safe(plan.series); guard++) {
      const s = plan.series
      const i = s.findIndex((x, j) => j > 0 && !pairOk(s[j - 1].color, x.color))
      const count = (id: string) => s.filter((x) => x.parent === id).length
      const [a, b] = [s[i - 1].parent, s[i].parent]
      const cut = count(a) >= count(b) ? a : b
      if (count(cut) <= 1) break
      caps.set(cut, count(cut) - 1)
      plan = build(packed)
    }
  }

  const { groups, kept } = plan
  const series = plan.series.map(({ key, color }) => ({ key, color }))
  const multi = groups.some((g) => g.keys.length > 1)
  const shade = !multi ? null : o.mode === 'tonal' ? 'rank' : o.grouping === 'model' ? 'version' : 'tier'
  return finish(series, kept, ranked.length > kept.size, o, { groups, shade })
}
