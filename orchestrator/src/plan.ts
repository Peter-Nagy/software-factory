import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
/**
 * change = features or fixes; goals = iterate on the project's goals (docs/PRODUCT.md), issues optional;
 * issue = revise one existing issue (applied to it, as often as the owner likes).
 */
export type PlanFocus = 'change' | 'goals' | 'issue';
export type PlanState = 'drafting' | 'thinking' | 'executing' | 'executed' | 'failed' | 'archived';

export interface Plan {
  id: number;
  title: string;
  target: PlanTarget;
  focus: PlanFocus;
  projectId: string | null;
  issueNumber: number | null;
  /** Set when this plan is the build-plan phase of a Studio: its planner reads the studio's documents. */
  studioId: number | null;
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
  issues: z.array(PlanIssueSchema).max(40).default([]),
});
export type PlanFile = z.infer<typeof PlanFileSchema>;
export type PlanIssue = z.infer<typeof PlanIssueSchema>;

type Row = Record<string, unknown>;
const toPlan = (r: Row): Plan => ({
  id: Number(r.id),
  title: String(r.title),
  target: r.target as PlanTarget,
  focus: ((r.focus as string | undefined) ?? 'change') as PlanFocus,
  projectId: (r.project_id as string | null) ?? null,
  issueNumber: r.issue_number == null ? null : Number(r.issue_number),
  studioId: r.studio_id == null ? null : Number(r.studio_id),
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

export function createPlan(ctx: PipelineContext, p: { title: string; target: PlanTarget; projectId?: string | null; model?: Model; focus?: PlanFocus; issueNumber?: number }): Plan {
  if (p.target === 'existing' && !ctx.store.projects().some((x) => x.id === p.projectId)) throw new Error(`Unknown project ${p.projectId}`);
  const focus: PlanFocus = p.target !== 'existing' ? 'change' : p.focus === 'goals' ? 'goals' : p.focus === 'issue' ? 'issue' : 'change';
  if (focus === 'issue' && !(Number.isInteger(p.issueNumber) && p.issueNumber! > 0)) throw new Error('An issue conversation needs the issue number');
  const r = ctx.store.db
    .prepare('INSERT INTO plans (title, target, focus, project_id, issue_number, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.title.slice(0, 100), p.target, focus, p.target === 'existing' ? p.projectId! : null, focus === 'issue' ? p.issueNumber! : null, p.model ?? (focus === 'issue' ? 'sonnet' : 'opus'), ctx.now(), ctx.now());
  const id = Number(r.lastInsertRowid);
  mkdirSync(join(planDir(ctx, id), 'work', 'plan'), { recursive: true });
  mkdirSync(join(planDir(ctx, id), 'sessions'), { recursive: true });
  return getPlan(ctx, id)!;
}

/** The ongoing conversation about one issue, if there is one. */
export function issuePlanFor(ctx: Pick<PipelineContext, 'store'>, projectId: string, issueNumber: number): Plan | null {
  const r = ctx.store.db
    .prepare(`SELECT * FROM plans WHERE focus = 'issue' AND project_id = ? AND issue_number = ? AND state != 'archived' ORDER BY id DESC LIMIT 1`)
    .get(projectId, issueNumber) as Row | undefined;
  return r ? toPlan(r) : null;
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
  /** Issue conversations: the revised issue (ISSUE.md: "# title" line, then the body). */
  issue?: { title: string; body: string } | null;
  errors: string[];
}

export const ISSUE_FILE = 'ISSUE.md';

/** "# Title" on the first non-empty line, the rest is the body. */
export function parseIssueFile(text: string): { title: string; body: string } | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  const m = first >= 0 ? lines[first]!.match(/^#\s+(.{3,120})$/) : null;
  if (!m) return null;
  const body = lines.slice(first + 1).join('\n').trim();
  return body.length >= 10 ? { title: m[1]!.trim(), body } : null;
}

export function readPlanFiles(ctx: Pick<PipelineContext, 'config'>, plan: Plan): PlanFiles {
  const dir = join(planDir(ctx, plan.id), 'work', 'plan');
  if (plan.focus === 'issue') {
    const path = join(dir, ISSUE_FILE);
    if (!existsSync(path)) return { product: null, plan: null, issue: null, errors: ['The planner has not written ISSUE.md yet.'] };
    const issue = parseIssueFile(readFileSync(path, 'utf8'));
    return { product: null, plan: null, issue, errors: issue ? [] : ['ISSUE.md needs a "# Title" first line and a body of at least 10 characters.'] };
  }
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
  if (target === 'new' && p.issues.length === 0) errors.push('A new project needs at least the scaffold issue.');
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
      const { gh, token } = await ctx.repoAccess(project);
      readToken = token;
      // An issue conversation starts from the issue as it is on GitHub.
      const issueFile = join(dir, 'work', 'plan', ISSUE_FILE);
      if (plan.focus === 'issue' && plan.issueNumber && !existsSync(issueFile)) {
        const issue = await gh.issue(project.owner, project.id, plan.issueNumber);
        writeFileSync(issueFile, `# ${issue.title}\n\n${(issue.body ?? '').trim()}\n`);
      }
      env.GH_TOKEN = token;
      const repoDir = join(dir, 'repo');
      rmSync(repoDir, { recursive: true, force: true });
      const remote = ctx.remoteUrl?.(project) ?? `https://github.com/${project.owner}/${project.id}.git`;
      await gitRemote(dir, token, 'clone', '--depth', '1', remote, repoDir);
      mounts[repoDir] = '/work/repo';
    }
    if (plan.studioId !== null) mounts[join(ctx.config.paths.state, 'studios', String(plan.studioId), 'work', 'docs')] = '/work/studio';
    const first = plan.sessionId === null;
    const prompt = first
      ? [
          plan.studioId !== null
            ? [
                `This is the build plan for "${plan.title}", the last phase of a Studio. The approved brief, research, product,`,
                'design, architecture and spike results are in /work/studio (read-only): RESEARCH.md, PRODUCT.md, DESIGN.md with',
                'mockups in design/, ARCHITECTURE.md, SPIKES.md. Build on them; do not re-decide what they settle.',
                'Make /work/plan/PRODUCT.md the product spec (start from /work/studio/PRODUCT.md). The studio documents go into the',
                "new repo's docs/ folder, so issues can point builders at them (e.g. 'match docs/design/home.html').",
              ].join('\n')
            : plan.target === 'new'
            ? `The owner wants to plan a new project: "${plan.title}".`
            : plan.focus === 'issue'
              ? [
                  `The owner wants to revise issue #${plan.issueNumber} of the project ${plan.projectId} (code in /work/repo).`,
                  `/work/plan/${ISSUE_FILE} holds the issue as it is now: a "# Title" line, then the body. Revise that file as you`,
                  'discuss: a clear title, 2-3 lines of context, and testable acceptance criteria. Agents build it unattended from',
                  'exactly this text. Write no PRODUCT.md or plan.json. Read the code first when the change depends on it.',
                  'Comments on the issue: gh issue view <n> --json comments.',
                ].join('\n')
              : plan.focus === 'goals'
              ? [
                  `The owner wants to iterate on the goals of the project ${plan.projectId} (code in /work/repo): "${plan.title}".`,
                  'Start /work/plan/PRODUCT.md as a copy of /work/repo/docs/PRODUCT.md (if there is one) and revise it as you discuss.',
                  'Add issues to plan.json only for work the revised goals need now; none is fine.',
                ].join('\n')
              : `The owner wants to plan a change to the existing project ${plan.projectId} (code in /work/repo): "${plan.title}".`,
          plan.focus === 'issue' ? 'Make the first revision right away from what you know, then discuss.' : 'Start PRODUCT.md and plan.json in /work/plan right away from what you know, then discuss.',
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

// ---------- apply an issue conversation ----------

/**
 * Write the revised issue to GitHub. A parked task gets a fresh start with it; a queued one picks it up anyway; a
 * running one sees it at its next step (the review reads the issue fresh). The conversation stays open for more.
 */
export async function applyIssuePlan(ctx: PipelineContext, deps: Pick<ExecuteDeps, 'repoClient'>, id: number): Promise<void> {
  const plan = getPlan(ctx, id);
  if (!plan || plan.focus !== 'issue' || !plan.projectId || !plan.issueNumber) throw new Error(`No issue conversation ${id}`);
  if (!['drafting', 'failed'].includes(plan.state)) throw new Error(`The conversation is ${plan.state}`);
  const files = readPlanFiles(ctx, plan);
  if (!files.issue) throw new Error(files.errors.join(' ') || 'Nothing to apply');
  const project = ctx.store.projects().find((p) => p.id === plan.projectId)!;
  update(ctx, id, { state: 'executing' });
  try {
    const { gh } = await deps.repoClient(project);
    await gh.updateIssue(project.owner, project.id, plan.issueNumber, { title: files.issue.title, body: files.issue.body });
    await gh.comment(project.owner, project.id, plan.issueNumber, `_Revised with the planner on the factory dashboard (conversation ${id})._`);
    const taskId = `${project.id}#${plan.issueNumber}`;
    const task = ctx.store.task(taskId);
    let note = 'No factory task tracks it yet; add the factory:ready label to have it built.';
    if (task) {
      ctx.store.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(files.issue.title, taskId);
      if (task.state === 'parked') {
        ctx.store.transition(taskId, 'queued', { attempt: 0, fixRounds: 0, interruptions: 0, sessionId: null, lastFailure: null, pendingMode: 'build', notBefore: null });
        note = 'The parked task starts over with it.';
      } else if (task.state === 'queued') note = 'The queued task builds from it.';
      else if (['done', 'cancelled'].includes(task.state)) note = `The task is ${task.state}; the change doesn't reopen it.`;
      else note = 'The running task sees it from its next step; the review checks against it.';
    }
    update(ctx, id, { state: 'drafting' });
    addMessage(ctx, id, 'system', `Applied to issue #${plan.issueNumber}. ${note}`);
  } catch (e) {
    update(ctx, id, { state: 'drafting' });
    addMessage(ctx, id, 'system', `Couldn't apply: ${(e as Error).message}`);
    throw e;
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

/** A studio's documents (docs/**) for a new repo; PRODUCT.md comes from the plan itself. */
function studioDocs(ctx: Pick<PipelineContext, 'config'>, studioId: number): Record<string, string> {
  const root = join(ctx.config.paths.state, 'studios', String(studioId), 'work');
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(md|html|json|svg|css)$/i.test(n) && statSync(p).size < 512 * 1024) out[relative(root, p)] = readFileSync(p, 'utf8');
    }
  };
  walk(join(root, 'docs'));
  delete out['docs/PRODUCT.md'];
  return out;
}

export function starterFiles(file: PlanFile, product: string): Record<string, string> {
  const p = file.project!;
  const pitch = product.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? file.title;
  return {
    'README.md': `# ${p.name}\n\n${pitch}\n\nBuilt by the software factory. The spec is in [docs/PRODUCT.md](docs/PRODUCT.md).\n`,
    'docs/PRODUCT.md': product,
    'factory.yaml': `kind: ${p.kind}\npriority: ${p.priority}\n`,
    'CLAUDE.md': `# ${p.name}\n\nRead docs/PRODUCT.md for what this is. The first issue scaffolds the stack and fills in this file:\nthe commands to run, the conventions and where things are. Keep it under 150 lines.\n`,
    '.gitignore': 'node_modules/\n.venv/\n.env\n.env.*\n.factory-run/\ndist/\n.next/\ncoverage/\n',
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
        const extra = plan.studioId !== null ? studioDocs(ctx, plan.studioId) : {};
        const repo = await deps.createRepo({ name, description: pf.title, files: { ...extra, ...starterFiles(pf, files.product) } });
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

    // For existing projects, a changed spec becomes an issue like any other change: it goes through the checks,
    // review and merge, so main is never edited directly.
    const currentProduct = plan.target === 'existing' ? readRepoProduct(ctx, plan) : null;
    const specChanged = plan.target === 'existing' && normalise(currentProduct ?? '') !== normalise(files.product);
    if (plan.target === 'existing' && !specChanged && pf.issues.length === 0) throw new Error('Nothing to execute: the spec is unchanged and there are no issues.');

    // 2. Labels, including each area used.
    const areas = [...new Set(pf.issues.map((i) => i.area).filter((a): a is string => Boolean(a)))];
    if (specChanged) areas.push('docs');
    await gh.ensureLabels(project.owner, project.id, [...FACTORY_LABELS, ...areas.map((a) => ({ name: `area:${a}`, color: 'bfdadc' }))]);

    // 3. The tracking issue carries the spec (no factory:ready: nobody builds it).
    if (!result.trackingIssue) {
      const t = await gh.createIssue(project.owner, project.id, { title: `${plan.focus === 'goals' ? 'Goals' : 'Plan'}: ${pf.title}`, body: `${files.product}\n\n_Planned on the factory dashboard (plan ${id})._`, labels: ['factory:plan'] });
      result.trackingIssue = t.number;
      save();
    }

    // 4a. The spec update comes first; the other issues build on it.
    if (specChanged && !result.issues[SPEC_ISSUE_KEY]) {
      const created = await gh.createIssue(project.owner, project.id, specIssue(result.trackingIssue, currentProduct !== null, project.priority));
      result.issues[SPEC_ISSUE_KEY] = created.number;
      save();
    }
    const specDep = result.issues[SPEC_ISSUE_KEY] ? [result.issues[SPEC_ISSUE_KEY]] : [];

    // 4b. Issues, dependencies first, so each can name the real numbers it waits for.
    for (const issue of topoOrder(pf.issues)!) {
      if (result.issues[issue.key]) continue;
      const created = await gh.createIssue(project.owner, project.id, {
        title: issue.title,
        body: issueBody(issue, result.trackingIssue, [...specDep, ...issue.dependsOn.map((d) => result.issues[d]!)]),
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

export const SPEC_ISSUE_KEY = 'spec-update';

/** The issue that writes the revised spec into the repo. */
export function specIssue(trackingIssue: number, hadSpec: boolean, priority: number) {
  return {
    title: hadSpec ? 'Update docs/PRODUCT.md to the revised goals' : 'Add docs/PRODUCT.md with the project goals',
    body: [
      `${hadSpec ? 'Replace' : 'Create'} \`docs/PRODUCT.md\` with the spec in #${trackingIssue}: copy the issue body exactly, without its last line ("Planned on the factory dashboard").`,
      'Change nothing else.',
      '',
      '## Acceptance criteria',
      `- [ ] \`docs/PRODUCT.md\` matches the spec in #${trackingIssue}`,
      '- [ ] No other files change',
      '',
      `Part of the plan in #${trackingIssue}.`,
    ].join('\n'),
    labels: ['factory:ready', 'size:s', 'risk:low', `priority:${priority}`, 'area:docs'],
  };
}

const normalise = (t: string) => t.replace(/\r\n/g, '\n').trim();

/** docs/PRODUCT.md as it was on main when the planner last looked (its clone sits next to the plan). */
function readRepoProduct(ctx: Pick<PipelineContext, 'config'>, plan: Plan): string | null {
  const p = join(planDir(ctx, plan.id), 'repo', 'docs', 'PRODUCT.md');
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
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
