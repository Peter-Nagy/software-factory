import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { StreamParser } from '../claude.ts';
import type { RunResult } from '../types.ts';

export interface ContainerSpec {
  name: string; // unique per run, e.g. factory-habit-tracker-12-a1
  image: string;
  worktree: string; // host path, mounted at /work
  workerConfigDir: string; // host path, mounted read-only at /home/worker/.claude-config
  /** Host dir that keeps this task's Claude session transcripts, so a later container can --resume them. */
  sessionsDir?: string;
  /** Mount the checkout read-only (reviewer). */
  readOnlyWork?: boolean;
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
    '-v',
    `${spec.worktree}:/work${spec.readOnlyWork ? ':ro' : ''}`,
    '-v',
    `${spec.workerConfigDir}:/home/worker/.claude-config:ro`,
  ];
  if (spec.sessionsDir) args.push('-v', `${spec.sessionsDir}:/home/worker/.claude/projects`);
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

/** Run one agent in a fresh container, stream its output to a log file and fold it into a RunResult. */
export function runInContainer(spec: ContainerSpec, claudeArgs: string[], opts: RunOptions): Promise<RunResult> {
  const docker = opts.docker ?? process.env.FACTORY_DOCKER_BIN ?? 'docker';
  const missing = spec.envNames.filter((n) => opts.env[n] === undefined);
  if (missing.length) return Promise.reject(new Error(`Missing values for env: ${missing.join(', ')}`));

  return new Promise((resolve, reject) => {
    const child = spawn(docker, dockerRunArgs(spec, claudeArgs), {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = createWriteStream(opts.logPath, { flags: 'a' });
    const parser = new StreamParser();
    parser.onSession = opts.onSession;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      spawn(docker, ['kill', spec.name], { stdio: 'ignore' });
    }, opts.timeoutMs);

    createInterface({ input: child.stdout }).on('line', (line) => {
      log.write(line + '\n');
      parser.push(line);
      opts.onLine?.(line);
    });
    createInterface({ input: child.stderr }).on('line', (line) => log.write(`[stderr] ${line}\n`));

    child.on('error', (err) => {
      clearTimeout(timer);
      log.end();
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      log.end();
      resolve(parser.finish(timedOut));
    });
  });
}

/** Remove containers left over from a previous orchestrator process (after a crash or a forced exit). */
export function killLeftoverContainers(docker = process.env.FACTORY_DOCKER_BIN ?? 'docker'): void {
  const ps = spawnSync(docker, ['ps', '-q', '--filter', 'label=factory.run'], { encoding: 'utf8' });
  const ids = (ps.stdout ?? '').split('\n').filter(Boolean);
  if (ids.length) spawnSync(docker, ['rm', '-f', ...ids], { stdio: 'ignore' });
}

export interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  /** Last ~8 KB of combined output, for failure reports. */
  tail: string;
  durationMs: number;
}

/** Run a plain command in a fresh container. The exit code is the verdict: nothing inside can fake it. */
export function runCommandInContainer(spec: ContainerSpec, command: string[], opts: Omit<RunOptions, 'onSession'>): Promise<CommandResult> {
  const docker = opts.docker ?? process.env.FACTORY_DOCKER_BIN ?? 'docker';
  const missing = spec.envNames.filter((n) => opts.env[n] === undefined);
  if (missing.length) return Promise.reject(new Error(`Missing values for env: ${missing.join(', ')}`));
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(docker, dockerCommandArgs(spec, command), {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = createWriteStream(opts.logPath, { flags: 'a' });
    let tail = '';
    const keep = (chunk: Buffer) => {
      log.write(chunk);
      tail = (tail + chunk.toString()).slice(-8192);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawn(docker, ['kill', spec.name], { stdio: 'ignore' });
    }, opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      log.end();
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      log.end();
      resolve({ exitCode: code, timedOut, tail, durationMs: Date.now() - started });
    });
  });
}
