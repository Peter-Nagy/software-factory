import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
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

export type PhaseKey = 'brief' | 'research' | 'product' | 'design' | 'architecture' | 'spikes' | 'plan';
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
  { key: 'brief', title: 'Brief', model: 'sonnet', doc: 'docs/BRIEF.md', costPct: 2 },
  { key: 'research', title: 'Research', model: 'sonnet', doc: 'docs/RESEARCH.md', costPct: 6 },
  { key: 'product', title: 'Product', model: 'opus', doc: 'docs/PRODUCT.md', costPct: 5 },
  { key: 'design', title: 'Design', model: 'opus', doc: 'docs/DESIGN.md', costPct: 8 },
  { key: 'architecture', title: 'Architecture', model: 'opus', doc: 'docs/ARCHITECTURE.md', costPct: 5 },
  { key: 'spikes', title: 'Spikes', model: 'sonnet', doc: 'docs/SPIKES.md', costPct: 6, optional: true },
  { key: 'plan', title: 'Build plan', model: 'opus', doc: 'plan/plan.json', costPct: 4 },
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
}
export interface StudioMessage {
  id: number;
  phase: PhaseKey;
  role: 'owner' | 'agent' | 'system';
  text: string;
  at: number;
}

/** What each phase agent writes to /work/status/<phase>.json at the end of every turn. */
export const PhaseStatusSchema = z.object({
  ready: z.boolean(),
  questions: z.array(z.string()).default([]),
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
  note: (r.note as string | null) ?? null, updatedAt: Number(r.updated_at),
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
  for (const sub of ['docs/design', 'status', 'spikes']) mkdirSync(join(studioWork(ctx, id), sub), { recursive: true });
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
export function listMockups(ctx: Ctx, id: number): string[] {
  const dir = join(studioWork(ctx, id), 'docs', 'design');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^[a-z0-9][a-z0-9._-]*\.html$/i.test(f)).sort();
}

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
    addMessage(ctx, id, phase, 'system', status?.questions.length ? 'Autopilot paused: the agent needs your answers above.' : 'Autopilot paused: the agent didn\'t mark this phase done.');
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
export async function studioTurn(ctx: PipelineContext, id: number, phase: PhaseKey, text: string, opts: { auto?: boolean } = {}): Promise<void> {
  const studio = getStudio(ctx, id);
  if (!studio) throw new Error(`No studio ${id}`);
  const row = phaseRow(ctx, id, phase);
  if (!canTalk(row.state) && row.state !== 'queued') throw new Error(`${phaseDef(phase).title} is ${row.state}`);
  const key = `${id}:${phase}`;
  if (busy.has(key)) throw new Error('The agent is still working on this phase');
  busy.add(key);
  try {
    if (phase === 'plan') return await planPhaseTurn(ctx, studio, text);
    await phaseTurn(ctx, studio, row, text, opts.auto ?? false);
  } finally {
    busy.delete(key);
  }
}

async function phaseTurn(ctx: PipelineContext, studio: Studio, row: PhaseRow, text: string, auto: boolean): Promise<void> {
  const { config, store } = ctx;
  const id = studio.id;
  const def = phaseDef(row.phase);
  const wasState = row.state;
  addMessage(ctx, id, row.phase, auto ? 'system' : 'owner', text);
  setPhase(ctx, id, row.phase, { state: 'thinking', note: null });
  try {
    const first = row.sessionId === null;
    const prompt = first
      ? [
          `Studio: "${studio.title}". You own the ${def.title} phase. Your document: /work/${def.doc}.`,
          'Earlier phases\' approved documents are in /work/docs; read the ones that exist before writing.',
          `At the end of every turn write /work/status/${row.phase}.json: {"ready": true|false, "questions": [...], "summary": "one line"${row.phase === 'research' ? ', "verdict": "build"|"narrow"|"dont"' : ''}}.`,
          '',
          phaseBrief(ctx, row.phase),
          '',
          `Owner: ${text}`,
        ].join('\n')
      : text;
    const role = roleConfig(config, 'studio');
    const env = { [config.worker.claudeTokenEnv]: await ctx.secrets.get(config.worker.claudeTokenEnv) };
    const args = buildClaudeArgs({
      prompt,
      model: row.model,
      effort: role.effort,
      maxTurns: role.maxTurns,
      resumeSessionId: row.sessionId,
      appendSystemPromptFile: `${WORKER_CONFIG_MOUNT}/prompts/studio.md`,
    });
    mkdirSync(config.paths.logs, { recursive: true });
    const logPath = join(config.paths.logs, `studio-${id}-${row.phase}-${Date.now()}.jsonl`);
    const sessionsDir = join(studioDir(ctx, id), 'sessions', row.phase);
    mkdirSync(sessionsDir, { recursive: true });
    const runId = store.startRun({ taskId: null, role: 'studio', model: row.model, logPath, usageBefore: store.latestUsage() });
    const result = await runInContainer(
      {
        name: `factory-studio-${id}-${row.phase}-${Date.now()}`,
        image: config.worker.image,
        worktree: studioWork(ctx, id),
        workerConfigDir: config.paths.workerConfig,
        sessionsDir,
        cpus: config.worker.cpus,
        memoryGb: config.worker.memoryGb,
        envNames: Object.keys(env),
        labels: { 'factory.role': 'studio', 'factory.studio': String(id), 'factory.phase': row.phase },
      },
      args,
      { env, timeoutMs: role.timeoutMinutes * 60_000, logPath },
    );
    store.finishRun(runId, result, result.resultText);
    const snap = snapshotAfterRun(store.latestUsage(), result, ctx.now());
    if (snap) store.recordUsage(snap);
    if (result.sessionId) setPhase(ctx, id, row.phase, { sessionId: result.sessionId });
    if (result.ok) {
      addMessage(ctx, id, row.phase, 'agent', result.resultText || '(no reply)');
      const hasDoc = readDoc(ctx, id, def.doc) !== null;
      setPhase(ctx, id, row.phase, { state: hasDoc ? 'drafting' : wasState === 'queued' ? 'ready' : wasState, note: null });
      if (hasDoc && auto) autopilotAfterTurn(ctx, id, row.phase);
    } else {
      const why = result.hitUsageLimit ? 'The usage limit was reached; try again after it resets.' : `The agent stopped: ${result.resultText.slice(0, 500) || 'no result'}`;
      addMessage(ctx, id, row.phase, 'system', why);
      setPhase(ctx, id, row.phase, { state: readDoc(ctx, id, def.doc) !== null ? 'drafting' : 'ready' });
    }
  } catch (e) {
    addMessage(ctx, id, row.phase, 'system', `Couldn't run the agent: ${(e as Error).message}`);
    setPhase(ctx, id, row.phase, { state: readDoc(ctx, id, def.doc) !== null ? 'drafting' : 'ready' });
  }
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
    start(studioTurn(ctx, studio.id, queued.phase, message, { auto: true }).catch((e: Error) => console.error(`Studio ${studio.id} ${queued.phase}: ${e.message}`)));
    started.push(`${studio.id}:${queued.phase}`);
  }
  return started;
}

/** After a restart nothing is thinking: put interrupted phases back so they can be retried. */
export function recoverStudios(ctx: Ctx): void {
  for (const studio of listStudios(ctx)) {
    for (const p of studioPhases(ctx, studio.id)) {
      if (p.state === 'thinking' && p.phase !== 'plan') {
        setPhase(ctx, studio.id, p.phase, { state: readDoc(ctx, studio.id, phaseDef(p.phase).doc) !== null ? 'drafting' : 'ready', note: 'Interrupted by a restart; send a message to continue.' });
      }
    }
    syncPlanPhase(ctx, studio.id);
  }
}
