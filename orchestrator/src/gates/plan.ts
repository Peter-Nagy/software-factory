import { z } from 'zod';
import { globToRegExp } from './migration-check.ts';

export { gateSteps, type GateStep, type StepName } from './contract.ts';
import type { StepName } from './contract.ts';

/**
 * Files that define the gates themselves and the agents' rules. A PR may change them, but it merges only after the
 * owner signs off on exactly that change (like a destructive migration). Projects add their own in factory.yaml
 * (`ownerApproval`).
 */
export const PROTECTED_PATHS = [
  '.github/CODEOWNERS',
  'factory.yaml',
  '.gitleaks.toml',
  '.gitleaksignore',
  '.semgrepignore',
  '.semgrep.yml',
  '.semgrep/**',
  'worker-config/**',
];

/** CI workflows: an agent's token can't push them, so a change there always goes back to the agent. */
export const NEVER_PATHS = ['.github/workflows/**'];

export function protectedChanges(changedFiles: string[], patterns: string[] = [...NEVER_PATHS, ...PROTECTED_PATHS]): string[] {
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
