import { Archive, ChevronRight, Plus, Sparkles } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { NewPlanDialog } from "@/components/dialogs"
import { PlanView } from "@/components/plan-view"
import { Button } from "@/components/ui/button"
import { PageHeader, ProjectAvatar } from "@/components/visual"
import { api } from "@/lib/api"
import { useFactory } from "@/lib/factory"
import { ago } from "@/lib/format"
import { Link, navigate } from "@/lib/router"

const PLAN_STATE: Record<string, string> = {
  drafting: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  thinking: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  executing: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  executed: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  failed: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
}

export function PlansPage() {
  const { state } = useFactory()
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-6">
      <PageHeader title="Plans" eyebrow="Talk an idea through with the planner, then execute it" actions={<Button onClick={() => setOpen(true)}><Plus /> New plan</Button>} />
      {state.plans.length === 0 ? (
        <div className="rounded-3xl border border-dashed p-12 text-center text-sm text-muted-foreground">No plans yet. Describe an idea, discuss it with the planner, then press Execute.</div>
      ) : (
        <div className="overflow-hidden rounded-3xl border bg-card shadow-elevation">
          <ul className="divide-y">
            {state.plans.map((p) => (
              <li key={p.id}>
                <Link href={`/plans/${p.id}`} className="flex items-center gap-3.5 px-4 py-3.5 text-sm transition-colors hover:bg-muted/50 sm:px-5">
                  {p.projectId ? <ProjectAvatar id={p.projectId} /> : <span className="bg-hero inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-white"><Sparkles className="size-4" /></span>}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{p.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{p.target === "new" ? "New project" : p.projectId}{p.focus === "goals" ? " · goals" : ""} · {ago(p.updatedAt)}</p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${PLAN_STATE[p.state] ?? "bg-muted text-muted-foreground"}`}>{p.state}</span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <NewPlanDialog open={open} onOpenChange={setOpen} projects={state.projects} />
    </div>
  )
}

export function PlanPage({ id }: { id: number }) {
  const { state, reload } = useFactory()
  const plan = state.plans.find((p) => p.id === id)
  const archive = async () => {
    if (!window.confirm("Archive this plan? Nothing gets built.")) return
    try {
      await api("POST", `plans/${id}/archive`)
      await reload()
      navigate("/plans")
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<><Link href="/plans" className="hover:text-foreground">Plans</Link>{plan?.projectId && <> · <Link href={`/projects/${encodeURIComponent(plan.projectId)}`} className="hover:text-foreground">{plan.projectId}</Link></>}</>}
        title={plan?.title ?? `Plan ${id}`}
        actions={plan && !["executed", "executing", "thinking"].includes(plan.state) ? <Button variant="outline" size="sm" onClick={archive}><Archive /> Archive</Button> : undefined}
      >
        {plan && (
          <div className="mt-2 flex gap-1.5">
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{plan.target === "new" ? "New project" : plan.focus === "goals" ? "Goals" : "Change"}</span>
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${PLAN_STATE[plan.state] ?? "bg-muted text-muted-foreground"}`}>{plan.state}</span>
          </div>
        )}
      </PageHeader>
      <PlanView planId={id} owner={state.owner} onChanged={reload} />
    </div>
  )
}
