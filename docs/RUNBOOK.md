# Runbook

How to install, operate and recover the factory on the Mac mini. The design lives in the plan doc
(https://claude.ai/artifact/BhQcTtADWKmwmz55no3433).

## First-time setup

1. **Clone and install**
   ```bash
   mkdir -p ~/factory && cd ~/factory
   git clone https://github.com/Peter-Nagy/software-factory.git
   cd software-factory && bash ops/setup.sh --power
   ```
2. **Claude login on the Mac:** run `claude` once and log in with your Max account. Then run `claude setup-token`
   and keep the printed token. It goes into 1Password in step 5.
3. **Run the spikes:** `bash spikes/run-all.sh` (see `spikes/README.md`). Send the summary back before go-live.
4. **GitHub App "factory-bot"** (github.com, Settings, Developer settings, GitHub Apps, New):
   - Homepage: any URL. Webhook: off.
   - Repository permissions: Contents RW, Pull requests RW, Issues RW, Checks R, Commit statuses R, Metadata R, Administration RW
     (Administration is used only by the orchestrator, for branch protection; workers get tokens without it).
   - Install it on your account with **All repositories**. Per-task tokens are cut down to one repo, and the
     orchestrator refuses repos without the `factory-managed` topic.
   - Note the App ID and the installation ID (from the installation URL), and generate a private key.
5. **1Password:** create a vault `Factory`. Add items (type API Credential, value in the `credential` field):
   `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_APP_PRIVATE_KEY` (paste the .pem contents), plus per-project secrets later.
   Create a service account with read access to `Factory` only, then store its token in the keychain:
   `security add-generic-password -s factory-op-token -a factory -w '<token>'`
6. **Config:** edit `~/factory/factory.config.yaml` (App ID, installation ID).
7. **Start:** `bash ops/setup.sh --launchd`. Logs: `~/factory/logs/orchestrator.log`.

## Adding a project (until the planner/Discord milestones land)

1. Create the repo and add the topic `factory-managed`. Add a `factory.yaml` (see `orchestrator/src/config.ts`, `ProjectConfigSchema`).
2. `node orchestrator/src/cli.ts add-project <repo> --kind web-app --priority 3`
3. Open issues with the label `factory:ready` (plus `priority:`, `risk:`, `area:`, `size:` as needed).
   They are picked up within 5 minutes.

## Day-to-day commands

```bash
alias factory='node --disable-warning=ExperimentalWarning ~/factory/software-factory/orchestrator/src/cli.ts'
factory status            # projects and open tasks
factory usage             # last 5-hour / 7-day reading
factory pause 3           # no new runs for 3 hours (running ones finish)
factory resume
factory requeue app#12    # retry a parked task
```

## Recovery

| Symptom | What to do |
| --- | --- |
| Orchestrator not running | `launchctl kickstart -k gui/$(id -u)/eu.peterszn.factory.orchestrator`, then check the log |
| Task stuck in `building` after a crash | Restarting the orchestrator requeues interrupted tasks and keeps their session |
| Everything paused at a usage limit | Expected: it resumes after the reset. `factory usage` shows when |
| Containers left behind | `docker ps --filter label=factory.run`, then `docker rm -f <id>` |
| Disk filling up | `docker system prune`, delete merged task folders under `~/factory/worktrees` |
| Updating Claude Code | `bash ops/setup.sh` rebuilds the worker image pinned to the host's `claude --version` |
