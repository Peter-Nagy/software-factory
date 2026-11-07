import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Fetch now and every `ms` while the tab is visible; `reload()` refetches immediately.
 * `deps` identify what is loaded (changing them clears the data); `ms` only changes the pace, and may depend on
 * the data (e.g. faster while something is running).
 */
export function usePoll<T>(load: () => Promise<T>, ms: number | ((data: T | null) => number), deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const pace = typeof ms === "function" ? ms(data) : ms
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
  // oxlint-disable-next-line react-hooks/exhaustive-deps
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
    }, pace)
    const onVisible = () => document.visibilityState === "visible" && void reload()
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [pace, reload])

  return { data, error, reload }
}
