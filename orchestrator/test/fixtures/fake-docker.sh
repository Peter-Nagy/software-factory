#!/usr/bin/env bash
# Stands in for `docker run ... claude -p ...` in the pipeline integration test.
# Finds the /work mount, acts like an agent according to the test's mode file, and prints a stream-json transcript.
set -euo pipefail
[ "${1:-}" = "kill" ] && exit 0
WORK=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-v" ] && [[ "$a" == *:/work ]]; then WORK="${a%:/work}"; fi
  prev="$a"
done
[ -n "$WORK" ] || { echo "no /work mount" >&2; exit 2; }
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || { echo "token not passed" >&2; exit 3; }
cd "$WORK"
# The runner passes only whitelisted env vars, so the test leaves the mode in a file: <root>/mode
MODE=$(cat "$WORK/../../../mode" 2>/dev/null || echo success)
g() { git -c user.name=fake -c user.email=fake@x "$@"; }
echo '{"type":"system","subtype":"init","session_id":"sess-fake"}'
case "$MODE" in
  success)
    echo "feature $(date +%s%N)" >> feature.txt
    g add feature.txt && g commit -qm "feat: fake work" && g push -q -u origin HEAD 2>/dev/null
    printf '## What changed\n- fake feature\n' > .factory/summary.md
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-fake","result":"done","total_cost_usd":0.1,"num_turns":3}'
    ;;
  question)
    echo '{"question":"Which colour?","options":["blue","green"],"default":"blue"}' > .factory/question.json
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-fake","result":"need input","num_turns":2}'
    ;;
  limit)
    echo "wip" >> wip.txt
    g add wip.txt && g commit -qm "wip"
    echo '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"sess-fake","result":"Claude usage limit reached.","num_turns":2}'
    ;;
  fail)
    echo '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"sess-fake","result":"Could not make the tests pass.","num_turns":120}'
    ;;
esac
