import type { Model, Risk } from './types.ts';

export const MAX_FIX_ROUNDS_PER_ATTEMPT = 2;

/** Model for each fresh attempt. The fixer between attempts resumes the same session on the same model. */
export function attemptLadder(risk: Risk): Model[] {
  return risk === 'high' ? ['opus', 'opus'] : ['sonnet', 'sonnet', 'opus'];
}

export type NextStep =
  | { action: 'fix'; model: Model; resumeSessionId: string }
  | { action: 'restart'; model: Model; attempt: number; withFailureSummary: boolean }
  | { action: 'split' }
  | { action: 'park' };

export interface RetryState {
  risk: Risk;
  attempt: number; // 1-based attempt that just failed
  fixRounds: number; // fix rounds already used in this attempt
  sessionId: string | null;
  splitOnFail: boolean;
}

/**
 * What to do after a gate or review failure.
 * 1. resume the same session to fix (cheap: prompt cache), up to MAX_FIX_ROUNDS_PER_ATTEMPT times
 * 2. start a fresh session on the next model in the ladder, with a summary of what failed
 * 3. split the task (if the architect marked it) or park it with a diagnosis
 */
export function nextStep(s: RetryState): NextStep {
  const ladder = attemptLadder(s.risk);
  const currentModel = ladder[Math.min(s.attempt, ladder.length) - 1] ?? ladder[ladder.length - 1]!;

  if (s.sessionId && s.fixRounds < MAX_FIX_ROUNDS_PER_ATTEMPT) {
    return { action: 'fix', model: currentModel, resumeSessionId: s.sessionId };
  }
  if (s.splitOnFail && s.attempt >= 2) {
    return { action: 'split' };
  }
  if (s.attempt < ladder.length) {
    return { action: 'restart', model: ladder[s.attempt]!, attempt: s.attempt + 1, withFailureSummary: true };
  }
  return { action: 'park' };
}

export function firstAttemptModel(risk: Risk): Model {
  return attemptLadder(risk)[0]!;
}
