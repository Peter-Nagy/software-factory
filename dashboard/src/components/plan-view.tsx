import { Check, ExternalLink, Rocket } from "lucide-react"
import { useRef, useState } from "react"
import { toast } from "sonner"
import { Markdown } from "@/components/markdown"
import { ChatPanel, useDocComments } from "@/components/chat-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, type Model, type PlanDetail } from "@/lib/api"
import { repoUrl } from "@/lib/format"
import { usePoll } from "@/lib/use-poll"

/**
 * One plan: the conversation with the planner on the left, what it has drafted (spec and issues) on the right,
 * Execute when it's ready. Used on the Plans page and on a project page for iterating its goals.
 */
export function PlanView({ planId, owner, onChanged }: { planId: number; owner: string; onChanged?: () => void }) {
  const { data, reload } = usePoll(() => api<PlanDetail>("GET", `plans/${planId}`),
    (d) => (!d || d.busy || ["thinking", "executing"].includes(d.plan.state) ? 2500 : 10000), [planId])
  const [confirm, setConfirm] = useState(false)
  const drafted = useRef<HTMLDivElement>(null)
  const comments = useDocComments(drafted, data?.plan.state !== "executed")

  const p = data?.plan
  const thinking = !!data && (p!.state === "thinking" || (data.busy && p!.state !== "executing"))
  const executing = p?.state === "executing"
  const done = p?.state === "executed"
  const files = data?.files
  const isIssue = p?.focus === "issue"
  const ready = isIssue ? !!files?.issue : !!files?.plan && files.errors.length === 0 && !!files.product


  const send = async (text: string) => {
    await api("POST", `plans/${planId}/messages`, { text })
    await reload()
  }
  const execute = async () => {
    setConfirm(false)
    try {
      await api("POST", `plans/${planId}/execute`)
      toast.success(isIssue ? "Applying to the issue…" : "Executing…")
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
      <ChatPanel
        title="Planner"
        model={p.model}
        onModel={setModel}
        modelLocked={done}
        messages={data.messages}
        thinking={thinking}
        thinkingText="The planner is thinking… usually 1–3 minutes."
        status={executing ? <p className="animate-pulse text-xs text-muted-foreground">{isIssue ? "Applying to the issue…" : `Executing: ${p.target === "new" ? "creating the repo and " : ""}filing issues…`}</p> : undefined}
        emptyHint={isIssue ? "Tell the planner what should change about this issue. It revises the draft on the right; select any part of it to comment." : "Describe what you want. The planner drafts the spec and the issues and asks what it needs. Then select any text in the spec to comment on it."}
        closed={done}
        notes={comments.notes}
        setNotes={comments.setNotes}
        onSend={send}
      />

      {isIssue ? (
        <Card>
          <CardHeader className="flex flex-row items-center gap-2 border-b">
            <CardTitle className="text-sm">Draft</CardTitle>
            <span className="text-xs text-muted-foreground">what the issue will say</span>
            <Button size="sm" className="ml-auto" disabled={!ready || thinking || executing} onClick={() => setConfirm(true)}>
              <Check /> Apply to issue
            </Button>
          </CardHeader>
          <CardContent ref={drafted} className="pt-4">
            {files.issue ? (
              <div data-comment-source="draft">
                <h3 className="mb-2 text-lg font-semibold tracking-tight">{files.issue.title}</h3>
                <Markdown text={files.issue.body} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{thinking ? "The planner is writing the first draft…" : files.errors.join(" ") || "No draft yet."}</p>
            )}
          </CardContent>
        </Card>
      ) : (
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
          <CardContent ref={drafted} className="pt-4">
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
              {files.product ? <div data-comment-source="spec"><Markdown text={files.product} /></div> : <p className="text-sm text-muted-foreground">No spec yet.</p>}
            </TabsContent>
            <TabsContent value="issues">
              {issues.length === 0 ? (
                <p className="text-sm text-muted-foreground">{p.focus === "goals" ? "No issues: executing only updates the goals." : "No issues yet."}</p>
              ) : (
                <ol className="divide-y">
                  {issues.map((i, n) => (
                    <li key={i.key} data-comment-source={`issue:${i.title}`}>
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
      )}

      {comments.button}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isIssue ? `Apply the draft to issue #${p.issueNumber}?` : "Execute this plan?"}</DialogTitle>
            <DialogDescription>
              {isIssue ? (
                "The issue's title and description on GitHub are replaced with the draft. A parked task starts over with it; a running one sees it from its next step. You can keep iterating afterwards."
              ) : (
                <>
                  The factory will {target}file {issues.length} issue{issues.length === 1 ? "" : "s"}
                  {p.focus === "goals" ? " plus one that writes the updated goals into the repo" : ""}, then build them without asking.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Not yet</Button>
            <Button onClick={execute}>{isIssue ? <><Check /> Apply</> : <><Rocket /> Execute</>}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
