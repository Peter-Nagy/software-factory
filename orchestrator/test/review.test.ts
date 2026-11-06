import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFactoryConfig, parseProjectConfig, GovernorConfigSchema } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { formatReviewFailure, gateSteps, protectedChanges, reviewPasses } from '../src/gates/plan.ts';
import type { GitHub } from '../src/github.ts';
import { taskFromIssue } from '../src/issues.ts';
import { runBuild, type PipelineContext } from '../src/pipeline.ts';
import { approveMigration, runReviewStage } from '../src/review.ts';
import { scheduleReviews } from '../src/scheduler.ts';
import { Secrets } from '../src/secrets.ts';
import type { Project, Task } from '../src/types.ts';

const fixture = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const agentDocker = fixture('fake-docker.sh');
const reviewDocker = fixture('fake-docker-review.sh');
chmodSync(agentDocker, 0o755);
chmodSync(reviewDocker, 0o755);

// ---------- pure logic ----------

test('gate steps: defaults per stack, overrides, e2e and security switches', () => {
  const names = (yaml: string) => gateSteps(parseProjectConfig(yaml)).map((s) => s.name);
  assert.deepEqual(names('kind: web-app'), ['install', 'typecheck', 'lint', 'test', 'e2e', 'secrets', 'dependencies', 'sast']);
  assert.deepEqual(names('kind: cli\ngates: {e2e: false, securityScan: false, commands: {lint: ""}}'), ['install', 'typecheck', 'test']);
  const custom = gateSteps(parseProjectConfig('kind: service\ngates: {commands: {test: "make test"}}'));
  assert.equal(custom.find((s) => s.name === 'test')!.command, 'make test');
});

test('protected paths: gate definitions and scanner ignore files', () => {
  assert.deepEqual(
    protectedChanges(['src/a.ts', '.github/workflows/ci.yml', 'factory.yaml', '.gitleaksignore', 'docs/x.md', '.semgrepignore']),
    ['.github/workflows/ci.yml', 'factory.yaml', '.gitleaksignore', '.semgrepignore'],
  );
});

test('a review passes only if it is internally consistent', () => {
  const ok = { verdict: 'approve' as const, criteria: [{ criterion: 'a', met: true, evidence: 't' }], blocking: [], notes: [] };
  assert.equal(reviewPasses(ok), true);
  assert.equal(reviewPasses({ ...ok, criteria: [] }), false); // no criteria checked
  assert.equal(reviewPasses({ ...ok, criteria: [{ criterion: 'a', met: false, evidence: '' }] }), false);
  assert.equal(reviewPasses({ ...ok, blocking: [{ file: 'f', problem: 'p', fix: 'x' }] }), false);
  assert.match(formatReviewFailure({ ...ok, verdict: 'request_changes', blocking: [{ file: 'f', line: 2, problem: 'Bad.', fix: 'Do y.' }] }), /f:2: Bad\. Fix: Do y\./);
});

test('review scheduling: one stage per project, governed like any Claude run', () => {
  const cfg = GovernorConfigSchema.parse({});
  const NOW = 1_800_000_000;
  const mk = (id: string, projectId: string, p: Partial<Task> = {}): Task => ({
    ...taskFromIssue(projectId, 3, { number: Number(id), title: id, body: null, labels: [] }), state: 'in_review', createdAt: 0, updatedAt: Number(id), ...p,
  });
  const base = {
    now: NOW, runningTaskIds: new Set<string>(), activeProjects: new Set(['a', 'b']), pausedUntil: null, ownUseDetected: false,
    usage: { fiveHourPct: 10, fiveHourResetsAt: NOW + 3600, sevenDayPct: 5, sevenDayResetsAt: NOW + 6 * 86400, source: 'stream' as const, takenAt: NOW },
    reviewModel: () => 'sonnet' as const, reviewCostPct: 2, runningProjects: new Set<string>(),
  };
  const tasks = [mk('1', 'a'), mk('2', 'a'), mk('3', 'b'), mk('4', 'b', { notBefore: NOW + 60 })];
  assert.deepEqual(scheduleReviews(cfg, { ...base, tasks }).map((p) => p.task.id), ['a#1', 'b#3']);
  assert.deepEqual(scheduleReviews(cfg, { ...base, tasks, runningProjects: new Set(['a']) }).map((p) => p.task.id), ['b#3']);
  const full = { ...base.usage, fiveHourPct: 95 };
  assert.equal(scheduleReviews(cfg, { ...base, tasks, usage: full }).length, 0);
});

// ---------- review stage against a real git remote, fake docker and fake GitHub ----------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'factory-review-'));
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  g(root, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'factory.yaml'), 'kind: web-app\nsecrets: [APP_SECRET]\n');
  g(seed, 'add', '.');
  g(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  g(seed, 'push', '-q', origin, 'main');
  const config = parseFactoryConfig(`github: {owner: me}\npaths: {state: ${root}/state, repos: ${root}/repos, worktrees: ${root}/wt, logs: ${root}/logs, workerConfig: ${root}/cfg}`);
  const store = new Store(':memory:');
  const project: Project = { id: 'app', owner: 'me', kind: 'web-app', state: 'active', priority: 3, createdAt: 1 };
  store.upsertProject(project);
  const statuses: { sha: string; context: string; state: string }[] = [];
  const comments: string[] = [];
  const merges: { pr: number; sha: string }[] = [];
  const fakeGh = {
    findOpenPullRequest: async () => null,
    createPullRequest: async () => ({ number: 41, html_url: 'x' }),
    setStatus: async (_o: string, _r: string, sha: string, s: { state: string; context: string }) => void statuses.push({ sha, ...s }),
    comment: async (_o: string, _r: string, _n: number, body: string) => void comments.push(body),
    mergePullRequest: async (_o: string, _r: string, pr: number, sha: string) => (merges.push({ pr, sha }), { sha: 'm', merged: true }),
  } as unknown as GitHub;
  const ctx: PipelineContext = {
    config, store,
    secrets: new Secrets({ reader: async (ref) => `value-of-${ref}` }),
    repoAccess: async () => ({ gh: fakeGh, token: '' }),
    remoteUrl: () => origin,
    now: () => Math.floor(Date.now() / 1000),
    notify: async () => undefined,
  };
  const write = (name: string, text: string) => writeFileSync(join(root, name), text);
  const count = (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8').trim().split('\n').filter(Boolean).length : 0);
  return { root, g, origin, seed, ctx, store, project, statuses, comments, merges, write, count };
}

/** Build issue `n` with the fake agent in `agentMode`, ending with an open PR in review. */
async function built(s: ReturnType<typeof setup>, n: number, agentMode = 'success') {
  process.env.FACTORY_DOCKER_BIN = agentDocker;
  s.write('mode', agentMode);
  s.store.upsertTask(taskFromIssue('app', 3, { number: n, title: `Issue ${n}`, body: null, labels: [] }));
  await runBuild(s.ctx, s.project, s.store.task(`app#${n}`)!, 'sonnet');
  assert.equal(s.store.task(`app#${n}`)!.state, 'in_review');
  process.env.FACTORY_DOCKER_BIN = reviewDocker;
}

const review = (s: ReturnType<typeof setup>, n: number) => runReviewStage(s.ctx, s.project, s.store.task(`app#${n}`)!);

test('review stage: green gates and an approving review merge the PR at the checked sha', async () => {
  const s = setup();
  await built(s, 1);
  s.write('review-mode', 'review=approve');
  assert.equal(await review(s, 1), 'merged');
  assert.equal(s.store.task('app#1')!.state, 'done');
  const head = s.g(s.origin, 'rev-parse', 'claude/1-issue-1');
  assert.deepEqual(s.merges, [{ pr: 41, sha: head }]);
  const final = (ctx: string) => s.statuses.filter((x) => x.context === ctx).at(-1)!;
  assert.equal(final('factory/gates').state, 'success');
  assert.equal(final('factory/review').state, 'success');
  assert.equal(s.count('gatesrun'), 8);
  assert.match(s.comments.at(-1)!, /approved[\s\S]*Shows a list/);
});

test('review stage: a failing gate goes back to the implementer without spending a review', async () => {
  const s = setup();
  await built(s, 2);
  s.write('review-mode', 'fail=test');
  assert.equal(await review(s, 2), 'fix');
  const t = s.store.task('app#2')!;
  assert.equal(t.state, 'queued');
  assert.equal(t.pendingMode, 'fix');
  assert.match(t.lastFailure!, /checks failed: test[\s\S]*broke at line 3/);
  assert.equal(s.count('reviewsrun'), 0);
  assert.equal(s.merges.length, 0);
});

test('review stage: requested changes are posted and sent back as a fix', async () => {
  const s = setup();
  await built(s, 3);
  s.write('review-mode', 'review=changes');
  assert.equal(await review(s, 3), 'fix');
  const t = s.store.task('app#3')!;
  assert.equal(t.pendingMode, 'fix');
  assert.match(t.lastFailure!, /Null dereference[\s\S]*Guard it/);
  assert.match(s.comments.at(-1)!, /changes requested/);
});

test('review stage: an unusable verdict retries later, and gates are not run twice for the same head', async () => {
  const s = setup();
  await built(s, 4);
  s.write('review-mode', 'review=garbage');
  assert.equal(await review(s, 4), 'retry');
  assert.equal(s.store.task('app#4')!.state, 'in_review');
  assert.ok(s.store.task('app#4')!.notBefore! > s.ctx.now());
  s.write('review-mode', 'review=approve');
  assert.equal(await review(s, 4), 'merged');
  assert.equal(s.count('gatesrun'), 8); // cached by head sha
  assert.equal(s.count('reviewsrun'), 2);
});

test('review stage: destructive migrations wait for approval of exactly that change', async () => {
  const s = setup();
  await built(s, 5, 'migration');
  s.write('review-mode', 'review=approve');
  assert.equal(await review(s, 5), 'blocked');
  assert.equal(s.store.task('app#5')!.state, 'blocked');
  assert.equal(s.count('gatesrun'), 0);
  const q = s.store.db.prepare('SELECT question, default_option FROM questions').get() as { question: string; default_option: string };
  assert.match(q.question, /002\.sql:1 drop-column/);
  assert.equal(q.default_option, 'reject');
  approveMigration(s.ctx, 'app#5');
  assert.equal(await review(s, 5), 'merged');
});

test('review stage: changes to protected files are sent back, not merged', async () => {
  const s = setup();
  await built(s, 6, 'protected');
  s.write('review-mode', 'review=approve');
  assert.equal(await review(s, 6), 'fix');
  assert.match(s.store.task('app#6')!.lastFailure!, /protected files[\s\S]*factory\.yaml/);
  assert.equal(s.count('gatesrun'), 0);
});

test('review stage: a branch behind main is synced with a merge commit before the checks', async () => {
  const s = setup();
  await built(s, 7);
  // main moves on after the PR was opened
  s.g(s.seed, 'pull', '-q', s.origin, 'main');
  writeFileSync(join(s.seed, 'other.txt'), 'other\n');
  s.g(s.seed, 'add', '.');
  s.g(s.seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'other');
  s.g(s.seed, 'push', '-q', s.origin, 'main');
  s.write('review-mode', 'review=approve');
  assert.equal(await review(s, 7), 'merged');
  const head = s.g(s.origin, 'rev-parse', 'claude/7-issue-7');
  assert.equal(s.g(s.origin, 'log', '-1', '--format=%s', head), "Merge remote-tracking branch 'origin/main' into claude/7-issue-7");
  assert.equal(s.merges[0]!.sha, head);
});
