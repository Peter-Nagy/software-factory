import { AlertTriangle, GitPullRequest, MessageCircleQuestion, RotateCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { Question, Task } from "@/lib/api"
import { ago, COLUMNS, prUrl } from "@/lib/format"
import { Link } from "@/lib/router"
import { cn } from "@/lib/utils"

const RISK: Record<Task["risk"], string> = {
  low: "",
  medium: "",
  high: "border-red-500/40 text-red-600 dark:text-red-400",
}

function TaskCard({ task, owner, showProject, questions, onOpen }: { task: Task; owner: string; showProject: boolean; questions: Question[]; onOpen: (t: Task) => void }) {
  const pr = prUrl(owner, task)
  const waiting = questions.filter((q) => q.taskId === task.id)
  const working = task.state === "building" || task.state === "fixing" || task.state === "merging"
  return (
    <button
      type="button"
      onClick={() => onOpen(task)}
      className={cn(
        "group w-full rounded-lg border bg-card p-3 text-left text-sm shadow-xs transition hover:border-foreground/25 hover:shadow-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        task.state === "parked" && "border-red-500/30",
        task.state === "blocked" && "border-amber-500/40",
      )}
    >
      <div className="flex items-start gap-2">
        {working && <span className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-sky-500" aria-label="working" />}
        <span className="leading-snug font-medium">{task.title}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {showProject && (
          <Link href={`/projects/${encodeURIComponent(task.projectId)}`} onClick={(e) => e.stopPropagation()} className="font-medium text-foreground/80 hover:underline">
            {task.projectId}
          </Link>
        )}
        <span>#{task.issueNumber}</span>
        {pr && (
          <a href={pr} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5 hover:text-foreground">
            <GitPullRequest className="size-3" />{task.prNumber}
          </a>
        )}
        {task.attempt > 1 && <span className="inline-flex items-center gap-0.5"><RotateCw className="size-3" />try {task.attempt}</span>}
        {task.risk === "high" && <Badge variant="outline" className={cn("h-4.5 px-1.5 text-[10px]", RISK[task.risk])}>high risk</Badge>}
        {task.area && <Badge variant="secondary" className="h-4.5 px-1.5 text-[10px]">{task.area}</Badge>}
        <span className="ml-auto">{ago(task.updatedAt)}</span>
      </div>
      {waiting.length > 0 && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">
          <MessageCircleQuestion className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-2">{waiting[0]!.question}</span>
        </div>
      )}
      {task.state === "parked" && task.lastFailure && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-700 dark:text-red-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-2">{task.lastFailure.split("\n")[0]}</span>
        </div>
      )}
    </button>
  )
}

export function Board({ tasks, owner, questions, showProject, onOpen }: { tasks: Task[]; owner: string; questions: Question[]; showProject: boolean; onOpen: (t: Task) => void }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
      <div className="grid min-w-[1080px] grid-cols-6 gap-3">
        {COLUMNS.map((col) => {
          const items = tasks
            .filter((t) => col.states.includes(t.state))
            .sort((a, b) => (col.key === "done" ? b.updatedAt - a.updatedAt : b.priority - a.priority || a.createdAt - b.createdAt))
          return (
            <section key={col.key} className="flex min-h-40 flex-col rounded-xl bg-muted/50 p-2" aria-label={col.title}>
              <header className="flex items-center gap-2 px-1.5 pt-1 pb-2" title={col.hint}>
                <h3 className={cn("text-xs font-semibold tracking-wide uppercase", col.key === "blocked" && items.length ? "text-amber-700 dark:text-amber-400" : col.key === "parked" && items.length ? "text-red-700 dark:text-red-400" : "text-muted-foreground")}>
                  {col.title}
                </h3>
                <span className="text-xs text-muted-foreground tabular-nums">{items.length}</span>
              </header>
              <div className="flex flex-col gap-2">
                {items.map((t) => <TaskCard key={t.id} task={t} owner={owner} showProject={showProject} questions={questions} onOpen={onOpen} />)}
                {items.length === 0 && <p className="px-1.5 py-3 text-xs text-muted-foreground/70">{col.hint}</p>}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
