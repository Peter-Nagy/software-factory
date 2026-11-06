import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFactoryConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { Bot, localParts, questionButtons, renderQuestion, type BotContext, type Intake } from '../src/discord/bot.ts';
import { digestText } from '../src/discord/digest.ts';
import { Gateway, type SocketLike } from '../src/discord/gateway.ts';
import type { DiscordRest } from '../src/discord/rest.ts';
import type { GitHub } from '../src/github.ts';
import { taskFromIssue } from '../src/issues.ts';
import { answerQuestion, applyTimeouts, getQuestion, takeAnswersForTask } from '../src/questions.ts';
import { Secrets } from '../src/secrets.ts';

// ---------- gateway protocol ----------

class FakeSocket implements SocketLike {
  sent: { op: number; d: unknown }[] = [];
  closed: number | null = null;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closed = code ?? 1000;
  }
  server(p: object) {
    this.onmessage?.({ data: JSON.stringify(p) });
  }
}

function gateway() {
  const sockets: FakeSocket[] = [];
  const beats: (() => void)[] = [];
  const events: string[] = [];
  let fatal = '';
  const gw = new Gateway({
    token: 'tok',
    intents: 33281,
    onDispatch: (t) => events.push(t),
    onFatal: (r) => (fatal = r),
    socketFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    reconnectDelayMs: 0,
    setTimer: (fn) => (beats.push(fn), beats.length),
    clearTimer: () => undefined,
  });
  return { gw, sockets, beats, events, fatal: () => fatal };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('gateway: hello -> identify with intents, heartbeats carry the last sequence', () => {
  const { gw, sockets, beats, events } = gateway();
  gw.start();
  const s = sockets[0]!;
  s.server({ op: 10, d: { heartbeat_interval: 41250 } });
  assert.deepEqual(s.sent[0], { op: 2, d: { token: 'tok', intents: 33281, properties: { os: 'darwin', browser: 'software-factory', device: 'software-factory' } } });
  s.server({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess', resume_gateway_url: 'wss://resume.example' } });
  s.server({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: {} });
  beats[0]!();
  assert.deepEqual(s.sent.at(-1), { op: 1, d: 2 });
  assert.deepEqual(events, ['READY', 'MESSAGE_CREATE']);
});

test('gateway: a dropped connection resumes the session at the resume URL', async () => {
  const { gw, sockets } = gateway();
  gw.start();
  sockets[0]!.server({ op: 10, d: { heartbeat_interval: 1000 } });
  sockets[0]!.server({ op: 0, t: 'READY', s: 5, d: { session_id: 'sess', resume_gateway_url: 'wss://resume.example' } });
  sockets[0]!.onclose?.({ code: 1006 });
  await tick();
  const s2 = sockets[1]!;
  assert.match(s2.url, /^wss:\/\/resume\.example/);
  s2.server({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.deepEqual(s2.sent[0], { op: 6, d: { token: 'tok', session_id: 'sess', seq: 5 } });
});

test('gateway: missed heartbeat ack reconnects; invalid session re-identifies; bad token is fatal', async () => {
  const g = gateway();
  g.gw.start();
  g.sockets[0]!.server({ op: 10, d: { heartbeat_interval: 1000 } });
  g.sockets[0]!.server({ op: 0, t: 'READY', s: 1, d: { session_id: 's', resume_gateway_url: 'wss://r' } });
  g.beats[0]!(); // sends heartbeat, now waiting for ack
  g.beats[0]!(); // no ack came: zombie
  await tick();
  assert.equal(g.sockets.length, 2);
  g.sockets[1]!.server({ op: 9, d: false }); // invalid, not resumable
  await tick();
  g.sockets[2]!.server({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.equal(g.sockets[2]!.sent[0]!.op, 2);
  g.sockets[2]!.onclose?.({ code: 4004, reason: 'Authentication failed' });
  await tick();
  assert.equal(g.sockets.length, 3);
  assert.match(g.fatal(), /4004/);
});

// ---------- questions ----------

function ctx() {
  const store = new Store(':memory:');
  const config = parseFactoryConfig('github: {owner: me}\ndiscord: {guildId: "1", ownerUserId: "42"}');
  store.upsertProject({ id: 'app', owner: 'me', kind: 'web-app', state: 'active', priority: 3, createdAt: 1 });
  let now = 1_800_000_000;
  const issues: { title: string; body: string; labels: string[] }[] = [];
  const gh = { createIssue: async (_o: string, _r: string, p: (typeof issues)[number]) => (issues.push(p), { number: 9, html_url: 'https://github.com/me/app/issues/9' }) } as unknown as GitHub;
  const c: BotContext = {
    config, store, secrets: new Secrets({ reader: async () => 'x' }),
    repoAccess: async () => ({ gh, token: '' }), repoClient: async () => ({ gh, token: '' }),
    now: () => now, notify: async () => undefined,
  };
  const ask = (kind: 'product' | 'migration', taskId: string, options: string[], def: string, timeoutIn = 3600) => {
    const r = store.db
      .prepare('INSERT INTO questions (kind, task_id, project_id, question, options, default_option, asked_at, timeout_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(kind, taskId, 'app', 'Which colour?', JSON.stringify(options), def, now, now + timeoutIn);
    return Number(r.lastInsertRowid);
  };
  const blockedTask = (n: number) => {
    store.upsertTask(taskFromIssue('app', 3, { number: n, title: `Task ${n}`, body: null, labels: [] }));
    store.transition(`app#${n}`, 'building', { sessionId: 'sess', attempt: 1 });
    store.transition(`app#${n}`, 'blocked', { pendingMode: 'resume' });
  };
  return { c, store, ask, blockedTask, issues, advance: (s: number) => (now += s) };
}

test('answering a product question resumes the task, and the agent gets the answer once', () => {
  const { c, store, ask, blockedTask } = ctx();
  blockedTask(1);
  const q = ask('product', 'app#1', ['blue', 'green'], 'blue');
  const r = answerQuestion(c, q, 'green', 'owner');
  assert.deepEqual(r, { ok: true, effect: 'app#1 continues with your answer' });
  const t = store.task('app#1')!;
  assert.equal(t.state, 'queued');
  assert.equal(t.pendingMode, 'resume');
  assert.equal(t.sessionId, 'sess');
  assert.match(takeAnswersForTask(c, 'app#1')!, /Which colour\?\nAnswer from the owner: green/);
  assert.equal(takeAnswersForTask(c, 'app#1'), null);
  assert.equal(answerQuestion(c, q, 'blue', 'owner').ok, false); // already answered
});

test('a task with two open questions waits for both', () => {
  const { c, store, ask, blockedTask } = ctx();
  blockedTask(2);
  const a = ask('product', 'app#2', ['x'], 'x');
  const b = ask('product', 'app#2', ['y'], 'y');
  answerQuestion(c, a, 'x', 'owner');
  assert.equal(store.task('app#2')!.state, 'blocked');
  answerQuestion(c, b, 'y', 'owner');
  assert.equal(store.task('app#2')!.state, 'queued');
});

test('timeouts apply the default; a migration approval times out as reject', () => {
  const { c, store, ask, blockedTask, advance } = ctx();
  blockedTask(3);
  const product = ask('product', 'app#3', ['blue', 'green'], 'green', 60);
  store.upsertTask(taskFromIssue('app', 3, { number: 4, title: 'Drop column', body: null, labels: [] }));
  store.transition('app#4', 'building');
  store.transition('app#4', 'in_review');
  store.transition('app#4', 'blocked');
  store.setSetting('pendingApproval:app#4', 'patch');
  const migration = ask('migration', 'app#4', ['approve', 'reject'], 'approve', 60); // even a wrong default never approves
  assert.equal(applyTimeouts(c).length, 0);
  advance(120);
  const applied = applyTimeouts(c);
  assert.deepEqual(applied.map((a) => [a.id, a.answer]), [[product, 'green'], [migration, 'reject']]);
  assert.equal(getQuestion(c, product)!.answeredBy, 'timeout');
  assert.equal(store.task('app#3')!.state, 'queued');
  assert.equal(store.task('app#4')!.state, 'parked');
  assert.match(takeAnswersForTask(c, 'app#3')!, /no reply in time/);
});

test('approving a migration sends the task back to review', () => {
  const { c, store, ask } = ctx();
  store.upsertTask(taskFromIssue('app', 3, { number: 5, title: 'Drop column', body: null, labels: [] }));
  store.transition('app#5', 'building');
  store.transition('app#5', 'in_review');
  store.transition('app#5', 'blocked');
  store.setSetting('pendingApproval:app#5', 'patch-1');
  const q = ask('migration', 'app#5', ['approve', 'reject'], 'reject');
  assert.equal(answerQuestion(c, q, 'maybe', 'owner').ok, false);
  assert.equal(answerQuestion(c, q, 'approve', 'owner').ok, true);
  assert.equal(store.task('app#5')!.state, 'in_review');
  assert.equal(store.getSetting('approvedMigration:app#5'), 'patch-1');
});

// ---------- bot ----------

function bot(intakeResult: Intake | null = null) {
  const h = ctx();
  const calls: { method: string; args: unknown[] }[] = [];
  const rest = new Proxy({}, {
    get: (_t, method: string) => async (...args: unknown[]) => {
      calls.push({ method, args });
      if (method === 'application') return { id: 'app-id' };
      if (method === 'guildChannels') return [{ id: 'c-inbox', name: 'inbox', type: 0 }];
      if (method === 'createTextChannel') return { id: `c-${args[1]}` };
      if (method === 'send') return { id: `m-${calls.length}` };
      return undefined;
    },
  }) as unknown as DiscordRest;
  const b = new Bot({ ctx: h.c, rest, guildId: '1', ownerUserId: '42', intake: async () => intakeResult });
  return { ...h, b, calls, last: (m: string) => calls.filter((x) => x.method === m).at(-1)?.args };
}

test('bot: creates only missing channels', async () => {
  const { b, calls } = bot();
  await b.ensureChannels();
  assert.deepEqual(calls.filter((c) => c.method === 'createTextChannel').map((c) => c.args[1]), ['questions', 'approvals', 'alerts', 'digest']);
  assert.equal(b.channels.get('inbox'), 'c-inbox');
});

test('bot: only the owner can use commands; others are refused and ignored', async () => {
  const { b, store, last } = bot();
  await b.ensureChannels();
  await b.dispatch('INTERACTION_CREATE', { id: 'i1', token: 't', type: 2, member: { user: { id: '7' } }, data: { name: 'pause', options: [{ name: 'hours', value: 2 }] } });
  assert.match(String((last('respond')![3] as { content: string }).content), /Only the factory owner/);
  assert.equal(store.getSetting('pausedUntil'), null);
  await b.dispatch('INTERACTION_CREATE', { id: 'i2', token: 't', type: 2, member: { user: { id: '42' } }, data: { name: 'pause', options: [{ name: 'hours', value: 2 }] } });
  assert.equal(store.getSetting('pausedUntil'), String(1_800_000_000 + 7200));
  // messages from someone else in #inbox are ignored entirely
  const before = store.db.prepare('SELECT COUNT(*) AS n FROM ideas').get() as { n: number };
  await b.dispatch('MESSAGE_CREATE', { id: 'm', channel_id: 'c-inbox', content: 'make me an app', author: { id: '7' } });
  assert.deepEqual(store.db.prepare('SELECT COUNT(*) AS n FROM ideas').get(), before);
});

test('bot: a tapped button answers the question and replaces the buttons', async () => {
  const { b, store, ask, blockedTask, last } = bot();
  await b.ensureChannels();
  blockedTask(6);
  const q = ask('product', 'app#6', ['blue', 'green'], 'blue');
  await b.dispatch('INTERACTION_CREATE', { id: 'i', token: 't', type: 3, member: { user: { id: '42' } }, data: { custom_id: `q:${q}:1` } });
  const [, , type, data] = last('respond')! as [string, string, number, { content: string; components: unknown[] }];
  assert.equal(type, 7);
  assert.deepEqual(data.components, []);
  assert.match(data.content, /Answered: green/);
  assert.equal(store.task('app#6')!.state, 'queued');
});

test('bot: tick posts new questions with buttons once, and sends the digest once a day', async () => {
  const { b, ask, blockedTask, calls, advance } = bot();
  await b.ensureChannels();
  blockedTask(7);
  ask('product', 'app#7', ['blue', 'green'], 'green');
  await b.tick(1_800_000_000, 'Europe/Budapest', 8);
  await b.tick(1_800_000_000, 'Europe/Budapest', 8);
  const sends = calls.filter((c) => c.method === 'send');
  const toQuestions = sends.filter((c) => c.args[0] === 'c-questions');
  assert.equal(toQuestions.length, 1);
  assert.equal(((toQuestions[0]!.args[1] as { components: { components: unknown[] }[] }).components[0]!.components.length), 2);
  assert.equal(sends.filter((c) => c.args[0] === 'c-digest').length, 1); // 1_800_000_000 is 09:20 in Budapest
  advance(86400);
  await b.tick(1_800_086_400, 'Europe/Budapest', 8);
  assert.equal(calls.filter((c) => c.method === 'send' && c.args[0] === 'c-digest').length, 2);
});

test('bot: #inbox messages become issues, answers or saved ideas', async () => {
  const t = bot({ kind: 'task', project: 'app', title: 'Dark mode', body: 'Add dark mode.\n\n## Acceptance criteria\n- [ ] toggles' });
  await t.b.ensureChannels();
  await t.b.dispatch('MESSAGE_CREATE', { id: 'm1', channel_id: 'c-inbox', content: 'add dark mode to app', author: { id: '42' } });
  assert.deepEqual(t.issues[0]!.labels, ['factory:ready', 'size:m']);
  assert.equal(t.issues[0]!.title, 'Dark mode');
  assert.match(String((t.last('send')![1] as { content: string }).content), /Created app#9/);

  const i = bot({ kind: 'new_project', name: 'Habit Tracker!', idea: 'track habits' });
  await i.b.ensureChannels();
  await i.b.dispatch('MESSAGE_CREATE', { id: 'm2', channel_id: 'c-inbox', content: 'idea: habit tracker', author: { id: '42' } });
  assert.deepEqual({ ...(i.store.db.prepare('SELECT name, text FROM ideas').get() as object) }, { name: 'habit-tracker', text: 'track habits' });

  const u = bot({ kind: 'task', project: 'nope' });
  await u.b.ensureChannels();
  await u.b.dispatch('MESSAGE_CREATE', { id: 'm3', channel_id: 'c-inbox', content: 'do x', author: { id: '42' } });
  assert.match(String((u.last('send')![1] as { content: string }).content), /Which project/);
  assert.equal(u.issues.length, 0);
});

test('rendering: buttons, question text, local time, digest', () => {
  const { c, store, ask, blockedTask } = ctx();
  blockedTask(8);
  const q = getQuestion(c, ask('migration', 'app#8', ['approve', 'reject'], 'reject'))!;
  assert.deepEqual(questionButtons(q)[0]!.components.map((x) => [x.label, x.style]), [['approve', 3], ['reject', 4]]);
  assert.match(renderQuestion(q, 'Europe/Budapest'), /Approval needed[\s\S]*means \*\*reject\*\*/);
  assert.deepEqual(localParts(1_800_000_000, 'Europe/Budapest'), { date: '2027-01-15', hour: 9 });
  store.db.prepare(`INSERT INTO runs (task_id, role, model, started_at, cost_usd) VALUES ('app#8', 'implementer', 'sonnet', ?, 0.25)`).run(1_800_000_000 - 100);
  const text = digestText(store, 1_800_000_000, 'Europe/Budapest');
  assert.match(text, /Factory digest[\s\S]*1 question\(s\) waiting[\s\S]*1 waiting on you[\s\S]*implementer\/sonnet ×1 \$0\.25/);
});
