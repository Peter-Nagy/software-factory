import type { TaskState } from './types.ts';

/** Allowed task state transitions. Anything not listed is a bug and is refused. */
export const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  // queued -> fixing = a failed task resumes its session to fix
  queued: ['building', 'fixing', 'blocked', 'parked', 'cancelled'],
  // building -> queued = checkpointed at a usage limit, resumes later
  building: ['in_review', 'fixing', 'blocked', 'parked', 'queued', 'cancelled'],
  in_review: ['merging', 'fixing', 'blocked', 'parked', 'queued', 'cancelled'],
  fixing: ['in_review', 'blocked', 'parked', 'queued', 'cancelled'],
  // merging -> fixing = rebase conflict or a check failed after rebase
  // merging -> in_review = main moved or the PR changed since the checks ran; check again
  merging: ['deploying', 'done', 'in_review', 'fixing', 'blocked', 'parked'],
  // deploying -> fixing = smoke test failed, change reverted, task reopened
  deploying: ['done', 'fixing', 'parked'],
  // blocked -> in_review = the owner approved a destructive migration
  blocked: ['queued', 'in_review', 'cancelled', 'parked'],
  parked: ['queued', 'cancelled'],
  done: [],
  cancelled: [],
};

/** States in which a container or deploy for the task is (or may be) running. */
export const ACTIVE_STATES: readonly TaskState[] = ['building', 'in_review', 'fixing', 'merging', 'deploying'];
export const TERMINAL_STATES: readonly TaskState[] = ['done', 'cancelled'];

export class InvalidTransitionError extends Error {}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(`Task cannot move from ${from} to ${to}`);
  }
}

export function taskId(projectId: string, issueNumber: number): string {
  return `${projectId}#${issueNumber}`;
}

/** Branch name for a task: claude/<issue>-<slug>. */
export function branchName(issueNumber: number, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `claude/${issueNumber}${slug ? `-${slug}` : ''}`;
}
