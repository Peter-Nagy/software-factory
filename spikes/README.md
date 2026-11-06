# S0 spikes

These run once on the Mac mini, before the factory goes live. They test the assumptions the design depends on.
Each spike reports PASS, FAIL, SKIP or INFO in `spikes/results/summary.md`. Paste that file into the chat
(or commit it) so the next milestones can build on the results.

| Spike | Question | Needs |
| --- | --- | --- |
| 01 | Does the `claude setup-token` subscription token work inside a worker container? | `CLAUDE_CODE_OAUTH_TOKEN` |
| 02 | Can the factory read 5-hour / 7-day usage unattended (stream-json, `/usage`, status line)? | `CLAUDE_CODE_OAUTH_TOKEN`, host `claude` login |
| 03 | Does auto mode run unattended in a container, and do the deny rules hold? | `CLAUDE_CODE_OAUTH_TOKEN` |
| 04 | Can the GitHub App mint a token limited to one repo? | `GH_APP_*` vars (runbook step 4) |
| 05 | Can the 1Password service account read the Factory vault? | `op` CLI, `OP_SERVICE_ACCOUNT_TOKEN` |
| 06 | How much of the 5-hour window does a small coding task use on Haiku and Sonnet? | `CLAUDE_CODE_OAUTH_TOKEN` (set `SKIP_COST=1` to skip) |

```bash
claude setup-token                      # prints a long-lived token; copy it
export CLAUDE_CODE_OAUTH_TOKEN='...'    # don't put it in shell history files: use `read -s` if you prefer
bash spikes/run-all.sh
```

Spikes 01-03 and 06 use a small image, `factory-worker:spike`, which builds automatically the first time (about 2 minutes).
Together they use a few percent of your 5-hour window. Spikes without their inputs are skipped, so you can run spikes 01-03 now and the rest later.
