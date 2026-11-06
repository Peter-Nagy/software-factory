export type Model = 'haiku' | 'sonnet' | 'opus';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type Role =
  | 'intake'
  | 'planner'
  | 'architect'
  | 'implementer'
  | 'reviewer'
  | 'diagnoser'
  | 'triage'
  | 'improver';

export type Risk = 'low' | 'medium' | 'high';
export type ProjectKind = 'web-app' | 'static-site' | 'service' | 'cli' | 'ios';

export type RunMode = 'build' | 'fix' | 'resume';

export type ProjectState = 'spec_pending' | 'awaiting_approval' | 'active' | 'paused' | 'archived';

/**
 * Task lifecycle. A task is one GitHub issue.
 * queued -> building -> in_review -> merging -> deploying -> done
 * with side exits to fixing, blocked (waiting on a product question), parked and cancelled.
 */
export type TaskState =
  | 'queued'
  | 'building'
  | 'in_review'
  | 'fixing'
  | 'merging'
  | 'deploying'
  | 'done'
  | 'blocked'
  | 'parked'
  | 'cancelled';

export interface Project {
  id: string; // repo name, e.g. "habit-tracker"
  owner: string; // GitHub owner
  kind: ProjectKind;
  state: ProjectState;
  priority: number; // 1 (low) .. 5 (high)
  createdAt: number;
}

export interface Task {
  id: string; // "<project>#<issue>"
  projectId: string;
  issueNumber: number;
  title: string;
  state: TaskState;
  priority: number; // 1..5, inherits project priority unless overridden
  risk: Risk;
  area: string | null; // e.g. "auth", "ui"; two tasks in the same area of one repo never run together
  dependsOn: string[]; // task ids
  attempt: number; // 0 before first run
  fixRounds: number; // fix rounds within the current attempt
  sessionId: string | null; // claude session to resume for fixes
  branch: string | null;
  prNumber: number | null;
  splitOnFail: boolean;
  /** What the next run does: start a new attempt, fix in the existing session, or continue an interrupted run. */
  pendingMode: RunMode;
  /** Consecutive runs that ended without a verdict (usage limit, runner error). Reset by any completed run. */
  interruptions: number;
  /** Don't start before this time (epoch seconds), used for backoff after runner errors. */
  notBefore: number | null;
  estimatedCostPct: number; // estimated share of a 5-hour window this task's next run uses
  lastFailure: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Subscription usage as reported by Claude Code (percentages 0..100, reset times in epoch seconds). */
export interface UsageSnapshot {
  fiveHourPct: number | null;
  fiveHourResetsAt: number | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: number | null;
  source: 'stream' | 'statusline' | 'estimate' | 'limit-error';
  takenAt: number; // epoch seconds
}

export interface RunResult {
  ok: boolean;
  sessionId: string | null;
  resultText: string;
  totalCostUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  permissionDenials: string[];
  usage: Partial<UsageSnapshot> | null;
  hitUsageLimit: boolean;
  structuredOutput: unknown;
  timedOut: boolean;
  /** A final result event arrived. false = the agent never finished (runner error, crash, killed). */
  completed: boolean;
}
