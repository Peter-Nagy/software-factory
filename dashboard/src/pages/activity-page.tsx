import { Bot, Hammer, ScanSearch, Sparkles } from "lucide-react"
import { UsagePanel } from "@/components/usage-panel"
import { PageHeader, SectionTitle } from "@/components/visual"
import { useFactory } from "@/lib/factory"
import { when } from "@/lib/format"
import { Link } from "@/lib/router"
import { cn } from "@/lib/utils"

function describe(kind: string, data: string): string {
  let d: Record<string, unknown> = {}
  try {
    d = JSON.parse(data) as Record<string, unknown>
  } catch {
    /* not JSON */
  }
  if (kind === "task.transition") return `${String(d.from)} → ${String(d.to)}`
  if (kind.startsWith("notify.")) return String(d.text ?? "")
  return Object.keys(d).length ? JSON.stringify(d).slice(0, 200) : ""
}

const ROLE: Record<string, { icon: typeof Bot; tone: string }> = {
  implementer: { icon: Hammer, tone: "bg-sky-500/12 text-sky-600 dark:text-sky-300" },
  reviewer: { icon: ScanSearch, tone: "bg-violet-500/12 text-violet-600 dark:text-violet-300" },
  planner: { icon: Sparkles, tone: "bg-fuchsia-500/12 text-fuchsia-600 dark:text-fuchsia-300" },
}

/** "studio:1:brief:standin" → "Studio 1 · brief (stand-in)"; "plan:3" → "Plan 3"; a task id stays as it is. */
function subjectLabel(subject: string | null | undefined): string {
  if (!subject) return "—"
  const [kind, id, phase, extra] = subject.split(":")
  if (kind === "studio") return `Studio ${id} · ${phase ?? ""}${extra === "standin" ? " (stand-in)" : ""}`
  if (kind === "plan") return `Plan ${id}`
  return subject
}

const taskHref = (id: string) => {
  const [p, n] = id.split("#")
  return `/projects/${encodeURIComponent(p!)}/issues/${n}`
}

export function ActivityPage() {
  const { state } = useFactory()

  return (
    <div className="space-y-8">
      <PageHeader title="Activity" eyebrow="What the agents did, and how much of your limits it used" />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        <UsagePanel />

        <section className="overflow-hidden rounded-3xl border bg-card shadow-elevation">
          <div className="px-5 pt-5"><SectionTitle>Recent runs</SectionTitle></div>
          {state.runs.length === 0 ? <p className="px-5 pb-5 text-sm text-muted-foreground">No runs yet.</p> : (
            <ul className="divide-y">
              {state.runs.map((r) => {
                const role = ROLE[r.role] ?? { icon: Bot, tone: "bg-muted text-muted-foreground" }
                const Icon = role.icon
                const body = (
                  <>
                    <span className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-full", role.tone)}><Icon className="size-4.5" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium capitalize">{r.role} <span className="font-normal text-muted-foreground normal-case">· {r.model}</span></p>
                      <p className="truncate text-xs text-muted-foreground">{subjectLabel(r.subject ?? r.task_id)} · {when(r.started_at, state.timezone)}{r.summary ? ` · ${r.summary}` : ""}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={cn("font-medium tabular-nums", r.ok === 0 && "text-rose-600 dark:text-rose-300")}>{r.cost_usd != null ? `$${r.cost_usd.toFixed(2)}` : "–"}</p>
                      <p className="text-xs text-muted-foreground">{r.ok === null ? "running" : r.ok ? (r.finished_at ? `${Math.max(1, Math.round((r.finished_at - r.started_at) / 60))} min` : "ok") : "failed"}</p>
                    </div>
                  </>
                )
                return (
                  <li key={r.id}>
                    {r.task_id ? (
                      <Link href={taskHref(r.task_id)} className="flex items-center gap-3.5 px-5 py-3 text-sm transition-colors hover:bg-muted/50">{body}</Link>
                    ) : (
                      <div className="flex items-center gap-3.5 px-5 py-3 text-sm">{body}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="rounded-3xl border bg-card p-5 shadow-elevation">
        <SectionTitle>Events</SectionTitle>
        <ol className="relative space-y-3 border-l border-border pl-5">
          {state.events.map((e, i) => (
            <li key={i} className="relative text-sm">
              <span className="absolute top-1.5 -left-[1.42rem] size-2 rounded-full bg-primary/70 ring-4 ring-card" />
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-xs">{e.kind}</span>
                {e.task_id && <Link href={taskHref(e.task_id)} className="text-xs text-primary hover:underline">{e.task_id}</Link>}
                <span className="ml-auto text-xs text-muted-foreground">{when(e.at, state.timezone)}</span>
              </div>
              {describe(e.kind, e.data) && <p className="mt-0.5 text-xs text-muted-foreground">{describe(e.kind, e.data)}</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
