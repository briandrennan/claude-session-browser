export type Preset = '1D' | '7D' | '14D' | '30D' | 'All' | 'custom'
export const PRESETS: Exclude<Preset, 'custom'>[] = ['1D', '7D', '14D', '30D', 'All']

// "All" starts well before Claude Code existed; the API trims usage charts to
// the first recorded activity.
const EPOCH = new Date(2024, 0, 1)

export function presetRange(p: Exclude<Preset, 'custom'>) {
  const to = new Date()
  if (p === 'All') return { from: new Date(EPOCH), to }
  const days = { '1D': 1, '7D': 7, '14D': 14, '30D': 30 }[p]
  const from = new Date(to.getTime() - days * 86400_000)
  if (p !== '1D') from.setHours(0, 0, 0, 0)
  return { from, to }
}
