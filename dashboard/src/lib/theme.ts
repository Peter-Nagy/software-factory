import { useEffect, useState } from "react"

const query = () => window.matchMedia("(prefers-color-scheme: dark)")

/** Follow the system light/dark setting: shadcn's dark styles key off a `.dark` class on <html>. */
export function applySystemTheme(): void {
  const set = () => document.documentElement.classList.toggle("dark", query().matches)
  set()
  query().addEventListener("change", set)
}

export function useSystemTheme(): "light" | "dark" {
  const [dark, setDark] = useState(query().matches)
  useEffect(() => {
    const q = query()
    const on = () => setDark(q.matches)
    q.addEventListener("change", on)
    return () => q.removeEventListener("change", on)
  }, [])
  return dark ? "dark" : "light"
}
