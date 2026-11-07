import type { Store } from './db.ts';
import type { UsageSnapshot } from './types.ts';

/**
 * What runs cost. Every run reports an API-equivalent dollar cost (exact), and the usage readings before and after it
 * (whole percents of the 5-hour and 7-day limits, shared with the owner's own use). One run's difference is noise,
 * but summed over runs that had the limits to themselves, it gives "percent of the limit per dollar". With that,
 * every run's share of the limits can be estimated from its dollar cost.
 */
export interface CostRun {
  id: number;
  subject: string | null;
  role: string;
  model: string;
  startedAt: number;
  finishedAt: number | null;
  usd: number | null;
  before: UsageSnapshot | null;
  after: Partial<UsageSnapshot> | null;
}

export interface Calibration {
  /** Percent of the 5-hour limit per API-dollar; null until there are enough clean samples. */
  fiveHourPctPerUsd: number | null;
  sevenDayPctPerUsd: number | null;
  /** Clean samples behind the 5-hour ratio. */
  samples: number;
}

export const MIN_SAMPLES = 5;

/** Runs that overlapped no other run and saw no reset of the window: their usage difference is theirs alone. */
export function calibrate(runs: CostRun[]): Calibration {
  const done = runs.filter((r) => r.finishedAt !== null && (r.usd ?? 0) > 0);
  const solo = done.filter((r) => !done.some((o) => o.id !== r.id && o.startedAt < r.finishedAt! && (o.finishedAt ?? Infinity) > r.startedAt));
  const ratio = (pct: (u: Partial<UsageSnapshot>) => number | null | undefined, resets: (u: Partial<UsageSnapshot>) => number | null | undefined) => {
    let usd = 0;
    let pctSum = 0;
    let n = 0;
    for (const r of solo) {
      if (!r.before || !r.after) continue;
      const a = pct(r.before);
      const b = pct(r.after);
      if (a == null || b == null || resets(r.before) == null || resets(r.before) !== resets(r.after)) continue;
      usd += r.usd!;
      pctSum += Math.max(0, b - a);
      n++;
    }
    return { value: n >= MIN_SAMPLES && usd > 0 ? pctSum / usd : null, n };
  };
  const five = ratio((u) => u.fiveHourPct, (u) => u.fiveHourResetsAt);
  const seven = ratio((u) => u.sevenDayPct, (u) => u.sevenDayResetsAt);
  return { fiveHourPctPerUsd: five.value, sevenDayPctPerUsd: seven.value, samples: five.n };
}

export interface CostLine {
  key: string;
  runs: number;
  usd: number;
  /** Estimated share of the 5-hour / 7-day limit (null without a calibration). */
  fiveHourPct: number | null;
  sevenDayPct: number | null;
}

export interface CostReport {
  since: number;
  calibration: Calibration;
  total: CostLine;
  byProject: CostLine[];
  byRole: CostLine[];
  byModel: CostLine[];
  /** Studio phases: per message, across all studios. */
  studioPhases: (CostLine & { phase: string; model: string; perMessageUsd: number; perMessageFiveHourPct: number | null })[];
  days: { date: string; usd: number }[];
}

/** Where a run's cost belongs: a project, a plan's project or a studio. */
export type ProjectOf = (subject: string | null) => string;

export function costReport(runs: CostRun[], cal: Calibration, since: number, projectOf: ProjectOf, timezone: string): CostReport {
  const inRange = runs.filter((r) => r.startedAt >= since && r.usd !== null);
  const line = (key: string, rs: CostRun[]): CostLine => {
    const usd = rs.reduce((t, r) => t + (r.usd ?? 0), 0);
    return {
      key, runs: rs.length, usd,
      fiveHourPct: cal.fiveHourPctPerUsd === null ? null : usd * cal.fiveHourPctPerUsd,
      sevenDayPct: cal.sevenDayPctPerUsd === null ? null : usd * cal.sevenDayPctPerUsd,
    };
  };
  const group = (by: (r: CostRun) => string) => {
    const m = new Map<string, CostRun[]>();
    for (const r of inRange) m.set(by(r), [...(m.get(by(r)) ?? []), r]);
    return [...m].map(([k, rs]) => line(k, rs)).sort((a, b) => b.usd - a.usd);
  };
  const studio = inRange.filter((r) => r.role === 'studio' && r.subject?.startsWith('studio:') && !r.subject.endsWith(':standin'));
  const phases = new Map<string, CostRun[]>();
  for (const r of studio) {
    const k = `${r.subject!.split(':')[2]}|${r.model}`;
    phases.set(k, [...(phases.get(k) ?? []), r]);
  }
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Map<string, number>();
  for (const r of inRange) {
    const d = day.format(new Date(r.startedAt * 1000));
    days.set(d, (days.get(d) ?? 0) + (r.usd ?? 0));
  }
  return {
    since,
    calibration: cal,
    total: line('total', inRange),
    byProject: group((r) => projectOf(r.subject)),
    byRole: group((r) => r.role),
    byModel: group((r) => r.model),
    studioPhases: [...phases].map(([k, rs]) => {
      const [phase, model] = k.split('|') as [string, string];
      const l = line(k, rs);
      return { ...l, phase, model, perMessageUsd: l.usd / rs.length, perMessageFiveHourPct: l.fiveHourPct === null ? null : l.fiveHourPct / rs.length };
    }),
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, usd]) => ({ date, usd })),
  };
}

// ---------- reading from the database ----------

type Row = Record<string, unknown>;
const parse = <T>(s: unknown): T | null => {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

export function loadCostRuns(store: Store, since = 0): CostRun[] {
  return (store.db.prepare('SELECT id, subject, task_id, role, model, started_at, finished_at, cost_usd, usage_before, usage_after FROM runs WHERE started_at >= ? ORDER BY id').all(since) as Row[]).map((r) => ({
    id: Number(r.id),
    subject: (r.subject as string | null) ?? (r.task_id as string | null) ?? null,
    role: String(r.role),
    model: String(r.model),
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    usd: r.cost_usd == null ? null : Number(r.cost_usd),
    before: parse<UsageSnapshot>(r.usage_before),
    after: parse<Partial<UsageSnapshot>>(r.usage_after),
  }));
}

/** Names a run's subject for the report: the project of a task or plan, or the studio's title. */
export function projectNamer(store: Store): ProjectOf {
  const plans = new Map((store.db.prepare('SELECT id, project_id, title FROM plans').all() as Row[]).map((r) => [Number(r.id), { project: r.project_id as string | null, title: String(r.title) }]));
  const studios = new Map((store.db.prepare('SELECT id, title FROM studios').all() as Row[]).map((r) => [Number(r.id), String(r.title)]));
  return (subject) => {
    if (!subject) return 'other';
    if (subject.includes('#')) return subject.split('#')[0]!;
    const [kind, id] = subject.split(':');
    if (kind === 'plan') {
      const p = plans.get(Number(id));
      return p?.project ?? `New: ${p?.title ?? `plan ${id}`}`;
    }
    if (kind === 'studio') return `Studio: ${studios.get(Number(id)) ?? id}`;
    return subject;
  };
}

/** Measured cost of one message per studio phase and model (30 days, all studios), when there are 3+ messages. */
export function measuredPhaseCosts(store: Store, now: number): Map<string, number> {
  const runs = loadCostRuns(store, 0);
  const cal = calibrate(runs);
  const out = new Map<string, number>();
  if (cal.fiveHourPctPerUsd === null) return out;
  for (const p of costReport(runs, cal, now - 30 * 86400, () => '', 'UTC').studioPhases) {
    if (p.runs >= 3 && p.perMessageFiveHourPct !== null) out.set(`${p.phase}|${p.model}`, p.perMessageFiveHourPct);
  }
  return out;
}
