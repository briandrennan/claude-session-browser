// Validated categorical palette (dataviz skill reference instance), as CSS vars
// --series-1..8 defined in index.css for light and dark. Slot 8 is "Other".
export const MAX_SERIES = 7
export const OTHER = 'Other'

const assigned = new Map<string, number>()

// Color follows the entity: once a group gets a slot it keeps it for the page's lifetime.
export function seriesColor(key: string): string {
  if (key === OTHER) return 'var(--series-other)'
  let slot = assigned.get(key)
  if (slot === undefined) {
    const used = new Set(assigned.values())
    slot = 0
    while (used.has(slot) && slot < MAX_SERIES) slot++
    if (slot >= MAX_SERIES) slot = assigned.size % MAX_SERIES
    assigned.set(key, slot)
  }
  return `var(--series-${slot + 1})`
}

// Release slots of groups no longer visible so new groups can reuse them.
export function retainSeries(keys: string[]) {
  const keep = new Set(keys)
  for (const k of [...assigned.keys()]) if (!keep.has(k)) assigned.delete(k)
}
