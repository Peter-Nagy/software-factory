import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GovernorConfigSchema } from '../src/config.ts';
import { modelForNextRun, schedule, type SchedulerInput } from '../src/scheduler.ts';
import type { Task } from '../src/types.ts';

const cfg = GovernorConfigSchema.parse({});
const NOW = 1_800_000_000;

let seq = 0;
function task(p: Partial<Task>): Task {
  seq++;
  return {
    id: `app#${seq}`, projectId: 'app', issueNumber: seq, title: `Task ${seq}`, state: 'queued', priority: 3, risk: 'medium',
    area: null, dependsOn: [], attempt: 0, fixRounds: 0, sessionId: null, branch: null, prNumber: null, splitOnFail: false,
    estimatedCostPct: 5, lastFailure: null, createdAt: NOW - 1000 + seq, updatedAt: NOW, ...p,
  };
}

function input(tasks: Task[], p: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    now: NOW, tasks, runningTaskIds: new Set(), activeProjects: new Set(['app']),
    usage: { fiveHourPct: 10, fiveHourResetsAt: NOW + 3600, sevenDayPct: 5, sevenDayResetsAt: NOW + 6 * 86400, source: 'stream', takenAt: NOW },
    pausedUntil: null, ownUseDetected: false, ...p,
  };
}

test('picks highest priority first, then oldest', () => {
  const a = task({ priority: 2 });
  const b = task({ priority: 5 });
  const c = task({ priority: 5 });
  const out = schedule(cfg, input([a, b, c]));
  assert.deepEqual(out.picks.map((p) => p.task.id), [b.id, c.id, a.id]);
});

test('waits for unfinished dependencies; untracked dependencies count as done', () => {
  const dep = task({ state: 'in_review' });
  const blocked = task({ dependsOn: [dep.id] });
  const free = task({ dependsOn: ['app#999'] });
  const out = schedule(cfg, input([dep, blocked, free]));
  assert.deepEqual(out.picks.map((p) => p.task.id), [free.id]);
  assert.match(out.skipped.find((s) => s.taskId === blocked.id)!.reason, /waiting on/);
});

test('never two tasks in the same area of one repo', () => {
  const open = task({ area: 'auth', state: 'in_review' });
  const same = task({ area: 'auth' });
  const t1 = task({ area: 'ui' });
  const t2 = task({ area: 'ui' });
  const out = schedule(cfg, input([open, same, t1, t2]));
  assert.deepEqual(out.picks.map((p) => p.task.id), [t1.id]);
});

test('skips inactive projects and tasks already running', () => {
  const other = task({ projectId: 'paused-app' });
  const live = task({});
  const out = schedule(cfg, input([other, live], { runningTaskIds: new Set([live.id]) }));
  assert.equal(out.picks.length, 0);
});

test('stops at the 5-hour budget and reports the wake time', () => {
  const tasks = [task({ estimatedCostPct: 30 }), task({ estimatedCostPct: 30 }), task({ estimatedCostPct: 30 })];
  const out = schedule(cfg, input(tasks, { usage: { fiveHourPct: 20, fiveHourResetsAt: NOW + 1800, sevenDayPct: 5, sevenDayResetsAt: NOW + 6 * 86400, source: 'stream', takenAt: NOW } }));
  assert.equal(out.picks.length, 2); // 20 + 30 + 30 = 80 <= 90; a third would project 110
  const full = schedule(cfg, input(tasks, { usage: { fiveHourPct: 95, fiveHourResetsAt: NOW + 1800, sevenDayPct: 5, sevenDayResetsAt: NOW + 6 * 86400, source: 'stream', takenAt: NOW } }));
  assert.equal(full.picks.length, 0);
  assert.equal(full.wakeAt, NOW + 1800 + cfg.resumeGraceSeconds);
});

test('model follows the attempt ladder; a session continues its attempt', () => {
  assert.equal(modelForNextRun(task({ attempt: 0 })), 'sonnet');
  assert.equal(modelForNextRun(task({ attempt: 1 })), 'sonnet'); // fresh second attempt
  assert.equal(modelForNextRun(task({ attempt: 2 })), 'opus'); // fresh third attempt
  assert.equal(modelForNextRun(task({ attempt: 2, sessionId: 's' })), 'sonnet'); // fixing attempt 2
  assert.equal(modelForNextRun(task({ attempt: 0, risk: 'high' })), 'opus');
});
