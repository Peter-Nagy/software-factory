import { useState } from "react"
import { Board } from "@/components/board"
import { QuestionCard } from "@/components/question-card"
import { SimpleSelect } from "@/components/simple-select"
import { TaskSheet } from "@/components/task-sheet"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { UsageCard } from "@/components/usage"
import type { Task } from "@/lib/api"
import { useFactory } from "@/lib/factory"

export function BoardPage() {
  const { state, reload } = useFactory()
  const [open, setOpen] = useState<Task | null>(null)
  const [project, setProject] = useState("all")
  const tasks = project === "all" ? state.tasks : state.tasks.filter((t) => t.projectId === project)
  const working = state.tasks.filter((t) => ["building", "fixing", "in_review", "merging"].includes(t.state)).length
  const queued = state.tasks.filter((t) => t.state === "queued").length
  const merged = state.tasks.filter((t) => t.state === "done").length

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <UsageCard state={state} />
        <Card>
          <CardHeader>
            <CardTitle>Right now</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-3 text-center">
            {[
              { n: working, label: "working" },
              { n: queued, label: "queued" },
              { n: merged, label: "merged (30 d)" },
            ].map((s) => (
              <div key={s.label} className="rounded-lg bg-muted/60 py-3">
                <div className="text-2xl font-semibold tabular-nums">{s.n}</div>
                <div className="text-xs text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {state.questions.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">Needs you</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {state.questions.map((q) => <QuestionCard key={q.id} q={q} timezone={state.timezone} onDone={reload} />)}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">Board</h2>
          {state.projects.length > 1 && (
            <SimpleSelect value={project} onChange={setProject} className="h-7" ariaLabel="Project"
              options={[{ value: "all", label: "All projects" }, ...state.projects.map((p) => ({ value: p.id, label: p.id }))]} />
          )}
        </div>
        <Board tasks={tasks} owner={state.owner} questions={state.questions} showProject={project === "all"} onOpen={setOpen} />
      </section>

      <TaskSheet task={open} owner={state.owner} timezone={state.timezone} questions={state.questions} onClose={() => setOpen(null)} onChanged={reload} />
    </div>
  )
}
