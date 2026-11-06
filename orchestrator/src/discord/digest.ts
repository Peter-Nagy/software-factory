import type { Store } from '../db.ts';

type Row = Record<string, unknown>;

/** The daily summary: what shipped, what needs you, what's queued, and what it cost. */
export function digestText(store: Store, now: number, timezone: string): string {
  const since = now - 24 * 3600;
  const transitions = store.db
    .prepare(`SELECT task_id, json_extract(data, '$.to') AS "to" FROM events WHERE kind = 'task.transition' AND at >= ?`)
    .all(since) as Row[];
  const titled = (ids: string[]) =>
    [...new Set(ids)].map((id) => {
      const t = store.task(id);
      return `- ${id}${t ? ` ${t.title}${t.prNumber ? ` (PR #${t.prNumber})` : ''}` : ''}`;
    });
  const merged = titled(transitions.filter((r) => r.to === 'done').map((r) => String(r.task_id)));
  const parked = titled(transitions.filter((r) => r.to === 'parked').map((r) => String(r.task_id)));
  const open = store.openTasks();
  const count = (...states: string[]) => open.filter((t) => states.includes(t.state)).length;
  const questions = Number((store.db.prepare('SELECT COUNT(*) AS n FROM questions WHERE answer IS NULL').get() as Row).n);
  const costs = store.db
    .prepare('SELECT role, model, COUNT(*) AS n, ROUND(SUM(COALESCE(cost_usd, 0)), 2) AS usd FROM runs WHERE started_at >= ? GROUP BY role, model ORDER BY usd DESC')
    .all(since) as Row[];
  const u = store.latestUsage();
  const day = new Date(now * 1000).toLocaleDateString('en-GB', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long' });

  return [
    `**Factory digest, ${day}**`,
    merged.length ? `\nMerged (${merged.length}):\n${merged.join('\n')}` : '\nNothing merged in the last 24 hours.',
    parked.length ? `\nParked (${parked.length}), see #alerts:\n${parked.join('\n')}` : '',
    questions ? `\n${questions} question(s) waiting for you in #questions / #approvals.` : '',
    `\nQueue: ${count('queued')} queued, ${count('building', 'fixing')} building, ${count('in_review', 'merging')} in review, ${count('blocked')} waiting on you, ${count('parked')} parked.`,
    u ? `Usage: 5-hour ${u.fiveHourPct ?? '?'}%, 7-day ${u.sevenDayPct ?? '?'}%.` : '',
    costs.length ? `Runs (24 h, est.): ${costs.map((c) => `${c.role}/${c.model} ×${c.n} $${c.usd}`).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
