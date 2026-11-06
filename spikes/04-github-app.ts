// S0-4: can the factory-bot GitHub App mint a token that reaches exactly one repo?
// Env: GH_APP_ID, GH_INSTALLATION_ID, GH_OWNER, GH_REPO (a repo to reach), GH_OTHER_REPO (any other repo you own),
//      and either GH_APP_KEY_FILE or OP_SERVICE_ACCOUNT_TOKEN (key read from the GITHUB_APP_PRIVATE_KEY item in the Factory vault)
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appJwt, GitHub, WORKER_PERMISSIONS } from '../orchestrator/src/github.ts';
import { Secrets } from '../orchestrator/src/secrets.ts';

const summary = join(import.meta.dirname, 'results', 'summary.md');
const NAME = 'S0-4 GitHub App scoped token';
const report = (status: string, detail: string) => {
  appendFileSync(summary, `- **${NAME}**: ${status} - ${detail}\n`);
  console.error(`${NAME}: ${status} - ${detail}`);
};

const env = (k: string) => process.env[k] ?? '';
const required = ['GH_APP_ID', 'GH_INSTALLATION_ID', 'GH_OWNER', 'GH_REPO', 'GH_OTHER_REPO'];
const missing = required.filter((k) => !env(k));
if (!env('GH_APP_KEY_FILE') && !env('OP_SERVICE_ACCOUNT_TOKEN')) missing.push('GH_APP_KEY_FILE or OP_SERVICE_ACCOUNT_TOKEN');
if (missing.length) {
  report('SKIP', `missing env: ${missing.join(' ')}`);
  process.exit(0);
}

try {
  const key = env('GH_APP_KEY_FILE') ? readFileSync(env('GH_APP_KEY_FILE'), 'utf8') : await new Secrets().get('GITHUB_APP_PRIVATE_KEY');
  const jwt = appJwt(env('GH_APP_ID'), key);
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
