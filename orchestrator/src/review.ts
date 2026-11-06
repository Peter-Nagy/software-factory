import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeArgs } from './claude.ts';
import { checkMigrations } from './gates/migration-check.ts';
import {
  formatGateFailure,
  formatReviewFailure,
  gateSteps,
  protectedChanges,
  REVIEW_JSON_SCHEMA,
  ReviewSchema,
  reviewPasses,
  type StepOutcome,
} from './gates/plan.ts';
import { ORCHESTRATOR_PERMISSIONS, STATUS_CONTEXTS } from './github.ts';
import { handleFailure, loadProjectConfig, MAX_INTERRUPTIONS, type PipelineContext } from './pipeline.ts';
import { promptPath, reviewerModel, roleConfig } from './roles.ts';
import { runCommandInContainer, runInContainer } from './runner/container.ts';
import { changedFiles, changePatchId, checkoutPath, containsBase, diffSize, git, gitRemote, headSha, prepareCheckout, redact } from './runner/worktree.ts';
import { branchName } from './tasks.ts';
import type { Model, Project, RunResult, Task } from './types.ts';
import { snapshotAfterRun } from './usage.ts';

/** Read-only token for the reviewer container: it may look at the issue and PR, nothing else. */
const REVIEWER_PERMISSIONS = { contents: 'read', pull_requests: 'read', issues: 'read', metadata: 'read' } as const;

const key = {
  gates: (id: string) => `gates:${id}`, // head sha whose checks passed
  review: (id: string) => `review:${id}`, // patch id the reviewer approved
  approved: (id: string) => `approvedMigration:${id}`, // patch id the owner approved
};

export type ReviewOutcome = 'merged' | 'fix' | 'blocked' | 'retry' | 'parked';

/** Estimated 5-hour share of one review run, for the governor. */
export const REVIEW_COST_PCT = 2;

/**
 * The in_review stage, all of it deterministic except the reviewer:
 *  1. bring the branch up to date with main (conflicts go back to the implementer)
 *  2. refuse changes to protected files; hold destructive migrations for the owner's approval
 *  3. gates: each step in its own container, exit code is the verdict, result posted as a commit status
 *  4. independent review with a JSON verdict, posted as a commit status
 *  5. squash-merge, only if neither the PR head nor main moved since the checks ran
 * Results are cached per head sha (gates) and per change patch id (review), so a re-run after an interruption
 * doesn't redo work or spend tokens twice.
 */
export async function runReviewStage(ctx: PipelineContext, project: Project, task: Task): Promise<ReviewOutcome> {
  const { config, store } = ctx;
  const { gh, token } = await ctx.repoAccess(project, ORCHESTRATOR_PERMISSIONS);
  const clean = (t: string) => redact(t, token);
  const branch = task.branch ?? branchName(task.issueNumber, task.title);
  const dir = checkoutPath(config.paths.worktrees, project.id, `${task.issueNumber}`);
  const remoteUrl = ctx.remoteUrl?.(project) ?? `https://github.com/${project.owner}/${project.id}.git`;
  await prepareCheckout({ remoteUrl, dir, branch, token });
  const prNumber = task.prNumber;
  if (prNumber === null) throw new Error(`${task.id} is in review without a PR`);

  // 1. Sync with main.
  if (!(await containsBase(dir))) {
    try {
      await git(dir, '-c', 'user.name=factory-bot', '-c', 'user.email=factory-bot@users.noreply.github.com', 'merge', '--no-edit', 'origin/main');
    } catch {
      const conflicts = await git(dir, 'diff', '--name-only', '--diff-filter=U').catch(() => '');
      await git(dir, 'merge', '--abort').catch(() => undefined);
      await handleFailure(ctx, task.id, task.sessionId, `Your branch conflicts with main in: ${conflicts.split('\n').join(', ') || 'unknown files'}.\nRun \`git fetch origin && git merge origin/main\`, resolve the conflicts keeping both sides' intent, run the checks, commit and push.`);
      return 'fix';
    }
    await gitRemote(dir, token, 'push', 'origin', `HEAD:${branch}`);
  }
  const head = await headSha(dir);
  const baseSha = await git(dir, 'rev-parse', 'origin/main');
  const patchId = await changePatchId(dir);
  const files = await changedFiles(dir);
  const projectConfig = await loadProjectConfig(dir);

  // 2a. Protected files: the gates' own definitions. Agents must not change them.
  const touched = protectedChanges(files);
  if (touched.length) {
    await gh.setStatus(project.owner, project.id, head, { state: 'failure', context: STATUS_CONTEXTS.gates, description: 'Changes protected files' });
    await handleFailure(ctx, task.id, task.sessionId, `This PR changes protected files that only the owner may change: ${touched.join(', ')}.\nRevert those changes (\`git checkout origin/main -- <file>\`), commit and push.`);
    return 'fix';
  }

  // 2b. Destructive migrations wait for the owner.
  if (projectConfig.gates.destructiveMigrationCheck && store.getSetting(key.approved(task.id)) !== patchId) {
    const contents = await Promise.all(files.map(async (path) => ({ path, content: await git(dir, 'show', `HEAD:${path}`).catch(() => '') })));
    const findings = checkMigrations(contents, projectConfig.gates.migrationGlobs);
    if (findings.length) {
      const list = findings.map((f) => `- ${f.file}:${f.line} ${f.rule}: ${f.text}`).join('\n');
      store.db
        .prepare('INSERT INTO questions (task_id, project_id, question, options, default_option, asked_at, timeout_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        // Never auto-approved: the default on timeout is to reject.
        .run(task.id, project.id, `PR #${prNumber} contains destructive database changes:\n${list}\nApprove the merge?`, JSON.stringify(['approve', 'reject']), 'reject', ctx.now(), ctx.now() + 7 * 86400);
      store.setSetting(`pendingApproval:${task.id}`, patchId);
      store.transition(task.id, 'blocked');
      await gh.comment(project.owner, project.id, prNumber, `Waiting for the owner's approval: this PR contains destructive database changes.\n\n${list}`);
      await ctx.notify('question', `${task.id} (PR #${prNumber}) has destructive migrations and needs your approval:\n${list}`);
      return 'blocked';
    }
  }

  // 3. Gates.
  if (store.getSetting(key.gates(task.id)) !== head) {
    await gh.setStatus(project.owner, project.id, head, { state: 'pending', context: STATUS_CONTEXTS.gates, description: 'Running checks' });
    const env = await ctx.secrets.getMany(projectConfig.secrets);
    mkdirSync(config.paths.logs, { recursive: true });
    const logPath = join(config.paths.logs, `${project.id}-${task.issueNumber}-gates-${Date.now()}.log`);
    const outcomes: StepOutcome[] = [];
    for (const step of gateSteps(projectConfig)) {
      let r;
      try {
        r = await runCommandInContainer(
          {
            name: `factory-gate-${project.id}-${task.issueNumber}-${step.name}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-'),
            image: config.worker.image,
            worktree: dir,
            workerConfigDir: config.paths.workerConfig,
            cpus: config.worker.cpus,
            memoryGb: config.worker.memoryGb,
            envNames: Object.keys(env),
            labels: { 'factory.task': task.id, 'factory.gate': step.name },
          },
          ['bash', '-lc', step.command],
          { env, timeoutMs: projectConfig.gates.timeoutMinutes * 60_000, logPath },
        );
      } catch (e) {
        // Docker itself failed: not the PR's fault. Try again later without touching the retry ladder.
        return interruption(ctx, task, `gate runner error: ${(e as Error).message}`);
      }
      outcomes.push({ name: step.name, ok: r.exitCode === 0 && !r.timedOut, timedOut: r.timedOut, tail: clean(r.tail) });
      if (step.name === 'install' && r.exitCode !== 0) break; // nothing else can run without dependencies
    }
    const failed = outcomes.filter((o) => !o.ok);
    store.event('task.gates', task.id, { head, results: outcomes.map((o) => ({ name: o.name, ok: o.ok })) });
    if (failed.length) {
      await gh.setStatus(project.owner, project.id, head, { state: 'failure', context: STATUS_CONTEXTS.gates, description: `Failed: ${failed.map((f) => f.name).join(', ')}` });
      await handleFailure(ctx, task.id, task.sessionId, formatGateFailure(outcomes));
      return 'fix';
    }
    await gh.setStatus(project.owner, project.id, head, { state: 'success', context: STATUS_CONTEXTS.gates, description: `Passed: ${outcomes.map((o) => o.name).join(', ')}` });
    store.setSetting(key.gates(task.id), head);
  }

  // 4. Independent review (the only step that spends tokens).
  if (store.getSetting(key.review(task.id)) !== patchId) {
    const verdict = await runReviewer(ctx, project, task, dir, prNumber);
    if (verdict.kind === 'interrupted') return interruption(ctx, task, verdict.why);
    if (verdict.kind === 'changes') {
      await gh.setStatus(project.owner, project.id, head, { state: 'failure', context: STATUS_CONTEXTS.review, description: 'Changes requested' });
      await gh.comment(project.owner, project.id, prNumber, `**Review: changes requested**\n\n${verdict.text}`);
      await handleFailure(ctx, task.id, task.sessionId, verdict.text);
      return 'fix';
    }
    store.setSetting(key.review(task.id), patchId);
    await gh.comment(project.owner, project.id, prNumber, `**Review: approved** (${verdict.model})\n\n${verdict.text}`);
  }
  await gh.setStatus(project.owner, project.id, head, { state: 'success', context: STATUS_CONTEXTS.review, description: 'Approved' });

  // 5. Merge, only if nothing moved since the checks.
  store.transition(task.id, 'merging');
  await gitRemote(dir, token, 'fetch', 'origin');
  const nowBase = await git(dir, 'rev-parse', 'origin/main');
  const nowHead = await git(dir, 'rev-parse', `origin/${branch}`);
  if (nowBase !== baseSha || nowHead !== head) {
    store.transition(task.id, 'in_review');
    store.event('task.merge_deferred', task.id, { reason: nowBase !== baseSha ? 'main moved' : 'branch moved' });
    return 'retry';
  }
  try {
    await gh.mergePullRequest(project.owner, project.id, prNumber, head, task.title);
  } catch (e) {
    store.transition(task.id, 'in_review');
    store.event('task.merge_failed', task.id, { error: clean((e as Error).message) });
    return 'retry';
  }
  store.transition(task.id, 'done', { interruptions: 0 });
  await ctx.notify('info', `Merged ${task.id}: PR #${prNumber} "${task.title}"`);
  return 'merged';
}

/** A review stage that couldn't finish for reasons outside the PR. Parks after too many in a row. */
async function interruption(ctx: PipelineContext, task: Task, why: string): Promise<ReviewOutcome> {
  const current = ctx.store.task(task.id)!;
  const interruptions = current.interruptions + 1;
  if (interruptions >= MAX_INTERRUPTIONS) {
    ctx.store.transition(task.id, 'parked', { interruptions, lastFailure: `Review stage interrupted ${interruptions} times; last: ${why}` });
    await ctx.notify('alert', `Parked ${task.id}: review stage interrupted ${interruptions} times (${why}).`);
    return 'parked';
  }
  ctx.store.db.prepare('UPDATE tasks SET interruptions = ?, not_before = ? WHERE id = ?').run(interruptions, ctx.now() + 300 * interruptions, task.id);
  ctx.store.event('task.review_interrupted', task.id, { why });
  return 'retry';
}

type ReviewerVerdict =
  | { kind: 'approved'; text: string; model: Model }
  | { kind: 'changes'; text: string }
  | { kind: 'interrupted'; why: string };

async function runReviewer(ctx: PipelineContext, project: Project, task: Task, dir: string, prNumber: number): Promise<ReviewerVerdict> {
  const { config, store } = ctx;
  const role = roleConfig(config, 'reviewer');
  const model = reviewerModel(task.risk, await diffSize(dir));
  const { token: readToken } = await ctx.repoAccess(project, REVIEWER_PERMISSIONS);
  const env = { [config.worker.claudeTokenEnv]: await ctx.secrets.get(config.worker.claudeTokenEnv), GH_TOKEN: readToken };
  const prompt = [
    `Review pull request #${prNumber} for issue #${task.issueNumber} ("${task.title}").`,
    `Issue: gh issue view ${task.issueNumber} --comments. PR description: gh pr view ${prNumber}. Diff: git diff origin/main...HEAD.`,
    'The checks (install, typecheck, lint, tests, E2E, security scans) already passed. Judge correctness, security, data safety, test quality, scope and the acceptance criteria.',
  ].join('\n');
  const args = buildClaudeArgs({
    prompt,
    model,
    effort: role.effort,
    maxTurns: role.maxTurns,
    maxBudgetUsd: role.maxBudgetUsd,
    appendSystemPromptFile: promptPath('reviewer'),
    jsonSchema: REVIEW_JSON_SCHEMA,
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  });
  mkdirSync(config.paths.logs, { recursive: true });
  const logPath = join(config.paths.logs, `${project.id}-${task.issueNumber}-review-${Date.now()}.jsonl`);
  const runId = store.startRun({ taskId: task.id, role: 'reviewer', model, logPath, usageBefore: store.latestUsage() });
  let result: RunResult;
  try {
    result = await runInContainer(
      {
        name: `factory-review-${project.id}-${task.issueNumber}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-'),
        image: config.worker.image,
        worktree: dir,
        readOnlyWork: true,
        workerConfigDir: config.paths.workerConfig,
        cpus: config.worker.cpus,
        memoryGb: config.worker.memoryGb,
        envNames: Object.keys(env),
        labels: { 'factory.task': task.id, 'factory.role': 'reviewer' },
      },
      args,
      { env, timeoutMs: role.timeoutMinutes * 60_000, logPath },
    );
  } catch (e) {
    return { kind: 'interrupted', why: `reviewer runner error: ${(e as Error).message}` };
  }
  store.finishRun(runId, result, redact(result.resultText, readToken));
  const snap = snapshotAfterRun(store.latestUsage(), result, ctx.now());
  if (snap) store.recordUsage(snap);
  if (result.hitUsageLimit || !result.completed) return { kind: 'interrupted', why: result.hitUsageLimit ? 'usage limit' : 'reviewer ended without a result' };

  const parsed = ReviewSchema.safeParse(result.structuredOutput);
  if (!parsed.success) return { kind: 'interrupted', why: 'reviewer returned no valid verdict' };
  const review = parsed.data;
  const criteria = review.criteria.map((c) => `- [${c.met ? 'x' : ' '}] ${c.criterion} (${c.evidence})`).join('\n');
  const notes = review.notes.length ? `\n\nNotes:\n${review.notes.map((n) => `- ${n}`).join('\n')}` : '';
  if (reviewPasses(review)) return { kind: 'approved', model, text: `${criteria}${notes}` };
  return { kind: 'changes', text: formatReviewFailure(review) };
}

export function reviewModelGuess(task: Task): Model {
  return reviewerModel(task.risk, 0);
}

/** Owner approved a held destructive migration: record it for exactly that change, and check again. */
export function approveMigration(ctx: PipelineContext, taskId: string): void {
  const patch = ctx.store.getSetting(`pendingApproval:${taskId}`);
  if (!patch) throw new Error(`${taskId} has no pending approval`);
  ctx.store.setSetting(key.approved(taskId), patch);
  ctx.store.setSetting(`pendingApproval:${taskId}`, null);
  ctx.store.db.prepare(`UPDATE questions SET answer = 'approve', answered_by = 'owner', answered_at = ? WHERE task_id = ? AND answer IS NULL`).run(ctx.now(), taskId);
  ctx.store.transition(taskId, 'in_review');
}

export function rejectMigration(ctx: PipelineContext, taskId: string): void {
  ctx.store.setSetting(`pendingApproval:${taskId}`, null);
  ctx.store.db.prepare(`UPDATE questions SET answer = 'reject', answered_by = 'owner', answered_at = ? WHERE task_id = ? AND answer IS NULL`).run(ctx.now(), taskId);
  ctx.store.transition(taskId, 'parked', { lastFailure: 'Owner rejected the destructive migration.' });
}

