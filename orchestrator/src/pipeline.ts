import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeArgs } from './claude.ts';
import { parseProjectConfig, type FactoryConfig, type ProjectConfig } from './config.ts';
import type { Store } from './db.ts';
import type { GitHub } from './github.ts';
import { nextStep } from './retry.ts';
import { promptPath, roleConfig } from './roles.ts';
import { runInContainer } from './runner/container.ts';
import { authConfig, checkoutPath, git, hasUnpushedCommits, prepareCheckout } from './runner/worktree.ts';
import type { Secrets } from './secrets.ts';
import { branchName } from './tasks.ts';
import type { Model, Project, RunResult, Task } from './types.ts';
import { snapshotAfterRun } from './usage.ts';

export interface PipelineContext {
  config: FactoryConfig;
  store: Store;
  secrets: Secrets;
  /** GitHub client + raw token scoped to one repo (minted per task by the orchestrator). */
  repoAccess(project: Project): Promise<{ gh: GitHub; token: string }>;
  now(): number;
  /** Clone URL override (tests); defaults to https://github.com/<owner>/<repo>.git */
  remoteUrl?(project: Project): string;
  notify(kind: 'question' | 'alert' | 'info', text: string): Promise<void>;
}

/** Files the agent writes for the orchestrator. Excluded from git via .git/info/exclude. */
export const FACTORY_DIR = '.factory';
export interface AgentQuestion {
  question: string;
  options: string[];
  default: string;
  smallUiChoice?: boolean;
}

export function implementerPrompt(task: Task, failureSummary: string | null): string {
  const lines = [
    `Implement GitHub issue #${task.issueNumber}: "${task.title}".`,
    `Read it first with: gh issue view ${task.issueNumber} --comments`,
    `You are on branch ${task.branch}. Commit in small steps and push with: git push -u origin HEAD`,
    `Finish by writing ${FACTORY_DIR}/summary.md (PR description: what changed, how it was tested, acceptance criteria checklist).`,
  ];
  if (failureSummary) {
    lines.push('', 'A previous attempt at this task failed. What went wrong:', failureSummary.slice(0, 4000), 'Take a different approach where the previous one got stuck.');
  }
  return lines.join('\n');
}

export function fixPrompt(failure: string): string {
  return [
    'The checks or the review on your pull request failed. Fix every blocking item below, run the tests again,',
    `commit, push, and update ${FACTORY_DIR}/summary.md.`,
    '',
    failure.slice(0, 6000),
  ].join('\n');
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function loadProjectConfig(dir: string): ProjectConfig {
  const p = join(dir, 'factory.yaml');
  return parseProjectConfig(existsSync(p) ? readFileSync(p, 'utf8') : 'kind: web-app');
}

/**
 * Run the implementer (or fixer) for one task, then route the outcome:
 * usage limit -> checkpoint and requeue; question -> blocked; pushed work -> PR + in_review; failure -> retry ladder.
 */
export async function runBuild(ctx: PipelineContext, project: Project, task: Task, model: Model, mode: 'build' | 'fix', failure: string | null): Promise<void> {
  const { config, store } = ctx;
  const role = roleConfig(config, 'implementer');
  const branch = task.branch ?? branchName(task.issueNumber, task.title);
  const attempt = mode === 'build' && task.sessionId === null ? task.attempt + 1 : task.attempt;
  const resumeSessionId = mode === 'fix' || (task.sessionId && task.attempt > 0) ? task.sessionId : null;

  task = store.transition(task.id, mode === 'fix' ? 'fixing' : 'building', { branch, attempt, fixRounds: mode === 'fix' ? task.fixRounds + 1 : task.fixRounds });

  const { gh, token } = await ctx.repoAccess(project);
  const dir = checkoutPath(config.paths.worktrees, project.id, `${task.issueNumber}`);
  const remoteUrl = ctx.remoteUrl?.(project) ?? `https://github.com/${project.owner}/${project.id}.git`;
  await prepareCheckout({ remoteUrl, dir, branch, token });
  mkdirSync(join(dir, FACTORY_DIR), { recursive: true });
  appendFileSync(join(dir, '.git', 'info', 'exclude'), `\n${FACTORY_DIR}/\n`);

  const projectConfig = loadProjectConfig(dir);
  const env = {
    [config.worker.claudeTokenEnv]: await ctx.secrets.get(config.worker.claudeTokenEnv),
    GH_TOKEN: token,
    ...(await ctx.secrets.getMany(projectConfig.secrets)),
  };

  const prompt = mode === 'fix' ? fixPrompt(failure ?? task.lastFailure ?? 'Unknown failure') : implementerPrompt({ ...task, branch }, failure);
  const args = buildClaudeArgs({
    prompt,
    model,
    effort: role.effort,
    maxTurns: role.maxTurns,
    maxBudgetUsd: role.maxBudgetUsd,
    resumeSessionId,
    appendSystemPromptFile: promptPath('implementer'),
  });

  mkdirSync(config.paths.logs, { recursive: true });
  const sessionsDir = join(config.paths.state, 'sessions', project.id, String(task.issueNumber));
  mkdirSync(sessionsDir, { recursive: true });
  const logPath = join(config.paths.logs, `${project.id}-${task.issueNumber}-${Date.now()}.jsonl`);
  const runId = store.startRun({ taskId: task.id, role: 'implementer', model, logPath, usageBefore: store.latestUsage() });

  let result: RunResult;
  try {
    result = await runInContainer(
      {
        name: `factory-${project.id}-${task.issueNumber}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-'),
        image: config.worker.image,
        worktree: dir,
        workerConfigDir: config.paths.workerConfig,
        sessionsDir,
        cpus: config.worker.cpus,
        memoryGb: config.worker.memoryGb,
        envNames: Object.keys(env),
        labels: { 'factory.task': task.id },
      },
      args,
      { env, timeoutMs: role.timeoutMinutes * 60_000, logPath },
    );
  } catch (e) {
    result = { ok: false, sessionId: task.sessionId, resultText: `Runner error: ${(e as Error).message}`, totalCostUsd: null, numTurns: null, durationMs: null, permissionDenials: [], usage: null, hitUsageLimit: false, structuredOutput: null, timedOut: false };
  }

  store.finishRun(runId, result, result.resultText);
  const snap = snapshotAfterRun(store.latestUsage(), result, ctx.now());
  if (snap) store.recordUsage(snap);
  const sessionId = result.sessionId ?? task.sessionId;

  // 1. Usage limit: checkpoint. The agent commits as it goes; push whatever is local so nothing is lost.
  if (result.hitUsageLimit) {
    if (await hasUnpushedCommits(dir, branch)) await git(dir, ...authConfig(token), 'push', '-u', 'origin', 'HEAD');
    store.transition(task.id, 'queued', { sessionId });
    store.event('task.checkpoint', task.id, { reason: 'usage limit' });
    return;
  }

  // 2. The agent needs a product decision.
  const question = readJson<AgentQuestion>(join(dir, FACTORY_DIR, 'question.json'));
  if (question) {
    const hours = question.smallUiChoice ? config.questions.smallUiTimeoutHours : config.questions.defaultTimeoutHours;
    store.db
      .prepare('INSERT INTO questions (task_id, project_id, question, options, default_option, asked_at, timeout_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(task.id, project.id, question.question, JSON.stringify(question.options), question.default, ctx.now(), ctx.now() + hours * 3600);
    store.transition(task.id, 'blocked', { sessionId });
    await ctx.notify('question', `${task.id}: ${question.question}`);
    return;
  }

  // 3. Work pushed: open (or reuse) the PR and hand over to the gates.
  // The host checks the remote with the repo token (the repo is private).
  const remoteHead = await git(dir, ...authConfig(token), 'ls-remote', 'origin', `refs/heads/${branch}`).catch(() => '');
  if (result.ok && remoteHead) {
    const summaryPath = join(dir, FACTORY_DIR, 'summary.md');
    const body = `${existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : result.resultText}\n\nCloses #${task.issueNumber}\n\n_Built by the software factory (${model}, attempt ${attempt})._`;
    const existing = await gh.findOpenPullRequest(project.owner, project.id, branch);
    const pr = existing ?? (await gh.createPullRequest(project.owner, project.id, { title: task.title, head: branch, base: 'main', body }));
    store.transition(task.id, 'in_review', { sessionId, prNumber: pr.number, lastFailure: null });
    return;
  }

  // 4. Failure: follow the retry ladder.
  const why = result.timedOut ? 'Run timed out.' : result.resultText || 'Run ended without pushing any work.';
  await handleFailure(ctx, task, sessionId, why);
}

/** Apply the retry ladder after any failed build, gate or review. */
export async function handleFailure(ctx: PipelineContext, task: Task, sessionId: string | null, why: string): Promise<void> {
  const current = ctx.store.task(task.id)!;
  const step = nextStep({ risk: current.risk, attempt: Math.max(current.attempt, 1), fixRounds: current.fixRounds, sessionId, splitOnFail: current.splitOnFail });
  switch (step.action) {
    case 'fix':
      // Stay resumable: the next tick picks it up as a fix run on the same session.
      ctx.store.transition(task.id, 'queued', { sessionId, lastFailure: why });
      ctx.store.event('task.fix_scheduled', task.id, {});
      return;
    case 'restart':
      ctx.store.transition(task.id, 'queued', { sessionId: null, fixRounds: 0, lastFailure: why });
      ctx.store.event('task.restart', task.id, { model: step.model, attempt: step.attempt });
      return;
    case 'split':
    case 'park':
      ctx.store.transition(task.id, 'parked', { sessionId, lastFailure: why });
      await ctx.notify('alert', `Parked ${task.id} (${step.action === 'split' ? 'needs splitting' : 'retries exhausted'}): ${why.slice(0, 300)}`);
      return;
  }
}
