// Model ids → family + version, for hierarchical chart colors (hue = family, shade = version).
// Ids look like `claude-opus-5-5`, `claude-haiku-4-5-20251001` or the older `claude-3-5-haiku-20241022`.

// Intrinsic tier, top first. Index is the family's fixed categorical slot, so a family keeps
// its hue across ranges and metrics. Ids matching none of these are family 'other'.
export const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'] as const
export type Family = (typeof FAMILIES)[number] | 'other'

export type ModelInfo = { family: Family; version: number[] }

export function parseModel(id: string): ModelInfo {
  const parts = id.toLowerCase().split(/[-_@.[\]]/)
  const family = (FAMILIES as readonly string[]).find((f) => parts.includes(f)) as Family | undefined
  // Numeric parts are the version; 8-digit parts are snapshot dates.
  const version = parts.filter((p) => /^\d{1,3}$/.test(p)).map(Number)
  return { family: family ?? 'other', version }
}

// Higher tier first (0 = fable), unknown last.
export const familyTier = (f: Family) => (f === 'other' ? FAMILIES.length : FAMILIES.indexOf(f))

export const familyName = (f: Family) => (f === 'other' ? 'Other models' : f[0].toUpperCase() + f.slice(1))

// Negative when a is newer than b.
export function compareVersion(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0)
    if (d) return d
  }
  return 0
}

// Strongest first: higher tier, then newer version.
export const compareModels = (a: string, b: string) => {
  const x = parseModel(a)
  const y = parseModel(b)
  return familyTier(x.family) - familyTier(y.family) || compareVersion(x.version, y.version)
}
