import { Archive, Check, Clock3, FlaskConical, Loader2, Lock, Maximize2, Minus, Play, RefreshCw, Rocket, SkipForward, Sparkles } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { ChatPanel, useDocComments } from "@/components/chat-panel"
import { AnswerReview, Coverage, Interview, StandinRunning } from "@/components/interview"
import { Markdown } from "@/components/markdown"
import { PlanView } from "@/components/plan-view"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { PageHeader } from "@/components/visual"
import { api, type Model, type PhaseKey, type PhaseState, type StudioDetail, type StudioPhase } from "@/lib/api"
import { useFactory } from "@/lib/factory"
import { Link, navigate } from "@/lib/router"
import { usePoll } from "@/lib/use-poll"
import { cn } from "@/lib/utils"

const PHASE_HINT: Record<PhaseKey, string> = {
  brief: "Tell the agent about the idea. It interviews you and writes the brief.",
  research: "Competitors, what users say, gaps, risks, with sources. Ends with a go/no-go.",
  product: "Positioning, business model, ranked features, user stories and metrics.",
  design: "Name and brand, design system, flows and styled mockups of the key screens.",
  architecture: "Stack, data, integrations, privacy and platform rules, cost, risky unknowns.",
  spikes: "Tiny throwaway prototypes that answer the risky questions before planning.",
  plan: "Milestones and issues with acceptance criteria. Execute creates the repo and files them.",
}

export function PhaseIcon({ state, small, busy }: { state: PhaseState; small?: boolean; busy?: boolean }) {
  const size = small ? "size-5 [&_svg]:size-3" : "size-8 [&_svg]:size-4"
  const tone: Record<PhaseState, string> = {
    approved: "bg-emerald-500 text-white",
    drafting: "bg-accent-gradient text-white",
    thinking: "bg-sky-500 text-white",
    queued: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
    stale: "bg-amber-500 text-white",
    ready: "bg-primary/15 text-primary ring-1 ring-primary/40",
    skipped: "bg-muted text-muted-foreground",
    locked: "bg-muted text-muted-foreground/60",
  }
  const icon: Record<PhaseState, React.ReactNode> = {
    approved: <Check />, drafting: <Sparkles />, thinking: <Loader2 className="animate-spin" />, queued: <Clock3 />,
    stale: <RefreshCw />, ready: <Play />, skipped: <Minus />, locked: <Lock />,
  }
  return <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full", size, tone[state])}>{busy && state !== "thinking" ? <Loader2 className="animate-spin" /> : icon[state]}</span>
}

const STATE_TEXT: Record<PhaseState, string> = {
  approved: "Approved", drafting: "Draft ready", thinking: "Working", queued: "Queued", stale: "Out of date",
  ready: "Ready to start", skipped: "Skipped", locked: "Locked",
}

function Stepper({ phases, current, onPick }: { phases: StudioPhase[]; current: PhaseKey; onPick: (p: PhaseKey) => void }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6">
      <ol className="flex min-w-max items-center gap-1 rounded-full border bg-card p-1.5 shadow-elevation">
        {phases.map((p, i) => (
          <li key={p.phase} className="flex items-center">
            <button
              type="button"
              disabled={p.state === "locked"}
              onClick={() => onPick(p.phase)}
              className={cn("flex items-center gap-2 rounded-full py-1 pr-3.5 pl-1 text-sm font-medium transition-colors disabled:cursor-not-allowed", current === p.phase ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground")}
            >
              <PhaseIcon state={p.state} busy={p.busy} />
              <span className="whitespace-nowrap">{i + 1}. {p.title}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** A mockup is agent-written HTML: shown in a sandboxed frame (no scripts, no same-origin access), served with a sandbox CSP. */
function MockupFrame({ src, scale }: { src: string; scale: number }) {
  return (
    <div className="overflow-hidden rounded-[2rem] bg-black p-2 shadow-elevation ring-1 ring-border" style={{ width: 390 * scale + 16, height: 844 * scale + 16 }}>
      <iframe title="Mockup" src={src} sandbox="" loading="lazy" referrerPolicy="no-referrer" className="origin-top-left rounded-[1.6rem] bg-white" style={{ width: 390, height: 844, transform: `scale(${scale})` }} />
    </div>
  )
}

function Verdict({ verdict }: { verdict: "build" | "narrow" | "dont" }) {
  const v = {
    build: { label: "Go", text: "Worth building as briefed.", tone: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300" },
    narrow: { label: "Go, narrower", text: "Worth building with a sharper angle; see the verdict below.", tone: "bg-amber-500/12 text-amber-800 ring-amber-500/30 dark:text-amber-200" },
    dont: { label: "No-go", text: "The research says not to build this; see what to use instead.", tone: "bg-rose-500/12 text-rose-700 ring-rose-500/30 dark:text-rose-300" },
  }[verdict]
  return (
    <div className={cn("mb-4 flex items-center gap-3 rounded-2xl p-3.5 ring-1", v.tone)}>
      <span className="text-lg font-semibold tracking-tight">{v.label}</span>
      <span className="text-sm">{v.text}</span>
    </div>
  )
}

function PhaseDoc({ studioId, phase, detail, docRef }: { studioId: number; phase: StudioPhase; detail: StudioDetail; docRef: React.RefObject<HTMLDivElement | null> }) {
  const [open, setOpen] = useState<string | null>(null)
  const doc = detail.docs[phase.phase]
  const file = phase.doc.split("/").pop()!
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 border-b">
        <CardTitle className="text-sm">{file}</CardTitle>
        {phase.status?.summary && <span className="truncate text-xs text-muted-foreground">{phase.status.summary}</span>}
      </CardHeader>
      <CardContent ref={docRef} className="max-h-[calc(100dvh-14rem)] overflow-y-auto pt-4">
        {phase.phase === "research" && phase.status?.verdict && <Verdict verdict={phase.status.verdict} />}
        {phase.status && <Coverage topics={phase.status.coverage} />}
        {doc ? <div data-comment-source={`doc:${file}`}><Markdown text={doc} /></div> : <p className="text-sm text-muted-foreground">{phase.busy || phase.state === "thinking" ? "The agent is writing it…" : "Nothing written yet."}</p>}
        {phase.phase === "design" && detail.mockups.length > 0 && (
          <div className="mt-6">
            <p className="mb-3 text-sm font-semibold">Mockups</p>
            <div className="flex flex-wrap gap-4">
              {detail.mockups.map((m) => (
                <button key={m} type="button" onClick={() => setOpen(m)} className="group text-left">
                  <MockupFrame src={`/api/studios/${studioId}/mockup?name=${encodeURIComponent(m)}`} scale={0.42} />
                  <span className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">{m.replace(/\.html$/, "")} <Maximize2 className="size-3" /></span>
                </button>
              ))}
            </div>
          </div>
        )}
        {phase.phase === "architecture" && detail.spikes && detail.spikes.length > 0 && (
          <div className="mt-6 rounded-2xl bg-muted/60 p-4">
            <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><FlaskConical className="size-4" /> Questions for the spikes</p>
            <ul className="space-y-2 text-sm">{detail.spikes.map((s) => <li key={s.key}><span className="font-medium">{s.question}</span>{s.approach && <span className="text-muted-foreground"> · {s.approach}</span>}</li>)}</ul>
          </div>
        )}
      </CardContent>
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="w-auto max-w-none sm:max-w-none">
          <DialogHeader><DialogTitle>{open?.replace(/\.html$/, "")}</DialogTitle></DialogHeader>
          {open && <div className="flex justify-center"><MockupFrame src={`/api/studios/${studioId}/mockup?name=${encodeURIComponent(open)}`} scale={0.85} /></div>}
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export function StudioPage({ id }: { id: number }) {
  const { state } = useFactory()
  const [fast, setFast] = useState(true)
  const { data, error, reload } = usePoll(() => api<StudioDetail>("GET", `studios/${id}`), fast ? 3000 : 10000, [id])
  const initial = new URLSearchParams(window.location.search).get("phase") as PhaseKey | null
  const [picked, setPicked] = useState<PhaseKey | null>(initial)
  const docRef = useRef<HTMLDivElement>(null)
  const comments = useDocComments(docRef)

  const working = !!data?.phases.some((p) => p.busy || p.state === "thinking" || p.state === "queued")
  useEffect(() => setFast(working || !data), [working, data])

  if (error && !data) return <p className="text-sm text-muted-foreground">{error}</p>
  if (!data) return <div className="space-y-4"><Skeleton className="h-24 w-full rounded-3xl" /><Skeleton className="h-[32rem] w-full rounded-3xl" /></div>
  const { studio, phases } = data
  const firstOpen = phases.find((p) => !["approved", "skipped", "locked"].includes(p.state)) ?? phases.filter((p) => p.state !== "locked").at(-1)!
  const phase = phases.find((p) => p.phase === (picked ?? firstOpen.phase)) ?? firstOpen
  const pick = (k: PhaseKey) => {
    setPicked(k)
    comments.setNotes(() => [])
    window.history.replaceState(null, "", `/studio/${id}?phase=${k}`)
  }

  const post = async (path: string, body: unknown, ok?: string) => {
    try {
      await api("POST", `studios/${id}/${path}`, body)
      if (ok) toast.success(ok)
      await reload()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const archive = async () => {
    if (!window.confirm("Archive this idea? Its documents stay on disk.")) return
    await post("archive", {})
    navigate("/studio")
  }

  const thinking = phase.busy || phase.state === "thinking"
  const canApprove = ["drafting", "stale"].includes(phase.state) && !!data.docs[phase.phase] && !thinking && phase.phase !== "plan" && !phase.autoAnswer
  const msgs = data.messages.filter((m) => m.phase === phase.phase)
  const standin = phase.autoAnswer
  const interviewing = !standin && !thinking && !!phase.status?.questions.length && ["ready", "drafting", "stale"].includes(phase.state)
  const answers = data.answers.filter((a) => a.phase === phase.phase)
  const nextPhase = phases.slice(phases.indexOf(phase) + 1).find((p) => p.state === "ready" || p.state === "stale" || p.state === "locked")
  const send = async (text: string) => {
    await api("POST", `studios/${id}/messages`, { phase: phase.phase, text })
    await reload()
  }
  const startable = (phase.state === "ready" && msgs.length === 0) || phase.state === "stale"

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<Link href="/studio" className="hover:text-foreground">Studio</Link>}
        title={studio.title}
        actions={
          <>
            <div className="inline-flex rounded-full bg-muted p-1">
              {(["guided", "autopilot"] as const).map((m) => (
                <button key={m} type="button" onClick={() => studio.mode !== m && void post("mode", { mode: m }, m === "autopilot" ? "Autopilot on: it continues on its own" : "Guided: you approve each step")}
                  className={cn("inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors", studio.mode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {m === "guided" ? <Sparkles className="size-3.5" /> : <Rocket className="size-3.5" />}
                  {m === "guided" ? "Guided" : "Autopilot"}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={archive}><Archive /> Archive</Button>
          </>
        }
      />

      <Stepper phases={phases} current={phase.phase} onPick={pick} />

      <section className="flex flex-wrap items-center gap-3 rounded-3xl border bg-card p-4 shadow-elevation sm:p-5">
        <PhaseIcon state={phase.state} busy={phase.busy} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold tracking-tight">{phase.title} <span className="font-normal text-muted-foreground">· {STATE_TEXT[phase.busy && phase.state !== "thinking" ? "thinking" : phase.state]}</span></p>
          <p className="text-sm text-muted-foreground">{phase.note ?? PHASE_HINT[phase.phase]}</p>
        </div>
        <span className="hidden text-xs text-muted-foreground sm:inline">~{phase.costPct}% of a 5-hour window per message</span>
        <div className="flex flex-wrap gap-2">
          {phase.optional && !["approved", "skipped", "thinking"].includes(phase.state) && <Button variant="ghost" size="sm" onClick={() => post("skip", { phase: phase.phase }, `${phase.title} skipped`)}><SkipForward /> Skip</Button>}
          {startable && !thinking && phase.phase !== "plan" && (
            <Button variant={phase.state === "stale" ? "outline" : "default"} size="sm" onClick={() => post("start", { phase: phase.phase })}>
              {phase.state === "stale" ? <><RefreshCw /> Update to match</> : <><Play /> Start {phase.title.toLowerCase()}</>}
            </Button>
          )}
          {phase.phase === "plan" && studio.planId === null && phase.state === "ready" && (
            <Button size="sm" onClick={() => post("start", { phase: "plan" })}><Play /> Draft the build plan</Button>
          )}
          {canApprove && <Button size="sm" onClick={() => post("approve", { phase: phase.phase }, `${phase.title} approved`)}><Check /> Approve</Button>}
        </div>
      </section>

      {phase.phase === "plan" ? (
        studio.planId !== null ? <PlanView planId={studio.planId} owner={state.owner} /> : (
          <div className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">{phase.state === "locked" ? "Approve the earlier steps first." : "The planner turns the approved documents into milestones and issues. Start it above."}</div>
        )
      ) : phase.state === "locked" ? (
        <div className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">Approve the earlier steps first.</div>
      ) : (
        <>
        {interviewing && (
          <Interview
            key={phase.phase}
            storageKey={`${id}:${phase.phase}`}
            agent={`The ${phase.title.toLowerCase()} agent`}
            questions={phase.status!.questions}
            onSend={send}
            onSkip={() => post("auto-answer", { phase: phase.phase }, "Answering for you; you'll review the answers at the end")}
          />
        )}
        {standin === "running" && (
          <StandinRunning agent={`the ${phase.title.toLowerCase()} agent`} rounds={new Set(answers.map((a) => a.round)).size} onStop={() => post("stop-answering", { phase: phase.phase })} />
        )}
        {standin === "review" && !thinking && (
          <AnswerReview
            key={answers.map((a) => a.id).join()}
            answers={answers}
            nextTitle={studio.mode === "guided" && nextPhase ? nextPhase.title.toLowerCase() : null}
            onSubmit={async (edits) => {
              const r = await api<{ approved: boolean; next: { phase: PhaseKey } | null }>("POST", `studios/${id}/review`, { phase: phase.phase, edits })
              if (r.approved) {
                toast.success(`${phase.title} approved`)
                if (r.next) pick(r.next.phase)
              } else toast.success("Sent your changes to the agent")
              await reload()
            }}
          />
        )}
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <ChatPanel
            key={phase.phase}
            title={`${phase.title} agent`}
            model={phase.model}
            onModel={(m: Model) => void post("model", { phase: phase.phase, model: m })}
            modelLocked={thinking}
            messages={msgs}
            thinking={thinking || phase.autoAnswer === "running"}
            thinkingText={phase.state === "queued" ? "Queued: starts when the usage budget allows." : `The ${phase.title.toLowerCase()} agent is working… usually 2–6 minutes.`}
            emptyHint={PHASE_HINT[phase.phase]}
            closed={phase.state === "skipped"}
            notes={comments.notes}
            setNotes={comments.setNotes}
            onSend={send}
          />
          <PhaseDoc studioId={id} phase={phase} detail={data} docRef={docRef} />
        </div>
        </>
      )}
      {comments.button}
    </div>
  )
}
