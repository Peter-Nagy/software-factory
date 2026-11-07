import { AlertTriangle, ArrowUp, Bot, Check, ExternalLink, GitPullRequest, Hammer, RotateCw, ScanSearch, Sparkles, X } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Markdown } from "@/components/markdown"
import { PlanView } from "@/components/plan-view"
import { QuestionCard } from "@/components/question-card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { ProjectAvatar, SectionTitle, StatusPill } from "@/components/visual"
import { api, enc, type IssueDetail, type Task } from "@/lib/api"
import { useFactory } from "@/lib/factory"
import { prUrl, when } from "@/lib/format"
import { Link } from "@/lib/router"
import { usePoll } from "@/lib/use-poll"
import { cn } from "@/lib/utils"

/** Where a task is on its way to main, for the progress line. */
const STEPS = [
  { key: "queued", label: "Queued", states: ["queued"] },
  { key: "building", label: "Building", states: ["building", "fixing", "blocked", "parked"] },
  { key: "review", label: "Review", states: ["in_review", "merging", "deploying"] },
  { key: "done", label: "Merged", states: ["done"] },
] as const

function Progress({ task }: { task: Task }) {
  const at = STEPS.findIndex((s) => (s.states as readonly string[]).includes(task.state))
  const trouble = task.state === "parked" || task.state === "blocked"
  return (
    <ol className="flex items-center gap-1.5 sm:gap-2">
      {STEPS.map((s, i) => {
        const done = i < at || task.state === "done"
        const current = i === at && task.state !== "done"
        return (
          <li key={s.key} className="flex flex-1 items-center gap-1.5 sm:gap-2">
            <span
              className={cn(
                "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1 transition-colors",
                done && "bg-emerald-500 text-white ring-emerald-500",
                current && !trouble && "bg-accent-gradient text-white ring-transparent",
                current && trouble && (task.state === "parked" ? "bg-rose-500 text-white ring-rose-500" : "bg-amber-500 text-white ring-amber-500"),
                !done && !current && "bg-muted text-muted-foreground ring-border",
              )}
            >
              {done ? <Check className="size-3.5" /> : current && trouble ? "!" : i + 1}
            </span>
            <span className={cn("hidden text-sm whitespace-nowrap sm:inline", current ? "font-medium" : "text-muted-foreground")}>{s.label}</span>
            {i < STEPS.length - 1 && <span className={cn("h-0.5 flex-1 rounded-full", i < at || task.state === "done" ? "bg-emerald-500/60" : "bg-border")} />}
          </li>
        )
      })}
    </ol>
  )
}

const ROLE_ICON: Record<string, typeof Bot> = { implementer: Hammer, reviewer: ScanSearch, planner: Sparkles }

export function IssuePage({ projectId, number }: { projectId: string; number: number }) {
  const { state, reload: reloadState } = useFactory()
  const ref = enc(`${projectId}#${number}`)
  const { data, error, reload } = usePoll(() => api<IssueDetail>("GET", `issues/${ref}`), 6000, [ref])
  const [ask, setAsk] = useState("")
  const [starting, setStarting] = useState(false)
  const refresh = async () => {
    await Promise.all([reload(), reloadState()])
  }

  if (error && !data) return <p className="text-sm text-muted-foreground">{error}</p>
  if (!data) return <div className="space-y-4"><Skeleton className="h-40 w-full rounded-3xl" /><Skeleton className="h-96 w-full rounded-3xl" /></div>
  const { project, task, issue, runs, conversation } = data
  const title = issue?.title ?? task?.title ?? `Issue #${number}`
  const pr = task ? prUrl(project.owner, task) : null
  const answered = data.questions.filter((q) => q.answer !== null)

  const act = async (what: "retry" | "cancel") => {
    if (!task) return
    if (what === "cancel" && !window.confirm(`Cancel ${task.id}? The issue stays open on GitHub.`)) return
    try {
      await api("POST", `tasks/${enc(task.id)}/${what}`)
      toast.success(what === "retry" ? "Back in the queue" : "Cancelled")
      await refresh()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const startConversation = async () => {
    setStarting(true)
    try {
      await api("POST", `issues/${ref}/conversation`, { message: ask.trim() || undefined })
      setAsk("")
      await reload()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-[2rem] border bg-card p-5 shadow-elevation sm:p-7">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <ProjectAvatar id={project.id} className="size-6 rounded-md text-[9px]" />
          <Link href={`/projects/${enc(project.id)}`} className="hover:text-foreground">{project.id}</Link>
          <span>· #{number}</span>
        </div>
        <h1 className="mt-3 text-2xl leading-tight font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {task ? <StatusPill state={task.state} /> : <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">Not tracked by the factory</span>}
          {task && task.risk !== "low" && <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", task.risk === "high" ? "bg-rose-500/12 text-rose-700 dark:text-rose-300" : "bg-muted text-muted-foreground")}>{task.risk} risk</span>}
          {task?.area && <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">{task.area}</span>}
          {task && task.attempt > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"><RotateCw className="size-3" />attempt {task.attempt}{task.fixRounds ? ` · ${task.fixRounds} fix${task.fixRounds > 1 ? "es" : ""}` : ""}</span>}
          {issue?.state === "closed" && <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">closed on GitHub</span>}
        </div>
        {task && <div className="mt-6"><Progress task={task} /></div>}
        <div className="mt-6 flex flex-wrap gap-2">
          {issue && <Button size="sm" variant="outline" render={<a href={issue.url} target="_blank" rel="noopener noreferrer" />}>GitHub issue <ExternalLink /></Button>}
          {pr && <Button size="sm" variant="outline" render={<a href={pr} target="_blank" rel="noopener noreferrer" />}><GitPullRequest /> PR #{task!.prNumber}</Button>}
          {task?.state === "parked" && <Button size="sm" onClick={() => act("retry")}><RotateCw /> Retry</Button>}
          {task && ["queued", "blocked", "parked"].includes(task.state) && <Button size="sm" variant="destructive" onClick={() => act("cancel")}><X /> Cancel task</Button>}
        </div>
      </section>

      {state.questions.filter((q) => q.taskId === task?.id).map((q) => <QuestionCard key={q.id} q={q} timezone={state.timezone} onDone={refresh} />)}

      {task?.lastFailure && task.state !== "done" && (
        <section className={cn("rounded-3xl border p-5", task.state === "parked" ? "border-rose-500/30 bg-rose-500/5" : "bg-card")}>
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className={cn("size-4", task.state === "parked" ? "text-rose-500" : "text-amber-500")} />
            {task.state === "parked" ? "Why it parked" : "Last failure"}
          </div>
          <pre className="max-h-72 overflow-auto rounded-2xl bg-background/70 p-4 font-mono text-xs whitespace-pre-wrap">{task.lastFailure}</pre>
          {task.state === "parked" && <p className="mt-3 text-sm text-muted-foreground">Often the issue itself is the problem. Revise it with the planner below; applying it gives the task a fresh start.</p>}
        </section>
      )}

      <section>
        <SectionTitle>{conversation ? "Revise with the planner" : "Issue"}</SectionTitle>
        {conversation ? (
          <PlanView planId={conversation.id} owner={project.owner} onChanged={refresh} />
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <div className="rounded-3xl border bg-card p-5 shadow-elevation sm:p-6">
              {issue ? <Markdown text={issue.body || "_No description._"} /> : <p className="text-sm text-muted-foreground">Couldn't load the issue from GitHub{data.issueError ? `: ${data.issueError}` : "."}</p>}
            </div>
            <div className="bg-hero relative overflow-hidden rounded-3xl p-5 text-white shadow-elevation sm:p-6">
              <div className="flex items-center gap-2 font-semibold"><Sparkles className="size-4" /> Change it with the planner</div>
              <p className="mt-1.5 text-sm text-white/80">Describe what should change: scope, acceptance criteria, approach. The planner revises the issue with you; nothing changes on GitHub until you apply it.</p>
              <div className="relative mt-4">
                <Textarea
                  value={ask}
                  onChange={(e) => setAsk(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void startConversation()}
                  placeholder="e.g. Split out the CSV export, and require a test for quoted newlines"
                  className="min-h-24 border-white/25 bg-white/12 pr-12 text-white placeholder:text-white/60 dark:bg-white/12"
                />
                <Button size="icon-sm" aria-label="Start" className="absolute right-2 bottom-2 bg-white text-violet-700 hover:bg-white/90" disabled={starting} onClick={startConversation}>
                  <ArrowUp />
                </Button>
              </div>
              <p className="mt-2 text-xs text-white/70">One Sonnet run per message on your subscription.</p>
            </div>
          </div>
        )}
      </section>

      {task && (
        <section className="overflow-hidden rounded-3xl border bg-card shadow-elevation">
          <div className="px-5 pt-5"><SectionTitle count={runs.length}>Agent runs</SectionTitle></div>
          {runs.length === 0 ? <p className="px-5 pb-5 text-sm text-muted-foreground">No runs yet.</p> : (
            <ul className="divide-y">
              {runs.map((r) => {
                const Icon = ROLE_ICON[r.role] ?? Bot
                return (
                  <li key={r.id} className="flex items-start gap-3.5 px-5 py-3.5 text-sm">
                    <span className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-full", r.ok === 0 ? "bg-rose-500/12 text-rose-600 dark:text-rose-300" : "bg-primary/12 text-primary")}><Icon className="size-4" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium capitalize">{r.role} <span className="font-normal text-muted-foreground normal-case">· {r.model} · {r.ok === null ? "running" : r.ok ? "ok" : "failed"}</span></p>
                      {r.summary && <p className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">{r.summary}</p>}
                    </div>
                    <div className="shrink-0 text-right text-xs text-muted-foreground">
                      <p>{when(r.started_at, state.timezone)}</p>
                      <p>{r.finished_at ? `${Math.max(1, Math.round((r.finished_at - r.started_at) / 60))} min` : ""}{r.cost_usd != null ? ` · $${r.cost_usd.toFixed(2)}` : ""}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {answered.length > 0 && (
        <section className="rounded-3xl border bg-card p-5 shadow-elevation">
          <SectionTitle>Answered questions</SectionTitle>
          <ul className="space-y-2 text-sm">
            {answered.map((q) => (
              <li key={q.id}><span className="text-muted-foreground">{q.question.split("\n")[0]}</span> → <strong>{q.answer}</strong>{q.answered_by === "timeout" ? " (default)" : ""}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
