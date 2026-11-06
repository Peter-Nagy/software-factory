import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Secrets live in the 1Password "Factory" vault, one item per secret, value in the "credential" field.
 * The orchestrator reads them with the 1Password CLI using OP_SERVICE_ACCOUNT_TOKEN from its own environment
 * (set by launchd from the macOS keychain). Agents never see that token.
 */
export class Secrets {
  private cache = new Map<string, { value: string; at: number }>();
  private readonly vault: string;
  private readonly ttlMs: number;
  private readonly reader: (ref: string) => Promise<string>;

  constructor(opts: { vault?: string; ttlMs?: number; reader?: (ref: string) => Promise<string> } = {}) {
    this.vault = opts.vault ?? 'Factory';
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.reader = opts.reader ?? (async (ref) => (await exec('op', ['read', '--no-newline', ref])).stdout);
  }

  ref(name: string): string {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid secret name: ${name}`);
    return `op://${this.vault}/${name}/credential`;
  }

  async get(name: string): Promise<string> {
    const hit = this.cache.get(name);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = await this.reader(this.ref(name));
    if (!value) throw new Error(`Secret ${name} is empty`);
    this.cache.set(name, { value, at: Date.now() });
    return value;
  }

  async getMany(names: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const n of names) out[n] = await this.get(n);
    return out;
  }
}
