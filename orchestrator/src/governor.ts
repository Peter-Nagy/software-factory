import type { GovernorConfig } from './config.ts';
import type { Model, UsageSnapshot } from './types.ts';

const WEEK_S = 7 * 24 * 3600;
/** A usage reading older than this is treated as unknown. */
export const USAGE_STALE_AFTER_S = 15 * 60;

export interface GovernorInput {
  now: number; // epoch seconds
  usage: UsageSnapshot | null;
  model: Model;
  estimatedCostPct: number; // this run's estimated share of a 5-hour window
  running: { estimatedCostPct: number }[]; // runs already in flight
  pausedUntil: number | null; // manual /pause or /yield (epoch seconds), null = not paused
  ownUseDetected: boolean; // usage rising faster than the factory's own runs explain
}

export type GovernorDecision =
  | { allow: true; reason: string }
  | { allow: false; reason: string; retryAt: number | null };

/** Allowed 7-day usage at `now`: elapsed share of the week + headroom, lifted to 100 near the reset. */
export function weeklyBurnLine(cfg: GovernorConfig, now: number, sevenDayResetsAt: number): number {
  const windowStart = sevenDayResetsAt - WEEK_S;
  const elapsed = Math.min(Math.max((now - windowStart) / WEEK_S, 0), 1);
  if (sevenDayResetsAt - now <= cfg.sprintHoursBeforeWeeklyReset * 3600) return 100;
  return Math.min(100, elapsed * 100 + cfg.weeklyHeadroomPct);
}

export function maxParallel(cfg: GovernorConfig, usage: UsageSnapshot | null, now: number, ownUseDetected: boolean): number {
  const known = usage !== null && usage.fiveHourPct !== null && now - usage.takenAt <= USAGE_STALE_AFTER_S;
  let cap = known ? cfg.maxParallel : cfg.unknownUsageMaxParallel;
  if (ownUseDetected) cap = Math.max(1, Math.floor(cap / 2));
  return cap;
}

/**
 * Decide whether a new agent run may start now. Pure function: all inputs explicit, no I/O.
 * Order of checks matters: hard stops first, then pacing.
 */
export function decide(cfg: GovernorConfig, input: GovernorInput): GovernorDecision {
  const { now, usage, model, estimatedCostPct, running, pausedUntil, ownUseDetected } = input;

  if (pausedUntil !== null && pausedUntil > now) {
    return { allow: false, reason: 'factory paused by you', retryAt: pausedUntil };
  }

  const cap = maxParallel(cfg, usage, now, ownUseDetected);
  if (running.length >= cap) {
    return { allow: false, reason: `parallel cap reached (${running.length}/${cap})`, retryAt: null };
  }

  // A known limit that hasn't reset yet blocks no matter how old the reading is:
  // usage only refreshes when a run finishes, so "stale" must never mean "free to go" during a limit.
  if (usage !== null) {
    const isFresh = now - usage.takenAt <= USAGE_STALE_AFTER_S;
    const stillOn = (resetsAt: number | null) => (resetsAt !== null ? resetsAt > now : isFresh);
    if (usage.sevenDayPct !== null && usage.sevenDayPct >= cfg.weeklyHardStopPct && stillOn(usage.sevenDayResetsAt)) {
      return { allow: false, reason: `weekly usage at ${usage.sevenDayPct}%`, retryAt: usage.sevenDayResetsAt !== null ? usage.sevenDayResetsAt + cfg.resumeGraceSeconds : null };
    }
    if (usage.fiveHourPct !== null && usage.fiveHourPct >= cfg.anyMaxFiveHourPct && stillOn(usage.fiveHourResetsAt)) {
      return { allow: false, reason: `5-hour usage at ${usage.fiveHourPct}%`, retryAt: usage.fiveHourResetsAt !== null ? usage.fiveHourResetsAt + cfg.resumeGraceSeconds : null };
    }
  }

  const fresh = usage !== null && usage.fiveHourPct !== null && now - usage.takenAt <= USAGE_STALE_AFTER_S;
  if (!fresh || usage === null) {
    // No reliable numbers: allow conservatively, never Opus, until a run reports usage.
    if (model === 'opus') return { allow: false, reason: 'usage unknown; holding Opus runs', retryAt: null };
    return { allow: true, reason: 'usage unknown; conservative start' };
  }

  // Weekly window: pace against the burn line.
  if (usage.sevenDayPct !== null && usage.sevenDayResetsAt !== null) {
    const line = weeklyBurnLine(cfg, now, usage.sevenDayResetsAt);
    if (usage.sevenDayPct > line) {
      if (model === 'opus') {
        return { allow: false, reason: `over weekly burn line (${usage.sevenDayPct}% > ${line.toFixed(0)}%); no Opus`, retryAt: null };
      }
      if (estimatedCostPct > cfg.smallTaskMaxPct) {
        return { allow: false, reason: `over weekly burn line (${usage.sevenDayPct}% > ${line.toFixed(0)}%); small tasks only`, retryAt: null };
      }
    }
  }

  // 5-hour window.
  if (usage.fiveHourPct !== null) {
    const retryAt = usage.fiveHourResetsAt !== null ? usage.fiveHourResetsAt + cfg.resumeGraceSeconds : null;
    if (model === 'opus' && usage.fiveHourPct >= cfg.opusMaxFiveHourPct) {
      return { allow: false, reason: `5-hour usage at ${usage.fiveHourPct}%; no new Opus runs`, retryAt };
    }
    const inFlight = running.reduce((sum, r) => sum + r.estimatedCostPct, 0);
    const projected = usage.fiveHourPct + inFlight + estimatedCostPct;
    if (projected > cfg.anyMaxFiveHourPct) {
      return { allow: false, reason: `would exceed 5-hour budget (projected ${projected.toFixed(0)}%)`, retryAt: null };
    }
  }

  return { allow: true, reason: 'within budget' };
}
