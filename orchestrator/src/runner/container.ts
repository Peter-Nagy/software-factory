import { spawn, spawnSync } from 'node:child_process';
import type { RunResult } from '../types.ts';
import { runToEnd, streamAgent, type CommandResult, type ProcessSpec } from './process.ts';

export interface ContainerSpec {
  name: string; // unique per run, e.g. factory-habit-tracker-12-a1
  image: string;
  worktree: string; // host path, mounted at /work
  workerConfigDir: string; // host path, mounted read-only at /home/worker/.claude-config
  /** Host dir that keeps this task's Claude session transcripts, so a later container can --resume them. */
  sessionsDir?: string;
  /** Mount the checkout read-only (reviewer). */
  readOnlyWork?: boolean;
  /**
   * Named Docker volume mounted as the worker's home, so what one gate step installs there (package caches,
   * toolchains managed per user) is still there for the next step. Removed with removeVolume afterwards.
   */
  homeVolume?: string;
  /** Extra read-only mounts: host path -> container path. */
  extraReadOnlyMounts?: Record<string, string>;
  cpus: number;
  memoryGb: number;
  /** Env var names to pass through. Values come from the spawning process env, never the command line. */
  envNames: string[];
  labels?: Record<string, string>;
}

/** `docker run` arguments for one agent run. Secrets are passed by name (-e NAME) so they never appear in `ps`. */
export function dockerRunArgs(spec: ContainerSpec, claudeArgs: string[]): string[] {
  return dockerCommandArgs(spec, ['claude', ...claudeArgs]);
}

/** `docker run` arguments for any command in the worker image (gate steps, agents). */
export function dockerCommandArgs(spec: ContainerSpec, command: string[]): string[] {
  const args = [
    'run',
    '--rm',
    '--name',
    spec.name,
    '--init',
    '--user',
    'worker',
    '--cpus',
    String(spec.cpus),
    '--memory',
    `${spec.memoryGb}g`,
    '--pids-limit',
    '2048',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    // Project images build on the worker image; a Dockerfile can't swap out the entrypoint that installs the config.
    '--entrypoint',
    '/usr/local/bin/factory-entrypoint',
    '-v',
    `${spec.worktree}:/work${spec.readOnlyWork ? ':ro' : ''}`,
    '-v',
    `${spec.workerConfigDir}:/home/worker/.claude-config:ro`,
  ];
  if (spec.homeVolume) {
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(spec.homeVolume)) throw new Error(`Invalid volume name: ${spec.homeVolume}`);
    args.push('-v', `${spec.homeVolume}:/home/worker`);
  }
  if (spec.sessionsDir) args.push('-v', `${spec.sessionsDir}:/home/worker/.claude/projects`);
  for (const [host, container] of Object.entries(spec.extraReadOnlyMounts ?? {})) args.push('-v', `${host}:${container}:ro`);
  args.push('-w', '/work');
  for (const [k, v] of Object.entries({ 'factory.run': spec.name, ...(spec.labels ?? {}) })) {
    args.push('--label', `${k}=${v}`);
  }
  for (const name of spec.envNames) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid env var name: ${name}`);
    args.push('-e', name);
  }
  args.push(spec.image, ...command);
  return args;
}

export interface RunOptions {
  env: Record<string, string>; // values for spec.envNames
  timeoutMs: number;
  logPath: string;
  onLine?: (line: string) => void; // live log tail for the dashboard
  onSession?: (sessionId: string) => void; // first session id seen
  docker?: string; // binary, default "docker"
}

function dockerProcess(spec: ContainerSpec, command: string[], opts: { env: Record<string, string>; docker?: string }): ProcessSpec {
  const docker = opts.docker ?? process.env.FACTORY_DOCKER_BIN ?? 'docker';
  const missing = spec.envNames.filter((n) => opts.env[n] === undefined);
  if (missing.length) throw new Error(`Missing values for env: ${missing.join(', ')}`);
  return {
    cmd: docker,
    args: dockerCommandArgs(spec, command),
    env: opts.env,
    kill: () => void spawn(docker, ['kill', spec.name], { stdio: 'ignore' }),
  };
}

/** Run one agent in a fresh container, stream its output to a log file and fold it into a RunResult. */
export async function runInContainer(spec: ContainerSpec, claudeArgs: string[], opts: RunOptions): Promise<RunResult> {
  return streamAgent(dockerProcess(spec, ['claude', ...claudeArgs], opts), opts);
}

/** Remove containers left over from a previous orchestrator process (after a crash or a forced exit). */
export function killLeftoverContainers(docker = process.env.FACTORY_DOCKER_BIN ?? 'docker'): void {
  const ps = spawnSync(docker, ['ps', '-q', '--filter', 'label=factory.run'], { encoding: 'utf8' });
  const ids = (ps.stdout ?? '').split('\n').filter(Boolean);
  if (ids.length) spawnSync(docker, ['rm', '-f', ...ids], { stdio: 'ignore' });
}

/** Remove a named volume (a gate run's home). Failures are ignored: the nightly prune catches leftovers. */
export function removeVolume(name: string, docker = process.env.FACTORY_DOCKER_BIN ?? 'docker'): void {
  spawnSync(docker, ['volume', 'rm', '-f', name], { stdio: 'ignore' });
}

export type { CommandResult } from './process.ts';

/** Run a plain command in a fresh container. The exit code is the verdict: nothing inside can fake it. */
export async function runCommandInContainer(spec: ContainerSpec, command: string[], opts: Omit<RunOptions, 'onSession'>): Promise<CommandResult> {
  return runToEnd(dockerProcess(spec, command, opts), opts);
}
