import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDue, listBackups, prune, runBackup } from '../src/backup.ts';
import { parseFactoryConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';

function setup(extra = '') {
  const root = mkdtempSync(join(tmpdir(), 'factory-backup-'));
  mkdirSync(join(root, 'state', 'studios', '1', 'work', 'docs'), { recursive: true });
  writeFileSync(join(root, 'state', 'studios', '1', 'work', 'docs', 'BRIEF.md'), '# Brief\n');
  const store = new Store(join(root, 'state', 'factory.db'));
  store.upsertProject({ id: 'app', owner: 'me', kind: 'cli', state: 'active', priority: 3, createdAt: 1 });
  writeFileSync(join(root, 'factory.config.yaml'), 'github: {owner: me}\n');
  const config = parseFactoryConfig(`github: {owner: me}\npaths: {state: ${root}/state}\nbackup: {dir: ${root}/backups, keep: 2${extra}}`);
  return { root, store, config };
}

test('backup: a consistent database copy, the rest of the state and the config, in one folder per run', async () => {
  const s = setup();
  const cfg = parseFactoryConfig(`github: {owner: me}\npaths: {state: ${s.root}/state}\nbackup: {dir: ${s.root}/backups, keep: 2, copyTo: [${s.root}/icloud]}`);
  const b = await runBackup(s.store, cfg, 1_794_000_000, join(s.root, 'factory.config.yaml'));
  assert.equal(b.path, join(s.root, 'backups', '20261106T212000Z'));
  assert.deepEqual(readdirSync(b.path).sort(), ['factory.config.yaml', 'factory.db', 'state.tar.gz']);
  const copy = new DatabaseSync(join(b.path, 'factory.db'), { readOnly: true });
  assert.equal((copy.prepare("SELECT id FROM projects").get() as { id: string }).id, 'app');
  copy.close();
  const listing = execFileSync('tar', ['-tzf', join(b.path, 'state.tar.gz')], { encoding: 'utf8' });
  assert.match(listing, /studios\/1\/work\/docs\/BRIEF\.md/);
  assert.doesNotMatch(listing, /factory\.db/);
  assert.deepEqual(b.copies, [join(s.root, 'icloud', '20261106T212000Z')]);
  assert.ok(existsSync(join(s.root, 'icloud', '20261106T212000Z', 'factory.db')));
  // keep: 2 — the oldest goes, here and in the copy
  await runBackup(s.store, cfg, 1_794_086_400, undefined);
  await runBackup(s.store, cfg, 1_794_172_800, undefined);
  assert.deepEqual(listBackups(cfg).map((x) => x.name), ['20261108T212000Z', '20261107T212000Z']);
  assert.deepEqual(readdirSync(join(s.root, 'icloud')).sort(), ['20261107T212000Z', '20261108T212000Z']);
  s.store.close();
});

test('backup: nothing half-written is left behind when it fails; stale partial folders are pruned', async () => {
  const { root, store, config } = setup();
  store.close(); // the copy fails: the database is closed
  await assert.rejects(runBackup(store, config, 1_794_000_000));
  assert.deepEqual(readdirSync(join(root, 'backups')), []);
  mkdirSync(join(root, 'backups', '.20200101T000000Z.partial'));
  execFileSync('touch', ['-t', '202001010000', join(root, 'backups', '.20200101T000000Z.partial')]);
  prune(join(root, 'backups'), 2);
  assert.deepEqual(readdirSync(join(root, 'backups')), []);
});

test('backup: due once a day at the configured hour, or when the last one is over a day old', () => {
  assert.equal(backupDue(null, 1000, 12, 3), true);
  assert.equal(backupDue(1000, 1000 + 3600, 4, 3), false); // ran an hour ago
  assert.equal(backupDue(1000, 1000 + 21 * 3600, 2, 3), false); // before the hour
  assert.equal(backupDue(1000, 1000 + 21 * 3600, 3, 3), true);
  assert.equal(backupDue(1000, 1000 + 27 * 3600, 1, 3), true); // missed: overdue
});
