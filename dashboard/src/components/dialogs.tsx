import { useState } from "react"
import { toast } from "sonner"
import { SimpleSelect } from "@/components/simple-select"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { api, enc, type Model, type Plan, type Project } from "@/lib/api"
import { navigate } from "@/lib/router"

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function AddTaskDialog({ project, open, onOpenChange, onCreated }: { project: Project; open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [size, setSize] = useState<"s" | "m" | "l">("m")
  const [busy, setBusy] = useState(false)
  const create = async () => {
    setBusy(true)
    try {
      const r = await api<{ number: number }>("POST", `projects/${enc(project.id)}/tasks`, { title, body, size })
      toast.success(`Created #${r.number}; the factory picks it up within 5 minutes`)
      setTitle("")
      setBody("")
      onOpenChange(false)
      onCreated()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task in {project.id}</DialogTitle>
          <DialogDescription>Becomes a GitHub issue the factory builds. For bigger changes, plan them with the agent instead.</DialogDescription>
        </DialogHeader>
        <Field label="Title">
          <Input value={title} onChange={(ev) => setTitle(ev.target.value)} placeholder="e.g. Add dark mode" autoFocus />
        </Field>
        <Field label="What to do" hint="Acceptance criteria as a checklist help the reviewer decide.">
          <Textarea value={body} onChange={(ev) => setBody(ev.target.value)} className="min-h-32" placeholder={"Context in a line or two.\n\n## Acceptance criteria\n- [ ] …"} />
        </Field>
        <Field label="Size">
          <SimpleSelect value={size} onChange={setSize} options={[{ value: "s", label: "Small (under 30 min)" }, { value: "m", label: "Medium" }, { value: "l", label: "Large (over an hour)" }]} />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !title.trim() || !body.trim()} onClick={create}>Create issue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Start a plan: a new project, a change to a project, or the project's goals. */
export function NewPlanDialog({ open, onOpenChange, projects, project, focus = "change" }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  projects: Project[]
  project?: Project
  focus?: "change" | "goals"
}) {
  const [title, setTitle] = useState(focus === "goals" ? "Revise the goals" : "")
  const [target, setTarget] = useState<"new" | "existing">(project ? "existing" : "new")
  const [projectId, setProjectId] = useState(project?.id ?? projects[0]?.id ?? "")
  const [message, setMessage] = useState("")
  const [model, setModel] = useState<Model>("opus")
  const [busy, setBusy] = useState(false)
  const start = async () => {
    setBusy(true)
    try {
      const plan = await api<Plan>("POST", "plans", { title, target, projectId: target === "existing" ? projectId : undefined, message, model, focus })
      onOpenChange(false)
      navigate(`/plans/${plan.id}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const goals = focus === "goals"
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{goals ? `Iterate on the goals of ${project?.id}` : "New plan"}</DialogTitle>
          <DialogDescription>
            {goals
              ? "Discuss the goals with the planner. On Execute, the updated goals go into the repo through a normal reviewed PR, plus any issues the new goals need."
              : "Discuss it with the planner until the spec and issues look right. Nothing is built until you press Execute."}
          </DialogDescription>
        </DialogHeader>
        <Field label="Title">
          <Input value={title} onChange={(ev) => setTitle(ev.target.value)} placeholder="e.g. Habit tracker with streaks" autoFocus />
        </Field>
        {!project && (
          <Field label="For">
            <SimpleSelect value={target} onChange={setTarget} options={[{ value: "new", label: "A new project" }, ...(projects.length ? [{ value: "existing" as const, label: "An existing project" }] : [])]} />
          </Field>
        )}
        {!project && target === "existing" && (
          <Field label="Project">
            <SimpleSelect value={projectId} onChange={setProjectId} options={projects.map((p) => ({ value: p.id, label: p.id }))} />
          </Field>
        )}
        <Field label="First message">
          <Textarea value={message} onChange={(ev) => setMessage(ev.target.value)} className="min-h-28"
            placeholder={goals ? "What should change about the goals? What's working, what isn't, what's next?" : "Who it's for, what it must do, what you already know you want or don't want."} />
        </Field>
        <Field label="Planner model">
          <SimpleSelect value={model} onChange={setModel} options={[{ value: "opus", label: "Opus: best plans, uses more of your limit" }, { value: "sonnet", label: "Sonnet: cheaper" }]} />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || !title.trim() || !message.trim()} onClick={start}>Start planning</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
