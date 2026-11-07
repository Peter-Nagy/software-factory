import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { StreamParser } from '../claude.ts';
import type { RunResult } from '../types.ts';

/** One process to run: a `docker run`, or the macOS runner through sudo. */
export interface ProcessSpec {
  cmd: string;
  args: string[];
  /** Env of the spawned process itself (docker reads secrets from it by name). */
  env: Record<string, string>;
  /** Written to stdin, then closed (the macOS runner takes its env as JSON there). */
  stdin?: string;
  /** How to stop it on timeout (docker kill <name>, or a signal). */
  kill(child: ChildProcess): void;
}

export interface StreamOptions {
  timeoutMs: number;
  logPath: string;
  onLine?: (line: string) => void; // live log tail for the dashboard
  onSession?: (sessionId: string) => void; // first session id seen
}

function start(p: ProcessSpec): ChildProcess {
  const child = spawn(p.cmd, p.args, {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...p.env },
    stdio: [p.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (p.stdin !== undefined) {
    child.stdin!.on('error', () => undefined); // the process may exit before reading it all
    child.stdin!.end(p.stdin);
  }
  return child;
}

/** Run one agent, stream its stream-json output to a log file and fold it into a RunResult. */
export function streamAgent(p: ProcessSpec, opts: StreamOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = start(p);
    const log = createWriteStream(opts.logPath, { flags: 'a' });
    const parser = new StreamParser();
    parser.onSession = opts.onSession;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill(child);
    }, opts.timeoutMs);

    createInterface({ input: child.stdout! }).on('line', (line) => {
      log.write(line + '\n');
      parser.push(line);
      opts.onLine?.(line);
    });
    let stderrTail = '';
    createInterface({ input: child.stderr! }).on('line', (line) => {
      log.write(`[stderr] ${line}\n`);
      stderrTail = `${stderrTail}${line}\n`.slice(-2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      log.end();
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      log.end();
      const result = parser.finish(timedOut);
      // The agent never reported a result: surface why (e.g. the container failed to start).
      if (!result.completed && !result.resultText) result.resultText = `exit ${code}: ${stderrTail.trim() || 'no output'}`;
      resolve(result);
    });
  });
}

export interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  /** Last ~8 KB of combined output, for failure reports. */
  tail: string;
  durationMs: number;
}

/** Run a plain command to the end. The exit code is the verdict: nothing inside can fake it. */
export function runToEnd(p: ProcessSpec, opts: Omit<StreamOptions, 'onSession' | 'onLine'>): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = start(p);
    const log = createWriteStream(opts.logPath, { flags: 'a' });
    let tail = '';
    const keep = (chunk: Buffer) => {
      log.write(chunk);
      tail = (tail + chunk.toString()).slice(-8192);
    };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill(child);
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
