import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { api, type Question } from "@/lib/api"
import { MessageCircleQuestion, ShieldAlert } from "lucide-react"
import { issuePath, when } from "@/lib/format"
import { Link } from "@/lib/router"

export function QuestionCard({ q, timezone, onDone }: { q: Question; timezone: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [other, setOther] = useState<string | null>(null)
  const migration = q.kind === "migration"
  const send = async (answer: string) => {
    setBusy(true)
    try {
      const r = await api<{ effect: string }>("POST", `questions/${q.id}/answer`, { answer })
      toast.success(`Answered: ${r.effect}`)
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="relative overflow-hidden rounded-3xl border border-amber-500/30 bg-card p-4 text-sm shadow-elevation">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-amber-500/10 to-transparent" />
      <div className="relative flex items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-300">
          {migration ? <ShieldAlert className="size-4.5" /> : <MessageCircleQuestion className="size-4.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="font-semibold text-amber-700 dark:text-amber-300">{migration ? "Approval needed" : "Question"}</span>
            {q.taskId && <Link href={issuePath({ projectId: q.taskId.split("#")[0]!, issueNumber: Number(q.taskId.split("#")[1]) })} className="hover:text-foreground">{q.taskId}</Link>}
          </div>
          <p className="mt-1.5 text-[0.95rem] leading-snug font-medium whitespace-pre-wrap">{q.question}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            No answer by {when(q.timeoutAt, timezone)} → <strong className="text-foreground/80">{migration ? "reject" : q.defaultOption ?? "the agent decides"}</strong>
          </p>
        </div>
      </div>
      <div className="relative mt-4 flex flex-wrap gap-2">
        {q.options.map((o) => (
          <Button key={o} size="sm" disabled={busy} variant={migration ? (o === "approve" ? "default" : "destructive") : o === q.defaultOption ? "default" : "outline"} onClick={() => send(o)}>
            {o}
          </Button>
        ))}
        {!migration && other === null && (
          <Button size="sm" variant="ghost" onClick={() => setOther("")}>
            Other answer…
          </Button>
        )}
      </div>
      {other !== null && (
        <div className="mt-2 space-y-2">
          <Textarea autoFocus value={other} onChange={(ev) => setOther(ev.target.value)} placeholder="Your answer, in your own words" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOther(null)}>Cancel</Button>
            <Button size="sm" disabled={busy || !other.trim()} onClick={() => send(other)}>Send</Button>
          </div>
        </div>
      )}
    </div>
  )
}
