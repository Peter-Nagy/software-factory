import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeArgs } from './claude.ts';
import { parseProjectConfig, type FactoryConfig, type ProjectConfig } from './config.ts';
import type { Store } from './db.ts';
import { CHECKS_FILE, CONTRACT_HELP, RUN_DIR, runnerFor, type Runner } from './gates/contract.ts';
import { ORCHESTRATOR_PERMISSIONS, type GitHub, type RepoPermissions } from './github.ts';
import { takeAnswersForTask } from './questions.ts';
import { nextStep } from './retry.ts';
import { promptPath, roleConfig } from './roles.ts';
import { runInContainer } from './runner/container.ts';
import { projectImage } from './runner/image.ts';
import { createSimulator, deleteSimulator, runAgentOnMac, worktreesDir as macWorktreesDir } from './runner/macos.ts';
import { checkoutPath, git, gitRemote, hasUnpushedCommits, prepareCheckout, redact } from './runner/worktree.ts';
import type { Secrets } from './secrets.ts';
import { branchName } from './tasks.ts';
import type { Model, Project, RunResult, Task } from './types.ts';
import { snapshotAfterRun } from './usage.ts';

export interface PipelineContext {
  config: FactoryConfig;
  store: Store;
  secrets: Secrets;
  /** GitHub client + raw token scoped to one repo (minted per task). Default permissions: a worker's. */
  repoAccess(project: Project, permissions?: RepoPermissions): Promise<{ gh: GitHub; token: string }>;
  now(): number;
  /** Clone URL override (tests); defaults to https://github.com/<owner>/<repo>.git */
  remoteUrl?(project: Project): string;
  notify(kind: 'question' | 'alert' | 'info', text: string): Promise<void>;
}

/** Files the agent writes for the orchestrator. Excluded from git via .git/info/exclude and cleared before each run. */
export const FACTORY_DIR = RUN_DIR;

/** Until the macOS runner is switched on, tasks of macOS projects wait parked instead of running where they can't build. */
export const NEEDS_MACOS = 'This project runs on the macOS runner (Xcode), which is not switched on (macos.enabled in the factory config). Requeue it once it is.';

/**
 * Where a project's tasks run, from factory.yaml on main. It has to be known before the checkout, because the
 * checkout lives where that runner can reach it. Falls back to the project kind.
 */
export async function projectRunner(gh: GitHub, project: Project): Promise<Runner> {
  try {
    const text = await gh.readFile(project.owner, project.id, 'factory.yaml');
    if (text) return runnerFor(parseProjectConfig(text));
  } catch {
    // unreadable or invalid: the kind decides
  }
  return project.kind === 'ios' ? 'macos' : 'linux';
}

export function worktreeRoot(config: FactoryConfig, runner: Runner): string {
  return runner === 'macos' ? macWorktreesDir(config.macos) : config.paths.worktrees;
}
export interface AgentQuestion {
  question: string;
  options: string[];
  default: string;
  smallUiChoice?: boolean;
}

/** Usage-limit stops or runner errors in a row before a task is parked for a human to look at. */
export const MAX_INTERRUPTIONS = 5;
const RUNNER_BACKOFF_S = 5 * 60;

export function implementerPrompt(task: Task, failureSummary: string | null): string {
  const lines = [
    `Implement GitHub issue #${task.issueNumber}: "${task.title}".`,
    `Read it first with: gh issue view ${task.issueNumber} --comments`,
    `You are on branch ${task.branch}. Commit in small steps. Don't push: you have read-only GitHub access, and the factory pushes your commits when you finish.`,
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
    `commit (don't push; the factory does), and update ${FACTORY_DIR}/summary.md.`,
    '',
    failure.slice(0, 6000),
  ].join('\n');
}

export const RESUME_PROMPT = [
  'Your previous run was interrupted (usage limit or restart). Continue the same task where you left off.',
  'Check `git status` and `git log` first: uncommitted changes from before the interruption are gone, committed work is still there.',
  `Finish as instructed earlier, including ${FACTORY_DIR}/summary.md.`,
].join('\n');

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * The project's factory.yaml as it is on origin/main, never the task branch: the agent controls its branch,
 * and the config decides which secrets the container gets.
 */
export async function loadProjectConfig(dir: string, base = 'main'): Promise<ProjectConfig> {
  const text = await git(dir, 'show', `origin/${base}:factory.yaml`).catch(() => 'kind: web-app');
  return parseProjectConfig(text);
}

/**
 * Run the implementer for one task according to its pending mode (build / fix / resume), then route the outcome:
 * runner error -> backoff; usage limit -> checkpoint; question -> blocked; committed work -> pushed + PR + in_review;
 * any other failure -> retry ladder.
 */
export async function runBuild(ctx: PipelineContext, project: Project, task: Task, model: Model): Promise<void> {
  const { config, store } = ctx;
  const role = roleConfig(config, 'implementer');
  const mode = task.pendingMode;
  const branch = task.branch ?? branchName(task.issueNumber, task.title);
  const attempt = mode === 'build' ? task.attempt + 1 : Math.max(task.attempt, 1);
  const resumeSessionId = mode === 'build' ? null : task.sessionId;

  task = store.transition(task.id, mode === 'fix' ? 'fixing' : 'building', {
    branch,
    attempt,
    fixRounds: mode === 'build' ? 0 : mode === 'fix' ? task.fixRounds + 1 : task.fixRounds,
    sessionId: mode === 'build' ? null : task.sessionId,
    notBefore: null,
  });

  // Two tokens: the agent's is read-only (it can't push anywhere, whatever it runs); the orchestrator's pushes
  // exactly this task's branch from the host and opens the PR. GitHub branch protection needs a paid plan on
  // private repos, so read-only agent tokens are what keeps main safe.
  const { token: agentToken } = await ctx.repoAccess(project);
  const { gh, token } = await ctx.repoAccess(project, ORCHESTRATOR_PERMISSIONS);
  const clean = (text: string) => redact(redact(text, token), agentToken);
  const runner = await projectRunner(gh, project);
  if (runner === 'macos' && !config.macos.enabled) {
    store.transition(task.id, 'parked', { lastFailure: NEEDS_MACOS });
    await ctx.notify('alert', `Parked ${task.id}: ${NEEDS_MACOS}`);
    return;
  }
  const dir = checkoutPath(worktreeRoot(config, runner), project.id, `${task.issueNumber}`);
  const remoteUrl = ctx.remoteUrl?.(project) ?? `https://github.com/${project.owner}/${project.id}.git`;
  await prepareCheckout({ remoteUrl, dir, branch, token });
  const factoryDir = join(dir, FACTORY_DIR);
  rmSync(factoryDir, { recursive: true, force: true }); // never act on a previous run's question or summary
  mkdirSync(factoryDir, { recursive: true });

  const projectConfig = await loadProjectConfig(dir);
  mkdirSync(config.paths.logs, { recursive: true });
  // Agents run in the project's toolchain image, as the checkout defines it right now (the branch, in a fix).
  let image: Awaited<ReturnType<typeof projectImage>> = { image: config.worker.image, problem: null };
  if (runner === 'linux') {
    try {
      image = await projectImage({
        dir, projectId: project.id, baseImage: config.worker.image,
        timeoutMs: projectConfig.gates.imageBuildTimeoutMinutes * 60_000,
        logPath: join(config.paths.logs, `${project.id}-${task.issueNumber}-image-${Date.now()}.log`),
      });
    } catch (e) {
      store.event('task.image_error', task.id, { error: (e as Error).message });
    }
  }
  const imageNote = image.problem ? `\n\nThe project's toolchain image can't be used, so this run uses the plain worker image. Fix it:\n${image.problem}` : '';
  const contractNote = existsSync(join(dir, CHECKS_FILE)) ? '' : `\n\nThis repo has no ${CHECKS_FILE} yet, and the checks fail without it. Add it in this task.\n${CONTRACT_HELP}`;
  const env = {
    [config.worker.claudeTokenEnv]: await ctx.secrets.get(config.worker.claudeTokenEnv),
    GH_TOKEN: agentToken,
    ...(await ctx.secrets.getMany(projectConfig.secrets)),
  };

  const answers = takeAnswersForTask(ctx, task.id);
  const answerBlock = answers
    ? `\n\nYou asked for product decisions earlier. Here they are; follow them and record each in docs/DECISIONS.md:\n\n${answers}`
    : '';
  const prompt =
    mode === 'fix'
      ? fixPrompt(task.lastFailure ?? 'Unknown failure')
      : mode === 'resume' && resumeSessionId
        ? answers
          ? `Continue the task.${answerBlock}\n\nFinish as instructed earlier, including ${FACTORY_DIR}/summary.md.`
          : RESUME_PROMPT
        : implementerPrompt(task, task.lastFailure) + answerBlock;
  // A fix prompt already carries the gates' complaints; a fresh build gets told about a missing contract up front.
  const fullPrompt = prompt + imageNote + (mode === 'build' ? contractNote : '');
  const args = buildClaudeArgs({
    prompt: fullPrompt,
    model,
    effort: role.effort,
    maxTurns: role.maxTurns,
    maxBudgetUsd: role.maxBudgetUsd,
    resumeSessionId,
    appendSystemPromptFile: promptPath('implementer'),
  });

  const sessionsDir = join(config.paths.state, 'sessions', project.id, String(task.issueNumber));
  mkdirSync(sessionsDir, { recursive: true });
  const logPath = join(config.paths.logs, `${project.id}-${task.issueNumber}-${Date.now()}.jsonl`);
  const runId = store.startRun({ taskId: task.id, role: 'implementer', model, logPath, usageBefore: store.latestUsage() });

  // On the macOS runner the agent gets its own Simulator device for the run (sessions stay in the runner's home).
  const runOnMac = async (): Promise<RunResult> => {
    const sim = await createSimulator(config.macos, dir, `factory-${project.id}-${task.issueNumber}-${Date.now()}`, logPath);
    try {
      const macEnv = sim.udid ? { ...env, FACTORY_SIMULATOR: sim.udid } : env;
      return await runAgentOnMac(config.macos, dir, args, macEnv, { timeoutMs: role.timeoutMinutes * 60_000, logPath, onSession: (id) => store.setTaskSession(task.id, id) });
    } finally {
      if (sim.udid) await deleteSimulator(config.macos, dir, sim.udid, logPath);
    }
  };
  let result: RunResult;
  try {
    result = runner === 'macos' ? await runOnMac() : await runInContainer(
      {
        name: `factory-${project.id}-${task.issueNumber}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-'),
        image: image.image,
        worktree: dir,
        workerConfigDir: config.paths.workerConfig,
        sessionsDir,
        cpus: config.worker.cpus,
        memoryGb: config.worker.memoryGb,
        envNames: Object.keys(env),
        labels: { 'factory.task': task.id },
      },
      args,
      { env, timeoutMs: role.timeoutMinutes * 60_000, logPath, onSession: (id) => store.setTaskSession(task.id, id) },
    );
  } catch (e) {
    result = {
      ok: false, sessionId: null, resultText: `Runner error: ${(e as Error).message}`, totalCostUsd: null, numTurns: null,
      durationMs: null, permissionDenials: [], usage: null, hitUsageLimit: false, structuredOutput: null, timedOut: false, completed: false,
    };
  }

  store.finishRun(runId, result, clean(result.resultText));
  const snap = snapshotAfterRun(store.latestUsage(), result, ctx.now());
  if (snap) store.recordUsage(snap);
  const sessionId = result.sessionId ?? store.task(task.id)?.sessionId ?? null;
  const pushLocalWork = async () => {
    if (await hasUnpushedCommits(dir, branch)) await gitRemote(dir, token, 'push', '-u', 'origin', `${branch}:${branch}`);
  };

  // 1. Interrupted without a verdict: usage limit, or the runner itself failed (Docker down, image missing, crash).
  //    Neither is the task's fault, so the retry ladder is not consumed. Too many in a row parks the task.
  if (result.hitUsageLimit || (!result.completed && !result.timedOut)) {
    await pushLocalWork().catch(() => undefined);
    const interruptions = task.interruptions + 1;
    const why = result.hitUsageLimit ? 'usage limit' : clean(result.resultText || 'runner ended without a result');
    if (interruptions >= MAX_INTERRUPTIONS) {
      store.transition(task.id, 'parked', { sessionId, interruptions, lastFailure: `Interrupted ${interruptions} times in a row; last: ${why}` });
      await ctx.notify('alert', `Parked ${task.id}: interrupted ${interruptions} times in a row (${why}).`);
      return;
    }
    store.transition(task.id, 'queued', {
      sessionId,
      interruptions,
      // A fix interrupted before it finished is resumed as a fix; anything else continues its attempt.
      pendingMode: mode === 'fix' && sessionId === null ? 'fix' : 'resume',
      fixRounds: mode === 'fix' ? Math.max(task.fixRounds - 1, 0) : task.fixRounds,
      notBefore: result.hitUsageLimit ? null : ctx.now() + RUNNER_BACKOFF_S * interruptions,
    });
    store.event(result.hitUsageLimit ? 'task.checkpoint' : 'task.runner_error', task.id, { why });
    return;
  }

  // 2. The agent needs a product decision.
  const question = readJson<AgentQuestion>(join(factoryDir, 'question.json'));
  if (question) {
    const hours = question.smallUiChoice ? config.questions.smallUiTimeoutHours : config.questions.defaultTimeoutHours;
    store.db
      .prepare(`INSERT INTO questions (kind, task_id, project_id, question, options, default_option, asked_at, timeout_at) VALUES ('product', ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.id, project.id, question.question, JSON.stringify(question.options), question.default, ctx.now(), ctx.now() + hours * 3600);
    await pushLocalWork().catch(() => undefined);
    store.transition(task.id, 'blocked', { sessionId, interruptions: 0, pendingMode: 'resume' });
    await ctx.notify('question', `${task.id}: ${question.question}`);
    return;
  }

  // 3. Work committed: push the task branch (never anything else, never forced), open or reuse the PR, hand over to the gates.
  let pushed = false;
  if (result.ok) {
    try {
      await pushLocalWork();
      const remoteHead = await gitRemote(dir, token, 'ls-remote', 'origin', `refs/heads/${branch}`);
      pushed = remoteHead !== '' && Number(await git(dir, 'rev-list', '--count', `origin/main..${branch}`)) > 0;
    } catch (e) {
      // e.g. the agent rewrote already-pushed history: the non-forced push is refused
      await handleFailure(ctx, task.id, sessionId, `Pushing your branch failed: ${clean((e as Error).message)}\nDon't rewrite commits that were already pushed (no rebase, amend or reset of earlier work); add new commits instead.`);
      return;
    }
  }
  if (result.ok && pushed) {
    const summaryPath = join(factoryDir, 'summary.md');
    const summary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : result.resultText;
    const body = `${clean(summary)}\n\nCloses #${task.issueNumber}\n\n_Built by the software factory (${model}, attempt ${attempt})._`;
    const existing = await gh.findOpenPullRequest(project.owner, project.id, branch);
    const pr = existing ?? (await gh.createPullRequest(project.owner, project.id, { title: task.title, head: branch, base: 'main', body }));
    store.transition(task.id, 'in_review', { sessionId, prNumber: pr.number, lastFailure: null, interruptions: 0 });
    return;
  }

  // 4. A real failure: follow the retry ladder.
  const why = result.timedOut ? 'Run timed out.' : clean(result.resultText || 'Run ended without committing any work.');
  await handleFailure(ctx, task.id, sessionId, why);
}

/** Apply the retry ladder after a failed build, gate or review. */
export async function handleFailure(ctx: PipelineContext, taskId: string, sessionId: string | null, why: string): Promise<void> {
  const current = ctx.store.task(taskId)!;
  const step = nextStep({ risk: current.risk, attempt: Math.max(current.attempt, 1), fixRounds: current.fixRounds, sessionId, splitOnFail: current.splitOnFail });
  switch (step.action) {
    case 'fix':
      ctx.store.transition(taskId, 'queued', { sessionId, lastFailure: why, pendingMode: 'fix', interruptions: 0 });
      ctx.store.event('task.fix_scheduled', taskId, {});
      return;
    case 'restart':
      ctx.store.transition(taskId, 'queued', { sessionId: null, fixRounds: 0, lastFailure: why, pendingMode: 'build', interruptions: 0 });
      ctx.store.event('task.restart', taskId, { model: step.model, attempt: step.attempt });
      return;
    case 'split':
    case 'park':
      ctx.store.transition(taskId, 'parked', { sessionId, lastFailure: why, interruptions: 0 });
      await ctx.notify('alert', `Parked ${taskId} (${step.action === 'split' ? 'needs splitting' : 'retries exhausted'}): ${why.slice(0, 300)}`);
      return;
  }
}
