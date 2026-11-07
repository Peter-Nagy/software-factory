import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { buildClaudeArgs } from './claude.ts';
import { decide } from './governor.ts';
import type { PipelineContext } from './pipeline.ts';
import { createPlan, getPlan, planTurn, type Plan } from './plan.ts';
import { roleConfig, WORKER_CONFIG_MOUNT } from './roles.ts';
import { runInContainer } from './runner/container.ts';
import type { Model } from './types.ts';
import { snapshotAfterRun } from './usage.ts';

/**
 * The Studio takes an idea to an executable build plan in phases. Each phase is one agent role with its own
 * conversation, writing its document into a shared folder (/work/docs) that later phases read. The owner reads,
 * comments, discusses and approves; in autopilot the factory approves phases that report they're done and have no
 * open questions, and stops at the research verdict and at the build plan.
 * The last phase is a regular plan (plans table, Execute button), so a studio ends exactly like plan mode does.
 */

export type PhaseKey = 'brief' | 'research' | 'product' | 'design' | 'architecture' | 'spikes' | 'plan' | 'launch';
export interface PhaseDef {
  key: PhaseKey;
  title: string;
  model: Model;
  /** The document this phase owns, relative to the studio's work folder. */
  doc: string;
  /** Estimated share of a 5-hour window per turn, for the governor and the UI. */
  costPct: number;
  optional?: boolean;
}

export const PHASES: PhaseDef[] = [
  { key: 'brief', title: 'Brief', model: 'opus', doc: 'docs/BRIEF.md', costPct: 4 },
  { key: 'research', title: 'Research', model: 'opus', doc: 'docs/RESEARCH.md', costPct: 10 },
  { key: 'product', title: 'Product', model: 'opus', doc: 'docs/PRODUCT.md', costPct: 5 },
  { key: 'design', title: 'Design', model: 'opus', doc: 'docs/DESIGN.md', costPct: 8 },
  { key: 'architecture', title: 'Architecture', model: 'opus', doc: 'docs/ARCHITECTURE.md', costPct: 5 },
  { key: 'spikes', title: 'Spikes', model: 'sonnet', doc: 'docs/SPIKES.md', costPct: 6, optional: true },
  { key: 'plan', title: 'Build plan', model: 'opus', doc: 'plan/plan.json', costPct: 4 },
  // Opens once the build plan is executed, so it's prepared while the factory builds.
  { key: 'launch', title: 'Launch kit', model: 'opus', doc: 'docs/LAUNCH.md', costPct: 6, optional: true },
];
export const phaseDef = (k: string): PhaseDef => {
  const d = PHASES.find((p) => p.key === k);
  if (!d) throw new Error(`Unknown phase ${k}`);
  return d;
};

/**
 * locked: an earlier phase isn't approved yet; ready: can start; queued: autopilot will start it when the governor
 * allows; thinking: an agent is on it; drafting: has a draft, waiting for the owner; approved; stale: an earlier
 * phase changed after this was approved; skipped (spikes with nothing to test).
 */
export type PhaseState = 'locked' | 'ready' | 'queued' | 'thinking' | 'drafting' | 'approved' | 'stale' | 'skipped';
export type StudioMode = 'guided' | 'autopilot';

export interface Studio {
  id: number;
  title: string;
  mode: StudioMode;
  planId: number | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface PhaseRow {
  phase: PhaseKey;
  state: PhaseState;
  model: Model;
  sessionId: string | null;
  note: string | null;
  updatedAt: number;
  /** running: a stand-in agent is answering the interview; review: it has finished and the owner should check its answers. */
  autoAnswer: AutoAnswer;
}
export type AutoAnswer = 'running' | 'review' | null;
export interface StudioMessage {
  id: number;
  phase: PhaseKey;
  /** standin: answers the stand-in agent gave on the owner's behalf. */
  role: 'owner' | 'agent' | 'system' | 'standin';
  text: string;
  at: number;
}

/** What each phase agent writes to /work/status/<phase>.json at the end of every turn. */
const OptionSchema = z.union([
  z.string().min(1).transform((label) => ({ label, description: '' })),
  z.object({ label: z.string().min(1).max(120), description: z.string().max(400).default('') }),
]);
/** One interview question. A plain string is a free-text question. */
export const StudioQuestionSchema = z.union([
  z.string().min(1).transform((question) => ({ question, header: '', why: '', options: [], multiSelect: false, recommended: null })),
  z.object({
    question: z.string().min(1).max(600),
    header: z.string().max(40).default(''),
    why: z.string().max(400).default(''),
    options: z.array(OptionSchema).max(6).default([]),
    multiSelect: z.boolean().default(false),
    recommended: z.string().nullable().default(null),
  }),
]);
export type StudioQuestion = z.infer<typeof StudioQuestionSchema>;

export const PhaseStatusSchema = z.object({
  ready: z.boolean(),
  questions: z.array(StudioQuestionSchema).max(15).default([]),
  /** The interview's topics and whether each is settled, so the owner sees how far along it is. */
  coverage: z.array(z.object({ topic: z.string().min(1).max(80), done: z.boolean() })).max(20).default([]),
  summary: z.string().default(''),
  verdict: z.enum(['build', 'narrow', 'dont']).optional(), // research only
});
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

export const SpikesSchema = z.array(z.object({ key: z.string().regex(/^[a-z0-9-]{1,40}$/), question: z.string().min(5), approach: z.string().default('') })).max(8);

type Row = Record<string, unknown>;
const toStudio = (r: Row): Studio => ({
  id: Number(r.id), title: String(r.title), mode: r.mode as StudioMode, planId: r.plan_id == null ? null : Number(r.plan_id),
  archived: Number(r.archived) === 1, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});
const toPhase = (r: Row): PhaseRow => ({
  phase: r.phase as PhaseKey, state: r.state as PhaseState, model: r.model as Model, sessionId: (r.session_id as string | null) ?? null,
  note: (r.note as string | null) ?? null, updatedAt: Number(r.updated_at), autoAnswer: (r.auto_answer as AutoAnswer) ?? null,
});

type Ctx = Pick<PipelineContext, 'store' | 'now' | 'config'>;

// ---------- storage ----------

export const studioDir = (ctx: Pick<PipelineContext, 'config'>, id: number) => join(ctx.config.paths.state, 'studios', String(id));
export const studioWork = (ctx: Pick<PipelineContext, 'config'>, id: number) => join(studioDir(ctx, id), 'work');

export function listStudios(ctx: Ctx): Studio[] {
  return (ctx.store.db.prepare('SELECT * FROM studios WHERE archived = 0 ORDER BY updated_at DESC').all() as Row[]).map(toStudio);
}
export function getStudio(ctx: Ctx, id: number): Studio | null {
  const r = ctx.store.db.prepare('SELECT * FROM studios WHERE id = ?').get(id) as Row | undefined;
  return r ? toStudio(r) : null;
}
export function studioPhases(ctx: Ctx, id: number): PhaseRow[] {
  const rows = (ctx.store.db.prepare('SELECT * FROM studio_phases WHERE studio_id = ?').all(id) as Row[]).map(toPhase);
  return PHASES.map((d) => rows.find((r) => r.phase === d.key)!).filter(Boolean);
}
export function phaseRow(ctx: Ctx, id: number, phase: PhaseKey): PhaseRow {
  const r = ctx.store.db.prepare('SELECT * FROM studio_phases WHERE studio_id = ? AND phase = ?').get(id, phase) as Row | undefined;
  if (!r) throw new Error(`No phase ${phase} in studio ${id}`);
  return toPhase(r);
}
export function studioMessages(ctx: Ctx, id: number, phase?: PhaseKey): StudioMessage[] {
  const rows = (phase
    ? ctx.store.db.prepare('SELECT * FROM studio_messages WHERE studio_id = ? AND phase = ? ORDER BY id').all(id, phase)
    : ctx.store.db.prepare('SELECT * FROM studio_messages WHERE studio_id = ? ORDER BY id').all(id)) as Row[];
  return rows.map((r) => ({ id: Number(r.id), phase: r.phase as PhaseKey, role: r.role as StudioMessage['role'], text: String(r.text), at: Number(r.at) }));
}

function setPhase(ctx: Ctx, id: number, phase: PhaseKey, patch: { state?: PhaseState; sessionId?: string | null; note?: string | null; model?: Model }): void {
  const cur = phaseRow(ctx, id, phase);
  ctx.store.db
    .prepare('UPDATE studio_phases SET state = ?, session_id = ?, note = ?, model = ?, updated_at = ? WHERE studio_id = ? AND phase = ?')
    .run(patch.state ?? cur.state, patch.sessionId === undefined ? cur.sessionId : patch.sessionId, patch.note === undefined ? cur.note : patch.note, patch.model ?? cur.model, ctx.now(), id, phase);
  ctx.store.db.prepare('UPDATE studios SET updated_at = ? WHERE id = ?').run(ctx.now(), id);
}

function addMessage(ctx: Ctx, id: number, phase: PhaseKey, role: StudioMessage['role'], text: string): void {
  ctx.store.db.prepare('INSERT INTO studio_messages (studio_id, phase, role, text, at) VALUES (?, ?, ?, ?, ?)').run(id, phase, role, text, ctx.now());
  ctx.store.db.prepare('UPDATE studios SET updated_at = ? WHERE id = ?').run(ctx.now(), id);
}

export function createStudio(ctx: Ctx, p: { title: string; mode?: StudioMode }): Studio {
  const now = ctx.now();
  const r = ctx.store.db.prepare('INSERT INTO studios (title, mode, created_at, updated_at) VALUES (?, ?, ?, ?)').run(p.title.slice(0, 100), p.mode === 'autopilot' ? 'autopilot' : 'guided', now, now);
  const id = Number(r.lastInsertRowid);
  for (const d of PHASES) {
    ctx.store.db.prepare('INSERT INTO studio_phases (studio_id, phase, state, model, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, d.key, d.key === 'brief' ? 'ready' : 'locked', d.model, now);
  }
  for (const sub of ['docs/design', 'docs/launch', 'status', 'spikes']) mkdirSync(join(studioWork(ctx, id), sub), { recursive: true });
  mkdirSync(join(studioDir(ctx, id), 'sessions'), { recursive: true });
  return getStudio(ctx, id)!;
}

export function setStudioMode(ctx: Ctx, id: number, mode: StudioMode): void {
  ctx.store.db.prepare('UPDATE studios SET mode = ?, updated_at = ? WHERE id = ?').run(mode, ctx.now(), id);
  if (mode === 'autopilot') queueNextIfIdle(ctx, id);
}

export function archiveStudio(ctx: Ctx, id: number): void {
  if (studioPhases(ctx, id).some((p) => p.state === 'thinking')) throw new Error('Wait until the agent has finished');
  ctx.store.db.prepare('UPDATE studios SET archived = 1, updated_at = ? WHERE id = ?').run(ctx.now(), id);
}

export function setPhaseModel(ctx: Ctx, id: number, phase: PhaseKey, model: Model): void {
  setPhase(ctx, id, phase, { model });
}

// ---------- files ----------

export function readDoc(ctx: Ctx, id: number, path: string): string | null {
  const p = join(studioWork(ctx, id), path);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

export function readStatus(ctx: Ctx, id: number, phase: PhaseKey): PhaseStatus | null {
  const raw = readDoc(ctx, id, `status/${phase}.json`);
  if (!raw) return null;
  try {
    const r = PhaseStatusSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function readSpikes(ctx: Ctx, id: number): z.infer<typeof SpikesSchema> | null {
  const raw = readDoc(ctx, id, 'docs/spikes.json');
  if (raw === null) return null;
  try {
    const r = SpikesSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Design mockups: self-contained HTML files in docs/design. */
/** HTML pages agents wrote: design mockups (`home.html`) and launch pages (`launch/landing.html`). */
export function listMockups(ctx: Ctx, id: number): string[] {
  const html = (sub: string) => {
    const dir = join(studioWork(ctx, id), 'docs', sub);
    return existsSync(dir) ? readdirSync(dir).filter((f) => /^[a-z0-9][a-z0-9._-]*\.html$/i.test(f)).sort() : [];
  };
  return [...html('design'), ...html('launch').map((f) => `launch/${f}`)];
}
/** Where a listed mockup lives on disk (names come from listMockups only). */
export const mockupPath = (ctx: Ctx, id: number, name: string) => join(studioWork(ctx, id), 'docs', name.startsWith('launch/') ? '' : 'design', name);

// ---------- transitions (pure decisions over the stored rows) ----------

const index = (k: PhaseKey) => PHASES.findIndex((p) => p.key === k);

/** May the owner talk to this phase now? */
export function canTalk(state: PhaseState): boolean {
  return state === 'ready' || state === 'drafting' || state === 'stale' || state === 'approved';
}

/**
 * Approve a phase: later phases that were worked on become stale (they built on the old version), the next one
 * opens. Spikes are skipped when the architecture names nothing to test.
 */
export function approvePhase(ctx: Ctx, id: number, phase: PhaseKey): void {
  const def = phaseDef(phase);
  if (def.key === 'plan') throw new Error('The build plan is approved by executing it');
  const row = phaseRow(ctx, id, phase);
  if (!['drafting', 'stale', 'approved'].includes(row.state)) throw new Error(`${def.title} has nothing to approve yet`);
  if (readDoc(ctx, id, def.doc) === null) throw new Error(`${def.title} has no document yet (${def.doc})`);
  setPhase(ctx, id, phase, { state: 'approved', note: null });
  setAutoAnswer(ctx, id, phase, null);
  for (const later of PHASES.slice(index(phase) + 1)) {
    const r = phaseRow(ctx, id, later.key);
    if (['approved', 'drafting'].includes(r.state)) setPhase(ctx, id, later.key, { state: 'stale', note: `${def.title} changed after this was written.` });
  }
  openNext(ctx, id, phase);
  queueNextIfIdle(ctx, id);
}

function openNext(ctx: Ctx, id: number, after: PhaseKey): void {
  const next = PHASES[index(after) + 1];
  if (!next) return;
  const r = phaseRow(ctx, id, next.key);
  if (r.state !== 'locked' && r.state !== 'skipped') return;
  if (next.key === 'spikes') {
    const spikes = readSpikes(ctx, id) ?? [];
    if (spikes.length === 0) {
      setPhase(ctx, id, 'spikes', { state: 'skipped', note: 'The architecture names no risky unknowns to test.' });
      openNext(ctx, id, 'spikes');
      return;
    }
  }
  setPhase(ctx, id, next.key, { state: 'ready', note: null });
}

export function skipPhase(ctx: Ctx, id: number, phase: PhaseKey): void {
  if (!phaseDef(phase).optional) throw new Error(`${phaseDef(phase).title} can't be skipped`);
  if (phaseRow(ctx, id, phase).state === 'thinking') throw new Error('Wait until the agent has finished');
  setPhase(ctx, id, phase, { state: 'skipped', note: 'Skipped by you.' });
  openNext(ctx, id, phase);
  queueNextIfIdle(ctx, id);
}

/** In autopilot, the first phase that's open and untouched gets queued (the main loop starts it under the governor). */
export function queueNextIfIdle(ctx: Ctx, id: number): void {
  const studio = getStudio(ctx, id);
  if (!studio || studio.mode !== 'autopilot' || studio.archived) return;
  const phases = studioPhases(ctx, id);
  if (phases.some((p) => p.state === 'thinking' || p.state === 'queued')) return;
  const open = phases.find((p) => p.state === 'ready' || p.state === 'stale');
  if (!open || open.phase === 'plan' && studio.planId !== null && getPlan(ctx as PipelineContext, studio.planId)?.state !== 'drafting') return;
  setPhase(ctx, id, open.phase, { state: 'queued', note: 'Starts when the usage budget allows.' });
}

/** After an autopilot turn: approve and move on if the agent is done and has no questions; otherwise stop for the owner. */
export function autopilotAfterTurn(ctx: Ctx, id: number, phase: PhaseKey): 'continued' | 'stopped' {
  const studio = getStudio(ctx, id)!;
  if (studio.mode !== 'autopilot' || phase === 'plan') return 'stopped';
  const status = readStatus(ctx, id, phase);
  if (!status?.ready || status.questions.length) {
    addMessage(ctx, id, phase, 'system', status?.questions.length ? 'Autopilot paused: the agent has questions for you.' : 'Autopilot paused: the agent didn\'t mark this phase done.');
    return 'stopped';
  }
  if (phase === 'research' && status.verdict !== 'build') {
    addMessage(ctx, id, phase, 'system', `Autopilot paused at the go/no-go: the verdict is "${status.verdict === 'dont' ? "don't build" : status.verdict ?? 'missing'}". Read it, then approve to continue anyway, or archive the idea.`);
    return 'stopped';
  }
  approvePhase(ctx, id, phase);
  return 'continued';
}

// ---------- one agent turn ----------

const busy = new Set<string>();
export const isBusy = (id: number, phase: PhaseKey) => busy.has(`${id}:${phase}`);

/** What the agent is asked to do when a phase starts, is refreshed, or is resumed by autopilot. */
export function startMessage(phase: PhaseKey, state: PhaseState, auto: boolean): string {
  if (state === 'stale') return 'Earlier documents changed since you wrote yours. Read them again and update your document to match; say briefly what changed.';
  return auto
    ? `Autopilot: draft the ${phaseDef(phase).title.toLowerCase()} phase now from the approved documents, deciding sensibly where they leave room. Ask only what truly needs the owner.`
    : `Start the ${phaseDef(phase).title.toLowerCase()} phase from the approved documents.`;
}

function phaseBrief(ctx: Pick<PipelineContext, 'config'>, phase: PhaseKey): string {
  const p = join(ctx.config.paths.workerConfig, 'prompts', 'studio', `${phase}.md`);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/**
 * One turn with a phase's agent. Phases 1-6 run here; the build plan is a linked plan (planTurn).
 * Runs in the background; the dashboard polls the studio.
 */
export async function studioTurn(ctx: PipelineContext, id: number, phase: PhaseKey, text: string, opts: { auto?: boolean; standin?: boolean } = {}): Promise<boolean> {
  const studio = getStudio(ctx, id);
  if (!studio) throw new Error(`No studio ${id}`);
  const row = phaseRow(ctx, id, phase);
  if (!canTalk(row.state) && row.state !== 'queued') throw new Error(`${phaseDef(phase).title} is ${row.state}`);
  const key = `${id}:${phase}`;
  if (busy.has(key)) throw new Error('The agent is still working on this phase');
  busy.add(key);
  try {
    if (phase === 'plan') {
      await planPhaseTurn(ctx, studio, text);
      return true;
    }
    return await phaseTurn(ctx, studio, row, text, opts.auto ?? false, opts.standin ?? false);
  } finally {
    busy.delete(key);
  }
}

/** One `claude` run for a studio: a phase agent (resumable session) or the stand-in that answers for the owner. */
async function runStudioAgent(ctx: PipelineContext, studio: Studio, phase: PhaseKey, o: { prompt: string; model: Model; resume: string | null; kind: 'phase' | 'standin' }) {
  const { config, store } = ctx;
  const id = studio.id;
  const role = roleConfig(config, 'studio');
  const env = { [config.worker.claudeTokenEnv]: await ctx.secrets.get(config.worker.claudeTokenEnv) };
  const standin = o.kind === 'standin';
  const args = buildClaudeArgs({
    prompt: o.prompt,
    model: o.model,
    effort: role.effort,
    maxTurns: standin ? 30 : role.maxTurns,
    resumeSessionId: o.resume,
    appendSystemPromptFile: `${WORKER_CONFIG_MOUNT}/prompts/${standin ? 'studio-standin.md' : 'studio.md'}`,
  });
  mkdirSync(config.paths.logs, { recursive: true });
  const logPath = join(config.paths.logs, `studio-${id}-${phase}${standin ? '-standin' : ''}-${Date.now()}.jsonl`);
  const sessionsDir = join(studioDir(ctx, id), 'sessions', standin ? `${phase}-standin` : phase);
  mkdirSync(sessionsDir, { recursive: true });
  const runId = store.startRun({ taskId: null, role: 'studio', model: o.model, logPath, usageBefore: store.latestUsage(), subject: `studio:${id}:${phase}${standin ? ':standin' : ''}` });
  const result = await runInContainer(
    {
      name: `factory-studio-${id}-${phase}${standin ? '-standin' : ''}-${Date.now()}`,
      image: config.worker.image,
      worktree: studioWork(ctx, id),
      workerConfigDir: config.paths.workerConfig,
      sessionsDir,
      cpus: config.worker.cpus,
      memoryGb: config.worker.memoryGb,
      envNames: Object.keys(env),
      labels: { 'factory.role': 'studio', 'factory.studio': String(id), 'factory.phase': phase, ...(standin ? { 'factory.standin': '1' } : {}) },
    },
    args,
    { env, timeoutMs: role.timeoutMinutes * 60_000, logPath },
  );
  store.finishRun(runId, result, result.resultText);
  const snap = snapshotAfterRun(store.latestUsage(), result, ctx.now());
  if (snap) store.recordUsage(snap);
  return result;
}

async function phaseTurn(ctx: PipelineContext, studio: Studio, row: PhaseRow, text: string, auto: boolean, standin = false): Promise<boolean> {
  const id = studio.id;
  const def = phaseDef(row.phase);
  const wasState = row.state;
  addMessage(ctx, id, row.phase, standin ? 'standin' : auto ? 'system' : 'owner', text);
  setPhase(ctx, id, row.phase, { state: 'thinking', note: null });
  try {
    const first = row.sessionId === null;
    // The owner can switch modes between turns, so every turn says which one applies.
    const mode = studio.mode === 'autopilot'
      ? '[Mode: autopilot. Don\'t interview: decide sensibly and record each decision; ask only what truly blocks you.]'
      : '[Mode: guided. Interview the owner (see "Interviewing") until every specific your document needs is settled.]';
    const prompt = first
      ? [
          `Studio: "${studio.title}". You own the ${def.title} phase. Your document: /work/${def.doc}.`,
          'Earlier phases\' approved documents are in /work/docs; read the ones that exist before writing.',
          `At the end of every turn write /work/status/${row.phase}.json: {"ready": true|false, "questions": [...], "coverage": [...], "summary": "one line"${row.phase === 'research' ? ', "verdict": "build"|"narrow"|"dont"' : ''}} (format in your instructions).`,
          '',
          phaseBrief(ctx, row.phase),
          '',
          mode,
          `Owner: ${text}`,
        ].join('\n')
      : `${mode}\n\n${standin ? `${STANDIN_NOTE}\n\n` : ''}${text}`;
    const result = await runStudioAgent(ctx, studio, row.phase, { prompt, model: row.model, resume: row.sessionId, kind: 'phase' });
    if (result.sessionId) setPhase(ctx, id, row.phase, { sessionId: result.sessionId });
    if (result.ok) {
      addMessage(ctx, id, row.phase, 'agent', result.resultText || '(no reply)');
      const hasDoc = readDoc(ctx, id, def.doc) !== null;
      setPhase(ctx, id, row.phase, { state: hasDoc ? 'drafting' : wasState === 'queued' ? 'ready' : wasState, note: null });
      const paused = hasDoc && auto && autopilotAfterTurn(ctx, id, row.phase) === 'stopped';
      // Tell the owner when the studio waits on them (not mid-way through a stand-in interview).
      const asks = readStatus(ctx, id, row.phase)?.questions.length ?? 0;
      if (!standin && phaseRow(ctx, id, row.phase).autoAnswer === null && (paused || (asks > 0 && studio.mode === 'guided'))) {
        const what = asks ? `the ${def.title.toLowerCase()} agent has ${asks === 1 ? 'a question' : `${asks} questions`}` : `${def.title} is ready for you to look at`;
        await ctx.notify('question', `Studio "${studio.title}": ${what}.`).catch(() => undefined);
      }
      return true;
    } else {
      const why = result.hitUsageLimit ? 'The usage limit was reached; try again after it resets.' : `The agent stopped: ${result.resultText.slice(0, 500) || 'no result'}`;
      addMessage(ctx, id, row.phase, 'system', why);
      setPhase(ctx, id, row.phase, { state: readDoc(ctx, id, def.doc) !== null ? 'drafting' : 'ready' });
    }
  } catch (e) {
    addMessage(ctx, id, row.phase, 'system', `Couldn't run the agent: ${(e as Error).message}`);
    setPhase(ctx, id, row.phase, { state: readDoc(ctx, id, def.doc) !== null ? 'drafting' : 'ready' });
  }
  return false;
}

/** The build plan phase is a plan in plan mode, linked to the studio; its planner reads the studio's documents. */
export function ensureStudioPlan(ctx: PipelineContext, studio: Studio): Plan {
  if (studio.planId !== null) {
    const p = getPlan(ctx, studio.planId);
    if (p) return p;
  }
  const plan = createPlan(ctx, { title: studio.title, target: 'new', model: phaseRow(ctx, studio.id, 'plan').model });
  ctx.store.db.prepare('UPDATE plans SET studio_id = ? WHERE id = ?').run(studio.id, plan.id);
  ctx.store.db.prepare('UPDATE studios SET plan_id = ?, updated_at = ? WHERE id = ?').run(plan.id, ctx.now(), studio.id);
  return getPlan(ctx, plan.id)!;
}

async function planPhaseTurn(ctx: PipelineContext, studio: Studio, text: string): Promise<void> {
  const plan = ensureStudioPlan(ctx, studio);
  setPhase(ctx, studio.id, 'plan', { state: 'thinking', note: null });
  try {
    await planTurn(ctx, plan.id, text);
  } finally {
    syncPlanPhase(ctx, studio.id);
  }
}

/** The plan phase mirrors its plan: executed = approved. */
export function syncPlanPhase(ctx: Ctx, id: number): void {
  const studio = getStudio(ctx, id);
  if (!studio?.planId) return;
  const plan = getPlan(ctx as PipelineContext, studio.planId);
  const row = phaseRow(ctx, id, 'plan');
  if (!plan || row.state === 'locked') return;
  const state: PhaseState = plan.state === 'executed' ? 'approved' : plan.state === 'thinking' || plan.state === 'executing' ? 'thinking' : row.state === 'stale' ? 'stale' : 'drafting';
  if (state !== row.state) setPhase(ctx, id, 'plan', { state });
  // The repo exists: the launch kit can be prepared while the factory builds.
  if (state === 'approved' && phaseRow(ctx, id, 'launch').state === 'locked') {
    setPhase(ctx, id, 'launch', { state: 'ready', note: null });
    queueNextIfIdle(ctx, id);
  }
}

// ---------- autopilot, driven by the main loop ----------

/**
 * Start queued phases the governor allows (one per studio at a time). `running` is what the loop already has
 * in flight, so studio work shares the budget with builds and reviews.
 */
export function startQueuedPhases(ctx: PipelineContext, running: { estimatedCostPct: number }[], start: (work: Promise<void>) => void): string[] {
  const started: string[] = [];
  const pausedUntil = Number(ctx.store.getSetting('pausedUntil') ?? 0) || null;
  for (const studio of listStudios(ctx).filter((s) => s.mode === 'autopilot')) {
    const queued = studioPhases(ctx, studio.id).find((p) => p.state === 'queued');
    if (!queued || isBusy(studio.id, queued.phase)) continue;
    const def = phaseDef(queued.phase);
    const verdict = decide(ctx.config.governor, {
      now: ctx.now(), usage: ctx.store.latestUsage(), model: queued.model, estimatedCostPct: def.costPct,
      running: [...running, ...started.map(() => ({ estimatedCostPct: def.costPct }))], pausedUntil, ownUseDetected: ctx.store.getSetting('ownUseDetected') === '1',
    });
    if (!verdict.allow) {
      if (queued.note !== `Waiting: ${verdict.reason}.`) setPhase(ctx, studio.id, queued.phase, { note: `Waiting: ${verdict.reason}.` });
      continue;
    }
    const prior = studioMessages(ctx, studio.id, queued.phase).length ? 'stale' : 'ready';
    const message = startMessage(queued.phase, (queued.note ?? '').includes('changed') ? 'stale' : prior === 'stale' ? 'stale' : 'ready', true);
    start(studioTurn(ctx, studio.id, queued.phase, message, { auto: true }).then(() => undefined, (e: Error) => console.error(`Studio ${studio.id} ${queued.phase}: ${e.message}`)));
    started.push(`${studio.id}:${queued.phase}`);
  }
  return started;
}

/** After a restart nothing is thinking: put interrupted phases back so they can be retried. */
export function recoverStudios(ctx: Ctx): void {
  for (const studio of listStudios(ctx)) {
    for (const p of studioPhases(ctx, studio.id)) {
      if (p.autoAnswer === 'running') {
        setAutoAnswer(ctx, studio.id, p.phase, null);
        addMessage(ctx, studio.id, p.phase, 'system', 'A restart stopped the stand-in; skip again to continue.');
      }
      if (p.state === 'thinking' && p.phase !== 'plan') {
        setPhase(ctx, studio.id, p.phase, { state: readDoc(ctx, studio.id, phaseDef(p.phase).doc) !== null ? 'drafting' : 'ready', note: 'Interrupted by a restart; send a message to continue.' });
      }
    }
    syncPlanPhase(ctx, studio.id);
  }
}

// ---------- answering the interview for the owner ----------

/** Rounds of stand-in answers before it stops and hands over to the owner. */
export const MAX_STANDIN_ROUNDS = 6;
const STANDIN_NOTE = '[These answers come from a stand-in for the owner, who reviews them afterwards. Keep interviewing as usual; ask fewer, sharper follow-ups.]';

export const StandinAnswersSchema = z.array(z.object({ answer: z.string().min(1).max(4000), reason: z.string().max(1000).default('') }));
export interface StudioAnswer {
  id: number;
  phase: PhaseKey;
  /** One skip = one batch; the review shows the latest. */
  batch: number;
  round: number;
  question: StudioQuestion;
  answer: string;
  reason: string;
  edited: boolean;
}

export function studioAnswers(ctx: Ctx, id: number, phase?: PhaseKey): StudioAnswer[] {
  const rows = (phase
    ? ctx.store.db.prepare('SELECT * FROM studio_answers WHERE studio_id = ? AND phase = ? ORDER BY id').all(id, phase)
    : ctx.store.db.prepare('SELECT * FROM studio_answers WHERE studio_id = ? ORDER BY id').all(id)) as Row[];
  return rows.map((r) => ({
    id: Number(r.id), phase: r.phase as PhaseKey, batch: Number(r.batch), round: Number(r.round), question: JSON.parse(String(r.question)) as StudioQuestion,
    answer: String(r.answer), reason: String(r.reason), edited: Number(r.edited) === 1,
  }));
}

/** The answers from the latest skip, the ones under review. */
export function latestAnswers(ctx: Ctx, id: number, phase: PhaseKey): StudioAnswer[] {
  const all = studioAnswers(ctx, id, phase);
  const last = Math.max(0, ...all.map((a) => a.batch));
  return all.filter((a) => a.batch === last);
}

function setAutoAnswer(ctx: Ctx, id: number, phase: PhaseKey, v: AutoAnswer): void {
  ctx.store.db.prepare('UPDATE studio_phases SET auto_answer = ? WHERE studio_id = ? AND phase = ?').run(v, id, phase);
}

/** The same shape the dashboard's answer form sends: each question quoted, the answer under it. */
export function composeAnswers(pairs: { question: string; answer: string }[], intro = 'Answers to your questions:'): string {
  return `${intro}\n\n${pairs.map((p) => `> ${p.question.replace(/\n/g, '\n> ')}\n${p.answer}`).join('\n\n')}`;
}

/** Whether the owner can hand this phase's open questions to the stand-in now. */
export function canAutoAnswer(ctx: Ctx, id: number, phase: PhaseKey): string | null {
  const row = phaseRow(ctx, id, phase);
  if (phase === 'plan') return 'The build plan has no interview';
  if (isBusy(id, phase) || row.state === 'thinking' || row.state === 'queued') return 'The agent is still working on this phase';
  if (row.autoAnswer === 'running') return 'Already answering';
  if (!readStatus(ctx, id, phase)?.questions.length) return 'There are no open questions';
  return null;
}

/** The stand-in's prompt: everything the owner has said, the answers so far, and this round's questions. */
function standinPrompt(ctx: Ctx, studio: Studio, phase: PhaseKey, questions: StudioQuestion[]): string {
  const said = studioMessages(ctx, studio.id).filter((m) => m.role === 'owner').map((m) => `[${phaseDef(m.phase).title}] ${m.text}`).join('\n\n---\n\n');
  const before = studioAnswers(ctx, studio.id).map((a) => `> ${a.question.question}\n${a.answer}${a.edited ? ' (the owner set this)' : ''}`).join('\n\n');
  return [
    `Studio: "${studio.title}". The ${phaseDef(phase).title} agent is interviewing the owner, who asked you to answer for them.`,
    'Approved and draft documents are in /work/docs; read the ones that matter before answering.',
    '',
    '## What the owner has said (their own words carry most weight)',
    (said || '(nothing yet)').slice(-30_000),
    '',
    '## Answers given so far',
    (before || '(none)').slice(-20_000),
    '',
    '## Questions to answer now (JSON)',
    JSON.stringify(questions, null, 1),
    '',
    `Write /work/status/${phase}.answers.json: one {"answer", "reason"} per question, in the same order.`,
  ].join('\n');
}

async function standinRound(ctx: PipelineContext, studio: Studio, phase: PhaseKey, questions: StudioQuestion[], round: number): Promise<{ answer: string; reason: string }[] | string> {
  const key = `${studio.id}:${phase}`;
  if (busy.has(key)) return 'The agent is still working on this phase';
  busy.add(key);
  const was = phaseRow(ctx, studio.id, phase);
  setPhase(ctx, studio.id, phase, { state: 'thinking', note: `Answering for you, round ${round}.` });
  const file = join(studioWork(ctx, studio.id), 'status', `${phase}.answers.json`);
  try {
    rmSync(file, { force: true });
    const result = await runStudioAgent(ctx, studio, phase, { prompt: standinPrompt(ctx, studio, phase, questions), model: was.model, resume: null, kind: 'standin' });
    if (!result.ok) return result.hitUsageLimit ? 'the usage limit was reached' : `the stand-in stopped: ${result.resultText.slice(0, 300) || 'no result'}`;
    if (!existsSync(file)) return 'the stand-in wrote no answers';
    const parsed = StandinAnswersSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success || parsed.data.length !== questions.length) return 'the stand-in\'s answers didn\'t match the questions';
    return parsed.data;
  } catch (e) {
    return (e as Error).message;
  } finally {
    setPhase(ctx, studio.id, phase, { state: was.state, note: was.note });
    busy.delete(key);
  }
}

/**
 * The owner pressed Skip: a stand-in answers the open questions, the phase agent continues, and so on until the
 * phase agent has no more questions (or after MAX_STANDIN_ROUNDS). Then the owner reviews the answers.
 */
export async function autoInterview(ctx: PipelineContext, id: number, phase: PhaseKey): Promise<void> {
  const why = canAutoAnswer(ctx, id, phase);
  if (why) throw new Error(why);
  setAutoAnswer(ctx, id, phase, 'running');
  const batch = Number((ctx.store.db.prepare('SELECT COALESCE(MAX(batch), 0) + 1 AS b FROM studio_answers WHERE studio_id = ? AND phase = ?').get(id, phase) as Row).b);
  addMessage(ctx, id, phase, 'system', 'You skipped the interview: a stand-in answers for you, then you review the answers.');
  let rounds = 0;
  let problem: string | null = null;
  while (rounds < MAX_STANDIN_ROUNDS) {
    if (phaseRow(ctx, id, phase).autoAnswer !== 'running') return; // the owner took over
    const questions = readStatus(ctx, id, phase)?.questions ?? [];
    if (!questions.length) break;
    const studio = getStudio(ctx, id)!;
    const answers = await standinRound(ctx, studio, phase, questions, rounds + 1);
    if (typeof answers === 'string') {
      problem = answers;
      break;
    }
    if (phaseRow(ctx, id, phase).autoAnswer !== 'running') return;
    rounds += 1;
    const insert = ctx.store.db.prepare('INSERT INTO studio_answers (studio_id, phase, batch, round, question, answer, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    questions.forEach((q, i) => insert.run(id, phase, batch, rounds, JSON.stringify(q), answers[i]!.answer, answers[i]!.reason, ctx.now()));
    const ok = await studioTurn(ctx, id, phase, composeAnswers(questions.map((q, i) => ({ question: q.question, answer: answers[i]!.answer }))), { standin: true });
    if (!ok) {
      problem = 'the phase agent stopped';
      break;
    }
  }
  if (phaseRow(ctx, id, phase).autoAnswer !== 'running') return;
  const left = readStatus(ctx, id, phase)?.questions.length ?? 0;
  if (rounds === 0) {
    setAutoAnswer(ctx, id, phase, null);
    addMessage(ctx, id, phase, 'system', `Couldn't answer for you: ${problem ?? 'nothing to answer'}. Answer the questions yourself or try again.`);
    return;
  }
  setAutoAnswer(ctx, id, phase, 'review');
  const end = problem ? `It stopped early (${problem}).` : left ? `It stopped after ${MAX_STANDIN_ROUNDS} rounds with ${left} questions still open.` : 'The agent has no more questions.';
  addMessage(ctx, id, phase, 'system', `Answered ${rounds} round${rounds === 1 ? '' : 's'} for you. ${end} Review the answers, change any, then continue.`);
  setPhase(ctx, id, phase, { note: 'Review the answers given for you, then continue.' });
  await ctx.notify('question', `Studio "${getStudio(ctx, id)!.title}": ${phaseDef(phase).title} answers are ready for your review (${rounds} round${rounds === 1 ? '' : 's'}).`).catch(() => undefined);
}

/** The owner wants to answer themselves again: the loop stops after the current step. */
export function stopAutoInterview(ctx: Ctx, id: number, phase: PhaseKey): void {
  if (phaseRow(ctx, id, phase).autoAnswer !== 'running') return;
  setAutoAnswer(ctx, id, phase, null);
  addMessage(ctx, id, phase, 'system', 'Stopped answering for you.');
}

/**
 * The owner reviewed the stand-in's answers. Changed answers go to the phase agent as one message (the interview
 * continues from there); with none changed, the phase is approved and the next one starts.
 */
export function reviewAnswers(ctx: Ctx, id: number, phase: PhaseKey, edits: { id: number; answer: string }[]): { message: string | null; approved: boolean; next: { phase: PhaseKey; state: PhaseState } | null } {
  const row = phaseRow(ctx, id, phase);
  if (row.autoAnswer !== 'review') throw new Error('There are no answers to review');
  const byId = new Map(latestAnswers(ctx, id, phase).map((a) => [a.id, a]));
  const changed = edits
    .map((e) => ({ a: byId.get(e.id), answer: e.answer.trim() }))
    .filter((e): e is { a: StudioAnswer; answer: string } => !!e.a && !!e.answer && e.answer !== e.a.answer);
  if (!changed.length) approvePhase(ctx, id, phase); // throws when there's nothing to approve yet; the review stays open
  const update = ctx.store.db.prepare('UPDATE studio_answers SET answer = ?, edited = 1 WHERE id = ?');
  for (const c of changed) update.run(c.answer.slice(0, 4000), c.a.id);
  setAutoAnswer(ctx, id, phase, null);
  if (changed.length) {
    setPhase(ctx, id, phase, { note: null });
    return {
      message: composeAnswers(changed.map((c) => ({ question: c.a.question.question, answer: `${c.answer}\n(was: ${c.a.answer})` })),
        'I reviewed the answers my stand-in gave and changed these. Update your document to match:'),
      approved: false, next: null,
    };
  }
  // The phase to start next: the first later one that's open. Autopilot queues it on its own.
  const next = getStudio(ctx, id)!.mode === 'autopilot' ? undefined
    : studioPhases(ctx, id).slice(index(phase) + 1).find((p) => p.state === 'ready' || p.state === 'stale');
  return { message: null, approved: true, next: next ? { phase: next.phase, state: next.state } : null };
}
