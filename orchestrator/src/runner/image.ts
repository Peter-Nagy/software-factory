import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CONTRACT_DIR, DOCKERFILE, dockerfileProblem } from '../gates/contract.ts';

export interface ProjectImage {
  /** The image to run agents and gates in: the project's toolchain image, or the worker image if it has none. */
  image: string;
  /** Why the project's image couldn't be used (invalid or failing Dockerfile); null when all is well. */
  problem: string | null;
}

function run(docker: string, args: string[], opts: { timeoutMs: number; logPath?: string }): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    // Only what the docker CLI needs: never the orchestrator's secrets.
    const dockerEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('DOCKER_')));
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...dockerEnv };
    const child = spawn(docker, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = opts.logPath ? createWriteStream(opts.logPath, { flags: 'a' }) : null;
    let out = '';
    const keep = (b: Buffer) => {
      log?.write(b);
      out = (out + b.toString()).slice(-8192);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      log?.end();
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      log?.end();
      resolve({ code, out, timedOut });
    });
  });
}

/** Hash of every file in the contract dir: the image tag, so an unchanged toolchain is never rebuilt. */
export function contractHash(dir: string, baseImageId: string): string {
  const root = join(dir, CONTRACT_DIR);
  const h = createHash('sha256').update(baseImageId);
  const walk = (d: string): string[] =>
    readdirSync(d)
      .sort()
      .flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
  for (const f of walk(root)) h.update(`\0${relative(root, f)}\0`).update(readFileSync(f));
  return h.digest('hex').slice(0, 16);
}

/**
 * The image for a checkout. With a `.factory/Dockerfile`, it's built on top of the worker image (cached by the
 * contents of `.factory/` and the worker image id); without one, it's the worker image itself.
 * The build context is `.factory/` only, never the rest of the repo.
 */
export async function projectImage(opts: {
  dir: string;
  projectId: string;
  baseImage: string;
  timeoutMs: number;
  logPath: string;
  docker?: string;
}): Promise<ProjectImage> {
  const docker = opts.docker ?? process.env.FACTORY_DOCKER_BIN ?? 'docker';
  const dockerfile = join(opts.dir, DOCKERFILE);
  if (!existsSync(dockerfile)) return { image: opts.baseImage, problem: null };
  const invalid = dockerfileProblem(readFileSync(dockerfile, 'utf8'), opts.baseImage);
  if (invalid) return { image: opts.baseImage, problem: invalid };

  const base = await run(docker, ['image', 'inspect', '--format', '{{.Id}}', opts.baseImage], { timeoutMs: 60_000 });
  if (base.code !== 0) throw new Error(`worker image ${opts.baseImage} not found: ${base.out.trim()}`);
  const tag = `factory-project-${opts.projectId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}:${contractHash(opts.dir, base.out.trim())}`;
  const exists = await run(docker, ['image', 'inspect', '--format', '{{.Id}}', tag], { timeoutMs: 60_000 });
  if (exists.code === 0) return { image: tag, problem: null };

  const built = await run(
    docker,
    ['build', '--pull=false', '--label', `factory.project=${opts.projectId}`, '-t', tag, '-f', dockerfile, join(opts.dir, CONTRACT_DIR)],
    { timeoutMs: opts.timeoutMs, logPath: opts.logPath },
  );
  if (built.code === 0 && !built.timedOut) return { image: tag, problem: null };
  return {
    image: opts.baseImage,
    problem: `Building ${DOCKERFILE} ${built.timedOut ? 'timed out' : 'failed'}:\n\`\`\`\n${built.out.slice(-3000)}\n\`\`\``,
  };
}
