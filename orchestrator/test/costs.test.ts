import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrate, costReport, loadCostRuns, MIN_SAMPLES, projectNamer, type CostRun } from '../src/costs.ts';
import { Store } from '../src/db.ts';

const u = (five: number, seven: number, resets = 1000) => ({ fiveHourPct: five, fiveHourResetsAt: resets, sevenDayPct: seven, sevenDayResetsAt: 9000, source: 'stream' as const, takenAt: 0 });
let next = 1;
const run = (p: Partial<CostRun> & { start: number; end: number; usd: number; b?: number; a?: number }): CostRun => ({
  id: next++, subject: p.subject ?? 'app#1', role: p.role ?? 'implementer', model: p.model ?? 'sonnet',
  startedAt: p.start, finishedAt: p.end, usd: p.usd,
  before: p.before ?? u(p.b ?? 10, 5), after: p.after ?? u(p.a ?? 12, 5),
});

test('costs: the ratio comes only from runs that had the limits to themselves, within one window', () => {
  next = 1;
  const solo = Array.from({ length: MIN_SAMPLES }, (_, i) => run({ start: i * 100, end: i * 100 + 50, usd: 1, b: 10, a: 12 })); // 2% per $
  const overlapping = [run({ start: 1000, end: 1100, usd: 1, b: 10, a: 40 }), run({ start: 1050, end: 1150, usd: 1, b: 10, a: 40 })];
  const reset = run({ start: 2000, end: 2100, usd: 1, before: u(90, 5, 1000), after: u(3, 5, 2000) });
  const cal = calibrate([...solo, ...overlapping, reset]);
  assert.equal(cal.fiveHourPctPerUsd, 2);
  assert.equal(cal.samples, MIN_SAMPLES);
  assert.equal(calibrate(solo.slice(1)).fiveHourPctPerUsd, null); // too few samples
});

test('costs: report by project, role, model and studio phase, with estimated shares of the limits', () => {
  next = 1;
  const runs = [
    run({ start: 100, end: 150, usd: 2, subject: 'app#1', role: 'implementer' }),
    run({ start: 200, end: 250, usd: 1, subject: 'app#2', role: 'reviewer', model: 'opus' }),
    run({ start: 300, end: 350, usd: 0.5, subject: 'studio:1:brief', role: 'studio', model: 'opus' }),
    run({ start: 400, end: 450, usd: 1.5, subject: 'studio:1:brief', role: 'studio', model: 'opus' }),
    run({ start: 500, end: 550, usd: 9, subject: 'studio:1:brief:standin', role: 'studio', model: 'opus' }),
    run({ start: 10, end: 20, usd: 5, subject: 'old#1' }), // before the range
  ];
  const r = costReport(runs, { fiveHourPctPerUsd: 2, sevenDayPctPerUsd: 0.5, samples: 9 }, 50, (s) => (s?.startsWith('studio:') ? 'Studio: Run' : s!.split('#')[0]!), 'UTC');
  assert.equal(r.total.usd, 14);
  assert.equal(r.total.fiveHourPct, 28);
  assert.equal(r.total.sevenDayPct, 7);
  assert.deepEqual(r.byProject.map((l) => [l.key, l.usd]), [['Studio: Run', 11], ['app', 3]]);
  assert.deepEqual(r.byRole.map((l) => l.key), ['studio', 'implementer', 'reviewer']);
  assert.deepEqual(r.studioPhases.map((p) => [p.phase, p.model, p.runs, p.perMessageUsd, p.perMessageFiveHourPct]), [['brief', 'opus', 2, 1, 2]]); // stand-in runs aren't messages
  assert.deepEqual(r.days, [{ date: '1970-01-01', usd: 14 }]);
});

test('costs: runs carry their subject; plans and studios get readable names', () => {
  const store = new Store(':memory:');
  store.db.prepare("INSERT INTO plans (title, target, project_id, created_at, updated_at) VALUES ('Weekly review', 'existing', 'habits', 1, 1)").run();
  store.db.prepare("INSERT INTO plans (title, target, created_at, updated_at) VALUES ('Brand new', 'new', 1, 1)").run();
  store.db.prepare("INSERT INTO studios (title, created_at, updated_at) VALUES ('Running app', 1, 1)").run();
  const id = store.startRun({ taskId: null, role: 'studio', model: 'opus', logPath: 'x', usageBefore: null, subject: 'studio:1:brief' });
  store.startRun({ taskId: 'app#3', role: 'implementer', model: 'sonnet', logPath: 'x', usageBefore: null });
  const runs = loadCostRuns(store);
  assert.deepEqual(runs.map((r) => r.subject), ['studio:1:brief', 'app#3']);
  assert.equal(runs[0]!.id, id);
  const name = projectNamer(store);
  assert.deepEqual(['app#3', 'plan:1', 'plan:2', 'studio:1:brief', null].map(name), ['app', 'habits', 'New: Brand new', 'Studio: Running app', 'other']);
});
