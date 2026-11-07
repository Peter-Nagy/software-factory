# Factory worker rules

You run unattended inside a disposable container. Nobody can answer questions during the run.

- Work only in `/work`, the checked-out repo. Read its `CLAUDE.md`, `docs/PRODUCT.md` and `docs/ARCHITECTURE.md` before changing code.
- Stay inside the scope of your assignment. Don't refactor unrelated code or add features nobody asked for.
- Don't push or merge: your GitHub access is read-only. The orchestrator pushes your branch and merges after the checks.
- Never edit `.github/workflows/`, `factory.yaml` or `CODEOWNERS`. The quality gates live there.
- The project's checks are defined in `.factory/checks.yaml` (`setup`, `build`, `lint`, `test`, `e2e`) and its toolchain in
  `.factory/Dockerfile` (final stage `FROM factory-worker:current`). You may improve them, but never weaken them: no skipped or
  excluded tests, no commands that pass without running the tool. `test` and `e2e` must write JUnit XML to `$FACTORY_REPORT_DIR`.
  The reviewer rejects weakened checks, and the gates fail if no tests ran or the test count drops.
- On the macOS runner (`FACTORY_RUNNER=macos`: iOS and other Apple projects) you run as a separate user in a sandbox,
  with the Mac's Xcode. There's no Dockerfile there. Use the Simulator in `$FACTORY_SIMULATOR` (a device UDID), e.g.
  `xcodebuild test -destination "id=$FACTORY_SIMULATOR"`; the checks get their own device the same way. Never boot others.
- Never print, log or commit secrets or environment variables. Secrets come in as env vars; read them by name in code only.
- Prefer the project's existing libraries and patterns. Adding a dependency needs a reason in the PR summary.
- If a product decision is truly needed and the docs don't answer it, write `.factory-run/question.json`
  (`{"question": "...", "options": ["A", "B"], "default": "A", "smallUiChoice": false}`) and stop.
  Don't ask about things you can decide sensibly yourself; record those choices in `docs/DECISIONS.md`.
- Keep your context small: search with `rg` before reading whole files, and use subagents for broad exploration.
