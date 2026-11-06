import { taskId } from './tasks.ts';
import type { Risk, Task } from './types.ts';

export interface IssueLike {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
}

/**
 * Turn a GitHub issue into task fields. Conventions the architect agent follows when it writes issues:
 *   labels: factory:ready, priority:1..5, risk:low|medium|high, area:<name>, size:s|m|l, split-on-fail
 *   body:   a line "Depends on #12, #15" for ordering
 */
export function taskFromIssue(projectId: string, projectPriority: number, issue: IssueLike): Omit<Task, 'createdAt' | 'updatedAt'> {
  const labels = issue.labels.map((l) => l.name.toLowerCase());
  const valueOf = (prefix: string) => labels.find((l) => l.startsWith(prefix))?.slice(prefix.length) ?? null;

  const priorityRaw = Number(valueOf('priority:'));
  const priority = Number.isInteger(priorityRaw) && priorityRaw >= 1 && priorityRaw <= 5 ? priorityRaw : projectPriority;
  const riskRaw = valueOf('risk:');
  const risk: Risk = riskRaw === 'low' || riskRaw === 'high' ? riskRaw : 'medium';
  const size = valueOf('size:');
  const estimatedCostPct = size === 's' ? 3 : size === 'l' ? 12 : 6;

  const deps = new Set<string>();
  for (const line of (issue.body ?? '').split('\n')) {
    const m = /^\s*(?:[-*]\s*)?depends\s+on\s*:?\s*(.+)$/i.exec(line);
    if (!m) continue;
    for (const ref of m[1]!.matchAll(/#(\d+)/g)) deps.add(taskId(projectId, Number(ref[1])));
  }

  return {
    id: taskId(projectId, issue.number),
    projectId,
    issueNumber: issue.number,
    title: issue.title,
    state: 'queued',
    priority,
    risk,
    area: valueOf('area:'),
    dependsOn: [...deps],
    attempt: 0,
    fixRounds: 0,
    sessionId: null,
    branch: null,
    prNumber: null,
    splitOnFail: labels.includes('split-on-fail'),
    estimatedCostPct: risk === 'high' ? estimatedCostPct * 2 : estimatedCostPct,
    lastFailure: null,
  };
}
