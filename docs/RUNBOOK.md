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
   - Repository permissions: Contents RW, Pull requests RW, Issues RW, Checks R, Commit statuses R, Metadata R,
     Administration RW, Workflows RW. Administration (branch protection) and Workflows (CI files in new projects) are used
     only by the orchestrator; worker tokens leave them out, so GitHub itself rejects agent pushes to `.github/workflows/`.
   - Install it on your account with **All repositories**. Per-task tokens are cut down to one repo, and the
     orchestrator refuses repos without the `factory-managed` topic.
   - Note the App ID and the installation ID (from the installation URL), and generate a private key. Store the key as
     `GITHUB_APP_PRIVATE_KEY` in the Factory vault and delete the downloaded file.
5. **1Password:** create a vault `Factory`. Add items (type API Credential, value in the `credential` field):
   `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_APP_PRIVATE_KEY` (paste the .pem contents), plus per-project secrets later.
   Create a service account with read access to `Factory` only, then store its token in the keychain:
   `security add-generic-password -s factory-op-token -a factory -w '<token>'`
6. **Config:** edit `~/factory/factory.config.yaml` (App ID, installation ID).
7. **Start:** `bash ops/setup.sh --launchd`. Logs: `~/factory/logs/orchestrator.log`.

## Discord

1. Create a private server, then an application at https://discord.com/developers/applications. On its Bot tab, reset and copy
   the token, turn on **Message Content Intent**, and turn off **Public Bot**.
2. OAuth2 → URL Generator: scopes `bot` and `applications.commands`; bot permissions: Manage Channels, View Channels,
   Send Messages, Read Message History, Embed Links. Open the URL and add the bot to the server.
3. Store the token as `DISCORD_BOT_TOKEN` in the Factory vault.
4. Add `discord: {guildId, ownerUserId}` to `~/factory/factory.config.yaml` (Developer Mode → right-click → Copy ID), then
   restart: `launchctl kickstart -k gui/$(id -u)/eu.peterszn.factory.orchestrator`. The bot creates its channels.

| Channel | What |
| --- | --- |
| #inbox | Write tasks, answers or ideas in plain words (Haiku sorts them) |
| #questions | Agents' product questions, with buttons; the default applies after 24 h (4 h for small UI choices) |
| #approvals | Destructive migrations: approve or reject; no answer within 7 days means reject |
| #alerts | Parked tasks and factory problems (mentions you) |
| #digest | Daily summary at 08:00 |

Slash commands: `/status`, `/usage`, `/pause hours`, `/resume`, `/task project text`, `/retry task`, `/answer id text`.
Only the `ownerUserId` can use them; the bot ignores everyone else.

## Adding a project (until the planner milestone lands)

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
factory update            # update the running factory to origin/main (see below)
```

### Updating the factory

Merged PRs land on GitHub; the running factory changes only when you run `factory update`. It refuses local
changes, shows the new commits, pauses new runs and waits for running agents (`--now` interrupts them instead; they
resume after the restart), then fast-forwards, installs, typechecks, tests and builds. A failure there leaves the old
version running. Otherwise it restarts and waits for `/api/health` to report the new commit with a fresh heartbeat;
if that doesn't happen within 3 minutes it rolls back to the previous commit and restarts that. Log:
`~/factory/logs/update.log`. Health: `curl http://127.0.0.1:4777/api/health` (local only).

## Recovery

| Symptom | What to do |
| --- | --- |
| Orchestrator not running | `launchctl kickstart -k gui/$(id -u)/eu.peterszn.factory.orchestrator`, then check the log |
| Task stuck in `building` after a crash | Restarting the orchestrator requeues interrupted tasks and keeps their session |
| Everything paused at a usage limit | Expected: it resumes after the reset. `factory usage` shows when |
| Containers left behind | `docker ps --filter label=factory.run`, then `docker rm -f <id>` |
| Disk filling up | `docker system prune`, delete merged task folders under `~/factory/worktrees` |
| Updating Claude Code | `bash ops/setup.sh` rebuilds the worker image pinned to the host's `claude --version` |
