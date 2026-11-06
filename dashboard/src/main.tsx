import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { applySystemTheme } from "@/lib/theme"
import "./index.css"
import App from "./App.tsx"

applySystemTheme()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
      <Toaster position="bottom-center" />
    </TooltipProvider>
  </StrictMode>,
)
