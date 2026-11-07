import { spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactoryConfig } from '../config.ts';
import type { RunResult } from '../types.ts';
import { runToEnd, streamAgent, type CommandResult, type ProcessSpec, type StreamOptions } from './process.ts';

/**
 * The macOS runner (ops/setup-macos-runner.sh): agents and project checks of Apple-platform projects run as a
 * separate user, through the one root-owned script sudoers allows, inside a sandbox profile. Env vars (secrets)
 * go through stdin as JSON, never the command line.
 */
export type MacosConfig = FactoryConfig['macos'];

export const worktreesDir = (cfg: MacosConfig) => join(cfg.root, 'worktrees');
const runScript = (cfg: MacosConfig) => join(cfg.root, 'bin', 'run');
const sudoBin = () => process.env.FACTORY_SUDO_BIN ?? '/usr/bin/sudo';

/**
 * Xcode's own sandboxes (package manifests and plugins, build-script phases) can't start inside the runner's
 * sandbox: macOS doesn't nest them. They're switched off for the runner user only; everything Xcode runs stays
 * inside the runner's sandbox, which blocks the owner's home and limits writes to the task's checkout.
 */
export const xcconfigPath = (cfg: MacosConfig) => join(cfg.root, 'config', 'xcode.xcconfig');
const XCCONFIG = '// Written by the factory orchestrator. The runner sandbox replaces Xcode\'s script sandbox.\nENABLE_USER_SCRIPT_SANDBOXING = NO\n';
const XCODE_DEFAULTS = [
  'defaults write com.apple.dt.Xcode IDEPackageSupportDisableManifestSandbox -bool YES',
  'defaults write com.apple.dt.Xcode IDEPackageSupportDisablePluginExecutionSandbox -bool YES',
].join(' && ');


function macProcess(cfg: MacosConfig, worktree: string, command: string[], env: Record<string, string>): ProcessSpec {
  for (const k of Object.keys(env)) if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Invalid env var name: ${k}`);
  return {
    cmd: sudoBin(),
    args: ['-n', '-u', cfg.user, runScript(cfg), worktree, '--', ...command],
    env: {},
    stdin: JSON.stringify({ XCODE_XCCONFIG_FILE: xcconfigPath(cfg), ...env }),
    cwd: '/', // the runner user can't enter the owner's home, where the orchestrator itself runs
    // sudo relays the signal to the runner, which stops the command's whole process group.
    kill: (child: ChildProcess) => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 15_000).unref();
    },
  };
}

export function runAgentOnMac(cfg: MacosConfig, worktree: string, claudeArgs: string[], env: Record<string, string>, opts: StreamOptions): Promise<RunResult> {
  return streamAgent(macProcess(cfg, worktree, ['claude', ...claudeArgs], env), opts);
}

export function runCommandOnMac(cfg: MacosConfig, worktree: string, command: string[], env: Record<string, string>, opts: Omit<StreamOptions, 'onSession' | 'onLine'>): Promise<CommandResult> {
  return runToEnd(macProcess(cfg, worktree, command, env), opts);
}

/** Stop everything the runner user is running and delete its Simulator devices (startup and shutdown). */
export function cleanupMac(cfg: MacosConfig): void {
  spawnSync(sudoBin(), ['-n', '-u', cfg.user, runScript(cfg), '--cleanup'], { stdio: 'ignore', input: '', cwd: '/' });
}

/** The runner can't read the owner's home, so it gets a copy of the worker config in its own root. */
export function syncWorkerConfig(cfg: MacosConfig, workerConfigDir: string): void {
  const dest = join(cfg.root, 'config', 'worker-config');
  if (!existsSync(join(cfg.root, 'config'))) throw new Error(`${cfg.root}/config is missing: run ops/setup-macos-runner.sh`);
  rmSync(dest, { recursive: true, force: true });
  cpSync(workerConfigDir, dest, { recursive: true });
  writeFileSync(xcconfigPath(cfg), XCCONFIG);
}

/** Pick the newest available iOS runtime and its newest iPhone, create a device, print its UDID. */
const CREATE_SIMULATOR = [
  'set -euo pipefail',
  XCODE_DEFAULTS, // every run that may build gets a Simulator first, so the settings are always in place
  "rt=$(xcrun simctl list -j runtimes | jq -r '[.runtimes[] | select(.platform == \"iOS\" and .isAvailable)] | last | .identifier // empty')",
  '[ -n "$rt" ] || { echo "no iOS Simulator runtime installed (xcodebuild -downloadPlatform iOS)" >&2; exit 1; }',
  // the newest iPhone the runtime supports (the list isn't ordered by age; minRuntimeVersion is)
  'dt=$(jq -rn --arg rt "$rt" --argjson r "$(xcrun simctl list -j runtimes)" --argjson d "$(xcrun simctl list -j devicetypes)" \'[$r.runtimes[] | select(.identifier == $rt) | .supportedDeviceTypes[] | select(.productFamily == "iPhone") | .identifier] as $ok | [$d.devicetypes[] | select(.identifier as $i | $ok | index($i))] | sort_by(.minRuntimeVersion) | last | .identifier // empty\')',
  'xcrun simctl create "$FACTORY_SIMULATOR_NAME" "$dt" "$rt"',
].join('\n');

/**
 * A Simulator device for one agent run or gate run, so parallel tasks never share one. Returns its UDID, or null
 * with the reason in `error` if none could be created (the project's checks then fail on their own).
 */
export async function createSimulator(cfg: MacosConfig, worktree: string, name: string, logPath: string): Promise<{ udid: string | null; error?: string }> {
  const r = await runCommandOnMac(cfg, worktree, ['bash', '-c', CREATE_SIMULATOR], { FACTORY_SIMULATOR_NAME: name }, { timeoutMs: 120_000, logPath });
  const udid = r.tail.match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\s*$/i)?.[0]?.trim() ?? null;
  return r.exitCode === 0 && udid ? { udid } : { udid: null, error: r.tail.slice(-500).trim() };
}

export async function deleteSimulator(cfg: MacosConfig, worktree: string, udid: string, logPath: string): Promise<void> {
  if (!/^[0-9A-F-]{36}$/i.test(udid)) return;
  await runCommandOnMac(cfg, worktree, ['xcrun', 'simctl', 'delete', udid], {}, { timeoutMs: 60_000, logPath }).catch(() => undefined);
}
