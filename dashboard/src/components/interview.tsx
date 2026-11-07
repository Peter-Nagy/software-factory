import { ArrowLeft, ArrowRight, Check, MessageCircleQuestion, PenLine, Send, Sparkles, Wand2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { StudioQuestion } from "@/lib/api"
import { cn } from "@/lib/utils"

interface Answer {
  picked: string[]
  /** The owner's own words; null while the "write my own" box is closed. */
  other: string | null
  /** Extra detail added to a picked option. */
  note: string
  yourCall: boolean
}
const EMPTY: Answer = { picked: [], other: null, note: "", yourCall: false }

const freeText = (q: StudioQuestion) => q.options.length === 0
const isAnswered = (q: StudioQuestion, a: Answer | undefined) =>
  !!a && (a.yourCall || a.picked.length > 0 || !!a.other?.trim() || (freeText(q) && !!a.note.trim()))

/** The answers as one chat message; the agent sees each question quoted with the answer under it. */
export function composeAnswers(questions: StudioQuestion[], answers: Record<number, Answer>): string {
  const blocks = questions.map((q, i) => {
    const a = answers[i] ?? EMPTY
    const parts = [...a.picked, a.other?.trim() ?? ""].filter(Boolean)
    let value = !isAnswered(q, a) || a.yourCall ? "Your call" : parts.join("; ")
    if (!a.yourCall && a.note.trim()) value = parts.length ? `${value}\n${a.note.trim()}` : a.note.trim()
    return `> ${q.question.replace(/\n/g, "\n> ")}\n${value}`
  })
  return `Answers to your questions:\n\n${blocks.join("\n\n")}`
}

function hash(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

/** Answers survive polling and reloads until they're sent. */
function useStoredAnswers(key: string) {
  const [answers, setAnswers] = useState<Record<number, Answer>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<number, Answer>
    } catch {
      return {}
    }
  })
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(answers))
  }, [key, answers])
  return [answers, setAnswers, () => localStorage.removeItem(key)] as const
}

/** The agent's questions as a form: one question at a time, options to click, your own words when they don't fit. */
export function Interview({ storageKey, agent, questions, onSend }: {
  storageKey: string
  agent: string
  questions: StudioQuestion[]
  onSend: (text: string) => Promise<void>
}) {
  const key = `interview:${storageKey}:${hash(JSON.stringify(questions))}`
  const [answers, setAnswers, forget] = useStoredAnswers(key)
  const [at, setAt] = useState(0)
  const [sending, setSending] = useState(false)
  const [showNote, setShowNote] = useState(false)
  const root = useRef<HTMLElement>(null)
  const advance = useRef<number | undefined>(undefined)

  const i = Math.min(at, questions.length - 1)
  const q = questions[i]!
  const a = answers[i] ?? EMPTY
  const done = useMemo(() => questions.filter((qq, n) => isAnswered(qq, answers[n])).length, [questions, answers])
  const last = i === questions.length - 1

  const set = (patch: Partial<Answer>) => setAnswers((all) => ({ ...all, [i]: { ...(all[i] ?? EMPTY), ...patch } }))
  const go = (n: number) => {
    window.clearTimeout(advance.current)
    setAt(Math.max(0, Math.min(questions.length - 1, n)))
    setShowNote(false)
  }
  const pick = (label: string) => {
    if (q.multiSelect) {
      set({ yourCall: false, picked: a.picked.includes(label) ? a.picked.filter((l) => l !== label) : [...a.picked, label] })
      return
    }
    const off = a.picked[0] === label
    set({ yourCall: false, picked: off ? [] : [label], other: off ? a.other : null })
    // Like a form wizard: a single choice moves on by itself.
    if (!off && !last) advance.current = window.setTimeout(() => go(i + 1), 280)
  }
  const yourCall = () => {
    set({ yourCall: !a.yourCall, picked: [], other: null })
    if (!a.yourCall && !last) advance.current = window.setTimeout(() => go(i + 1), 280)
  }

  const send = async () => {
    setSending(true)
    try {
      await onSend(composeAnswers(questions, answers))
      forget()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  // Keys: 1-9 pick an option, ← → move between questions. Not while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest("textarea, input, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return
      if (!root.current || root.current.getBoundingClientRect().bottom < 0) return
      const n = Number(e.key)
      if (n >= 1 && n <= q.options.length) {
        e.preventDefault()
        pick(q.options[n - 1]!.label)
      } else if (e.key === "ArrowRight") go(i + 1)
      else if (e.key === "ArrowLeft") go(i - 1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  useEffect(() => () => window.clearTimeout(advance.current), [])

  return (
    <section ref={root} className="animate-rise overflow-clip rounded-3xl border bg-card shadow-elevation">
      <div className="bg-hero relative overflow-hidden px-5 pt-4 pb-3.5 text-white sm:px-6">
        <div className="pointer-events-none absolute -top-16 -right-10 size-48 rounded-full bg-white/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-white/15"><MessageCircleQuestion className="size-4" /></span>
          <p className="font-semibold tracking-tight">{agent} has {questions.length === 1 ? "a question" : `${questions.length} questions`}</p>
          <span className="ml-auto text-sm text-white/80">{done} of {questions.length} answered</span>
        </div>
        <div className="relative mt-3 flex gap-1">
          {questions.map((qq, n) => (
            <button key={n} type="button" aria-label={`Question ${n + 1}`} onClick={() => go(n)}
              className={cn("h-1.5 flex-1 rounded-full transition-colors", n === i ? "bg-white" : isAnswered(qq, answers[n]) ? "bg-white/60" : "bg-white/20 hover:bg-white/35")} />
          ))}
        </div>
      </div>

      <div className="-mb-px flex gap-1 overflow-x-auto border-b px-3 pt-2 sm:px-4">
        {questions.map((qq, n) => (
          <button key={n} type="button" onClick={() => go(n)}
            className={cn("inline-flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 pb-2 text-xs font-medium transition-colors",
              n === i ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {isAnswered(qq, answers[n])
              ? <Check className="size-3.5 text-emerald-500" />
              : <span className="inline-flex size-4 items-center justify-center rounded-full bg-muted text-[0.65rem]">{n + 1}</span>}
            {qq.header || `Question ${n + 1}`}
          </button>
        ))}
      </div>

      <div key={i} className="animate-rise space-y-4 px-5 py-5 sm:px-6">
        <div>
          <p className="text-lg leading-snug font-semibold tracking-tight">{q.question}</p>
          {q.why && <p className="mt-1 text-sm text-muted-foreground">{q.why}</p>}
          {q.multiSelect && <p className="mt-1 text-xs font-medium text-primary">Pick all that apply</p>}
        </div>

        {q.options.length > 0 && (
          <div className="grid gap-2.5 sm:grid-cols-2">
            {q.options.map((o, n) => {
              const on = a.picked.includes(o.label)
              return (
                <button key={o.label} type="button" onClick={() => pick(o.label)} aria-pressed={on}
                  className={cn("group relative flex items-start gap-3 rounded-2xl border p-3.5 text-left transition-all",
                    on ? "border-primary bg-primary/8 ring-2 ring-primary/40" : "hover:border-primary/40 hover:bg-muted/50")}>
                  <span className={cn("mt-0.5 inline-flex size-6 shrink-0 items-center justify-center text-xs font-semibold transition-colors",
                    q.multiSelect ? "rounded-md" : "rounded-full",
                    on ? "bg-accent-gradient text-white" : "bg-muted text-muted-foreground group-hover:text-foreground")}>
                    {on ? <Check className="size-3.5" /> : n + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                      {o.label}
                      {q.recommended === o.label && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary/12 px-2 py-0.5 text-[0.7rem] font-semibold text-primary"><Sparkles className="size-3" /> Recommended</span>
                      )}
                    </span>
                    {o.description && <span className="mt-0.5 block text-sm text-muted-foreground">{o.description}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {freeText(q) ? (
          <Textarea autoFocus value={a.note} onChange={(e) => set({ note: e.target.value, yourCall: false })} placeholder="Your answer: examples and specifics help most" className="min-h-28" />
        ) : (
          <div className="space-y-2.5">
            {a.other !== null && (
              <Textarea autoFocus value={a.other} onChange={(e) => set({ other: e.target.value, yourCall: false, picked: q.multiSelect ? a.picked : [] })}
                placeholder="In your own words" className="min-h-20" />
            )}
            {showNote && (
              <Textarea autoFocus value={a.note} onChange={(e) => set({ note: e.target.value })} placeholder="Anything to add: a detail, an exception, an example" className="min-h-20" />
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {!freeText(q) && a.other === null && (
            <Button variant="outline" size="sm" onClick={() => set({ other: "", yourCall: false, picked: q.multiSelect ? a.picked : [] })}><PenLine /> Write my own</Button>
          )}
          {!freeText(q) && !showNote && !a.note && a.picked.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setShowNote(true)}>Add detail</Button>
          )}
          <Button variant={a.yourCall ? "default" : "ghost"} size="sm" onClick={yourCall}><Wand2 /> Your call</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-5 py-3 sm:px-6">
        <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => go(i - 1)}><ArrowLeft /> Back</Button>
        <span className="hidden text-xs text-muted-foreground sm:inline">Keys 1–{Math.max(1, q.options.length)} pick · ← → move</span>
        <div className="ml-auto flex items-center gap-2">
          {done < questions.length && <span className="hidden text-xs text-muted-foreground md:inline">{questions.length - done} unanswered → the agent decides</span>}
          {!last && <Button variant="outline" size="sm" onClick={() => go(i + 1)}>Next <ArrowRight /></Button>}
          <Button size="sm" disabled={sending || done === 0} onClick={send} className={cn(last || done === questions.length ? "" : "hidden sm:inline-flex")}>
            <Send /> Send {done === questions.length ? "answers" : `${done} answer${done === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>
    </section>
  )
}

/** How far the interview has got: the phase's topics, settled or still open. */
export function Coverage({ topics }: { topics: { topic: string; done: boolean }[] }) {
  if (topics.length === 0) return null
  const settled = topics.filter((t) => t.done).length
  return (
    <div className="mb-4 rounded-2xl bg-muted/50 p-3.5">
      <div className="flex items-center justify-between gap-2 text-sm">
        <p className="font-medium">Interview</p>
        <p className="text-xs text-muted-foreground">{settled} of {topics.length} topics settled</p>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="bg-accent-gradient h-full rounded-full transition-all" style={{ width: `${(settled / topics.length) * 100}%` }} />
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {topics.map((t) => (
          <span key={t.topic} className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs",
            t.done ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" : "bg-card text-muted-foreground ring-1 ring-border")}>
            {t.done && <Check className="size-3" />}{t.topic}
          </span>
        ))}
      </div>
    </div>
  )
}
