export const usd = (n: number) =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : '$0'

export const tokens = (n: number) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return `${Math.round(n)}`
}

export const duration = (seconds: number) => {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

export const sessionHref = (id: string, title: string) => `/sessions/${id}?${slug(title)}`

// "claude-opus-5-5" -> "Opus 5.5" using the server's pricing labels, longest prefix wins.
export function modelLabel(model: string, labels: Record<string, string>) {
  const match = Object.keys(labels)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  return match ? labels[match] : model.replace(/^claude-/, '')
}
