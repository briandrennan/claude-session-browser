import { useCallback, useSyncExternalStore } from 'react'

// localStorage-backed state shared by every component using the same key (a Picker and
// its proposal's useTheme stay in sync). Tolerates storage being unavailable or junk.
const values = new Map<string, unknown>()
const listeners = new Map<string, Set<() => void>>()

function read<T>(key: string, initial: T, valid: (v: unknown) => v is T): T {
  if (values.has(key)) return values.get(key) as T
  let v = initial
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      if (valid(parsed)) v = parsed
    }
  } catch {
    /* storage unavailable or malformed */
  }
  values.set(key, v)
  return v
}

export function usePersisted<T>(key: string, initial: T, valid: (v: unknown) => v is T): [T, (v: T) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      let set = listeners.get(key)
      if (!set) listeners.set(key, (set = new Set()))
      set.add(cb)
      return () => void set.delete(cb)
    },
    [key],
  )
  const value = useSyncExternalStore(subscribe, () => read(key, initial, valid))
  const setValue = useCallback(
    (v: T) => {
      values.set(key, v)
      try {
        localStorage.setItem(key, JSON.stringify(v))
      } catch {
        /* storage unavailable */
      }
      listeners.get(key)?.forEach((cb) => cb())
    },
    [key],
  )
  return [value, setValue]
}

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')
const subscribeSystem = (cb: () => void) => {
  const q = darkQuery()
  q.addEventListener('change', cb)
  return () => q.removeEventListener('change', cb)
}
const systemMode = () => (darkQuery().matches ? 'dark' : 'light')

// Live OS color-scheme preference.
export function useSystemMode(): 'light' | 'dark' {
  return useSyncExternalStore(subscribeSystem, systemMode)
}
