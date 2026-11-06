// S0-4: can the factory-bot GitHub App mint a token that reaches exactly one repo?
// Env: GH_APP_ID, GH_APP_KEY_FILE, GH_INSTALLATION_ID, GH_OWNER, GH_REPO (a factory repo), GH_OTHER_REPO (any other repo you own)
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appJwt, GitHub, WORKER_PERMISSIONS } from '../orchestrator/src/github.ts';

const summary = join(import.meta.dirname, 'results', 'summary.md');
const NAME = 'S0-4 GitHub App scoped token';
const report = (status: string, detail: string) => {
  appendFileSync(summary, `- **${NAME}**: ${status} - ${detail}\n`);
  console.error(`${NAME}: ${status} - ${detail}`);
};

const env = (k: string) => process.env[k] ?? '';
const required = ['GH_APP_ID', 'GH_APP_KEY_FILE', 'GH_INSTALLATION_ID', 'GH_OWNER', 'GH_REPO', 'GH_OTHER_REPO'];
const missing = required.filter((k) => !env(k));
if (missing.length) {
  report('SKIP', `missing env: ${missing.join(' ')}`);
  process.exit(0);
}

try {
  const jwt = appJwt(env('GH_APP_ID'), readFileSync(env('GH_APP_KEY_FILE'), 'utf8'));
  const { token, expiresAt } = await GitHub.installationToken({
    appJwt: jwt,
    installationId: env('GH_INSTALLATION_ID'),
    repositories: [env('GH_REPO')],
    permissions: WORKER_PERMISSIONS,
  });
  const gh = new GitHub(token);
  const own = await gh.request<{ full_name: string }>('GET', `/repos/${env('GH_OWNER')}/${env('GH_REPO')}`);
  let otherBlocked = false;
  try {
    await gh.request('GET', `/repos/${env('GH_OWNER')}/${env('GH_OTHER_REPO')}`);
  } catch (e) {
    otherBlocked = (e as { status?: number }).status === 404 || (e as { status?: number }).status === 403;
  }
  const ok = own.full_name.length > 0 && otherBlocked;
  report(ok ? 'PASS' : 'FAIL', `reads ${own.full_name}; other repo blocked=${otherBlocked}; token expires ${expiresAt}`);
} catch (e) {
  report('FAIL', (e as Error).message.slice(0, 300));
}
