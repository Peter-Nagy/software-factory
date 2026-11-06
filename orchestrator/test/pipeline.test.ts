import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFactoryConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import type { GitHub } from '../src/github.ts';
import { taskFromIssue } from '../src/issues.ts';
import { runBuild, type PipelineContext } from '../src/pipeline.ts';
import { Secrets } from '../src/secrets.ts';
import type { Project } from '../src/types.ts';

const fakeDocker = fileURLToPath(new URL('./fixtures/fake-docker.sh', import.meta.url));
chmodSync(fakeDocker, 0o755);

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'factory-pipe-'));
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  g(root, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'factory.yaml'), 'kind: web-app\nsecrets: [APP_SECRET]\n');
  g(seed, 'add', '.');
  g(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  g(seed, 'push', '-q', origin, 'main');

  const config = parseFactoryConfig(
    `github: {owner: me}\npaths: {state: ${root}/state, repos: ${root}/repos, worktrees: ${root}/wt, logs: ${root}/logs, workerConfig: ${root}/cfg}`,
  );
  const store = new Store(':memory:');
  const project: Project = { id: 'app', owner: 'me', kind: 'web-app', state: 'active', priority: 3, createdAt: 1 };
  store.upsertProject(project);
  const prs: { title: string; head: string; body: string }[] = [];
  const notes: string[] = [];
  const fakeGh = {
    findOpenPullRequest: async () => null,
    createPullRequest: async (_o: string, _r: string, p: { title: string; head: string; body: string }) => (prs.push(p), { number: 41, html_url: 'x' }),
  } as unknown as GitHub;
  const ctx: PipelineContext = {
    config,
    store,
    secrets: new Secrets({ reader: async (ref) => `value-of-${ref}` }),
    repoAccess: async () => ({ gh: fakeGh, token: '' }),
    remoteUrl: () => origin,
    now: () => Math.floor(Date.now() / 1000),
    notify: async (_k, t) => void notes.push(t),
  };
  return { ctx, store, project, prs, notes, origin, g, root };
}

async function run(mode: string, issue: number, s = setup()) {
  process.env.FACTORY_DOCKER_BIN = fakeDocker;
  writeFileSync(join(s.root, 'mode'), mode);
  s.store.upsertTask(taskFromIssue('app', 3, { number: issue, title: `Issue ${issue}`, body: null, labels: [] }));
  await runBuild(s.ctx, s.project, s.store.task(`app#${issue}`)!, 'sonnet', 'build', null);
  return { ...s, task: s.store.task(`app#${issue}`)! };
}

test('pipeline: pushed work opens a PR and moves to in_review', async () => {
  const r = await run('success', 7);
  assert.equal(r.task.state, 'in_review');
  assert.equal(r.task.prNumber, 41);
  assert.equal(r.task.attempt, 1);
  assert.equal(r.task.sessionId, 'sess-fake');
  assert.equal(r.prs[0]!.head, 'claude/7-issue-7');
  assert.match(r.prs[0]!.body, /fake feature[\s\S]*Closes #7/);
  assert.equal(r.g(r.origin, 'log', '-1', '--format=%s', 'claude/7-issue-7'), 'feat: fake work');
  const run0 = r.store.db.prepare('SELECT ok, cost_usd FROM runs').get() as { ok: number; cost_usd: number };
  assert.deepEqual({ ...run0 }, { ok: 1, cost_usd: 0.1 });
});

test('pipeline: a question blocks the task and notifies', async () => {
  const r = await run('question', 8);
  assert.equal(r.task.state, 'blocked');
  assert.equal(r.notes.length, 1);
  const q = r.store.db.prepare('SELECT question, default_option, timeout_at - asked_at AS t FROM questions').get() as Record<string, unknown>;
  assert.deepEqual({ ...q }, { question: 'Which colour?', default_option: 'blue', t: 24 * 3600 });
});

test('pipeline: usage limit checkpoints, pushes WIP and requeues with the session', async () => {
  const r = await run('limit', 9);
  assert.equal(r.task.state, 'queued');
  assert.equal(r.task.sessionId, 'sess-fake');
  assert.equal(r.g(r.origin, 'log', '-1', '--format=%s', 'claude/9-issue-9'), 'wip');
  assert.equal(r.store.latestUsage()!.fiveHourPct, 100);
});

test('pipeline: failure follows the retry ladder (fix on the same session first)', async () => {
  const r = await run('fail', 10);
  assert.equal(r.task.state, 'queued');
  assert.equal(r.task.sessionId, 'sess-fake');
  assert.match(r.task.lastFailure!, /tests pass/);
});

test('pipeline: a queued fix resumes the session and lands back in review', async () => {
  const r = await run('fail', 11);
  writeFileSync(join(r.root, 'mode'), 'success');
  await runBuild(r.ctx, r.project, r.task, 'sonnet', 'fix', r.task.lastFailure);
  const t = r.store.task('app#11')!;
  assert.equal(t.state, 'in_review');
  assert.equal(t.fixRounds, 1);
  assert.equal(t.attempt, 1);
  assert.equal(t.lastFailure, null);
});
