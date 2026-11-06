import type { PipelineContext } from './pipeline.ts';
import { approveMigration, rejectMigration } from './review.ts';

export type QuestionKind = 'product' | 'migration';

export interface Question {
  id: number;
  kind: QuestionKind;
  taskId: string | null;
  projectId: string | null;
  question: string;
  options: string[];
  defaultOption: string | null;
  askedAt: number;
  timeoutAt: number;
  answer: string | null;
  answeredBy: string | null;
  delivered: boolean;
  discordMessageId: string | null;
  discordChannelId: string | null;
}

type Row = Record<string, unknown>;
const toQuestion = (r: Row): Question => ({
  id: Number(r.id),
  kind: r.kind as QuestionKind,
  taskId: (r.task_id as string | null) ?? null,
  projectId: (r.project_id as string | null) ?? null,
  question: String(r.question),
  options: JSON.parse(String(r.options)) as string[],
  defaultOption: (r.default_option as string | null) ?? null,
  askedAt: Number(r.asked_at),
  timeoutAt: Number(r.timeout_at),
  answer: (r.answer as string | null) ?? null,
  answeredBy: (r.answered_by as string | null) ?? null,
  delivered: Number(r.delivered) === 1,
  discordMessageId: (r.discord_message_id as string | null) ?? null,
  discordChannelId: (r.discord_channel_id as string | null) ?? null,
});

export function getQuestion(ctx: Pick<PipelineContext, 'store'>, id: number): Question | null {
  const r = ctx.store.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Row | undefined;
  return r ? toQuestion(r) : null;
}

export function openQuestions(ctx: Pick<PipelineContext, 'store'>): Question[] {
  return (ctx.store.db.prepare('SELECT * FROM questions WHERE answer IS NULL ORDER BY id').all() as Row[]).map(toQuestion);
}

/** Questions not yet posted to Discord. */
export function unpostedQuestions(ctx: Pick<PipelineContext, 'store'>): Question[] {
  return (ctx.store.db.prepare('SELECT * FROM questions WHERE answer IS NULL AND discord_message_id IS NULL ORDER BY id').all() as Row[]).map(toQuestion);
}

export function markPosted(ctx: Pick<PipelineContext, 'store'>, id: number, channelId: string, messageId: string): void {
  ctx.store.db.prepare('UPDATE questions SET discord_channel_id = ?, discord_message_id = ? WHERE id = ?').run(channelId, messageId, id);
}

export type AnswerResult = { ok: true; effect: string } | { ok: false; reason: string };

/**
 * Record the owner's (or the timeout's) answer and act on it:
 * - product question: the blocked task resumes its session with the answer
 * - migration approval: approve exactly the held change, or park the task
 */
export function answerQuestion(ctx: PipelineContext, id: number, answer: string, by: 'owner' | 'timeout'): AnswerResult {
  const q = getQuestion(ctx, id);
  if (!q) return { ok: false, reason: `No question #${id}` };
  if (q.answer !== null) return { ok: false, reason: `Question #${id} was already answered: ${q.answer}` };
  const text = answer.trim();
  if (!text) return { ok: false, reason: 'Empty answer' };

  if (q.kind === 'migration') {
    const decision = text.toLowerCase();
    if (decision !== 'approve' && decision !== 'reject') return { ok: false, reason: 'Answer approve or reject' };
    ctx.store.db.prepare('UPDATE questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?').run(decision, by, ctx.now(), id);
    const task = q.taskId ? ctx.store.task(q.taskId) : null;
    if (!task || task.state !== 'blocked') return { ok: true, effect: 'recorded (the task is no longer waiting)' };
    if (decision === 'approve') {
      approveMigration(ctx, task.id);
      return { ok: true, effect: `${task.id} goes back to review and merges if the checks pass` };
    }
    rejectMigration(ctx, task.id);
    return { ok: true, effect: `${task.id} parked` };
  }

  ctx.store.db.prepare('UPDATE questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?').run(text, by, ctx.now(), id);
  const task = q.taskId ? ctx.store.task(q.taskId) : null;
  if (task && task.state === 'blocked') {
    // Still waiting on other questions? Stay blocked until all are answered.
    const pending = (ctx.store.db.prepare('SELECT COUNT(*) AS n FROM questions WHERE task_id = ? AND answer IS NULL').get(task.id) as Row).n;
    if (Number(pending) === 0) {
      ctx.store.transition(task.id, 'queued', { pendingMode: 'resume' });
      return { ok: true, effect: `${task.id} continues with your answer` };
    }
    return { ok: true, effect: `recorded; ${task.id} still waits on ${pending} more question(s)` };
  }
  return { ok: true, effect: 'recorded' };
}

/** Apply defaults to questions past their timeout. Migration approvals default to reject. */
export function applyTimeouts(ctx: PipelineContext): { id: number; answer: string; effect: string }[] {
  const out: { id: number; answer: string; effect: string }[] = [];
  for (const q of openQuestions(ctx)) {
    if (q.timeoutAt > ctx.now()) continue;
    const answer = q.kind === 'migration' ? 'reject' : q.defaultOption ?? q.options[0] ?? 'Use your best judgement and record the choice in docs/DECISIONS.md.';
    const r = answerQuestion(ctx, q.id, answer, 'timeout');
    if (r.ok) out.push({ id: q.id, answer, effect: r.effect });
  }
  return out;
}

/** Answers the task's agent hasn't seen yet, as prompt text. Marks them delivered. */
export function takeAnswersForTask(ctx: Pick<PipelineContext, 'store'>, taskId: string): string | null {
  const rows = ctx.store.db
    .prepare(`SELECT * FROM questions WHERE task_id = ? AND kind = 'product' AND answer IS NOT NULL AND delivered = 0 ORDER BY id`)
    .all(taskId) as Row[];
  if (rows.length === 0) return null;
  ctx.store.db.prepare(`UPDATE questions SET delivered = 1 WHERE task_id = ? AND kind = 'product' AND answer IS NOT NULL`).run(taskId);
  return rows
    .map(toQuestion)
    .map((q) => `Question: ${q.question}\nAnswer${q.answeredBy === 'timeout' ? ' (no reply in time, so the default applies)' : ' from the owner'}: ${q.answer}`)
    .join('\n\n');
}
