import { CheckCircle2, Clock3, Hammer, ScanSearch } from "lucide-react"
import { useState } from "react"
import { Board } from "@/components/board"
import { QuestionCard } from "@/components/question-card"
import { UsageRings } from "@/components/usage"
import { ProjectAvatar, SectionTitle } from "@/components/visual"
import { useFactory } from "@/lib/factory"
import { greeting } from "@/lib/format"
import { cn } from "@/lib/utils"

export function BoardPage() {
  const { state, reload } = useFactory()
  const [project, setProject] = useState("all")
  const tasks = project === "all" ? state.tasks : state.tasks.filter((t) => t.projectId === project)
  const count = (states: string[]) => state.tasks.filter((t) => states.includes(t.state)).length
  const building = count(["building", "fixing"])
  const reviewing = count(["in_review", "merging", "deploying"])
  const queued = count(["queued"])
  const merged = count(["done"])
  const inFlight = building + reviewing
  const needsYou = state.questions.length + count(["parked"])

  const chips = [
    { icon: Hammer, n: building, label: "building" },
    { icon: ScanSearch, n: reviewing, label: "in review" },
    { icon: Clock3, n: queued, label: "queued" },
    { icon: CheckCircle2, n: merged, label: "merged" },
  ]

  return (
    <div className="space-y-8">
      <section className="bg-hero relative overflow-hidden rounded-[2rem] p-6 text-white shadow-[0_30px_60px_-30px_oklch(0.45_0.25_280/0.8)] sm:p-8">
        <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-white/10 blur-3xl" />
        <div className="relative flex flex-col gap-8 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-white/75">{greeting(state.timezone)}</p>
            <div className="mt-2 flex items-baseline gap-3">
              <span className="text-6xl font-semibold tracking-tighter tabular-nums sm:text-7xl">{inFlight}</span>
              <span className="text-lg text-white/85">{inFlight === 1 ? "task in flight" : "tasks in flight"}</span>
            </div>
            <p className="mt-2 max-w-md text-sm text-white/75">
              {state.pausedUntil ? "Paused: running work finishes, nothing new starts." : needsYou ? `${needsYou} thing${needsYou === 1 ? "" : "s"} need${needsYou === 1 ? "s" : ""} you. Everything else runs on its own.` : "Nothing needs you. The factory keeps going on its own."}
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {chips.map(({ icon: Icon, n, label }) => (
                <span key={label} className="inline-flex items-center gap-2 rounded-full bg-white/14 px-3.5 py-2 text-sm ring-1 ring-white/20 backdrop-blur">
                  <Icon className="size-4 text-white/80" />
                  <span className="font-semibold tabular-nums">{n}</span>
                  <span className="text-white/80">{label}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 justify-center rounded-3xl bg-white/10 p-4 ring-1 ring-white/15 backdrop-blur sm:p-5">
            <UsageRings state={state} />
          </div>
        </div>
      </section>

      {state.questions.length > 0 && (
        <section>
          <SectionTitle count={state.questions.length}>Needs you</SectionTitle>
          <div className="grid gap-3 md:grid-cols-2">
            {state.questions.map((q) => <QuestionCard key={q.id} q={q} timezone={state.timezone} onDone={reload} />)}
          </div>
        </section>
      )}

      <section>
        <SectionTitle count={tasks.filter((t) => t.state !== "done").length}>Board</SectionTitle>
        {state.projects.length > 1 && (
          <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6">
            {[{ id: "all" }, ...state.projects].map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProject(p.id)}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors",
                  project === p.id ? "border-transparent bg-foreground text-background" : "bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {p.id !== "all" && <ProjectAvatar id={p.id} className="size-5 rounded-md text-[8px]" />}
                {p.id === "all" ? "All projects" : p.id}
              </button>
            ))}
          </div>
        )}
        <Board tasks={tasks} owner={state.owner} questions={state.questions} showProject={project === "all"} />
      </section>
    </div>
  )
}
