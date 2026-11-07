import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFactoryConfig, parseProjectConfig, GovernorConfigSchema } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { formatReviewFailure, gateSteps, protectedChanges, reviewPasses } from '../src/gates/plan.ts';
import { ContractError, countJunit, dockerfileProblem, e2eRequired, parseChecks, reportProblem, runnerFor, testCountProblem, testsRemovedReason } from '../src/gates/contract.ts';
import { excludeRunDir } from '../src/runner/worktree.ts';
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

const CHECKS = 'setup: make deps\nbuild: make build\nlint: make lint\ntest: make test\ne2e: make e2e\n';

test('check contract: required checks, fail closed, any stack', () => {
  const names = (yaml: string, checks = CHECKS) => gateSteps(parseProjectConfig(yaml), parseChecks(checks)).map((s) => s.name);
  assert.deepEqual(names('kind: web-app'), ['setup', 'build', 'lint', 'test', 'e2e', 'secrets', 'dependencies', 'sast']);
  assert.deepEqual(names('kind: cli\ngates: {securityScan: false}', 'build: go build ./...\nlint: golangci-lint run\ntest: gotestsum --junitfile $FACTORY_REPORT_DIR/r.xml\n'), ['build', 'lint', 'test']);
  const steps = gateSteps(parseProjectConfig('kind: cli'), parseChecks(CHECKS));
  assert.equal(steps.find((s) => s.name === 'test')!.reports, true);
  assert.equal(steps.find((s) => s.name === 'lint')!.reports, false);
  // missing, empty, unknown or incomplete definitions fail instead of passing vacuously
  assert.throws(() => parseChecks(null), ContractError);
  assert.throws(() => parseChecks('build: x\nlint: x\n'), /test: is missing/);
  assert.throws(() => parseChecks('build: x\nlint: "  "\ntest: x\n'), /lint: is empty/);
  assert.throws(() => parseChecks('build: x\nlint: x\ntest: x\ntypecheck: x\n'), /typecheck/);
  assert.throws(() => parseChecks('build: [x'), /not valid YAML/);
  // user-facing kinds need e2e unless the owner turns it off
  assert.throws(() => gateSteps(parseProjectConfig('kind: web-app'), parseChecks('build: x\nlint: x\ntest: x\n')), /no e2e check/);
  assert.equal(e2eRequired(parseProjectConfig('kind: web-app\ngates: {e2e: false}')), false);
  assert.equal(e2eRequired(parseProjectConfig('kind: service')), false);
  assert.equal(runnerFor(parseProjectConfig('kind: ios')), 'macos');
  assert.equal(runnerFor(parseProjectConfig('kind: cli\nrunner: macos')), 'macos');
  assert.equal(runnerFor(parseProjectConfig('kind: web-app')), 'linux');
});

test('check contract: JUnit evidence, test count, Dockerfile base', () => {
  const xml = '<testsuite><testcase name="a"/><testcase name="b"><skipped/></testcase><!-- <testcase name="c"/> --><testcase name="d" time="1">\n</testcase></testsuite>';
  assert.deepEqual(countJunit([xml]), { tests: 3, failed: 0, skipped: 1 });
  assert.deepEqual(countJunit(['<testcase name="x"><failure message="boom"/></testcase>', '<testcase name="y"><error/></testcase>']), { tests: 2, failed: 2, skipped: 0 });
  assert.equal(reportProblem('test', [xml]), null);
  assert.match(reportProblem('test', [])!, /no JUnit XML/);
  assert.match(reportProblem('test', ['<testsuite tests="0"/>'])!, /ran no tests/);
  assert.match(reportProblem('e2e', ['<testsuite><testcase name="a"><skipped/></testcase></testsuite>'])!, /ran no tests/);
  assert.match(reportProblem('test', ['<testcase name="x"><failure/></testcase>'])!, /1 failing test/);
  assert.equal(testCountProblem(10, null, null), null); // first merge sets the baseline
  assert.equal(testCountProblem(12, 10, null), null);
  assert.match(testCountProblem(8, 10, null)!, /ran 8 tests; main runs 10/);
  assert.equal(testCountProblem(8, 10, 'removed the legacy importer'), null);
  assert.equal(testsRemovedReason('feat: x\n\nbody\n\nTests-Removed: legacy importer is gone\n'), 'legacy importer is gone');
  assert.equal(testsRemovedReason('feat: nothing to see'), null);
  assert.equal(dockerfileProblem('FROM factory-worker:current\nRUN apt-get install -y golang', 'factory-worker:current'), null);
  assert.equal(dockerfileProblem('FROM golang:1.25 AS tools\nRUN go install x\nFROM factory-worker:current\nCOPY --from=tools /go/bin/x /usr/local/bin/', 'factory-worker:current'), null);
  assert.match(dockerfileProblem('FROM ubuntu:24.04\n', 'factory-worker:current')!, /final stage/);
  assert.match(dockerfileProblem('RUN true\n', 'factory-worker:current')!, /no FROM/);
});

test('checkouts exclude the scratch dir, not the committed .factory/ contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-excl-'));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n\n.factory/\n');
  excludeRunDir(dir);
  excludeRunDir(dir);
  assert.equal(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), '# git ls-files --others --exclude-from=.git/info/exclude\n.factory-run/\n');
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
  mkdirSync(join(seed, '.factory'));
  writeFileSync(join(seed, '.factory', 'checks.yaml'), CHECKS);
  g(seed, 'add', '.');
  g(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  g(seed, 'push', '-q', origin, 'main');
  const config = parseFactoryConfig(`github: {owner: me}\npaths: {state: ${root}/state, repos: ${root}/repos, worktrees: ${root}/wt, logs: ${root}/logs, workerConfig: ${root}/cfg}`);
  const store = new Store(':memory:');
  const project: Project = { id: 'app', owner: 'me', kind: 'web-app', state: 'active', priority: 3, createdAt: 1 };
  store.upsertProject(project);
  const statuses: { sha: string; context: string; state: string; description?: string }[] = [];
  const comments: string[] = [];
  const merges: { pr: number; sha: string }[] = [];
  const fakeGh = {
    findOpenPullRequest: async () => null,
    createPullRequest: async () => ({ number: 41, html_url: 'x' }),
    setStatus: async (_o: string, _r: string, sha: string, s: { state: string; context: string; description?: string }) => void statuses.push({ sha, ...s }),
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

// ---------- the check contract in the review stage ----------

test('contract: a branch without checks fails the gates without running anything', async () => {
  const s = setup();
  await built(s, 20, 'nochecks');
  s.write('review-mode', 'review=approve');
  assert.equal(await review(s, 20), 'fix');
  assert.match(s.store.task('app#20')!.lastFailure!, /\.factory\/checks\.yaml is missing[\s\S]*JUnit XML/);
  assert.equal(s.count('gatesrun'), 0);
  assert.equal(s.statuses.at(-1)!.state, 'failure');
});

test('contract: tests that exit 0 without a report, or with zero tests, fail', async () => {
  const s = setup();
  await built(s, 21);
  s.write('review-mode', 'noreport\nreview=approve');
  assert.equal(await review(s, 21), 'fix');
  assert.match(s.store.task('app#21')!.lastFailure!, /checks failed: test, e2e[\s\S]*no JUnit XML report/);
  assert.equal(s.count('reviewsrun'), 0);

  await built(s, 22);
  s.write('review-mode', 'tests=0\nreview=approve');
  assert.equal(await review(s, 22), 'fix');
  assert.match(s.store.task('app#22')!.lastFailure!, /ran no tests/);
});

test('contract: the test count is recorded at merge and may not drop without a stated reason', async () => {
  const s = setup();
  await built(s, 23);
  s.write('review-mode', 'tests=5\nreview=approve');
  assert.equal(await review(s, 23), 'merged');
  assert.equal(s.store.getSetting('testCount:app'), '5');
  assert.match(s.statuses.find((x) => x.context === 'factory/gates' && x.state === 'success')!.description ?? '', /5 tests/);

  await built(s, 24);
  s.write('review-mode', 'tests=3\nreview=approve');
  assert.equal(await review(s, 24), 'fix');
  assert.match(s.store.task('app#24')!.lastFailure!, /ran 3 tests; main runs 5[\s\S]*Tests-Removed/);

  await built(s, 25, 'trailer');
  s.write('review-mode', 'tests=3\nreview=approve');
  assert.equal(await review(s, 25), 'merged');
  assert.match(readFileSync(join(s.root, 'reviewprompt'), 'utf8'), /ran 3 tests \(main ran 5\)[\s\S]*importer and its tests are gone/);
  assert.equal(s.store.getSetting('testCount:app'), '3');
});

test('contract: a toolchain Dockerfile is built once, checks run in it, and the reviewer watches .factory/ changes', async () => {
  const s = setup();
  process.env.DOCKER_FAKE_STATE = s.root;
  try {
    await built(s, 26, 'contract');
    s.write('review-mode', 'review=approve');
    assert.equal(await review(s, 26), 'merged');
    assert.equal(s.count('builds'), 1);
    const images = readFileSync(join(s.root, 'gateimages'), 'utf8').trim().split('\n');
    assert.ok(images.length === 8 && images.every((i) => i.startsWith('factory-project-app:')), images.join(','));
    assert.match(readFileSync(join(s.root, 'reviewprompt'), 'utf8'), /changes the project's check definitions \(\.factory\/Dockerfile\)[\s\S]*weakens any check/);

    await built(s, 27, 'contract');
    s.write('review-mode', 'imagefail\nreview=approve');
    assert.equal(await review(s, 27), 'fix');
    assert.match(s.store.task('app#27')!.lastFailure!, /Building \.factory\/Dockerfile failed[\s\S]*Unable to locate package/);
  } finally {
    delete process.env.DOCKER_FAKE_STATE;
  }
});

test('contract: macOS projects wait parked instead of running in a Linux container', async () => {
  const s = setup();
  s.g(s.seed, 'pull', '-q', s.origin, 'main');
  writeFileSync(join(s.seed, 'factory.yaml'), 'kind: ios\n');
  s.g(s.seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'ios');
  s.g(s.seed, 'push', '-q', s.origin, 'main');
  process.env.FACTORY_DOCKER_BIN = agentDocker;
  s.store.upsertTask(taskFromIssue('app', 3, { number: 28, title: 'Issue 28', body: null, labels: [] }));
  await runBuild(s.ctx, s.project, s.store.task('app#28')!, 'sonnet');
  const t = s.store.task('app#28')!;
  assert.equal(t.state, 'parked');
  assert.match(t.lastFailure!, /macOS runner/);
  assert.equal(existsSync(join(s.root, 'argsseen')), false); // no agent ran
});
