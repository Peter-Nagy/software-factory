import type { Effort, Model, RunResult, UsageSnapshot } from './types.ts';

export interface ClaudeRunOptions {
  prompt: string;
  model: Model;
  effort?: Effort;
  maxTurns: number;
  maxBudgetUsd?: number;
  resumeSessionId?: string | null;
  appendSystemPromptFile?: string;
  settingsPath?: string;
  jsonSchema?: object;
}

/**
 * Arguments for an unattended `claude -p` run. Uses the subscription login (no --bare: bare mode skips OAuth).
 * Auto mode lets a classifier approve actions; --permission-prompts none denies anything that would still prompt.
 */
export function buildClaudeArgs(o: ClaudeRunOptions): string[] {
  const args = [
    '-p',
    o.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'auto',
    '--permission-prompts',
    'none',
    '--model',
    o.model,
    '--max-turns',
    String(o.maxTurns),
  ];
  if (o.effort) args.push('--effort', o.effort);
  if (o.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(o.maxBudgetUsd));
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
  if (o.appendSystemPromptFile) args.push('--append-system-prompt-file', o.appendSystemPromptFile);
  if (o.settingsPath) args.push('--settings', o.settingsPath);
  if (o.jsonSchema) args.push('--json-schema', JSON.stringify(o.jsonSchema));
  return args;
}

const USAGE_LIMIT_PATTERNS = [/usage limit/i, /limit reached/i, /rate[_ ]limit/i, /out of (extra )?usage/i];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Normalise a reset time to epoch seconds (accepts seconds, milliseconds or ISO strings). */
function toEpochSeconds(v: unknown): number | null {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  const n = num(v);
  if (n === null) return null;
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

function windowFrom(o: unknown): { pct: number | null; resetsAt: number | null } | null {
  if (!isObj(o)) return null;
  // Status-line shape: used_percentage (0..100). Headless rate_limit_event shape (spike S0-2a): utilization (0..1).
  const used = num(o.used_percentage) ?? num(o.usedPercentage);
  const util = num(o.utilization);
  const pct = used ?? (util !== null ? Math.round(util * 1000) / 10 : null);
  const resetsAt = toEpochSeconds(o.resets_at ?? o.resetsAt);
  if (pct === null && resetsAt === null) return null;
  return { pct, resetsAt };
}

/**
 * Find subscription rate-limit numbers anywhere in an event. The exact headless shape is confirmed in spike S0-2;
 * this accepts the status-line shape ({ five_hour: {used_percentage, resets_at}, seven_day: {...} })
 * nested under any key.
 */
export function extractUsage(event: unknown, depth = 0): Partial<UsageSnapshot> | null {
  if (!isObj(event) || depth > 4) return null;
  const five = windowFrom(event.five_hour ?? event.fiveHour);
  const seven = windowFrom(event.seven_day ?? event.sevenDay);
  if (five || seven) {
    const out: Partial<UsageSnapshot> = {};
    if (five) {
      out.fiveHourPct = five.pct;
      out.fiveHourResetsAt = five.resetsAt;
    }
    if (seven) {
      out.sevenDayPct = seven.pct;
      out.sevenDayResetsAt = seven.resetsAt;
    }
    return out;
  }
  for (const value of Object.values(event)) {
    const found = extractUsage(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Fold the newline-delimited JSON of a `claude -p --output-format stream-json` run into a RunResult. */
export class StreamParser {
  private sessionId: string | null = null;
  private result: Json | null = null;
  private denials: string[] = [];
  private usage: Partial<UsageSnapshot> | null = null;
  private limitHit = false;
  readonly malformedLines: string[] = [];
  /** Called once, the first time the run reports its session id. */
  onSession?: (sessionId: string) => void;

  push(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: unknown;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      this.malformedLines.push(trimmed.slice(0, 200));
      if (USAGE_LIMIT_PATTERNS.some((p) => p.test(trimmed))) this.limitHit = true;
      return;
    }
    if (!isObj(ev)) return;
    if (typeof ev.session_id === 'string') {
      if (this.sessionId === null) this.onSession?.(ev.session_id);
      this.sessionId = ev.session_id;
    }

    const u = extractUsage(ev);
    if (u) this.usage = { ...(this.usage ?? {}), ...u };

    if (ev.type === 'system' && ev.subtype === 'permission_denied') {
      this.denials.push(String(ev.tool_name ?? ev.tool ?? 'unknown'));
    }
    // Headless runs emit {"type":"rate_limit_event","rate_limit_info":{"status":"allowed"|...}}; anything but allowed is a stop.
    if (ev.type === 'rate_limit_event' && isObj(ev.rate_limit_info) && typeof ev.rate_limit_info.status === 'string' && ev.rate_limit_info.status !== 'allowed' && ev.rate_limit_info.status !== 'allowed_warning') {
      this.limitHit = true;
    }
    if (ev.type === 'system' && ev.subtype === 'api_retry' && ev.error === 'rate_limit') {
      this.limitHit = true;
    }
    if (ev.type === 'result') {
      this.result = ev;
      if (Array.isArray(ev.permission_denials)) {
        for (const d of ev.permission_denials) {
          this.denials.push(isObj(d) ? String(d.tool_name ?? 'unknown') : String(d));
        }
      }
      if (ev.is_error === true && typeof ev.result === 'string' && USAGE_LIMIT_PATTERNS.some((p) => p.test(ev.result as string))) {
        this.limitHit = true;
      }
    }
  }

  finish(timedOut = false): RunResult {
    const r = this.result;
    const ok = !timedOut && r !== null && r.is_error !== true && r.subtype === 'success';
    return {
      ok,
      sessionId: this.sessionId,
      resultText: r && typeof r.result === 'string' ? r.result : '',
      totalCostUsd: r ? num(r.total_cost_usd) : null,
      numTurns: r ? num(r.num_turns) : null,
      durationMs: r ? num(r.duration_ms) : null,
      permissionDenials: [...new Set(this.denials)],
      usage: this.usage,
      // A rate-limit retry in the middle of a run that then succeeds is not a usage-limit stop.
      hitUsageLimit: this.limitHit && !ok,
      structuredOutput: r ? r.structured_output ?? null : null,
      timedOut,
      completed: r !== null,
    };
  }
}

export function parseStream(text: string, timedOut = false): RunResult {
  const p = new StreamParser();
  for (const line of text.split('\n')) p.push(line);
  return p.finish(timedOut);
}
