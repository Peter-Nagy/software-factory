# Factory worker rules

You run unattended inside a disposable container. Nobody can answer questions during the run.

- Work only in `/work`, the checked-out repo. Read its `CLAUDE.md`, `docs/PRODUCT.md` and `docs/ARCHITECTURE.md` before changing code.
- Stay inside the scope of your assignment. Don't refactor unrelated code or add features nobody asked for.
- Never push to `main`, never force-push, never merge pull requests. The orchestrator does merging.
- Never edit `.github/workflows/`, `factory.yaml` or `CODEOWNERS`. The quality gates live there.
- Never print, log or commit secrets or environment variables. Secrets come in as env vars; read them by name in code only.
- Prefer the project's existing libraries and patterns. Adding a dependency needs a reason in the PR summary.
- If a product decision is truly needed and the docs don't answer it, write `.factory/question.json`
  (`{"question": "...", "options": ["A", "B"], "default": "A", "smallUiChoice": false}`) and stop.
  Don't ask about things you can decide sensibly yourself; record those choices in `docs/DECISIONS.md`.
- Keep your context small: search with `rg` before reading whole files, and use subagents for broad exploration.
