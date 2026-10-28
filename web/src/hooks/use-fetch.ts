import { useCallback, useEffect, useState } from 'react'

export function useFetch<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<Error>()
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps)
  useEffect(() => {
    let live = true
    setLoading(true)
    run()
      .then((d) => live && (setData(d), setError(undefined)))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [run, nonce])
  return { data, error, loading, reload: () => setNonce((n) => n + 1), setData }
}
