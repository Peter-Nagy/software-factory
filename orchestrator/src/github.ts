import { createSign } from 'node:crypto';

const API = 'https://api.github.com';

const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

/** JWT (RS256) that authenticates as the GitHub App itself. Valid 9 minutes, backdated 60 s for clock drift. */
export function appJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKeyPem).toString('base64url')}`;
}

export type RepoPermissions = Partial<
  Record<'contents' | 'pull_requests' | 'issues' | 'checks' | 'statuses' | 'metadata' | 'workflows' | 'administration', 'read' | 'write'>
>;

/** Permissions an agent container gets: read only. The orchestrator pushes the agent's commits from the host. */
export const WORKER_PERMISSIONS: RepoPermissions = {
  contents: 'read',
  pull_requests: 'read',
  issues: 'read',
  checks: 'read',
  statuses: 'read',
  metadata: 'read',
};

/**
 * The orchestrator's own token for a repo: merge, post gate statuses, push sync merges (which can carry workflow
 * changes from main). Never given to an agent.
 */
export const ORCHESTRATOR_PERMISSIONS: RepoPermissions = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  statuses: 'write',
  checks: 'read',
  workflows: 'write',
  metadata: 'read',
};

/** Statuses the factory posts; branch protection requires both. */
export const STATUS_CONTEXTS = { gates: 'factory/gates', review: 'factory/review' } as const;

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class GitHub {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'software-factory',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new GitHubError(res.status, `${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** Installation token limited to the given repos and permissions (expires within an hour). */
  static async installationToken(opts: {
    appJwt: string;
    installationId: string;
    repositories: string[];
    permissions: RepoPermissions;
    fetchImpl?: typeof fetch;
  }): Promise<{ token: string; expiresAt: string }> {
    const gh = new GitHub(opts.appJwt, opts.fetchImpl);
    const r = await gh.request<{ token: string; expires_at: string }>(
      'POST',
      `/app/installations/${opts.installationId}/access_tokens`,
      { repositories: opts.repositories, permissions: opts.permissions },
    );
    return { token: r.token, expiresAt: r.expires_at };
  }

  repoTopics(owner: string, repo: string) {
    return this.request<{ names: string[] }>('GET', `/repos/${owner}/${repo}/topics`).then((r) => r.names);
  }

  /** Open issues labelled factory:ready, excluding pull requests. */
  readyIssues(owner: string, repo: string) {
    return this.request<{ number: number; title: string; body: string | null; labels: { name: string }[]; pull_request?: unknown }[]>(
      'GET',
      `/repos/${owner}/${repo}/issues?state=open&labels=factory:ready&per_page=100`,
    ).then((issues) => issues.filter((i) => !i.pull_request));
  }

  createPullRequest(owner: string, repo: string, p: { title: string; head: string; base: string; body: string }) {
    return this.request<{ number: number; html_url: string }>('POST', `/repos/${owner}/${repo}/pulls`, p);
  }

  findOpenPullRequest(owner: string, repo: string, head: string) {
    return this.request<{ number: number; html_url: string }[]>(
      'GET',
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`,
    ).then((prs) => prs[0] ?? null);
  }

  comment(owner: string, repo: string, issueNumber: number, body: string) {
    return this.request('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
  }

  setLabels(owner: string, repo: string, issueNumber: number, labels: string[]) {
    return this.request('PUT', `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, { labels });
  }

  /** Combined state of status checks on a ref: success | pending | failure. */
  async checksState(owner: string, repo: string, ref: string): Promise<'success' | 'pending' | 'failure'> {
    const runs = await this.request<{ check_runs: { status: string; conclusion: string | null }[] }>(
      'GET',
      `/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`,
    );
    if (runs.check_runs.length === 0) return 'pending';
    if (runs.check_runs.some((r) => r.status !== 'completed')) return 'pending';
    const bad = runs.check_runs.some((r) => !['success', 'neutral', 'skipped'].includes(r.conclusion ?? ''));
    return bad ? 'failure' : 'success';
  }

  /** Squash-merge, but only if the PR head is still `sha` (GitHub refuses with 409 otherwise). */
  mergePullRequest(owner: string, repo: string, prNumber: number, sha: string, title: string) {
    return this.request<{ sha: string; merged: boolean }>('PUT', `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      merge_method: 'squash',
      sha,
      commit_title: `${title} (#${prNumber})`,
    });
  }

  pullRequest(owner: string, repo: string, prNumber: number) {
    return this.request<{ number: number; state: string; merged: boolean; head: { sha: string; ref: string }; base: { ref: string } }>(
      'GET',
      `/repos/${owner}/${repo}/pulls/${prNumber}`,
    );
  }

  setStatus(owner: string, repo: string, sha: string, s: { state: 'pending' | 'success' | 'failure' | 'error'; context: string; description: string }) {
    return this.request('POST', `/repos/${owner}/${repo}/statuses/${sha}`, { ...s, description: s.description.slice(0, 140) });
  }

  /**
   * Protect the default branch: changes only through PRs, the factory's statuses required, no force pushes or deletion,
   * and the rules apply to admins too. Needs a token with administration: write.
   */
  protectBranch(owner: string, repo: string, branch = 'main') {
    return this.request('PUT', `/repos/${owner}/${repo}/branches/${branch}/protection`, {
      required_status_checks: { strict: false, contexts: [STATUS_CONTEXTS.gates, STATUS_CONTEXTS.review] },
      enforce_admins: true,
      required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: false },
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
      required_linear_history: true,
    });
  }
}
