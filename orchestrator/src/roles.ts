import type { FactoryConfig, RoleConfig } from './config.ts';
import type { Model, Risk, Role } from './types.ts';

/** worker-config/ is mounted read-only here in every worker container. */
export const WORKER_CONFIG_MOUNT = '/home/worker/.claude-config';

/** Default model, effort and limits per agent role. Override any field under `roles:` in factory.config.yaml. */
export const DEFAULT_ROLES: Record<Role, RoleConfig> = {
  intake: { model: 'haiku', maxTurns: 6, timeoutMinutes: 3 },
  planner: { model: 'opus', effort: 'high', maxTurns: 40, timeoutMinutes: 30 },
  architect: { model: 'opus', effort: 'medium', maxTurns: 40, timeoutMinutes: 30 },
  implementer: { model: 'sonnet', effort: 'medium', maxTurns: 120, timeoutMinutes: 45 },
  reviewer: { model: 'sonnet', effort: 'medium', maxTurns: 30, timeoutMinutes: 15 },
  diagnoser: { model: 'haiku', maxTurns: 8, timeoutMinutes: 5 },
  triage: { model: 'haiku', maxTurns: 8, timeoutMinutes: 5 },
  improver: { model: 'sonnet', effort: 'medium', maxTurns: 60, timeoutMinutes: 30 },
  // Studio phases pick their own model (see studio.ts); these are the limits per turn.
  studio: { model: 'opus', effort: 'high', maxTurns: 80, timeoutMinutes: 40 },
};

export function roleConfig(config: FactoryConfig, role: Role): RoleConfig {
  return { ...DEFAULT_ROLES[role], ...(config.roles[role] ?? {}) } as RoleConfig;
}

/** Role prompt as seen from inside the container (source: worker-config/prompts/<role>.md). */
export function promptPath(role: Role): string {
  return `${WORKER_CONFIG_MOUNT}/prompts/${role}.md`;
}

/** Reviewer escalates to Opus for risky or large changes. */
export function reviewerModel(risk: Risk, diffLines: number, largeDiffLines = 600): Model {
  return risk === 'high' || diffLines > largeDiffLines ? 'opus' : 'sonnet';
}
