import type { GovernorConfig } from './config.ts';
import { decide, type GovernorDecision } from './governor.ts';
import { attemptLadder } from './retry.ts';
import { ACTIVE_STATES } from './tasks.ts';
import type { Model, Task, UsageSnapshot } from './types.ts';

export interface SchedulerInput {
  now: number;
  tasks: Task[]; // all non-terminal tasks
  runningTaskIds: Set<string>; // tasks with an agent container running right now
  cancelledTaskIds?: Set<string>; // dependents of these never start on their own
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
 * A fix or resume continues the current attempt; a build starts the next one.
 */
export function modelForNextRun(task: Task): Model {
  const ladder = attemptLadder(task.risk);
  const index = task.pendingMode === 'build' ? task.attempt : task.attempt - 1;
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
  // An area is held from a task's first build until it merges, including while it waits in the queue for a fix
  // or sits blocked on a question, so two open branches never touch the same area.
  const holdsArea = (t: Task) =>
    ACTIVE_STATES.includes(t.state) || input.runningTaskIds.has(t.id) || ((t.state === 'queued' || t.state === 'blocked') && t.branch !== null);
  const areaHolders = new Map<string, string>();
  for (const t of input.tasks) {
    const k = areaKey(t);
    if (k && holdsArea(t) && !areaHolders.has(k)) areaHolders.set(k, t.id);
  }
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
    if (task.notBefore !== null && task.notBefore > input.now) {
      skipped.push({ taskId: task.id, reason: 'backing off after a runner error' });
      wakeAt = wakeAt === null ? task.notBefore : Math.min(wakeAt, task.notBefore);
      continue;
    }
    // A dependency that isn't tracked is treated as done (closed before the factory saw it). A cancelled one blocks.
    const unmet = task.dependsOn.filter((d) => input.cancelledTaskIds?.has(d) || (byId.has(d) && byId.get(d)!.state !== 'done'));
    if (unmet.length > 0) {
      skipped.push({ taskId: task.id, reason: `waiting on ${unmet.join(', ')}` });
      continue;
    }
    const area = areaKey(task);
    const holder = area ? areaHolders.get(area) : undefined;
    if (area && holder !== undefined && holder !== task.id) {
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
    if (area) areaHolders.set(area, task.id);
  }

  return { picks, skipped, wakeAt };
}

/**
 * Pick tasks whose PR is ready for the review stage (gates, reviewer, merge). Finishing work goes before starting
 * new work, so the loop calls this before schedule(). One review stage per project at a time keeps merges serial.
 */
export function scheduleReviews(
  cfg: GovernorConfig,
  input: SchedulerInput & { reviewModel: (t: Task) => Model; reviewCostPct: number; runningProjects: Set<string> },
): Pick[] {
  const inFlight = input.tasks.filter((t) => input.runningTaskIds.has(t.id)).map((t) => ({ estimatedCostPct: t.estimatedCostPct }));
  const busyProjects = new Set(input.runningProjects);
  const picks: Pick[] = [];
  const candidates = input.tasks
    .filter((t) => t.state === 'in_review' && !input.runningTaskIds.has(t.id) && input.activeProjects.has(t.projectId))
    .filter((t) => t.notBefore === null || t.notBefore <= input.now)
    .sort((a, b) => b.priority - a.priority || a.updatedAt - b.updatedAt);
  for (const task of candidates) {
    if (busyProjects.has(task.projectId)) continue;
    const model = input.reviewModel(task);
    const d = decide(cfg, {
      now: input.now,
      usage: input.usage,
      model,
      estimatedCostPct: input.reviewCostPct,
      running: inFlight,
      pausedUntil: input.pausedUntil,
      ownUseDetected: input.ownUseDetected,
    });
    if (!d.allow) continue;
    picks.push({ task, model });
    inFlight.push({ estimatedCostPct: input.reviewCostPct });
    busyProjects.add(task.projectId);
  }
  return picks;
}
