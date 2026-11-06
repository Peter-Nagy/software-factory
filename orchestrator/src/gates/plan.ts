import { z } from 'zod';
import type { ProjectConfig } from '../config.ts';
import { globToRegExp } from './migration-check.ts';

/**
 * Gates 1-3 run as separate containers, one per step, and the exit code is the verdict.
 * Steps the project doesn't define are skipped (an npm script that doesn't exist is a no-op via --if-present).
 */
export type StepName = 'install' | 'typecheck' | 'lint' | 'test' | 'e2e' | 'secrets' | 'dependencies' | 'sast';
export interface GateStep {
  name: StepName;
  command: string; // run with bash -lc inside /work
}

/** Defaults detect the stack from files in the repo (Node via package.json, Python via pyproject/requirements). */
const DEFAULTS: Record<'install' | 'typecheck' | 'lint' | 'test' | 'e2e', string> = {
  install: [
    'if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; elif [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then pnpm install; fi',
    'if [ -f pyproject.toml ] || [ -f requirements.txt ]; then python3 -m venv .venv && . .venv/bin/activate && { [ ! -f requirements.txt ] || pip install -q -r requirements.txt; } && { [ ! -f pyproject.toml ] || pip install -q -e ".[dev]" || pip install -q -e .; }; fi',
  ].join('\n'),
  typecheck: '[ ! -f package.json ] || pnpm run --if-present typecheck',
  lint: '[ ! -f package.json ] || pnpm run --if-present lint',
  test: '[ ! -f package.json ] || pnpm run --if-present test\nif [ -d .venv ] && { [ -d tests ] || [ -d test ]; }; then . .venv/bin/activate && python -m pytest -q; fi',
  e2e: '[ ! -f package.json ] || pnpm run --if-present e2e',
};

/** Security steps use tool configs from the read-only worker-config mount, never files in the repo. */
const SECURITY: GateStep[] = [
  {
    name: 'secrets',
    command: 'gitleaks git --no-banner --redact --log-opts="origin/main..HEAD" --gitleaks-ignore-path /dev/null .',
  },
  {
    name: 'dependencies',
    // Only when this branch changes a lockfile: new advisories on untouched dependencies are maintenance work, not this PR's fault.
    command:
      'changed=$(git diff --name-only origin/main...HEAD | grep -E "(^|/)(pnpm-lock.yaml|package-lock.json|yarn.lock|requirements[^/]*.txt|poetry.lock|uv.lock|Cargo.lock|go.sum)$" || true); ' +
      'if [ -z "$changed" ]; then echo "no lockfile changes"; else for f in $changed; do osv-scanner scan source --lockfile "$f" || exit 1; done; fi',
  },
  {
    name: 'sast',
    command: 'semgrep scan --config p/default --error --quiet --metrics=off --baseline-commit "$(git merge-base origin/main HEAD)" --x-ignore-semgrepignore-files .',
  },
];

export function gateSteps(cfg: ProjectConfig): GateStep[] {
  const steps: GateStep[] = [];
  for (const name of ['install', 'typecheck', 'lint', 'test', 'e2e'] as const) {
    if (name === 'e2e' && !cfg.gates.e2e) continue;
    const command = cfg.gates.commands[name] ?? DEFAULTS[name];
    if (command.trim()) steps.push({ name, command });
  }
  if (cfg.gates.securityScan) steps.push(...SECURITY);
  return steps;
}

/**
 * Files an agent must never change: they define the gates themselves. A PR touching one waits for the owner,
 * like a destructive migration.
 */
export const PROTECTED_PATHS = [
  '.github/workflows/**',
  '.github/CODEOWNERS',
  'factory.yaml',
  '.gitleaks.toml',
  '.gitleaksignore',
  '.semgrepignore',
  '.semgrep.yml',
  '.semgrep/**',
  'worker-config/**',
];

export function protectedChanges(changedFiles: string[], patterns = PROTECTED_PATHS): string[] {
  const res = patterns.map(globToRegExp);
  return changedFiles.filter((f) => res.some((re) => re.test(f)));
}

/** The reviewer's verdict, enforced with --json-schema and validated again here. */
export const ReviewSchema = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  criteria: z.array(z.object({ criterion: z.string(), met: z.boolean(), evidence: z.string() })),
  blocking: z.array(z.object({ file: z.string(), line: z.number().int().optional(), problem: z.string(), fix: z.string() })),
  notes: z.array(z.string()).default([]),
});
export type Review = z.infer<typeof ReviewSchema>;

export const REVIEW_JSON_SCHEMA = {
  type: 'object',
  required: ['verdict', 'criteria', 'blocking', 'notes'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request_changes'] },
    criteria: {
      type: 'array',
      items: { type: 'object', required: ['criterion', 'met', 'evidence'], properties: { criterion: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } } },
    },
    blocking: {
      type: 'array',
      items: { type: 'object', required: ['file', 'problem', 'fix'], properties: { file: { type: 'string' }, line: { type: 'integer' }, problem: { type: 'string' }, fix: { type: 'string' } } },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
};

/** An approval only counts if it is consistent: every criterion met and nothing blocking. */
export function reviewPasses(r: Review): boolean {
  return r.verdict === 'approve' && r.blocking.length === 0 && r.criteria.length > 0 && r.criteria.every((c) => c.met);
}

export function formatReviewFailure(r: Review): string {
  const lines = ['The independent review requested changes.', ''];
  const unmet = r.criteria.filter((c) => !c.met);
  if (unmet.length) lines.push('Unmet acceptance criteria:', ...unmet.map((c) => `- ${c.criterion}: ${c.evidence}`), '');
  if (r.blocking.length) lines.push('Blocking issues:', ...r.blocking.map((b) => `- ${b.file}${b.line ? `:${b.line}` : ''}: ${b.problem} Fix: ${b.fix}`));
  if (r.verdict === 'approve' && r.criteria.length === 0) lines.push('- The review listed no acceptance criteria; make sure the PR summary has an acceptance-criteria checklist with evidence.');
  return lines.join('\n');
}

export interface StepOutcome {
  name: StepName;
  ok: boolean;
  timedOut: boolean;
  tail: string;
}

export function formatGateFailure(outcomes: StepOutcome[]): string {
  const failed = outcomes.filter((o) => !o.ok);
  return [
    `These checks failed: ${failed.map((f) => f.name).join(', ')}.`,
    ...failed.map((f) => `\n### ${f.name}${f.timedOut ? ' (timed out)' : ''}\n\`\`\`\n${f.tail.slice(-3000)}\n\`\`\``),
  ].join('\n');
}
