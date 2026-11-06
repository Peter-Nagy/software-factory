import { FolderGit2, Plus } from "lucide-react"
import { useState } from "react"
import { NewPlanDialog } from "@/components/dialogs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useFactory } from "@/lib/factory"
import { Link } from "@/lib/router"

export function ProjectsPage() {
  const { state } = useFactory()
  const [newPlan, setNewPlan] = useState(false)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Projects</h1>
        <Button size="sm" className="ml-auto" onClick={() => setNewPlan(true)}>
          <Plus /> New project
        </Button>
      </div>
      {state.projects.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">No projects yet. Plan your first one with the agent.</CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {state.projects.map((p) => {
            const tasks = state.tasks.filter((t) => t.projectId === p.id)
            const open = tasks.filter((t) => !["done", "cancelled"].includes(t.state))
            const needsYou = tasks.filter((t) => t.state === "blocked" || t.state === "parked").length
            const done = tasks.filter((t) => t.state === "done").length
            return (
              <Link key={p.id} href={`/projects/${encodeURIComponent(p.id)}`} className="group">
                <Card className="h-full transition group-hover:border-foreground/25 group-hover:shadow-sm">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <FolderGit2 className="size-4 text-muted-foreground" />
                      {p.id}
                    </CardTitle>
                    <CardDescription className="flex flex-wrap gap-1.5 pt-1">
                      <Badge variant="secondary">{p.kind}</Badge>
                      {p.state !== "active" && <Badge variant="outline">{p.state}</Badge>}
                      <Badge variant="outline">priority {p.priority}</Badge>
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex gap-4 text-sm">
                    <span><strong className="tabular-nums">{open.length}</strong> <span className="text-muted-foreground">open</span></span>
                    <span><strong className="tabular-nums">{done}</strong> <span className="text-muted-foreground">merged</span></span>
                    {needsYou > 0 && <span className="text-amber-700 dark:text-amber-400"><strong className="tabular-nums">{needsYou}</strong> need you</span>}
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
      <NewPlanDialog open={newPlan} onOpenChange={setNewPlan} projects={state.projects} />
    </div>
  )
}
