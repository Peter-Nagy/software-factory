import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildClaudeArgs, extractUsage, parseStream } from '../src/claude.ts';
import { dockerRunArgs } from '../src/runner/container.ts';
import { snapshotAfterRun } from '../src/usage.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('claude args: unattended auto mode, subscription login (no --bare), resume and limits', () => {
  const args = buildClaudeArgs({ prompt: 'do it', model: 'sonnet', effort: 'medium', maxTurns: 50, resumeSessionId: 'abc', appendSystemPromptFile: '/p.md' });
  assert.deepEqual(args.slice(0, 2), ['-p', 'do it']);
  assert.ok(!args.includes('--bare'));
  const flag = (f: string) => args[args.indexOf(f) + 1];
  assert.equal(flag('--permission-mode'), 'auto');
  assert.equal(flag('--permission-prompts'), 'none');
  assert.equal(flag('--output-format'), 'stream-json');
  assert.equal(flag('--model'), 'sonnet');
  assert.equal(flag('--max-turns'), '50');
  assert.equal(flag('--resume'), 'abc');
  assert.equal(flag('--append-system-prompt-file'), '/p.md');
});

test('stream parser: success run with cost, session, denials and usage', () => {
  const r = parseStream(fixture('run-success.jsonl'));
  assert.equal(r.ok, true);
  assert.equal(r.sessionId, 'sess-123');
  assert.equal(r.totalCostUsd, 0.42);
  assert.equal(r.numTurns, 17);
  assert.deepEqual(r.permissionDenials, ['Bash']);
  assert.equal(r.usage?.fiveHourPct, 23.5);
  assert.equal(r.usage?.sevenDayResetsAt, 1738857600);
  assert.equal(r.hitUsageLimit, false);
});

test('stream parser: usage limit error is detected; timeouts are not ok', () => {
  const r = parseStream(fixture('run-limit.jsonl'));
  assert.equal(r.ok, false);
  assert.equal(r.hitUsageLimit, true);
  assert.equal(parseStream(fixture('run-success.jsonl'), true).ok, false);
});

test('usage extraction accepts other plausible shapes', () => {
  assert.deepEqual(extractUsage({ type: 'rate_limit_event', rate_limit_info: { five_hour: { utilization: 0.4, resets_at: '2026-11-06T15:00:00Z' } } }), {
    fiveHourPct: 40,
    fiveHourResetsAt: Date.parse('2026-11-06T15:00:00Z') / 1000,
  });
  assert.equal(extractUsage({ type: 'assistant', message: { content: [] } }), null);
});

test('snapshot after a limit error with no numbers means 100% and a re-check soon', () => {
  const now = 1_800_000_000;
  const snap = snapshotAfterRun(null, parseStream(fixture('run-limit.jsonl')), now)!;
  assert.equal(snap.fiveHourPct, 100);
  assert.equal(snap.source, 'limit-error');
  assert.equal(snap.fiveHourResetsAt, now + 1800);
});

test('snapshot keeps previous windows unless they have reset', () => {
  const now = 1_800_000_000;
  const prev = { fiveHourPct: 50, fiveHourResetsAt: now - 10, sevenDayPct: 30, sevenDayResetsAt: now + 1000, source: 'stream' as const, takenAt: now - 600 };
  const noUsage = { ...parseStream(fixture('run-success.jsonl')), usage: null };
  const snap = snapshotAfterRun(prev, noUsage, now)!;
  assert.equal(snap.fiveHourPct, null); // window reset
  assert.equal(snap.sevenDayPct, 30);
});

test('docker args: isolation flags, read-only config, secrets by name only', () => {
  const args = dockerRunArgs(
    { name: 'factory-x', image: 'factory-worker:1', worktree: '/w', workerConfigDir: '/cfg', sessionsDir: '/s', cpus: 4, memoryGb: 6, envNames: ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN'] },
    ['-p', 'hi'],
  );
  const joined = args.join(' ');
  for (const part of ['--rm', '--cap-drop ALL', 'no-new-privileges', '--memory 6g', '-v /w:/work', '-v /cfg:/home/worker/.claude-config:ro', '-v /s:/home/worker/.claude/projects', '-e GH_TOKEN']) {
    assert.ok(joined.includes(part), `missing ${part}`);
  }
  assert.ok(!joined.includes('GH_TOKEN='), 'secret values must never be on the command line');
  assert.deepEqual(args.slice(-4), ['factory-worker:1', 'claude', '-p', 'hi']);
  assert.throws(() => dockerRunArgs({ name: 'x', image: 'i', worktree: '/w', workerConfigDir: '/c', sessionsDir: '/s', cpus: 1, memoryGb: 1, envNames: ['bad name'] }, []));
});
