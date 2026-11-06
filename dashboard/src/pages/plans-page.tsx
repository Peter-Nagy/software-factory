import { Archive, Plus } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { NewPlanDialog } from "@/components/dialogs"
import { PlanView } from "@/components/plan-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { api } from "@/lib/api"
import { useFactory } from "@/lib/factory"
import { ago } from "@/lib/format"
import { Link, navigate } from "@/lib/router"

export function PlansPage() {
  const { state } = useFactory()
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Plans</h1>
        <Button size="sm" className="ml-auto" onClick={() => setOpen(true)}><Plus /> New plan</Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {state.plans.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No plans yet. Start one: describe an idea, discuss it with the planner, then press Execute.</p>
          ) : (
            <ul className="divide-y">
              {state.plans.map((p) => (
                <li key={p.id}>
                  <Link href={`/plans/${p.id}`} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm hover:bg-muted/50">
                    <span className="font-medium">{p.title}</span>
                    <span className="text-muted-foreground">{p.target === "new" ? "new project" : p.projectId}</span>
                    {p.focus === "goals" && <Badge variant="secondary" className="h-4.5 text-[10px]">goals</Badge>}
                    <Badge variant="outline" className="ml-auto">{p.state}</Badge>
                    <span className="w-20 text-right text-xs text-muted-foreground">{ago(p.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <p className="text-xs text-muted-foreground">
            <Link href="/plans" className="hover:underline">Plans</Link>
            {plan?.projectId && <> · <Link href={`/projects/${encodeURIComponent(plan.projectId)}`} className="hover:underline">{plan.projectId}</Link></>}
          </p>
          <h1 className="text-lg font-semibold">{plan?.title ?? `Plan ${id}`}</h1>
        </div>
        {plan && (
          <div className="flex gap-1.5">
            <Badge variant="secondary">{plan.target === "new" ? "new project" : plan.focus === "goals" ? "goals" : "change"}</Badge>
            <Badge variant="outline">{plan.state}</Badge>
          </div>
        )}
        {plan && !["executed", "executing", "thinking"].includes(plan.state) && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={archive}><Archive /> Archive</Button>
        )}
      </div>
      <PlanView planId={id} owner={state.owner} onChanged={reload} />
    </div>
  )
}
