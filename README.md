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
| M2 gates, independent review, auto-merge | Done; first real merge: factory-sandbox PR #2 |
| M3 governor live: usage probe, own-use detection | Usage readings live from every run; own-use detection next |
| M4 Discord: intake, questions with buttons, approvals, alerts, daily digest, slash commands | Built and tested; needs your bot token to go live |
| M5 planning · M6 deploy · M7 iOS · M8 maintenance · M9 dashboard · M10 self-improvement · M11 hardening | Planned |

## Layout

```
orchestrator/src/     daemon (main.ts), CLI (cli.ts), governor, scheduler, pipeline, GitHub client, SQLite store
orchestrator/test/    unit tests (node --test)
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
