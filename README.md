# software-factory

An autonomous software factory that runs on a dedicated Mac mini. Claude Code agents, running under your Max subscription,
turn ideas and GitHub issues into tested, reviewed and deployed apps while you're away. A usage governor keeps them within your limits.

- **Plan:** https://claude.ai/artifact/BhQcTtADWKmwmz55no3433
- **Setup and operations:** [docs/RUNBOOK.md](docs/RUNBOOK.md)
- **Pre-flight checks:** [spikes/README.md](spikes/README.md)

## Status

| Milestone | State |
| --- | --- |
| S0 spikes | Written; run on the Mac |
| M1 core: config, SQLite state, governor, scheduler, retry ladder, container runner, issue to PR | Built and unit-tested; untested end to end |
| M2 gates and merge: self-hosted runner, reviewer, auto-merge | Next |
| M3 governor live: usage probe, own-use detection | After the spike 2 results |
| M4 Discord · M5 planning · M6 deploy · M7 iOS · M8 maintenance · M9 dashboard · M10 self-improvement · M11 hardening | Planned |

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
