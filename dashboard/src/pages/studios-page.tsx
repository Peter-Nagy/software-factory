import { ArrowUp, ChevronRight, Lightbulb, Rocket, Sparkles } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { PageHeader } from "@/components/visual"
import { PhaseIcon } from "@/pages/studio-page"
import { api, type Studio, type StudioSummary } from "@/lib/api"
import { ago } from "@/lib/format"
import { Link, navigate } from "@/lib/router"
import { usePoll } from "@/lib/use-poll"
import { cn } from "@/lib/utils"

const STEPS = "Brief → Research → Product → Design → Architecture → Spikes → Build plan"

export function StudiosPage() {
  const { data } = usePoll(() => api<StudioSummary[]>("GET", "studios"), 8000)
  const [idea, setIdea] = useState("")
  const [title, setTitle] = useState("")
  const [mode, setMode] = useState<"guided" | "autopilot">("guided")
  const [busy, setBusy] = useState(false)

  const start = async () => {
    if (!idea.trim()) return
    setBusy(true)
    try {
      const name = title.trim() || idea.trim().split(/[.!?\n]/)[0]!.replace(/^(i want to |i'd like to |let's )/i, "").slice(0, 60)
      const s = await api<Studio>("POST", "studios", { title: name.charAt(0).toUpperCase() + name.slice(1), message: idea.trim(), mode })
      navigate(`/studio/${s.id}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Studio" eyebrow="From an idea to a plan the factory can build" />

      <section className="bg-hero relative overflow-hidden rounded-[2rem] p-6 text-white shadow-[0_30px_60px_-30px_oklch(0.45_0.25_280/0.8)] sm:p-8">
        <div className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-white/10 blur-3xl" />
        <div className="relative max-w-3xl">
          <div className="flex items-center gap-2 text-sm text-white/80"><Lightbulb className="size-4" /> New idea</div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">What do you want to make?</h2>
          <p className="mt-1.5 text-sm text-white/75">{STEPS}. Each step is a document you can comment on and discuss with its agent.</p>
          <div className="relative mt-5">
            <Textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void start()}
              placeholder="I want to create a running app that…"
              className="min-h-28 border-white/25 bg-white/12 pr-14 text-base text-white placeholder:text-white/55 dark:bg-white/12"
            />
            <Button size="icon" aria-label="Start" className="absolute right-2.5 bottom-2.5 bg-white text-violet-700 shadow-none hover:bg-white/90" disabled={busy || !idea.trim()} onClick={start}>
              <ArrowUp />
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name (optional)" className="h-9 max-w-56 border-white/25 bg-white/12 text-white placeholder:text-white/55 dark:bg-white/12" />
            <div className="inline-flex rounded-full bg-white/12 p-1 ring-1 ring-white/20">
              {(["guided", "autopilot"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)} className={cn("inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors", mode === m ? "bg-white text-violet-700" : "text-white/80 hover:text-white")}>
                  {m === "guided" ? <Sparkles className="size-3.5" /> : <Rocket className="size-3.5" />}
                  {m === "guided" ? "Guided" : "Autopilot"}
                </button>
              ))}
            </div>
            <span className="text-xs text-white/70">{mode === "guided" ? "You approve each step." : "Runs every step; stops at the go/no-go and the final plan."}</span>
          </div>
        </div>
      </section>

      {data && data.length > 0 && (
        <section className="overflow-hidden rounded-3xl border bg-card shadow-elevation">
          <ul className="divide-y">
            {data.map((s) => {
              const current = s.phases.find((p) => !["approved", "skipped"].includes(p.state))
              return (
                <li key={s.id}>
                  <Link href={`/studio/${s.id}`} className="flex items-center gap-4 px-5 py-4 text-sm transition-colors hover:bg-muted/50">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{s.title}</p>
                      <p className="text-xs text-muted-foreground">{s.mode === "autopilot" ? "Autopilot" : "Guided"} · {current ? `at ${current.phase === "plan" ? "build plan" : current.phase === "launch" ? "launch kit" : current.phase}` : "planned"} · {ago(s.updatedAt)}</p>
                    </div>
                    <div className="hidden items-center gap-1 sm:flex">
                      {s.phases.map((p) => <PhaseIcon key={p.phase} state={p.state} small />)}
                    </div>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
