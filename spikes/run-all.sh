#!/usr/bin/env bash
# Run every S0 spike and write spikes/results/summary.md. Safe to re-run; each spike skips what it can't test.
#
#   export CLAUDE_CODE_OAUTH_TOKEN=...      # from `claude setup-token`
#   export OP_SERVICE_ACCOUNT_TOKEN=...     # optional, spike 5
#   export GH_APP_ID=... GH_APP_KEY_FILE=... GH_INSTALLATION_ID=... GH_OWNER=... GH_REPO=... GH_OTHER_REPO=...  # optional, spike 4
#   bash spikes/run-all.sh
set -uo pipefail
. "$(dirname "$0")/lib.sh"

{
  echo "# S0 spike results"
  echo
  echo "- Date: $(date -u +%Y-%m-%dT%H:%MZ)"
  echo "- Host: $(uname -sm), $(sw_vers -productVersion 2>/dev/null || echo non-macOS)"
  echo "- Docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo missing)"
  echo "- Host claude: $(claude --version 2>/dev/null || echo missing)"
  echo "- Node: $(node --version 2>/dev/null || echo missing)"
  echo
} > "$SUMMARY"

for tool in docker jq perl; do
  if ! have "$tool"; then
    result "prerequisites" FAIL "$tool is not installed"
    echo "Install $tool first (see ops/setup.sh)." >&2
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1; then
  result "prerequisites" FAIL "Docker daemon not running (start OrbStack)"
  exit 1
fi

bash "$SPIKES_DIR/01-container-auth.sh"
bash "$SPIKES_DIR/02-rate-limits.sh"
bash "$SPIKES_DIR/03-auto-mode.sh"
if have node; then
  node --disable-warning=ExperimentalWarning "$SPIKES_DIR/04-github-app.ts"
else
  result "S0-4 GitHub App scoped token" SKIP "node not installed"
fi
bash "$SPIKES_DIR/05-1password.sh"
bash "$SPIKES_DIR/06-usage-cost.sh"

echo
echo "Done. Summary: $SUMMARY"
echo "Raw outputs are in $RESULTS_DIR (not committed). Commit summary.md or paste it into the chat."
