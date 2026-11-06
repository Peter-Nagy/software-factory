import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFactoryConfig, type FactoryConfig } from './config.ts';
import { Store } from './db.ts';
import { appJwt, GitHub, WORKER_PERMISSIONS, type RepoPermissions } from './github.ts';
import { taskFromIssue } from './issues.ts';
import type { PipelineContext } from './pipeline.ts';
import { killLeftoverContainers } from './runner/container.ts';
import { Secrets } from './secrets.ts';
import type { Project } from './types.ts';

export interface App extends PipelineContext {
  config: FactoryConfig;
  store: Store;
  secrets: Secrets;
  repoClient(project: Project, permissions?: RepoPermissions): Promise<{ gh: GitHub; token: string }>;
}

export async function createApp(config: FactoryConfig = loadFactoryConfig()): Promise<App> {
  mkdirSync(config.paths.state, { recursive: true });
  mkdirSync(config.paths.logs, { recursive: true });
  const store = new Store(join(config.paths.state, 'factory.db'));
  const secrets = new Secrets();

  let privateKey: string | null = null;
  const loadKey = async () => {
    if (privateKey) return privateKey;
    const ref = config.github.appPrivateKey;
    if (!ref) throw new Error('github.appPrivateKey is not set in factory.config.yaml');
    // Either a secret name in the 1Password Factory vault (e.g. GITHUB_APP_PRIVATE_KEY) or a file path.
    privateKey = /^[A-Z][A-Z0-9_]*$/.test(ref) ? await secrets.get(ref) : readFileSync(ref, 'utf8');
    return privateKey;
  };

  const repoClient = async (project: Project, permissions: RepoPermissions = WORKER_PERMISSIONS) => {
    const { appId, installationId } = config.github;
    if (!appId || !installationId) throw new Error('github.appId and github.installationId must be set');
    const { token } = await GitHub.installationToken({
      appJwt: appJwt(appId, await loadKey()),
      installationId,
      repositories: [project.id],
      permissions,
    });
    return { gh: new GitHub(token), token };
  };

  return {
    config,
    store,
    secrets,
    repoClient,
    repoAccess: (project, permissions) => repoClient(project, permissions),
    now: () => Math.floor(Date.now() / 1000),
    // Discord arrives in M4; until then notifications are events + stdout (visible in the launchd log).
    notify: async (kind, text) => {
      store.event(`notify.${kind}`, null, { text });
      console.log(`[${kind}] ${text}`);
    },
  };
}

/** Pull open `factory:ready` issues of every active project into the task table. */
export async function syncIssues(app: App): Promise<number> {
  let count = 0;
  for (const project of app.store.projects().filter((p) => p.state === 'active')) {
    try {
      const { gh } = await app.repoClient(project, { issues: 'read', metadata: 'read' });
      for (const issue of await gh.readyIssues(project.owner, project.id)) {
        app.store.upsertTask(taskFromIssue(project.id, project.priority, issue));
        count++;
      }
    } catch (e) {
      console.error(`Issue sync failed for ${project.id}: ${(e as Error).message}`);
    }
  }
  return count;
}

/**
 * On startup: remove containers a previous process left running (so two agents never share a checkout),
 * then put interrupted runs back in the queue. They continue their attempt and session; nothing is charged to the ladder.
 */
export function recoverInterrupted(app: App): string[] {
  killLeftoverContainers();
  const recovered: string[] = [];
  for (const t of app.store.openTasks()) {
    if (t.state === 'building' || t.state === 'fixing') {
      app.store.transition(t.id, 'queued', {
        pendingMode: 'resume',
        fixRounds: t.state === 'fixing' ? Math.max(t.fixRounds - 1, 0) : t.fixRounds,
      });
      recovered.push(t.id);
    }
    if (t.state === 'merging') {
      app.store.transition(t.id, 'in_review'); // the merge is guarded by sha, so checking again is safe
      recovered.push(t.id);
    }
  }
  return recovered;
}
