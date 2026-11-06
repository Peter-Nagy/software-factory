import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { statusText } from '../discord/bot.ts';
import { weeklyBurnLine } from '../governor.ts';
import { ORCHESTRATOR_PERMISSIONS, type GitHub, type RepoPermissions } from '../github.ts';
import type { PipelineContext } from '../pipeline.ts';
import {
  appRepoClient,
  archivePlan,
  createPlan,
  executePlan,
  getPlan,
  listPlans,
  planMessages,
  planTurn,
  readPlanFiles,
  setPlanModel,
  type RepoCreator,
} from '../plan.ts';
import { answerQuestion, openQuestions } from '../questions.ts';
import { TERMINAL_STATES } from '../tasks.ts';
import type { Model, Project } from '../types.ts';

export interface DashboardContext extends PipelineContext {
  repoClient(project: Project, permissions?: RepoPermissions): Promise<{ gh: GitHub; token: string }>;
}

/** The built React app (dashboard/: npm run build). */
export const DIST = fileURLToPath(new URL('../../../dashboard/dist/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const COOKIE = 'factory_session';

/**
 * Agents run in containers that can reach this Mac, so "the request came from localhost" proves nothing.
 * Every API call needs the session cookie, which a browser only gets by opening the login link
 * (`factory dashboard-url`). The token lives in the factory's state database, which no container mounts.
 * Writes also need a custom header (cross-site forms can't send one), and the Host header must be one we serve.
 */
export function dashboardToken(ctx: Pick<PipelineContext, 'store'>): string {
  let t = ctx.store.getSetting('dashboardToken');
  if (!t) {
    t = randomBytes(24).toString('base64url');
    ctx.store.setSetting('dashboardToken', t);
  }
  return t;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((kv): kv is [string, string] => kv.length === 2 && kv[0] !== '')
      .map(([k, v]) => [k, decodeURIComponent(v)]),
  );
}

export function hostAllowed(host: string | undefined, allowed: string[]): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name.endsWith('.ts.net') || allowed.map((h) => h.toLowerCase()).includes(name);
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, 'Request too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

const str = (v: unknown, field: string, max = 20_000): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  return v.trim().slice(0, max);
};

/** Everything the overview page shows, in one call. */
export function dashboardState(ctx: DashboardContext) {
  const { store } = ctx;
  const now = ctx.now();
  const usage = store.latestUsage();
  const burnLine = usage?.sevenDayResetsAt ? Math.round(weeklyBurnLine(ctx.config.governor, now, usage.sevenDayResetsAt)) : null;
  const pausedUntil = Number(store.getSetting('pausedUntil') ?? 0);
  const recentDone = store.db
    .prepare(`SELECT id FROM tasks WHERE state IN ('done', 'cancelled') ORDER BY updated_at DESC LIMIT 15`)
    .all()
    .map((r) => store.task(String((r as { id: string }).id))!);
  const runs = store.db
    .prepare('SELECT id, task_id, role, model, started_at, finished_at, ok, cost_usd, num_turns, summary FROM runs ORDER BY id DESC LIMIT 25')
    .all();
  const spend = store.db
    .prepare(`SELECT role, model, COUNT(*) AS runs, ROUND(SUM(COALESCE(cost_usd, 0)), 3) AS usd FROM runs WHERE started_at >= ? GROUP BY role, model ORDER BY usd DESC`)
    .all(now - 7 * 86400);
  const events = store.db.prepare('SELECT at, kind, task_id, data FROM events ORDER BY id DESC LIMIT 40').all();
  return {
    now,
    owner: ctx.config.github.owner,
    timezone: ctx.config.schedule.timezone,
    usage,
    burnLine,
    governor: { opusMaxFiveHourPct: ctx.config.governor.opusMaxFiveHourPct, anyMaxFiveHourPct: ctx.config.governor.anyMaxFiveHourPct },
    pausedUntil: pausedUntil > now ? pausedUntil : null,
    projects: store.projects(),
    tasks: [...store.openTasks(), ...recentDone].filter((t) => !TERMINAL_STATES.includes(t.state) || recentDone.includes(t)),
    questions: openQuestions(ctx),
    plans: listPlans(ctx),
    runs,
    spend,
    events,
    summary: statusText(ctx),
  };
}

export interface DashboardOptions {
  createRepo: RepoCreator;
  /** Built app folder (default: dashboard/dist). */
  distDir?: string;
  log?: (m: string) => void;
}

export function startDashboard(ctx: DashboardContext, opts: DashboardOptions): Promise<Server> {
  const { port, allowedHosts } = ctx.config.dashboard;
  const token = dashboardToken(ctx);
  const background = new Map<number, Promise<unknown>>(); // plan id -> running turn or execution
  const log = opts.log ?? ((m: string) => console.log(`[dashboard] ${m}`));
  const dist = opts.distDir ?? DIST;

  // docs/PRODUCT.md per project, read from main with a read-only token, cached for a minute.
  const productCache = new Map<string, { at: number; text: string | null }>();
  const productFor = async (project: Project): Promise<string | null> => {
    const hit = productCache.get(project.id);
    if (hit && ctx.now() - hit.at < 60) return hit.text;
    try {
      const { gh } = await ctx.repoClient(project, { contents: 'read', metadata: 'read' });
      const text = await gh.readFile(project.owner, project.id, 'docs/PRODUCT.md');
      productCache.set(project.id, { at: ctx.now(), text });
      return text;
    } catch {
      return hit?.text ?? null;
    }
  };

  const runInBackground = (planId: number, work: () => Promise<unknown>) => {
    if (background.has(planId)) throw new HttpError(409, 'The planner is still working on this plan');
    const p = work()
      .catch((e: Error) => log(`plan ${planId}: ${e.message}`))
      .finally(() => background.delete(planId));
    background.set(planId, p);
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const json = typeof body !== 'string' && !Buffer.isBuffer(body);
      res.writeHead(status, {
        'Content-Type': json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ...headers,
      });
      res.end(json ? JSON.stringify(body) : (body as string | Buffer));
    };

    if (!hostAllowed(req.headers.host, allowedHosts)) return send(421, { error: 'Unknown host' });

    // Login: the link carries the token once; the browser keeps it as an HttpOnly cookie.
    if (url.pathname === '/login') {
      const t = url.searchParams.get('t') ?? '';
      if (!same(t, token)) return send(403, '<!doctype html><p>This login link is not valid. Run <code>factory dashboard-url</code> on the Mac for the current one.</p>');
      const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '');
      const cookie = `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${180 * 86400}${local ? '' : '; Secure'}`;
      return send(302, '', { Location: '/', 'Set-Cookie': cookie });
    }

    const authed = same(cookies(req)[COOKIE] ?? '', token);
    if (!url.pathname.startsWith('/api/')) {
      // The app: hashed assets are public (no data in them); every page needs the session.
      const isAsset = url.pathname.startsWith('/assets/') || /\.(svg|png|ico|woff2|webmanifest)$/.test(url.pathname);
      if (!isAsset && !authed) return send(401, '<!doctype html><meta name="viewport" content="width=device-width"><p style="font:16px system-ui;margin:2em">Open the login link from <code>factory dashboard-url</code> on the Mac.</p>');
      if (!existsSync(join(dist, 'index.html'))) return send(503, '<!doctype html><p style="font:16px system-ui;margin:2em">The dashboard isn\'t built yet: run <code>npm run build</code> in <code>dashboard/</code>.</p>');
      const file = normalize(join(dist, decodeURIComponent(url.pathname)));
      const inside = file.startsWith(dist.endsWith(sep) ? dist : dist + sep);
      const target = inside && existsSync(file) && statSync(file).isFile() ? file : join(dist, 'index.html'); // SPA fallback
      const immutable = target.includes(`${sep}assets${sep}`);
      return send(200, readFileSync(target), { 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store' });
    }
    if (!authed) return send(401, { error: 'Not logged in' });
    if (req.method !== 'GET' && req.headers['x-factory'] !== '1') return send(403, { error: 'Missing X-Factory header' });

    try {
      const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
      const method = req.method ?? 'GET';
      const body = method === 'POST' ? await readJson(req) : {};
      const result = await route(method, parts, body);
      send(200, result ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`${req.method} ${url.pathname}: ${(e as Error).stack ?? (e as Error).message}`);
      send(status, { error: (e as Error).message });
    }
  };

  const route = async (method: string, p: string[], body: Record<string, unknown>): Promise<unknown> => {
    const { store } = ctx;
    const key = `${method} ${p[0] ?? ''}${p.length > 1 ? '/:id' : ''}${p.length > 2 ? `/${p[2]}` : ''}`;
    const id = p[1] ? decodeURIComponent(p[1]) : '';
    switch (key) {
      case 'GET state':
        return dashboardState(ctx);
      case 'POST pause': {
        const hours = Number(body.hours);
        if (!(hours > 0 && hours <= 168)) throw new HttpError(400, 'hours must be between 0 and 168');
        store.setSetting('pausedUntil', String(ctx.now() + Math.round(hours * 3600)));
        return;
      }
      case 'POST resume':
        store.setSetting('pausedUntil', null);
        return;
      case 'POST tasks/:id/retry': {
        const t = store.task(id);
        if (!t || (t.state !== 'parked' && t.state !== 'blocked')) throw new HttpError(400, `${id} is not parked`);
        if (t.state === 'blocked') throw new HttpError(400, 'Answer its question instead');
        store.transition(id, 'queued', { fixRounds: 0, interruptions: 0, notBefore: null });
        return;
      }
      case 'POST tasks/:id/cancel': {
        const t = store.task(id);
        if (!t) throw new HttpError(404, `No task ${id}`);
        if (!['queued', 'blocked', 'parked'].includes(t.state)) throw new HttpError(400, `Can't cancel a task that is ${t.state}`);
        store.transition(id, 'cancelled');
        return;
      }
      case 'POST questions/:id/answer': {
        const r = answerQuestion(ctx, Number(id), str(body.answer, 'answer', 4000), 'owner');
        if (!r.ok) throw new HttpError(400, r.reason);
        return r;
      }
      case 'GET projects/:id': {
        const project = store.projects().find((x) => x.id === id);
        if (!project) throw new HttpError(404, `No project ${id}`);
        const tasks = (store.db.prepare(`SELECT id FROM tasks WHERE project_id = ? AND (state NOT IN ('done', 'cancelled') OR updated_at >= ?) ORDER BY updated_at DESC`).all(id, ctx.now() - 30 * 86400) as { id: string }[]).map((r) => store.task(r.id)!);
        return {
          project,
          tasks,
          product: await productFor(project),
          plans: listPlans(ctx).filter((pl) => pl.projectId === id),
          questions: openQuestions(ctx).filter((q) => q.projectId === id),
          merged30d: Number((store.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND state = 'done' AND updated_at >= ?`).get(id, ctx.now() - 30 * 86400) as { n: number }).n),
        };
      }
      case 'POST projects/:id/state': {
        const project = store.projects().find((x) => x.id === id);
        if (!project) throw new HttpError(404, `No project ${id}`);
        if (body.state !== 'active' && body.state !== 'paused') throw new HttpError(400, 'state must be active or paused');
        store.setProjectState(id, body.state);
        productCache.delete(id);
        return;
      }
      case 'GET tasks/:id': {
        const task = store.task(id);
        if (!task) throw new HttpError(404, `No task ${id}`);
        return {
          task,
          runs: store.db.prepare('SELECT id, role, model, started_at, finished_at, ok, cost_usd, num_turns, summary FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 30').all(id),
          events: store.db.prepare('SELECT at, kind, data FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 50').all(id),
          questions: store.db.prepare('SELECT id, kind, question, answer, answered_by, asked_at FROM questions WHERE task_id = ? ORDER BY id DESC').all(id),
        };
      }
      case 'POST projects/:id/tasks': {
        const project = store.projects().find((x) => x.id === id);
        if (!project) throw new HttpError(404, `No project ${id}`);
        const { gh } = await ctx.repoClient(project, ORCHESTRATOR_PERMISSIONS);
        const issue = await gh.createIssue(project.owner, project.id, {
          title: str(body.title, 'title', 120),
          body: `${str(body.body, 'description')}\n\n_Added from the factory dashboard._`,
          labels: ['factory:ready', `size:${['s', 'm', 'l'].includes(String(body.size)) ? body.size : 'm'}`],
        });
        return { number: issue.number, url: issue.html_url };
      }
      case 'POST plans': {
        const target = body.target === 'existing' ? 'existing' : 'new';
        const model: Model = body.model === 'sonnet' ? 'sonnet' : 'opus';
        const plan = createPlan(ctx, { title: str(body.title, 'title', 100), target, projectId: target === 'existing' ? str(body.projectId, 'projectId') : null, model, focus: body.focus === 'goals' ? 'goals' : 'change' });
        const first = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : null;
        if (first) runInBackground(plan.id, () => planTurn(ctx, plan.id, first.slice(0, 20_000)));
        return getPlan(ctx, plan.id);
      }
      case 'GET plans/:id': {
        const plan = getPlan(ctx, Number(id));
        if (!plan) throw new HttpError(404, `No plan ${id}`);
        return { plan, messages: planMessages(ctx, plan.id), files: readPlanFiles(ctx, plan), busy: background.has(plan.id) };
      }
      case 'POST plans/:id/messages': {
        const plan = getPlan(ctx, Number(id));
        if (!plan) throw new HttpError(404, `No plan ${id}`);
        if (plan.state === 'executed' || plan.state === 'archived') throw new HttpError(400, 'This plan is finished; start a new one');
        const text = str(body.text, 'text');
        runInBackground(plan.id, () => planTurn(ctx, plan.id, text));
        return;
      }
      case 'POST plans/:id/model': {
        setPlanModel(ctx, Number(id), body.model === 'sonnet' ? 'sonnet' : 'opus');
        return;
      }
      case 'POST plans/:id/execute': {
        const plan = getPlan(ctx, Number(id));
        if (!plan) throw new HttpError(404, `No plan ${id}`);
        const files = readPlanFiles(ctx, plan);
        if (!files.plan || files.errors.length) throw new HttpError(400, `Not ready: ${files.errors.join(' ')}`);
        runInBackground(plan.id, () => executePlan(ctx, { createRepo: opts.createRepo, repoClient: appRepoClient((pr, perms) => ctx.repoClient(pr, perms)) }, plan.id));
        return;
      }
      case 'POST plans/:id/archive':
        archivePlan(ctx, Number(id));
        return;
    }
    throw new HttpError(404, `No route ${method} /api/${p.join('/')}`);
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((e: Error) => {
      log(`unhandled: ${e.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: Tailscale forwards to it, nothing on the network can reach it directly.
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
