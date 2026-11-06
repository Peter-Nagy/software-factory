import type { RunResult, UsageSnapshot } from './types.ts';

/**
 * Build a fresh usage snapshot after a run. Numbers the run reported win; missing windows keep the previous
 * reading unless that window has already reset. A usage-limit error with no numbers means "at 100%".
 */
export function snapshotAfterRun(prev: UsageSnapshot | null, run: RunResult, now: number): UsageSnapshot | null {
  const keep = (pct: number | null | undefined, resetsAt: number | null | undefined) =>
    resetsAt !== null && resetsAt !== undefined && resetsAt <= now ? { pct: null, resetsAt: null } : { pct: pct ?? null, resetsAt: resetsAt ?? null };

  const prevFive = keep(prev?.fiveHourPct, prev?.fiveHourResetsAt);
  const prevSeven = keep(prev?.sevenDayPct, prev?.sevenDayResetsAt);
  const u = run.usage ?? {};

  const snap: UsageSnapshot = {
    fiveHourPct: u.fiveHourPct ?? prevFive.pct,
    fiveHourResetsAt: u.fiveHourResetsAt ?? prevFive.resetsAt,
    sevenDayPct: u.sevenDayPct ?? prevSeven.pct,
    sevenDayResetsAt: u.sevenDayResetsAt ?? prevSeven.resetsAt,
    source: run.usage ? 'stream' : prev?.source ?? 'estimate',
    // Copied numbers keep their original time, so an old reading never looks fresh.
    takenAt: run.usage ? now : prev?.takenAt ?? now,
  };

  if (run.hitUsageLimit && u.fiveHourPct === undefined) {
    snap.fiveHourPct = 100;
    snap.source = 'limit-error';
    snap.takenAt = now;
    // Without a reported reset time, check again in 30 minutes with a cheap probe run.
    snap.fiveHourResetsAt ??= now + 30 * 60;
  }

  if (!run.usage && !run.hitUsageLimit && prev === null) return null;
  return snap;
}
