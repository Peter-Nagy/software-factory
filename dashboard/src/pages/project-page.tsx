import { ExternalLink, Lightbulb, Pause, Play, Plus, Sparkles } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Board } from "@/components/board"
import { AddTaskDialog, NewPlanDialog } from "@/components/dialogs"
import { Markdown } from "@/components/markdown"
import { QuestionCard } from "@/components/question-card"
import { TaskSheet } from "@/components/task-sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { api, enc, type ProjectDetail, type Task } from "@/lib/api"
import { useFactory } from "@/lib/factory"
import { ago, repoUrl } from "@/lib/format"
import { Link } from "@/lib/router"
import { usePoll } from "@/lib/use-poll"

export function ProjectPage({ id }: { id: string }) {
  const { state, reload: reloadState } = useFactory()
  const { data, error, reload } = usePoll(() => api<ProjectDetail>("GET", `projects/${enc(id)}`), 8000, [id])
  const [open, setOpen] = useState<Task | null>(null)
  const [addTask, setAddTask] = useState(false)
  const [plan, setPlan] = useState<"change" | "goals" | null>(null)
  const refresh = async () => {
    await Promise.all([reload(), reloadState()])
  }

  if (error && !data) return <p className="text-sm text-muted-foreground">{error}</p>
  if (!data) return <Skeleton className="h-96 w-full" />
  const { project, tasks, product, plans, questions } = data
  const paused = project.state === "paused"
  const activePlans = plans.filter((p) => p.state !== "executed")

  const toggle = async () => {
    try {
      await api("POST", `projects/${enc(project.id)}/state`, { state: paused ? "active" : "paused" })
      toast.success(paused ? "Resumed: the factory picks up its tasks again" : "Paused: running tasks finish, nothing new starts")
      await refresh()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <p className="text-xs text-muted-foreground">
            <Link href="/projects" className="hover:underline">Projects</Link> /
          </p>
          <h1 className="text-xl font-semibold">{project.id}</h1>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary">{project.kind}</Badge>
          <Badge variant={paused ? "destructive" : "outline"}>{project.state}</Badge>
          <Badge variant="outline">priority {project.priority}</Badge>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" size="sm" render={<a href={repoUrl(project.owner, project.id)} target="_blank" rel="noopener noreferrer" />}>
            Repo <ExternalLink />
          </Button>
          <Button variant="outline" size="sm" onClick={toggle}>{paused ? <><Play /> Resume</> : <><Pause /> Pause</>}</Button>
          <Button variant="outline" size="sm" onClick={() => setPlan("change")}><Lightbulb /> Plan a change</Button>
          <Button size="sm" onClick={() => setAddTask(true)}><Plus /> Task</Button>
        </div>
      </div>

      {questions.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {questions.map((q) => <QuestionCard key={q.id} q={q} timezone={state.timezone} onDone={refresh} />)}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>Goals and details</CardTitle>
              <CardDescription>docs/PRODUCT.md on main</CardDescription>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setPlan("goals")}><Sparkles /> Iterate with the agent</Button>
          </CardHeader>
          <CardContent className="max-h-[32rem] overflow-y-auto">
            {product ? <Markdown text={product} /> : (
              <p className="text-sm text-muted-foreground">No docs/PRODUCT.md yet. Iterate with the agent to write the project's goals; they land in the repo through a reviewed PR.</p>
            )}
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Progress</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-3 gap-3 text-center">
              {[
                { n: tasks.filter((t) => !["done", "cancelled"].includes(t.state)).length, label: "open" },
                { n: data.merged30d, label: "merged (30 d)" },
                { n: tasks.filter((t) => t.state === "parked" || t.state === "blocked").length, label: "need you" },
              ].map((s) => (
                <div key={s.label} className="rounded-lg bg-muted/60 py-3">
                  <div className="text-2xl font-semibold tabular-nums">{s.n}</div>
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Plans</CardTitle></CardHeader>
            <CardContent>
              {plans.length === 0 ? <p className="text-sm text-muted-foreground">No plans for this project yet.</p> : (
                <ul className="divide-y text-sm">
                  {[...activePlans, ...plans.filter((p) => p.state === "executed")].slice(0, 8).map((p) => (
                    <li key={p.id}>
                      <Link href={`/plans/${p.id}`} className="flex items-center gap-2 py-2 hover:underline">
                        <span className="truncate">{p.title}</span>
                        {p.focus === "goals" && <Badge variant="secondary" className="h-4.5 text-[10px]">goals</Badge>}
                        <Badge variant="outline" className="ml-auto h-4.5 text-[10px]">{p.state}</Badge>
                        <span className="text-xs text-muted-foreground">{ago(p.updatedAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Board</h2>
        <Board tasks={tasks} owner={project.owner} questions={state.questions} showProject={false} onOpen={setOpen} />
      </section>

      <TaskSheet task={open} owner={project.owner} timezone={state.timezone} questions={state.questions} onClose={() => setOpen(null)} onChanged={refresh} />
      <AddTaskDialog project={project} open={addTask} onOpenChange={setAddTask} onCreated={refresh} />
      {plan && <NewPlanDialog key={plan} open onOpenChange={(o) => !o && setPlan(null)} projects={state.projects} project={project} focus={plan} />}
    </div>
  )
}
