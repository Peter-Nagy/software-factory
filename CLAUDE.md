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
