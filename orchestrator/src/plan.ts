import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { buildClaudeArgs } from './claude.ts';
import { ORCHESTRATOR_PERMISSIONS, type GitHub } from './github.ts';
import type { PipelineContext } from './pipeline.ts';
import { promptPath, roleConfig } from './roles.ts';
import { runInContainer } from './runner/container.ts';
import { gitRemote, redact } from './runner/worktree.ts';
import type { Model, Project, ProjectKind } from './types.ts';
import { snapshotAfterRun } from './usage.ts';

export type PlanTarget = 'new' | 'existing';
export type PlanState = 'drafting' | 'thinking' | 'executing' | 'executed' | 'failed' | 'archived';

export interface Plan {
  id: number;
  title: string;
  target: PlanTarget;
  projectId: string | null;
  state: PlanState;
  model: Model;
  sessionId: string | null;
  result: PlanResult | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlanMessage {
  id: number;
  role: 'owner' | 'planner' | 'system';
  text: string;
  at: number;
}

/** What execution has done so far. Execution resumes from here if it stopped halfway. */
export interface PlanResult {
  repoCreated?: string; // owner/name
  trackingIssue?: number;
  issues: Record<string, number>; // plan key -> issue number
  error?: string;
}

export const PlanIssueSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'keys are short kebab-case'),
  title: z.string().min(3).max(120),
  body: z.string().min(10),
  size: z.enum(['s', 'm', 'l']).default('m'),
  risk: z.enum(['low', 'medium', 'high']).default('medium'),
  area: z.string().regex(/^[a-z0-9][a-z0-9-]{0,29}$/).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  dependsOn: z.array(z.string()).default([]),
});
export const PlanFileSchema = z.object({
  title: z.string().min(3).max(100),
  project: z
    .object({
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'repo names are kebab-case, 3-40 characters'),
      kind: z.enum(['web-app', 'static-site', 'service', 'cli', 'ios']),
      priority: z.number().int().min(1).max(5).default(3),
    })
    .optional(),
  issues: z.array(PlanIssueSchema).min(1).max(40),
});
export type PlanFile = z.infer<typeof PlanFileSchema>;
export type PlanIssue = z.infer<typeof PlanIssueSchema>;

type Row = Record<string, unknown>;
const toPlan = (r: Row): Plan => ({
  id: Number(r.id),
  title: String(r.title),
  target: r.target as PlanTarget,
  projectId: (r.project_id as string | null) ?? null,
  state: r.state as PlanState,
  model: r.model as Model,
  sessionId: (r.session_id as string | null) ?? null,
  result: r.result ? (JSON.parse(String(r.result)) as PlanResult) : null,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

// ---------- storage ----------

export function planDir(ctx: Pick<PipelineContext, 'config'>, id: number): string {
  return join(ctx.config.paths.state, 'plans', String(id));
}

export function listPlans(ctx: Pick<PipelineContext, 'store'>): Plan[] {
  return (ctx.store.db.prepare(`SELECT * FROM plans WHERE state != 'archived' ORDER BY updated_at DESC`).all() as Row[]).map(toPlan);
}

export function getPlan(ctx: Pick<PipelineContext, 'store'>, id: number): Plan | null {
  const r = ctx.store.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as Row | undefined;
  return r ? toPlan(r) : null;
}

export function planMessages(ctx: Pick<PipelineContext, 'store'>, id: number): PlanMessage[] {
  return (ctx.store.db.prepare('SELECT * FROM plan_messages WHERE plan_id = ? ORDER BY id').all(id) as Row[]).map((r) => ({
    id: Number(r.id),
    role: r.role as PlanMessage['role'],
    text: String(r.text),
    at: Number(r.at),
  }));
}

function addMessage(ctx: Pick<PipelineContext, 'store' | 'now'>, planId: number, role: PlanMessage['role'], text: string): void {
  ctx.store.db.prepare('INSERT INTO plan_messages (plan_id, role, text, at) VALUES (?, ?, ?, ?)').run(planId, role, text, ctx.now());
  ctx.store.db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(ctx.now(), planId);
}

function update(ctx: Pick<PipelineContext, 'store' | 'now'>, id: number, patch: { state?: PlanState; sessionId?: string | null; result?: PlanResult; title?: string; model?: Model }): void {
  const cur = getPlan(ctx, id)!;
  ctx.store.db
    .prepare('UPDATE plans SET state = ?, session_id = ?, result = ?, title = ?, model = ?, updated_at = ? WHERE id = ?')
    .run(patch.state ?? cur.state, patch.sessionId === undefined ? cur.sessionId : patch.sessionId, JSON.stringify(patch.result ?? cur.result), patch.title ?? cur.title, patch.model ?? cur.model, ctx.now(), id);
}

export function createPlan(ctx: PipelineContext, p: { title: string; target: PlanTarget; projectId?: string | null; model?: Model }): Plan {
  if (p.target === 'existing' && !ctx.store.projects().some((x) => x.id === p.projectId)) throw new Error(`Unknown project ${p.projectId}`);
  const r = ctx.store.db
    .prepare('INSERT INTO plans (title, target, project_id, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.title.slice(0, 100), p.target, p.target === 'existing' ? p.projectId! : null, p.model ?? 'opus', ctx.now(), ctx.now());
  const id = Number(r.lastInsertRowid);
  mkdirSync(join(planDir(ctx, id), 'work', 'plan'), { recursive: true });
  mkdirSync(join(planDir(ctx, id), 'sessions'), { recursive: true });
  return getPlan(ctx, id)!;
}

export function setPlanModel(ctx: PipelineContext, id: number, model: Model): void {
  update(ctx, id, { model });
}

export function archivePlan(ctx: PipelineContext, id: number): void {
  const plan = getPlan(ctx, id);
  if (!plan) throw new Error(`No plan ${id}`);
  if (plan.state === 'thinking' || plan.state === 'executing') throw new Error('Wait until the plan is idle');
  update(ctx, id, { state: 'archived' });
}

// ---------- files the planner keeps up to date ----------

export interface PlanFiles {
  product: string | null;
  plan: PlanFile | null;
  errors: string[];
}

export function readPlanFiles(ctx: Pick<PipelineContext, 'config'>, plan: Plan): PlanFiles {
  const dir = join(planDir(ctx, plan.id), 'work', 'plan');
  const product = existsSync(join(dir, 'PRODUCT.md')) ? readFileSync(join(dir, 'PRODUCT.md'), 'utf8') : null;
  if (!existsSync(join(dir, 'plan.json'))) return { product, plan: null, errors: ['The planner has not written plan.json yet.'] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  } catch (e) {
    return { product, plan: null, errors: [`plan.json is not valid JSON: ${(e as Error).message}`] };
  }
  const parsed = PlanFileSchema.safeParse(raw);
  if (!parsed.success) return { product, plan: null, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  return { product, plan: parsed.data, errors: validatePlan(parsed.data, plan.target) };
}

/** Structural checks the schema can't express: unique keys, known dependencies, no cycles, a project for new plans. */
export function validatePlan(p: PlanFile, target: PlanTarget): string[] {
  const errors: string[] = [];
  if (target === 'new' && !p.project) errors.push('A new-project plan needs "project" (name, kind).');
  const keys = new Set<string>();
  for (const i of p.issues) {
    if (keys.has(i.key)) errors.push(`Duplicate issue key "${i.key}".`);
    keys.add(i.key);
  }
  for (const i of p.issues) for (const d of i.dependsOn) if (!keys.has(d)) errors.push(`"${i.key}" depends on unknown "${d}".`);
  if (errors.length === 0 && topoOrder(p.issues) === null) errors.push('The issue dependencies form a cycle.');
  return errors;
}

/** Issues ordered so every dependency comes first; null on a cycle. Keeps the planner's order where it can. */
export function topoOrder(issues: PlanIssue[]): PlanIssue[] | null {
  const done = new Set<string>();
  const out: PlanIssue[] = [];
  let progress = true;
  while (out.length < issues.length && progress) {
    progress = false;
    for (const i of issues) {
      if (done.has(i.key) || !i.dependsOn.every((d) => done.has(d))) continue;
      out.push(i);
      done.add(i.key);
      progress = true;
    }
  }
  return out.length === issues.length ? out : null;
}

// ---------- one conversation turn ----------

export const PLANNER_COST_PCT = 3;

/**
 * Send the owner's message to the planner and record its reply. Runs in the background: the dashboard polls the plan.
 * The planner works in its plan folder; for an existing project, a fresh clone of main is mounted read-only at /work/repo.
 */
export async function planTurn(ctx: PipelineContext, id: number, text: string): Promise<void> {
  const plan = getPlan(ctx, id);
  if (!plan) throw new Error(`No plan ${id}`);
  if (plan.state !== 'drafting' && plan.state !== 'failed') throw new Error(`Plan is ${plan.state}`);
  addMessage(ctx, id, 'owner', text);
  update(ctx, id, { state: 'thinking' });

  const { config, store } = ctx;
  const role = roleConfig(config, 'planner');
  const dir = planDir(ctx, id);
  const mounts: Record<string, string> = {};
  let readToken: string | null = null;
  try {
    const env: Record<string, string> = { [config.worker.claudeTokenEnv]: await ctx.secrets.get(config.worker.claudeTokenEnv) };
    if (plan.target === 'existing' && plan.projectId) {
      const project = store.projects().find((p) => p.id === plan.projectId)!;
      const { token } = await ctx.repoAccess(project);
      readToken = token;
      env.GH_TOKEN = token;
      const repoDir = join(dir, 'repo');
      rmSync(repoDir, { recursive: true, force: true });
      const remote = ctx.remoteUrl?.(project) ?? `https://github.com/${project.owner}/${project.id}.git`;
      await gitRemote(dir, token, 'clone', '--depth', '1', remote, repoDir);
      mounts[repoDir] = '/work/repo';
    }
    const first = plan.sessionId === null;
    const prompt = first
      ? [
          plan.target === 'new'
            ? `The owner wants to plan a new project: "${plan.title}".`
            : `The owner wants to plan a change to the existing project ${plan.projectId} (code in /work/repo): "${plan.title}".`,
          'Start PRODUCT.md and plan.json in /work/plan right away from what you know, then discuss.',
          '',
          `Owner: ${text}`,
        ].join('\n')
      : text;
    const args = buildClaudeArgs({
      prompt,
      model: plan.model,
      effort: role.effort,
      maxTurns: role.maxTurns,
      resumeSessionId: plan.sessionId,
      appendSystemPromptFile: promptPath('planner'),
    });
    mkdirSync(config.paths.logs, { recursive: true });
    const logPath = join(config.paths.logs, `plan-${id}-${Date.now()}.jsonl`);
    const runId = store.startRun({ taskId: null, role: 'planner', model: plan.model, logPath, usageBefore: store.latestUsage() });
    const result = await runInContainer(
      {
        name: `factory-plan-${id}-${Date.now()}`,
        image: config.worker.image,
        worktree: join(dir, 'work'),
        workerConfigDir: config.paths.workerConfig,
        sessionsDir: join(dir, 'sessions'),
        extraReadOnlyMounts: mounts,
        cpus: config.worker.cpus,
        memoryGb: config.worker.memoryGb,
        envNames: Object.keys(env),
        labels: { 'factory.role': 'planner', 'factory.plan': String(id) },
      },
      args,
      { env, timeoutMs: role.timeoutMinutes * 60_000, logPath },
    );
    const clean = (t: string) => redact(t, readToken);
    store.finishRun(runId, result, clean(result.resultText));
    const snap = snapshotAfterRun(store.latestUsage(), result, ctx.now());
    if (snap) store.recordUsage(snap);
    if (result.sessionId) update(ctx, id, { sessionId: result.sessionId });
    if (result.ok) {
      addMessage(ctx, id, 'planner', clean(result.resultText) || '(no reply)');
      update(ctx, id, { state: 'drafting' });
    } else {
      const why = result.hitUsageLimit ? 'The usage limit was reached. Try again after it resets (see the usage gauges).' : `The planner stopped: ${clean(result.resultText).slice(0, 500) || 'no result'}`;
      addMessage(ctx, id, 'system', why);
      update(ctx, id, { state: 'drafting' });
    }
  } catch (e) {
    addMessage(ctx, id, 'system', `Couldn't run the planner: ${redact((e as Error).message, readToken)}`);
    update(ctx, id, { state: 'drafting' });
  }
}

// ---------- execute ----------

export const FACTORY_LABELS: { name: string; color: string }[] = [
  { name: 'factory:ready', color: '0e8a16' },
  { name: 'size:s', color: 'c5def5' },
  { name: 'size:m', color: 'c5def5' },
  { name: 'size:l', color: 'c5def5' },
  { name: 'risk:low', color: 'fef2c0' },
  { name: 'risk:medium', color: 'fbca04' },
  { name: 'risk:high', color: 'd93f0b' },
  ...[1, 2, 3, 4, 5].map((n) => ({ name: `priority:${n}`, color: n === 5 ? 'b60205' : 'ededed' })),
  { name: 'split-on-fail', color: 'ededed' },
  { name: 'factory:plan', color: '5319e7' },
];

/** Creates the private repo for a new project with its first commit, and tags it for the factory. */
export type RepoCreator = (p: { name: string; description: string; files: Record<string, string> }) => Promise<{ owner: string; name: string }>;

export interface ExecuteDeps {
  createRepo: RepoCreator;
  /** Orchestrator client for a project; retried while a new repo becomes visible to the App. */
  repoClient(project: Project): Promise<{ gh: GitHub }>;
}

export function issueBody(issue: PlanIssue, trackingIssue: number, depNumbers: number[]): string {
  const footer = [`Part of the plan in #${trackingIssue}.`];
  if (depNumbers.length) footer.push(`Depends on ${depNumbers.map((n) => `#${n}`).join(', ')}`);
  return `${issue.body.trim()}\n\n${footer.join('\n')}`;
}

export function issueLabels(issue: PlanIssue, projectPriority: number): string[] {
  return ['factory:ready', `size:${issue.size}`, `risk:${issue.risk}`, `priority:${issue.priority ?? projectPriority}`, ...(issue.area ? [`area:${issue.area}`] : [])];
}

export function starterFiles(file: PlanFile, product: string): Record<string, string> {
  const p = file.project!;
  const pitch = product.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? file.title;
  return {
    'README.md': `# ${p.name}\n\n${pitch}\n\nBuilt by the software factory. The spec is in [docs/PRODUCT.md](docs/PRODUCT.md).\n`,
    'docs/PRODUCT.md': product,
    'factory.yaml': `kind: ${p.kind}\npriority: ${p.priority}\n`,
    'CLAUDE.md': `# ${p.name}\n\nRead docs/PRODUCT.md for what this is. The first issue scaffolds the stack and fills in this file:\nthe commands to run, the conventions and where things are. Keep it under 150 lines.\n`,
    '.gitignore': 'node_modules/\n.venv/\n.env\n.env.*\n.factory/\ndist/\n.next/\ncoverage/\n',
  };
}

/**
 * Turn the plan into work. Every step records what it did, so a failure halfway (network, GitHub) can be retried
 * with Execute again without duplicating the repo or issues.
 */
export async function executePlan(ctx: PipelineContext, deps: ExecuteDeps, id: number): Promise<PlanResult> {
  const plan = getPlan(ctx, id);
  if (!plan) throw new Error(`No plan ${id}`);
  if (!['drafting', 'failed'].includes(plan.state)) throw new Error(`Plan is ${plan.state}`);
  const files = readPlanFiles(ctx, plan);
  if (!files.plan || files.errors.length) throw new Error(`The plan isn't ready: ${files.errors.join(' ')}`);
  if (!files.product) throw new Error('The planner has not written PRODUCT.md yet.');
  const pf = files.plan;
  const result: PlanResult = { issues: {}, ...(plan.result ?? {}) };
  delete result.error;
  update(ctx, id, { state: 'executing', result });
  const save = () => update(ctx, id, { result });

  try {
    // 1. The project.
    let project: Project;
    if (plan.target === 'new') {
      const name = pf.project!.name;
      if (!result.repoCreated) {
        if (ctx.store.projects().some((p) => p.id === name)) throw new Error(`A project called ${name} already exists.`);
        const repo = await deps.createRepo({ name, description: pf.title, files: starterFiles(pf, files.product) });
        result.repoCreated = `${repo.owner}/${repo.name}`;
        save();
      }
      project = { id: name, owner: result.repoCreated.split('/')[0]!, kind: pf.project!.kind as ProjectKind, state: 'active', priority: pf.project!.priority, createdAt: ctx.now() };
      ctx.store.upsertProject(project);
      ctx.store.setProjectState(project.id, 'active');
      if (plan.projectId !== project.id) ctx.store.db.prepare('UPDATE plans SET project_id = ? WHERE id = ?').run(project.id, id);
    } else {
      project = ctx.store.projects().find((p) => p.id === plan.projectId)!;
    }
    const { gh } = await deps.repoClient(project);

    // 2. Labels, including each area used.
    const areas = [...new Set(pf.issues.map((i) => i.area).filter((a): a is string => Boolean(a)))];
    await gh.ensureLabels(project.owner, project.id, [...FACTORY_LABELS, ...areas.map((a) => ({ name: `area:${a}`, color: 'bfdadc' }))]);

    // 3. The tracking issue carries the spec (no factory:ready: nobody builds it).
    if (!result.trackingIssue) {
      const t = await gh.createIssue(project.owner, project.id, { title: `Plan: ${pf.title}`, body: `${files.product}\n\n_Planned on the factory dashboard (plan ${id})._`, labels: ['factory:plan'] });
      result.trackingIssue = t.number;
      save();
    }

    // 4. Issues, dependencies first, so each can name the real numbers it waits for.
    for (const issue of topoOrder(pf.issues)!) {
      if (result.issues[issue.key]) continue;
      const created = await gh.createIssue(project.owner, project.id, {
        title: issue.title,
        body: issueBody(issue, result.trackingIssue, issue.dependsOn.map((d) => result.issues[d]!)),
        labels: issueLabels(issue, project.priority),
      });
      result.issues[issue.key] = created.number;
      save();
    }
    update(ctx, id, { state: 'executed', result });
    addMessage(ctx, id, 'system', `Executed: ${Object.keys(result.issues).length} issues in ${project.owner}/${project.id} (plan #${result.trackingIssue}). The factory picks them up within 5 minutes.`);
    return result;
  } catch (e) {
    result.error = (e as Error).message;
    update(ctx, id, { state: 'failed', result });
    addMessage(ctx, id, 'system', `Execution stopped: ${result.error}. Fix the cause and press Execute again; finished steps are skipped.`);
    throw e;
  }
}

/** Clients for executePlan in production: a token from the GitHub App, retried while a new repo becomes visible to it. */
export function appRepoClient(repoClient: (p: Project, perms: typeof ORCHESTRATOR_PERMISSIONS) => Promise<{ gh: GitHub }>) {
  return async (project: Project) => {
    let last: Error | null = null;
    for (let i = 0; i < 10; i++) {
      try {
        return await repoClient(project, ORCHESTRATOR_PERMISSIONS);
      } catch (e) {
        last = e as Error;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    throw last ?? new Error('GitHub App has no access to the new repo');
  };
}
