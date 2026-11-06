import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { api, type Question } from "@/lib/api"
import { when } from "@/lib/format"

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
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span className="font-medium text-amber-800 dark:text-amber-300">{migration ? "Approval needed" : "Question"} #{q.id}</span>
        <span>{q.taskId}</span>
        <span className="ml-auto">
          no answer by {when(q.timeoutAt, timezone)} → <strong>{migration ? "reject" : q.defaultOption ?? "agent decides"}</strong>
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap">{q.question}</p>
      <div className="mt-3 flex flex-wrap gap-2">
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
