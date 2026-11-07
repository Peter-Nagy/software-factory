import { ArrowUpRight, Plus } from "lucide-react"
import { useState } from "react"
import { NewPlanDialog } from "@/components/dialogs"
import { Button } from "@/components/ui/button"
import { PageHeader, ProjectAvatar, projectGradient } from "@/components/visual"
import { useFactory } from "@/lib/factory"
import { Link } from "@/lib/router"

export function ProjectsPage() {
  const { state } = useFactory()
  const [newPlan, setNewPlan] = useState(false)
  return (
    <div className="space-y-6">
      <PageHeader title="Projects" eyebrow={`${state.projects.length} in the factory`} actions={<Button onClick={() => setNewPlan(true)}><Plus /> New project</Button>} />
      {state.projects.length === 0 ? (
        <div className="rounded-3xl border border-dashed p-12 text-center text-sm text-muted-foreground">No projects yet. Plan your first one with the agent.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {state.projects.map((p) => {
            const tasks = state.tasks.filter((t) => t.projectId === p.id)
            const open = tasks.filter((t) => !["done", "cancelled"].includes(t.state)).length
            const needsYou = tasks.filter((t) => t.state === "blocked" || t.state === "parked").length
            const done = tasks.filter((t) => t.state === "done").length
            const live = tasks.filter((t) => ["building", "fixing", "in_review", "merging"].includes(t.state)).length
            return (
              <Link key={p.id} href={`/projects/${encodeURIComponent(p.id)}`} className="group block overflow-hidden rounded-3xl border bg-card shadow-elevation transition-all duration-200 hover:-translate-y-0.5 hover:shadow-elevation-hover">
                <div className="relative h-24" style={{ background: projectGradient(p.id) }}>
                  <div className="absolute inset-0 bg-[radial-gradient(120%_100%_at_100%_0%,rgb(255_255_255/0.28),transparent_60%)]" />
                  <ArrowUpRight className="absolute top-4 right-4 size-5 text-white/80 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  {live > 0 && <span className="absolute bottom-3 left-4 inline-flex items-center gap-1.5 rounded-full bg-black/25 px-2.5 py-1 text-xs font-medium text-white backdrop-blur"><span className="size-1.5 animate-pulse rounded-full bg-white" />{live} working</span>}
                </div>
                <div className="px-5 pb-5">
                  <ProjectAvatar id={p.id} className="-mt-6 size-12 rounded-2xl text-sm ring-4 ring-card" />
                  <div className="mt-3 flex items-center gap-2">
                    <h3 className="truncate text-lg font-semibold tracking-tight">{p.id}</h3>
                    {p.state !== "active" && <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">{p.state}</span>}
                  </div>
                  <p className="text-sm text-muted-foreground">{p.kind} · priority {p.priority}</p>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                    {[{ n: open, l: "open" }, { n: done, l: "merged" }, { n: needsYou, l: "need you", warn: needsYou > 0 }].map((s) => (
                      <div key={s.l} className={`rounded-2xl py-2.5 ${s.warn ? "bg-amber-500/12 text-amber-700 dark:text-amber-300" : "bg-muted/60"}`}>
                        <div className="text-xl font-semibold tabular-nums">{s.n}</div>
                        <div className="text-[11px] text-muted-foreground">{s.l}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}
      <NewPlanDialog open={newPlan} onOpenChange={setNewPlan} projects={state.projects} />
    </div>
  )
}
