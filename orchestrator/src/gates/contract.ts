import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ProjectConfig } from '../config.ts';

/**
 * The check contract. The factory knows no languages: it defines which checks every project must have and how a
 * check proves it ran. Each project supplies the commands for its own stack in `.factory/checks.yaml` and its
 * toolchain in `.factory/Dockerfile` (on top of the worker image).
 *
 *   setup  optional   install dependencies (may write only inside the repo or $HOME)
 *   build  required   compile and/or typecheck
 *   lint   required   linter and format check
 *   test   required   unit and integration tests; must write JUnit XML to $FACTORY_REPORT_DIR
 *   e2e    required when the project has user flows; also writes JUnit XML
 *
 * Fail closed: a required check that is missing, empty or ran zero tests fails the gates.
 */
export const CONTRACT_DIR = '.factory';
export const CHECKS_FILE = `${CONTRACT_DIR}/checks.yaml`;
export const DOCKERFILE = `${CONTRACT_DIR}/Dockerfile`;
/** Orchestrator scratch space in the checkout (summary, question, reports). Git-excluded and cleared per run. */
export const RUN_DIR = '.factory-run';
export const REPORT_DIR_IN_CONTAINER = `/work/${RUN_DIR}/reports`;

const command = z.string().trim().min(1, 'is empty');
export const ChecksSchema = z
  .object({
    setup: command.optional(),
    build: command,
    lint: command,
    test: command,
    e2e: command.optional(),
  })
  .strict();
export type Checks = z.infer<typeof ChecksSchema>;

export type CheckName = 'setup' | 'build' | 'lint' | 'test' | 'e2e';
export const CHECK_ORDER: CheckName[] = ['setup', 'build', 'lint', 'test', 'e2e'];
/** Checks that must report test results as JUnit XML. */
export const REPORTING_CHECKS: CheckName[] = ['test', 'e2e'];

/** How a fix prompt explains the contract when it's missing or broken. */
export const CONTRACT_HELP = [
  `Every project defines its checks in \`${CHECKS_FILE}\` (commands run with bash in /work, in the project's image):`,
  '```yaml',
  'setup: <install dependencies>   # optional; may write only inside the repo or $HOME',
  'build: <compile and/or typecheck>',
  'lint: <linter and format check>',
  'test: <unit and integration tests>',
  'e2e: <end-to-end tests>         # required when the project has user flows',
  '```',
  '`test` and `e2e` must write JUnit XML reports into the directory in `$FACTORY_REPORT_DIR`; at least one test must run.',
  `Toolchains the worker image lacks go in \`${DOCKERFILE}\`, which must start with \`FROM factory-worker:current\`.`,
  `\`${CONTRACT_DIR}/\` must be committed: remove it from .gitignore if it's listed there (scratch files live in ${RUN_DIR}/).`,
].join('\n');

export class ContractError extends Error {}

export function parseChecks(text: string | null): Checks {
  if (text === null) throw new ContractError(`${CHECKS_FILE} is missing.`);
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ContractError(`${CHECKS_FILE} is not valid YAML: ${(e as Error).message}`);
  }
  const r = ChecksSchema.safeParse(raw ?? {});
  if (!r.success) {
    const problems = r.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.code === 'unrecognized_keys' ? i.message : i.path.length && i.code === 'invalid_type' ? 'is missing' : i.message}`);
    throw new ContractError(`${CHECKS_FILE} is invalid: ${problems.join('; ')}.`);
  }
  return r.data;
}

export type Runner = 'linux' | 'macos';

/** iOS and macOS apps need Xcode: their tasks run on the macOS runner. */
export function runnerFor(cfg: ProjectConfig): Runner {
  return cfg.runner ?? (cfg.kind === 'ios' ? 'macos' : 'linux');
}

/** Projects with user-facing flows need E2E tests unless the owner turned them off in factory.yaml. */
export function e2eRequired(cfg: ProjectConfig): boolean {
  return cfg.gates.e2e ?? ['web-app', 'static-site', 'ios'].includes(cfg.kind);
}

export type StepName = CheckName | 'secrets' | 'dependencies' | 'sast';
export interface GateStep {
  name: StepName;
  command: string; // run with bash -lc inside /work
  /** The step must leave JUnit XML with at least one executed test in its report directory. */
  reports: boolean;
}

/** Security steps use tool configs from the read-only worker-config mount, never files in the repo. */
const SECURITY: GateStep[] = [
  {
    name: 'secrets',
    command: 'gitleaks git --no-banner --redact --log-opts="origin/main..HEAD" --gitleaks-ignore-path /dev/null .',
    reports: false,
  },
  {
    name: 'dependencies',
    // Only when this branch changes a lockfile: new advisories on untouched dependencies are maintenance work, not this PR's fault.
    // osv-scanner reads lockfiles of most ecosystems, so this stays stack-independent.
    command:
      'changed=$(git diff --name-only origin/main...HEAD | grep -E "(^|/)(pnpm-lock.yaml|package-lock.json|yarn.lock|bun.lock|requirements[^/]*.txt|poetry.lock|uv.lock|Pipfile.lock|Cargo.lock|go.sum|Gemfile.lock|composer.lock|Package.resolved|gradle.lockfile|pubspec.lock|mix.lock)$" || true); ' +
      'if [ -z "$changed" ]; then echo "no lockfile changes"; else for f in $changed; do osv-scanner scan source --lockfile "$f" || exit 1; done; fi',
    reports: false,
  },
  {
    name: 'sast',
    command: 'semgrep scan --config p/default --error --quiet --metrics=off --baseline-commit "$(git merge-base origin/main HEAD)" --x-ignore-semgrepignore-files .',
    reports: false,
  },
];

/** The steps to run for a project, in order. Throws ContractError when a required check is missing. */
export function gateSteps(cfg: ProjectConfig, checks: Checks): GateStep[] {
  if (e2eRequired(cfg) && !checks.e2e) {
    throw new ContractError(`${CHECKS_FILE} has no e2e check, and this project needs one (it has user-facing flows).`);
  }
  const steps: GateStep[] = [];
  for (const name of CHECK_ORDER) {
    const cmd = checks[name];
    if (cmd) steps.push({ name, command: cmd, reports: REPORTING_CHECKS.includes(name) });
  }
  if (cfg.gates.securityScan) steps.push(...SECURITY);
  return steps;
}

export interface JunitCounts {
  tests: number; // testcases found
  failed: number; // with <failure> or <error>
  skipped: number;
}

/**
 * Count test cases in JUnit XML reports without an XML library. Every test tool's JUnit writer emits one
 * <testcase> per test, with a <failure>, <error> or <skipped> child when it didn't pass.
 */
export function countJunit(xmlFiles: string[]): JunitCounts {
  const total: JunitCounts = { tests: 0, failed: 0, skipped: 0 };
  for (const xml of xmlFiles) {
    const body = xml.replace(/<!--[\s\S]*?-->/g, '');
    const cases = body.match(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g) ?? [];
    for (const c of cases) {
      total.tests++;
      if (/<(failure|error)\b/.test(c)) total.failed++;
      else if (/<skipped\b/.test(c)) total.skipped++;
    }
  }
  return total;
}

/** The verdict on one reporting check's results; null when they're fine. */
export function reportProblem(step: CheckName, files: string[]): string | null {
  if (files.length === 0) {
    return `The ${step} check exited 0 but wrote no JUnit XML report to $FACTORY_REPORT_DIR, so there's no evidence any test ran. Configure the test tool to write JUnit XML there.`;
  }
  const c = countJunit(files);
  if (c.failed > 0) return `The ${step} check exited 0, but its JUnit report lists ${c.failed} failing test${c.failed === 1 ? '' : 's'}.`;
  if (c.tests - c.skipped === 0) return `The ${step} check ran no tests (${c.tests} found, ${c.skipped} skipped). It needs at least one test that runs.`;
  return null;
}

/** Commit trailer an agent adds when a change removes tests on purpose; the reviewer judges the reason. */
export const TESTS_REMOVED_TRAILER = 'Tests-Removed';

/** The test count may not drop below main's, unless a commit on the branch explains why. */
export function testCountProblem(now: number, onMain: number | null, reason: string | null): string | null {
  if (onMain === null || now >= onMain || reason) return null;
  return [
    `The test check ran ${now} tests; main runs ${onMain}. Tests may not disappear silently.`,
    `If removing them is intended (e.g. the feature they tested was removed), add a commit whose message has a trailer line \`${TESTS_REMOVED_TRAILER}: <why>\`. The reviewer judges the reason.`,
  ].join('\n');
}

export function testsRemovedReason(commitMessages: string): string | null {
  const m = commitMessages.match(new RegExp(`^${TESTS_REMOVED_TRAILER}:\\s*(.+)$`, 'mi'));
  return m ? m[1]!.trim() : null;
}

/**
 * The final stage must build on the worker image, so agents keep the claude CLI, the entrypoint and the security
 * tools. Earlier stages (e.g. to compile a tool) may use any image.
 */
export function dockerfileProblem(text: string, baseImage: string): string | null {
  const froms = text.split('\n').map((l) => l.trim()).filter((l) => /^FROM\s/i.test(l));
  const last = froms.at(-1);
  if (!last) return `${DOCKERFILE} has no FROM line.`;
  const image = last.split(/\s+/)[1];
  if (image !== baseImage && image !== 'factory-worker:current') {
    return `The final stage of ${DOCKERFILE} must be \`FROM factory-worker:current\` (found \`${last}\`).`;
  }
  return null;
}
