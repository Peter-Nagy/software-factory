#!/usr/bin/env bash
# S0-2: can the factory read 5-hour / 7-day subscription usage without a person watching?
# Tries three sources and records which ones work:
#   a) events in `claude -p --output-format stream-json` (headless, in a container)
#   b) `/usage` run through `claude -p`
#   c) the status line JSON from a short interactive session (pseudo-terminal via `script`)
set -uo pipefail
. "$(dirname "$0")/lib.sh"

if ! need_env CLAUDE_CODE_OAUTH_TOKEN >/dev/null; then
  result "S0-2 usage readings" SKIP "CLAUDE_CODE_OAUTH_TOKEN not set"
  exit 0
fi
build_spike_image || { result "S0-2 usage readings" FAIL "image build failed"; exit 0; }

# a) stream-json
STREAM="$RESULTS_DIR/02a-stream.jsonl"
log "a) headless stream-json run"
spike_docker 180 "$SPIKE_IMAGE" \
  claude -p "Reply with OK." --model haiku --output-format stream-json --verbose > "$STREAM" 2>/dev/null
types=$(jq -r '[.type, (.subtype // "")] | join("/")' "$STREAM" 2>/dev/null | sort -u | tr '\n' ' ')
if grep -q -E '"(five_hour|seven_day|rate_limit[a-z_]*)"' "$STREAM"; then
  sample=$(grep -E '"(five_hour|seven_day|rate_limit[a-z_]*)"' "$STREAM" | head -1 | jq -c 'del(.message)' 2>/dev/null | head -c 400)
  result "S0-2a stream-json usage" PASS "event types: $types; sample: \`$sample\`"
else
  result "S0-2a stream-json usage" FAIL "no rate-limit fields; event types seen: $types"
fi

# b) /usage via -p
USAGE_OUT="$RESULTS_DIR/02b-usage.txt"
log "b) /usage through claude -p"
spike_docker 120 "$SPIKE_IMAGE" claude -p "/usage" > "$USAGE_OUT" 2>&1
if grep -q -E '[0-9]+(\.[0-9]+)? ?%' "$USAGE_OUT"; then
  result "S0-2b /usage in -p" PASS "$(tr '\n' ' ' < "$USAGE_OUT" | head -c 300)"
else
  result "S0-2b /usage in -p" FAIL "$(tr '\n' ' ' < "$USAGE_OUT" | head -c 200)"
fi

# c) status line probe on the host (uses your normal Claude Code login on this Mac)
if have claude; then
  log "c) status line probe (interactive session in a pseudo-terminal, up to 90 s)"
  PROBE_DIR=$(mktemp -d)
  STATUS_JSON="$RESULTS_DIR/02c-statusline.json"
  rm -f "$STATUS_JSON"
  cat > "$PROBE_DIR/settings.json" <<EOF
{"statusLine": {"type": "command", "command": "cat > '$STATUS_JSON'"}}
EOF
  (
    cd "$HOME" || exit 0
    if [ "$(uname)" = "Darwin" ]; then
      run_with_timeout 90 script -q /dev/null claude --settings "$PROBE_DIR/settings.json" --model haiku "Reply with OK." >/dev/null 2>&1
    else
      run_with_timeout 90 script -q -c "claude --settings '$PROBE_DIR/settings.json' --model haiku 'Reply with OK.'" /dev/null >/dev/null 2>&1
    fi
  ) &
  probe_pid=$!
  for _ in $(seq 1 45); do
    if [ -s "$STATUS_JSON" ] && jq -e '.rate_limits' "$STATUS_JSON" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  kill "$probe_pid" 2>/dev/null; wait "$probe_pid" 2>/dev/null
  if [ -s "$STATUS_JSON" ] && jq -e '.rate_limits' "$STATUS_JSON" >/dev/null 2>&1; then
    result "S0-2c status line probe" PASS "$(jq -c '.rate_limits' "$STATUS_JSON")"
  elif [ -s "$STATUS_JSON" ]; then
    result "S0-2c status line probe" FAIL "status line ran but had no rate_limits (keys: $(jq -c 'keys' "$STATUS_JSON" 2>/dev/null))"
  else
    result "S0-2c status line probe" FAIL "status line never ran (a trust or login prompt may have blocked it)"
  fi
  rm -rf "$PROBE_DIR"
else
  result "S0-2c status line probe" SKIP "claude CLI not installed on the host"
fi
