import type { GovernorConfig } from './config.ts';
import { decide, type GovernorDecision } from './governor.ts';
import { attemptLadder } from './retry.ts';
import { ACTIVE_STATES } from './tasks.ts';
import type { Model, Task, UsageSnapshot } from './types.ts';

export interface SchedulerInput {
  now: number;
  tasks: Task[]; // all non-terminal tasks
  runningTaskIds: Set<string>; // tasks with an agent container running right now
  activeProjects: Set<string>; // projects in state 'active'
  usage: UsageSnapshot | null;
  pausedUntil: number | null;
  ownUseDetected: boolean;
}

export interface Pick {
  task: Task;
  model: Model;
}

export interface SchedulerOutput {
  picks: Pick[];
  skipped: { taskId: string; reason: string }[];
  /** Earliest time a usage-blocked task could start; the loop can sleep until then. */
  wakeAt: number | null;
}

/**
 * Model for the task's next run. `attempt` counts attempts started so far.
 * A task with a session continues that attempt (fix or checkpoint resume); otherwise a fresh attempt starts.
 */
export function modelForNextRun(task: Task): Model {
  const ladder = attemptLadder(task.risk);
  const index = task.sessionId ? task.attempt - 1 : task.attempt;
  return ladder[Math.min(Math.max(index, 0), ladder.length - 1)]!;
}

function areaKey(t: Task): string | null {
  return t.area ? `${t.projectId}:${t.area}` : null;
}

/**
 * Choose which queued tasks start now.
 * - only tasks of active projects, with all dependencies done
 * - highest priority first, then oldest
 * - never two tasks on the same area of one repo at once
 * - each start must pass the usage governor, counting the picks made so far
 */
export function schedule(cfg: GovernorConfig, input: SchedulerInput): SchedulerOutput {
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  // Areas are busy from the first build until merge, so two open PRs never touch the same area.
  const inProgress = input.tasks.filter((t) => ACTIVE_STATES.includes(t.state) || input.runningTaskIds.has(t.id));
  const busyAreas = new Set(inProgress.map(areaKey).filter((k): k is string => k !== null));
  // Only runs with a live agent count against parallelism and the 5-hour budget.
  const inFlight = input.tasks.filter((t) => input.runningTaskIds.has(t.id)).map((t) => ({ estimatedCostPct: t.estimatedCostPct }));

  const candidates = input.tasks
    .filter((t) => t.state === 'queued' && !input.runningTaskIds.has(t.id))
    .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

  const picks: Pick[] = [];
  const skipped: { taskId: string; reason: string }[] = [];
  let wakeAt: number | null = null;

  for (const task of candidates) {
    if (!input.activeProjects.has(task.projectId)) {
      skipped.push({ taskId: task.id, reason: 'project not active' });
      continue;
    }
    // A dependency that isn't tracked as a task is treated as done (closed before the factory saw it).
    const unmet = task.dependsOn.filter((d) => byId.has(d) && byId.get(d)!.state !== 'done');
    if (unmet.length > 0) {
      skipped.push({ taskId: task.id, reason: `waiting on ${unmet.join(', ')}` });
      continue;
    }
    const area = areaKey(task);
    if (area && busyAreas.has(area)) {
      skipped.push({ taskId: task.id, reason: `area ${task.area} busy` });
      continue;
    }

    const model = modelForNextRun(task);
    const decision: GovernorDecision = decide(cfg, {
      now: input.now,
      usage: input.usage,
      model,
      estimatedCostPct: task.estimatedCostPct,
      running: inFlight,
      pausedUntil: input.pausedUntil,
      ownUseDetected: input.ownUseDetected,
    });
    if (!decision.allow) {
      skipped.push({ taskId: task.id, reason: decision.reason });
      if (decision.retryAt !== null) wakeAt = wakeAt === null ? decision.retryAt : Math.min(wakeAt, decision.retryAt);
      continue;
    }

    picks.push({ task, model });
    inFlight.push({ estimatedCostPct: task.estimatedCostPct });
    if (area) busyAreas.add(area);
  }

  return { picks, skipped, wakeAt };
}
