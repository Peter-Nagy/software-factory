import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { RUN_DIR } from '../gates/contract.ts';

const exec = promisify(execFile);

/**
 * Each task gets its own clone (no shared .git), so the container mounts exactly one directory and git works inside it.
 * Host-side commands that reach GitHub authenticate through environment variables (GIT_CONFIG_*), never arguments:
 * arguments show up in `ps` and in error messages.
 */

export class GitError extends Error {}

/** Env that makes git send the token as an HTTP header for this one command. */
export function authEnv(token: string | null): Record<string, string> {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

/** Remove a token (raw or in its Basic-auth form) from text before it is logged, stored or shown to an agent. */
export function redact(text: string, token: string | null): string {
  if (!token) return text;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return text.split(token).join('[redacted]').split(basic).join('[redacted]');
}

/**
 * Checkouts under these roots are shared with the macOS runner user (same group): git runs there with umask 002
 * so the runner can write what the orchestrator checks out, and trusts repos owned by the other user.
 */
const sharedRoots: string[] = [];
export function shareWorktreesUnder(root: string): void {
  const r = root.endsWith('/') ? root : `${root}/`;
  if (!sharedRoots.includes(r)) sharedRoots.push(r);
}
export const isShared = (dir: string) => sharedRoots.some((r) => `${dir}/`.startsWith(r));

function configEnv(pairs: [string, string][]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

async function run(cwd: string, args: string[], token: string | null): Promise<string> {
  const shared = isShared(cwd);
  const pairs: [string, string][] = [];
  if (token) pairs.push(['http.extraHeader', authEnv(token).GIT_CONFIG_VALUE_0!]);
  if (shared) pairs.push(['safe.directory', '*'], ['core.sharedRepository', 'group']);
  try {
    const { stdout } = await exec(shared ? '/bin/sh' : 'git', shared ? ['-c', 'umask 002 && exec git "$@"', 'git', ...args] : args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(pairs.length ? configEnv(pairs) : {}) },
    });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; code?: number };
    // Rethrow without the command line or env; stderr is redacted in case a remote echoes credentials.
    throw new GitError(`git ${args[0]} failed (exit ${err.code ?? '?'}): ${redact(String(err.stderr ?? '').trim(), token).slice(0, 500)}`);
  }
}

/** Local git command (no network). */
export function git(cwd: string, ...args: string[]): Promise<string> {
  return run(cwd, args, null);
}

/** Git command that may reach the remote, authenticated with a repo-scoped token. */
export function gitRemote(cwd: string, token: string | null, ...args: string[]): Promise<string> {
  return run(cwd, args, token);
}

export function checkoutPath(worktreesDir: string, projectId: string, taskSlug: string): string {
  return join(worktreesDir, projectId, taskSlug);
}

/**
 * Clone the repo into `dir` (if needed) and put `branch` in a clean state for the next run:
 * - local commits that never reached origin are pushed first, so a reset never loses work
 * - an existing remote branch is resumed; otherwise the branch starts from origin/<base>
 * - uncommitted leftovers from an interrupted run are discarded (agents commit and push as they go)
 */
export async function prepareCheckout(opts: { remoteUrl: string; dir: string; branch: string; base?: string; token: string | null }): Promise<string> {
  const base = opts.base ?? 'main';
  const { dir, branch, token } = opts;
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dirname(dir), { recursive: true, mode: isShared(dir) ? 0o2775 : 0o777 });
    await gitRemote(dirname(dir), token, 'clone', '--no-checkout', opts.remoteUrl, dir);
  }
  await gitRemote(dir, token, 'fetch', '--prune', 'origin');

  const localExists = (await git(dir, 'branch', '--list', branch)) !== '';
  if (localExists && (await hasUnpushedCommits(dir, branch, base))) {
    await gitRemote(dir, token, 'push', 'origin', `${branch}:${branch}`);
    await gitRemote(dir, token, 'fetch', 'origin');
  }
  const remote = await git(dir, 'branch', '-r', '--list', `origin/${branch}`);
  await git(dir, 'checkout', '-f', '-B', branch, remote ? `origin/${branch}` : `origin/${base}`);
  excludeRunDir(dir);
  await git(dir, 'clean', '-fd', '-e', RUN_DIR);
  return dir;
}

/**
 * Keep the orchestrator's scratch dir out of git. Older checkouts excluded `.factory/`, which is now the
 * project's committed check contract, so that line is dropped.
 */
export function excludeRunDir(dir: string): void {
  const path = join(dir, '.git', 'info', 'exclude');
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const kept = lines.filter((l) => !['.factory', '.factory/'].includes(l.trim()));
  while (kept.length && kept.at(-1)!.trim() === '') kept.pop();
  if (!kept.some((l) => l.trim() === `${RUN_DIR}/`)) kept.push(`${RUN_DIR}/`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${kept.join('\n')}\n`);
}

export function removeCheckout(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Lines changed on the branch relative to origin/<base> (used to pick the reviewer model). */
export async function diffSize(dir: string, base = 'main'): Promise<number> {
  const out = await git(dir, 'diff', '--shortstat', `origin/${base}...HEAD`);
  const ins = Number(/(\d+) insertion/.exec(out)?.[1] ?? 0);
  const del = Number(/(\d+) deletion/.exec(out)?.[1] ?? 0);
  return ins + del;
}

export async function changedFiles(dir: string, base = 'main'): Promise<string[]> {
  const out = await git(dir, 'diff', '--name-only', `origin/${base}...HEAD`);
  return out ? out.split('\n') : [];
}

export async function headSha(dir: string): Promise<string> {
  return git(dir, 'rev-parse', 'HEAD');
}

/** True if local `branch` has commits that origin/<branch> (or origin/<base> for a new branch) doesn't. */
export async function hasUnpushedCommits(dir: string, branch: string, base = 'main'): Promise<boolean> {
  const remote = await git(dir, 'branch', '-r', '--list', `origin/${branch}`);
  const range = remote ? `origin/${branch}..${branch}` : `origin/${base}..${branch}`;
  return Number(await git(dir, 'rev-list', '--count', range)) > 0;
}

/**
 * Stable id of the branch's own change (independent of where it sits on main), so syncing with main doesn't
 * force a new review of an unchanged diff.
 */
export async function changePatchId(dir: string, base = 'main'): Promise<string> {
  const mergeBase = await git(dir, 'merge-base', `origin/${base}`, 'HEAD');
  const diff = await git(dir, 'diff', mergeBase, 'HEAD');
  if (!diff) return 'empty';
  const out = spawnSync('git', ['patch-id', '--stable'], { cwd: dir, input: diff + '\n', encoding: 'utf8' });
  return (out.stdout ?? '').split(' ')[0] || 'unknown';
}

/** True if origin/<base> is already contained in HEAD. */
export async function containsBase(dir: string, base = 'main'): Promise<boolean> {
  try {
    await git(dir, 'merge-base', '--is-ancestor', `origin/${base}`, 'HEAD');
    return true;
  } catch {
    return false;
  }
}
