import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFactoryConfig } from '../src/config.ts';
import { dashboardToken, startDashboard, type DashboardContext } from '../src/dashboard/server.ts';
import { Store } from '../src/db.ts';
import type { GitHub } from '../src/github.ts';
import { executePlan, getPlan } from '../src/plan.ts';
import { Secrets } from '../src/secrets.ts';
import {
  approvePhase,
  autoInterview,
  latestAnswers,
  MAX_STANDIN_ROUNDS,
  reviewAnswers,
  stopAutoInterview,
  studioAnswers,
  createStudio,
  ensureStudioPlan,
  getStudio,
  phaseRow,
  listMockups,
  mockupPath,
  syncPlanPhase,
  PhaseStatusSchema,
  readStatus,
  recoverStudios,
  setStudioMode,
  startQueuedPhases,
  studioMessages,
  studioPhases,
  studioTurn,
  studioWork,
  studioWaits,
  type PhaseKey,
} from '../src/studio.ts';

const fixture = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const studioDocker = fixture('fake-docker-studio.sh');
const planDocker = fixture('fake-docker-plan.sh');
chmodSync(studioDocker, 0o755);
chmodSync(planDocker, 0o755);

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'factory-studio-'));
  const store = new Store(':memory:');
  const config = parseFactoryConfig(`github: {owner: me}\npaths: {state: ${root}/state, logs: ${root}/logs, workerConfig: ${root}/cfg}\ndashboard: {port: 0}`);
  const repos: { name: string; files: Record<string, string> }[] = [];
  const notes: [string, string][] = [];
  const gh = {
    ensureLabels: async () => undefined,
    createIssue: async () => ({ number: 1, html_url: 'x' }),
  } as unknown as GitHub;
  const now = Math.floor(Date.now() / 1000);
  // fresh, low usage so the governor lets autopilot run (Opus included)
  store.recordUsage({ fiveHourPct: 10, fiveHourResetsAt: now + 3600, sevenDayPct: 5, sevenDayResetsAt: now + 6 * 86400, source: 'stream', takenAt: now });
  const ctx: DashboardContext = {
    config, store, secrets: new Secrets({ reader: async () => 'secret' }),
    repoAccess: async () => ({ gh, token: 't' }), repoClient: async () => ({ gh, token: 't' }),
    now: () => Math.floor(Date.now() / 1000), notify: async (kind, text) => void notes.push([kind, text]),
  };
  process.env.FACTORY_DOCKER_BIN = studioDocker;
  const mode = (id: number, phase: PhaseKey, m: string) => writeFileSync(join(studioWork(ctx, id), '..', `mode-${phase}`), m);
  const states = (id: number) => Object.fromEntries(studioPhases(ctx, id).map((p) => [p.phase, p.state]));
  return { root, store, ctx, repos, notes, mode, states, createRepo: async (p: { name: string; files: Record<string, string> }) => (repos.push(p), { owner: 'me', name: p.name }) };
}

test('studio, guided: phases open in order, approval unlocks the next, spikes skip when there is nothing to test', async () => {
  const s = setup();
  const st = createStudio(s.ctx, { title: 'Running app' });
  assert.deepEqual(Object.values(s.states(st.id)), ['ready', 'locked', 'locked', 'locked', 'locked', 'locked', 'locked', 'locked']);
  await assert.rejects(studioTurn(s.ctx, st.id, 'research', 'go'), /locked/);

  await studioTurn(s.ctx, st.id, 'brief', 'I want to create a running app');
  assert.equal(s.states(st.id).brief, 'drafting');
  assert.deepEqual(studioMessages(s.ctx, st.id, 'brief').map((m) => m.role), ['owner', 'agent']);
  const args = readFileSync(join(studioWork(s.ctx, st.id), '..', 'args-brief'), 'utf8');
  assert.match(args, /--model opus[\s\S]*prompts\/studio\.md/);
  assert.match(args, /You own the Brief phase[\s\S]*status\/brief\.json/);

  for (const phase of ['brief', 'research', 'product', 'design'] as PhaseKey[]) {
    if (phase !== 'brief') await studioTurn(s.ctx, st.id, phase, 'go');
    approvePhase(s.ctx, st.id, phase);
  }
  assert.equal(phaseRow(s.ctx, st.id, 'design').model, 'opus');
  await studioTurn(s.ctx, st.id, 'architecture', 'go');
  approvePhase(s.ctx, st.id, 'architecture');
  assert.equal(s.states(st.id).spikes, 'skipped');
  assert.equal(s.states(st.id).plan, 'ready');
  assert.throws(() => approvePhase(s.ctx, st.id, 'plan'), /executing it/);

  // Reworking the product makes the later approved phases stale.
  await studioTurn(s.ctx, st.id, 'product', 'add social features');
  approvePhase(s.ctx, st.id, 'product');
  const after = s.states(st.id);
  assert.equal(after.design, 'stale');
  assert.equal(after.architecture, 'stale');
  assert.equal(after.product, 'approved');
});

test('studio, guided: risky unknowns open the spikes phase; a failed turn keeps the phase usable', async () => {
  const s = setup();
  const st = createStudio(s.ctx, { title: 'Running app' });
  for (const phase of ['brief', 'research', 'product', 'design'] as PhaseKey[]) {
    await studioTurn(s.ctx, st.id, phase, 'go');
    approvePhase(s.ctx, st.id, phase);
  }
  s.mode(st.id, 'architecture', 'spikes');
  await studioTurn(s.ctx, st.id, 'architecture', 'go');
  approvePhase(s.ctx, st.id, 'architecture');
  assert.equal(s.states(st.id).spikes, 'ready');
  assert.equal(s.states(st.id).plan, 'locked');

  s.mode(st.id, 'spikes', 'fail');
  await studioTurn(s.ctx, st.id, 'spikes', 'go');
  assert.equal(s.states(st.id).spikes, 'ready');
  assert.match(studioMessages(s.ctx, st.id, 'spikes').at(-1)!.text, /The agent stopped: gave up/);
});

test('studio, autopilot: done phases approve themselves under the governor and stop at the go/no-go', async () => {
  const s = setup();
  const st = createStudio(s.ctx, { title: 'Running app', mode: 'autopilot' });
  s.mode(st.id, 'research', 'narrow');
  setStudioMode(s.ctx, st.id, 'autopilot');
  assert.equal(s.states(st.id).brief, 'queued');

  const run = async () => {
    const work: Promise<void>[] = [];
    const started = startQueuedPhases(s.ctx, [], (w) => work.push(w));
    await Promise.all(work);
    return started;
  };
  assert.deepEqual(await run(), [`${st.id}:brief`]);
  assert.equal(s.states(st.id).brief, 'approved');
  assert.equal(s.states(st.id).research, 'queued');

  // Paused: nothing starts, the phase says why.
  s.store.setSetting('pausedUntil', String(Math.floor(Date.now() / 1000) + 3600));
  assert.deepEqual(await run(), []);
  assert.match(phaseRow(s.ctx, st.id, 'research').note!, /Waiting: factory paused/);
  s.store.setSetting('pausedUntil', null);

  assert.deepEqual(await run(), [`${st.id}:research`]);
  assert.equal(s.states(st.id).research, 'drafting'); // verdict "narrow": stops for the owner
  assert.match(studioMessages(s.ctx, st.id, 'research').at(-1)!.text, /go\/no-go[\s\S]*narrow/);
  assert.deepEqual(await run(), []);

  // The owner approves anyway; autopilot carries on until a phase has questions.
  s.mode(st.id, 'product', 'questions');
  approvePhase(s.ctx, st.id, 'research');
  assert.deepEqual(await run(), [`${st.id}:product`]);
  assert.equal(s.states(st.id).product, 'drafting');
  assert.match(studioMessages(s.ctx, st.id, 'product').at(-1)!.text, /has questions for you/);
});

test('studio: a restart puts interrupted phases back', () => {
  const s = setup();
  const st = createStudio(s.ctx, { title: 'x' });
  s.store.db.prepare(`UPDATE studio_phases SET state = 'thinking' WHERE studio_id = ? AND phase = 'brief'`).run(st.id);
  recoverStudios(s.ctx);
  assert.equal(s.states(st.id).brief, 'ready');
  assert.match(phaseRow(s.ctx, st.id, 'brief').note!, /restart/);
});

test('studio build plan: the planner reads the studio documents and Execute puts them in the new repo', async () => {
  const s = setup();
  const st = createStudio(s.ctx, { title: 'Running app' });
  for (const phase of ['brief', 'research', 'product', 'design', 'architecture'] as PhaseKey[]) {
    await studioTurn(s.ctx, st.id, phase, 'go');
    approvePhase(s.ctx, st.id, phase);
  }
  process.env.FACTORY_DOCKER_BIN = planDocker;
  await studioTurn(s.ctx, st.id, 'plan', 'Plan it');
  const plan = getPlan(s.ctx, getStudio(s.ctx, st.id)!.planId!)!;
  assert.equal(plan.studioId, st.id);
  assert.equal(s.states(st.id).plan, 'drafting');
  const args = readFileSync(join(s.root, 'state/plans', String(plan.id), 'argsseen'), 'utf8');
  assert.match(args, /studios\/\d+\/work\/docs:\/work\/studio:ro/);
  assert.match(args, /last phase of a Studio/);
  assert.equal(ensureStudioPlan(s.ctx, getStudio(s.ctx, st.id)!).id, plan.id); // one plan per studio

  await executePlan(s.ctx, { createRepo: s.createRepo, repoClient: async () => ({ gh: (await s.ctx.repoClient({} as never, {})).gh }) }, plan.id);
  const files = s.repos[0]!.files;
  assert.match(files['docs/RESEARCH.md']!, /Strava/);
  assert.match(files['docs/design/home.html']!, /Today/);
  assert.match(files['docs/PRODUCT.md']!, /Habit tracker/); // the plan's own spec wins over the studio draft
  assert.equal(files['docs/status/brief.json'], undefined);

  // The executed plan opens the launch kit, prepared while the factory builds; its pages are listed with the mockups.
  syncPlanPhase(s.ctx, st.id);
  assert.equal(s.states(st.id).plan, 'approved');
  assert.equal(s.states(st.id).launch, 'ready');
  process.env.FACTORY_DOCKER_BIN = studioDocker;
  await studioTurn(s.ctx, st.id, 'launch', 'Prepare the launch');
  assert.equal(s.states(st.id).launch, 'drafting');
  assert.deepEqual(listMockups(s.ctx, st.id), ['home.html', 'launch/landing.html']);
  assert.match(readFileSync(mockupPath(s.ctx, st.id, 'launch/landing.html'), 'utf8'), /Run together/);
  approvePhase(s.ctx, st.id, 'launch');
  assert.equal(s.states(st.id).launch, 'approved');
});

// ---------- over HTTP ----------

function call(port: number, method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: 'localhost', ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...(method === 'POST' ? { 'X-Factory': '1', 'Content-Type': 'application/json' } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('studio over HTTP: create with a first message, read, approve; mockups are served sandboxed', async () => {
  const s = setup();
  const server = await startDashboard(s.ctx, { createRepo: s.createRepo, distDir: join(s.root, 'nodist'), log: () => undefined });
  const port = (server.address() as AddressInfo).port;
  const cookie = `factory_session=${encodeURIComponent(dashboardToken(s.ctx))}`;
  try {
    const created = JSON.parse((await call(port, 'POST', '/api/studios', { cookie, body: { title: 'Running app', message: 'I want to create a running app' } })).text);
    for (let i = 0; i < 50 && studioMessages(s.ctx, created.id).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    const detail = JSON.parse((await call(port, 'GET', `/api/studios/${created.id}`, { cookie })).text);
    assert.equal(detail.phases[0].state, 'drafting');
    assert.equal(detail.phases[0].status.ready, true);
    assert.match(detail.docs.brief, /A running app/);
    assert.equal((await call(port, 'POST', `/api/studios/${created.id}/approve`, { cookie, body: { phase: 'research' } })).status, 400);
    assert.equal((await call(port, 'POST', `/api/studios/${created.id}/approve`, { cookie, body: { phase: 'brief' } })).status, 200);
    assert.equal((await call(port, 'POST', `/api/studios/${created.id}/messages`, { cookie, body: { phase: 'design', text: 'x' } })).status, 400); // locked
    assert.equal((await call(port, 'POST', `/api/studios/${created.id}/approve`, { cookie, body: { phase: 'nope' } })).status, 400);

    // A mockup with a script: served with a sandbox CSP and no access to anything else.
    for (const phase of ['research', 'product', 'design'] as PhaseKey[]) {
      await studioTurn(s.ctx, created.id, phase, 'go');
      approvePhase(s.ctx, created.id, phase);
    }
    const m = await call(port, 'GET', `/api/studios/${created.id}/mockup?name=home.html`, { cookie });
    assert.equal(m.status, 200);
    assert.match(String(m.headers['content-security-policy']), /^sandbox; default-src 'none'.*frame-ancestors 'self'/);
    assert.equal(m.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal((await call(port, 'GET', `/api/studios/${created.id}/mockup?name=../../../factory.db`, { cookie })).status, 404);
    assert.equal((await call(port, 'GET', `/api/studios/${created.id}/mockup?name=home.html`)).status, 401);
    assert.ok(existsSync(join(studioWork(s.ctx, created.id), 'docs', 'design', 'home.html')));
  } finally {
    server.close();
  }
});


test('studio interview: questions are structured, plain strings still work, and the mode is in every turn', async () => {
  const parsed = PhaseStatusSchema.parse({
    ready: false,
    questions: [
      'Describe your typical run',
      { header: 'Platform', question: 'Which platforms?', options: ['iPhone', { label: 'Web', description: 'More work' }], recommended: 'iPhone' },
    ],
    coverage: [{ topic: 'Platforms', done: false }],
  });
  assert.deepEqual(parsed.questions[0], { question: 'Describe your typical run', header: '', why: '', options: [], multiSelect: false, recommended: null });
  assert.deepEqual(parsed.questions[1]!.options, [{ label: 'iPhone', description: '' }, { label: 'Web', description: 'More work' }]);
  assert.equal(parsed.questions[1]!.recommended, 'iPhone');
  assert.equal(PhaseStatusSchema.safeParse({ ready: true, questions: Array.from({ length: 16 }, () => 'q?') }).success, false);

  const { ctx, mode, notes } = setup();
  const st = createStudio(ctx, { title: 'Run', mode: 'guided' });
  const prompt = () => readFileSync(join(studioWork(ctx, st.id), '..', 'args-brief'), 'utf8');
  mode(st.id, 'brief', 'interview');
  await studioTurn(ctx, st.id, 'brief', 'I want a running app');
  const status = readStatus(ctx, st.id, 'brief')!;
  assert.equal(status.questions.length, 2);
  assert.equal(status.questions[0]!.options.length, 2);
  assert.deepEqual(status.coverage.map((c) => c.done), [true, false]);
  assert.match(prompt(), /Mode: guided/);
  setStudioMode(ctx, st.id, 'autopilot');
  setStudioMode(ctx, st.id, 'guided');
  await studioTurn(ctx, st.id, 'brief', 'Answers to your questions:\n\n> Which platforms?\nYour call');
  assert.match(prompt(), /Mode: guided[\s\S]*Answers to your questions/);
  assert.deepEqual(notes.at(-1), ['question', 'Studio "Run": the brief agent has 2 questions.']);
  assert.deepEqual(studioWaits(ctx).map((w) => [w.phase, w.kind, w.count]), [['brief', 'questions', 2]]);
});

test('studio skip: a stand-in answers round after round, then the owner reviews; edits go back, no edits approve', async () => {
  const { ctx, mode, states, notes } = setup();
  const st = createStudio(ctx, { title: 'Run', mode: 'guided' });
  mode(st.id, 'brief', 'rounds');
  await studioTurn(ctx, st.id, 'brief', 'I want a running app');
  assert.equal(readStatus(ctx, st.id, 'brief')!.questions.length, 2);

  await autoInterview(ctx, st.id, 'brief');
  const turns = readFileSync(join(studioWork(ctx, st.id), '..', 'turns'), 'utf8').trim().split('\n');
  assert.deepEqual(turns, ['brief', 'standin-brief', 'brief', 'standin-brief', 'brief']);
  assert.equal(phaseRow(ctx, st.id, 'brief').autoAnswer, 'review');
  const answers = studioAnswers(ctx, st.id, 'brief');
  assert.equal(answers.length, 4);
  assert.deepEqual(answers.map((a) => a.round), [1, 1, 2, 2]);
  assert.equal(answers[0]!.answer, 'iPhone');
  assert.equal(answers[1]!.answer, 'guess for Describe your typical run');
  const msgs = studioMessages(ctx, st.id, 'brief');
  assert.deepEqual(msgs.filter((m) => m.role === 'standin').length, 2);
  assert.match(msgs.find((m) => m.role === 'standin')!.text, /^Answers to your questions:\n\n> Which platforms\?\niPhone/);
  assert.match(msgs.at(-1)!.text, /Answered 2 rounds for you\. The agent has no more questions\./);
  // the stand-in saw the owner's words; the phase agent was told the answers come from a stand-in
  assert.match(readFileSync(join(studioWork(ctx, st.id), '..', 'args-standin-brief'), 'utf8'), /I want a running app[\s\S]*> Which platforms\?\niPhone/);
  assert.match(readFileSync(join(studioWork(ctx, st.id), '..', 'args-brief'), 'utf8'), /stand-in for the owner/);

  // edits go to the phase agent and end the review
  const r = reviewAnswers(ctx, st.id, 'brief', [{ id: answers[0]!.id, answer: 'iPhone + web' }, { id: answers[1]!.id, answer: answers[1]!.answer }]);
  assert.equal(r.approved, false);
  assert.match(r.message!, /changed these[\s\S]*> Which platforms\?\niPhone \+ web\n\(was: iPhone\)/);
  assert.doesNotMatch(r.message!, /typical run/);
  assert.equal(studioAnswers(ctx, st.id, 'brief')[0]!.edited, true);
  assert.equal(phaseRow(ctx, st.id, 'brief').autoAnswer, null);
  assert.throws(() => reviewAnswers(ctx, st.id, 'brief', []), /no answers to review/);

  // a second skip with nothing open is refused; with questions and no edits, the review approves and names the next phase
  await assert.rejects(autoInterview(ctx, st.id, 'brief'), /no open questions/);
  mode(st.id, 'brief', 'interview');
  await studioTurn(ctx, st.id, 'brief', 'one more thing');
  mode(st.id, 'brief', 'done');
  await autoInterview(ctx, st.id, 'brief');
  assert.deepEqual(latestAnswers(ctx, st.id, 'brief').map((a) => a.batch), [2, 2]);
  assert.deepEqual(studioWaits(ctx).map((w) => [w.studio, w.phase, w.kind, w.count]), [['Run', 'brief', 'review', 2]]);
  assert.match(notes.at(-1)![1], /Brief answers are ready for your review \(1 round\)/);
  const ok = reviewAnswers(ctx, st.id, 'brief', []);
  assert.deepEqual(ok, { message: null, approved: true, next: { phase: 'research', state: 'ready' } });
  assert.equal(states(st.id).brief, 'approved');
});

test('studio skip: stops after the round cap, when the owner takes over, and when the stand-in fails', async () => {
  const { ctx, mode } = setup();
  const st = createStudio(ctx, { title: 'Run', mode: 'guided' });
  mode(st.id, 'brief', 'endless');
  await studioTurn(ctx, st.id, 'brief', 'go');
  await autoInterview(ctx, st.id, 'brief');
  assert.equal(new Set(studioAnswers(ctx, st.id, 'brief').map((a) => a.round)).size, MAX_STANDIN_ROUNDS);
  assert.match(studioMessages(ctx, st.id, 'brief').at(-1)!.text, /stopped after 6 rounds with 2 questions still open/);

  const b = createStudio(ctx, { title: 'B', mode: 'guided' });
  mode(b.id, 'brief', 'endless');
  await studioTurn(ctx, b.id, 'brief', 'go');
  const run = autoInterview(ctx, b.id, 'brief');
  stopAutoInterview(ctx, b.id, 'brief');
  await run;
  assert.equal(phaseRow(ctx, b.id, 'brief').autoAnswer, null);
  assert.ok(studioAnswers(ctx, b.id, 'brief').length <= 2);

  const c = createStudio(ctx, { title: 'C', mode: 'guided' });
  mode(c.id, 'brief', 'interview');
  await studioTurn(ctx, c.id, 'brief', 'go');
  mode(c.id, 'brief', 'standin-fail');
  await autoInterview(ctx, c.id, 'brief');
  assert.equal(phaseRow(ctx, c.id, 'brief').autoAnswer, null);
  assert.equal(phaseRow(ctx, c.id, 'brief').state, 'drafting');
  assert.match(studioMessages(ctx, c.id, 'brief').at(-1)!.text, /Couldn't answer for you: the stand-in wrote no answers/);
});
