import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStep, MAX_FIX_ROUNDS_PER_ATTEMPT } from '../src/retry.ts';
import { assertTransition, branchName, canTransition, InvalidTransitionError } from '../src/tasks.ts';

test('retry ladder: fix in session, then fresh Sonnet, then Opus, then park', () => {
  const base = { risk: 'medium' as const, splitOnFail: false };
  assert.deepEqual(nextStep({ ...base, attempt: 1, fixRounds: 0, sessionId: 's1' }), { action: 'fix', model: 'sonnet', resumeSessionId: 's1' });
  assert.deepEqual(nextStep({ ...base, attempt: 1, fixRounds: MAX_FIX_ROUNDS_PER_ATTEMPT, sessionId: 's1' }), {
    action: 'restart', model: 'sonnet', attempt: 2, withFailureSummary: true,
  });
  assert.deepEqual(nextStep({ ...base, attempt: 2, fixRounds: MAX_FIX_ROUNDS_PER_ATTEMPT, sessionId: 's2' }), {
    action: 'restart', model: 'opus', attempt: 3, withFailureSummary: true,
  });
  assert.deepEqual(nextStep({ ...base, attempt: 3, fixRounds: MAX_FIX_ROUNDS_PER_ATTEMPT, sessionId: 's3' }), { action: 'park' });
  assert.deepEqual(nextStep({ ...base, attempt: 1, fixRounds: 0, sessionId: null }), { action: 'restart', model: 'sonnet', attempt: 2, withFailureSummary: true });
});

test('high-risk tasks run on Opus and split when marked', () => {
  assert.deepEqual(nextStep({ risk: 'high', attempt: 1, fixRounds: 0, sessionId: 's', splitOnFail: false }), { action: 'fix', model: 'opus', resumeSessionId: 's' });
  assert.deepEqual(nextStep({ risk: 'high', attempt: 2, fixRounds: 2, sessionId: 's', splitOnFail: false }), { action: 'park' });
  assert.deepEqual(nextStep({ risk: 'medium', attempt: 2, fixRounds: 2, sessionId: 's', splitOnFail: true }), { action: 'split' });
});

test('state machine refuses impossible transitions', () => {
  assert.equal(canTransition('queued', 'building'), true);
  assert.equal(canTransition('done', 'queued'), false);
  assert.equal(canTransition('queued', 'merging'), false);
  assert.throws(() => assertTransition('in_review', 'deploying'), InvalidTransitionError);
});

test('branch names are short, safe and prefixed', () => {
  assert.equal(branchName(12, 'Add login with GitHub (OAuth)!'), 'claude/12-add-login-with-github-oauth');
  assert.equal(branchName(3, '✨'), 'claude/3');
  assert.ok(branchName(7, 'x'.repeat(100)).length <= 'claude/7-'.length + 40);
});
