#!/usr/bin/env bash
# S0-6: how much of the 5-hour window does a small, realistic coding task use per model?
# Runs one fixed task on Haiku and Sonnet and records estimated cost, turns, time and usage % before/after
# (when spike 2 found a way to read it). Costs a few percent of your 5-hour window.
set -uo pipefail
. "$(dirname "$0")/lib.sh"

if ! need_env CLAUDE_CODE_OAUTH_TOKEN >/dev/null; then result "S0-6 usage per task" SKIP "CLAUDE_CODE_OAUTH_TOKEN not set"; exit 0; fi
if [ -n "${SKIP_COST:-}" ]; then result "S0-6 usage per task" SKIP "SKIP_COST set"; exit 0; fi
build_spike_image || { result "S0-6 usage per task" FAIL "image build failed"; exit 0; }

PROMPT='In /work, create a small TypeScript module slugify.ts exporting slugify(text: string): string
(lowercase, ASCII only, words joined by "-", max 60 chars) and a test file slugify.test.ts using node:test
with at least 6 cases. Run it with: node --test slugify.test.ts. Fix failures until the tests pass.'

usage_pct() { # prints "five/seven" (percent) from the last rate_limit_event, if any
  jq -r 'select(.type=="rate_limit_event") | .rate_limit_info.unifiedWindows | "\((.five_hour.utilization // 0) * 100)/\((.seven_day.utilization // 0) * 100)"' "$1" 2>/dev/null | tail -1
}

for model in haiku sonnet; do
  WORK=$(mktemp -d); chmod a+rwx "$WORK"
  OUT="$RESULTS_DIR/06-$model.jsonl"
  log "Reference task on $model"
  start=$(date +%s)
  spike_docker 900 -v "$WORK:/work" "$SPIKE_IMAGE" \
    claude -p "$PROMPT" --model "$model" --permission-mode auto --permission-prompts none \
    --output-format stream-json --verbose > "$OUT" 2>/dev/null
  secs=$(( $(date +%s) - start ))
  cost=$(jq -r 'select(.type=="result") | .total_cost_usd // "n/a"' "$OUT" 2>/dev/null | tail -1)
  turns=$(jq -r 'select(.type=="result") | .num_turns // "n/a"' "$OUT" 2>/dev/null | tail -1)
  ok=$(jq -r 'select(.type=="result") | .subtype' "$OUT" 2>/dev/null | tail -1)
  pct=$(usage_pct "$OUT")
  result "S0-6 usage per task ($model)" INFO "result=$ok, ${secs}s, turns=$turns, est. \$$cost, usage after (5h/7d)=${pct:-unknown}"
  rm -rf "$WORK"
done
