import type { Task, TaskState } from "./api"

export function when(epochSeconds: number | null | undefined, timezone?: string): string {
  if (!epochSeconds) return "?"
  return new Date(epochSeconds * 1000).toLocaleString("en-GB", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit" })
}

export function ago(epochSeconds: number): string {
  const d = Math.max(0, Date.now() / 1000 - epochSeconds)
  if (d < 90) return "just now"
  if (d < 5400) return `${Math.round(d / 60)} min ago`
  if (d < 129600) return `${Math.round(d / 3600)} h ago`
  return `${Math.round(d / 86400)} d ago`
}

export const STATE_LABEL: Record<TaskState, string> = {
  queued: "Queued", building: "Building", fixing: "Fixing", in_review: "In review", merging: "Merging",
  deploying: "Deploying", done: "Merged", blocked: "Waiting on you", parked: "Parked", cancelled: "Cancelled",
}

/** Board columns, in the order work flows. */
export const COLUMNS: { key: string; title: string; states: TaskState[]; hint: string }[] = [
  { key: "queued", title: "Queued", states: ["queued"], hint: "Waiting for budget, dependencies or a free area" },
  { key: "building", title: "Building", states: ["building", "fixing"], hint: "An agent is writing or fixing code" },
  { key: "review", title: "In review", states: ["in_review", "merging", "deploying"], hint: "Checks, independent review, merge" },
  { key: "blocked", title: "Waiting on you", states: ["blocked"], hint: "A question or an approval" },
  { key: "parked", title: "Parked", states: ["parked"], hint: "Retries ran out; needs a look" },
  { key: "done", title: "Done", states: ["done"], hint: "Merged in the last 30 days" },
]

export const repoUrl = (owner: string, repo: string) => `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
export const issueUrl = (owner: string, t: Pick<Task, "projectId" | "issueNumber">) => `${repoUrl(owner, t.projectId)}/issues/${t.issueNumber}`
export const prUrl = (owner: string, t: Pick<Task, "projectId" | "prNumber">) => (t.prNumber ? `${repoUrl(owner, t.projectId)}/pull/${t.prNumber}` : null)
