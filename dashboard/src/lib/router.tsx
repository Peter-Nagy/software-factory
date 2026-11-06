import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react"

// A tiny router on the History API (the server falls back to index.html for any path).
const listeners = new Set<() => void>()

export function navigate(path: string): void {
  if (path === window.location.pathname) return
  window.history.pushState(null, "", path)
  listeners.forEach((l) => l())
  window.scrollTo(0, 0)
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => {
    const on = () => setPath(window.location.pathname)
    listeners.add(on)
    window.addEventListener("popstate", on)
    return () => {
      listeners.delete(on)
      window.removeEventListener("popstate", on)
    }
  }, [])
  return path
}

/** Match "/projects/:id" style patterns; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean)
  const a = path.split("/").filter(Boolean)
  if (p.length !== a.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(":")) params[p[i]!.slice(1)] = decodeURIComponent(a[i]!)
    else if (p[i] !== a[i]) return null
  }
  return params
}

export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e)
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigate(href)
      }}
      {...rest}
    />
  )
}
