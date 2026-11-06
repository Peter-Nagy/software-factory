#!/usr/bin/env bash
# S0-1: does the subscription token from `claude setup-token` work inside a worker container?
set -uo pipefail
. "$(dirname "$0")/lib.sh"
NAME="S0-1 subscription token in container"

if ! need_env CLAUDE_CODE_OAUTH_TOKEN >/dev/null; then
  result "$NAME" SKIP "CLAUDE_CODE_OAUTH_TOKEN not set (run 'claude setup-token' and export it)"
  exit 0
fi
build_spike_image || { result "$NAME" FAIL "image build failed"; exit 0; }

OUT="$RESULTS_DIR/01-auth.json"
log "Asking Claude (Haiku) for a fixed reply from inside a container"
run_with_timeout 180 docker run --rm --init --user worker -e CLAUDE_CODE_OAUTH_TOKEN \
  -v "$REPO_DIR/worker-config:/home/worker/.claude-config:ro" "$SPIKE_IMAGE" \
  claude -p "Reply with exactly the word FACTORY_OK and nothing else." --model haiku --output-format json \
  > "$OUT" 2> "$RESULTS_DIR/01-auth.stderr"

version=$(docker run --rm "$SPIKE_IMAGE" claude --version 2>/dev/null | head -1)
if jq -e '.result | test("FACTORY_OK")' "$OUT" >/dev/null 2>&1; then
  cost=$(jq -r '.total_cost_usd // "n/a"' "$OUT")
  result "$NAME" PASS "claude $version answered; est. cost \$$cost"
else
  err=$(jq -r '.result // empty' "$OUT" 2>/dev/null | head -c 200)
  [ -z "$err" ] && err=$(head -c 200 "$RESULTS_DIR/01-auth.stderr")
  result "$NAME" FAIL "claude $version: ${err:-no output}"
fi
