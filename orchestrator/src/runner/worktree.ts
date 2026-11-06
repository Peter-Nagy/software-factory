import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Each task gets its own partial clone (no shared .git), so the container can mount exactly one directory
 * and git works inside it without host paths. Partial clones (--filter=blob:none) keep this fast.
 */

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** `-c` options that authenticate one git command with a token without writing it to .git/config. */
export function authConfig(token: string | null): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

export function checkoutPath(worktreesDir: string, projectId: string, taskSlug: string): string {
  return join(worktreesDir, projectId, taskSlug);
}

/**
 * Clone the repo into `dir` (if not already there) and check out `branch`.
 * An existing remote branch is resumed (after a checkpoint); otherwise the branch starts from origin/<base>.
 */
export async function prepareCheckout(opts: { remoteUrl: string; dir: string; branch: string; base?: string; token: string | null }): Promise<string> {
  const base = opts.base ?? 'main';
  const auth = authConfig(opts.token);
  if (!existsSync(join(opts.dir, '.git'))) {
    mkdirSync(dirname(opts.dir), { recursive: true });
    await exec('git', [...auth, 'clone', '--filter=blob:none', '--no-checkout', opts.remoteUrl, opts.dir]);
  }
  await git(opts.dir, ...auth, 'fetch', '--prune', 'origin');
  const remote = await git(opts.dir, 'branch', '-r', '--list', `origin/${opts.branch}`);
  await git(opts.dir, 'checkout', '-B', opts.branch, remote ? `origin/${opts.branch}` : `origin/${base}`);
  return opts.dir;
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

/** True if the branch has commits that origin/<branch> doesn't (agent committed but didn't push). */
export async function hasUnpushedCommits(dir: string, branch: string): Promise<boolean> {
  const remote = await git(dir, 'branch', '-r', '--list', `origin/${branch}`);
  const range = remote ? `origin/${branch}..HEAD` : `origin/main..HEAD`;
  return Number(await git(dir, 'rev-list', '--count', range)) > 0;
}
