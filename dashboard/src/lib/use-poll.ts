import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Fetch now and every `ms` while the tab is visible; `reload()` refetches immediately.
 * `deps` identify what is loaded (changing them clears the data); `ms` only changes the pace.
 */
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  const generation = useRef(0)

  const reload = useCallback(async () => {
    const gen = generation.current
    try {
      const value = await loadRef.current()
      if (gen === generation.current) {
        setData(value)
        setError(null)
      }
    } catch (e) {
      if (gen === generation.current) setError((e as Error).message)
    }
  }, [])

  // New identity: drop the old data and load at once.
  useEffect(() => {
    generation.current++
    setData(null)
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  // Pace: poll while visible, and refresh when the tab comes back.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload()
    }, ms)
    const onVisible = () => document.visibilityState === "visible" && void reload()
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [ms, reload])

  return { data, error, reload }
}
