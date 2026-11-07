import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type { FactoryConfig } from './config.ts';
import type { Store } from './db.ts';

const run = promisify(execFile);

/** A backup is one folder per day: a consistent copy of the database, the rest of the state, and the config. */
export interface BackupResult {
  path: string;
  bytes: number;
  copies: string[];
}

const stamp = (epoch: number) => new Date(epoch * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); // 20261107T031500Z

/**
 * Back up the factory's state into `<dir>/<stamp>/`:
 *  - factory.db: `VACUUM INTO` gives a consistent copy while the orchestrator keeps writing; checked with integrity_check
 *  - state.tar.gz: plans, studios and agent sessions (everything in the state folder but the live database files)
 *  - factory.config.yaml (it holds no secrets: those live in 1Password)
 * Written to a temporary folder and renamed when complete, so a crash never leaves a half backup that looks whole.
 * Then copied to each extra directory (e.g. iCloud Drive), and old backups beyond `keep` are deleted everywhere.
 */
export async function runBackup(store: Store, config: FactoryConfig, now: number, configPath?: string): Promise<BackupResult> {
  const dir = config.backup.dir;
  mkdirSync(dir, { recursive: true });
  const name = stamp(now);
  const tmp = join(dir, `.${name}.partial`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  try {
    const db = join(tmp, 'factory.db');
    store.db.exec(`VACUUM INTO '${db.replace(/'/g, "''")}'`);
    const copy = new DatabaseSync(db, { readOnly: true });
    try {
      const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error(`integrity check of the copy failed: ${check.integrity_check}`);
    } finally {
      copy.close();
    }
    const state = config.paths.state;
    if (existsSync(state)) {
      const entries = readdirSync(state).filter((n) => !/^factory\.db(-wal|-shm|-journal)?$/.test(n));
      if (entries.length) await run('tar', ['-czf', join(tmp, 'state.tar.gz'), '-C', state, ...entries]);
    }
    if (configPath && existsSync(configPath)) await run('cp', [configPath, join(tmp, 'factory.config.yaml')]);
    const final = join(dir, name);
    rmSync(final, { recursive: true, force: true });
    renameSync(tmp, final);
    const copies: string[] = [];
    for (const extra of config.backup.copyTo) {
      mkdirSync(extra, { recursive: true });
      await run('cp', ['-R', final, join(extra, name)]);
      copies.push(join(extra, name));
      prune(extra, config.backup.keep);
    }
    prune(dir, config.backup.keep);
    return { path: final, bytes: folderBytes(final), copies };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** Keep the newest `keep` complete backups in `dir`; partial folders older than a day go too. */
export function prune(dir: string, keep: number): string[] {
  if (!existsSync(dir)) return [];
  const all = readdirSync(dir).filter((n) => /^\d{8}T\d{6}Z$/.test(n)).sort();
  const gone = all.slice(0, Math.max(0, all.length - keep));
  for (const n of gone) rmSync(join(dir, n), { recursive: true, force: true });
  for (const n of readdirSync(dir).filter((x) => x.endsWith('.partial'))) {
    const p = join(dir, n);
    if (Date.now() - statSync(p).mtimeMs > 86_400_000) rmSync(p, { recursive: true, force: true });
  }
  return gone;
}

function folderBytes(p: string): number {
  return readdirSync(p).reduce((t, n) => t + statSync(join(p, n)).size, 0);
}

/** Due once a day, at or after the configured local hour (and right away if the last one is over a day old). */
export function backupDue(lastAt: number | null, now: number, localHour: number, backupHour: number): boolean {
  if (lastAt === null) return true;
  if (now - lastAt >= 26 * 3600) return true;
  return localHour >= backupHour && now - lastAt >= 20 * 3600;
}

/** The newest backups, for the dashboard and `factory backup --list`. */
export function listBackups(config: FactoryConfig): { name: string; bytes: number }[] {
  const dir = config.backup.dir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^\d{8}T\d{6}Z$/.test(n))
    .sort()
    .reverse()
    .map((n) => ({ name: n, bytes: folderBytes(join(dir, n)) }));
}

