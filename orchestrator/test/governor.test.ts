import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GovernorConfigSchema } from '../src/config.ts';
import { decide, weeklyBurnLine, type GovernorInput } from '../src/governor.ts';
import type { UsageSnapshot } from '../src/types.ts';

const cfg = GovernorConfigSchema.parse({});
const NOW = 1_800_000_000;
const DAY = 86_400;

function usage(p: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    fiveHourPct: 10,
    fiveHourResetsAt: NOW + 3600,
    sevenDayPct: 10,
    sevenDayResetsAt: NOW + 6 * DAY, // one day into the week
    source: 'stream',
    takenAt: NOW,
    ...p,
  };
}

function input(p: Partial<GovernorInput>): GovernorInput {
  return { now: NOW, usage: usage({}), model: 'sonnet', estimatedCostPct: 6, running: [], pausedUntil: null, ownUseDetected: false, ...p };
}

test('burn line grows with elapsed week plus headroom, lifted near reset', () => {
  assert.equal(Math.round(weeklyBurnLine(cfg, NOW, NOW + 6 * DAY)), Math.round(100 / 7 + 10));
  assert.equal(Math.round(weeklyBurnLine(cfg, NOW, NOW + 3.5 * DAY)), 60);
  assert.equal(weeklyBurnLine(cfg, NOW, NOW + 11 * 3600), 100); // inside the 12 h sprint window
});

test('allows a normal Sonnet run within budget', () => {
  assert.equal(decide(cfg, input({})).allow, true);
});

test('manual pause wins and reports when to retry', () => {
  const d = decide(cfg, input({ pausedUntil: NOW + 600 }));
  assert.equal(d.allow, false);
  assert.equal(!d.allow && d.retryAt, NOW + 600);
});

test('parallel cap counts running tasks; halves when you are using Claude yourself', () => {
  const running = Array.from({ length: 6 }, () => ({ estimatedCostPct: 1 }));
  assert.equal(decide(cfg, input({ running })).allow, false);
  const three = Array.from({ length: 3 }, () => ({ estimatedCostPct: 1 }));
  assert.equal(decide(cfg, input({ running: three })).allow, true);
  assert.equal(decide(cfg, input({ running: three, ownUseDetected: true })).allow, false);
});

test('unknown or stale usage: conservative cap and no Opus', () => {
  assert.equal(decide(cfg, input({ usage: null })).allow, true);
  assert.equal(decide(cfg, input({ usage: null, model: 'opus' })).allow, false);
  assert.equal(decide(cfg, input({ usage: null, running: [{ estimatedCostPct: 1 }, { estimatedCostPct: 1 }] })).allow, false);
  const stale = usage({ takenAt: NOW - 3600 });
  assert.equal(decide(cfg, input({ usage: stale, model: 'opus' })).allow, false);
});

test('weekly hard stop pauses until the weekly reset', () => {
  const d = decide(cfg, input({ usage: usage({ sevenDayPct: 99 }) }));
  assert.equal(d.allow, false);
  assert.equal(!d.allow && d.retryAt, NOW + 6 * DAY + cfg.resumeGraceSeconds);
});

test('over the weekly burn line: small Sonnet tasks only, no Opus', () => {
  const over = usage({ sevenDayPct: 40 }); // line is ~24% one day in
  assert.equal(decide(cfg, input({ usage: over, estimatedCostPct: 3 })).allow, true);
  assert.equal(decide(cfg, input({ usage: over, estimatedCostPct: 6 })).allow, false);
  assert.equal(decide(cfg, input({ usage: over, model: 'opus', estimatedCostPct: 3 })).allow, false);
});

test('5-hour window: Opus stops at 70%, everything at 90%, projected spend counts', () => {
  assert.equal(decide(cfg, input({ usage: usage({ fiveHourPct: 75 }), model: 'opus' })).allow, false);
  assert.equal(decide(cfg, input({ usage: usage({ fiveHourPct: 75 }) })).allow, true);
  const full = decide(cfg, input({ usage: usage({ fiveHourPct: 91 }) }));
  assert.equal(full.allow, false);
  assert.equal(!full.allow && full.retryAt, NOW + 3600 + cfg.resumeGraceSeconds);
  assert.equal(decide(cfg, input({ usage: usage({ fiveHourPct: 80 }), running: [{ estimatedCostPct: 6 }], estimatedCostPct: 6 })).allow, false);
});

test('sprint window before weekly reset lifts the burn line', () => {
  const nearReset = usage({ sevenDayPct: 85, sevenDayResetsAt: NOW + 6 * 3600 });
  assert.equal(decide(cfg, input({ usage: nearReset, model: 'opus' })).allow, true);
});

test('a known limit keeps blocking after the reading goes stale, until its reset', () => {
  const hitLongAgo = usage({ fiveHourPct: 100, fiveHourResetsAt: NOW + 600, takenAt: NOW - 3 * 3600 });
  const d = decide(cfg, input({ usage: hitLongAgo }));
  assert.equal(d.allow, false);
  assert.equal(!d.allow && d.retryAt, NOW + 600 + cfg.resumeGraceSeconds);
  // Once the reset has passed, the stale reading means "unknown": conservative start allowed.
  assert.equal(decide(cfg, input({ usage: usage({ fiveHourPct: 100, fiveHourResetsAt: NOW - 1, takenAt: NOW - 3 * 3600 }) })).allow, true);
  const weekly = usage({ sevenDayPct: 99, sevenDayResetsAt: NOW + 2 * DAY, takenAt: NOW - 2 * DAY });
  assert.equal(decide(cfg, input({ usage: weekly })).allow, false);
});

test('a fresh reading without a 5-hour number is treated as unknown', () => {
  assert.equal(decide(cfg, input({ usage: usage({ fiveHourPct: null }), model: 'opus' })).allow, false);
});
