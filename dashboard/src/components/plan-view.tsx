import { ArrowUp, Bot, ExternalLink, Rocket } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Markdown } from "@/components/markdown"
import { SimpleSelect } from "@/components/simple-select"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { api, type Model, type PlanDetail } from "@/lib/api"
import { repoUrl } from "@/lib/format"
import { usePoll } from "@/lib/use-poll"
import { cn } from "@/lib/utils"

/**
 * One plan: the conversation with the planner on the left, what it has drafted (spec and issues) on the right,
 * Execute when it's ready. Used on the Plans page and on a project page for iterating its goals.
 */
export function PlanView({ planId, owner, onChanged }: { planId: number; owner: string; onChanged?: () => void }) {
  const [fast, setFast] = useState(true)
  const { data, reload } = usePoll(() => api<PlanDetail>("GET", `plans/${planId}`), fast ? 2500 : 10000, [planId])
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const chat = useRef<HTMLDivElement>(null)

  const p = data?.plan
  const thinking = !!data && (p!.state === "thinking" || (data.busy && p!.state !== "executing"))
  const executing = p?.state === "executing"
  const done = p?.state === "executed"
  const files = data?.files
  const ready = !!files?.plan && files.errors.length === 0 && !!files.product

  useEffect(() => setFast(thinking || executing || !data), [thinking, executing, data])
  useEffect(() => {
    chat.current?.scrollTo({ top: chat.current.scrollHeight, behavior: "smooth" })
  }, [data?.messages.length, thinking])

  const send = async () => {
    if (!text.trim()) return
    setSending(true)
    try {
      await api("POST", `plans/${planId}/messages`, { text })
      setText("")
      await reload()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSending(false)
    }
  }
  const execute = async () => {
    setConfirm(false)
    try {
      await api("POST", `plans/${planId}/execute`)
      toast.success("Executing…")
      await reload()
      onChanged?.()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const setModel = async (m: Model) => {
    try {
      await api("POST", `plans/${planId}/model`, { model: m })
      await reload()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  if (!data || !p || !files) return <p className="text-sm text-muted-foreground">Loading plan…</p>
  const issues = files.plan?.issues ?? []
  const target = p.target === "new" ? `create the private repo ${owner}/${files.plan?.project?.name ?? "?"} and ` : ""
  const resultProject = p.projectId ?? files.plan?.project?.name

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <Card className="flex max-h-[calc(100dvh-11rem)] min-h-[28rem] flex-col">
        <CardHeader className="flex flex-row items-center gap-2 border-b">
          <Bot className="size-4 text-muted-foreground" />
          <CardTitle className="text-sm">Planner</CardTitle>
          <div className="ml-auto">
            <SimpleSelect<Model> ariaLabel="Planner model" value={p.model} onChange={setModel} disabled={done} className="h-7"
              options={[{ value: "opus", label: "Opus" }, { value: "sonnet", label: "Sonnet" }]} />
          </div>
        </CardHeader>
        <div ref={chat} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {data.messages.length === 0 && !thinking && (
            <p className="text-sm text-muted-foreground">Describe what you want. The planner drafts the spec and the issues and asks what it needs.</p>
          )}
          {data.messages.map((m) => (
            <div key={m.id} className={cn("flex", m.role === "owner" ? "justify-end" : m.role === "system" ? "justify-center" : "justify-start")}>
              {m.role === "owner" ? (
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm whitespace-pre-wrap text-primary-foreground">{m.text}</div>
              ) : m.role === "planner" ? (
                <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-muted px-3.5 py-2"><Markdown text={m.text} /></div>
              ) : (
                <p className="max-w-[90%] text-center text-xs text-muted-foreground">{m.text}</p>
              )}
            </div>
          ))}
          {thinking && <p className="animate-pulse text-xs text-muted-foreground">The planner is thinking… usually 1–3 minutes.</p>}
          {executing && <p className="animate-pulse text-xs text-muted-foreground">Executing: {p.target === "new" ? "creating the repo and " : ""}filing issues…</p>}
        </div>
        {!done && (
          <div className="border-t p-3">
            <div className="relative">
              <Textarea
                value={text}
                onChange={(ev) => setText(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) void send()
                }}
                disabled={thinking || executing}
                placeholder={thinking ? "Waiting for the planner…" : "Reply to the planner (⌘↵ to send)"}
                className="min-h-20 pr-12"
              />
              <Button size="icon-sm" className="absolute right-2 bottom-2" aria-label="Send" disabled={thinking || executing || sending || !text.trim()} onClick={send}>
                <ArrowUp />
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">Each message is one {p.model === "opus" ? "Opus" : "Sonnet"} run on your subscription.</p>
          </div>
        )}
      </Card>

      <Card>
        <Tabs defaultValue="spec">
          <CardHeader className="flex flex-row items-center gap-2 border-b">
            <TabsList>
              <TabsTrigger value="spec">Spec</TabsTrigger>
              <TabsTrigger value="issues">Issues {issues.length > 0 && <Badge variant="secondary" className="ml-1 h-4.5 px-1.5 text-[10px]">{issues.length}</Badge>}</TabsTrigger>
            </TabsList>
            <div className="ml-auto">
              {done ? (
                <Badge variant="secondary">Executed</Badge>
              ) : (
                <Button size="sm" disabled={!ready || thinking || executing} onClick={() => setConfirm(true)}>
                  <Rocket /> Execute
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            {p.result?.trackingIssue && resultProject && (
              <p className="mb-3 text-sm">
                <a className="inline-flex items-center gap-1 text-primary hover:underline" href={`${repoUrl(owner, resultProject)}/issues/${p.result.trackingIssue}`} target="_blank" rel="noopener noreferrer">
                  Plan issue #{p.result.trackingIssue} <ExternalLink className="size-3" />
                </a>
                <span className="text-muted-foreground"> · {Object.keys(p.result.issues).length} issues filed</span>
              </p>
            )}
            {files.errors.length > 0 && !done && (
              <div className="mb-3 rounded-md bg-muted p-2.5 text-xs text-muted-foreground">{files.errors.map((e) => <div key={e}>{e}</div>)}</div>
            )}
            <TabsContent value="spec">
              {files.product ? <Markdown text={files.product} /> : <p className="text-sm text-muted-foreground">No spec yet.</p>}
            </TabsContent>
            <TabsContent value="issues">
              {issues.length === 0 ? (
                <p className="text-sm text-muted-foreground">{p.focus === "goals" ? "No issues: executing only updates the goals." : "No issues yet."}</p>
              ) : (
                <ol className="divide-y">
                  {issues.map((i, n) => (
                    <li key={i.key}>
                      <details className="group py-2.5">
                        <summary className="flex cursor-pointer list-none items-start gap-2 text-sm">
                          <span className="w-5 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">{n + 1}</span>
                          <span className="font-medium">{i.title}</span>
                          <span className="ml-auto flex shrink-0 gap-1">
                            <Badge variant="outline" className="h-4.5 px-1.5 text-[10px]">{i.size}</Badge>
                            {i.risk === "high" && <Badge variant="outline" className="h-4.5 px-1.5 text-[10px] border-red-500/40 text-red-600 dark:text-red-400">high risk</Badge>}
                            {i.area && <Badge variant="secondary" className="h-4.5 px-1.5 text-[10px]">{i.area}</Badge>}
                          </span>
                        </summary>
                        {i.dependsOn.length > 0 && <p className="mt-1 ml-7 text-xs text-muted-foreground">after {i.dependsOn.join(", ")}</p>}
                        <Markdown text={i.body} className="mt-2 ml-7 text-muted-foreground" />
                      </details>
                    </li>
                  ))}
                </ol>
              )}
            </TabsContent>
          </CardContent>
        </Tabs>
      </Card>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Execute this plan?</DialogTitle>
            <DialogDescription>
              The factory will {target}file {issues.length} issue{issues.length === 1 ? "" : "s"}
              {p.focus === "goals" ? " plus one that writes the updated goals into the repo" : ""}, then build them without asking.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Not yet</Button>
            <Button onClick={execute}><Rocket /> Execute</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
