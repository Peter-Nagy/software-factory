import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFactoryConfig, parseProjectConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { checkMigrations, globToRegExp, scanMigration } from '../src/gates/migration-check.ts';
import { appJwt, GitHub } from '../src/github.ts';
import { taskFromIssue } from '../src/issues.ts';
import { changedFiles, diffSize, hasUnpushedCommits, prepareCheckout } from '../src/runner/worktree.ts';
import { Secrets } from '../src/secrets.ts';
import { InvalidTransitionError } from '../src/tasks.ts';

test('factory config: defaults fill in, ~ expands, bad values are rejected', () => {
  const c = parseFactoryConfig('github:\n  owner: Peter-Nagy\n');
  assert.equal(c.governor.maxParallel, 6);
  assert.equal(c.questions.defaultTimeoutHours, 24);
  assert.ok(!c.paths.state.startsWith('~'));
  assert.throws(() => parseFactoryConfig('github: {owner: x}\ngovernor: {anyMaxFiveHourPct: 150}'));
  const p = parseProjectConfig('kind: service\nsecrets: [DATABASE_URL]\ndeploy: {adapter: mac-docker}');
  assert.equal(p.deploy.adapter, 'mac-docker');
  assert.throws(() => parseProjectConfig('kind: service\nsecrets: ["lower-case"]'));
});

test('issues become tasks: labels, dependencies, size and risk', () => {
  const t = taskFromIssue('app', 3, {
    number: 14,
    title: 'Password reset',
    body: 'Some text\n- Depends on #12, #13\nnot a dependency #99',
    labels: [{ name: 'factory:ready' }, { name: 'priority:5' }, { name: 'risk:high' }, { name: 'area:auth' }, { name: 'size:l' }, { name: 'split-on-fail' }],
  });
  assert.equal(t.id, 'app#14');
  assert.equal(t.priority, 5);
  assert.equal(t.risk, 'high');
  assert.equal(t.area, 'auth');
  assert.deepEqual(t.dependsOn, ['app#12', 'app#13']);
  assert.equal(t.estimatedCostPct, 24);
  assert.equal(t.splitOnFail, true);
  const plain = taskFromIssue('app', 2, { number: 1, title: 'x', body: null, labels: [] });
  assert.equal(plain.priority, 2);
  assert.equal(plain.risk, 'medium');
});

test('destructive migration check', () => {
  const sql = [
    'CREATE TABLE users (id int);',
    'ALTER TABLE users DROP COLUMN email;',
    '-- DROP TABLE commented_out;',
    'DELETE FROM sessions;',
    'DELETE FROM tokens WHERE expired = true;',
    'ALTER TABLE users RENAME COLUMN name TO full_name;',
  ].join('\n');
  const rules = scanMigration('db/migrations/002.sql', sql).map((f) => `${f.rule}@${f.line}`);
  assert.deepEqual(rules.sort(), ['delete-without-where@4', 'drop-column@2', 'rename-column-or-table@6'].sort());
  assert.deepEqual(scanMigration('m.sql', 'CREATE TABLE a (id int);\nALTER TABLE a ADD COLUMN b text;'), []);
  assert.equal(scanMigration('m.ts', 'await db.schema.dropTable("x")').length, 1);
  assert.ok(globToRegExp('**/migrations/**').test('apps/web/migrations/0001_init.sql'));
  assert.ok(globToRegExp('**/*.sql').test('schema.sql'));
  const found = checkMigrations([{ path: 'src/app.ts', content: 'DROP TABLE x' }, { path: 'drizzle/0003.sql', content: 'TRUNCATE logs;' }], ['**/drizzle/**']);
  assert.deepEqual(found.map((f) => f.rule), ['truncate']);
});

test('store: tasks, validated transitions, usage and settings', () => {
  const s = new Store(':memory:');
  s.upsertProject({ id: 'app', owner: 'me', kind: 'web-app', state: 'active', priority: 3, createdAt: 1 });
  s.upsertTask(taskFromIssue('app', 3, { number: 1, title: 'First', body: null, labels: [] }));
  const moved = s.transition('app#1', 'building', { attempt: 1, branch: 'claude/1-first' });
  assert.equal(moved.state, 'building');
  assert.throws(() => s.transition('app#1', 'done'), InvalidTransitionError);
  // A re-sync of the issue refreshes fields but keeps state.
  s.upsertTask({ ...taskFromIssue('app', 3, { number: 1, title: 'First (renamed)', body: null, labels: [] }) });
  assert.equal(s.task('app#1')!.state, 'building');
  assert.equal(s.task('app#1')!.title, 'First (renamed)');
  assert.equal(s.task('app#1')!.branch, 'claude/1-first');
  s.recordUsage({ fiveHourPct: 12, fiveHourResetsAt: 5, sevenDayPct: 3, sevenDayResetsAt: 6, source: 'stream', takenAt: 100 });
  assert.equal(s.latestUsage()!.fiveHourPct, 12);
  s.setSetting('pausedUntil', '123');
  assert.equal(s.getSetting('pausedUntil'), '123');
  s.setSetting('pausedUntil', null);
  assert.equal(s.getSetting('pausedUntil'), null);
  s.close();
});

test('GitHub App JWT is a valid RS256 token', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = appJwt('12345', privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), 1_800_000_000);
  const [h, p, sig] = jwt.split('.');
  const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
  assert.deepEqual(payload, { iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: '12345' });
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${p}`);
  assert.ok(v.verify(publicKey, Buffer.from(sig!, 'base64url')));
});

test('installation token request is scoped to one repo', async () => {
  let seen: { url: string; body: unknown } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ token: 'ghs_x', expires_at: '2026-11-06T13:00:00Z' }), { status: 201 });
  }) as unknown as typeof fetch;
  const r = await GitHub.installationToken({ appJwt: 'jwt', installationId: '77', repositories: ['app'], permissions: { contents: 'write' }, fetchImpl: fakeFetch });
  assert.equal(r.token, 'ghs_x');
  assert.equal(seen!.url, 'https://api.github.com/app/installations/77/access_tokens');
  assert.deepEqual(seen!.body, { repositories: ['app'], permissions: { contents: 'write' } });
});

test('secrets: 1Password references, validation and caching', async () => {
  const reads: string[] = [];
  const s = new Secrets({ reader: async (ref) => (reads.push(ref), 'value') });
  assert.equal(await s.get('VERCEL_TOKEN'), 'value');
  await s.get('VERCEL_TOKEN');
  assert.deepEqual(reads, ['op://Factory/VERCEL_TOKEN/credential']);
  await assert.rejects(s.get('../evil'));
});

test('checkout: clones, branches from main, resumes an existing remote branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-git-'));
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  g(root, 'init', '-q', '-b', 'main', seed);
  g(seed, 'config', 'user.email', 't@t');
  g(seed, 'config', 'user.name', 't');
  writeFileSync(join(seed, 'README.md'), 'hi\n');
  g(seed, 'add', '.');
  g(seed, 'commit', '-qm', 'init');
  g(seed, 'remote', 'add', 'origin', origin);
  g(seed, 'push', '-q', 'origin', 'main');

  const dir = join(root, 'work', 'app', '1');
  await prepareCheckout({ remoteUrl: origin, dir, branch: 'claude/1-x', token: null });
  assert.equal(g(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'claude/1-x');
  g(dir, 'config', 'user.email', 't@t');
  g(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-qm', 'work');
  assert.equal(await hasUnpushedCommits(dir, 'claude/1-x'), true);
  g(dir, 'push', '-q', '-u', 'origin', 'HEAD');
  assert.equal(await diffSize(dir), 2);
  assert.deepEqual(await changedFiles(dir), ['a.txt']);

  // A fresh checkout elsewhere resumes the pushed branch instead of starting from main.
  const dir2 = join(root, 'work', 'app', '1b');
  await prepareCheckout({ remoteUrl: origin, dir: dir2, branch: 'claude/1-x', token: null });
  assert.equal(g(dir2, 'log', '-1', '--format=%s'), 'work');
});
