# software-factory: notes for agents working on this repo

- TypeScript run directly by Node (type stripping): only erasable syntax (no enums, no parameter properties, no namespaces).
  Import local files with the `.ts` extension.
- Keep dependencies minimal. Today they're `yaml` and `zod`, with `node:sqlite` for state. Ask before adding more.
- Pure decision logic (governor, scheduler, retry, state machine, migration check) stays free of I/O and is unit-tested.
- Checks: `npm test` and `npm run typecheck` must pass.
- Protected (never change without the owner's explicit approval): `worker-config/settings.json` deny rules,
  governor caps and hard stops, secret scoping, gate requirements.
- Agents run only through the official `claude` CLI with the owner's subscription login. Never use `--bare` or the
  Agent SDK libraries with a claude.ai login.
- The factory builds itself too: this repo is one of its projects. Its checks are in `.factory/checks.yaml` (typecheck,
  dashboard build and lint with `--deny-warnings`, unit tests, and `e2e/smoke.ts`: the dashboard over sample data in
  Chromium). Add a smoke case when you add a dashboard page or flow.
- Changes to the safety layers (the paths under `ownerApproval` in `factory.yaml`) merge only after the owner signs off.
  Keep such changes small and separate from feature work, and say in the PR why each one is needed.
- The running factory doesn't update itself: the owner runs `factory update` (ops/update.sh) after merges.
