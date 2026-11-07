import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const home = homedir();
const expandHome = (p: string) => (p.startsWith('~/') ? join(home, p.slice(2)) : p);
const pathString = z.string().transform(expandHome);

const ModelSchema = z.enum(['haiku', 'sonnet', 'opus']);
const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const GovernorConfigSchema = z
  .object({
    /** Weekly burn line: allowed 7-day usage = elapsed share of the week + this headroom. */
    weeklyHeadroomPct: z.number().min(0).max(100).default(10),
    /** In the last N hours before the weekly reset the burn line is lifted to use leftover allowance. */
    sprintHoursBeforeWeeklyReset: z.number().min(0).max(168).default(12),
    /** Above this 5-hour usage no new Opus runs start. */
    opusMaxFiveHourPct: z.number().min(0).max(100).default(70),
    /** Above this 5-hour usage no new runs start at all. */
    anyMaxFiveHourPct: z.number().min(0).max(100).default(90),
    /** At or above this 7-day usage everything pauses until the weekly reset. */
    weeklyHardStopPct: z.number().min(0).max(100).default(98),
    /** Over the weekly burn line only tasks estimated at or below this 5-hour share may start. */
    smallTaskMaxPct: z.number().min(0).max(100).default(5),
    maxParallel: z.number().int().min(1).max(32).default(6),
    /** Parallel cap while usage numbers are unknown (e.g. before the first run of the day). */
    unknownUsageMaxParallel: z.number().int().min(1).max(32).default(2),
    /** Wait this long after a reported reset time before starting again. */
    resumeGraceSeconds: z.number().int().min(0).default(120),
  })
  .default({});

export const RoleConfigSchema = z.object({
  model: ModelSchema,
  effort: EffortSchema.optional(),
  maxTurns: z.number().int().positive(),
  timeoutMinutes: z.number().positive(),
  /** Client-side cost cap passed as --max-budget-usd (an estimate; acts as a runaway guard). */
  maxBudgetUsd: z.number().positive().optional(),
});
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export const FactoryConfigSchema = z.object({
  github: z.object({
    owner: z.string().min(1),
    appId: z.string().optional(),
    installationId: z.string().optional(),
    /** GitHub App private key: a secret name in the 1Password Factory vault (e.g. GITHUB_APP_PRIVATE_KEY) or a file path. */
    appPrivateKey: z.string().optional(),
    managedTopic: z.string().default('factory-managed'),
  }),
  paths: z
    .object({
      state: pathString.default('~/factory/state'),
      repos: pathString.default('~/factory/repos'),
      worktrees: pathString.default('~/factory/worktrees'),
      logs: pathString.default('~/factory/logs'),
      workerConfig: pathString.default('~/factory/software-factory/worker-config'),
    })
    .default({}),
  governor: GovernorConfigSchema,
  worker: z
    .object({
      image: z.string().default('factory-worker:current'),
      cpus: z.number().positive().default(4),
      memoryGb: z.number().positive().default(6),
      /** Name of the env var (resolved from 1Password) that holds the `claude setup-token` token. */
      claudeTokenEnv: z.string().default('CLAUDE_CODE_OAUTH_TOKEN'),
    })
    .default({}),
  /**
   * The macOS runner for Apple-platform projects (ops/setup-macos-runner.sh). Agents and project checks run as a
   * separate user through a root-owned script, inside a sandbox profile; security scans and reviews stay in Docker.
   */
  macos: z
    .object({
      enabled: z.boolean().default(false),
      user: z.string().regex(/^[a-z][a-z0-9_-]*$/).default('factory-ios'),
      root: z.string().default('/Users/Shared/factory-macos'),
    })
    .default({}),
  roles: z.record(z.string(), RoleConfigSchema.partial()).default({}),
  questions: z
    .object({
      defaultTimeoutHours: z.number().positive().default(24),
      smallUiTimeoutHours: z.number().positive().default(4),
    })
    .default({}),
  /** Local web dashboard (bound to this Mac; reach it from elsewhere through `tailscale serve`). */
  dashboard: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().min(0).max(65535).default(4777), // 0 = any free port (tests)
      /** Host names the browser may use, besides localhost. Any *.ts.net name (Tailscale) is always allowed. */
      allowedHosts: z.array(z.string()).default([]),
    })
    .default({}),
  /** Discord remote control. Leave out to run without it (notifications go to the log). */
  discord: z
    .object({
      guildId: z.string().regex(/^\d+$/),
      ownerUserId: z.string().regex(/^\d+$/), // the only user whose commands and answers count
      botTokenSecret: z.string().default('DISCORD_BOT_TOKEN'),
    })
    .optional(),
  schedule: z
    .object({
      tickSeconds: z.number().int().positive().default(30),
      timezone: z.string().default('Europe/Budapest'),
      digestHourLocal: z.number().int().min(0).max(23).default(8),
    })
    .default({}),
});
export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;
export type GovernorConfig = z.infer<typeof GovernorConfigSchema>;

export const ProjectConfigSchema = z.object({
  kind: z.enum(['web-app', 'static-site', 'service', 'cli', 'ios']),
  priority: z.number().int().min(1).max(5).default(3),
  /** Where tasks run: Linux containers, or macOS VMs (Xcode). Unset: macos for ios, linux otherwise. */
  runner: z.enum(['linux', 'macos']).optional(),
  deploy: z
    .object({
      adapter: z.enum(['vercel', 'cf-pages', 'mac-docker', 'github-release', 'testflight', 'none']).default('none'),
      productionUrl: z.string().url().optional(),
      healthPath: z.string().default('/'),
    })
    .default({}),
  /** Names of secrets (items in the 1Password Factory vault) the project's tasks get as env vars. */
  secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
  /** Extra paths (globs) whose changes merge only after the owner signs off, on top of the gates' own files. */
  ownerApproval: z.array(z.string()).default([]),
  gates: z
    .object({
      /** E2E tests required. Unset: required for kinds with user-facing flows (web-app, static-site, ios). */
      e2e: z.boolean().optional(),
      securityScan: z.boolean().default(true),
      aiReview: z.boolean().default(true),
      destructiveMigrationCheck: z.boolean().default(true),
      migrationGlobs: z.array(z.string()).default(['**/migrations/**', '**/drizzle/**', '**/*.sql']),
      timeoutMinutes: z.number().positive().default(20),
      /** Minutes allowed to build the project's toolchain image from .factory/Dockerfile. */
      imageBuildTimeoutMinutes: z.number().positive().default(30),
    })
    .default({}),
  maintenance: z
    .object({
      renovate: z.boolean().default(true),
      sentryProject: z.string().optional(),
      monthlyIdeas: z.boolean().default(true),
    })
    .default({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export function parseFactoryConfig(text: string): FactoryConfig {
  return FactoryConfigSchema.parse(parseYaml(text) ?? {});
}

export function parseProjectConfig(text: string): ProjectConfig {
  return ProjectConfigSchema.parse(parseYaml(text) ?? {});
}

export function loadFactoryConfig(path = process.env.FACTORY_CONFIG ?? join(home, 'factory', 'factory.config.yaml')): FactoryConfig {
  if (!existsSync(path)) {
    throw new Error(`Factory config not found at ${path}. Copy factory.config.example.yaml there and edit it.`);
  }
  return parseFactoryConfig(readFileSync(path, 'utf8'));
}
