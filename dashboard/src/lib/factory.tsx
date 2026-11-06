import { createContext, useContext } from "react"
import type { FactoryState } from "./api"

/** The overview state, polled once by the app shell and shared by every page. */
export const FactoryContext = createContext<{ state: FactoryState; reload: () => Promise<void> } | null>(null)

export function useFactory() {
  const ctx = useContext(FactoryContext)
  if (!ctx) throw new Error("useFactory outside the app shell")
  return ctx
}
