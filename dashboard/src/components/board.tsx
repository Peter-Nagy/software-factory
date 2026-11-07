import { AlertTriangle, GitPullRequest, MessageCircleQuestion, RotateCw } from "lucide-react"
import { ProjectAvatar, STATE_TONE, StatusDot } from "@/components/visual"
import type { Question, Task } from "@/lib/api"
import { ago, COLUMNS, issuePath, prUrl } from "@/lib/format"
import { Link, navigate } from "@/lib/router"
import { cn } from "@/lib/utils"

function TaskCard({ task, owner, showProject, questions }: { task: Task; owner: string; showProject: boolean; questions: Question[] }) {
  const pr = prUrl(owner, task)
  const waiting = questions.filter((q) => q.taskId === task.id)
  const href = issuePath(task)
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => navigate(href)}
      onKeyDown={(e) => e.key === "Enter" && navigate(href)}
      className={cn(
        "group cursor-pointer rounded-2xl border bg-card p-3.5 text-left text-sm shadow-elevation transition-all duration-200 hover:-translate-y-0.5 hover:shadow-elevation-hover focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        task.state === "parked" && "border-rose-500/30",
        task.state === "blocked" && "border-amber-500/40",
      )}
    >
      <div className="flex items-start gap-2.5">
        {showProject && <ProjectAvatar id={task.projectId} className="size-7 rounded-lg text-[10px]" />}
        <div className="min-w-0 flex-1">
          <p className="leading-snug font-medium">{task.title}</p>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            {showProject && (
              <Link href={`/projects/${encodeURIComponent(task.projectId)}`} onClick={(e) => e.stopPropagation()} className="truncate hover:text-foreground">
                {task.projectId}
              </Link>
            )}
            <span className="shrink-0">#{task.issueNumber}</span>
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <StatusDot state={task.state} />
        {pr && (
          <a href={pr} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 hover:text-foreground">
            <GitPullRequest className="size-3" />{task.prNumber}
          </a>
        )}
        {task.attempt > 1 && <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5"><RotateCw className="size-3" />try {task.attempt}</span>}
        {task.risk === "high" && <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-rose-600 dark:text-rose-300">high risk</span>}
        {task.area && <span className="rounded-full bg-muted px-2 py-0.5">{task.area}</span>}
        <span className="ml-auto">{ago(task.updatedAt)}</span>
      </div>
      {waiting.length > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-200">
          <MessageCircleQuestion className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-2">{waiting[0]!.question}</span>
        </div>
      )}
      {task.state === "parked" && task.lastFailure && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-rose-500/8 p-2.5 text-xs text-rose-700 dark:text-rose-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-2">{task.lastFailure.split("\n")[0]}</span>
        </div>
      )}
    </div>
  )
}

const COLUMN_STATE = { queued: "queued", building: "building", review: "in_review", blocked: "blocked", parked: "parked", done: "done" } as const

export function Board({ tasks, owner, questions, showProject }: { tasks: Task[]; owner: string; questions: Question[]; showProject: boolean }) {
  return (
    <div className="-mx-4 snap-x snap-mandatory overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6 lg:snap-none">
      <div className="grid auto-cols-[minmax(280px,85vw)] grid-flow-col gap-3 sm:auto-cols-[300px] xl:grid-flow-row xl:grid-cols-6">
        {COLUMNS.map((col) => {
          const items = tasks
            .filter((t) => col.states.includes(t.state))
            .sort((a, b) => (col.key === "done" ? b.updatedAt - a.updatedAt : b.priority - a.priority || a.createdAt - b.createdAt))
          const tone = STATE_TONE[COLUMN_STATE[col.key as keyof typeof COLUMN_STATE]]
          return (
            <section key={col.key} className="flex min-h-48 snap-start flex-col rounded-3xl bg-muted/45 p-2.5 ring-1 ring-border/50 ring-inset" aria-label={col.title}>
              <header className="flex items-center gap-2 px-1.5 pt-1 pb-3" title={col.hint}>
                <span className={cn("size-2 rounded-full", tone.dot)} />
                <h3 className="text-sm font-semibold">{col.title}</h3>
                <span className="ml-auto rounded-full bg-card px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums shadow-xs">{items.length}</span>
              </header>
              <div className="flex flex-col gap-2.5">
                {items.map((t) => <TaskCard key={t.id} task={t} owner={owner} showProject={showProject} questions={questions} />)}
                {items.length === 0 && <p className="rounded-2xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground/80">{col.hint}</p>}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
