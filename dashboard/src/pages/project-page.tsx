import { ChevronRight, ExternalLink, Lightbulb, Pause, Play, Plus, Sparkles } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Board } from "@/components/board"
import { AddTaskDialog, NewPlanDialog } from "@/components/dialogs"
import { Markdown } from "@/components/markdown"
import { QuestionCard } from "@/components/question-card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ProjectAvatar, projectGradient, SectionTitle } from "@/components/visual"
import { api, enc, type ProjectDetail } from "@/lib/api"
import { useFactory } from "@/lib/factory"
import { ago, repoUrl } from "@/lib/format"
import { Link } from "@/lib/router"
import { usePoll } from "@/lib/use-poll"

export function ProjectPage({ id }: { id: string }) {
  const { state, reload: reloadState } = useFactory()
  const { data, error, reload } = usePoll(() => api<ProjectDetail>("GET", `projects/${enc(id)}`), 8000, [id])
  const [addTask, setAddTask] = useState(false)
  const [plan, setPlan] = useState<"change" | "goals" | null>(null)
  const refresh = async () => {
    await Promise.all([reload(), reloadState()])
  }

  if (error && !data) return <p className="text-sm text-muted-foreground">{error}</p>
  if (!data) return <div className="space-y-4"><Skeleton className="h-44 w-full rounded-[2rem]" /><Skeleton className="h-96 w-full rounded-3xl" /></div>
  const { project, tasks, product, plans, questions } = data
  const paused = project.state === "paused"
  const activePlans = plans.filter((p) => p.state !== "executed")
  const open = tasks.filter((t) => !["done", "cancelled"].includes(t.state)).length
  const needYou = tasks.filter((t) => t.state === "parked" || t.state === "blocked").length

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
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-[2rem] text-white shadow-elevation">
        <div className="absolute inset-0" style={{ background: projectGradient(project.id) }} />
        <div className="absolute inset-0 bg-[radial-gradient(90%_120%_at_100%_0%,rgb(255_255_255/0.25),transparent_55%),linear-gradient(to_top,rgb(0_0_0/0.25),transparent_60%)]" />
        <div className="relative p-6 sm:p-8">
          <Link href="/projects" className="text-sm text-white/75 hover:text-white">Projects</Link>
          <div className="mt-3 flex flex-wrap items-end gap-4">
            <ProjectAvatar id={project.id} className="size-16 rounded-2xl text-lg ring-2 ring-white/30" />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-3xl font-semibold tracking-tight sm:text-4xl">{project.id}</h1>
              <p className="mt-1 text-sm text-white/80">{project.kind} · priority {project.priority}{paused ? " · paused" : ""}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="border-white/25 bg-white/15 text-white hover:bg-white/25 hover:text-white dark:bg-white/15" render={<a href={repoUrl(project.owner, project.id)} target="_blank" rel="noopener noreferrer" />}>
                Repo <ExternalLink />
              </Button>
              <Button size="sm" variant="outline" className="border-white/25 bg-white/15 text-white hover:bg-white/25 hover:text-white dark:bg-white/15" onClick={toggle}>
                {paused ? <><Play /> Resume</> : <><Pause /> Pause</>}
              </Button>
            </div>
          </div>
          <div className="mt-6 grid grid-cols-3 gap-2 sm:max-w-md">
            {[{ n: open, l: "open" }, { n: data.merged30d, l: "merged · 30 d" }, { n: needYou, l: "need you" }].map((s) => (
              <div key={s.l} className="rounded-2xl bg-white/14 px-3 py-2.5 ring-1 ring-white/15 backdrop-blur">
                <div className="text-2xl font-semibold tracking-tight tabular-nums">{s.n}</div>
                <div className="text-[11px] text-white/75">{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setAddTask(true)}><Plus /> Task</Button>
        <Button variant="outline" onClick={() => setPlan("change")}><Lightbulb /> Plan a change</Button>
        <Button variant="outline" onClick={() => setPlan("goals")}><Sparkles /> Iterate on goals</Button>
      </div>

      {questions.length > 0 && (
        <section>
          <SectionTitle count={questions.length}>Needs you</SectionTitle>
          <div className="grid gap-3 md:grid-cols-2">
            {questions.map((q) => <QuestionCard key={q.id} q={q} timezone={state.timezone} onDone={refresh} />)}
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="rounded-3xl border bg-card p-5 shadow-elevation sm:p-6">
          <SectionTitle action={<Button size="sm" variant="secondary" onClick={() => setPlan("goals")}><Sparkles /> Iterate with the agent</Button>}>Goals and details</SectionTitle>
          <div className="max-h-[32rem] overflow-y-auto pr-1">
            {product ? <Markdown text={product} /> : (
              <p className="text-sm text-muted-foreground">No docs/PRODUCT.md yet. Iterate with the agent to write the project's goals; they land in the repo through a reviewed PR.</p>
            )}
          </div>
        </section>
        <section className="rounded-3xl border bg-card p-5 shadow-elevation sm:p-6">
          <SectionTitle count={plans.length}>Plans</SectionTitle>
          {plans.length === 0 ? <p className="text-sm text-muted-foreground">No plans for this project yet.</p> : (
            <ul className="-mx-2 space-y-1">
              {[...activePlans, ...plans.filter((p) => p.state === "executed")].slice(0, 8).map((p) => (
                <li key={p.id}>
                  <Link href={`/plans/${p.id}`} className="flex items-center gap-3 rounded-2xl px-2 py-2.5 text-sm transition-colors hover:bg-muted/60">
                    <span className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full ${p.focus === "goals" ? "bg-fuchsia-500/12 text-fuchsia-600 dark:text-fuchsia-300" : "bg-violet-500/12 text-violet-600 dark:text-violet-300"}`}>
                      {p.focus === "goals" ? <Sparkles className="size-4" /> : <Lightbulb className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{p.title}</p>
                      <p className="text-xs text-muted-foreground">{p.state} · {ago(p.updatedAt)}</p>
                    </div>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section>
        <SectionTitle count={open}>Board</SectionTitle>
        <Board tasks={tasks} owner={project.owner} questions={state.questions} showProject={false} />
      </section>

      <AddTaskDialog project={project} open={addTask} onOpenChange={setAddTask} onCreated={refresh} />
      {plan && <NewPlanDialog key={plan} open onOpenChange={(o) => !o && setPlan(null)} projects={state.projects} project={project} focus={plan} />}
    </div>
  )
}
