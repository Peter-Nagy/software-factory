import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFactoryConfig } from '../src/config.ts';
import { dashboardToken, hostAllowed, startDashboard, type DashboardContext } from '../src/dashboard/server.ts';
import { Store } from '../src/db.ts';
import type { GitHub } from '../src/github.ts';
import { applyIssuePlan, createPlan, executePlan, issuePlanFor, parseIssueFile, getPlan, issueBody, issueLabels, planMessages, planTurn, readPlanFiles, topoOrder, validatePlan, type PlanFile } from '../src/plan.ts';
import { Secrets } from '../src/secrets.ts';
import { taskFromIssue } from '../src/issues.ts';

const planDocker = fileURLToPath(new URL('./fixtures/fake-docker-plan.sh', import.meta.url));
chmodSync(planDocker, 0o755);

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'factory-dash-'));
  const store = new Store(':memory:');
  const config = parseFactoryConfig(`github: {owner: me}\npaths: {state: ${root}/state, logs: ${root}/logs, workerConfig: ${root}/cfg}\ndashboard: {port: 0}`);
  store.upsertProject({ id: 'app', owner: 'me', kind: 'web-app', state: 'active', priority: 3, createdAt: 1 });
  const created: { repo: string; title: string; body: string; labels: string[] }[] = [];
  const labels: string[] = [];
  let failAfter = Infinity;
  let n = 100;
  const gh = {
    ensureLabels: async (_o: string, _r: string, ls: { name: string }[]) => void labels.push(...ls.map((l) => l.name)),
    createIssue: async (_o: string, repo: string, p: { title: string; body: string; labels: string[] }) => {
      if (created.length >= failAfter) throw new Error('GitHub is down');
      created.push({ repo, ...p });
      return { number: ++n, html_url: `https://github.com/me/${repo}/issues/${n}` };
    },
  } as unknown as GitHub;
  const ctx: DashboardContext = {
    config, store, secrets: new Secrets({ reader: async () => 'secret' }),
    repoAccess: async () => ({ gh, token: 'read-token' }), repoClient: async () => ({ gh, token: 'orch-token' }),
    now: () => Math.floor(Date.now() / 1000), notify: async () => undefined,
  };
  const repos: { name: string; files: Record<string, string> }[] = [];
  const createRepo = async (p: { name: string; files: Record<string, string> }) => (repos.push(p), { owner: 'me', name: p.name });
  return { root, store, ctx, gh, created, labels, repos, createRepo, failAt: (k: number) => (failAfter = k) };
}

// ---------- plan logic ----------

const sample: PlanFile = {
  title: 'v1',
  project: { name: 'habit-tracker', kind: 'web-app', priority: 3 },
  issues: [
    { key: 'b', title: 'Second', body: 'Body text here', size: 'm', risk: 'low', dependsOn: ['a'] },
    { key: 'a', title: 'First', body: 'Body text here', size: 's', risk: 'high', area: 'auth', dependsOn: [] },
  ],
};

test('plan validation: ordering, unknown dependencies, cycles, project for new plans', () => {
  assert.deepEqual(topoOrder(sample.issues)!.map((i) => i.key), ['a', 'b']);
  assert.deepEqual(validatePlan(sample, 'new'), []);
  assert.match(validatePlan({ ...sample, project: undefined }, 'new')[0]!, /needs "project"/);
  assert.match(validatePlan({ ...sample, issues: [{ ...sample.issues[0]!, dependsOn: ['zzz'] }] }, 'existing')[0]!, /unknown "zzz"/);
  const cyc = [{ ...sample.issues[0]!, dependsOn: ['a'] }, { ...sample.issues[1]!, dependsOn: ['b'] }];
  assert.match(validatePlan({ ...sample, issues: cyc }, 'existing')[0]!, /cycle/);
  assert.deepEqual(issueLabels(sample.issues[1]!, 4), ['factory:ready', 'size:s', 'risk:high', 'priority:4', 'area:auth']);
  assert.equal(issueBody(sample.issues[0]!, 7, [8]), 'Body text here\n\nPart of the plan in #7.\nDepends on #8');
});

test('plan turn: the planner drafts files, its reply is stored, the session continues', async () => {
  const s = setup();
  process.env.FACTORY_DOCKER_BIN = planDocker;
  const plan = createPlan(s.ctx, { title: 'Habit tracker', target: 'new' });
  await planTurn(s.ctx, plan.id, 'Track my habits please');
  let p = getPlan(s.ctx, plan.id)!;
  assert.equal(p.state, 'drafting');
  assert.equal(p.sessionId, 'plan-sess');
  const msgs = planMessages(s.ctx, plan.id);
  assert.deepEqual(msgs.map((m) => m.role), ['owner', 'planner']);
  assert.match(msgs[1]!.text, /Ready to execute: 3 issues/);
  const files = readPlanFiles(s.ctx, p);
  assert.deepEqual(files.errors, []);
  assert.equal(files.plan!.issues.length, 3);
  assert.match(readFileSync(join(s.root, 'state/plans', String(plan.id), 'argsseen'), 'utf8'), /--model opus/);
  await planTurn(s.ctx, plan.id, 'Make it smaller');
  p = getPlan(s.ctx, plan.id)!;
  assert.match(readFileSync(join(s.root, 'state/plans', String(plan.id), 'argsseen'), 'utf8'), /--resume plan-sess -p Make it smaller|--resume plan-sess/);
  assert.equal(planMessages(s.ctx, plan.id).length, 4);
});

test('plan turn on an existing project mounts a read-only clone of main', async () => {
  const s = setup();
  const origin = join(s.root, 'origin.git');
  const seed = join(s.root, 'seed');
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  g(s.root, 'init', '-q', '--bare', '-b', 'main', origin);
  g(s.root, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'CLAUDE.md'), 'hi');
  g(seed, 'add', '.');
  g(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  g(seed, 'push', '-q', origin, 'main');
  s.ctx.remoteUrl = () => origin;
  process.env.FACTORY_DOCKER_BIN = planDocker;
  const plan = createPlan(s.ctx, { title: 'Dark mode', target: 'existing', projectId: 'app', model: 'sonnet' });
  await planTurn(s.ctx, plan.id, 'Add dark mode');
  const dir = join(s.root, 'state/plans', String(plan.id));
  assert.match(readFileSync(join(dir, 'repo-files'), 'utf8'), /CLAUDE\.md/);
  assert.match(readFileSync(join(dir, 'argsseen'), 'utf8'), /:\/work\/repo:ro[\s\S]*--model sonnet/);
});

test('execute: new project gets a repo, labels, a spec issue and ordered issues; a failure halfway resumes', async () => {
  const s = setup();
  process.env.FACTORY_DOCKER_BIN = planDocker;
  const plan = createPlan(s.ctx, { title: 'Habit tracker', target: 'new' });
  await planTurn(s.ctx, plan.id, 'go');
  s.failAt(2); // tracking issue + first issue succeed, then GitHub fails
  await assert.rejects(executePlan(s.ctx, { createRepo: s.createRepo, repoClient: async () => ({ gh: s.gh }) }, plan.id), /GitHub is down/);
  assert.equal(getPlan(s.ctx, plan.id)!.state, 'failed');
  s.failAt(Infinity);
  const r = await executePlan(s.ctx, { createRepo: s.createRepo, repoClient: async () => ({ gh: s.gh }) }, plan.id);
  assert.equal(s.repos.length, 1); // not created twice
  assert.match(s.repos[0]!.files['factory.yaml']!, /kind: web-app\npriority: 4/);
  assert.deepEqual(s.created.map((c) => c.title), ['Plan: Habit tracker v1', 'Scaffold the app', 'Add and list habits', 'Show streaks']);
  assert.deepEqual(s.created[0]!.labels, ['factory:plan']);
  assert.match(s.created[3]!.body, /Part of the plan in #101\.\nDepends on #102, #103$/);
  assert.ok(s.created[2]!.labels.includes('area:habits'));
  assert.ok(s.labels.includes('area:streaks') && s.labels.includes('factory:ready'));
  assert.deepEqual(r.issues, { scaffold: 102, habits: 103, streaks: 104 });
  assert.equal(getPlan(s.ctx, plan.id)!.state, 'executed');
  assert.equal(s.store.projects().find((p) => p.id === 'habit-tracker')?.state, 'active');
});

// ---------- HTTP: auth, host and CSRF checks ----------

async function serve() {
  const s = setup();
  const dist = join(s.root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Software Factory</title><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
  const server = await startDashboard(s.ctx, { createRepo: s.createRepo, log: () => undefined, distDir: dist });
  const port = (server.address() as AddressInfo).port;
  const token = dashboardToken(s.ctx);
  const call = (path: string, init: RequestInit & { host?: string } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...init, headers: { host: init.host ?? `localhost:${port}`, ...(init.headers ?? {}) } });
  return { ...s, server, token, call, port };
}

test('dashboard: nothing works without the login cookie; the login link sets it', async () => {
  const d = await serve();
  try {
    assert.equal((await d.call('/api/state')).status, 401);
    assert.equal((await d.call('/')).status, 401);
    assert.equal((await d.call('/login?t=wrong')).status, 403);
    const login = await d.call(`/login?t=${d.token}`);
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const jar = cookie.split(';')[0]!;
    const state = (await (await d.call('/api/state', { headers: { cookie: jar } })).json()) as { projects: { id: string }[] };
    assert.equal(state.projects[0]!.id, 'app');
    const page = await d.call('/', { headers: { cookie: jar } });
    assert.match(await page.text(), /Software Factory/);
    assert.match(page.headers.get('content-security-policy')!, /script-src 'self';.*frame-ancestors 'none'/);
    // client-side routes fall back to the app; assets are served (and cached) without a session
    assert.match(await (await d.call('/projects/app', { headers: { cookie: jar } })).text(), /Software Factory/);
    const asset = await d.call('/assets/app-abc.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control')!, /immutable/);
    assert.equal((await d.call('/projects/app')).status, 401);
    assert.equal((await d.call('/assets/../../../etc/passwd')).status, 401); // normalised to a page: needs a session
  } finally {
    d.server.close();
  }
});

test('dashboard: writes need the X-Factory header; unknown hosts are refused', async () => {
  const d = await serve();
  try {
    const jar = (await d.call(`/login?t=${d.token}`)).headers.get('set-cookie')!.split(';')[0]!;
    const post = (extra: Record<string, string>) => d.call('/api/pause', { method: 'POST', headers: { cookie: jar, 'content-type': 'application/json', ...extra }, body: JSON.stringify({ hours: 2 }) });
    assert.equal((await post({})).status, 403);
    assert.equal(d.store.getSetting('pausedUntil'), null);
    assert.equal((await post({ 'x-factory': '1' })).status, 200);
    assert.ok(Number(d.store.getSetting('pausedUntil')) > 0);
    // a container reaching the Mac uses another host name; DNS-rebinding pages too
    const rawStatus = (host: string) =>
      new Promise<number>((resolve, reject) => {
        request({ host: '127.0.0.1', port: d.port, path: '/api/state', headers: { host, cookie: jar } }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject).end();
      });
    assert.equal(await rawStatus('host.docker.internal'), 421);
    assert.equal(await rawStatus(`localhost:${d.port}`), 200);
    assert.equal(hostAllowed('mac-mini.tail1234.ts.net', []), true);
    assert.equal(hostAllowed('evil.example', []), false);
  } finally {
    d.server.close();
  }
});

test('dashboard: plans over HTTP, answers and task actions', async () => {
  const d = await serve();
  process.env.FACTORY_DOCKER_BIN = planDocker;
  try {
    const jar = (await d.call(`/login?t=${d.token}`)).headers.get('set-cookie')!.split(';')[0]!;
    const api = async (method: string, path: string, body?: object) => {
      const r = await d.call(`/api/${path}`, { method, headers: { cookie: jar, 'x-factory': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: r.status, json: (await r.json()) as any };
    };
    const created = await api('POST', 'plans', { title: 'Habit tracker', target: 'new', message: 'track habits', model: 'sonnet' });
    assert.equal(created.status, 200);
    const id = created.json.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let view: any;
    for (let i = 0; i < 50; i++) {
      view = (await api('GET', `plans/${id}`)).json;
      if (!view.busy && view.plan.state === 'drafting' && view.messages.length >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(view.files.plan.issues.length, 3);
    assert.equal((await api('POST', `plans/${id}/execute`)).status, 200);
    for (let i = 0; i < 50 && (await api('GET', `plans/${id}`)).json.plan.state !== 'executed'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await api('GET', `plans/${id}`)).json.plan.state, 'executed');
    assert.equal(d.created.length, 4);
    assert.equal((await api('POST', `plans/${id}/messages`, { text: 'more' })).status, 400); // finished plans don't take messages
    assert.equal((await api('POST', 'tasks/app%2399/retry')).status, 400);
    assert.equal((await api('POST', 'questions/123/answer', { answer: 'x' })).status, 400);
    assert.equal((await api('POST', 'nope')).status, 404);
    assert.ok(existsSync(join(d.root, 'state/plans', String(id), 'work/plan/plan.json')));
  } finally {
    d.server.close();
  }
});

test('dashboard: project and task details, pausing a project', async () => {
  const d = await serve();
  try {
    const jar = (await d.call(`/login?t=${d.token}`)).headers.get('set-cookie')!.split(';')[0]!;
    const api = async (method: string, path: string, body?: object) => {
      const r = await d.call(`/api/${path}`, { method, headers: { cookie: jar, 'x-factory': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: r.status, json: (await r.json()) as any };
    };
    (d.gh as unknown as { readFile: unknown }).readFile = async () => '# App\n\nGoals here';
    d.store.upsertTask({ ...(await import('../src/issues.ts')).taskFromIssue('app', 3, { number: 5, title: 'Five', body: null, labels: [] }) });
    const p = await api('GET', 'projects/app');
    assert.equal(p.json.product, '# App\n\nGoals here');
    assert.deepEqual(p.json.tasks.map((t: { id: string }) => t.id), ['app#5']);
    assert.equal((await api('POST', 'projects/app/state', { state: 'paused' })).status, 200);
    assert.equal(d.store.projects()[0]!.state, 'paused');
    assert.equal((await api('POST', 'projects/app/state', { state: 'archived' })).status, 400);
    const t = await api('GET', `tasks/${encodeURIComponent('app#5')}`);
    assert.equal(t.json.task.title, 'Five');
  } finally {
    d.server.close();
  }
});

test('issue conversation: starts from the issue on GitHub, applies the revision, restarts a parked task', async () => {
  const s = setup();
  const origin = join(s.root, 'origin.git');
  const seed = join(s.root, 'seed');
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  g(s.root, 'init', '-q', '--bare', '-b', 'main', origin);
  g(s.root, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'CLAUDE.md'), 'hi');
  g(seed, 'add', '.');
  g(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  g(seed, 'push', '-q', origin, 'main');
  s.ctx.remoteUrl = () => origin;
  const updates: unknown[] = [];
  const comments: string[] = [];
  Object.assign(s.gh, {
    issue: async () => ({ number: 7, title: 'Import CSV', body: 'Import habits.', state: 'open', html_url: 'u', labels: [] }),
    updateIssue: async (_o: string, _r: string, n: number, p: unknown) => void updates.push({ n, ...(p as object) }),
    comment: async (_o: string, _r: string, _n: number, b: string) => void comments.push(b),
  });
  s.store.upsertTask(taskFromIssue('app', 3, { number: 7, title: 'Import CSV', body: null, labels: [] }));
  for (const to of ['building', 'parked'] as const) s.store.transition('app#7', to, to === 'building' ? { attempt: 3, branch: 'b' } : { lastFailure: 'CSV tests fail' });

  assert.deepEqual(parseIssueFile('# Title here\n\nBody text long enough'), { title: 'Title here', body: 'Body text long enough' });
  assert.equal(parseIssueFile('No heading\nbody body body'), null);
  assert.throws(() => createPlan(s.ctx, { title: 'x', target: 'existing', projectId: 'app', focus: 'issue' }), /issue number/);

  process.env.FACTORY_DOCKER_BIN = planDocker;
  const plan = createPlan(s.ctx, { title: '#7', target: 'existing', projectId: 'app', focus: 'issue', issueNumber: 7 });
  assert.equal(plan.model, 'sonnet');
  assert.equal(issuePlanFor(s.ctx, 'app', 7)!.id, plan.id);
  await planTurn(s.ctx, plan.id, 'Quoted newlines must work');
  const dir = join(s.root, 'state/plans', String(plan.id));
  assert.equal(readFileSync(join(dir, 'issue-seen'), 'utf8'), '# Import CSV\n\nImport habits.\n');
  assert.match(readFileSync(join(dir, 'argsseen'), 'utf8'), /revise issue #7/);
  const files = readPlanFiles(s.ctx, getPlan(s.ctx, plan.id)!);
  assert.deepEqual(files.errors, []);
  assert.equal(files.issue!.title, 'Import habits from CSV files');

  await applyIssuePlan(s.ctx, { repoClient: async () => ({ gh: s.gh }) }, plan.id);
  assert.deepEqual(updates, [{ n: 7, title: 'Import habits from CSV files', body: files.issue!.body }]);
  assert.match(comments[0]!, /conversation/);
  const t = s.store.task('app#7')!;
  assert.equal(t.state, 'queued');
  assert.equal(t.attempt, 0);
  assert.equal(t.pendingMode, 'build');
  assert.equal(t.title, 'Import habits from CSV files');
  assert.equal(getPlan(s.ctx, plan.id)!.state, 'drafting'); // stays open for more rounds
  assert.match(planMessages(s.ctx, plan.id).at(-1)!.text, /Applied to issue #7\. The parked task starts over/);
});
