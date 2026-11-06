import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { RepoCreator } from './plan.ts';
import { git, gitRemote } from './runner/worktree.ts';

const exec = promisify(execFile);

/**
 * New repos are created with the owner's own `gh` login on this Mac: a GitHub App can't create repos in a personal
 * account. Only the orchestrator does this, when the owner presses Execute; agents never see that token.
 * The App is installed on all repositories, so it can work in the new repo right away.
 */
export function ghRepoCreator(owner: string, topic: string): RepoCreator {
  return async ({ name, description, files }) => {
    const token = (await exec('gh', ['auth', 'token'])).stdout.trim();
    if (!token) throw new Error('gh is not logged in on this Mac (run: gh auth login)');
    const gh = (...args: string[]) => exec('gh', args, { env: { ...process.env, GH_TOKEN: token } });
    try {
      await gh('api', '-X', 'POST', 'user/repos', '-f', `name=${name}`, '-F', 'private=true', '-f', `description=${description.slice(0, 300)}`, '-F', 'has_wiki=false');
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message);
      throw new Error(/already exists/i.test(msg) ? `A repo called ${owner}/${name} already exists on GitHub.` : `Creating the repo failed: ${msg.slice(0, 300)}`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'factory-new-repo-'));
    try {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      await git(dir, 'init', '-q', '-b', 'main');
      await git(dir, 'add', '-A');
      await git(dir, '-c', 'user.name=factory-bot', '-c', 'user.email=factory-bot@users.noreply.github.com', 'commit', '-qm', 'Start project from the factory plan');
      await gitRemote(dir, token, 'push', `https://github.com/${owner}/${name}.git`, 'main:main');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await gh('api', '-X', 'PUT', `repos/${owner}/${name}/topics`, '-f', `names[]=${topic}`);
    return { owner, name };
  };
}
