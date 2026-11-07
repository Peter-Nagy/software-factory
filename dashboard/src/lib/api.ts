// Types mirror the orchestrator's JSON (orchestrator/src/types.ts, plan.ts, questions.ts).

export type TaskState = "queued" | "building" | "in_review" | "fixing" | "merging" | "deploying" | "done" | "blocked" | "parked" | "cancelled"
export type Model = "haiku" | "sonnet" | "opus"

export interface Project { id: string; owner: string; kind: string; state: "spec_pending" | "awaiting_approval" | "active" | "paused" | "archived"; priority: number; createdAt: number }
export interface Task {
  id: string; projectId: string; issueNumber: number; title: string; state: TaskState; priority: number; risk: "low" | "medium" | "high"
  area: string | null; dependsOn: string[]; attempt: number; fixRounds: number; branch: string | null; prNumber: number | null
  lastFailure: string | null; interruptions: number; pendingMode: "build" | "fix" | "resume"; createdAt: number; updatedAt: number
}
export interface Usage { fiveHourPct: number | null; fiveHourResetsAt: number | null; sevenDayPct: number | null; sevenDayResetsAt: number | null; source: string; takenAt: number }
export interface Question { id: number; kind: "product" | "migration" | "approval"; taskId: string | null; projectId: string | null; question: string; options: string[]; defaultOption: string | null; askedAt: number; timeoutAt: number }
export interface Plan { id: number; title: string; target: "new" | "existing"; focus: "change" | "goals" | "issue"; projectId: string | null; issueNumber: number | null; state: "drafting" | "thinking" | "executing" | "executed" | "failed" | "archived"; model: Model; result: { repoCreated?: string; trackingIssue?: number; issues: Record<string, number>; error?: string } | null; createdAt: number; updatedAt: number }
export interface PlanIssue { key: string; title: string; body: string; size: "s" | "m" | "l"; risk: "low" | "medium" | "high"; area?: string; dependsOn: string[] }
export interface PlanDetail {
  plan: Plan
  messages: { id: number; role: "owner" | "planner" | "system"; text: string; at: number }[]
  files: { product: string | null; plan: { title: string; project?: { name: string; kind: string; priority: number }; issues: PlanIssue[] } | null; issue?: { title: string; body: string } | null; errors: string[] }
  busy: boolean
}
export interface Run { id: number; task_id: string | null; role: string; model: string; started_at: number; finished_at: number | null; ok: number | null; cost_usd: number | null; num_turns: number | null; summary: string | null }
export interface FactoryState {
  now: number; owner: string; timezone: string; usage: Usage | null; burnLine: number | null
  governor: { opusMaxFiveHourPct: number; anyMaxFiveHourPct: number }; pausedUntil: number | null
  projects: Project[]; tasks: Task[]; questions: Question[]; plans: Plan[]; runs: Run[]
  spend: { role: string; model: string; runs: number; usd: number }[]
  events: { at: number; kind: string; task_id: string | null; data: string }[]
}
export interface ProjectDetail { project: Project; tasks: Task[]; product: string | null; plans: Plan[]; questions: Question[]; merged30d: number }
export interface TaskDetail { task: Task; runs: Run[]; events: { at: number; kind: string; data: string }[]; questions: { id: number; kind: string; question: string; answer: string | null; answered_by: string | null; asked_at: number }[] }

export interface IssueDetail {
  project: Project
  number: number
  issue: { title: string; body: string; state: string; url: string; labels: string[] } | null
  issueError: string | null
  task: Task | null
  runs: Run[]
  events: { at: number; kind: string; data: string }[]
  questions: TaskDetail["questions"]
  conversation: { id: number; state: Plan["state"] } | null
}

export class ApiError extends Error {}

export async function api<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Factory": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) {
    window.location.reload()
    throw new ApiError("Not logged in")
  }
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

export const enc = encodeURIComponent

// ---------- Studio ----------
export type PhaseKey = "brief" | "research" | "product" | "design" | "architecture" | "spikes" | "plan"
export type PhaseState = "locked" | "ready" | "queued" | "thinking" | "drafting" | "approved" | "stale" | "skipped"
export interface Studio { id: number; title: string; mode: "guided" | "autopilot"; planId: number | null; archived: boolean; createdAt: number; updatedAt: number }
export interface StudioSummary extends Studio { phases: { phase: PhaseKey; state: PhaseState }[] }
export interface StudioPhase {
  phase: PhaseKey; state: PhaseState; model: Model; note: string | null; updatedAt: number
  title: string; doc: string; costPct: number; costMeasured?: boolean; optional: boolean; busy: boolean
  autoAnswer: "running" | "review" | null
  status: { ready: boolean; questions: StudioQuestion[]; coverage: { topic: string; done: boolean }[]; summary: string; verdict?: "build" | "narrow" | "dont" } | null
}
export interface StudioQuestion {
  question: string; header: string; why: string
  options: { label: string; description: string }[]
  multiSelect: boolean; recommended: string | null
}
export interface StudioDetail {
  studio: Studio
  phases: StudioPhase[]
  messages: { id: number; phase: PhaseKey; role: "owner" | "agent" | "system" | "standin"; text: string; at: number }[]
  answers: StudioAnswer[]
  docs: Partial<Record<PhaseKey, string | null>>
  mockups: string[]
  spikes: { key: string; question: string; approach: string }[] | null
}
export interface StudioAnswer { id: number; phase: PhaseKey; round: number; question: StudioQuestion; answer: string; reason: string; edited: boolean }

export interface CostLine { key: string; runs: number; usd: number; fiveHourPct: number | null; sevenDayPct: number | null }
export interface CostReport {
  since: number
  calibration: { fiveHourPctPerUsd: number | null; sevenDayPctPerUsd: number | null; samples: number }
  total: CostLine; byProject: CostLine[]; byRole: CostLine[]; byModel: CostLine[]
  studioPhases: (CostLine & { phase: string; model: string; perMessageUsd: number; perMessageFiveHourPct: number | null })[]
  days: { date: string; usd: number }[]
}
