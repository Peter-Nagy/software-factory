# software-factory

An autonomous software factory that runs on a dedicated Mac mini. Claude Code agents, running under your Max subscription,
turn ideas and GitHub issues into tested, reviewed and deployed apps while you're away. A usage governor keeps them within your limits.

- **Plan:** https://claude.ai/artifact/BhQcTtADWKmwmz55no3433
- **Setup and operations:** [docs/RUNBOOK.md](docs/RUNBOOK.md)
- **Pre-flight checks:** [spikes/README.md](spikes/README.md)

## Status

| Milestone | State |
| --- | --- |
| S0 spikes | All pass on the Mac mini ([results](spikes/results/summary.md)) |
| M1 core: config, SQLite state, governor, scheduler, retry ladder, container runner, issue to PR | Done; ran end to end on factory-sandbox |
| M2 gates, independent review, auto-merge | Done; real merges on factory-sandbox. Gates follow the stack-independent check contract below. Protected changes and destructive migrations merge only after the owner signs off |
| M3 governor live: usage probe, own-use detection | Usage readings live from every run; usage per project, agent and studio phase measured (Activity page); own-use detection next |
| M4 Discord: intake, questions with buttons, approvals, alerts, daily digest, slash commands | Built and tested; needs your bot token to go live. Lighter alternative: ntfy push (built, off until configured) |
| M5 planning: plan mode, issue pages, Studio (idea to build plan: interviews, stand-in answers, launch kit) | Built |
| Dashboard | Built; Playwright smoke test over sample data (`e2e/smoke.ts`) |
| M7 macOS runner | Built, set up and isolated; Simulator tests hang on Xcode 26.6 + macOS 27 (likely needs Xcode 27). `ops/macos-runner/selftest.sh` checks it |
| M11 hardening | `factory update` (checks, restart, health check, rollback), `/api/health` heartbeat, daily backups, watchdog (install with `setup.sh --launchd`), runbook |
| M6 deploy · M8 maintenance · M10 self-improvement | Planned. The factory builds itself once `software-factory` is registered as a project |

## Check contract

The factory doesn't know any languages. Each project defines its checks for its own stack, and the gates fail closed:

- `.factory/checks.yaml`: `build`, `lint` and `test` are required, `e2e` too for web apps, static sites and iOS
  (unless `factory.yaml` sets `gates.e2e: false`), and `setup` is optional. Each value is a shell command run in `/work`.
- `test` and `e2e` must write JUnit XML to `$FACTORY_REPORT_DIR`, and at least one test must run. An exit code of 0 alone doesn't pass.
- The test count may not drop below main's unless a commit has a `Tests-Removed: <why>` trailer, which the reviewer judges.
- `.factory/Dockerfile` (optional) adds the project's toolchain; its final stage must be `FROM factory-worker:current`.
  It's built with only `.factory/` as context and cached by its contents. Agents and gates both run in that image.
- Agents may change `.factory/`. The reviewer is told to reject any change that weakens a check.
- `runner: macos` (the default for `kind: ios`) sends tasks to the macOS runner: a hidden `factory-ios` user that can't read
  your home, reached through one root-owned script (`sudo -u factory-ios /Users/Shared/factory-macos/bin/run`), with
  everything inside a sandbox profile (`ops/macos-runner/sandbox.sb`). It uses the Mac's Xcode, so no Dockerfile; each agent
  run and each gate run gets its own Simulator device in `$FACTORY_SIMULATOR`. Security scans and reviews stay in Docker.
  Set up with `sudo ops/setup-macos-runner.sh`, then `macos: {enabled: true}` in the factory config; until then those tasks wait parked.
- Secrets, dependency and code scans (gitleaks, osv-scanner, semgrep) stay owned by the factory and work across stacks.

## Layout

```
orchestrator/src/     daemon (main.ts), CLI (cli.ts), governor, scheduler, pipeline, GitHub client, SQLite store
orchestrator/test/    unit tests (node --test)
dashboard/            React + Tailwind + shadcn/ui dashboard (built by ops/setup.sh, served by the orchestrator)
worker/               worker image: Claude Code CLI, gh, Playwright, gitleaks, osv-scanner, semgrep
worker-config/        mounted read-only into every worker: deny rules, global CLAUDE.md, role prompts
spikes/               S0 checks to run once on the Mac
ops/                  setup.sh, launchd service, run script
docs/                 runbook
```

## Development

Node 22.18 or newer runs the TypeScript directly (type stripping), so there's no build step.

```bash
npm install
npm test
npm run typecheck
```
