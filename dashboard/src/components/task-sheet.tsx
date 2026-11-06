import { ExternalLink } from "lucide-react"
import { toast } from "sonner"
import { QuestionCard } from "@/components/question-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { api, enc, type Question, type Task, type TaskDetail } from "@/lib/api"
import { issueUrl, prUrl, STATE_LABEL, when } from "@/lib/format"
import { usePoll } from "@/lib/use-poll"

interface Props {
  task: Task | null
  owner: string
  timezone: string
  questions: Question[]
  onClose: () => void
  onChanged: () => void
}

export function TaskSheet({ task, owner, timezone, questions, onClose, onChanged }: Props) {
  return (
    <Sheet open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {task && <Body task={task} owner={owner} timezone={timezone} questions={questions} onChanged={onChanged} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h4>
      {children}
    </div>
  )
}

function Body({ task, owner, timezone, questions, onChanged, onClose }: Omit<Props, "task"> & { task: Task }) {
  const { data } = usePoll(() => api<TaskDetail>("GET", `tasks/${enc(task.id)}`), 5000, [task.id])
  const t = data?.task ?? task
  const pr = prUrl(owner, t)
  const act = async (what: "retry" | "cancel") => {
    if (what === "cancel" && !window.confirm(`Cancel ${t.id}? The issue stays open on GitHub.`)) return
    try {
      await api("POST", `tasks/${enc(t.id)}/${what}`)
      toast.success(what === "retry" ? "Back in the queue" : "Cancelled")
      onChanged()
      if (what === "cancel") onClose()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const answered = data?.questions.filter((q) => q.answer !== null) ?? []
  return (
    <>
      <SheetHeader>
        <SheetDescription>
          {t.projectId} · #{t.issueNumber}
        </SheetDescription>
        <SheetTitle className="text-lg leading-snug">{t.title}</SheetTitle>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Badge>{STATE_LABEL[t.state]}</Badge>
          <Badge variant="outline">{t.risk} risk</Badge>
          {t.area && <Badge variant="secondary">{t.area}</Badge>}
          <Badge variant="outline">priority {t.priority}</Badge>
          {t.attempt > 0 && (
            <Badge variant="outline">
              attempt {t.attempt}
              {t.fixRounds ? `, ${t.fixRounds} fix round${t.fixRounds > 1 ? "s" : ""}` : ""}
            </Badge>
          )}
        </div>
      </SheetHeader>
      <div className="space-y-5 px-4 pb-6 text-sm">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" render={<a href={issueUrl(owner, t)} target="_blank" rel="noopener noreferrer" />}>
            Issue <ExternalLink />
          </Button>
          {pr && (
            <Button variant="outline" size="sm" render={<a href={pr} target="_blank" rel="noopener noreferrer" />}>
              PR #{t.prNumber} <ExternalLink />
            </Button>
          )}
          {t.state === "parked" && <Button size="sm" onClick={() => act("retry")}>Retry</Button>}
          {["queued", "blocked", "parked"].includes(t.state) && (
            <Button size="sm" variant="destructive" onClick={() => act("cancel")}>Cancel task</Button>
          )}
        </div>
        {questions
          .filter((q) => q.taskId === t.id)
          .map((q) => (
            <QuestionCard key={q.id} q={q} timezone={timezone} onDone={onChanged} />
          ))}
        {t.lastFailure && t.state !== "done" && (
          <Section title={t.state === "parked" ? "Why it parked" : "Last failure"}>
            <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">{t.lastFailure}</pre>
          </Section>
        )}
        {t.dependsOn.length > 0 && <p className="text-muted-foreground">Waits for {t.dependsOn.join(", ")}.</p>}
        <Separator />
        <Section title="Agent runs">
          {!data ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : data.runs.length === 0 ? (
            <p className="text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="space-y-2">
              {data.runs.map((r) => (
                <li key={r.id} className="rounded-md border p-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium">{r.role}</span>
                    <Badge variant="secondary" className="h-4.5 text-[10px]">{r.model}</Badge>
                    {r.ok === null ? (
                      <Badge className="h-4.5 text-[10px]">running</Badge>
                    ) : r.ok ? (
                      <span className="text-emerald-600 dark:text-emerald-400">ok</span>
                    ) : (
                      <span className="text-red-600 dark:text-red-400">failed</span>
                    )}
                    <span className="ml-auto text-muted-foreground">
                      {when(r.started_at, timezone)}
                      {r.finished_at ? ` · ${Math.round((r.finished_at - r.started_at) / 60) || "<1"} min` : ""}
                      {r.cost_usd != null ? ` · ~$${r.cost_usd.toFixed(2)}` : ""}
                    </span>
                  </div>
                  {r.summary && <p className="mt-1.5 line-clamp-3 text-xs text-muted-foreground">{r.summary}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>
        {answered.length > 0 && (
          <Section title="Answered questions">
            <ul className="space-y-1.5">
              {answered.map((q) => (
                <li key={q.id} className="text-xs">
                  <span className="text-muted-foreground">{q.question.split("\n")[0]}</span> → <strong>{q.answer}</strong>
                  {q.answered_by === "timeout" ? " (default)" : ""}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </>
  )
}
